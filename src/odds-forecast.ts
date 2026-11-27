import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { EvidenceRow } from './source-evidence.js';
import type { RuleCard } from './research.js';
import { qualifiedBook } from './watch-activity.js';
import { readCs2OddsReference, readNbaOddsReference } from './odds-source.js';

const source = 'personal-agent/odds-forecast';
const policy = { method: 'odds_linear_pool_v1', alpha: .5, minSportsbooks: 2, externalMaxAgeSeconds: 120,
  pmMaxAgeSeconds: 30, maxAlignmentSeconds: 120, maxPmSpread: .10, maxMappingAgeSeconds: 600 } as const;
const referencePolicyV2 = { method: 'single_market_odds_reference_v2', aggregate: 'median', alpha: policy.alpha,
  minSportsbooks: policy.minSportsbooks, externalMaxAgeSeconds: policy.externalMaxAgeSeconds,
  pmMaxAgeSeconds: policy.pmMaxAgeSeconds, maxAlignmentSeconds: policy.maxAlignmentSeconds, maxPmSpread: policy.maxPmSpread } as const;
const referencePolicyV3 = { ...referencePolicyV2, method: 'single_market_odds_reference_v3',
  pollingWindow: 'source_stale_after', officialClock: 'verified_direct_response_or_book_version' } as const;
const referencePolicyV4 = { ...referencePolicyV3, method: 'single_market_odds_reference_v4',
  settlementFallback: 'standard_prematch_team_markets' } as const;
const referencePolicyV5 = { ...referencePolicyV4, method: 'single_market_odds_reference_v5',
  blend: { depthShares: 100, baseUncertainty: .01, smallSamplePenalty: 2, unfilledDepthPenalty: .025, minWeight: .20 } } as const;
const referencePolicyV6 = { ...referencePolicyV5, method: 'single_market_odds_reference_v6',
  nbaMoneylineDefault: 'polymarket_midpoint' } as const;
const referencePolicyV7 = { ...referencePolicyV6, method: 'single_market_odds_reference_v7',
  settlementSelection: 'verified_and_assumed' } as const;
const referencePolicy = { ...referencePolicyV7, method: 'single_market_odds_reference_v8',
  fullWinnerSettlement: 'normal_decisive_result' } as const;
type ReferencePolicy = typeof referencePolicy | typeof referencePolicyV7 | typeof referencePolicyV6 | typeof referencePolicyV5 | typeof referencePolicyV4
  | typeof referencePolicyV3 | typeof referencePolicyV2;
const games = ['cs2', 'lol', 'dota2', 'valorant', 'r6'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)).digest('hex');
const age = (now: number, clock?: string | null) => (now - Date.parse(clock ?? '')) / 1000;
const nullable = (n: number) => Number.isFinite(n) ? n : null;
const labelKey = (label: string) => label.trim().normalize('NFKC').toLowerCase();
const groupKey = (label: string) => labelKey(label).replace(/[^\p{L}\p{N}]/gu, '');
const safeError = (error: unknown) => error instanceof Error && /HTTP \d{3}$/.test(error.message)
  ? error.message.match(/HTTP \d{3}$/)![0] : error instanceof Error ? error.name : 'unknown';

type Option = { label: string; tokenId: string; price?: string | null };
type Target = { marketId: number; conditionId: string; eventSlug: string; slug: string; title: string;
  tokenId: string; option: string; tokens: string[]; catalogPrice: number | null };
type Market = { status: string; localMarketId: number; conditionId: string; slug: string; eventSlug: string; title: string;
  category?: string; tags?: string[]; acceptingOrders?: boolean; active?: boolean; closed?: boolean; stateObservedAt?: string;
  quoteObservedAt?: string; quoteUpdatedAt?: string;
  rules?: string; truncated?: boolean; hasMore?: boolean; outcomeSemanticsValid?: boolean; yesTokenId: string; noTokenId: string;
  outcomes?: Option[]; candidates?: unknown[]; markets?: unknown[] };
type Quote = { book: string; provider: string; label: string; category: string; market: string; period: string; metric?: string;
  sourceUpdatedAt?: string | null; receivedAt?: string | null; sourceStale?: boolean; sourceError?: string | null;
  sourceCheckedAt?: string | null; streamValidUntil?: string; groupId?: string;
  sourceRevision?: string; sourceOddsFormat?: string; phase?: string; suspended?: boolean; sampleTier?: string; url?: string;
  overround: number; outcomes: { name: string; decimal: number; probability: number; point: number | null }[] };
type RuleCheck = { status: 'compatible' | 'conflict' | 'unknown'; reasons?: string[]; scenarios?: unknown[];
  normalOutcomeStatus?: 'aligned' | 'unknown' | 'conflict';
  version?: string; checkedAt?: string; evidence?: { id: string; revision: string; checkedAt: string; current?: boolean }[] };
type Match = { marketId: string; conditionId: string; eventSlug?: string; type: string; metric: string; period: string;
  line: string | null; handicapTeam?: string | null; predicate?: string | null; rulesHash: string; outcomes: Option[];
  books: { book: string; provider: string; pairs: { selection: string; tokenId: string }[]; ruleCheck: RuleCheck }[] };
type Fixture = { id: string; providerFixtureIds?: string[]; home: string; away: string; competition: string; sport: string;
  startTime: string; inPlay?: boolean; rejectedMarkets?: number; quotes: Quote[];
  polymarketMatch: { state: string; pmEventId?: string; version?: number; stale?: boolean; checkedAt?: number; verifiedAt?: number;
    marketCoverage?: string; selectionVersion?: string; reason?: string; markets: Match[] } };
type Read = { source: string; retrievedAt: string; data: unknown };
type Scope = { family: 'sports' | 'game'; sport?: string; search?: string };
type Host = { resolveTarget: (input: string, signal: AbortSignal) => Promise<Read>;
  readOdds: (path: string, signal: AbortSignal) => Promise<Read>;
  readOfficialBook: (target: Target, signal: AbortSignal) => Promise<unknown>;
  loadEvidence: (id: string) => EvidenceRow | undefined;
  saveEvidence: (source: string, data: unknown, retrievedAt: string, id?: string) => EvidenceRow };

function identify(market: Market, input: string): Target | undefined {
  const tokens = [market.yesTokenId, market.noTokenId];
  if (market.status !== 'found' || !Number.isSafeInteger(market.localMarketId) || market.localMarketId < 1
      || !/^0x[0-9a-f]{64}$/i.test(market.conditionId) || tokens.some(token => !/^\d+$/.test(token))
      || new Set(tokens).size !== 2) return;
  // Named sports outcomes are not boolean Yes/No. Verify the listed labels
  // against the resolver's canonical tokens, regardless of their order.
  const listed = market.outcomes ?? [];
  const explicit = listed.length === 2 && new Set(listed.map(o => o.tokenId)).size === 2
    && listed.every(o => tokens.includes(o.tokenId) && typeof o.label === 'string' && o.label.trim());
  const options: Option[] = explicit ? listed : market.outcomeSemanticsValid === true
    ? [{ label: 'Yes', tokenId: tokens[0] }, { label: 'No', tokenId: tokens[1] }] : [];
  const matches = options.filter(o => input === o.tokenId || labelKey(input) === labelKey(o.label));
  const canonicalToken = tokens.includes(input) ? input : matches.length === 1 ? matches[0].tokenId : undefined;
  if (!canonicalToken) return;
  const option = options.find(o => o.tokenId === canonicalToken);
  return { marketId: market.localMarketId, conditionId: market.conditionId, eventSlug: market.eventSlug, slug: market.slug,
    title: market.title, tokenId: canonicalToken, option: option?.label ?? canonicalToken, tokens,
    catalogPrice: option?.price ? nullable(Number(option.price)) : null };
}

type LookupBook = { status: string; evidenceId: string; retrievedAt: string; reason?: string; httpStatus?: number | null;
  result?: { bestBid: number | null; bestAsk: number | null; sourceTime: string | null;
    ageSeconds: number | null; timestampStatus: string; bookShape: string; directlyObservedAt?: string;
    bidLevels?: number; askLevels?: number; bids?: { price: number; size: number }[]; asks?: { price: number; size: number }[] } };
type LookupQuote = Pick<Quote, 'book' | 'label' | 'provider' | 'sourceUpdatedAt' | 'receivedAt' | 'sourceStale' | 'sourceError'
  | 'sourceCheckedAt' | 'streamValidUntil' | 'sampleTier' | 'phase' | 'groupId' | 'sourceRevision'
  | 'category' | 'market' | 'period' | 'metric'>
  & { outcomes: { name: string; decimal: number; point: number | null; matchesOption: boolean;
      sourcePrice?: number | string | null; normalizedProbability?: number | null; tokenId?: string }[];
    sourceOddsFormat?: string | null; providerFixtureIds?: string[]; priceTimeScope?: string | null; overround?: number | null;
    sourceSnapshot?: { id: string; cadenceSeconds: number; staleAfterSeconds: number } | null;
    comparisonBasis?: 'exact_entities_and_time' | 'esports_game_only' | 'esports_schedule_offset' | 'nba_tipoff_offset';
    ruleCheck: RuleCheck; fixture: { id: string; startTime?: string; inPlay?: boolean } };
type FixtureExample = { home: string; away: string; startTime: string; provider: string };
type LookupQuotes = { status: string; evidenceId?: string; source?: string; retrievedAt?: string; reason?: string; matchedQuoteCount?: number;
  market?: Pick<Match, 'type' | 'metric' | 'line' | 'period' | 'predicate' | 'rulesHash'>
    & { ruleFacts?: { overtime?: string }; pmRuleEvidence?: { basis: string; marketId: string; revision: string } };
  event?: { id: string; scheduledStartTime: string; sport?: string; sportFamily?: string; teams?: string[];
    bestOf?: number | null }; truncated?: boolean; quotes?: LookupQuote[];
  publicReference?: Awaited<ReturnType<typeof readNbaOddsReference>>;
  publicQuotes?: Omit<NonNullable<LookupQuotes['publicReference']>[number], 'evidenceId'>[];
  sourceCoverage?: { theOddsApi?: string; sirBetalot?: string; draftKingsEspn?: string; bet365?: string; pinnacle?: string };
  sources?: { id: string; usable?: boolean; stale?: boolean; error?: string | null; lastSuccessAt?: string | null }[];
  diagnostics?: { latestFreshKickoff?: string | null; aliasCandidate?: FixtureExample | null; kickoffCandidate?: FixtureExample | null };
  rejectedQuotes?: Record<string, number>; rejectedEvents?: Record<string, number> };
type LookupHost = Omit<Host, 'loadEvidence'>;
type LookupInput = { target: Target; market: Market; targetRow: EvidenceRow; polymarket: LookupBook; bookmakers: LookupQuotes };

const oddsClock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' });
const oddsTime = (value: string | number | null | undefined) => value != null && Number.isFinite(new Date(value).getTime())
  ? oddsClock.format(new Date(value)) : '未知';
const oddsPercent = (value: number) => `${(100 * value).toFixed(2)}%`;
const oddsReasons: Record<string, string> = {
  no_bookmaker_reference: '缺完整可用的同盘口书商参考', official_book_unqualified: 'PM 双边盘口、时效、市场状态或价差未达标',
  fewer_than_two_current_prematch_books: '在有效观察窗口内的赛前书商不足两家',
  normal_outcome_rules_unverified: '常规赛果规则通过的有效书商不足两家',
  source_times_not_aligned: 'PM 官方观察时间未与足够的书商有效窗口对齐',
  unsupported_line_or_market: '当前盘口类型或盘口线缺少对应的计算口径', not_prematch: '未确认在赛前',
};
type QuoteCheck = { status: 'fusion' | 'reference' | 'excluded'; reason?: string; probability?: number; until?: number };

