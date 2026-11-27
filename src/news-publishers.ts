import { readFileSync } from 'node:fs';
import { sourceSetting } from './source-config.js';

type PublisherEntry = [name: string, domains: string, endpoint: string, type: 'feed' | 'web' | 'json'];
const catalog = sourceSetting('PM_NEWS_PUBLISHERS_FILE') || new URL('../config/news-publishers.json', import.meta.url);
const registry = JSON.parse(readFileSync(catalog, 'utf8')) as Record<string, PublisherEntry[]>;


export const newsPublishers = Object.entries(registry).flatMap(([group, rows]) =>
  rows.map(([name, hosts, endpoint, type]) => {
    const domains = hosts.split(' ');
    return { id: domains[0], name, domains, endpoint, type, group };
  }));

export type NewsPublisher = typeof newsPublishers[number];

export function matchesPublisherDomain(hostname: string, domains: readonly string[]) {
  return domains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
}

type Headline = { url: string; title: string; snippet: string; publishedAt?: string; publicationDay?: string;
  upstreamUrl?: string; upstreamPublisher?: string; article?: { body: string; truncated: boolean } };
type IndexSnapshot = { at: number; headlines: Headline[]; truncated: boolean; error?: string; indexUrl?: string; cursor?: string };
type PublisherPlan = { keywords: string; sourceDomains: string[]; newsSince?: string; entities?: string[][]; document?: string };
const indexCache = new Map<string, IndexSnapshot>();
const maxBytes = 1_500_000;
const maxEntries = 160;
const feedEntry = /<(?:\w+:)?(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?\1>/gi;
const publisherNoise = new Set('the and for from news latest today yesterday official current about after reports report release result market price index update live updates breaking why what when this 新闻 最新 今天 昨天 报道 消息 發布 发布 最新消息'.split(' '));
const broadTopics = new Set('election elections electoral voting presidential presidentielle presidentielles candidate candidates candidat candidats candidatures poll polls sondage sondages latest actualite actualites partido match kickoff horario time date sports liga rates inflation cpi 選舉 选举 投票 競選 竞选 候選人 候选人 比赛 聯賽 联赛 时间 開賽 开赛'.split(' '));
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replaceAll('臺', '台');

function includesTerm(value: string, term: string) {
  const target = normalize(term).trim();
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(target) ? value.includes(target)
    : new RegExp('(?:^|[^\\p{L}\\p{N}])' + target.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '(?![\\p{L}\\p{N}])', 'iu').test(value);
}

export function matchesNewsEntities(value: string, groups: string[][]) {
  const normalized = normalize(value);
  return groups.every(group => group.some(alias => includesTerm(normalized, alias)));
}

export function decodePublisherText(value: string) {
  return value.replace(/&(amp|quot|apos|lt|gt|nbsp|[lr][sd]quo|[mn]dash|[a-z](?:acute|tilde|uml)|#\d+|#x[\da-f]+);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    const accents = { acute: '\u0301', tilde: '\u0303', uml: '\u0308' } as Record<string, string>;
    const accent = accents[name.slice(1).toLowerCase()];
    if (accent) return (name[0] + accent).normalize('NFC');
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
      mdash: '—', ndash: '–' } as Record<string, string>)[name.toLowerCase()] ?? entity;
  });
}

export function isPublisherIndex(markup: string) {
  const title = /<title\b[^>]*>([^<]*)<\/title>/i.exec(markup)?.[1] ??
    /^\s*#{1,3}\s+([^\r\n]{1,200})/.exec(markup)?.[1];
  return !!title && /^(?:[\w .-]+ )?(?:news archive|press release archive|search newsroom|search results)(?:\s*[|–-]|\s*$)/i.test(title.trim());
}

