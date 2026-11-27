import { sourceSetting } from './source-config.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
import { assessRuleEvidence, type RuleFactBinding, type RuleCard } from './research.js';
import { normalizeSourceEvidence, sourceSnapshotFromEvidence, type EvidenceRow, type SourceEvidenceRequest } from './source-evidence.js';
import { saveEvidence as persistEvidence } from './store.js';
import { decodePublisherText, isPublisherIndex, matchesNewsEntities, matchesPublisherDomain, newsPublishers, readPublisherFeedArticle,
  searchPublisherIndexes, type NewsPublisher } from './news-publishers.js';

const resolverSource = 'market-data/research/resolve';
const searchSource = 'personal-agent/market-web-search';
const paidSource = `${searchSource}/serper-reservation`;
const tavilySource = `${searchSource}/tavily-reservation`;
const exaEndpoint = new URL(sourceSetting('PM_EXA_URL') + '/mcp');
const langsearchEndpoint = new URL(sourceSetting('PM_LANGSEARCH_URL') + '/v1/web-search');
const tavilyEndpoint = new URL(sourceSetting('PM_TAVILY_URL') + '/');
const jinaEndpoint = sourceSetting('PM_JINA_URL') + '/';
const runFile = promisify(execFile);
const maxQueries = 3;
const maxResults = 5;
const exaBodyLimit = 60_000;
const storedBodyLimit = 300_000;
const str = { type: 'string' } as const;
const required = { ...str, required: true } as const;
const obj = <const T extends ParameterSchemaSpec>(properties: T) =>
  ({ type: 'object', additionalProperties: false, properties } as const);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value: unknown, limit: number) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

function resolution(row: EvidenceRow | undefined) {
  if (row?.source !== resolverSource || !object(row.data) || row.data.status !== 'found' ||
      !Number.isSafeInteger(row.data.localMarketId) || typeof row.data.title !== 'string') {
    throw new Error('需要 resolve_market 或 read_market(rules) 保存的单市场解析证据。');
  }
  return row.data;
}

function sameMarket(left: Record<string, unknown>, right: Record<string, unknown>) {
  return left.localMarketId === right.localMarketId && ['conditionId', 'gammaMarketId'].every(key =>
    !left[key] || !right[key] || String(left[key]).toLowerCase() === String(right[key]).toLowerCase());
}

function httpUrl(value: unknown) {
  const url = typeof value === 'string' && value.length <= 4096 ? URL.parse(value) : null;
  return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
}

type Engine = 'searxng' | 'serper' | 'exa' | 'langsearch' | 'tavily' | 'publisher-rss' | 'publisher-web' | 'publisher-json' | 'sec-edgar' | 'espn-scoreboard';
type Hit = { rank: number; url: string; domain: string; title: string; snippet: string; engines: string[];
  publishedAt?: string; publicationDay?: string; feedScore?: number; document?: string; snippetTruncated: boolean;
  upstreamUrl?: string; upstreamPublisher?: string };
type Attempt = {
  engine: Engine; startedAt: string; finishedAt: string; elapsedMs: number; attempted: boolean;
  searxEngine?: string; publisher?: string; publisherId?: string; indexUrl?: string; indexRetrievedAt?: string; cached?: boolean;
  status: 'ok' | 'empty' | 'failed' | 'cancelled' | 'unavailable'; reason?: string;
  engineErrors: { engine: string; reason: string }[]; results: Hit[]; truncated: boolean; returned: number;
  pageAttempts?: { url: string; startedAt: string; finishedAt: string; status: 'ok' | 'failed'; reason?: string }[];
  credits?: number;
};
type QueryReport = {
  keywords: string; clauseIds: string[]; sourceDomains: string[]; newsSince?: string; attempts: Attempt[];
  entities?: string[][];
  fallback?: { reason: string; decision: string; reservationId?: string };
};

const officialReadPriority = ['policy_decision', 'price_release', 'consumer_prices', 'policy_outlook', 'fixture_schedule',
  'fixture_report', 'issuer_release', 'regulatory_filing', 'earnings_coverage',
  'leadership_release', 'leadership_filing', 'leadership_prior_filing', 'leadership_oversight', 'leadership_reporting',
  'fed_statement', 'fed_speech', 'election_reporting', 'research_verification',
  'jin10_flash', 'equation_flash', 'nba_box_score', 'nba_recap'];
const mexicanSportsPress = ['soyreferee.com', 'televisa.com', 'tudn.com', 'espn.com.mx', 'record.com.mx', 'mediotiempo.com'];
const earningsPress = ['cnbc.com', 'apnews.com', 'reuters.com'];
const leadershipPress = ['dw.com', 'apnews.com', 'reuters.com', 'france24.com', 'bbc.com', 'cnbc.com', 'axios.com',
  'time.com', 'nbcnews.com', 'nbcnewyork.com', 'arstechnica.com'];

function fixtureEntities(market: Record<string, unknown> | undefined) {
  if (market?.category !== 'sports' || typeof market.title !== 'string') return [];
  const title = market.title.replace(/^(?:Counter-Strike|CS2|League of Legends|Dota 2|Valorant):\s*/i, '');
  const matchup = title.split(':')[0].replace(/\s+\(BO\d\).*$/i, '').split(/\s+(?:vs\.?|versus)\s+/i);
  if (matchup.length !== 2) return [];
  return matchup.map(name => {
    const club = name.replace(/^(?:AFC|C[FS]|FC|Club)\s+/i, '').trim();
    const aliases = /^(?:Philadelphia )?76ers$/i.test(club) ? ['Sixers'] : /^Monterrey$/i.test(club) ? ['Rayados'] : [];
    return [...new Set([name.trim(), club, ...aliases])].filter(Boolean);
  });
}

function primaryPlans(market: Record<string, unknown> | undefined) {
  const title = typeof market?.title === 'string' ? market.title : '';
  const listing: Array<{ keywords: string; sourceDomains: string[]; document: string; entities?: string[][] }> = [];
  const archive: typeof listing = [];
  const add = (items: typeof listing, domain: string, keywords: string, document: string, entities?: string[][]) =>
    items.push({ sourceDomains: [domain], keywords, document, entities });
  if (/\bFed\b.*\b(?:interest rates?|meeting|basis points?)\b/i.test(title)) {
    add(listing, 'federalreserve.gov', 'Federal Reserve issues FOMC statement', 'fed_statement', [['Federal Reserve issues FOMC statement']]);
    add(listing, 'newyorkfed.org', 'Williams', 'fed_speech', [['Williams']]);
  }
  if (/\bRiemann Hypothesis\b/i.test(title)) {
    add(listing, 'leanprover-community.github.io', 'Lean verification Riemann Hypothesis', 'research_verification', [['Riemann Hypothesis']]);
  }
  if (/\bTaipei Mayor\b/i.test(title) && !/\bNew Taipei\b/i.test(title)) {
    add(listing, 'pts.org.tw', '北市 選戰', 'election_reporting', [['北市選戰', '臺北市長', '台北市長']]);
  }
  if (/\bbank of japan\b/i.test(title)) {
    add(listing, 'boj.or.jp', 'Statement on Monetary Policy', 'policy_decision', [['Statement on Monetary Policy']]);
    add(listing, 'boj.or.jp', 'Services Producer Price Index', 'price_release', [['Services Producer Price Index']]);
    // The latest official release can predate the news window. Its printed period remains in the receipt.
    add(listing, 'stat.go.jp', '消費者物価指数 全国 月分', 'consumer_prices', [['消費者物価指数'], ['全国'], ['PDF']]);
    add(listing, 'boj.or.jp', 'Outlook for Economic Activity and Prices', 'policy_outlook', [['Outlook for Economic Activity and Prices'], ["The Bank's View"]]);
  }
  const teams = fixtureEntities(market);
  if (teams.some(team => team.includes('Rayados'))) {
    add(listing, 'rayados.com', 'Rayados horarios partido de ida', 'fixture_schedule',
      [...teams, ['horarios', 'horario', 'hora']]);
    add(listing, 'soyreferee.com', 'Rayados América dónde ver partido de ida', 'fixture_report',
      [...teams, ['en vivo', 'dónde y a qué hora', 'dónde ver']]);
  }
  if (/\bAmazon\b.*\b(?:capex|capital expenditures)\b/i.test(title)) {
    const year = title.match(/\b20\d{2}\b/)?.[0] ?? '';
    add(listing, 'aboutamazon.com', 'Amazon announces quarter results', 'issuer_release', [['Amazon.com announces']]);
    add(archive, 'sec.gov', 'Amazon ' + year + ' quarterly form 10-Q', 'regulatory_filing');
    add(archive, 'cnbc.com', 'Amazon AMZN earnings report ' + year + ' capital expenditures', 'earnings_coverage');
  }
  const event = typeof market?.eventSlug === 'string' ? market.eventSlug.replaceAll('-', ' ') : '';
  if (/\bNVIDIA\b/i.test(title + ' ' + event) && /\b(?:CEO|resignation|removal)\b/i.test(title)) {
    const names = [['Jensen Huang', 'Jen-Hsun Huang'], ['CEO', 'Chief Executive Officer']];
    add(listing, 'nvidianews.nvidia.com', 'NVIDIA Jensen Huang CEO reinstates appoints announces transition', 'leadership_release', names);
    add(listing, 'nvidianews.nvidia.com', 'NVIDIA CEO announces departure transition resignation', 'leadership_release',
      [['CEO Transition', 'CEO Departure', 'CEO Resignation', 'CEO Succession']]);
    add(listing, 'nvidianews.nvidia.com', 'NVIDIA Board national security export control oversight committee', 'leadership_oversight',
      [['NVIDIA'], ['export control'], ['committee']]);
    add(listing, 'dw.com', 'Nvidia Jensen Huang CEO reinstates', 'leadership_reporting', names);
    add(listing, 'axios.com', 'Nvidia Jensen Huang board government investigation', 'leadership_reporting', [names[0], names[1]]);
    add(archive, 'sec.gov', 'NVIDIA executive appointment or departure Form 8-K Item 5.02', 'leadership_filing');
  }
  return { listing, archive };
}

function officialMarketRecords(market: Record<string, unknown> | undefined, intent: string, discovered: Hit[]): Hit[] {
  const title = String(market?.title ?? '');
  const rules = String(market?.rules ?? '');
  const results: Hit[] = [];
  const add = (href: string, label: string, document: string) => {
    const url = new URL(href);
    results.push({ rank: results.length + 1, url: url.href, domain: url.hostname, title: label, document,
      snippet: '', snippetTruncated: false, engines: ['official-record-route'] });
  };
  const nbaSeason = /^nba-[a-z]{2,4}-[a-z]{2,4}-(\d{4})-\d{2}-\d{2}$/.exec(String(market?.slug));
  if (nbaSeason && /NBA\s*(?:Cup|杯)|group (?:stage|play)|杯赛|小组赛/i.test(intent)) {
    add(sourceSetting('PM_NBA_URL') + '/nba-cup/' + nbaSeason[1] + '/groups', 'NBA Cup Group Play ' + nbaSeason[1], 'nba_cup_groups');
  }
  // Look up dated league bulletins around scheduled tip-off. A candidate URL alone proves no status.
  if (/^nba-[a-z]{2,4}-[a-z]{2,4}-\d{4}-\d{2}-\d{2}$/.test(String(market?.slug)) &&
      /originally scheduled for/i.test(rules) && /injury report|伤病报告/i.test(intent)) {
    const tip = Date.parse(String(market?.endDate));
    const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    for (const minutesBefore of [75, 60, 45, 30, 15]) {
      const at = tip - minutesBefore * 60_000;
      if (!Number.isFinite(at) || at > Date.now() || at % 900_000 !== 0) continue;
      const time = clock.format(at).replace(':', '_').replace(/\s/g, '');
      add(sourceSetting('PM_NBA_CDN_URL') + '/referee/injury/Injury-Report_' + day.format(at) + '_' + time + '.pdf',
        'NBA Injury Report ' + day.format(at) + ' ' + clock.format(at) + ' ET', 'nba_injury_report');
    }
  }
  for (const url of ruleReferences(rules)) {
    if (/^https:\/\/www\.federalreserve\.gov\/monetarypolicy\/(?:fomccalendars|openmarket)\.htm$/.test(url)) {
      const calendar = url.includes('fomccalendars');
      add(url, calendar ? 'FOMC meeting calendar' : 'Federal Reserve open market operations', calendar ? 'fed_calendar' : 'fed_rate');
    }
    if (/^https:\/\/data\.ornn\.com\/markets\/[a-z\d-]+$/i.test(url)) add(url, 'Ornn daily settled index values', 'ornn_daily_index');
  }
  const pce = /\bPersonal Income and Outlays report for ([A-Z][a-z]+) (20\d\d)\b/i.exec(rules);
  let period: Date | undefined;
  if (pce && /\bBureau of Economic Analysis\b/i.test(rules)) period = new Date(pce[1] + ' 1, ' + pce[2] + ' UTC');
  else if (!market && /\bPCE\b|个人消费支出物价/i.test(intent)) {
    // In an unbound news question, take the period from a discovered BEA release matching the requested month.
    const periods = discovered.flatMap(hit => {
      const match = /^https:\/\/(?:www\.)?bea\.gov\/news\/(20\d\d)\/personal-income-and-outlays-([a-z]+)-\1\/?$/i.exec(hit.url);
      if (!match) return [];
      const date = new Date(match[2] + ' 1, ' + match[1] + ' UTC');
      const years = intent.match(/\b20\d\d\b/g);
      if (!Number.isFinite(date.getTime()) || years && !years.includes(match[1]) ||
          !new RegExp('\\b' + match[2] + '\\b|(?:^|\\D)' + (date.getUTCMonth() + 1) + '\\s*月', 'i').test(intent)) return [];
      return [date.getTime()];
    });
    if (periods.length && new Set(periods.map(t => new Date(t).getUTCFullYear())).size === 1) period = new Date(Math.max(...periods));
  }
  if (period && Number.isFinite(period.getTime())) {
    const compare = pce || /上期|上月|比.{0,6}月|比较|对比|升温|加速|放缓|previous|prior|compar|accelerat|hotter|cooler/i.test(intent);
    for (const offset of compare ? [0, -1] : [0]) {
      const day = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + offset, 1));
      const year = day.getUTCFullYear();
      const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(day);
      add(`${sourceSetting('PM_BEA_URL')}/news/${year}/personal-income-and-outlays-${month.toLowerCase()}-${year}`,
        `BEA Personal Income and Outlays, ${month} ${year}`, offset ? 'bea_previous_release' : 'bea_target_release');
    }
    if (market || /日历|何时|几点|时间|schedule/i.test(intent)) add(sourceSetting('PM_BEA_URL') + '/news/schedule', 'BEA release schedule', 'bea_schedule');
  }
  const election = /\bTaiwanese local elections are scheduled to be held on [A-Za-z]+ \d{1,2}, (20\d\d)\b/i.exec(rules);
  if (election && /\bTaipei Mayor\b/i.test(title) && !/\bNew Taipei\b/i.test(title) &&
      ruleReferences(rules).some(url => hostMatches(new URL(url).hostname, ['cec.gov.tw']))) {
    const year = Number(election[1]) - 1911;
    add(`${sourceSetting('PM_TAIWAN_CEC_URL')}/01選舉公報/03直轄市長/${year}年/臺北市市長.pdf`,
      `${year}年臺北市市長選舉公報`, 'election_bulletin');
  }
  return results;
}