type BookDepth = Pick<NonNullable<LookupBook['result']>, 'bids' | 'asks'>;
function topFive(book?: BookDepth) {
  return { bids: book?.bids?.slice(0, 5) ?? [], asks: book?.asks?.slice(0, 5) ?? [] };
}

function fiveLevels(book?: BookDepth) {
  const { bids, asks } = topFive(book);
  const show = (levels: typeof bids) => levels.map(({ price, size }) => `${price} × ${size}`).join('、') || '无报价';
  return [`- 买盘 ${show(bids)}`, `- 卖盘 ${show(asks)}`].join('\n');
}

function officialBookReply(book: LookupBook) {
  if (book.result) {
    const { ageSeconds, sourceTime, directlyObservedAt } = book.result;
    const observed = ageSeconds !== null && ageSeconds > 30
      ? directlyObservedAt
        ? `官方读取 ${oddsTime(directlyObservedAt)}，盘口快照 ${oddsTime(sourceTime)}（北京时间）。`
        : `最近取得的盘口快照为 ${oddsTime(sourceTime)}（北京时间），实时状态未确认。`
      : '';
    return [fiveLevels(book.result), observed].filter(Boolean).join('\n\n');
  }
  const reason = book.reason === 'ECONNRESET' ? '连接被重置'
    : ['ETIMEDOUT', 'TimeoutError', 'AbortError', 'ABORT_ERR'].includes(book.reason ?? '') ? '连接超时' : '连接异常';
  switch (book.status) {
    case 'access_failed': return `官方盘口读取失败（${reason}）。`;
    case 'not_found': return '官方接口未找到该选项的盘口（HTTP 404）。';
    case 'rate_limited': return '官方接口暂时限流。';
    case 'http_error': return `官方盘口请求失败（HTTP ${book.httpStatus ?? '未知'}）。`;
    case 'invalid_response': return '官方盘口响应无法核验。';
    default: return '未取得可用的官方盘口。';
  }
}

function bookmakerOdds(quote: { book: string; label?: string; provider: string; outcomes: Quote['outcomes'] | LookupQuote['outcomes'] }) {
  const odds = quote.outcomes.map(({ name, point, decimal }) => `${name}${point == null ? '' : ` (${point})`} ${Number(decimal.toFixed(4))}`);
  return `- ${quote.label || quote.book}（${quote.provider}）· ${odds.join(' / ')}`;
}

function bookmakerGap(external: LookupQuotes) {
  const { aliasCandidate, kickoffCandidate, latestFreshKickoff } = external.diagnostics ?? {};
  const kickoff = external.event?.scheduledStartTime;
  if (external.status === 'no_event_match') {
    if (aliasCandidate) return `疑似队名映射漏配。${aliasCandidate.provider} 快照中有 ${aliasCandidate.away} 对 ${aliasCandidate.home}，开赛 ${oddsTime(aliasCandidate.startTime)}（北京时间），需核对队名映射。`;
    if (kickoffCandidate) return `开赛时间不一致。书商快照为 ${oddsTime(kickoffCandidate.startTime)}，Polymarket 为 ${oddsTime(kickoff)}（北京时间）。`;
    if (latestFreshKickoff && kickoff && Date.parse(kickoff) > Date.parse(latestFreshKickoff))
      return `尚未覆盖到本场。已接入的有效书商快照最远到 ${oddsTime(latestFreshKickoff)} 开赛，目标比赛在 ${oddsTime(kickoff)} 开赛（北京时间）。`;
    if (latestFreshKickoff) return '当前有效书商来源未提供这场可匹配的同盘口报价。';
    if (external.sources?.length && !external.sources.some(s => s.usable && !s.stale && !s.error))
      return '已接入的书商源当前缺少可用的有效快照，无法判断本场有无报价。';
    return '当前快照未匹配到本场，缺少可核对的赛程覆盖依据。';
  }
  if (external.status === 'no_matching_quote') return external.rejectedQuotes?.suspended
    ? '已找到该比赛和目标盘口，当前快照中的同盘口报价已暂停。'
    : '已找到该比赛，但快照中没有所问盘口、时段及盘口线的完整赔率。';
  if (external.status === 'unavailable') return /^HTTP \d{3}$/.test(external.reason ?? '')
    ? `Polymonitor 请求失败（${external.reason}），本次无法判断有无报价。`
    : external.reason === 'TimeoutError' ? 'Polymonitor 请求超时，本次无法判断有无报价。'
      : 'Polymonitor 请求失败，本次无法判断有无报价。';
  return ({
    target_unresolved: 'Polymonitor 无法复核此市场的合约和选项身份。',
    unsupported_market: 'Polymonitor 无法复核此盘口或事件口径。',
    sources_unavailable: 'Polymonitor 当前没有可用的书商快照，无法判断本场是否开盘。',
    invalid_response: 'Polymonitor 回执的市场或选项身份校验失败。',
  } as Record<string, string>)[external.status] ?? '暂无同盘口赔率。';
}

function marketOddsReply(target: Target, book: LookupBook, external: LookupQuotes) {
  const coverage = external.sourceCoverage;
  const nbaChecks = [
    coverage?.bet365 === 'no_moneyline_in_feed' ? 'bet365（MoviOdds）当前无本场胜负报价。'
      : coverage?.bet365 === 'source_unavailable' ? 'bet365（MoviOdds）当前源不可用。' : '',
    coverage?.pinnacle === 'no_moneyline_in_feed' ? 'Pinnacle（Pinnodds）当前无本场胜负报价。'
      : coverage?.pinnacle === 'source_unavailable' ? 'Pinnacle（Pinnodds）当前镜像不可用。' : '',
    coverage?.draftKingsEspn === 'fixture_without_moneyline' ? 'DraftKings（ESPN）已列本场比赛，当前没有双边胜负赔率。'
      : coverage?.draftKingsEspn === 'source_unavailable' ? 'DraftKings（ESPN）当前源不可用。' : '',
  ].filter(Boolean).join(' ');
  const supplementalGap = ({
    league_not_served_now: 'The Odds API 当前目录没有该联赛。',
    fixture_not_listed: 'The Odds API 的赛程中未找到这场。',
    no_prices: 'The Odds API 找到比赛，当前未返回该盘口赔率。',
    quota_reserved: 'The Odds API 当前没有可用于按需查询的额度。',
    source_temporarily_unavailable: 'The Odds API 当前连接不可用。',
    source_rate_limited: 'The Odds API 当前限流。',
    lookup_busy: 'The Odds API 当前另有查询正在进行。',
    lookup_failed: 'The Odds API 本次读取失败。',
  } as Record<string, string>)[external.sourceCoverage?.theOddsApi ?? ''];
  const odds = external.status === 'matched' && external.quotes?.length
    ? external.quotes.map(bookmakerOdds).join('\n') : [bookmakerGap(external), nbaChecks, supplementalGap,
      !nbaChecks && coverage?.sirBetalot === 'access_denied' ? 'Sir Betalot 拒绝了本次读取（HTTP 403）。' : '',
    ].filter(Boolean).join(' ');
  const references = external.publicReference ?? [];
  const referenceGroups = Map.groupBy(references, quote => quote.publisher);
  const historical = [...referenceGroups].map(([publisher, quotes]) => [
    publisher === 'Sir Betalot' ? `书商页面参考报价（Sir Betalot，北京时间） · ${quotes[0].url}`
      : publisher ? `公开赛前报价（${publisher}，北京时间） · ${quotes[0].url}`
        : '公开历史参考（LunoSport，未核验当前报价）',
    ...quotes.map(({ book, outcomes, displayedTime }) =>
      `- ${book} · ${outcomes.map(({ name, decimal }) => `${name} ${Number(decimal.toFixed(4))}`).join(' / ')} · 页面记录 ${publisher ? oddsTime(displayedTime) : displayedTime}`),
  ].join('\n')).join('\n\n');
  const kickoff = external.event?.scheduledStartTime;
  const matchupNotes = new Set((external.quotes ?? []).flatMap(quote => {
    if (quote.comparisonBasis === 'esports_game_only')
      return [`${quote.provider} 只标了游戏项目，按双方队名和开赛时间对应本场。`];
    if (quote.comparisonBasis === 'esports_schedule_offset' || quote.comparisonBasis === 'nba_tipoff_offset')
      return [`${quote.provider} 开赛时间标为 ${oddsTime(quote.fixture.startTime)}，Polymarket 标为 ${oddsTime(kickoff)}（北京时间）。`];
    return [];
  }));
  return [
    `**${target.title} · ${target.option}**${kickoff ? `\n计划开赛 ${oddsTime(kickoff)}（北京时间）` : ''}`,
    `### 书商赔率与来源（十进制）\n${[odds, ...matchupNotes, historical].filter(Boolean).join('\n\n')}`,
    `### Polymarket 官方盘口（最多五档，价格 × 份数）\n${officialBookReply(book)}`,
  ].join('\n\n');
}

async function readMarketOdds(host: LookupHost, input: string, option: string, signal: AbortSignal) {
  const resolved = await host.resolveTarget(input.trim(), signal);
  const targetRow = host.saveEvidence(resolved.source, resolved.data, resolved.retrievedAt);
  const market = resolved.data as Market;
  const target = identify(market, option.trim());
  if (!target) return { status: 'target_unresolved', marketEvidenceId: targetRow.evidenceId, resolverStatus: market.status,
    choices: market.outcomes ?? market.markets ?? market.candidates ?? [] };

  const ids = new URLSearchParams({ conditionId: target.conditionId, tokenId: target.tokenId });
  const readBookmakers = async (): Promise<LookupQuotes> => {
    try {
      const result = await host.readOdds(`/runtime/bookmakers/market/${target.marketId}?${ids}`, signal);
      const { evidenceId } = host.saveEvidence(result.source, result.data, result.retrievedAt);
      const data = result.data as LookupQuotes & { schemaVersion: number; marketId: string; conditionId: string; tokenId: string };
      const metadata = { evidenceId, source: result.source, retrievedAt: result.retrievedAt };
      if (data?.schemaVersion !== 1 || data.marketId !== String(target.marketId) || data.tokenId !== target.tokenId
          || data.conditionId !== target.conditionId.toLowerCase() || !Array.isArray(data.quotes))
        return { ...metadata, status: 'invalid_response' };
      return { ...data, ...metadata };
    } catch (cause) {
      signal.throwIfAborted();
      return { status: 'unavailable', reason: safeError(cause) };
    }
  };
  const bookmakers = await readBookmakers();
  if (bookmakers.event && bookmakers.market?.type === 'h2h' && bookmakers.market.period === 'full') {
    const { teams = [], scheduledStartTime, sport, bestOf } = bookmakers.event;
    const quotes = bookmakers.quotes ?? [];
    const cs2 = sport === 'cs2' ? readCs2OddsReference({
      teams: [teams, ...quotes.map(quote => quote.outcomes.map(outcome => outcome.name))],
      kickoff: scheduledStartTime, bestOf, tournament: target.title.split(') - ')[1] ?? '',
      existingBooks: quotes.map(quote => quote.book),
    }, host.saveEvidence, signal) : [];
    const historical = sport === 'nba' && !quotes.length
      ? readNbaOddsReference(target.slug, teams, scheduledStartTime, host.saveEvidence, signal) : [];
    const bookmakerKey = (name: string) => labelKey(name).replace(/[^\p{L}\p{N}]/gu, '');
    const direct = (bookmakers.publicQuotes ?? []).map(quote => ({ ...quote,
      evidenceId: host.saveEvidence(quote.url, quote, bookmakers.retrievedAt ?? new Date().toISOString()).evidenceId }));
    const publicReference = (await Promise.all([cs2, historical, direct])).flat();
    const seen = new Set(quotes.map(quote => bookmakerKey(quote.book)));
    const unique = publicReference.filter(quote => {
      const book = bookmakerKey(quote.book);
      if (seen.has(book)) return false;
      seen.add(book);
      return true;
    });
    if (unique.length) bookmakers.publicReference = unique;
  }
  // An on-demand bookmaker observation may be created during this call. Read
  // CLOB afterwards so its observation can actually fall inside that window.
  const polymarket = await host.readOfficialBook(target, signal) as LookupBook;
  return { target, market, targetRow, polymarket, bookmakers } satisfies LookupInput;
}