function plain(markup: string, limit = 1800) {
  return decodePublisherText(markup.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function element(markup: string, tag: string) {
  return new RegExp('<(?:\\w+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?' + tag + '>', 'i').exec(markup)?.[1] ?? '';
}

function attr(tag: string, name: string) {
  const m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? decodePublisherText(m[1] ?? m[2] ?? m[3]) : '';
}

function articleLink(value: string, base: URL, publisher: NewsPublisher) {
  const url = value && value.length <= 4096 ? URL.parse(value, base) : null;
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password ||
      !matchesPublisherDomain(url.hostname, publisher.domains)) return;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  if (url.pathname === '/' || url.href === base.href) return;
  return url.href;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown) => typeof value === 'string' ? value : '';

function newsUpstream(value: unknown) {
  const url = typeof value === 'string' && value.length <= 4096 ? URL.parse(value) : null;
  return url && /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
}

function timestamp(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() + 300_000 ? new Date(time).toISOString() : undefined;
}

function fromPublicNews(markup: string, base: URL, publisher: NewsPublisher) {
  let json: unknown;
  try { json = JSON.parse(markup); } catch { throw Error('invalid_news_json'); }
  const jin10 = publisher.id === 'jin10.com';
  const items = record(json) ? jin10 ? json.data : json.items : undefined;
  if (!Array.isArray(items)) throw Error('invalid_news_json');
  const headlines = items.slice(0, maxEntries).flatMap((item): Headline[] => {
    if (!record(item)) return [];
    if (jin10) {
      if (item.type !== 0 || record(item.extras) && item.extras.ad || !record(item.data) ||
          !/^\d{18,24}$/.test(string(item.id))) return [];
      const snippet = plain(string(item.data.content));
      const publishedAt = timestamp(string(item.time).replace(' ', 'T') + '+08:00');
      if (!snippet || !publishedAt) return [];
      const title = plain(string(item.data.title), 300) || /^【([^】]+)】/.exec(snippet)?.[1] || snippet.slice(0, 140);
      return [{ title, snippet, publishedAt, url: sourceSetting('PM_JIN10_WEB_URL') + '/detail/' + item.id,
        upstreamUrl: newsUpstream(item.data.source_link), upstreamPublisher: plain(string(item.data.source), 100) || undefined }];
    }
    const url = articleLink(string(item.url), base, publisher);
    const zh = string(item.zh), en = string(item.en);
    const title = plain((zh || en).split('\n').find(line => line.trim()) ?? '', 300);
    const publishedAt = timestamp(string(item.time));
    if (!url || !title || !publishedAt || !Number.isSafeInteger(item.no) ||
        !new RegExp('^/(?:main|tradfi|monitor)/' + item.no + '/?$').test(new URL(url).pathname)) return [];
    // The separate ai field is generated commentary. Keep the publisher text and its attribution.
    const coins = Array.isArray(item.coins) ? item.coins.filter(coin => typeof coin === 'string').slice(0, 12).join(' ') : '';
    return [{ title, snippet: plain([coins, item.source, zh, en].filter(x => typeof x === 'string').join(' ')), publishedAt, url,
      upstreamUrl: newsUpstream(item.source_url), upstreamPublisher: plain(string(item.source), 100) || undefined }];
  });
  if (items.length && !headlines.length) throw Error('no_attributed_news_links');
  const last = items.at(-1);
  const cursor = jin10 && items.length >= 20 && record(last) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(string(last.time))
    ? string(last.time) : undefined;
  return { headlines, cursor, more: !!cursor || items.length >= maxEntries ||
    record(json) && typeof json.next_cursor === 'string' && !!json.next_cursor };
}

function fromFeed(markup: string, base: URL, publisher: NewsPublisher): Headline[] {
  if (!/<(?:rss|feed|rdf:RDF)(?:\s|>)/i.test(markup)) throw Error('invalid_feed');
  const entries = [...markup.matchAll(feedEntry)].slice(0, maxEntries);
  const headlines = entries.flatMap(([entry]) => {
    const alternate = [...entry.matchAll(/<(?:\w+:)?link\b[^>]*>/gi)]
      .map(([tag]) => tag).find(tag => !attr(tag, 'rel') || attr(tag, 'rel') === 'alternate');
    const url = articleLink(plain(element(entry, 'link'), 4096) || (alternate ? attr(alternate, 'href') : ''), base, publisher);
    const title = plain(element(entry, 'title'), 300);
    const snippet = plain(element(entry, 'description') || element(entry, 'summary') || element(entry, 'content'));
    const time = Date.parse(plain(element(entry, 'pubDate') || element(entry, 'published') ||
      element(entry, 'date') || element(entry, 'updated')));
    const publishedAt = Number.isFinite(time) && time <= Date.now() + 300_000 ? new Date(time).toISOString() : undefined;
    // Axios publishes the article in content:encoded. Descriptions from other feeds stay as discovery snippets.
    const encoded = publisher.id === 'axios.com' ? element(entry, 'encoded') : '';
    const body = plain(encoded, 24_001);
    const links = [...encoded.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)].flatMap(([, tag, label]) => {
      const link = newsUpstream(attr(tag, 'href'));
      return link && !/[()]|\s/.test(link) ? ['[' + plain(label, 90).replace(/[\[\]]/g, '') + '](' + link + ')'] : [];
    }).slice(0, 20);
    const article = body.length > 300 && publishedAt
      ? { body: [title, publishedAt, body.slice(0, 24_000), ...new Set(links)].join('\n'), truncated: body.length > 24_000 }
      : undefined;
    return url && title ? [{ url, title, snippet, publishedAt, article }] : [];
  });
  if (entries.length && !headlines.length) throw Error('no_attributed_feed_links');
  return headlines;
}