function searchCapture(row: EvidenceRow | undefined) {
  if (row?.source !== searchSource || !object(row.data) || !object(row.data.content) || !object(row.data.content.value)) {
    throw new Error('需要 search_market_sources 保存的搜索证据 ID。');
  }
  return row.data.content.value as { status: string; newsSince?: string; market?: { marketEvidenceId: string; slug?: string }; ruleLinks: string[];
    candidates: ReturnType<typeof rankCandidates>; queries: QueryReport[];
    primaryCandidates?: Hit[];
    counts: { searchAttempts: number; paidAttempts: number; tavilyCredits: number } };
}

function compactSearchReports(reports: QueryReport[]) {
  return reports.map(({ attempts, ...query }) => ({ ...query, attempts: [
    ...attempts.filter(attempt => !attempt.publisher),
    ...attempts.filter(attempt => attempt.publisher && attempt.results.length)
      .sort((a, b) => (b.results[0].feedScore ?? 0) - (a.results[0].feedScore ?? 0)).slice(0, 12),
  ].map(({ results, ...attempt }) =>
    ({ ...attempt, retainedResults: results.length, results: results.map(({ rank, url, title, publishedAt, publicationDay, document, upstreamUrl, upstreamPublisher }) =>
      ({ rank, url, title, publishedAt, publicationDay, document, upstreamUrl, upstreamPublisher })) })) }));
}

function mcpRequest(name: string, args: unknown) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
}

async function responsePayload(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  // The hosted Exa MCP returns a single tools/call result in an SSE data event.
  for (const line of (await response.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const message: unknown = JSON.parse(line.slice(5));
    if (object(message) && message.id === 1) return message;
  }
  throw new Error('missing_mcp_result');
}

function exaText(payload: unknown) {
  if (!object(payload) || !object(payload.result) || payload.result.isError ||
      !Array.isArray(payload.result.content)) return;
  return payload.result.content.filter(object).filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function exaResults(payload: unknown) {
  const text = exaText(payload);
  if (text === undefined) return;
  const entries = [...text.matchAll(/^Title:\s*([^\n]+)\nURL:\s*(https?:\/\/\S+)\s*\n(?:Published:\s*([^\n]+)\n)?/gm)];
  if (!entries.length && text.trim() && !/^no (?:search )?results\b/i.test(text.trim())) return;
  return entries.map((match, i) => ({ title: match[1], url: match[2], publishedDate: match[3] === 'N/A' ? undefined : match[3],
    content: text.slice(match.index + match[0].length, entries[i + 1]?.index)
      .replace(/^[\s\S]*?^(?:Highlights|Text):\s*/m, '').replace(/\n\s*---\s*$/, '').trim() }));
}

async function search(engine: Exclude<Engine, 'publisher-rss' | 'publisher-web' | 'publisher-json' | 'sec-edgar'>, endpoint: URL | null, query: Pick<QueryReport, 'keywords' | 'sourceDomains' | 'newsSince'>,
                      signal: AbortSignal, key?: string): Promise<Attempt> {
  const started = Date.now();
  const result: Attempt = { engine, startedAt: new Date(started).toISOString(), finishedAt: '', elapsedMs: 0,
    attempted: false, status: 'unavailable', engineErrors: [], results: [], truncated: false, returned: 0 };
  const timeout = AbortSignal.timeout(14_000);
  try {
    signal.throwIfAborted();
    if (!endpoint) {
      result.reason = 'searxng_endpoint_missing_or_invalid';
      return result;
    }
    const url = new URL(endpoint);
    const { keywords, sourceDomains, newsSince } = query;
    const day = newsSince && Date.now() - Date.parse(newsSince + 'T00:00:00+08:00') <= 86_400_000;
    const terms = keywords.replace(/(?:^| )-?site:[a-z\d.-]+/gi, ' ').replace(/ +/g, ' ').trim();
    const scopedKeywords = sourceDomains.length && !/\bsite:/i.test(keywords) ? `${keywords} site:${sourceDomains[0]}` : keywords;
    let body: unknown;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (engine === 'searxng') {
      result.searxEngine = url.searchParams.get('engines') ?? undefined;
      url.searchParams.set('q', scopedKeywords);
      url.searchParams.set('format', 'json');
      if (newsSince) url.searchParams.set('time_range', day ? 'day' : 'week');
    } else if (engine === 'serper') {
      headers['X-API-KEY'] = key!;
      body = { q: scopedKeywords, num: maxResults };
    } else if (engine === 'langsearch') {
      headers.Authorization = `Bearer ${key}`;
      body = { query: terms, count: maxResults, ...(sourceDomains.length ? { includeDomains: sourceDomains } : {}),
        ...(newsSince ? { freshness: day ? 'oneDay' : 'oneWeek' } : {}) };
    } else if (engine === 'tavily') {
      headers.Authorization = `Bearer ${key}`;
      body = { query: terms, max_results: maxResults, search_depth: 'basic', auto_parameters: false, include_usage: true,
        ...(sourceDomains.length ? { include_domains: sourceDomains } : {}) };
    } else {
      headers.Accept = 'application/json, text/event-stream';
      body = mcpRequest('web_search_exa', { query: terms, numResults: maxResults,
        objective: newsSince ? `Find original news reporting or official first-hand statements published on or after ${newsSince} about the exact event. Prefer dated reporting from independent publishers, including AP, Reuters, local news and official publications. Verify actual publication date and exclude old articles or generic market summaries.`
          : sourceDomains.length ? `Find the original records matching these terms. Prefer specific, dated pages and archives to homepages or rolling reports. Prioritize ${sourceDomains.join(', ')}.`
          : 'Find specific original primary-source records that match these search terms. Prefer official reports, records, and documentation over summaries.' });
    }
    result.attempted = true;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, timeout]),
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      result.status = 'failed';
      result.reason = `HTTP_${response.status}`;
      return result;
    }
    const payload = await responsePayload(response);
    let rows: unknown;
    if (engine === 'langsearch') {
      if (!object(payload) || (payload.code !== 200 && payload.code !== '200')) {
        result.status = 'failed';
        const code = object(payload) ? payload.code : undefined;
        result.reason = (typeof code === 'string' || typeof code === 'number') && /^\d{3}$/.test(String(code))
          ? `langsearch_code_${code}` : 'invalid_search_response';
        return result;
      }
      const pages = object(payload.data) ? payload.data.webPages : undefined;
      rows = object(pages) ? pages.value : pages === undefined && object(payload.data) ? [] : undefined;
    } else {
      rows = engine === 'exa' ? exaResults(payload) : object(payload) ? payload[engine === 'serper' ? 'organic' : 'results'] : undefined;
    }
    if (object(payload) && object(payload.usage) && typeof payload.usage.credits === 'number') result.credits = payload.usage.credits;
    if (object(payload) && Array.isArray(payload.unresponsive_engines)) {
      result.engineErrors = payload.unresponsive_engines.filter(Array.isArray).slice(0, 30)
        .map(([engine, reason]) => ({ engine: clean(engine, 60), reason: clean(reason, 180) }));
    }
    if (!Array.isArray(rows) && !(engine === 'serper' && object(payload) && object(payload.searchParameters) && rows === undefined)) {
      result.status = 'failed';
      result.reason = 'invalid_search_response';
      return result;
    }
    const hits = Array.isArray(rows) ? rows : [];
    result.returned = hits.length;
    const earliest = newsSince ? Date.parse(newsSince + 'T00:00:00+08:00') : -Infinity;
    let excludedByDate = false;
    for (const [index, row] of hits.slice(0, maxResults).entries()) {
      if (!object(row)) continue;
      const url = httpUrl(engine === 'serper' ? row.link : row.url);
      if (!url || sourceDomains.length && !hostMatches(url.hostname, sourceDomains)) continue;
      const excerpt = engine === 'serper' || engine === 'langsearch' ? row.snippet ?? row.text : row.content;
      const snippet = clean(excerpt, 300);
      const publishedAt = clean(row.datePublished ?? row.publishedDate ?? row.published_date ?? row.date, 80);
      if (Date.parse(publishedAt) < earliest) { excludedByDate = true; continue; }
      const rank = engine === 'serper' && typeof row.position === 'number' && Number.isSafeInteger(row.position) && row.position > 0
        ? row.position : index + 1;
      const engines = Array.isArray(row.engines) ? row.engines.map(value => clean(value, 60)).filter(Boolean) : [];
      result.results.push({ rank, url: url.href, domain: url.hostname, title: clean(row.title ?? row.name, 220), snippet,
        snippetTruncated: clean(excerpt, 301).length > snippet.length,
        engines: engines.length ? engines : [clean(row.engine, 60) || engine],
        publishedAt: publishedAt || undefined });
    }
    result.truncated = hits.length > maxResults || result.results.some(hit => hit.snippetTruncated);
    result.status = result.results.length ? 'ok' : result.engineErrors.length || hits.length ? 'failed' : 'empty';
    if (!result.results.length && (excludedByDate || hits.length && sourceDomains.length)) {
      result.status = 'empty';
      result.reason = excludedByDate ? 'no_result_in_requested_news_window' : 'no_result_on_requested_domains';
    } else if (result.status === 'failed') result.reason = hits.length ? 'no_usable_result_urls' : 'upstream_engines_failed';
    return result;
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'failed';
    const cause = error instanceof Error ? error.cause : undefined;
    const code = object(cause) && typeof cause.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : undefined;
    result.reason = signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : error instanceof SyntaxError ? 'invalid_json' : code ?? 'network_error';
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = Date.now() - started;
  }
}

function domainsFor(keywords: string, domains: string[] = []) {
  return [...new Set([...domains, ...Array.from(keywords.matchAll(/(?:^| )site:([a-z\d.-]+)/gi), match => match[1])]
    .map(domain => domain.toLowerCase().replace(/^www\./, '')))].slice(0, 3);
}

const hostMatches = matchesPublisherDomain;

function publisherInScope(publisher: NewsPublisher, scope: string[]) {
  return !scope.length || publisher.domains.some(domain => scope.some(host => hostMatches(host, [domain]) || hostMatches(domain, [host])));
}

function candidateKey(input: string) {
  const url = new URL(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  if (!url.search && url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}

function candidateWords(hit: Hit) {
  const path = new URL(hit.url).pathname;
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Keep the literal path when encoding is invalid. */ }
  return hit.title + ' ' + hit.snippet + ' ' + decoded.replace(/[-_/]/g, ' ');
}

function officialPdf(url: URL) {
  return url.protocol === 'https:' && !url.port && /\.pdf$/i.test(url.pathname) &&
    (url.hostname === 'ak-static.cms.nba.com' && url.pathname.startsWith('/referee/injury/') || /(?:^|\.)(?:gov|gov\.tw|go\.jp|gov\.uk|europa\.eu|boj\.or\.jp|ir\.aboutamazon\.com|alpo\.ge)$/i.test(url.hostname));
}

export async function officialBody(response: Response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error('HTTP_' + response.status);
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 8_000_000) throw Error('document_too_large');
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts, bytes);
}

export async function capturePolymarketPriceWindow(db: DatabaseSync, row: EvidenceRow, signal: AbortSignal) {
  const market = resolution(row);
  const slug = typeof market.slug === 'string' && /^btc-updown-5m-(\d{10})$/.exec(market.slug);
  if (!slug || market.eventSlug !== slug[0] ||
      !ruleReferences(market.rules).includes('https://data.chain.link/streams/btc-usd-twap-60s-streams')) return;
  const start = Number(slug[1]) * 1000;
  const end = start + 300_000;
  if (Date.parse(String(market.endDate)) !== end || Date.now() < end) return;
  const startUtc = new Date(start).toISOString().replace('.000Z', 'Z');
  const endUtc = new Date(end).toISOString().replace('.000Z', 'Z');
  const url = sourceSetting('PM_POLYMARKET_WEB_URL') + '/event/' + slug[0];
  const queryKey = ['crypto-prices', 'price', 'BTC', startUtc, 'fiveminute', endUtc, true, 60];
  const expectedKey = JSON.stringify(queryKey);
  let snapshot: { queryKey: typeof queryKey; state: Record<string, unknown> } | undefined;
  let reason = 'matching_final_twap_pair_unavailable';
  let httpStatus: number | undefined;
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      headers: { Accept: 'text/html' } });
    httpStatus = response.status;
    const html = (await officialBody(response)).toString('utf8').replaceAll('\\"', '"');
    const matches = [...html.matchAll(/"state":(\{"data":\{"openPrice":\d+(?:\.\d+)?,"closePrice":\d+(?:\.\d+)?\},[^<>]{0,850}?\}),"queryKey":(\["crypto-prices","price","BTC",[^\]]{0,180}\])/g)]
      .filter(match => match[2] === expectedKey).map(match => match[1]);
    if (matches.length && new Set(matches).size === 1) {
      const state = JSON.parse(matches[0]);
      if (state.status === 'success' && state.data.openPrice > 0 && state.data.closePrice > 0 &&
          Number.isFinite(state.data.openPrice) && Number.isFinite(state.data.closePrice) &&
          typeof state.dataUpdatedAt === 'number' && state.dataUpdatedAt >= end) snapshot = { queryKey, state };
    }
  } catch (error) {
    reason = signal.aborted ? 'cancelled' : httpStatus && httpStatus !== 200 ? 'HTTP_' + httpStatus
      : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'public_market_body_unavailable';
  }
  const saved = persistEvidence(db, url, { kind: 'source_capture', coverage: snapshot ? 'body' : 'link', recordKey: url,
    captureProvider: 'polymarket_chainlink_twap_replay', marketEvidenceId: row.evidenceId, inputEvidenceIds: [row.evidenceId],
    startUtc, endUtc, httpStatus, ...(snapshot ? { content: { format: 'json', value: snapshot } } :
      { failure: { stage: httpStatus === 200 ? 'validate' : 'access', reason } }) });
  const prices = snapshot?.state.data as { openPrice: number; closePrice: number } | undefined;
  return { ...saved, prices, startUtc, endUtc, status: prices ? 'ok' : 'failed', reason: prices ? undefined : reason };
}

// Resolve a live box score from the dated slate, using both teams in home/away order.
async function nbaBoxScoreIndex(day: string, teams: string[], signal: AbortSignal): Promise<Attempt> {
  const indexUrl = sourceSetting('PM_ESPN_API_URL') + '/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + day.replaceAll('-', '');
  const started = Date.now();
  const report: Attempt = { engine: 'espn-scoreboard', startedAt: new Date(started).toISOString(), finishedAt: '',
    elapsedMs: 0, attempted: true, status: 'empty', results: [], engineErrors: [], truncated: false, returned: 0, indexUrl };
  try {
    const response = await fetch(indexUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), redirect: 'error' });
    const slate = JSON.parse((await officialBody(response)).toString('utf8'));
    const matches = slate.events.filter((event: { name: string; id: string; date: string }) => {
      const pair = String(event.name).split(' at ');
      return /^\d+$/.test(event.id) && pair.length === 2 && teams.every((name, i) =>
        pair[i].toLowerCase().endsWith(' ' + name.toLowerCase())) &&
        new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(event.date)) === day;
    });
    if (matches.length === 1) {
      const game = matches[0];
      report.results.push({ rank: 1, url: sourceSetting('PM_ESPN_API_URL') + '/apis/site/v2/sports/basketball/nba/summary?event=' + game.id,
        domain: 'site.api.espn.com', title: game.name + ' game box score ' + day, document: 'nba_box_score',
        snippet: '', snippetTruncated: false, engines: ['espn-scoreboard'] });
      report.status = 'ok';
      const recap = Array.isArray(game.links) && game.links.find((link: unknown) => object(link) && Array.isArray(link.rel) && link.rel.includes('recap'));
      const url = httpUrl(recap?.href);
      if (game.status?.type?.completed === true && url?.origin === sourceSetting('PM_ESPN_WEB_URL') && url.pathname === '/nba/recap' &&
          url.searchParams.get('gameId') === game.id) report.results.push({ rank: 2, url: url.href, domain: url.hostname,
        title: game.name + ' game recap ' + day, document: 'nba_recap', snippet: '', snippetTruncated: false, engines: ['espn-scoreboard'] });
      report.returned = report.results.length;
    } else report.reason = matches.length ? 'ambiguous_fixture' : 'fixture_not_found';
  } catch (e) {
    report.status = signal.aborted ? 'cancelled' : 'failed';
    report.reason = signal.aborted ? 'cancelled' : e instanceof Error ? e.message.slice(0, 100) : 'scoreboard_unavailable';
  }
  report.elapsedMs = Date.now() - started;
  report.finishedAt = new Date().toISOString();
  return report;
}