export function createMarketOddsLookupTool(host: LookupHost) {
  return defineTool({
    name: 'lookup_market_odds',
    description: '用于只看两边报价、对照书商赔率和买卖五档的请求。读取官方 CLOB 与 Polymonitor 同盘口赔率，直接使用 reply，包含赛事匹配和时间说明。',
    parameters: { market: { ...required, description: 'Polymarket 市场链接、精确 slug 或本地 ID。' },
      option: { ...required, description: '市场上的准确选项标签或完整选项 token ID。' } },
    output,
    async execute({ market, option }, { signal }) {
      const result = await readMarketOdds(host, market, option, signal);
      if (!result.target) return JSON.stringify(result);
      const { target, polymarket, bookmakers, targetRow } = result;
      const { marketId, conditionId, slug, title, tokenId, option: selection } = target;
      return JSON.stringify({ market: { marketId, conditionId, slug, title, tokenId, option: selection },
        marketEvidenceId: targetRow.evidenceId, polymarket, bookmakers, reply: marketOddsReply(target, polymarket, bookmakers) });
    },
  });
}

// Saved v1 forecasts still replay against their original board evidence.
type BoardInput = { scope?: Scope; pages: { retrievedAt: string; fixtures: Fixture[] }[]; mappingStates: Record<string, number>;
  inventory: number | null; filteredFixtures: number | null; scannedFixtures: number; nextOffset: number | null;
  error: string | null; issues: string[]; coverage: 'unavailable' | 'partial' | 'complete' };
type RuleInput = { valid: boolean; hash: string | null; version: string | null; issue: string | null; refs: string[] };
type BookInput = { marketId?: number; localMarketId?: number; bookStatus?: string; fallbackReason?: string } & Parameters<typeof qualifiedBook>[0];
type ForecastInput = { target: Target; market: Market; rules: RuleInput; board: BoardInput; pm: EvidenceRow | undefined;
  pmError?: string; asOf: string };

function validateRules(market: Market, raw: EvidenceRow, ref: string | undefined, load: Host['loadEvidence']): RuleInput {
  const hash = market.rules?.trim() ? digest(market.rules) : null;
  const result = { hash, version: hash, valid: !!hash && !market.truncated && !market.hasMore,
    issue: null as string | null, refs: [raw.evidenceId] };
  if (!result.valid) result.issue = 'pm_rule_text_missing_or_incomplete';
  if (!ref || ref === raw.evidenceId) return result;
  const row = load(ref);
  const card = row?.data as RuleCard | undefined;
  if (row?.source === 'market-data/research/resolve') {
    const saved = row.data as Market;
    return { ...result, refs: [...result.refs, ref], valid: result.valid && saved.conditionId === market.conditionId && saved.rules === market.rules,
      issue: saved.conditionId !== market.conditionId || saved.rules !== market.rules ? 'pm_rule_evidence_identity_or_version_mismatch' : result.issue };
  }
  const cardRefs = card?.kind === 'rule_card' && Array.isArray(card.inputEvidenceIds) ? card.inputEvidenceIds : [];
  if (row?.source !== 'personal-agent/research' || card?.kind !== 'rule_card' || card.market.conditionId !== market.conditionId
      || card.market.localMarketId !== market.localMarketId || !cardRefs.length || cardRefs.some(id => !load(id))
      || card.rules.capturedText !== market.rules || card.rules.incomplete || card.rules.clarifications.length) {
    return { ...result, refs: row ? [...result.refs, ref, ...cardRefs] : result.refs, valid: false,
      issue: 'pm_rule_evidence_identity_version_or_clarification_unverified' };
  }
  return { ...result, refs: [...result.refs, ref, ...cardRefs] };
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
}

function adaptiveWeights(probabilities: number[], center: number, book: NonNullable<LookupBook['result']>, policy: typeof referencePolicy.blend) {
  // These are current quote-quality proxies, not fitted forecast errors.
  const sportsbookDeviation = probabilities.reduce((total, p) => total + Math.abs(p - center), 0) / probabilities.length;
  const sportsbookUncertainty = Math.hypot(sportsbookDeviation,
    policy.baseUncertainty * Math.sqrt(1 + policy.smallSamplePenalty / probabilities.length));
  const { bids, asks } = topFive(book);
  const volume = (levels: typeof bids) => levels.reduce((total, level) => total + level.size, 0);
  const pmFilledShares = Math.min(policy.depthShares, volume(bids), volume(asks));
  const averagePrice = (levels: typeof bids, bestPrice: number) => {
    if (!pmFilledShares) return bestPrice;
    let remaining = pmFilledShares;
    let value = 0;
    for (const { price, size } of levels) {
      const shares = Math.min(remaining, size);
      value += shares * price;
      remaining -= shares;
    }
    return value / pmFilledShares;
  };
  const pmEffectiveBid = averagePrice(bids, book.bestBid!);
  const pmEffectiveAsk = averagePrice(asks, book.bestAsk!);
  const pmHalfSpread = (pmEffectiveAsk - pmEffectiveBid) / 2;
  const pmUncertainty = Math.hypot(policy.baseUncertainty, pmHalfSpread,
    policy.unfilledDepthPenalty * (1 - pmFilledShares / policy.depthShares));
  const rawWeight = pmUncertainty ** 2 / (sportsbookUncertainty ** 2 + pmUncertainty ** 2);
  const sportsbookWeight = Math.max(policy.minWeight, Math.min(1 - policy.minWeight, rawWeight));
  return { sportsbookWeight, polymarketWeight: 1 - sportsbookWeight, sportsbookDeviation, sportsbookUncertainty,
    pmUncertainty, pmEffectiveBid, pmEffectiveAsk, pmFilledShares, pmDepthTargetShares: policy.depthShares };
}

type QuoteWindow = { at: number; until: number; basis: 'collected_snapshot' | 'market_group_confirmation' };
function quoteWindow(quote: LookupQuote, received: number, now: number): QuoteWindow | null {
  if (!(received <= now) || quote.sourceUpdatedAt && !(Date.parse(quote.sourceUpdatedAt) <= received)) return null;
  if (quote.provider === 'moviodds' && quote.sampleTier === 'stream' && quote.groupId) {
    const at = Date.parse(quote.sourceCheckedAt ?? '');
    const until = Math.min(Date.parse(quote.streamValidUntil ?? ''), at + 1000 * referencePolicy.externalMaxAgeSeconds);
    return at <= received && now <= until ? { at, until, basis: 'market_group_confirmation' } : null;
  }
  const snapshot = quote.sourceSnapshot;
  if (!snapshot?.id || !quote.sourceRevision || quote.sampleTier === 'daily-sample'
      || !(snapshot.cadenceSeconds > 0 && snapshot.staleAfterSeconds >= snapshot.cadenceSeconds)) return null;
  const until = received + 1000 * snapshot.staleAfterSeconds;
  return now <= until ? { at: received, until, basis: 'collected_snapshot' } : null;
}