function fromListing(markup: string, base: URL, publisher: NewsPublisher) {
  const links = new Map<string, Headline>();
  const html = markup.replace(/<(script|style|svg|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const speeches = publisher.id === 'newyorkfed.org';
  const rows = publisher.group === 'official'
    ? [...html.matchAll(speeches ? /<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi : /<li\b[^>]*>[\s\S]*?<\/li\s*>/gi)].map(m => m[0]) : [];
  for (const row of publisher.group === 'official' ? [...rows, html] : [html]) {
    const date = row.match(/<time\b[^>]*datetime=["'](\d{4}-\d{2}-\d{2})["']/i)?.[1];
    const dateParts = /class=["']fecha["'][^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})/i.exec(row);
    const speechDay = speeches ? row.match(/\b[A-Z][a-z]{2} \d{1,2}, 20\d{2}\b/)?.[0] : undefined;
    const day = date ?? (dateParts ? [dateParts[3], dateParts[2], dateParts[1]].join('-') :
      speechDay ? timestamp(speechDay + ' UTC')?.slice(0, 10) : undefined);
    const context = row !== html ? plain(row + ' ' + [...row.matchAll(/<img[^>]*src=["'][^"']+\/([^/"']+)["']/gi)]
      .map(m => m[1].replace(/[-_]/g, ' ')).join(' '), 550) : '';
    for (const match of row.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a\s*>/gi)) {
      const url = articleLink(attr(match[1], 'href'), base, publisher);
      const title = plain(attr(match[1], 'title') || match[2], 300);
      if (!url || links.has(url) || !/[\p{L}\p{N}]/u.test(title)) continue;
      const path = new URL(url).pathname;
      if (speeches && !/^\/newsevents\/speeches\/20\d\d\/[a-z]+\d{6}$/i.test(path)) continue;
      if (path.split('/').filter(Boolean).length < 2 && !/\d{5,}|[a-z]{4}(?:-[a-z\d]{2,}){2,}/i.test(path)) continue;
      if (title.length < (publisher.group === 'official' ? 8 : 18) && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{6}/.test(title)) continue;
      const listingDate = publisher.group === 'official' && row === html
        ? /class=["'][^"']*\bindex-item-text-info-date\b[^"']*["'][^>]*>\s*([A-Za-z]+ \d{1,2}, 20\d{2})\s*</i
            .exec(row.slice(Math.max(0, match.index - 380), match.index))?.[1] : undefined;
      const listed = listingDate ? Date.parse(listingDate + ' UTC') : NaN;
      links.set(url, { url, title, snippet: context, publicationDay: Number.isFinite(listed)
        ? new Date(listed).toISOString().slice(0, 10) : row !== html ? day : undefined });
      if (links.size === maxEntries) break;
    }
    if (links.size === maxEntries) break;
  }
  if (!links.size) throw Error('no_attributed_listing_links');
  return [...links.values()];
}

async function limitedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return { markup: '', truncated: false };
  const headerCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1];
  let decoder: TextDecoder | undefined;
  let markup = '', size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) return { markup: markup + (decoder?.decode() ?? ''), truncated: false };
    if (!decoder) {
      const label = headerCharset ?? /charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder().decode(part.value.subarray(0, 4096)))?.[1];
      try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder(); }
    }
    const room = maxBytes - size;
    if (part.value.length > room) {
      markup += decoder.decode(part.value.subarray(0, room));
      await reader.cancel();
      return { markup, truncated: true };
    }
    size += part.value.length;
    markup += decoder.decode(part.value, { stream: true });
  }
}

async function readIndex(publisher: NewsPublisher, signal: AbortSignal, endpoint: string = publisher.endpoint) {
  const timeout = AbortSignal.timeout(4500);
  const fetchSignal = AbortSignal.any([signal, timeout]);
  const start = new URL(endpoint);
  try {
    let url = start;
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await fetch(url, { redirect: 'manual', signal: fetchSignal, headers: {
        Accept: publisher.type === 'json' ? 'application/json' :
          publisher.type === 'feed' ? 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*' : 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; pm-personal-agent/0.1)',
        // These are the Jin10 public website's client identifiers. The request selects public flashes only.
        ...(publisher.id === 'jin10.com' ? { 'x-app-id': 'bVBF4FyRTn5NJF5n', 'x-version': '1.0.0' } : {}),
      } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        const next = location ? URL.parse(location, url) : null;
        await response.body?.cancel();
        if (!next || next.protocol !== 'https:' || next.username || next.password ||
            (next.hostname !== start.hostname && !matchesPublisherDomain(next.hostname, publisher.domains))) {
          throw Error('redirect_outside_publisher');
        }
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('HTTP_' + response.status);
      }
      const { markup, truncated } = await limitedText(response);
      if (publisher.type === 'json') {
        if (truncated) throw Error('truncated_news_json');
        const { headlines, more, cursor } = fromPublicNews(markup, url, publisher);
        return { at: Date.now(), headlines, truncated: more, cursor, indexUrl: endpoint };
      }
      const headlines = publisher.type === 'feed' ? fromFeed(markup, url, publisher) : fromListing(markup, url, publisher);
      return { at: Date.now(), headlines, truncated: truncated || headlines.length === maxEntries, indexUrl: endpoint };
    }
    throw Error('redirect_limit');
  } catch (error) {
    const known = error instanceof Error && /^(?:HTTP_\d+|no_attributed_\w+_links|redirect_\w+|invalid_feed|invalid_news_json|truncated_news_json)$/.test(error.message);
    return { at: Date.now(), headlines: [], truncated: false, indexUrl: endpoint,
      error: signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : known ? (error as Error).message : 'network_error' };
  }
}

export async function readPublisherFeedArticle(url: URL, signal: AbortSignal) {
  const publisher = newsPublishers.find(item => item.id === 'axios.com' && matchesPublisherDomain(url.hostname, item.domains));
  if (!publisher) throw Error('document_identity_mismatch');
  const canonical = articleLink(url.href, new URL(publisher.endpoint), publisher);
  const cached = indexCache.get(publisher.id);
  const index = cached && !cached.error && Date.now() - cached.at < 300_000 ? cached : await readIndex(publisher, signal);
  if (index.error) throw Error(index.error);
  indexCache.set(publisher.id, index);
  const hit = index.headlines.find(item => item.url === canonical && item.article);
  if (!hit?.article) throw Error('document_text_empty');
  return hit.article;
}

function termsFor(keywords: string) {
  const words = segmenter.segment(normalize(keywords.replace(/(?:^| )-?site:[a-z\d.-]+/gi, ' ')));
  return [...new Set([...words].filter(w => w.isWordLike).map(w => w.segment)
    .filter(term => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{2}|[a-z]{3}|^(?:ai|uk|us|eu)$/.test(term) &&
      !publisherNoise.has(term)))].slice(0, 24);
}

const financePairs = /\b[A-Z]{3}\s*\/\s*[A-Z]{3}\b/gi;
const exchangeWords = /\b(?:upbit|bithumb|coinone|korbit|binance)\b|币安/i;
const exchangeActions = /^(?:公告|上线|暂停|下架|交易|充值|公告栏|announcements?|notices?|listing|delisting|suspension)$/i;

export async function searchPublisherIndexes(publishers: NewsPublisher[], plan: PublisherPlan[], signal: AbortSignal) {
  const deadline = AbortSignal.timeout(18_000);
  const batchSignal = AbortSignal.any([signal, deadline]);
  const queries = plan.map(query => ({ ...query, terms: termsFor(query.keywords),
    datedTopic: query.sourceDomains.length ? normalize(query.keywords)
      .match(/\b(?:presidentielle|elections?|world cup|championships?|olympics)\s+20\d\d\b/)?.[0] : undefined,
    pairs: [...query.keywords.matchAll(financePairs)].map(([pair]) => pair.replace(/\s+/g, '').toLowerCase()),
    since: query.newsSince ? Date.parse(query.newsSince + 'T00:00:00+08:00') : -Infinity }));
  let cursor = 0;
  const scheduled = [...publishers].sort((a, b) => Number(b.type === 'json') - Number(a.type === 'json'));
  const results = new Map<string, Awaited<ReturnType<typeof searchOne>>>();
  async function searchOne(publisher: NewsPublisher) {
    const start = Date.now();
    const validQueries = queries.filter(q => !q.sourceDomains.length || publisher.domains.some(domain =>
      q.sourceDomains.some(host => matchesPublisherDomain(domain, [host]) || matchesPublisherDomain(host, [domain]))));
    const scopedQueries = validQueries.filter(q => q.sourceDomains.some(host => matchesPublisherDomain(host, publisher.domains)));
    const endpoint = new URL(publisher.endpoint);
    if (publisher.id === 'eqn.news') {
      const scoped = scopedQueries.find(q => exchangeWords.test(q.keywords)) ?? scopedQueries[0];
      const text = (validQueries.find(q => exchangeWords.test(q.keywords)) ?? scoped ?? validQueries[0])?.keywords ?? '';
      const coin = /(?:\b(bitcoin|ethereum|btc|eth|sol|xrp|bnb|doge|avax|hype)\b|比特币|以太坊)/i.exec(text)?.[0].toLowerCase();
      const exchangeChannel = /\b(?:upbit|bithumb|coinone|korbit)\b/i.test(text) ? 'korea' :
        /\bbinance\b|币安/.test(text.toLowerCase()) ? 'binance' : undefined;
      if (exchangeChannel) endpoint.searchParams.set('channel', exchangeChannel);
      if (coin) endpoint.searchParams.set('coin', ({ bitcoin: 'BTC', '比特币': 'BTC', ethereum: 'ETH', '以太坊': 'ETH' } as Record<string, string>)[coin] ?? coin.toUpperCase());
      if (scoped && !exchangeChannel) {
        const topic = scoped.terms.find(term => term !== coin && !/^(?:bitcoin|ethereum|比特|以太|区块链|加密|币圈)$/.test(term));
        if (topic) endpoint.searchParams.set('query', topic);
      }
    }
    const cached = indexCache.get(publisher.id);
    const reusable = cached && cached.indexUrl === endpoint.href &&
      start - cached.at < (cached.error ? 120_000 : publisher.type === 'json' ? 60_000 : 300_000);
    const attempted = !batchSignal.aborted && !reusable;
    const snapshot = signal.aborted ? undefined : reusable ? cached : attempted ? await readIndex(publisher, batchSignal, endpoint.href) : undefined;
    const reason = signal.aborted ? 'cancelled' : deadline.aborted && (!snapshot || snapshot.error === 'cancelled')
      ? 'batch_deadline' : snapshot?.error;
    if (attempted && snapshot && !reason?.match(/^(?:cancelled|batch_deadline)$/)) indexCache.set(publisher.id, snapshot);
    const matchedRows = (headlines: Headline[]) => headlines.flatMap(hit => {
      const published = hit.publishedAt ? Date.parse(hit.publishedAt) : undefined;
      const title = normalize(hit.title), snippet = normalize(hit.snippet);
      const matching = validQueries.filter(q => (!hit.publicationDay || !q.newsSince || hit.publicationDay >= q.newsSince) &&
        (published === undefined || published >= q.since) &&
        (!q.entities?.length || matchesNewsEntities(hit.title + ' ' + hit.snippet, q.entities)))
        .flatMap(q => {
          const words = title + ' ' + snippet;
          const interchangeable = q.terms.filter(term => exchangeActions.test(term)).length >= 2;
          const authoredNotice = publisher.id === 'eqn.news' && !!hit.upstreamPublisher &&
            q.terms.some(term => exchangeWords.test(term) && matchesNewsEntities(hit.upstreamPublisher!, [[term]])) &&
            q.terms.every(term => exchangeWords.test(term) || interchangeable && exchangeActions.test(term) ||
              /^(?:公告|announcements?|notices?)$/i.test(term));
          const pairMatch = publisher.id === 'jin10.com' && q.pairs.some(pair => words.includes(pair));
          const direct = q.terms.filter(term => includesTerm(title, term));
          const covered = q.terms.filter(term => includesTerm(words, term));
          const significant = covered.filter(term => !broadTopics.has(term));
          const datedHeadline = q.datedTopic && includesTerm(title, q.datedTopic);
          if (!authoredNotice && !pairMatch && !datedHeadline && ((!direct.length && (publisher.type !== 'json' || !covered.length)) ||
              q.terms.length > 1 && (significant.length < 1 || covered.length < 2))) return [];
          return [{ score: Math.max(direct.length, Number(authoredNotice), Number(pairMatch)) * 3 + covered.length, document: q.document ??
            (publisher.type === 'json' ? publisher.id === 'jin10.com' ? 'jin10_flash' : 'equation_flash' : undefined) }];
        }).sort((a, b) => Number(!!b.document) - Number(!!a.document) || b.score - a.score);
      return matching[0] ? [{ ...hit, ...matching[0] }] : [];
    });
    const rows = reason ? [] : matchedRows(snapshot?.headlines ?? []);
    const pageAttempts: { url: string; startedAt: string; finishedAt: string; status: 'ok' | 'failed'; reason?: string }[] = [];
    let cursor = snapshot?.cursor;
    while (publisher.id === 'jin10.com' && scopedQueries.length && !rows.length && cursor && pageAttempts.length < 2 &&
        !batchSignal.aborted && scopedQueries.some(q => Date.parse(cursor!.replace(' ', 'T') + '+08:00') >= q.since)) {
      const next = new URL(endpoint);
      next.searchParams.set('max_time', cursor);
      const startedAt = new Date().toISOString();
      const page = await readIndex(publisher, batchSignal, next.href);
      pageAttempts.push({ url: next.href, startedAt, finishedAt: new Date(page.at).toISOString(),
        status: page.error ? 'failed' : 'ok', reason: page.error });
      rows.push(...matchedRows(page.headlines));
      cursor = page.cursor === cursor ? undefined : page.cursor;
    }
    rows.sort((a, b) => b.score - a.score || (b.publishedAt ?? b.publicationDay ?? '').localeCompare(a.publishedAt ?? a.publicationDay ?? ''));
    const firstPerDocument = validQueries.flatMap(query => {
      const hit = query.document && rows.find(row => row.document === query.document);
      return hit ? [hit] : [];
    });
    const selected = [...new Set([...firstPerDocument, ...rows])].slice(0, 5);
    return {
      engine: publisher.type === 'json' ? 'publisher-json' as const : publisher.type === 'feed' ? 'publisher-rss' as const : 'publisher-web' as const,
      publisher: publisher.name, publisherId: publisher.id,
      indexUrl: endpoint.href, indexRetrievedAt: snapshot && new Date(snapshot.at).toISOString(),
      cached: !!reusable && !!snapshot, attempted, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - start, reason, status: signal.aborted ? 'cancelled' as const :
        reason === 'batch_deadline' && !attempted ? 'unavailable' as const :
        reason ? 'failed' as const : rows.length ? 'ok' as const : 'empty' as const,
      truncated: !!snapshot?.truncated || rows.length > 5, returned: rows.length, engineErrors: [],
      ...(pageAttempts.length ? { pageAttempts } : {}),
      results: selected.map((hit, i) => ({ rank: i + 1, url: hit.url, domain: new URL(hit.url).hostname,
        title: hit.title, snippet: hit.snippet.slice(0, 300), snippetTruncated: hit.snippet.length > 300,
        engines: [publisher.id], publishedAt: hit.publishedAt, publicationDay: hit.publicationDay, feedScore: hit.score, document: hit.document,
        upstreamUrl: hit.upstreamUrl, upstreamPublisher: hit.upstreamPublisher })),
    };
  }
  await Promise.all(Array.from({ length: Math.min(16, publishers.length) }, async () => {
    while (cursor < publishers.length) {
      const publisher = scheduled[cursor++];
      results.set(publisher.id, await searchOne(publisher));
    }
  }));
  return publishers.map(publisher => results.get(publisher.id)!);
}