async function readNbaBoxScore(url: URL, signal: AbortSignal, recap = false) {
  if (recap) {
    const id = url.searchParams.get('gameId') ?? '';
    if (url.origin !== sourceSetting('PM_ESPN_WEB_URL') || url.pathname !== '/nba/recap' || !/^\d+$/.test(id)) throw Error('document_identity_mismatch');
    url = new URL(sourceSetting('PM_ESPN_API_URL') + '/apis/site/v2/sports/basketball/nba/summary?event=' + id);
  }
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), redirect: 'error' });
  const data = JSON.parse((await officialBody(response)).toString('utf8'));
  const game = data.header?.competitions?.[0];
  if (!game || String(game.id) !== url.searchParams.get('event')) throw Error('game_id_mismatch');
  if (recap) {
    const article = data.article;
    const link = httpUrl(article?.links?.web?.href);
    if (!game.status?.type?.completed || article?.premium !== false || typeof article.story !== 'string' ||
        link?.hostname !== 'www.espn.com' || link.pathname !== '/nba/recap' || link.searchParams.get('gameId') !== String(game.id))
      throw Error('document_recap_unavailable');
    const text = decodePublisherText(article.story.replace(/<\/(?:p|div)>/gi, '\n').replace(/<[^>]*>/g, ' ')).trim();
    if (text.length < 160) throw Error('document_text_empty');
    const body = [article.source && 'Author: ' + article.source, article.headline, text].filter(Boolean).join('\n');
    return { body: body.slice(0, storedBodyLimit), truncated: body.length > storedBodyLimit,
      publicationDay: typeof article.published === 'string' ? article.published.slice(0, 10) : undefined };
  }
  const teams = game.competitors.map((t: { team: {displayName: string}; score: string; homeAway: string }) =>
    ({ team: t.team.displayName, score: t.score, homeAway: t.homeAway }));
  const players = (data.boxscore?.players ?? []).flatMap((t: { team: {displayName: string}; statistics: {
    labels: string[]; athletes: {athlete: {displayName: string}; starter?: boolean; didNotPlay?: boolean; stats?: string[]}[] }[] }) =>
    t.statistics.flatMap(group => group.athletes.map(p => ({ team: t.team.displayName, player: p.athlete.displayName,
      starter: p.starter, didNotPlay: p.didNotPlay,
      stats: Object.fromEntries((p.stats ?? []).map((value, i) => [group.labels[i], value])) }))));
  return { body: JSON.stringify({ date: game.date, venue: data.gameInfo?.venue?.fullName, status: game.status, teams, players }), truncated: false };
}

async function issuerFilings(query: { keywords: string; document: string }, signal: AbortSignal): Promise<Attempt> {
  const started = Date.now();
  const leadership = query.document === 'leadership_filing';
  const issuer = leadership ? { cik: 1045810, name: 'NVIDIA', file: /^nvda-\d{8}\.htm$/i, forms: ['8-K', '8-K/A'] }
    : { cik: 1018724, name: 'Amazon', file: /^amzn-\d{8}\.htm$/i, forms: ['10-Q', '10-K'] };
  const indexUrl = sourceSetting('PM_SEC_DATA_URL') + '/submissions/CIK' + String(issuer.cik).padStart(10, '0') + '.json';
  const report: Attempt = { engine: 'sec-edgar', startedAt: new Date(started).toISOString(), finishedAt: '',
    elapsedMs: 0, attempted: false, status: 'empty', results: [], engineErrors: [], truncated: false, returned: 0, indexUrl };
  try {
    signal.throwIfAborted();
    report.attempted = true;
    const response = await fetch(indexUrl, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      headers: { Accept: 'application/json', 'User-Agent': 'pm-personal-agent/0.1 public evidence' } });
    const index: unknown = JSON.parse((await officialBody(response)).toString('utf8'));
    if (!object(index) || Number(index.cik) !== issuer.cik || !object(index.filings) || !object(index.filings.recent)) {
      throw Error('invalid_edgar_index');
    }
    const { form, reportDate, filingDate, accessionNumber, primaryDocument, items } = index.filings.recent;
    const year = query.keywords.match(/\b20\d{2}\b/)?.[0];
    if (Array.isArray(form) && Array.isArray(reportDate) && Array.isArray(filingDate) &&
        Array.isArray(accessionNumber) && Array.isArray(primaryDocument)) {
      report.results = form.flatMap((kind, i): Hit[] => {
        const day = clean(reportDate[i], 12), accession = clean(accessionNumber[i], 30), file = clean(primaryDocument[i], 90);
        if (!issuer.forms.includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
            !issuer.file.test(file) || year && !day.startsWith(year) ||
            leadership && (!Array.isArray(items) || !/\b5\.02\b/.test(String(items[i])))) return [];
        return [{ rank: 1, url: sourceSetting('PM_SEC_WEB_URL') + '/Archives/edgar/data/' + issuer.cik + '/' + accession.replaceAll('-', '') + '/' + file,
          domain: 'www.sec.gov', title: issuer.name + ' Form ' + kind + ' for ' + day, snippet: '',
          engines: ['sec-edgar'], publicationDay: clean(filingDate[i], 12), document: query.document, snippetTruncated: false }];
      }).sort((left, right) => (right.publicationDay ?? '').localeCompare(left.publicationDay ?? '')).slice(0, leadership ? 2 : 1)
        .map((hit, i) => ({ ...hit, rank: i + 1, document: i === 1 ? 'leadership_prior_filing' : hit.document }));
    }
    report.returned = report.results.length;
    report.status = report.returned ? 'ok' : 'empty';
  } catch (error) {
    report.status = signal.aborted ? 'cancelled' : 'failed';
    report.reason = error instanceof Error && /^HTTP_\d{3}$/.test(error.message) ? error.message :
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : signal.aborted ? 'cancelled' : 'edgar_index_unavailable';
  } finally {
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - started;
  }
  return report;
}

async function cnbcFilingCoverage(filing: Hit, signal: AbortSignal): Promise<Attempt[]> {
  const period = /\b(20\d{2})-(\d{2})-\d{2}\b/.exec(filing.title);
  const filed = Date.parse(filing.publicationDay ?? '');
  if (!period || !Number.isFinite(filed)) return [];
  const days = [filed, filed - 86_400_000].map(time => new Date(time));
  const quarter = Math.ceil(Number(period[2]) / 3);
  return Promise.all(days.map(async date => {
    const day = date.toISOString().slice(0, 10);
    const month = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(date);
    const endpoint = sourceSetting('PM_CNBC_URL') + '/site-map/articles/' + date.getUTCFullYear() + '/' + month + '/' + day.slice(-2) + '/';
    const started = Date.now();
    const result: Attempt = { engine: 'publisher-web', publisher: 'CNBC', publisherId: 'cnbc.com', indexUrl: endpoint,
      startedAt: new Date(started).toISOString(), finishedAt: '', elapsedMs: 0, attempted: false,
      status: 'empty', engineErrors: [], results: [], truncated: false, returned: 0 };
    try {
      signal.throwIfAborted();
      result.attempted = true;
      const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pm-personal-agent/0.1)' } });
      const html = (await officialBody(response)).toString('utf8');
      const titles = html.matchAll(/\{"__typename":"cnbcnewsstory","title":("(?:[^"\\]|\\.)*"),"url":("(?:[^"\\]|\\.)*")/g);
      for (const [, rawTitle, rawUrl] of titles) {
        const title = String(JSON.parse(rawTitle));
        const url = httpUrl(JSON.parse(rawUrl));
        if (!url || !hostMatches(url.hostname, ['cnbc.com']) || !url.pathname.startsWith('/' + day.replaceAll('-', '/') + '/') ||
            !matchesNewsEntities(title, [['Amazon', 'AMZN']]) ||
            !new RegExp('\\bq' + quarter + '\\b.*\\bearnings\\b', 'i').test(url.pathname)) continue;
        result.results.push({ rank: 1, url: url.href, domain: url.hostname, title, snippet: '', engines: ['cnbc.com'],
          publicationDay: day, document: 'earnings_coverage', snippetTruncated: false });
        break;
      }
      result.indexRetrievedAt = new Date().toISOString();
      result.returned = result.results.length;
      result.status = result.returned ? 'ok' : 'empty';
    } catch (error) {
      result.status = signal.aborted ? 'cancelled' : 'failed';
      result.reason = error instanceof Error && /^HTTP_\d{3}$/.test(error.message) ? error.message :
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : signal.aborted ? 'cancelled' : 'publisher_index_unavailable';
    } finally {
      result.finishedAt = new Date().toISOString();
      result.elapsedMs = Date.now() - started;
    }
    return result;
  }));
}