export function estimateMarketOdds(input: LookupInput, rules: RuleInput, asOf: string,
                                   method: ReferencePolicy = referencePolicy,
                                   forecastKeyVersion: 1 | 2 = 2) {
  const { target, market, bookmakers, polymarket } = input;
  const cadenceAware = method.method !== referencePolicyV2.method;
  const now = Date.parse(asOf);
  const match = bookmakers.market;
  const book = polymarket.result;
  const pmObservedAt = cadenceAware && book?.directlyObservedAt || book?.sourceTime;
  const bookAge = age(now, pmObservedAt);
  const kickoff = Date.parse(bookmakers.event?.scheduledStartTime ?? '');
  const beforeKickoff = kickoff > now;
  const eligibleMarket = match?.period === 'full' && (match.type === 'h2h'
    || ['spreads', 'totals', 'player_totals'].includes(match.type) && Math.abs(Number(match.line) % 1) === .5);
  const decisiveWinner = 'fullWinnerSettlement' in method && match?.period === 'full' && match.type === 'h2h'
    && (bookmakers.event?.sport === 'nfl' && match.ruleFacts?.overtime === 'included'
      || match.metric === 'series' && (bookmakers.event?.bestOf ?? 0) > 0);
  const standardSettlement = 'settlementFallback' in method && rules.valid && match?.rulesHash === rules.hash
    && (bookmakers.event?.sport === 'nba' && match.ruleFacts?.overtime === 'included' && ['h2h', 'spreads', 'totals'].includes(match.type)
      || bookmakers.event?.sport === 'soccer' && match.type === 'h2h' && !!match.predicate && match.ruleFacts?.overtime === 'regulation'
      || decisiveWinner);
  const groups = new Map<string, { quote: LookupQuote; probability: number; sourceTime: string | null;
    sourceAge: number | null; orderTime: number; normalRulesVerified: boolean; window?: QuoteWindow | null }[]>();
  const conflictingBooks: string[] = [];
  const rejected: Record<string, number> = {};
  const rejectedQuotes = new Map<LookupQuote, string>();
  for (const quote of bookmakers.status === 'matched' && eligibleMarket && beforeKickoff ? bookmakers.quotes ?? [] : []) {
    const { ruleCheck, outcomes } = quote;
    const scenarios = (ruleCheck.scenarios ?? []) as { case: string }[];
    const normalConflict = ruleCheck.normalOutcomeStatus === 'conflict' || ruleCheck.status === 'conflict'
      && (!scenarios.length || scenarios.some(s => s.case !== 'postponement_or_no_result'));
    const selected = outcomes.filter(o => o.matchesOption);
    const complete = outcomes.length === (match?.predicate ? 3 : 2) && selected.length > 0 && selected.length < outcomes.length
      && new Set(outcomes.map(o => labelKey(o.name))).size === outcomes.length
      && outcomes.every(o => Number.isFinite(o.decimal) && o.decimal > 1);
    const reason = normalConflict ? 'normal_outcome_rule_conflict' : !complete ? 'incomplete_odds'
      : quote.sourceStale || quote.sourceError ? 'source_stale_or_failed'
        : quote.fixture.inPlay || quote.phase && quote.phase !== 'prematch' && quote.phase !== 'unknown' ? 'quote_not_prematch' : null;
    if (reason) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      rejectedQuotes.set(quote, reason);
      continue;
    }
    const total = outcomes.reduce((sum, o) => sum + 1 / o.decimal, 0);
    const probability = selected.reduce((sum, o) => sum + 1 / o.decimal, 0) / total;
    const confirmed = quote.provider === 'moviodds' && quote.sampleTier === 'stream' && quote.groupId
      && Date.parse(quote.streamValidUntil ?? '') > now;
    const clock = !cadenceAware && confirmed && quote.sourceCheckedAt ? quote.sourceCheckedAt : quote.sourceUpdatedAt;
    const observed = Date.parse(clock ?? '');
    const received = Date.parse(quote.receivedAt ?? '');
    const sourceTime = clock && observed <= received && received <= now ? clock : null;
    const id = groupKey(quote.book);
    const normalRulesVerified = rules.valid && match?.rulesHash === rules.hash
      && (ruleCheck.normalOutcomeStatus === 'aligned' || ruleCheck.status === 'compatible')
      && Boolean(ruleCheck.version && ruleCheck.evidence?.length && ruleCheck.evidence.every(e =>
        e.id && e.revision && e.current !== false && age(now, e.checkedAt) >= 0));
    const window = cadenceAware ? quoteWindow(quote, received, now) : undefined;
    const row = { quote, probability, sourceTime, sourceAge: sourceTime ? age(now, sourceTime) : null,
      orderTime: window?.at ?? (sourceTime ? observed : (Number.isFinite(received) && received <= now ? received : 0)),
      normalRulesVerified, ...(cadenceAware ? { window } : {}) };
    groups.set(id, [...groups.get(id) ?? [], row]);
  }
  const books = [...groups].flatMap(([id, rows]) => {
    rows.sort((a, b) => ('fullWinnerSettlement' in method ? Number(Boolean(b.window)) - Number(Boolean(a.window)) : 0)
      || b.orderTime - a.orderTime || Number(Boolean(b.sourceTime)) - Number(Boolean(a.sourceTime))
      || a.quote.provider.localeCompare(b.quote.provider));
    const first = rows[0];
    const outcomes = (row: typeof first) => digest(row.quote.outcomes.toSorted((a, b) => a.name.localeCompare(b.name))
      .map(({ name, decimal, point, matchesOption }) => ({ name, decimal, point, matchesOption })));
    if (rows.some(row => row.orderTime === first.orderTime && outcomes(row) !== outcomes(first))) {
      conflictingBooks.push(id);
      return [];
    }
    return [first];
  });
  const probabilities = books.map(b => b.probability);
  const currentBooks = books.filter(row => cadenceAware ? row.window
    : row.sourceAge !== null && row.sourceAge <= method.externalMaxAgeSeconds);
  const reference = probabilities.length ? { probability: median(probabilities), min: Math.min(...probabilities),
    max: Math.max(...probabilities), bookCount: probabilities.length,
    unknownSourceTimeCount: books.filter(row => row.sourceAge === null).length,
    olderSourceTimeCount: books.filter(row => row.sourceAge !== null && row.sourceAge > method.externalMaxAgeSeconds).length,
    ...(cadenceAware ? { withinSourceWindowCount: currentBooks.length } : {}) } : null;
  const pmGap = !book || book.bookShape !== 'two_sided' || book.bestBid === null || book.bestAsk === null
    ? 'Polymarket 缺少有效的双边盘口'
    : !(market.active === true && market.closed === false && market.acceptingOrders === true) ? 'Polymarket 市场未确认可交易'
    : !((cadenceAware && book.directlyObservedAt || book.timestampStatus === 'within_30s')
      && bookAge >= 0 && bookAge <= method.pmMaxAgeSeconds) ? 'Polymarket 盘口时点未通过时效核验'
    : !(book.bestAsk - book.bestBid <= method.maxPmSpread) ? 'Polymarket 盘口买卖点差过大' : null;
  const pmMidpoint = pmGap === null ? (book!.bestAsk! + book!.bestBid!) / 2 : null;
  const timestamp = Date.parse(pmObservedAt ?? '');
  const combineSettlementGroups = 'settlementSelection' in method;
  const verifiedBooks = currentBooks.filter(row => row.normalRulesVerified);
  const canAssume = (row: typeof books[number]) => standardSettlement && row.quote.category === 'sportsbook'
    && (combineSettlementGroups || row.quote.ruleCheck.status === 'unknown' && !!row.quote.ruleCheck.reasons?.some(reason =>
      ['bookmaker_rules_unavailable', 'bookmaker_rule_evidence_stale_or_failed'].includes(reason)));
  const overlaps = (row: typeof books[number]) => row.window ? timestamp >= row.window.at && timestamp <= row.window.until
    : Math.abs(timestamp - Date.parse(row.sourceTime!)) <= 1000 * method.maxAlignmentSeconds;
  const alignedVerified = verifiedBooks.filter(overlaps);
  const ruleEligibleBooks = currentBooks.filter(row => row.normalRulesVerified || canAssume(row));
  const aligned = !combineSettlementGroups && alignedVerified.length >= method.minSportsbooks
    ? alignedVerified : ruleEligibleBooks.filter(overlaps);
  const assumedBooks = aligned.filter(row => !row.normalRulesVerified).map(row => row.quote.book);
  const clocks = [timestamp, ...aligned.map(row => row.window?.at ?? Date.parse(row.sourceTime!))];
  const alignmentSeconds = (Math.max(...clocks) - Math.min(...clocks)) / 1000;
  const clocksAligned = aligned.length >= method.minSportsbooks && (cadenceAware || alignmentSeconds <= method.maxAlignmentSeconds);
  const conditionalGaps = [
    ...(!reference ? ['no_bookmaker_reference'] : []),
    ...(pmMidpoint === null ? ['official_book_unqualified'] : []),
    ...(currentBooks.length < method.minSportsbooks ? ['fewer_than_two_current_prematch_books'] : []),
    ...(currentBooks.length >= method.minSportsbooks && ruleEligibleBooks.length < method.minSportsbooks ? ['normal_outcome_rules_unverified'] : []),
    ...(pmMidpoint !== null && ruleEligibleBooks.length >= method.minSportsbooks && !clocksAligned
      ? ['source_times_not_aligned'] : []),
  ];
  const alignedProbabilities = aligned.map(row => row.probability);
  const sportsbookProbability = clocksAligned ? median(alignedProbabilities) : null;
  const weights = 'blend' in method && pmMidpoint !== null && sportsbookProbability !== null
    ? adaptiveWeights(alignedProbabilities, sportsbookProbability, book!, method.blend) : undefined;
  const sportsbookWeight = weights?.sportsbookWeight ?? method.alpha;
  const conditional = pmMidpoint !== null && sportsbookProbability !== null
    ? { probability: sportsbookWeight * sportsbookProbability + (1 - sportsbookWeight) * pmMidpoint,
      sportsbookProbability, pmMidpoint, alignmentSeconds, books: aligned.map(row => row.quote.book),
      ...(weights ? { weights, equalWeightProbability: (sportsbookProbability + pmMidpoint) / 2 } : {}),
      ...(assumedBooks.length ? { assumedBooks } : {}),
      assumption: 'game_completed_normally', usesPolymarketPrice: true } : null;
  const defaultForecast = pmMidpoint !== null && beforeKickoff && (conditional || 'fullWinnerSettlement' in method)
    && 'nbaMoneylineDefault' in method && bookmakers.event?.sport === 'nba' && match?.type === 'h2h'
    ? { method: method.nbaMoneylineDefault, probability: pmMidpoint } : undefined;
  const referenceGap = bookmakers.status !== 'matched' ? null : !eligibleMarket ? 'unsupported_line_or_market'
    : !beforeKickoff ? 'not_prematch' : null;
  const retained = new Map(books.map(row => [row.quote, row]));
  const current = new Set(currentBooks.map(row => row.quote));
  const ruleEligible = new Set(ruleEligibleBooks.map(row => row.quote));
  const overlapping = new Set(aligned.map(row => row.quote));
  const quoteChecks = (bookmakers.quotes ?? []).map((quote): QuoteCheck => {
    const row = retained.get(quote);
    if (!row) return { status: 'excluded', reason: referenceGap ?? rejectedQuotes.get(quote)
      ?? (conflictingBooks.includes(groupKey(quote.book)) ? 'same_book_same_time_conflict' : 'duplicate_bookmaker_quote') };
    const ruleRejected = 'fullWinnerSettlement' in method ? !ruleEligible.has(quote) : !row.normalRulesVerified && !overlapping.has(quote);
    const reason = !current.has(quote) ? 'quote_window_unqualified' : ruleRejected ? 'rule_not_verified'
      : pmMidpoint === null ? 'official_book_unqualified' : !overlapping.has(quote) ? 'quote_time_not_aligned'
        : !conditional ? 'fusion_requirements_unmet' : undefined;
    return { status: reason ? 'reference' : 'fusion', reason, probability: row.probability, until: row.window?.until };
  });
  const snapshotIdentity = [target.conditionId, target.tokenId, method, rules.version, bookmakers.status, match?.rulesHash];
  const forecastKey = forecastKeyVersion === 1 ? digest([...snapshotIdentity,
    books.map(row => [row.quote.book, row.quote.provider, row.sourceTime, row.quote.receivedAt, row.quote.outcomes, row.quote.ruleCheck,
      ...(cadenceAware ? [row.window] : [])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    book?.sourceTime, book?.bestBid, book?.bestAsk, conditional, ...(cadenceAware ? [pmObservedAt] : [])])
    // Repeat HTTP reads can re-confirm one official book version. Use the source observation
    // and qualification result here, while retaining the original receipt and observation time.
    : digest([forecastKeyVersion, ...snapshotIdentity, match?.line, match?.period, match?.type, match?.predicate,
      bookmakers.reason, reference, referenceGap, conditionalGaps, rejected, conflictingBooks.toSorted(), Boolean(bookmakers.truncated),
      books.toSorted((a, b) => a.quote.book.localeCompare(b.quote.book)).map(row => [row.quote, row.window, row.normalRulesVerified]),
      polymarket.status, polymarket.reason, book?.sourceTime, book?.bookShape, book?.bestBid, book?.bestAsk, pmMidpoint,
      conditional && [conditional.probability, conditional.sportsbookProbability, conditional.books.toSorted()],
      ...('blend' in method ? [topFive(book), weights ?? null] : []),
      ...(bookmakers.diagnostics ? [bookmakers.diagnostics] : []),
      ...(bookmakers.publicReference ? [bookmakers.publicReference.map(({ evidenceId, ...quote }) => quote)] : [])]);
  const modelProbability = conditional?.probability ?? null;
  const pmBestAsk = book?.bestAsk ?? null;
  return { target, asOf, forecastKey, forecastKeyVersion, method, calibrationStatus: 'baseline_uncalibrated' as const,
    status: conditional ? 'conditional_reference' as const : reference ? 'sportsbook_reference' as const : 'insufficient_data' as const,
    reference, conditional, defaultForecast, conditionalGaps, pmMidpoint, pmBestAsk, pmGap, books, quoteChecks, event: bookmakers.event, pmRuleVersion: rules.version,
    modelMinusPmMidpoint: conditional ? conditional.probability - conditional.pmMidpoint : null,
    modelMinusBestAsk: modelProbability !== null && pmBestAsk !== null ? modelProbability - pmBestAsk : null,
    differenceUnits: 'decimal probability (multiply by 100 for percentage points)',
    bookmakerStatus: bookmakers.status, sampleTruncated: Boolean(bookmakers.truncated), rejected, conflictingBooks, referenceGap };
}

type MarketEstimate = ReturnType<typeof estimateMarketOdds>;
function forecastConclusion(probability: number | null, gaps: string[], assumedCount = 0) {
  return probability === null ? `**融合值未生成**。${gaps.length ? `${gaps.map(gap => oddsReasons[gap] ?? gap).join('、')}。` : ''}`
    : `**正常完赛条件融合概率${assumedCount ? `（${assumedCount} 家按常规全场口径）` : ''} ${oddsPercent(probability)}**`;
}

function priceShape(f: Fixture, m: Match, q: Quote) {
  if (q.market !== m.type || q.period !== m.period || m.period !== 'full'
      || (q.metric && q.metric !== m.metric) || (games.includes(f.sport) && q.market !== 'h2h' && !q.metric)) return 'different_market_period_or_metric';
  if (!Array.isArray(q.outcomes) || q.outcomes.length !== (m.predicate ? 3 : 2)
      || q.outcomes.some(o => typeof o?.name !== 'string' || !o.name.trim() || !Number.isFinite(o.decimal) || o.decimal <= 1)
      || new Set(q.outcomes.map(o => labelKey(o.name))).size !== q.outcomes.length) return 'invalid_or_incomplete_outcomes';
  if (m.type === 'h2h') return q.outcomes.every(o => o.point === null) ? null : 'unexpected_winner_line';
  if (!['spreads', 'totals', 'player_totals'].includes(m.type)) return 'unsupported_market_type';
  const line = Number(m.line);
  if (m.line === null || !m.line.trim() || !Number.isFinite(line) || Math.abs(line % 1) !== .5) return 'push_or_partial_payout_unsupported';
  if (m.type === 'spreads') {
    if (q.outcomes.some(o => typeof o.point !== 'number') || !q.outcomes.some(o => o.point === line)
        || !q.outcomes.some(o => o.point === -line)) return 'different_line';
  } else if (q.outcomes.some(o => o.point !== line)) return 'different_line';
  return null;
}

type QuoteDecision = ReturnType<typeof inspectQuote>;
function inspectQuote(f: Fixture, m: Match, q: Quote, target: Target, rules: RuleInput, now: number) {
  const reasons: string[] = [];
  // MoviOdds explicitly confirms a whole group on the synchronized stream.
  // A general heartbeat, request time or board generation is never a quote clock.
  const stream = q.provider === 'moviodds' && q.sampleTier === 'stream';
  const confirmed = stream && q.groupId && q.sourceCheckedAt && q.sourceStale === false;
  const sourceObservedAt = confirmed ? q.sourceCheckedAt : q.sourceUpdatedAt;
  const sourceAge = age(now, sourceObservedAt);
  const receivedAge = age(now, q.receivedAt);
  const kickoff = Date.parse(f.startTime);
  const shape = priceShape(f, m, q);
  const sportsbook = q.category === 'sportsbook' && !/^(polymarket|kalshi|betfair|matchbook|novig|prophetx|sxbet|4casters)/.test(groupKey(q.book));
  if (!sportsbook) reasons.push('not_external_sportsbook');
  if (shape) reasons.push(shape);
  const entries = shape || !sportsbook ? [] : (m.books ?? []).filter(b => b.book === q.book && b.provider === q.provider
    && b.pairs.length === q.outcomes.length && new Set(b.pairs.map(p => p.selection)).size === q.outcomes.length
    && new Set(b.pairs.map(p => p.tokenId)).size === target.tokens.length && b.pairs.every(p => target.tokens.includes(p.tokenId)
      && q.outcomes.some(o => o.name === p.selection)) && (!m.predicate || q.outcomes.some(o => groupKey(o.name) === 'draw')));
  const handicapToken = m.type === 'spreads' && m.handicapTeam
    ? m.outcomes.find(o => labelKey(o.label) === labelKey(m.handicapTeam!))?.tokenId : undefined;
  const mapped = entries.filter(b => m.type !== 'spreads' || (handicapToken && b.pairs.every(p =>
    q.outcomes.find(o => o.name === p.selection)?.point === (p.tokenId === handicapToken ? Number(m.line) : -Number(m.line)))));
  const candidate = mapped[0];
  const ambiguous = mapped.some(b => digest(b) !== digest(candidate));
  if (!candidate || ambiguous) reasons.push(ambiguous ? 'ambiguous_selection_mapping' : 'no_exact_selection_mapping');
  const ruleCheck = candidate?.ruleCheck;
  const strongRuleEvidence = ruleCheck?.version && ruleCheck.evidence?.length && ruleCheck.evidence.every(e =>
    e.id && e.revision && age(now, e.checkedAt) >= 0);
  const ruleStatus = rules.valid && m.rulesHash === rules.hash && ruleCheck?.status === 'conflict' ? 'conflict' as const
    : rules.valid && m.rulesHash === rules.hash && ruleCheck?.status === 'compatible' && strongRuleEvidence
      ? 'compatible' as const : 'unknown' as const;
  if (candidate && ruleStatus !== 'compatible') reasons.push(ruleStatus === 'conflict' ? 'settlement_conflict' : 'settlement_unverified');
  if (candidate && m.rulesHash !== rules.hash) reasons.push('pm_rules_version_mismatch');
  if (q.sourceStale || q.sourceError || q.suspended) reasons.push('source_stale_failed_or_suspended');
  if (stream && !(Date.parse(q.streamValidUntil ?? '') > now)) reasons.push('source_stream_lease_expired_or_missing');
  if (!Number.isFinite(sourceAge)) reasons.push('source_quote_time_unknown');
  else if (sourceAge < 0 || age(now, q.sourceUpdatedAt) < 0) reasons.push('source_quote_time_future');
  else if (sourceAge > policy.externalMaxAgeSeconds) reasons.push('source_quote_too_old');
  if (!(receivedAge >= 0) || receivedAge > sourceAge) reasons.push('source_receipt_missing_or_inconsistent');
  if (!(kickoff > now) || f.inPlay === true || q.phase && q.phase !== 'prematch') reasons.push('phase_not_verified_prematch');
  const total = !shape && sportsbook ? q.outcomes.reduce((sum, o) => sum + 1 / o.decimal, 0) : 0;
  const normalized = total > 0 && Number.isFinite(q.overround) && Math.abs(total - 1 - q.overround) < 1e-9
    && q.outcomes.every(o => Number.isFinite(o.probability) && Math.abs(o.probability - 1 / o.decimal / total) < 1e-9);
  if (total > 0 && !normalized) reasons.push('invalid_normalization');
  const probability = candidate && !ambiguous && normalized ? candidate.pairs.filter(p => p.tokenId === target.tokenId)
    .reduce((sum, p) => sum + q.outcomes.find(o => o.name === p.selection)!.probability, 0) : null;
  const verifiedAt = f.polymarketMatch.verifiedAt ?? f.polymarketMatch.checkedAt ?? NaN;
  const mappingAge = now / 1000 - verifiedAt;
  if (f.polymarketMatch.state !== 'linked' || !f.polymarketMatch.version || !f.polymarketMatch.pmEventId
      || f.polymarketMatch.stale !== false || !(mappingAge >= 0 && mappingAge <= policy.maxMappingAgeSeconds)) reasons.push('event_mapping_unverified_or_stale');
  return { fixtureId: f.id, eventId: f.polymarketMatch.pmEventId, mappingVersion: f.polymarketMatch.version,
    mappingCheckedAt: Number.isFinite(verifiedAt) ? new Date(verifiedAt * 1000).toISOString() : null,
    ruleStatus, ruleCheck, pairs: candidate?.pairs, probability, quote: q, sourceObservedAt,
    observationBasis: confirmed ? 'market_group_confirmation' : 'source_quote_update', sourceAgeSeconds: nullable(sourceAge), reasons };
}

function quoteValues(row: QuoteDecision) {
  return row.quote.outcomes.map(o => [o.name, o.decimal, o.point]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

export function forecastOdds(input: ForecastInput) {
  const { target, market, rules, board, pm, pmError, asOf } = input;
  const now = Date.parse(asOf);
  const fixtures = board.pages.flatMap(p => p.fixtures);
  const exact = fixtures.flatMap(f => f.polymarketMatch.markets.filter(m => m.marketId === String(target.marketId)
    && m.conditionId === target.conditionId && m.outcomes.length === 2 && new Set(m.outcomes.map(o => o.tokenId)).size === 2
    && m.outcomes.every(o => target.tokens.includes(o.tokenId))).map(m => ({ f, m })));
  const events = new Set(exact.map(({ f }) => f.polymarketMatch.pmEventId).filter(Boolean));
  const semantics = new Set(exact.map(({ m, f }) => digest([f.sport, m.type, m.metric, m.period, m.line, m.predicate ?? null])));
  const mapping = events.size > 1 || semantics.size > 1 ? 'ambiguous' : exact.length ? 'exact'
    : board.scope ? 'unmatched' : 'unsupported';
  const pmData = pm?.data as BookInput | undefined;
  const book = qualifiedBook(pmData ?? {}, target.tokenId, asOf);
  const bookTime = Date.parse(book.observedAt ?? '');
  const pmReasons: string[] = [];
  if (pmError) pmReasons.push(`pm_book_request_failed:${pmError}`);
  if (market.active !== true || market.closed !== false || market.acceptingOrders !== true) pmReasons.push('pm_trading_state_not_open');
  if ((pmData?.localMarketId ?? pmData?.marketId) !== target.marketId || ![pmData?.yes, pmData?.no].some(s => s?.tokenId === target.tokenId))
    pmReasons.push('pm_market_or_token_not_verified');
  if (book.status !== 'covered') pmReasons.push(`pm_book_${book.sourceStatus}_or_time_unqualified`);
  if (book.status === 'covered' && (book.bestBid === undefined || book.bestAsk === undefined)) pmReasons.push('pm_missing_bid_or_ask');
  if (book.status === 'covered' && (book.spread ?? 0) > policy.maxPmSpread) pmReasons.push('pm_spread_over_limit');
  if (!(age(now, pm?.retrievedAt) >= 0) || Date.parse(pm?.retrievedAt ?? '') < bookTime) pmReasons.push('pm_receipt_time_unverified');
  const { bids: _bids, asks: _asks, ...bookSummary } = book.status === 'covered' ? book : { ...book, bids: undefined, asks: undefined };
  const midpoint = !pmReasons.length && book.status === 'covered' ? (book.bestBid! + book.bestAsk!) / 2 : null;
  const decisions = exact.flatMap(({ f, m }) => f.quotes.map(q => inspectQuote(f, m, q, target, rules, now)));
  const byBook = new Map<string, QuoteDecision[]>();
  for (const row of decisions) {
    if (midpoint !== null && Math.abs(Date.parse(row.sourceObservedAt ?? '') - bookTime) > 1000 * policy.maxAlignmentSeconds)
      row.reasons.push('pm_external_time_misaligned');
    if (mapping !== 'exact') row.reasons.push('ambiguous_target_mapping');
    if (row.probability === null || !(row.sourceAgeSeconds !== null && row.sourceAgeSeconds >= 0)) continue;
    const id = groupKey(row.quote.book);
    byBook.set(id, [...byBook.get(id) ?? [], row]);
  }
  const used = [...byBook].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, candidates]) => {
    candidates.sort((a, b) => Date.parse(b.sourceObservedAt!) - Date.parse(a.sourceObservedAt!)
      || a.quote.provider.localeCompare(b.quote.provider) || a.fixtureId.localeCompare(b.fixtureId));
    const latest = candidates[0];
    const sameTime = candidates.filter(q => Date.parse(q.sourceObservedAt!) === Date.parse(latest.sourceObservedAt!));
    const conflict = sameTime.some(q => digest([quoteValues(q), q.pairs?.slice().sort((a, b) => a.selection.localeCompare(b.selection))])
      !== digest([quoteValues(latest), latest.pairs?.slice().sort((a, b) => a.selection.localeCompare(b.selection))]));
    for (const q of candidates) if (q !== latest || conflict) q.reasons.push(conflict && sameTime.includes(q)
      ? 'same_book_same_time_conflict' : 'duplicate_bookmaker_quote');
    return conflict || latest.reasons.length ? [] : [latest];
  });
  const times = used.map(row => Date.parse(row.sourceObservedAt!));
  if (midpoint !== null) times.push(bookTime);
  const alignmentSeconds = times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : null;
  const external = used.length ? used.reduce((sum, q) => sum + q.probability!, 0) / used.length : null;
  const gaps = [...board.issues, ...pmReasons];
  if (rules.issue) gaps.push(rules.issue);
  if (!board.scope) gaps.push('no_supported_external_source_for_market_domain');
  else if (mapping !== 'exact') gaps.push(fixtures.length ? 'target_market_has_no_unique_exact_mapping' : 'no_formal_event_link_in_read_scope');
  if (used.length < policy.minSportsbooks) gaps.push('fewer_than_two_qualified_sportsbooks');
  if (alignmentSeconds !== null && alignmentSeconds > policy.maxAlignmentSeconds) gaps.push('observations_exceed_alignment_span');
  // A truncated or shifting scope can hide a newer/contradictory quote for the
  // same book. Require the bounded target search to finish before pooling.
  const incompleteScan = board.issues.some(issue => issue !== 'board_source_gaps');
  const pModel = mapping === 'exact' && !incompleteScan && external !== null && used.length >= policy.minSportsbooks
    && midpoint !== null && alignmentSeconds! <= policy.maxAlignmentSeconds ? policy.alpha * external + (1 - policy.alpha) * midpoint : null;
  const bookSummaryWithUnits = { ...bookSummary, reasons: pmReasons, observationAgeSeconds: nullable(age(now, book.observedAt)), midpoint,
    fallbackReason: pmData?.fallbackReason, catalogPrice: target.catalogPrice, stateObservedAt: market.stateObservedAt,
    catalogQuoteObservedAt: market.quoteObservedAt, catalogQuoteSourceUpdatedAt: market.quoteUpdatedAt,
    units: 'USD per $1 share', depthUnits: 'shares' };
  const distribution = used.map(q => q.probability!);
  const ruleVersions = [...new Set(used.map(q => q.ruleCheck!.version!))].sort();
  const targetBook = [pmData?.yes, pmData?.no].find(row => row?.tokenId === target.tokenId);
  const forecastKey = digest([target.conditionId, target.tokenId, policy, rules.version, ruleVersions,
    exact.map(({ m }) => [m.type, m.period, m.line, m.metric, m.rulesHash]).map(digest).sort(),
    decisions.map(q => digest([q.eventId, q.quote.book, q.quote.provider, q.quote.sourceUpdatedAt, quoteValues(q),
      q.quote.suspended, q.ruleStatus, q.ruleCheck?.version,
      ...(q.observationBasis === 'market_group_confirmation' ? [q.sourceObservedAt] : [])])).sort(),
    market.active, market.closed, market.acceptingOrders, targetBook ?? pmError ?? null]);
  return { target, asOf, forecastKey, method: policy, calibrationStatus: 'baseline_uncalibrated' as const,
    usesPolymarketPrice: true, status: pModel !== null ? 'ready' : !board.scope ? 'unsupported'
      : decisions.some(q => q.probability !== null) ? 'comparison_only' : 'insufficient_data',
    coverage: board.coverage, mapping, mappingStates: board.mappingStates, scope: board.scope, pagesRead: board.pages.length,
    nextOffset: board.nextOffset, inventory: board.inventory, filteredFixtures: board.filteredFixtures, scannedFixtures: board.scannedFixtures,
    boardError: board.error,
    alternativeMarketTypes: !exact.length ? [...new Set(fixtures.flatMap(f => f.quotes.map(q => q.market)))].sort() : [],
    exactFixtures: exact.map(({ f, m }) => ({ id: f.id, providerFixtureIds: f.providerFixtureIds, event: `${f.away} / ${f.home}`,
      competition: f.competition, startTime: f.startTime, type: m.type, period: m.period, metric: m.metric, line: m.line,
      mappingState: f.polymarketMatch.state, mappingStale: f.polymarketMatch.stale, marketCoverage: f.polymarketMatch.marketCoverage })),
    ruleVersion: rules.version, externalRuleVersions: ruleVersions, ruleStatus: used.length ? 'compatible'
      : decisions.some(q => q.ruleStatus === 'conflict') ? 'conflict' : 'unknown',
    timeStatus: midpoint !== null && used.length && alignmentSeconds! <= policy.maxAlignmentSeconds ? 'current'
      : age(now, book.observedAt) > policy.pmMaxAgeSeconds || decisions.some(q => q.reasons.includes('source_quote_too_old')
        || q.reasons.includes('pm_external_time_misaligned')) ? 'stale' : 'unknown',
    alignmentSeconds, externalConsensus: external, externalConsensusBookCount: used.length,
    mappedSportsbookCount: new Set(decisions.filter(q => q.probability !== null).map(q => groupKey(q.quote.book))).size,
    sourceDisagreement: distribution.length ? { min: Math.min(...distribution), max: Math.max(...distribution) } : null,
    pm: bookSummaryWithUnits, modelProbability: pModel,
    modelMinusPmMidpoint: pModel === null ? null : pModel - midpoint!,
    modelMinusBestAsk: pModel === null || book.status !== 'covered' ? null : pModel - book.bestAsk!,
    differenceUnits: 'decimal probability (multiply by 100 for percentage points)', gaps,
    used, excluded: decisions.filter(q => q.reasons.length), author: 'agent',
    limitations: ['Uncalibrated baseline. Sportsbook dependence and de-vig assumptions are unmeasured.',
      'Prematch only. Source update timestamps may represent price changes. Fees and slippage are unavailable.'],
  };
}

type Forecast = ReturnType<typeof forecastOdds>;
function compareOddsForecasts(before: Forecast, after: Forecast) {
  const sameTarget = before.target.conditionId === after.target.conditionId && before.target.tokenId === after.target.tokenId;
  const ruleChanged = before.ruleVersion !== after.ruleVersion || digest(before.externalRuleVersions) !== digest(after.externalRuleVersions);
  const methodChanged = digest(before.method) !== digest(after.method);
  const selection = (forecast: Forecast) => forecast.used.map(q => `${q.quote.book}/${q.quote.provider}`).sort();
  const beforeInputs = selection(before), afterInputs = selection(after);
  const comparable = sameTarget && !ruleChanged && !methodChanged && before.status === 'ready' && after.status === 'ready';
  const describe = (first: number | null, second: number | null) => ({ before: first, after: second,
    delta: comparable && first !== null && second !== null ? second - first : null });
  return { status: comparable ? 'comparable' : 'not_comparable', sameTarget, ruleChanged, methodChanged,
    beforeStatus: before.status, afterStatus: after.status, beforeAsOf: before.asOf, afterAsOf: after.asOf,
    inputSet: { before: beforeInputs, after: afterInputs, changed: digest(beforeInputs) !== digest(afterInputs) },
    externalConsensus: describe(before.externalConsensus, after.externalConsensus), pmMidpoint: describe(before.pm.midpoint, after.pm.midpoint),
    modelProbability: describe(before.modelProbability, after.modelProbability),
    differenceUnits: 'decimal probability (multiply by 100 for percentage points)' };
}