export async function readOfficialPdf(url: URL, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const response = await fetch(url, { redirect: 'error', signal: deadline, headers: {
    Accept: 'application/pdf,application/octet-stream',
    'User-Agent': 'pm-personal-agent/0.1 (official public evidence)',
  } });
  const document = await officialBody(response);
  if (!document.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('invalid_pdf');
  deadline.throwIfAborted();
  const extraction = runFile('/usr/bin/pdftotext', ['-layout', '-f', '1', '-l', '24', '-', '-'],
    { signal: deadline, maxBuffer: 750_000 });
  extraction.child.stdin!.on('error', () => undefined);
  extraction.child.stdin!.end(document);
  const { stdout } = await extraction;
  const body = stdout.trim();
  if (body.length < 30) throw Error('pdf_text_empty');
  const pages = stdout.split('\f').filter(page => page.trim()).length;
  return { body: body.slice(0, storedBodyLimit), truncated: pages >= 24 || body.length > storedBodyLimit, pages };
}

async function readOfficialHtml(start: URL, signal: AbortSignal, preserveLinks = false, articleOnly = false, nbaDay?: string) {
  let url = start;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(9_000)]);
  for (let redirects = 0; redirects < 3; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal: deadline, headers: {
      Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; pm-personal-agent/0.1)',
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = URL.parse(response.headers.get('location') ?? '', url);
      await response.body?.cancel();
      if (!next || next.protocol !== 'https:' || next.port || next.username || next.password ||
          !hostMatches(next.hostname, [start.hostname.replace(/^(?:www|cfm\d)\./, '')])) throw Error('redirect_outside_publisher');
      url = next;
      continue;
    }
    const html = (await officialBody(response)).toString('utf8');
    const nbaGame = url.hostname === 'www.nba.com' && /^\/game\/[a-z]+-vs-[a-z]+-(\d{10})\/?$/i.exec(url.pathname);
    if (nbaGame) {
      const embedded = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
      const page = embedded && JSON.parse(embedded[1])?.props?.pageProps;
      const story = page?.story;
      if (page?.game?.gameId !== nbaGame[1] || nbaDay && page.game.gameCode?.split('/')[0] !== nbaDay.replaceAll('-', '') ||
          page.game.gameStatus !== 3 || story?.storyType !== 'recap' ||
          !Array.isArray(story.content)) throw Error('document_recap_unavailable');
      const paragraphs = story.content.filter((p: unknown): p is string => typeof p === 'string').map((p: string) =>
        decodePublisherText(p.replace(/<[^>]*>/g, ' ')).trim()).filter(Boolean);
      const body = paragraphs.join('\n\n');
      if (body.length < 160) throw Error('document_recap_unavailable');
      return { body: body.slice(0, storedBodyLimit), truncated: body.length > storedBodyLimit,
        publicationDay: typeof story.date === 'string' ? story.date.slice(0, 10) : undefined };
    }
    if (isPublisherIndex(html)) throw Error('html_index_only');
    if (!/<(?:html|article|main|body)\b/i.test(html) ||
        /<title[^>]*>\s*(?:Access Denied|Just a moment|403 Forbidden|Page Not Found|SEC\.gov \| Your Request)/i.test(html)) {
      throw Error('html_body_missing');
    }
    let markup = html.replace(/<(script|style|svg|noscript|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    if (preserveLinks) markup = markup.replace(/<a\b[^>]*\bhref=["']([^"'<>]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (original, href, label) => {
        const link = URL.parse(decodePublisherText(href), url);
        return link?.protocol === 'https:' && !link.username && !link.password && !/[()\s]/.test(link.href)
          ? '[' + label.replace(/<[^>]+>|[\[\]]/g, '') + '](' + link.href + ')' : original;
      });
    const plain = (part: string) => decodePublisherText(part.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    let text = plain(markup);
    if (articleOnly) {
      const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(markup)?.[1] ??
        /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(markup)?.[1] ?? markup;
      const paragraphs = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => plain(m[1]))
        .filter(p => p.length >= 30 && !/enable javascript|subscribe to (?:read|continue)|accept all cookies/i.test(p));
      if (paragraphs.join('').length < 160) throw Error('html_body_missing');
      const headline = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(markup)?.[1] ?? '';
      text = [plain(headline), ...new Set(paragraphs)].filter(Boolean).join('\n');
    }
    if (text.length < 120) throw Error('html_body_missing');
    const publication = /<meta\b(?=[^>]*\b(?:property|name)=["']article:published_time["'])[^>]*\bcontent=["'](20\d\d-\d\d-\d\d)[^"']*["']/i.exec(html);
    return { body: text.slice(0, storedBodyLimit), truncated: text.length > storedBodyLimit, publicationDay: publication?.[1] };
  }
  throw Error('redirect_limit');
}

function publisherFlash(url: URL) {
  if (url.protocol !== 'https:' || url.port) return;
  if (url.origin === sourceSetting('PM_JIN10_WEB_URL') && /^\/detail\/\d{18,24}\/?$/.test(url.pathname)) return 'jin10-flash' as const;
  if (url.hostname === 'eqn.news' && /^\/(?:main|tradfi|monitor)\/\d{1,12}\/?$/.test(url.pathname)) return 'equation-news' as const;
}

async function readPublisherFlash(url: URL, provider: NonNullable<ReturnType<typeof publisherFlash>>, hit: Hit | undefined, signal: AbortSignal) {
  const id = url.pathname.split('/').filter(Boolean).at(-1)!;
  const endpoint = provider === 'equation-news' ? sourceSetting('PM_EQN_URL') + '/public/v1/news/' + id : url;
  const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), headers: {
    Accept: provider === 'equation-news' ? 'application/json' : 'text/html',
    'User-Agent': 'Mozilla/5.0 (compatible; pm-personal-agent/0.1)',
  } });
  const raw = (await officialBody(response)).toString('utf8');
  if (provider === 'jin10-flash') {
    const start = /<div\b[^>]*class=["']detail-content["'][^>]*>/i.exec(raw);
    if (!start) throw Error('html_body_missing');
    const article = raw.slice(start.index, start.index + 20_000)
      .split(/<div\b[^>]*class=["'](?:flash-remark|detail-media-wrap|detail-bottom)\b/i)[0];
    if (!/class=["']content-title["']/i.test(article) || !/class=["']content-time["']/i.test(article)) throw Error('html_body_missing');
    const text = decodePublisherText(article.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length < 20) throw Error('html_body_missing');
    const upstream = httpUrl(hit?.upstreamUrl)?.href;
    return { body: '金十数据公开快讯\n' + text + (upstream ? '\n[上游报道](' + upstream + ')' : ''),
      truncated: article.length >= 20_000, upstreamUrl: upstream, upstreamPublisher: hit?.upstreamPublisher };
  }
  const doc: unknown = JSON.parse(raw);
  const pageUrl = object(doc) ? httpUrl(doc.url) : null;
  if (!object(doc) || String(doc.no) !== id || !pageUrl || candidateKey(pageUrl.href) !== candidateKey(url.href)) {
    throw Error('document_identity_mismatch');
  }
  const upstream = httpUrl(doc.source_url)?.href, publisher = clean(doc.source, 120);
  const content = clean(doc.body, storedBodyLimit + 1) || clean(doc.zh, storedBodyLimit + 1) || clean(doc.en, storedBodyLimit + 1);
  const date = clean(doc.time, 40);
  if (!content || !Number.isFinite(Date.parse(date))) throw Error('document_text_empty');
  const note = object(doc.data) && doc.data.note_tweet_truncated === true;
  // For reposts this is the published flash, with the originating post preserved as a link.
  const body = ['方程式新闻公开快讯', date, publisher && '上游发布方 ' + publisher, content,
    upstream && '[上游原文](' + upstream + ')'].filter(Boolean).join('\n');
  return { body: body.slice(0, storedBodyLimit), truncated: note || /…$/.test(content) || body.length > storedBodyLimit,
    upstreamUrl: upstream, upstreamPublisher: publisher || undefined };
}

async function readJina(proxy: string, requested: URL, preserveLinks: boolean, signal: AbortSignal) {
  const { stdout } = await runFile('/usr/bin/curl', ['--disable', '--silent', '--show-error',
    '--noproxy', '', '--proxy', proxy, '--max-time', '17', '--max-filesize', '1048576',
    '--header', 'Accept: application/json', '--header', 'Content-Type: application/json',
    ...(preserveLinks ? ['--header', 'X-With-Links-Summary: true'] : []),
    '--data-binary', JSON.stringify({ url: requested.href }), '--write-out', '\n%{http_code}', jinaEndpoint],
  { signal, maxBuffer: 1_050_000 });
  const split = stdout.lastIndexOf('\n');
  const status = stdout.slice(split + 1);
  if (status !== '200') return { reason: `HTTP_${status}` };
  const payload: unknown = JSON.parse(stdout.slice(0, split));
  const data = object(payload) && object(payload.data) ? payload.data : undefined;
  if (typeof data?.httpStatus === 'number' && (data.httpStatus < 200 || data.httpStatus >= 300)) {
    return { reason: `source_HTTP_${data.httpStatus}` };
  }
  const source = httpUrl(data?.finalUrl ?? data?.url);
  if (!source || candidateKey(source.href) !== candidateKey(requested.href) || typeof data?.content !== 'string') {
    return { reason: 'body_missing_or_wrong_url' };
  }
  if (data.content.trim().replace(/^#+\s*/, '') === data.title) return { reason: 'title_only' };
  return { content: data.content.trim() };
}

function rankCandidates(reports: QueryReport[]) {
  type Candidate = { url: string; title: string; snippet: string; scoped: boolean;
    publisher?: string; publisherId?: string; publishedAt?: string;
    ranks: { engine: Engine; searxEngine?: string; rank: number }[]; best: number };
  const candidates = new Map<string, Candidate>();
  const domains = [...new Set(reports.flatMap(report => report.sourceDomains))];
  for (const attempt of reports.flatMap(report => report.attempts)) {
    for (const hit of attempt.results) {
      const key = candidateKey(hit.url);
      const publisher = newsPublishers.find(source => hostMatches(hit.domain, source.domains));
      const candidate = candidates.get(key) ?? { url: hit.url, title: hit.title, snippet: hit.snippet,
        scoped: hostMatches(hit.domain, domains), publisher: publisher?.name, publisherId: publisher?.id,
        publishedAt: hit.publishedAt, ranks: [], best: 0 };
      candidate.publishedAt ??= hit.publishedAt;
      if (!candidate.ranks.some(rank => rank.engine === attempt.engine && rank.searxEngine === attempt.searxEngine && rank.rank === hit.rank)) {
        candidate.ranks.push({ engine: attempt.engine, searxEngine: attempt.searxEngine, rank: hit.rank });
      }
      const score = maxResults + 1 - hit.rank;
      if (score > candidate.best) Object.assign(candidate, { title: hit.title, snippet: hit.snippet, best: score });
      candidates.set(key, candidate);
    }
  }
  const score = (hit: Candidate) =>
    Number(hit.scoped) * 20 + hit.best + Number(!!hit.publisher) +
    new Set(hit.ranks.map(r => r.engine)).size - Number(new URL(hit.url).pathname === '/') * 3;
  return [...candidates.values()].sort((a, b) => score(b) - score(a)).slice(0, maxResults)
    .map(({ best: _best, ...hit }, i) => ({ ...hit, rank: i + 1 }));
}

function registeredNewsOutlet(hit: Hit) {
  const url = httpUrl(hit.url);
  if (!url || /^(?:site\.)?api\./i.test(url.hostname) || url.pathname === '/' ||
      /\/(?:scoreboard|box-?score|odds|standings|schedule|gamecast|stats)(?:\/|$)/i.test(url.pathname)) return;
  return newsPublishers.find(p => matchesPublisherDomain(hit.domain, p.domains));
}

// Keep the discovery route even when a publisher's own index and a search engine find the same article.
function roundupArticles(reports: QueryReport[], primary: Hit[], purpose: string) {
  const primaryUrls = new Set(primary.map(hit => candidateKey(hit.url)));
  const selected = new Map<string, { hit: Hit; routes: Set<'publisher' | 'web'>; registeredSite?: string }>();
  const origins = new Set<string>();
  const titles = new Set<string>();
  const topicWords = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(purpose.toLowerCase())]
    .filter(part => part.isWordLike && part.segment.length >= 2 && !/^\d+$/.test(part.segment)).map(part => part.segment);
  const topicScore = (hit: Hit) => topicWords.filter(word => hit.title.toLowerCase().includes(word)).length;
  for (const route of ['publisher', 'web'] as const) {
    const hits = reports.flatMap(query => query.attempts.filter(a => route === 'publisher' ? !!a.publisher :
      ['searxng', 'langsearch', 'exa', 'serper', 'tavily'].includes(a.engine)).flatMap(a => a.results))
      .sort((a, b) => topicScore(b) - topicScore(a) || (route === 'publisher' ? (b.feedScore ?? 0) - (a.feedScore ?? 0) : 0) || a.rank - b.rank);
    // One slot for a first-hand record or a registered outlet whose rolling index missed the story.
    const preferred = hits.find(hit => (route === 'publisher' ? registeredNewsOutlet(hit)?.group === 'official' : !!registeredNewsOutlet(hit)) &&
      !primaryUrls.has(candidateKey(hit.url)) && !origins.has(hit.domain.replace(/^www\./, '')));
    if (preferred) hits.unshift(preferred);
    let added = 0;
    for (const hit of hits) {
      const key = candidateKey(hit.url);
      const previous = selected.get(key);
      if (previous) { previous.routes.add(route); continue; }
      const origin = hit.upstreamPublisher || (httpUrl(hit.upstreamUrl)?.hostname ?? hit.domain).replace(/^www\./, '');
      const title = hit.title.trim().toLowerCase();
      if (added >= 2 || primaryUrls.has(key) || origins.has(origin) || titles.has(title) ||
          !title || new URL(hit.url).pathname === '/' || /\b(?:betting odds|where to watch|odds and predictions|picks today)\b/i.test(title)) continue;
      selected.set(key, { hit, routes: new Set([route]), registeredSite: registeredNewsOutlet(hit)?.id });
      origins.add(origin);
      titles.add(title);
      added++;
    }
  }
  return [...selected.values()].map(({ hit, routes, registeredSite }) => ({ url: hit.url, title: hit.title, registeredSite, routes: [...routes] }));
}

function ruleReferences(rules: unknown) {
  if (typeof rules !== 'string') return [];
  return [...new Set([...rules.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
    .map(match => httpUrl(match[0].replace(/[.,;]+$/, ''))?.href).filter((url): url is string => !!url))].slice(0, 12);
}

function savedLinkMatches(row: EvidenceRow, approvedUrls: string[], destination: URL) {
  const snapshot = sourceSnapshotFromEvidence(row);
  const base = httpUrl(snapshot.source);
  const body = snapshot.content?.value;
  const original = httpUrl(row.source);
  if (!base || typeof body !== 'string' || snapshot.coverage !== 'body' ||
      !approvedUrls.some(url => (original && candidateKey(url) === candidateKey(original.href)) || candidateKey(url) === candidateKey(base.href))) return false;
  for (const match of body.matchAll(/href=["']([^"'\s<>]+)["']|\]\(([^\s()<>]+)\)/gi)) {
    const linked = URL.parse((match[1] ?? match[2]).replaceAll('&amp;', '&'), base);
    if (linked && candidateKey(linked.href) === candidateKey(destination.href)) return true;
  }
  return false;
}

function publicKeywords(value: string) {
  const keywords = value.trim().replace(/ +/g, ' ');
  // The Skill selects public terms. Reject obvious pasted URLs, IDs and contact/credential strings at the boundary.
  if (!keywords.replace(/(?:^| )-?site:[a-z\d.-]+/gi, '').trim() || keywords.length > 180 ||
      /[\p{Cc}\p{Cf}]|:\/\/|(?:^| )!\S|\S@\S|\b0x[a-f\d]{40,}\b|\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b|\b(?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=]/iu.test(keywords)) {
    throw new Error('搜索关键词须为不超过 180 字的单行公开检索词，可用 site:，不要附链接、内部证据 ID 或私人信息。');
  }
  return keywords;
}

const billTypes = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'] as const;
const candleIntervals = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;
const officialParameters = { required: true, oneOf: [
  obj({ source: { ...required, const: 'govinfo_bill_status' },
    congress: { type: 'integer', required: true }, billType: { ...required, enum: billTypes }, billNumber: { type: 'integer', required: true } }),
  obj({ source: { ...required, const: 'awc_metar' }, station: required, startUtc: required, endUtc: required, timeZone: str }),
  obj({ source: { ...required, const: 'binance_spot_klines' }, symbol: required, interval: { ...required, enum: candleIntervals },
    openTimesUtc: { type: 'array', required: true, items: str }, timeZone: str }),
  obj({ source: { ...required, const: 'polymarket_chainlink_twap_replay' } }),
] } as const;
type OfficialQuery =
  | { source: 'govinfo_bill_status'; congress: number; billType: typeof billTypes[number]; billNumber: number }
  | { source: 'awc_metar'; station: string; startUtc: string; endUtc: string; timeZone?: string }
  | { source: 'binance_spot_klines'; symbol: string; interval: typeof candleIntervals[number]; openTimesUtc: string[]; timeZone?: string };

function officialSearchKeywords(query: OfficialQuery) {
  if (query.source === 'govinfo_bill_status') {
    return `US Congress ${query.congress} ${query.billType.toUpperCase()} ${query.billNumber} GovInfo bill status legislative actions`;
  }
  if (query.source === 'awc_metar') {
    return `Aviation Weather Center ${query.station} METAR observations ${query.startUtc} ${query.endUtc}`;
  }
  return `Binance Spot ${query.symbol} ${query.interval} Kline close ${query.openTimesUtc.join(' ')}`;
}

type OfficialObservation = {
  status: 'ok' | 'empty' | 'mismatch';
  content: { format: 'json' | 'text'; value: unknown };
  scope: Record<string, unknown>;
  reason?: string;
};

function utcMillis(value: string) {
  const ms = Date.parse(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || !Number.isFinite(ms) ||
      new Date(ms).toISOString().replace('.000Z', 'Z') !== value) {
    throw new Error('时间须为 UTC 整秒，格式 YYYY-MM-DDTHH:mm:ssZ。');
  }
  return ms;
}

function localClock(timeZone?: string) {
  return timeZone ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }) : undefined;
}

function compareCloses(a: string, b: string) {
  const [wholeA, fractionA = ''] = a.split('.');
  const [wholeB, fractionB = ''] = b.split('.');
  const digits = Math.max(fractionA.length, fractionB.length);
  const first = BigInt(wholeA + fractionA.padEnd(digits, '0'));
  const second = BigInt(wholeB + fractionB.padEnd(digits, '0'));
  return second > first ? 'higher' : second < first ? 'lower' : 'equal';
}

function inspectMetar(body: string, station: string, start: number, end: number, clock?: Intl.DateTimeFormat): OfficialObservation {
  const data: unknown = body.trim() ? JSON.parse(body) : [];
  if (!Array.isArray(data) || data.some(row => !object(row) || typeof row.icaoId !== 'string' ||
      typeof row.rawOb !== 'string' || !Number.isSafeInteger(row.obsTime) ||
      !Number.isFinite(new Date(Number(row.obsTime) * 1000).getTime()))) throw new Error('invalid_metar_response');
  const records = data.map((row, index) => ({ row, index, time: Number(row.obsTime) * 1000 }))
    .sort((a, b) => a.time - b.time);
  const matched = records.filter(({ row, time }) => row.icaoId === station && time >= start && time < end);
  const wrongStation = records.filter(({ row }) => row.icaoId !== station).length;
  const routine = matched.filter(({ row }) => row.metarType === 'METAR');
  const temperatures = routine.flatMap(({ row, index, time }) => {
    const remark = /\bRMK\b[^\r\n]*?\b(T([01])(\d{3})(?:[01]\d{3}|\/{4}))(?=\s|$)/.exec(row.rawOb);
    return remark ? [{ value: (remark[2] === '1' ? -1 : 1) * Number(remark[3]) / 10,
      rawRemark: remark[1], rawAt: { pointer: `/${index}/rawOb` }, obsTimeAt: { pointer: `/${index}/obsTime` },
      observationUtc: new Date(time).toISOString() }] : [];
  });
  const peak = temperatures.reduce<typeof temperatures[number] | undefined>(
    (best, item) => !best || item.value > best.value ? item : best, undefined);
  const time = (record?: typeof records[number]) => record && new Date(record.time).toISOString();
  const local = (record?: typeof records[number]) => record && clock?.format(record.time);
  return { status: wrongStation ? 'mismatch' : matched.length ? 'ok' : 'empty', content: { format: 'json', value: data },
    reason: wrongStation ? 'returned_station_mismatch' : matched.length ? undefined : 'no_observations_in_requested_window',
    scope: { station, startUtc: new Date(start).toISOString(), endUtcExclusive: new Date(end).toISOString(),
      returned: records.length, firstReturnedUtc: time(records[0]), lastReturnedUtc: time(records.at(-1)),
      inWindow: matched.length, firstInWindowUtc: time(matched[0]), lastInWindowUtc: time(matched.at(-1)),
      outsideWindow: records.length - matched.length - wrongStation, wrongStation, routineCount: routine.length,
      routineWithTemperatureRemark: temperatures.length, maxObservedRoutineRemarkC: peak, coverage: 'requires_rule_review',
      ...(clock ? { localTimes: { timeZone: clock.resolvedOptions().timeZone, windowStart: clock.format(start),
        windowEndExclusive: clock.format(end), firstInWindow: local(matched[0]), lastInWindow: local(matched.at(-1)),
        peakAt: peak && clock.format(Date.parse(peak.observationUtc)) } } : {}) } };
}

function officialRequests(query: OfficialQuery): { url: URL; inspect: (body: string) => OfficialObservation }[] {
  if (query.source === 'govinfo_bill_status') {
    const { congress, billType, billNumber } = query;
    if (!billTypes.includes(billType) || !Number.isSafeInteger(congress) || congress < 108 || congress > 200 ||
        !Number.isSafeInteger(billNumber) || billNumber < 1 || billNumber > 999999) throw new Error('无效的国会届次或法案编号。');
    const url = new URL(`${sourceSetting('PM_GOVINFO_URL')}/bulkdata/BILLSTATUS/${congress}/${billType}/BILLSTATUS-${congress}${billType}${billNumber}.xml`);
    return [{ url, inspect(body) {
      const header = body.match(/<billStatus>\s*<version>[^<]*<\/version>\s*<bill>([\s\S]*?)(?=<legislationUrl>|<relatedBills>|<actions>)/)?.[1];
      if (!header || !/<\/billStatus>\s*$/.test(body)) throw new Error('invalid_bill_status_xml');
      const match = header.includes(`<congress>${congress}</congress>`) && header.includes(`<type>${billType.toUpperCase()}</type>`)
        && header.includes(`<number>${billNumber}</number>`);
      const block = /^    <actions>\s*[\s\S]*?^    <\/actions>/m.exec(body);
      // The excerpt follows the published XML layout. The complete document remains the evidence.
      const recentActions = block ? [...block[0].matchAll(/^      <item>[\s\S]*?^      <\/item>/gm)].slice(0, 10).flatMap(item => {
        const date = /<actionDate>([^<]+)<\/actionDate>/.exec(item[0]);
        const text = /<text>([^<]+)<\/text>/.exec(item[0]);
        if (!date || !text) return [];
        const offset = block.index + item.index;
        return [{ date: date[1], text: text[1],
          dateAt: { quote: date[0], offset: offset + date.index },
          actionAt: { quote: text[0], offset: offset + text.index } }];
      }) : [];
      return { status: match ? 'ok' : 'mismatch', reason: match ? undefined : 'returned_bill_identity_mismatch',
        content: { format: 'text', value: body }, scope: { congress, billType, billNumber, billAt: { url: true }, recentActions } };
    } }];
  }
  if (query.source === 'awc_metar') {
    const { station } = query;
    const start = utcMillis(query.startUtc);
    const end = utcMillis(query.endUtc);
    const hours = Math.ceil((end - start) / 3600000);
    if (!/^[A-Z][A-Z0-9]{3}$/.test(station) || hours < 1 || hours > 71) {
      throw new Error('METAR 需要一个 4 位 ICAO 站点及不超过 71 小时的 UTC 窗口。');
    }
    const url = new URL(sourceSetting('PM_AWC_URL') + '/api/data/metar');
    // Read one extra hour for the provider's nominal report buckets, then filter by actual obsTime.
    url.search = new URLSearchParams({ ids: station, format: 'json', date: query.endUtc, hours: String(hours + 1) }).toString();
    const clock = localClock(query.timeZone);
    return [{ url, inspect: body => inspectMetar(body, station, start, end, clock) }];
  }
  const { symbol, interval, openTimesUtc } = query;
  if (!/^[A-Z0-9]{3,24}$/.test(symbol) || !candleIntervals.includes(interval) ||
      openTimesUtc.length < 1 || openTimesUtc.length > 2 || new Set(openTimesUtc).size !== openTimesUtc.length) {
    throw new Error('Binance Spot 需要有效交易对和周期，以及 1 至 2 个不同的开盘时刻。');
  }
  const clock = localClock(query.timeZone);
  return openTimesUtc.map(openUtc => {
    const start = utcMillis(openUtc);
    const url = new URL(sourceSetting('PM_BINANCE_SPOT_URL') + '/api/v3/klines');
    url.search = new URLSearchParams({ symbol, interval, startTime: String(start), limit: '1' }).toString();
    return { url, inspect(body) {
      const rows: unknown = JSON.parse(body);
      if (!Array.isArray(rows) || rows.length > 1) throw new Error('invalid_binance_klines_response');
      const scope = { symbol, interval, openUtc };
      if (!rows.length) return { status: 'empty', reason: 'no_kline_returned', content: { format: 'json', value: rows }, scope };
      const [candle] = rows;
      if (!Array.isArray(candle) || !Number.isSafeInteger(candle[0]) || !Number.isSafeInteger(candle[6]) ||
          candle[6] < candle[0] || typeof candle[4] !== 'string' || !/^\d+(?:\.\d+)?$/.test(candle[4])) {
        throw new Error('invalid_binance_kline');
      }
      const exact = candle[0] === start;
      const closed = candle[6] < Date.now();
      return { status: exact ? 'ok' : 'mismatch', reason: exact ? undefined : 'returned_kline_open_time_mismatch',
        content: { format: 'json', value: rows },
        scope: { ...scope, actualOpenUtc: new Date(candle[0]).toISOString(), closeUtc: new Date(candle[6]).toISOString(),
          ...(clock ? { localTimes: { timeZone: clock.resolvedOptions().timeZone,
            actualOpen: clock.format(candle[0]), close: clock.format(candle[6]) } } : {}),
          closed, ...(exact ? { close: candle[4], closeAt: { pointer: '/0/4' } } : {}) } };
    } };
  });
}

export function createMarketWebSearchTools({ db, loadEvidence, saveEvidence }: {
  db: DatabaseSync;
  loadEvidence: (id: string) => EvidenceRow | undefined;
  saveEvidence: (source: string, data: unknown, retrievedAt: string) => EvidenceRow;
}) {
  const endpoint = httpUrl(process.env.PM_SEARXNG_URL?.trim());
  const bingEndpoint = endpoint?.searchParams.get('engines') === 'yahoo' ? new URL(endpoint) : undefined;
  bingEndpoint?.searchParams.set('engines', 'bing');
  const paidEnabled = process.env.PM_PAID_SEARCH_ENABLED === 'true';
  const enabled = paidEnabled && process.env.PM_SERPER_ENABLED === 'true';
  const key = process.env.SERPER_API_KEY?.trim();
  const quota = Number(process.env.PM_SERPER_AUTHORIZED_CALLS ?? 0);
  const serper = new URL(sourceSetting('PM_SERPER_URL') + '/search');
  const exaEnabled = process.env.PM_EXA_ENABLED !== 'false';
  const langsearchKey = process.env.LANGSEARCH_API_KEY?.trim();
  const jinaProxy = process.env.PM_JINA_READER_PROXY?.trim();
  const tavilyEnabled = paidEnabled && process.env.PM_TAVILY_ENABLED === 'true';
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const tavilyQuota = Number(process.env.PM_TAVILY_AUTHORIZED_CALLS ?? 0);
  // A single SQLite write reserves a credit before dispatch, including concurrent hosts using this store.
  const reserve = db.prepare(`INSERT INTO evidence (id,source,retrieved_at,data) SELECT ?,?,?,?
    WHERE (SELECT count(*) FROM evidence WHERE source=?) < ?`);
  let paidUnavailable: string | undefined;
  let tavilyBalance: { until: number; remaining: number; reason?: string } | undefined;

  async function tavilyGrant(signal: AbortSignal, marketEvidenceId: string, reason: string) {
    if (!tavilyEnabled || !tavilyKey || !Number.isSafeInteger(tavilyQuota) || tavilyQuota <= 0) return { reason: 'tavily_not_authorized' };
    if (signal.aborted) return { reason: 'cancelled' };
    if (!tavilyBalance || tavilyBalance.until <= Date.now()) {
      try {
        const response = await fetch(new URL('usage', tavilyEndpoint), { redirect: 'error',
          headers: { Authorization: `Bearer ${tavilyKey}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]) });
        if (response.ok) {
          const usage = await response.json() as { account?: { plan_limit?: number; plan_usage?: number }; key?: { limit?: number | null; usage?: number } };
          const account = (usage.account?.plan_limit ?? NaN) - (usage.account?.plan_usage ?? NaN);
          const keyBalance = typeof usage.key?.limit === 'number' ? usage.key.limit - (usage.key.usage ?? NaN) : Infinity;
          tavilyBalance = { until: Date.now() + 90_000, remaining: Math.min(account, keyBalance) };
        } else {
          await response.body?.cancel();
          tavilyBalance = { until: Date.now() + 60_000, remaining: 0, reason: `tavily_usage_HTTP_${response.status}` };
        }
      } catch {
        return { reason: signal.aborted ? 'cancelled' : 'tavily_usage_unavailable' };
      }
    }
    if (signal.aborted) return { reason: 'cancelled' };
    if (!(tavilyBalance.remaining >= 1)) return { reason: tavilyBalance.reason ?? 'tavily_included_credits_unavailable' };
    const id = randomUUID();
    const reserved = reserve.run(id, tavilySource, new Date().toISOString(),
      JSON.stringify({ kind: 'tavily_request_reservation', marketEvidenceId, reason }), tavilySource, tavilyQuota);
    if (!reserved.changes) return { reason: 'tavily_quota_exhausted' };
    tavilyBalance.remaining--;
    return { key: tavilyKey, id };
  }

  const output = { schema: str, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  function marketContext(marketEvidenceId: string, ruleCardEvidenceId?: string) {
    const market = resolution(loadEvidence(marketEvidenceId));
    let card: RuleCard | undefined;
    if (ruleCardEvidenceId !== undefined) {
      const row = loadEvidence(ruleCardEvidenceId);
      if (row?.source !== 'personal-agent/research' || !object(row.data) || row.data.kind !== 'rule_card') {
        throw new Error('需要 build_rule_card 保存的规则卡证据。');
      }
      card = row.data as RuleCard;
      const raw = resolution(loadEvidence(card.rules.evidenceId));
      if (!sameMarket(market, raw) || !sameMarket(raw, card.market)) throw new Error('市场解析与规则卡属于不同市场。');
      if ((raw.rules ?? '') !== card.rules.capturedText || (market.rules ?? '') !== card.rules.capturedText) {
        throw new Error('市场解析与规则卡的规则原文版本不一致。');
      }
      if (card.inputEvidenceIds.some(id => !loadEvidence(id))) throw new Error('规则卡有缺失的原文或澄清证据。');
    }
    return { market, card, inputEvidenceIds: [...new Set([
      marketEvidenceId, ...(card ? [ruleCardEvidenceId!, ...card.inputEvidenceIds] : []),
    ])] };
  }

  const officialTool = defineTool({
    name: 'read_official_market_data',
    description: '按法案编号、ICAO 站点与 UTC 窗口、或 Binance 现货 K 线直查官方数据。规则指定 Chainlink 60 秒 TWAP 的五分钟 BTC 盘用 polymarket_chainlink_twap_replay，直接读取该市场公开页面的起止原始价格，不读取 Oracle。其他数据可传同市场 searchEvidenceId，或同时运行通用搜索。当地时间用 IANA timeZone。',
    parameters: { marketEvidenceId: required, ruleCardEvidenceId: str, searchEvidenceId: str, query: officialParameters },
    output,
    async execute({ marketEvidenceId, ruleCardEvidenceId, searchEvidenceId, query }, exec) {
      const { signal } = exec;
      signal.throwIfAborted();
      const { market, inputEvidenceIds } = marketContext(marketEvidenceId, ruleCardEvidenceId);
      if (query.source === 'polymarket_chainlink_twap_replay') {
        const saved = await capturePolymarketPriceWindow(db, loadEvidence(marketEvidenceId)!, signal);
        if (!saved) throw Error('该盘口未结束，或规则未规定该 Chainlink BTC/USD 60 秒 TWAP 窗口。');
        signal.throwIfAborted();
        const { data: _data, ...record } = saved;
        return JSON.stringify({ marketEvidenceId, localMarketId: market.localMarketId, records: [record],
          counts: { searchAttempts: 0, readAttempts: 1, paidAttempts: 0 } });
      }
      const requests = officialRequests(query);
      let discovered: ReturnType<typeof searchCapture> | undefined;
      let searchId = searchEvidenceId;
      if (searchId !== undefined) {
        const saved = searchCapture(loadEvidence(searchId));
        if (!saved.market) throw new Error('官方市场直查需要同一市场的搜索证据。');
        const { market: previous } = marketContext(saved.market.marketEvidenceId, ruleCardEvidenceId);
        if (!sameMarket(market, previous) || (market.rules ?? '') !== (previous.rules ?? '')) {
          throw new Error('官方直查与搜索回执必须属于同一市场和规则版本。');
        }
      } else {
        const receipt = await searchTool.execute({
          marketEvidenceId, ...(ruleCardEvidenceId === undefined ? {} : { ruleCardEvidenceId }),
          purpose: '为同市场的官方直查查找其他公开原文',
          queries: [{ keywords: officialSearchKeywords(query) }],
        }, exec);
        const row: EvidenceRow = JSON.parse(receipt as string);
        discovered = searchCapture(row);
        searchId = row.evidenceId;
      }
      const officialInputIds = [...inputEvidenceIds, searchId];
      const records = await Promise.all(requests.map(async ({ url, inspect }) => {
        const started = Date.now();
        let observation: OfficialObservation | undefined;
        let httpStatus: number | undefined;
        let reason: string | undefined;
        let stage: 'access' | 'parse' = 'access';
        try {
          const { stdout } = await runFile('/usr/bin/curl', [
            '--disable', '--silent', '--show-error', '--noproxy', '*', '--max-time', '12',
            '--max-filesize', '2097152', '--write-out', '\n%{http_code}', url.href,
          ], { signal, maxBuffer: 2_100_000 });
          const split = stdout.lastIndexOf('\n');
          httpStatus = Number(stdout.slice(split + 1));
          if (httpStatus === 200 || httpStatus === 204 && query.source === 'awc_metar') {
            stage = 'parse';
            observation = inspect(stdout.slice(0, split));
            reason = observation.reason;
          } else {
            reason = `HTTP_${httpStatus}`;
          }
        } catch (error) {
          const code = object(error) ? error.code : undefined;
          reason = signal.aborted ? 'cancelled' : code === 28 ? 'timeout' :
            code === 63 || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'body_too_large' :
            stage === 'parse' ? error instanceof SyntaxError ? 'invalid_json' : clean((error as Error).message, 100)
            : typeof code === 'number' ? `curl_exit_${code}` : 'network_error';
        }
        const status = observation?.status ?? (signal.aborted ? 'cancelled' : 'failed');
        const usable = observation?.status === 'ok';
        const { evidenceId, source, retrievedAt } = saveEvidence(url.href, { kind: 'source_capture',
          coverage: usable ? 'body' : 'link', recordKey: url.href, inputEvidenceIds: officialInputIds,
          captureProvider: query.source, marketEvidenceId, ruleCardEvidenceId,
          httpStatus, status, query, scope: observation?.scope,
          ...(observation ? { content: observation.content } : {}),
          ...(!usable ? { failure: { stage, reason } } : {}) }, new Date().toISOString());
        return { evidenceId, source, retrievedAt, status, httpStatus, elapsedMs: Date.now() - started,
          reason, scope: observation?.scope };
      }));
      const pair = query.source === 'binance_spot_klines' ? records.flatMap(({ status, scope, evidenceId }) =>
        status === 'ok' && scope?.closed === true && typeof scope.openUtc === 'string' && typeof scope.close === 'string'
          ? [{ openUtc: scope.openUtc, close: scope.close, evidenceId }] : []) : [];
      const [earlier, later] = pair.sort((a, b) => a.openUtc.localeCompare(b.openUtc));
      const comparison = pair.length === 2 ? { earlier, later, laterVsEarlier: compareCloses(earlier.close, later.close) } : undefined;
      const search = discovered && { status: discovered.status, candidates: discovered.candidates, ruleLinks: discovered.ruleLinks,
        queries: compactSearchReports(discovered.queries) };
      return JSON.stringify({ marketEvidenceId, localMarketId: market.localMarketId, ruleCardEvidenceId, searchEvidenceId: searchId,
        clauseMatch: 'unknown', records, comparison, search, counts: { searchAttempts: discovered?.counts.searchAttempts ?? 0,
          readAttempts: requests.length, paidAttempts: discovered?.counts.paidAttempts ?? 0,
          tavilyCredits: discovered?.counts.tavilyCredits ?? 0 } });
    },
  });

  const publisherTool = defineTool({
    name: 'list_news_publishers',
    description: '列出真实世界搜索已登记的新闻发布方、publisherIds、原文域名及发现入口。用 match 查媒体名称或域名，用 group 按新闻类别筛选。',
    parameters: { match: str,
      group: { ...str, enum: ['world', 'finance', 'asia', 'crypto', 'tech-sports', 'official'] as const } },
    output,
    async execute({ match, group }) {
      const term = match?.trim().toLowerCase();
      const publishers = newsPublishers.filter(p => (!group || group === p.group) &&
        (!term || p.name.toLowerCase().includes(term) || p.domains.some(host => host.includes(term))));
      return JSON.stringify({ total: newsPublishers.length, matched: publishers.length, publishers });
    },
  });
  const primaryReadCache = new Map<string, Record<string, unknown>>();
  const searchTool = defineTool({
    name: 'search_market_sources',
    description: '结合发布方索引和公网检索找原文。涉及已确认盘口时传 marketEvidenceId；纯事实可省略。可传 entities，按人名、机构、球队或地区分组，每组至少命中一个完整别名。指定金十或方程式新闻时，用 publisherIds 或 sourceDomains 中的 jin10.com 或 eqn.news，把不同主题分开查。今日新闻传北京时间 newsSince。先用 records 里已读正文的详情页。',
    parameters: {
      marketEvidenceId: str, ruleCardEvidenceId: str, purpose: required, newsSince: str,
      publisherIds: { type: 'array', items: str },
      queries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
        properties: { keywords: required, clauseIds: { type: 'array', items: str }, sourceDomains: { type: 'array', items: str },
          entities: { type: 'array', items: { type: 'array', items: str } } } } },
    },
    output: { schema: str, render: (_args, value) => {
      const receipt = JSON.parse(value);
      const batch = receipt.data.content.value;
      batch.queries = compactSearchReports(batch.queries);
      return [{ type: 'text' as const, text: JSON.stringify(receipt) }];
    } },
    async execute({ marketEvidenceId, ruleCardEvidenceId, purpose, queries, newsSince, publisherIds }, execution): Promise<string> {
      const { signal } = execution;
      signal.throwIfAborted();
      const started = Date.now();
      if (ruleCardEvidenceId && !marketEvidenceId) throw new Error('按条款搜索需要指定市场证据。');
      const scope = marketEvidenceId ? marketContext(marketEvidenceId, ruleCardEvidenceId) : undefined;
      const market = scope?.market;
      const card = scope?.card;
      if (!purpose.trim() || purpose.length > 600 || queries.length < 1 || queries.length > maxQueries) {
        throw new Error('需要简短搜索目的和 1 至 3 条查询计划。');
      }
      if (newsSince !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(newsSince) ||
        !Number.isFinite(Date.parse(newsSince + 'T00:00:00+08:00')) ||
        Date.parse(newsSince + 'T00:00:00+08:00') > Date.now())) throw new Error('newsSince 需要有效的北京时间日期。');
      const ids = [...new Set(publisherIds ?? [])];
      const requested = newsPublishers.filter(publisher => ids.includes(publisher.id));
      if (requested.length !== ids.length || requested.length > 3) throw new Error('publisherIds 最多指定 3 家已登记发布方，请用 list_news_publishers 查询 ID。');
      const teams = fixtureEntities(market);
      const plan = queries.map(({ keywords, clauseIds = [], sourceDomains = [], entities = [] }) => {
        if (clauseIds.length > 8 || clauseIds.some(id => !card?.clauses.some(clause => clause.id === id))) {
          throw new Error('查询仅可引用当前规则卡上的条款，每条最多 8 个。');
        }
        if (sourceDomains.length > 3 || sourceDomains.some(domain => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i.test(domain))) {
          throw new Error('sourceDomains 最多 3 个公开域名，不含 URL 或路径。');
        }
        const domains = domainsFor(keywords, sourceDomains);
        if (requested.length && domains.some(host => !requested.some(publisher => publisherInScope(publisher, [host])))) {
          throw new Error('publisherIds 与查询里的域名范围冲突。');
        }
        if (entities.length > 3 || entities.some(group => !group.length || group.length > 5 ||
          group.some(alias => alias.length > 70 || !/^[\p{L}\p{M}\p{N} &.'’()-]+$/u.test(alias.trim())))) {
          throw new Error('entities 最多 3 组，每组 1 至 5 个公开名称，每项最多 70 字。可省略 entities，保留简短的公开主题关键词。');
        }
        // Headlines mentioning only a common month or "inflation" are poor matches for a named price series.
        const series = /(?:\bPCE\b|个人消费支出物价)/i.test(keywords) ?
          [['PCE', 'personal consumption expenditures', 'personal income and outlays', '个人消费支出', '個人消費支出']] : [];
        return { keywords: publicKeywords(keywords), clauseIds: [...new Set(clauseIds)],
          sourceDomains: domains.length || !requested.length ? domains : requested.map(publisher => publisher.id), newsSince,
          entities: teams.length && !requested.length ? teams : entities.length ? entities : series };
      });
      if (new Set(plan.map(q => q.keywords.toLowerCase())).size !== plan.length) throw new Error('查询关键词不能重复。');

      const targetedIndex = Math.max(0, plan.findIndex(query => query.sourceDomains.length));
      const reports: QueryReport[] = [];
      const primary = requested.length ? { listing: [], archive: [] } : primaryPlans(market);
      const publisherPlan = [...primary.listing.map(query => query.document === 'election_reporting'
        ? { ...query, newsSince } : query), ...plan];
      const publishers = (requested.length ? requested : newsPublishers)
        .filter(publisher => publisherPlan.some(query => publisherInScope(publisher, query.sourceDomains)));
      const indexSearch = searchPublisherIndexes(publishers, publisherPlan, signal);
      const filingQuery = primary.archive.find(query => query.sourceDomains[0] === 'sec.gov');
      const filingSearch = filingQuery && issuerFilings(filingQuery, signal);
      const cnbcSearch = filingQuery?.document === 'regulatory_filing'
        ? filingSearch?.then(attempt => attempt.results[0] ? cnbcFilingCoverage(attempt.results[0], signal) : []) : undefined;
      const archiveSearch = Promise.all(primary.archive.map(async query => {
        const native = query.document === 'earnings_coverage' ? await cnbcSearch ?? [] : [];
        const attempts = query === filingQuery ? [await filingSearch!] :
          native.some(attempt => attempt.status === 'ok') ? native : [...native, ...await Promise.all([
          search('searxng', endpoint, query, signal),
          ...(exaEnabled ? [search('exa', exaEndpoint, query, signal)] : []),
          ...(langsearchKey ? [search('langsearch', langsearchEndpoint, query, signal, langsearchKey)] : []),
        ])];
        for (const attempt of attempts) {
          const year = query.keywords.match(/\b20\d{2}\b/)?.[0];
          attempt.results = attempt.results.filter(hit => hostMatches(hit.domain, query.sourceDomains) &&
            (hit.document === query.document || query === filingQuery && hit.document === 'leadership_prior_filing' ||
              /\bAmazon\b.*\b(?:earnings|results)\b/i.test(hit.title) &&
              !!year && new RegExp('(?:^|\\D)' + year + '(?:\\D|$)').test(candidateWords(hit))))
            .map(hit => ({ ...hit, document: hit.document === 'leadership_prior_filing' ? hit.document : query.document }));
          if (!attempt.results.length && attempt.status === 'ok') {
            attempt.status = 'empty';
            attempt.reason = 'no_primary_document';
          }
        }
        return { ...query, clauseIds: [], attempts };
      }));
      for (const query of plan) {
        const attempts = await Promise.all([
          search('searxng', endpoint, query, signal),
          ...(bingEndpoint ? [search('searxng', bingEndpoint, query, signal)] : []),
          ...(exaEnabled ? [search('exa', exaEndpoint, query, signal)] : []),
          ...(langsearchKey ? [search('langsearch', langsearchEndpoint, query, signal, langsearchKey)] : []),
        ]);
        if (requested.length || query.entities.length) {
          for (const attempt of attempts) {
            attempt.results = attempt.results.filter(hit =>
              (!requested.length || requested.some(publisher => hostMatches(hit.domain, publisher.domains))) &&
              (!query.entities.length || matchesNewsEntities(candidateWords(hit), query.entities)));
            if (!attempt.results.length && attempt.status === 'ok') {
              attempt.status = 'empty';
              attempt.reason = 'no_returned_hit_in_scope';
            }
          }
        }
        reports.push({ ...query, attempts });
      }
      const targeted = reports[targetedIndex];
      const nbaDay = /^nba-[a-z]{2,4}-[a-z]{2,4}-(\d{4}-\d{2}-\d{2})$/.exec(String(market?.slug))?.[1];
      const scoreQuery = reports.find(q => (!q.sourceDomains.length || hostMatches('site.api.espn.com', q.sourceDomains)) &&
        /box[ -]?score|minutes played|live score|technical stat|技术统计|实际登场/i.test(q.keywords + ' ' + purpose));
      const fixtureQuery = scoreQuery ?? reports.find(q => !q.sourceDomains.length);
      if (nbaDay && teams.length === 2 && fixtureQuery && !requested.length) {
        fixtureQuery.attempts.push(await nbaBoxScoreIndex(nbaDay, teams.map(group => group[0]), signal));
      }
      const publisherAttempts = await indexSearch;
      for (const attempt of publisherAttempts) {
        const publisher = publishers.find(item => item.id === attempt.publisherId)!;
        const report = reports.find(query => publisherInScope(publisher, query.sourceDomains));
        (report ?? targeted).attempts.push(attempt);
      }
      const tavily = requested.length ? { reason: 'publisher_scope' } :
        marketEvidenceId ? await tavilyGrant(signal, marketEvidenceId, 'search') : { reason: 'public_fact' };
      if (tavily.key) {
        targeted.attempts.push(await search('tavily', new URL('search', tavilyEndpoint), targeted, signal, tavily.key));
      }
      const scopedMiss = targeted.sourceDomains.length > 0 && !reports.some(report => report.attempts.some(attempt =>
        attempt.results.some(hit => hostMatches(hit.domain, targeted.sourceDomains))));
      let usedFallback = false;
      for (const report of reports) {
        const primary = report.attempts[0];
        const missedScope = report === targeted && scopedMiss;
        if (!missedScope && (report.attempts.some(attempt => attempt.status === 'ok') ||
          targeted.attempts.some(attempt => attempt.status === 'ok'))) continue;
        const reason = missedScope ? 'no_result_on_requested_domains' : primary.reason ?? primary.status;
        const decision = signal.aborted ? 'cancelled' : requested.length ? 'publisher_scope' :
          !marketEvidenceId ? 'public_fact' : !enabled ? 'disabled' : !key ? 'credential_missing'
          : paidUnavailable ?? (!Number.isSafeInteger(quota) || quota <= 0 ? 'quota_unavailable' : usedFallback ? 'batch_limit' : undefined);
        if (decision) { report.fallback = { reason, decision }; continue; }
        const reservationId = randomUUID();
        const credit = reserve.run(reservationId, paidSource, new Date().toISOString(),
          JSON.stringify({ kind: 'serper_search_reservation', marketEvidenceId, reason }), paidSource, quota);
        if (!credit.changes) { report.fallback = { reason, decision: 'quota_exhausted' }; continue; }
        usedFallback = true;
        report.fallback = { reason, decision: 'called', reservationId };
        const fallback = await search('serper', serper, report, signal, key);
        report.attempts.push(fallback);
        if (['HTTP_401', 'HTTP_402', 'HTTP_403', 'HTTP_429'].includes(fallback.reason ?? '')) paidUnavailable = fallback.reason;
      }

      reports.push(...await archiveSearch);
      const openQuery = plan.find(q => !q.sourceDomains.length);
      const registeredPressHit = reports.some(q => q.attempts.some(a => a.results.some(hit => {
        const publisher = registeredNewsOutlet(hit);
        return publisher && publisher.group !== 'official';
      })));
      const publicHit = reports.some(q => q.attempts.some(a => ['searxng', 'langsearch', 'exa', 'serper', 'tavily'].includes(a.engine) && a.results.length));
      const seed = !publicHit && publisherAttempts.flatMap(a => a.results).find(hit =>
        hit.title.trim().length >= 12 && hit.title.length <= 160 && !/[\p{C}@!:：=]|https?\/\/|\b0x[\da-f]+/iu.test(hit.title));
      if (openQuery && !requested.length && (!registeredPressHit || seed) && !signal.aborted) {
        const topic = [market?.category, market?.title, purpose, openQuery.keywords].join(' ');
        const outlets = /sports|nba|football|tennis|比赛|球队|赛况/i.test(topic) ? ['espn.com', 'si.com'] :
          /crypto|bitcoin|ethereum|加密|比特币/i.test(topic) ? ['cointelegraph.com', 'eqn.news'] :
          /GDP|FOMC|CPI|PCE|inflation|econom|宏观|经济|通胀/i.test(topic) ? ['cnbc.com', 'jin10.com'] :
          /台北|台灣|台湾|taipei|taiwan/i.test(topic) ? ['cna.com.tw', 'pts.org.tw'] : ['bbc.com', 'theguardian.com'];
        const fixtureDay = /^nba-[a-z]+-[a-z]+-(\d{4}-\d{2}-\d{2})$/.exec(String(market?.slug))?.[1];
        const keywords = fixtureDay && !openQuery.keywords.includes(fixtureDay) ? openQuery.keywords + ' ' + fixtureDay : openQuery.keywords;
        // A matched public headline gives the web engines another way to identify the event.
        const query = seed ? { keywords: seed.title, clauseIds: [], sourceDomains: [], entities: openQuery.entities, newsSince } :
          { ...openQuery, keywords, sourceDomains: outlets };
        const scoped = await Promise.all([search('searxng', endpoint, query, signal),
          ...(langsearchKey ? [search('langsearch', langsearchEndpoint, query, signal, langsearchKey)] : [])]);
        for (const attempt of scoped) {
          attempt.results = attempt.results.filter(hit => matchesNewsEntities(candidateWords(hit), query.entities));
          if (attempt.status === 'ok' && !attempt.results.length) { attempt.status = 'empty'; attempt.reason = 'no_returned_hit_in_scope'; }
        }
        reports.push({ ...query, attempts: scoped, fallback: seed ? { reason: 'no_public_web_hit', decision: 'search_publisher_headline' } :
          { reason: 'no_registered_news_article', decision: 'free_site_search' } });
      }
      const attempts = reports.flatMap(report => report.attempts);
      if (teams.length && !attempts.some(attempt => attempt.results.some(hit => hit.document === 'fixture_report'))) {
        const independent = attempts.flatMap(attempt => attempt.results).find(hit =>
          hostMatches(hit.domain, mexicanSportsPress) && matchesNewsEntities(candidateWords(hit), teams) &&
          /\b(?:horario|horarios|partido de ida|cuartos)\b/i.test(candidateWords(hit)));
        if (independent) independent.document = 'fixture_report';
      }
      if (primary.archive.some(query => query.document === 'earnings_coverage')) {
        const period = attempts.flatMap(attempt => attempt.results).find(hit => hit.document === 'regulatory_filing')?.title
          .match(/\b(20\d{2})-(\d{2})-\d{2}\b/);
        if (period) {
          const ordinal = ['first', 'second', 'third', 'fourth'];
          const quarter = Math.ceil(Number(period[2]) / 3);
          const inPeriod = new RegExp('(?:^|\\W)Q' + quarter + '(?:\\W|$)|\\b' + ordinal[quarter - 1] + '[ -]quarter\\b', 'i');
          const hit = attempts.flatMap(attempt => attempt.results).find(hit => hostMatches(hit.domain, earningsPress) &&
            /\bAmazon\b/i.test(hit.title) && candidateWords(hit).includes(period[1]) && inPeriod.test(candidateWords(hit)));
          if (hit) hit.document = 'earnings_coverage';
        }
      }
      if (primary.archive.some(query => query.document === 'leadership_filing')) {
        const candidates = attempts.flatMap(attempt => attempt.results).filter(hit => hostMatches(hit.domain, leadershipPress) &&
          matchesNewsEntities(candidateWords(hit), [['Jensen Huang', 'Jen-Hsun Huang'], ['Nvidia'], ['CEO', 'chief executive']]) &&
          /\b(?:reinstat\w+|return\w+|rehir\w+|appoint\w+)\b/i.test(candidateWords(hit)));
        for (const host of leadershipPress) {
          const hits = candidates.filter(hit => hostMatches(hit.domain, [host]));
          const hit = hits.find(item => item.publishedAt && /\b(?:board|scrutiny|investigation|hearing|congress|backlash)\b/i.test(item.title)) ?? hits[0];
          if (hit) hit.document = 'leadership_reporting';
        }
      }
      const officialRecords = requested.length ? [] : officialMarketRecords(market, [purpose, ...queries.map(q => q.keywords)].join(' '),
        attempts.flatMap(a => a.results)).filter(hit => market || plan.some(q => !q.sourceDomains.length || hostMatches(hit.domain, q.sourceDomains)));
      const primaryCandidates = [...officialRecords, ...officialReadPriority.flatMap(document => {
        const hits = attempts.flatMap(attempt => attempt.results).filter(hit => hit.document === document);
        if (document === 'election_reporting') return hits.filter(hit => !/新北市長|新北市選戰/.test(hit.title))
          .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, 2);
        if (document === 'earnings_coverage') hits.sort((a, b) => Number(!!b.publicationDay) - Number(!!a.publicationDay));
        if (document === 'leadership_release' || document === 'leadership_oversight' || document === 'fed_statement' || document === 'fed_speech') {
          hits.sort((a, b) => (b.publicationDay ?? b.publishedAt ?? '').localeCompare(a.publicationDay ?? a.publishedAt ?? ''));
        }
        if (document === 'leadership_reporting') {
          const byPublisher = new Map<string, Hit>();
          for (const hit of hits) {
            const publisher = leadershipPress.find(host => hostMatches(hit.domain, [host])) ?? hit.domain;
            if (!byPublisher.has(publisher)) byPublisher.set(publisher, hit);
          }
          return [...byPublisher.values()].sort((a, b) => Number(hostMatches(b.domain, ['axios.com'])) -
            Number(hostMatches(a.domain, ['axios.com']))).slice(0, 3);
        }
        return hits.length ? [hits[0]] : [];
      })];
      if (nbaDay && !requested.length) {
        const pair = String(market?.slug).split('-').slice(1, 3).join('-vs-');
        const game = attempts.flatMap(a => a.results).find(hit => {
          const url = httpUrl(hit.url);
          return url?.hostname === 'www.nba.com' && new RegExp('^/game/' + pair + '-\\d{10}/?$').test(url.pathname);
        });
        if (game) primaryCandidates.push({ ...game, document: 'nba_game_story' });
      }
      const publisherCandidates = attempts.flatMap(attempt => attempt.publisher && attempt.results[0] ?
        [{ publisher: attempt.publisher, publisherId: attempt.publisherId, ...attempt.results[0] }] : [])
        .sort((a, b) => (b.feedScore ?? 0) - (a.feedScore ?? 0) ||
          (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, 8);
      const publisherCoverage = {
        registered: newsPublishers.length, selected: publisherAttempts.length,
        indexed: publisherAttempts.filter(item => item.status === 'ok' || item.status === 'empty').length,
        matched: publisherAttempts.filter(item => item.status === 'ok').length,
        fetched: publisherAttempts.filter(item => item.attempted).length,
        cached: publisherAttempts.filter(item => item.cached).length,
        deferred: publisherAttempts.filter(item => item.status === 'unavailable').length,
        failed: publisherAttempts.filter(item => item.status === 'failed').length,
      };
      const newsReadPlan = roundupArticles(reports, primaryCandidates, purpose);
      const found = attempts.some(attempt => attempt.results.length > 0);
      const degraded = attempts.some(attempt => !['ok', 'empty'].includes(attempt.status) || attempt.engineErrors.length ||
        attempt.pageAttempts?.some(page => page.status === 'failed'));
      const status = signal.aborted ? 'cancelled' : found ? degraded ? 'partial' : 'ok' : degraded ? 'failed' : 'empty';
      const value = { status, purpose, newsSince, market: market && { localMarketId: market.localMarketId, slug: market.slug, title: market.title,
        marketEvidenceId, ...(card ? { rulesEvidenceId: card.rules.evidenceId, rulesContentId: card.rules.contentId, ruleCardEvidenceId } : {}) },
        ruleScope: !card || !card.rules.capturedText.trim() ? 'unknown' : card.rules.incomplete ? 'incomplete' : 'available',
        clauseMatch: 'unknown', candidates: rankCandidates(reports), publisherCandidates, publisherCoverage, primaryCandidates, newsReadPlan,
        ruleLinks: market ? ruleReferences(market.rules) : [],
        tavily: tavily.key ? { reservationId: tavily.id } : { reason: tavily.reason },
        queries: reports, elapsedMs: Date.now() - started,
        counts: { searchAttempts: attempts.reduce((count, a) => count + Number(a.attempted) + (a.pageAttempts?.length ?? 0), 0),
          paidAttempts: attempts.filter(a => a.attempted && ['serper', 'tavily'].includes(a.engine)).length,
          tavilyCredits: attempts.reduce((sum, attempt) => sum + (attempt.credits ?? 0), 0) } };
      const receipt = saveEvidence(searchSource, { kind: 'source_capture', coverage: 'summary',
        recordKey: market ? `local:${market.localMarketId}` : undefined, truncated: attempts.some(a => a.truncated),
        inputEvidenceIds: scope?.inputEvidenceIds ?? [],
        content: { format: 'json', value } }, new Date().toISOString());
      const records = await Promise.all([...primaryCandidates, ...newsReadPlan].map(async hit => {
        if (signal.aborted) return;
        const key = marketEvidenceId + ':' + candidateKey(hit.url);
        const cacheable = 'document' in hit && !!hit.document && hit.document !== 'nba_box_score';
        const cached = cacheable && primaryReadCache.get(key);
        if (cached) return { ...cached, reused: true };
        const result = JSON.parse(String(await readTool.execute({
          searchEvidenceId: receipt.evidenceId, url: hit.url,
        }, execution))) as Record<string, unknown>;
        const { preview: _preview, ...savedRead } = result;
        if (cacheable && (savedRead.coverage === 'document' || savedRead.coverage === 'body') && !savedRead.truncated) {
          if (primaryReadCache.size >= 64) primaryReadCache.delete(primaryReadCache.keys().next().value!);
          primaryReadCache.set(key, savedRead);
        }
        return savedRead;
      }));
      if (filingQuery?.document === 'leadership_filing' && !signal.aborted) {
        const report = records.find(record => record?.captureProvider === 'publisher-rss');
        const copyId = typeof report?.evidenceId === 'string' ? report.evidenceId : undefined;
        const snapshot = copyId && loadEvidence(copyId);
        const body = snapshot && sourceSnapshotFromEvidence(snapshot).content?.value;
        const interview = typeof body === 'string' &&
          /\]\((https:\/\/www\.cnbc\.com\/[^\s)]+interview-transcript\.html)\)/i.exec(body)?.[1];
        if (interview && copyId && !primaryCandidates.some(hit => candidateKey(hit.url) === candidateKey(interview))) {
          const result = JSON.parse(String(await readTool.execute({
            searchEvidenceId: receipt.evidenceId, linkEvidenceId: copyId, url: interview,
          }, execution))) as Record<string, unknown>;
          const { preview: _preview, ...savedRead } = result;
          records.push(savedRead);
        }
      }
      return JSON.stringify(records.length ? { ...receipt, records: records.filter(Boolean) } : receipt);
    },
  });

  const readTool = defineTool({
    name: 'read_market_source_copy',
    description: '读取本轮候选、规则链接，或通过 linkEvidenceId 证明的正文链接。官方 PDF 直接使用此工具提取正文；网页受限或截断时也可补读。目录页若需保留链接，设 preserveLinks=true。',
    parameters: { searchEvidenceId: required, url: required, linkEvidenceId: str, preserveLinks: { type: 'boolean' } },
    output,
    async execute({ searchEvidenceId, url, linkEvidenceId, preserveLinks = false }, { signal }): Promise<string> {
      const saved = searchCapture(loadEvidence(searchEvidenceId));
      const requested = httpUrl(url);
      const urls = [...(saved.ruleLinks ?? []), ...(saved.primaryCandidates ?? []).map(hit => hit.url),
        ...saved.queries.flatMap(r => r.attempts.flatMap(a => a.results.map(r => r.url)))];
      const linkProof = linkEvidenceId && loadEvidence(linkEvidenceId);
      if (!requested || (!urls.some(u => candidateKey(u) === candidateKey(requested.href)) &&
          !(linkProof && savedLinkMatches(linkProof, urls, requested)))) {
        throw new Error('需要该搜索或规则回执中的公开 URL，或已读候选正文中的实际链接。');
      }
      const tag = saved.primaryCandidates?.find(hit => candidateKey(hit.url) === candidateKey(requested.href));
      const indexHit = tag ?? saved.queries.flatMap(q => q.attempts.flatMap(a => a.results)).find(hit =>
        candidateKey(hit.url) === candidateKey(requested.href) && (hit.upstreamUrl || hit.upstreamPublisher));
      const linkedInterview = linkProof && requested.hostname === 'www.cnbc.com' &&
        /interview-transcript\.html$/i.test(requested.pathname) &&
        saved.primaryCandidates?.some(hit => hit.document === 'leadership_filing');
      const flash = publisherFlash(requested);
      const publisherFeed = requested.protocol === 'https:' && !requested.port && hostMatches(requested.hostname, ['axios.com']);
      const registeredArticle = requested.protocol === 'https:' && !requested.port && newsPublishers.some(p =>
        p.group !== 'official' && matchesPublisherDomain(requested.hostname, p.domains)) && requested.pathname !== '/';
      const directHtml = requested.protocol === 'https:' && !requested.port &&
        (requested.hostname === 'www.nba.com' && /^\/game\/[a-z]+-vs-[a-z]+-\d{10}\/?$/i.test(requested.pathname) ||
          hostMatches(requested.hostname, ['federalreserve.gov', 'newyorkfed.org', 'bea.gov', 'cec.gov.tw', 'data.ornn.com',
          'anthropic.com', 'leanprover-community.github.io', 'blast.tv', 'pglesports.com', 'pts.org.tw']) ||
          (tag || linkProof) && hostMatches(requested.hostname, ['rayados.com', 'stat.go.jp', 'aboutamazon.com', 'sec.gov',
            'nvidianews.nvidia.com', ...mexicanSportsPress, ...earningsPress, ...leadershipPress]));
      const attempts: { engine: 'espn-boxscore' | 'espn-recap' | 'official-pdf' | 'publisher-html' | 'publisher-rss' | 'jin10-flash' | 'equation-news' | 'exa' | 'jina' | 'tavily';
        status: string; reason?: string; credits?: number; reservationId?: string }[] = [];
      async function read(engine: typeof attempts[number]['engine'], secret?: string, reservationId?: string) {
        const attempt: typeof attempts[number] = { engine, status: 'failed' };
        attempts.push(attempt);
        attempt.reservationId = reservationId;
        try {
          if (engine === 'espn-boxscore' || engine === 'espn-recap') {
            const captured = await readNbaBoxScore(requested!, signal, engine === 'espn-recap');
            attempt.status = 'ok';
            return { engine, ...captured };
          }
          if (engine === 'jin10-flash' || engine === 'equation-news') {
            const captured = await readPublisherFlash(requested!, engine, indexHit, signal);
            attempt.status = captured.truncated ? 'partial' : 'ok';
            return { engine, ...captured };
          }
          if (engine === 'publisher-rss') {
            const article = await readPublisherFeedArticle(requested!, signal);
            attempt.status = article.truncated ? 'partial' : 'ok';
            return { engine, ...article };
          }
          if (engine === 'official-pdf' || engine === 'publisher-html') {
            const captured = await (engine === 'official-pdf' ? readOfficialPdf(requested!, signal)
              : readOfficialHtml(requested!, signal, preserveLinks || tag?.document === 'research_verification', registeredArticle && !directHtml,
                /^nba-[a-z]+-[a-z]+-(\d{4}-\d{2}-\d{2})$/.exec(String(saved.market?.slug))?.[1]));
            attempt.status = captured.truncated ? 'partial' : 'ok';
            return { engine, ...captured };
          }
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(18_000)]);
          let content: string | undefined;
          if (engine === 'jina') {
            const result = await readJina(jinaProxy!, requested!, preserveLinks, deadline);
            content = result.content;
            attempt.reason = result.reason;
          } else {
            const response = await fetch(engine === 'exa' ? exaEndpoint : new URL('extract', tavilyEndpoint), {
              method: 'POST', redirect: 'error', signal: deadline,
              headers: { 'Content-Type': 'application/json', Accept: engine === 'exa' ? 'application/json, text/event-stream' : 'application/json',
                ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
              body: JSON.stringify(engine === 'exa'
                ? mcpRequest('web_fetch_exa', { urls: [requested!.href], maxCharacters: exaBodyLimit })
                : { urls: [requested!.href], extract_depth: 'basic', format: preserveLinks ? 'markdown' : 'text', include_usage: true }),
            });
            if (!response.ok) { await response.body?.cancel(); attempt.reason = `HTTP_${response.status}`; return; }
            const payload = await responsePayload(response);
            if (engine === 'exa') {
              const text = exaText(payload);
              const header = text?.match(/^#[^\n]+\nURL:\s*(https?:\/\/\S+)\s*\n/);
              if (header && candidateKey(header[1]) === candidateKey(requested!.href)) {
                content = text!.slice(header[0].length).trim();
                if (content.replace(/^#+\s*/, '') === header[0].split('\n', 1)[0].replace(/^#+\s*/, '').trim()) {
                  attempt.reason = 'title_only';
                  return;
                }
              }
            } else if (object(payload)) {
              if (object(payload.usage) && typeof payload.usage.credits === 'number') attempt.credits = payload.usage.credits;
              const item = Array.isArray(payload.results) ? payload.results.find(r => object(r) && httpUrl(r.url)
                && candidateKey(String(r.url)) === candidateKey(requested!.href)) : undefined;
              if (typeof item?.raw_content === 'string') content = item.raw_content.trim();
              if (!content && Array.isArray(payload.failed_results)) {
                const failed = payload.failed_results.find(r => object(r) && r.url === requested!.href);
                const reason = clean(failed?.error, 200);
                attempt.reason = (secret ? reason.replaceAll(secret, '[redacted]') : reason) || undefined;
              }
            }
          }
          if (!content || content.length < 30) { attempt.reason ??= 'body_missing_or_wrong_url'; return; }
          if (isPublisherIndex(content) && !preserveLinks) { attempt.reason = 'html_index_only'; return; }
          const truncated = content.length >= (engine === 'exa' ? exaBodyLimit - 80 : storedBodyLimit);
          attempt.status = truncated ? 'partial' : 'ok';
          return { engine, body: content.slice(0, storedBodyLimit), truncated };
        } catch (error) {
          const code = object(error) ? object(error.cause) ? error.cause.code : error.code : undefined;
          attempt.reason = signal.aborted ? 'cancelled' : error instanceof Error && /^(?:HTTP_\d{3}|(?:document|pdf|html|redirect)_[a-z_]+)$/.test(error.message)
            ? error.message : code === 28 || error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout' : typeof code === 'number' ? `curl_exit_${code}` : typeof code === 'string' ? code : 'read_failed';
        }
      }
      signal.throwIfAborted();
      let body: Awaited<ReturnType<typeof read>>;
      const readers: typeof attempts[number]['engine'][] = tag?.document === 'nba_box_score' ? ['espn-boxscore'] :
        tag?.document === 'nba_recap' ? ['espn-recap'] :
        tag?.document === 'nba_game_story' ? ['publisher-html'] : flash ? [flash] : [
        ...(publisherFeed ? ['publisher-rss' as const] : []),
        ...(officialPdf(requested) ? ['official-pdf' as const] : directHtml || registeredArticle ? ['publisher-html' as const] : []),
        ...(preserveLinks ? ['jina', 'exa'] as const : ['exa', 'jina'] as const),
      ];
      for (const engine of readers) {
        if (signal.aborted || body && !body.truncated) break;
        if (engine === 'exa' && !exaEnabled || engine === 'jina' && !jinaProxy) continue;
        const capture = await read(engine);
        if (capture && (!body || !capture.truncated || capture.body.length > body.body.length)) body = capture;
      }
      let fallbackReason: string | undefined;
      if (!flash && tag?.document !== 'nba_game_story' && saved.market && (!body || body.truncated)) {
        const grant = await tavilyGrant(signal, saved.market.marketEvidenceId, 'extract');
        if (grant.key) body = await read('tavily', grant.key, grant.id) ?? body;
        else fallbackReason = grant.reason;
      }
      const publicationDay = body && 'publicationDay' in body && typeof body.publicationDay === 'string'
        ? body.publicationDay : tag?.publicationDay;
      const outsideWindow = tag?.document === 'election_reporting' && saved.newsSince && publicationDay && publicationDay < saved.newsSince;
      if (outsideWindow) body = undefined;
      const { evidenceId, source, retrievedAt } = saveEvidence(requested.href,
        { kind: 'source_capture', coverage: body?.engine === 'official-pdf' ? 'document' : body ? 'body' : 'link', recordKey: requested.href, truncated: body?.truncated,
          inputEvidenceIds: [searchEvidenceId, ...(linkProof ? [linkProof.evidenceId] : [])], attempts,
          document: tag?.document ?? indexHit?.document ?? (linkedInterview ? 'leadership_interview' : undefined),
          publicationDay,
          upstreamUrl: body && 'upstreamUrl' in body ? body.upstreamUrl : indexHit?.upstreamUrl,
          upstreamPublisher: body && 'upstreamPublisher' in body ? body.upstreamPublisher : indexHit?.upstreamPublisher, ...(body
            ? { content: { format: 'text', value: body.body }, captureProvider: body.engine, ...('pages' in body ? { pages: body.pages } : {}) }
            : { failure: outsideWindow ? { stage: 'validate', reason: 'outside_requested_news_window' } :
              { stage: 'access', reason: attempts.at(-1)?.reason ?? fallbackReason ?? 'read_failed' } }),
        }, new Date().toISOString());
      return JSON.stringify({ evidenceId, source, retrievedAt, coverage: body?.engine === 'official-pdf' ? 'document' : body ? 'body' : 'link', truncated: body?.truncated,
        captureProvider: body?.engine, publicationDay, reason: outsideWindow ? 'outside_requested_news_window' : undefined,
        capturedCharacters: body?.body.length,
        upstreamUrl: body && 'upstreamUrl' in body ? body.upstreamUrl : indexHit?.upstreamUrl,
        upstreamPublisher: body && 'upstreamPublisher' in body ? body.upstreamPublisher : indexHit?.upstreamPublisher,
        readAttempts: attempts.length, paidAttempts: attempts.filter(a => a.engine === 'tavily').length,
        tavilyCredits: attempts.reduce((sum, a) => sum + (a.credits ?? 0), 0), attempts, fallbackReason,
        preview: body?.body.slice(0, 3500) });
    },
  });

  const passagesTool = defineTool({
    name: 'locate_market_source_passages',
    description: '在已保存的网页正文原文中查找最多 4 个短词。返回实际原文逐字 quote、UTF-16 offset 和上下文，可直接用于来源归一化。搜索摘要不能在这里当正文。',
    parameters: { evidenceId: required, terms: { type: 'array', required: true, items: str } },
    output,
    async execute({ evidenceId, terms }) {
      const row = loadEvidence(evidenceId);
      if (!row) throw new Error('证据不存在。');
      const snapshot = sourceSnapshotFromEvidence(row);
      const body = snapshot.content?.value;
      if (!['body', 'document'].includes(snapshot.coverage) || typeof body !== 'string') {
        throw new Error('需要已保存的 HTML/文本正文，JSON 数据请直接使用字段路径。');
      }
      if (!terms.length || terms.length > 4 || terms.some(term => !term.trim() || term.length > 120)) {
        throw new Error('需要 1 到 4 个短查找词，每个最多 120 字。');
      }
      return JSON.stringify({ evidenceId, source: snapshot.source, truncated: snapshot.truncated, matches: terms.map(term => {
        return { term, hits: literalPassages(body, term) };
      }) });
    },
  });

  const quote = obj({ quote: required, offset: { type: 'integer' } });
  const pointer = obj({ pointer: required });
  const factLocation = { oneOf: [quote, pointer], required: true } as const;
  const scopeLocation = { oneOf: [quote, pointer, obj({ url: { type: 'boolean', const: true, required: true } }),
    obj({ query: required })], required: true } as const;
  const verifyTool = defineTool({
    name: 'verify_market_source_fact',
    description: '用已保存的规则卡、网页正文和官方数据核对条款。同一条款可传多个来源的 findings，并用 searchEvidenceId 关联本轮检索。填事实位置、object/validTime/unit 等范围位置和映射理由，以及来源、覆盖和条款判断。',
    parameters: {
      cardEvidenceId: required, searchEvidenceId: str,
      findings: { type: 'array', required: true, items: obj({
        clauseId: required, sourceEvidenceId: required, at: factLocation, value: str, mapping: str,
        checks: { type: 'array', required: true, items: obj({ field: required, at: scopeLocation, basis: required,
          literal: { oneOf: [str, { type: 'number' }, { type: 'boolean' }] } }) },
        sourceMatch: { ...required, enum: ['matched', 'mismatch', 'unknown'] },
        sourceBasis: required,
        coverage: { ...required, enum: ['complete', 'observation', 'unknown'] },
        review: { ...required, enum: ['literal', 'supports', 'refutes', 'not_applicable', 'unverified'] },
        basis: required,
      }) },
    }, output,
    async execute({ cardEvidenceId, searchEvidenceId, findings }, { signal }) {
      signal.throwIfAborted();
      const row = loadEvidence(cardEvidenceId);
      if (row?.source !== 'personal-agent/research' || !object(row.data) || row.data.kind !== 'rule_card') {
        throw new Error('需要已保存的规则卡。');
      }
      const card = row.data as RuleCard;
      if (!findings.length || findings.length > 6 || card.inputEvidenceIds.some(id => !loadEvidence(id))) {
        throw new Error('需要完整规则卡和 1 到 6 个事实。');
      }
      if (searchEvidenceId !== undefined) {
        const saved = searchCapture(loadEvidence(searchEvidenceId));
        if (!saved.market) throw new Error('条款核对需要与规则卡同一市场的搜索证据。');
        marketContext(saved.market.marketEvidenceId, cardEvidenceId);
      }
      const inputs = findings.map(finding => {
        const requirement = card.evidenceRequirements.find(r => r.clauseId === finding.clauseId);
        const raw = loadEvidence(finding.sourceEvidenceId);
        if (!requirement || !raw) throw new Error('找不到条款的事实要求或原始证据。');
        const clause = card.clauses.find(item => item.id === finding.clauseId);
        if (finding.review === 'literal' && !clause?.interval && !clause?.equals) {
          throw new Error(`${finding.clauseId} 没有数值区间或字面值谓词。逐字原文仍放在 at。review 用 supports、refutes 或 unverified 表达它与条款的关系。`);
        }
        if (finding.checks.length > 12 || new Set(finding.checks.map(check => check.field)).size !== finding.checks.length) {
          throw new Error('同一事实最多 12 个不同的范围校验。');
        }
        const snapshot = sourceSnapshotFromEvidence(raw);
        const url = URL.parse(snapshot.source);
        const body = typeof snapshot.content?.value === 'string' ? snapshot.content.value : undefined;
        const checks: SourceEvidenceRequest['checks'] = finding.checks.map(({ field, at, literal, basis }) => {
          const location = resolveQuote(body, at);
          const observed = 'quote' in location ? location.quote : 'url' in location ? snapshot.source :
            'query' in location ? url?.searchParams.get(location.query) ?? undefined : undefined;
          return { field, at: location, mapping: basis,
            literal: typeof literal === 'string' && observed?.includes(literal) ? observed : literal ?? observed };
        });
        const request: SourceEvidenceRequest = { ...requirement.request, checks,
          sourceRequirement: { status: finding.sourceMatch, basis: finding.sourceBasis } };
        const at = resolveQuote(body, finding.at);
        const numbers = request.facts[0].kind === 'number' && 'quote' in at
          ? at.quote.match(/(?<![\p{L}\p{N}.,])[+−-]?\d[\d,.]*(?![\p{L}\p{N}.,])/gu) : undefined;
        const value = finding.value ?? (numbers?.length === 1 ? numbers[0].replace(/[,.]+$/, '') : undefined);
        const candidates = { facts: [{ key: requirement.factKey, at, value, mapping: finding.mapping }] };
        return { finding, snapshot, request, candidates, factKey: requirement.factKey };
      });
      const proofs = inputs.map(({ finding, snapshot, request, candidates, factKey }) => {
        const normalized = normalizeSourceEvidence(request, snapshot, candidates);
        const { evidenceId } = saveEvidence(normalized.source,
          { ...normalized.data, normalizationPlan: { request, candidates } }, normalized.retrievedAt);
        const binding: RuleFactBinding = { clauseId: finding.clauseId, normalizedEvidenceId: evidenceId, factKey,
          review: finding.review, coverage: finding.coverage, basis: finding.basis };
        const body = snapshot.content?.value;
        const fact = normalized.data.facts[0];
        const unchecked = [
          ...(!fact ? [{ field: 'fact', at: finding.at }] : []),
          ...finding.checks.filter(c => !fact?.checks.some(check => check.field === c.field && check.status === 'matched')),
        ];
        const needsLocation = typeof body === 'string' ? unchecked.flatMap(({ field, at }) => 'quote' in at
          ? [{ field, quote: at.quote, hits: literalPassages(body, at.quote) }]
          : []).slice(0, 4) : [];
        return { evidence: { ...normalized, evidenceId }, binding, needsLocation };
      });
      const checkedAt = new Date().toISOString();
      const result = assessRuleEvidence(card, proofs.map(p => p.evidence), proofs.map(p => p.binding), { now: checkedAt });
      const inputEvidenceIds = [cardEvidenceId, ...(searchEvidenceId ? [searchEvidenceId] : []), ...result.inputEvidenceIds];
      const stored = saveEvidence('personal-agent/research', { ...result, ruleCard: { ...result.ruleCard, evidenceId: cardEvidenceId },
        searchEvidenceId, inputEvidenceIds: [...new Set(inputEvidenceIds)] }, checkedAt);
      return JSON.stringify({ evidenceId: stored.evidenceId, cardEvidenceId, searchEvidenceId, settlement: result.settlement,
        conditions: result.conditions.map(({ clauseId, status, missing, observations }) => ({ clauseId, status, missing,
          observations: observations.map(o => ({ sourceEvidenceId: o.sourceRef.evidenceId, status: o.status, issue: o.issue })) })),
        facts: proofs.map(({ evidence, binding, needsLocation }) => ({ clauseId: binding.clauseId, normalizedEvidenceId: evidence.evidenceId,
          sourceEvidenceId: evidence.data.sourceRef.evidenceId, source: evidence.source, scope: evidence.data.scope,
          fact: evidence.data.facts[0], quality: evidence.data.quality, ...(needsLocation.length ? { needsLocation } : {}) })) });
    },
  });

  return [publisherTool, searchTool, readTool, officialTool, passagesTool, verifyTool] as const;
}

function literalPassages(body: string, term: string) {
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const hits = [];
  for (const match of body.matchAll(pattern)) {
    hits.push({ quote: match[0], offset: match.index,
      context: body.slice(Math.max(0, match.index - 115), match.index + match[0].length + 190) });
    if (hits.length === 3) break;
  }
  return hits;
}

function resolveQuote<T extends NonNullable<SourceEvidenceRequest['checks']>[number]['at']>(body: string | undefined, at: T): T {
  if (!body || !('quote' in at) || (at.offset !== undefined && body.startsWith(at.quote, at.offset))) return at;
  const escaped = at.quote.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if (!escaped) return at;
  const matches = body.matchAll(new RegExp(escaped, 'giu'));
  const first = matches.next().value;
  // Record an exact captured location only when the wording has a single match.
  return first && matches.next().done ? { ...at, quote: first[0], offset: first.index } : at;
}