const str = { type: 'string' } as const;
const required = { ...str, required: true } as const;
const output = { schema: str, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

type StoredForecast = { kind: 'odds_forecast'; result: Forecast; targetEvidenceId: string; boardEvidenceId: string;
  pmEvidenceId?: string; pmError?: string; rules: RuleInput; asOf: string; inputEvidenceIds: string[];
  previousForecastEvidenceId?: string };
type StoredEstimate = { kind: 'market_odds_estimate'; result: MarketEstimate; targetEvidenceId: string;
  bookmakers: Pick<LookupQuotes, 'status' | 'reason' | 'evidenceId' | 'retrievedAt' | 'publicReference'>;
  polymarket: LookupBook; rules: RuleInput; inputEvidenceIds: string[]; previousForecastEvidenceId?: string };

function compareEstimates(before: MarketEstimate, after: MarketEstimate) {
  const sameTarget = before.target.conditionId === after.target.conditionId && before.target.tokenId === after.target.tokenId;
  const beforeRules = new Map(before.books.map(b => [b.quote.book, b.quote.ruleCheck.version]));
  const ruleChanged = before.pmRuleVersion !== after.pmRuleVersion
    || after.books.some(b => beforeRules.has(b.quote.book) && beforeRules.get(b.quote.book) !== b.quote.ruleCheck.version);
  const methodChanged = digest(before.method) !== digest(after.method);
  const inputs = (result: MarketEstimate) => result.books.map(b => `${b.quote.book}/${b.quote.provider}`).sort();
  const beforeInputs = inputs(before), afterInputs = inputs(after);
  const inputSet = { before: beforeInputs, after: afterInputs, changed: digest(beforeInputs) !== digest(afterInputs) };
  const beforeConditional = before.conditional?.books.toSorted() ?? [], afterConditional = after.conditional?.books.toSorted() ?? [];
  const conditionalInputSet = { before: beforeConditional, after: afterConditional,
    changed: digest(beforeConditional) !== digest(afterConditional) };
  const comparable = sameTarget && !ruleChanged && !methodChanged && !inputSet.changed && !!before.reference && !!after.reference;
  const describe = (first: number | null, second: number | null, comparable: boolean) => ({ before: first, after: second,
    delta: comparable && first !== null && second !== null ? second - first : null });
  return { status: comparable ? 'comparable' : 'not_comparable', sameTarget, ruleChanged, methodChanged, inputSet, conditionalInputSet,
    sameSnapshot: before.forecastKey === after.forecastKey, beforeStatus: before.status, afterStatus: after.status,
    beforeAsOf: before.asOf, afterAsOf: after.asOf,
    sportsbookReference: describe(before.reference?.probability ?? null, after.reference?.probability ?? null, comparable),
    pmMidpoint: describe(before.pmMidpoint, after.pmMidpoint, comparable),
    conditionalProbability: describe(before.conditional?.probability ?? null, after.conditional?.probability ?? null,
      comparable && !conditionalInputSet.changed),
    differenceUnits: 'decimal probability (multiply by 100 for percentage points)' };
}

function estimateComparisonReply(change: ReturnType<typeof compareEstimates>) {
  const show = (value: number | null, unit: string) => value === null ? '未提供' : `${(value * 100).toFixed(2)}${unit}`;
  const row = (label: string, value: typeof change.pmMidpoint) =>
    `- ${label} ${show(value.before, '%')} → ${show(value.after, '%')}，变化 ${show(value.delta, ' 个百分点')}。`;
  return [
    `**${change.status === 'comparable' ? '两份快照可比' : '两份快照不可比'}**　${oddsTime(change.beforeAsOf)} → ${oddsTime(change.afterAsOf)}（北京时间）。`,
    row('书商赛果参考', change.sportsbookReference),
    row('PM 中间价', change.pmMidpoint),
    row('正常完赛条件融合', change.conditionalProbability),
    `书商样本 ${change.inputSet.before.join('、') || '无'} → ${change.inputSet.after.join('、') || '无'}。`,
    `融合样本 ${change.conditionalInputSet.before.join('、') || '无'} → ${change.conditionalInputSet.after.join('、') || '无'}。`,
    `目标${change.sameTarget ? '相同' : '不同'}，书商样本${change.inputSet.changed ? '变化' : '相同'}，融合使用的书商${change.conditionalInputSet.changed ? '变化' : '相同'}，规则${change.ruleChanged ? '变化' : '相同'}，方法${change.methodChanged ? '变化' : '相同'}。`,
    change.sameSnapshot ? '两次引用同一份快照。' : '变化值只反映这两个已保存时点。',
  ].join('\n\n');
}

function forecastSummary(result: Forecast) {
  const { used, excluded, ...summary } = result;
  const counts: Record<string, number> = {};
  for (const q of excluded) for (const reason of q.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  const percent = (value: number | null) => value === null ? null : Number((value * 100).toFixed(4));
  const mappedExamples = new Map<string, QuoteDecision>();
  for (const row of excluded) if (row.probability !== null && !mappedExamples.has(row.quote.book)) mappedExamples.set(row.quote.book, row);
  return { ...summary, display: { modelPercent: percent(summary.modelProbability), externalPercent: percent(summary.externalConsensus),
    midpointPercent: percent(summary.pm.midpoint), minusMidpointPercentagePoints: percent(summary.modelMinusPmMidpoint),
    minusAskPercentagePoints: percent(summary.modelMinusBestAsk) },
    used: used.map(({ quote, probability, pairs, ruleCheck, fixtureId, mappingVersion, mappingCheckedAt,
      sourceAgeSeconds, sourceObservedAt, observationBasis }) =>
    ({ book: quote.book, provider: quote.provider, sourceUpdatedAt: quote.sourceUpdatedAt, receivedAt: quote.receivedAt,
      decimalOdds: quote.outcomes.map(o => [o.name, o.decimal, o.probability]), overround: quote.overround,
      probability, pairs, ruleCheck, fixtureId, mappingVersion, mappingCheckedAt, sourceAgeSeconds, sourceObservedAt, observationBasis })),
    rejectedQuoteCount: excluded.length, exclusionCounts: counts,
    excludedMappedExamples: [...mappedExamples.values()].slice(0, 4).map(({ quote, probability, pairs, reasons, ruleCheck }) => ({
      book: quote.book, provider: quote.provider, outcomes: quote.outcomes.map(o => ({ selection: o.name,
        decimalOdds: o.decimal, devigPercent: percent(o.probability),
        mapsToTarget: pairs?.some(p => p.selection === o.name && p.tokenId === summary.target.tokenId) ?? false })),
      indicativeDevigPercent: percent(probability), sourceUpdatedAt: quote.sourceUpdatedAt, receivedAt: quote.receivedAt, reasons, ruleCheck })),
    exclusionExamples: [...new Set(excluded.flatMap(q => q.reasons))].slice(0, 16).map(reason => {
      const sample = excluded.find(q => q.reasons.includes(reason))!;
      return { reason, book: sample.quote.book, provider: sample.quote.provider, market: sample.quote.market,
        sourceUpdatedAt: sample.quote.sourceUpdatedAt, sourceAgeSeconds: sample.sourceAgeSeconds, ruleCheck: sample.ruleCheck };
    }) };
}

const inputRefs = (data: StoredForecast) => ({ rules: data.rules.refs, board: data.boardEvidenceId, pmBook: data.pmEvidenceId ?? null });

function forecastEvidenceId(key: string) {
  // UUIDv8 keeps the receipt compatible with evidence links and compaction.
  const variant = (8 | (Number.parseInt(key[16], 16) & 3)).toString(16);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-8${key.slice(13, 16)}-${variant}${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

export function createOddsForecastTools(host: Host) {
  const { loadEvidence, saveEvidence } = host;
  function requireEvidence(id: string) {
    const row = loadEvidence(id);
    if (!row || row.evidenceId !== id) throw new Error(`证据不存在 ${id}`);
    return row;
  }
  function loadForecast(id: string) {
    const row = requireEvidence(id);
    const data = row.data as StoredForecast | StoredEstimate;
    if (row.source !== source || !['odds_forecast', 'market_odds_estimate'].includes(data?.kind)) throw new Error(`需要原始赔率预测证据 ${id}`);
    return { row, data };
  }
  function comparison(before: StoredForecast | StoredEstimate, after: StoredForecast | StoredEstimate) {
    if (before.kind === 'odds_forecast' && after.kind === 'odds_forecast') return compareOddsForecasts(before.result, after.result);
    if (before.kind === 'market_odds_estimate' && after.kind === 'market_odds_estimate') return compareEstimates(before.result, after.result);
    return { status: 'not_comparable', methodChanged: true, beforeMethod: before.result.method.method, afterMethod: after.result.method.method };
  }
  function estimateOutput(data: StoredEstimate, result: MarketEstimate, input: LookupInput, evidenceId: string, mode: string, compared?: string) {
    const { conditional, defaultForecast, referenceGap, conditionalGaps } = result;
    const displayGaps = conditionalGaps.flatMap(gap => {
      if (gap === 'official_book_unqualified') return input.polymarket.status === 'ok' && result.pmGap ? [result.pmGap] : [];
      if (gap === 'no_bookmaker_reference' || gap === 'fewer_than_two_current_prematch_books')
        return input.bookmakers.status === 'matched' && !referenceGap ? [gap] : [];
      return [gap];
    });
    const used = conditional ? result.books.filter(row => conditional.books.includes(row.quote.book)) : [];
    const assumed = used.filter(row => !row.normalRulesVerified);
    const settlementSummary = 'settlementSelection' in result.method && conditional ? [
      `融合使用 ${used.length} 家书商，正常完赛口径已核验 ${used.length - assumed.length} 家。`,
      assumed.length && `按正常完赛口径假设纳入（${assumed.length} 家）${assumed.map(({ quote }) => quote.label || quote.book).join('、')}。`,
    ].filter(Boolean).join('\n') : '';
    const weights = conditional?.weights;
    const modelComparisons = conditional && weights ? {
      dynamicPool: { probability: conditional.probability, sportsbookWeight: weights.sportsbookWeight, polymarketWeight: weights.polymarketWeight },
      linearPool: { probability: (conditional.sportsbookProbability + conditional.pmMidpoint) / 2, sportsbookWeight: .5, polymarketWeight: .5,
        betaCalibration: 'not_fitted', featureWeights: 'not_fitted' },
      depthAdjustedPool: { probability: weights.pmFilledShares > 0
        ? (conditional.sportsbookProbability + (weights.pmEffectiveBid + weights.pmEffectiveAsk) / 2) / 2 : null,
        sportsbookWeight: .5, polymarketWeight: .5, sharesPerSide: weights.pmFilledShares },
    } : undefined;
    const modelLines = modelComparisons ? [
      `- Bates–Granger 思路，动态权重 ${oddsPercent(modelComparisons.dynamicPool.probability)}（书商 ${oddsPercent(modelComparisons.dynamicPool.sportsbookWeight)} / PM ${oddsPercent(modelComparisons.dynamicPool.polymarketWeight)}）`,
      `- Ranjan–Gneiting 线性池 ${oddsPercent(modelComparisons.linearPool.probability)}（书商 50% / PM 50%，Beta 校准与 FFORMA 未用于线上结果）`,
      `- Cont 等启发的盘口深度融合 ${modelComparisons.depthAdjustedPool.probability === null ? '缺少双边可成交深度' : `${oddsPercent(modelComparisons.depthAdjustedPool.probability)}（书商 50% / PM 双边各 ${modelComparisons.depthAdjustedPool.sharesPerSide} 份的均价中点 50%）`}`,
    ] : [];
    const weightReason = weights && [
      `${used.length} 家书商的去水概率平均偏离中位数 ${(100 * weights.sportsbookDeviation).toFixed(2)} 个百分点。`,
      `PM 买卖五档各可覆盖 ${weights.pmFilledShares} / ${weights.pmDepthTargetShares} 份，双边均价差 ${((weights.pmEffectiveAsk - weights.pmEffectiveBid) * 100).toFixed(2)} 美分。`,
      `结合这两项，动态融合${weights.sportsbookWeight === weights.polymarketWeight ? '两边权重相同'
        : `更侧重${weights.sportsbookWeight > weights.polymarketWeight ? '书商' : ' Polymarket'}`}。估计未经历史校准。`,
      !settlementSummary && defaultForecast && conditional?.assumedBooks?.length ? `融合对照含 ${conditional.assumedBooks.length} 家按常规全场口径估计的书商。` : '',
    ].join('');
    const direction = (p: number) => oddsPercent(p) === '50.00%' ? 0 : Math.sign(p - .5);
    const summary = conditional && (() => {
      const bookDirection = direction(conditional.sportsbookProbability);
      const pmDirection = direction(conditional.pmMidpoint);
      const agreement = bookDirection * pmDirection < 0 ? '两边方向相反' : bookDirection === pmDirection
        ? bookDirection === 0 ? '两边均在五成' : bookDirection > 0 ? '两边均看好该选项' : '两边对该选项均低于五成'
        : '一边在五成';
      return `书商对 ${input.target.option} 的去水中位数为 ${oddsPercent(conditional.sportsbookProbability)}，Polymarket 中间价为 ${oddsPercent(conditional.pmMidpoint)}。${agreement}。`;
    })();
    const judgment = conditional ? { market: input.target.title, option: input.target.option, historical: mode === 'snapshot',
      summary,
      sportsbookMedian: oddsPercent(conditional.sportsbookProbability),
      sportsbookInputs: used.map(({ quote, probability }) => ({ book: quote.label || quote.book, provider: quote.provider,
        odds: quote.outcomes.map(({ name, decimal }) => [name, Number(decimal.toFixed(4))]), devig: oddsPercent(probability) })),
      sportsbookRange: [oddsPercent(Math.min(...used.map(row => row.probability))), oddsPercent(Math.max(...used.map(row => row.probability)))],
      sportsbookCount: used.length, pmMidpoint: oddsPercent(conditional.pmMidpoint),
      pmDepth: topFive(input.polymarket.result), calibrationStatus: result.calibrationStatus } : undefined;
    const reply = [
      ...(mode === 'snapshot' ? [`**历史快照 · ${oddsTime(result.asOf)}（北京时间）**`] : []),
      marketOddsReply(input.target, input.polymarket, input.bookmakers),
      ...(compared ? [compared] : []),
    ].join('\n\n');
    return { ...result, mode, evidenceId, inputEvidenceIds: data.inputEvidenceIds, previousForecastEvidenceId: data.previousForecastEvidenceId,
      inputEvidence: { rules: data.rules.refs, bookmakers: data.bookmakers.evidenceId, pmBook: data.polymarket.evidenceId },
      reply, judgment, modelComparisons, diagnostic: conditional ? undefined : { bookmaker: input.bookmakers.status === 'matched' ? undefined : bookmakerGap(input.bookmakers),
        polymarket: result.pmGap ? (input.polymarket.status === 'ok' ? result.pmGap
          : input.polymarket.status === 'empty' ? '官方盘口返回空挂单' : officialBookReply(input.polymarket)) : undefined,
        gaps: [...referenceGap ? [referenceGap] : [], ...displayGaps].map(gap => oddsReasons[gap] ?? gap) },
      conclusion: [weightReason, settlementSummary, modelLines.length && `三种融合结果\n${modelLines.join('\n')}`,
        (!defaultForecast || !conditional) && forecastConclusion(conditional?.probability ?? null,
          [...referenceGap ? [referenceGap] : [], ...displayGaps], settlementSummary ? 0 : conditional?.assumedBooks?.length),
        defaultForecast && `**默认胜率参考（Polymarket 中间价）${oddsPercent(defaultForecast.probability)}**`].filter(Boolean).join('\n\n') };
  }
  function replayEstimate(data: StoredEstimate) {
    const asOf = data.result.asOf;
    const method = [referencePolicy, referencePolicyV7, referencePolicyV6, referencePolicyV5, referencePolicyV4, referencePolicyV3, referencePolicyV2]
      .find(p => digest(data.result.method) === digest(p));
    const keyVersion = data.result.forecastKeyVersion ?? 1;
    if (!method || (keyVersion !== 1 && keyVersion !== 2)
        || data.inputEvidenceIds.some(id => !(Date.parse(requireEvidence(id).retrievedAt) <= Date.parse(asOf))))
      throw new Error('历史估计方法版本或输入取得时间不匹配。');
    const targetRow = requireEvidence(data.targetEvidenceId);
    const market = targetRow.data as Market;
    const target = identify(market, data.result.target.tokenId);
    if (!target) throw new Error('历史市场身份无法复核。');
    const { bookmakers: meta, polymarket } = data;
    const bookmakers = { ...(meta.evidenceId && meta.status !== 'invalid_response'
      ? requireEvidence(meta.evidenceId).data as LookupQuotes : {}), ...meta };
    const input = { target, market, targetRow, bookmakers, polymarket };
    const result = estimateMarketOdds(input, data.rules, asOf, method, keyVersion);
    if (result.forecastKey !== data.result.forecastKey || result.conditional?.probability !== data.result.conditional?.probability)
      throw new Error('历史估计无法按原输入复算。');
    return { input, result };
  }
  function replay(data: StoredForecast) {
    if (data.result.method.method !== policy.method || digest(data.result.method) !== digest(policy)) throw new Error('该预测使用不同方法版本。');
    const board = requireEvidence(data.boardEvidenceId).data as BoardInput;
    for (const id of data.inputEvidenceIds) requireEvidence(id);
    const targetRow = requireEvidence(data.targetEvidenceId);
    const pm = data.pmEvidenceId ? requireEvidence(data.pmEvidenceId) : undefined;
    const cutoff = Date.parse(data.asOf);
    if ([...data.inputEvidenceIds.map(id => requireEvidence(id).retrievedAt), ...board.pages.map(p => p.retrievedAt)]
      .some(time => !(Date.parse(time) <= cutoff))) throw new Error('输入证据取得时间晚于历史截止。');
    const result = forecastOdds({ target: data.result.target, market: targetRow.data as Market,
      rules: data.rules, board, pm, pmError: data.pmError, asOf: data.asOf });
    if (result.forecastKey !== data.result.forecastKey || result.modelProbability !== data.result.modelProbability)
      throw new Error('保存的输入和预测结果无法按原版本复算。');
    return result;
  }
  return [
    defineTool({ name: 'forecast_market_odds', description: '单场比赛赔率或胜率的默认入口，返回书商赔率、官方盘口和完整预测。核心规则与时间对齐时计算正常完赛条件融合。保存证据供复算。用户明确只要原始报价时使用 lookup_market_odds。',
      parameters: { market: { ...str, description: 'Polymarket 市场链接、slug 或 local:ID。事件多市场会返回候选。' },
        option: { ...str, description: '市场的精确选项标签或 token ID。' }, mode: { ...str, enum: ['current', 'snapshot'] },
        rule_evidence_id: str, previous_forecast_evidence_id: str, snapshot_evidence_id: str }, output,
      async execute({ market, option, mode = 'current', rule_evidence_id, previous_forecast_evidence_id, snapshot_evidence_id }, { signal }) {
        if (mode === 'snapshot') {
          if (!snapshot_evidence_id || market || option || rule_evidence_id || previous_forecast_evidence_id)
            throw new Error('历史复算只需 mode=snapshot 和原始预测的 snapshot_evidence_id。');
          const { data } = loadForecast(snapshot_evidence_id);
          if (data.kind === 'market_odds_estimate') {
            const { input, result } = replayEstimate(data);
            return JSON.stringify(estimateOutput(data, result, input, snapshot_evidence_id, mode));
          }
          const result = replay(data);
          const pm = data.pmEvidenceId ? requireEvidence(data.pmEvidenceId).data as BookInput : undefined;
          const book = qualifiedBook(pm ?? {}, result.target.tokenId, result.asOf);
          const quotes = [...new Set([...result.used, ...result.excluded].map(row => bookmakerOdds(row.quote)))];
          const reply = [
            `**历史快照复算 · ${result.target.title} · ${result.target.option}**`,
            `原观测 ${oddsTime(result.asOf)}（北京时间）`,
            `### 书商赔率与来源（十进制）\n${quotes.join('\n') || '暂无同盘口赔率。'}`,
            `### Polymarket 快照盘口（最多五档，价格 × 份数）\n${fiveLevels(book.status === 'covered' ? book : undefined)}`,
          ].join('\n\n');
          const judgment = result.modelProbability !== null && result.externalConsensus !== null && result.pm.midpoint !== null
            ? { market: result.target.title, option: result.target.option, historical: true,
              sportsbookMean: oddsPercent(result.externalConsensus), sportsbookCount: result.used.length,
              sportsbookInputs: result.used.map(({ quote, probability }) => ({ book: quote.label || quote.book,
                provider: quote.provider, odds: quote.outcomes.map(({ name, decimal }) => [name, Number(decimal.toFixed(4))]),
                devig: probability === null ? null : oddsPercent(probability) })),
              pmMidpoint: oddsPercent(result.pm.midpoint), pmDepth: topFive(book.status === 'covered' ? book : undefined),
              calibrationStatus: result.calibrationStatus } : undefined;
          return JSON.stringify({ ...forecastSummary(result), mode, timeStatus: 'historical', originalTimeStatus: result.timeStatus,
            evidenceId: snapshot_evidence_id, inputEvidenceIds: data.inputEvidenceIds, inputEvidence: inputRefs(data),
            reply, judgment, conclusion: forecastConclusion(result.modelProbability, result.gaps) });
        }
        if (!market?.trim() || !option?.trim() || snapshot_evidence_id) throw new Error('当前查询需要市场和精确选项。');
        const previous = previous_forecast_evidence_id ? loadForecast(previous_forecast_evidence_id) : undefined;
        const input = await readMarketOdds(host, market, option, signal);
        if (!input.target) return JSON.stringify(input);
        const { targetRow, bookmakers, polymarket } = input;
        const rules = validateRules(input.market, targetRow, rule_evidence_id, loadEvidence);
        signal.throwIfAborted();
        const asOf = new Date().toISOString();
        const { evidenceId, status, reason, retrievedAt, publicReference } = bookmakers;
        const result = estimateMarketOdds(input, rules, asOf);
        const stored: StoredEstimate = { kind: 'market_odds_estimate', result, targetEvidenceId: targetRow.evidenceId,
          bookmakers: { evidenceId, status, reason, retrievedAt, publicReference }, polymarket, rules,
          inputEvidenceIds: [...new Set([...rules.refs, polymarket.evidenceId, ...evidenceId ? [evidenceId] : [],
            ...publicReference?.map(quote => quote.evidenceId) ?? []])],
          previousForecastEvidenceId: previous?.row.evidenceId };
        const receiptId = forecastEvidenceId(result.forecastKey);
        let existing = loadEvidence(receiptId);
        if (!existing) {
          try { saveEvidence(source, stored, asOf, receiptId); }
          catch (cause) {
            existing = loadEvidence(receiptId);
            if (!existing) throw cause;
          }
        }
        const saved = existing ? loadForecast(receiptId).data : stored;
        if (saved.kind !== 'market_odds_estimate' || saved.result.forecastKey !== result.forecastKey)
          throw new Error('赔率快照证据 ID 冲突。');
        const original = existing ? replayEstimate(saved) : { input, result };
        const change = previous ? comparison(previous.data, saved) : undefined;
        const compared = previous && change ? ('conditionalInputSet' in change
          ? estimateComparisonReply(change) : '两份快照方法版本不同，未计算差值。') : undefined;
        const out = estimateOutput(saved, original.result, original.input, receiptId, mode, compared);
        const current = { ...out, latestCheckedAt: asOf, reusedSnapshot: !!existing };
        return JSON.stringify(previous ? { ...current, previousForecastEvidenceId: previous.row.evidenceId,
          change } : current);
      },
    }),
    defineTool({ name: 'compare_odds_forecasts', description: '按证据 ID 对照已保存的赔率预测，分开报告外部共识、PM 中间价、输入集合、规则和方法变化。',
      parameters: { before_evidence_id: required, after_evidence_id: required }, output,
      async execute({ before_evidence_id, after_evidence_id }) {
        const before = loadForecast(before_evidence_id).data;
        const after = loadForecast(after_evidence_id).data;
        const change = comparison(before, after);
        const reply = 'conditionalInputSet' in change
          ? `**${before.result.target.title} · ${before.result.target.option} → ${after.result.target.title} · ${after.result.target.option}**\n\n${estimateComparisonReply(change)}`
          : 'externalConsensus' in change
            ? [`**旧版预测快照 ${change.status === 'comparable' ? '可比' : '不可比'}**`,
              `预测回执 \`${before_evidence_id}\` → \`${after_evidence_id}\`，${oddsTime(change.beforeAsOf)} → ${oddsTime(change.afterAsOf)}（北京时间）。`,
              ...([['书商参考', change.externalConsensus], ['PM 中间价', change.pmMidpoint], ['融合值', change.modelProbability]] as const)
                .map(([label, v]) => `${label} ${v.before === null ? '无' : oddsPercent(v.before)} → ${v.after === null ? '无' : oddsPercent(v.after)}，变化 ${v.delta === null ? '未提供' : `${(100 * v.delta).toFixed(2)} 个百分点`}。`),
              `书商样本 ${change.inputSet.before.join('、') || '无'} → ${change.inputSet.after.join('、') || '无'}，目标${change.sameTarget ? '相同' : '不同'}，规则${change.ruleChanged ? '变化' : '相同'}，方法${change.methodChanged ? '变化' : '相同'}。`,
            ].join('\n\n')
            : `**两份快照不可比**。\n\n预测回执 \`${before_evidence_id}\` → \`${after_evidence_id}\`，方法 ${before.result.method.method} → ${after.result.method.method}，未计算差值。`;
        return JSON.stringify({ beforeEvidenceId: before_evidence_id, afterEvidenceId: after_evidence_id, ...change, reply });
      },
    }),
  ];
}
