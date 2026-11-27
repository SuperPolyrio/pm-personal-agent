import { sourceSetting } from './source-config.js';
import { Agent, request } from 'node:https';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { EvidenceRow } from './source-evidence.js';

const views = ['market', 'event', 'live_sports', 'book', 'price_history', 'trades', 'positions', 'activity', 'resolution', 'freshness', 'tokens', 'price_at'] as const;
const intervals = ['1h', '6h', '1d', '1w'] as const;
const positionStatuses = ['OPEN', 'REDEEMABLE', 'REDEEMABLE_LOST', 'MERGEABLE', 'CLOSED'] as const;
const str = { type: 'string' } as const;
const api = sourceSetting('PM_POLYMARKET_DATA_URL') + '/v2/';
const condition = /^0x[0-9a-f]{64}$/i;
const wallet = /^0x[0-9a-f]{40}$/i;
const token = /^\d{1,78}$/;
const clob = sourceSetting('PM_POLYMARKET_CLOB_URL') + '/';
const gamma = sourceSetting('PM_POLYMARKET_GAMMA_URL') + '/';
const maxBytes = 2 * 1024 * 1024;
type View = typeof views[number];
type Row = Record<string, unknown>;
type Args = { view: View; id?: string; condition_id?: string; cursor?: string; limit?: number;
  competition?: string; include_lines?: boolean;
  interval?: typeof intervals[number]; fidelity?: number; start?: number; end?: number; as_of?: number;
  taker_only?: boolean; position_status?: typeof positionStatuses[number]; include_archived?: boolean;
  position_min_shares?: number; exclude_deposits_withdrawals?: boolean };
type Save = (source: string, data: unknown, retrievedAt: string) => EvidenceRow;
type Transport = Agent | HttpsProxyAgent<string> | SocksProxyAgent;

function endpoint({ view, id, condition_id, cursor, limit, interval, fidelity, start, end, as_of,
  competition, include_lines, taker_only, position_status, include_archived, position_min_shares, exclude_deposits_withdrawals }: Args) {
  const walletData = ['trades', 'positions', 'activity'].includes(view);
  const paged = walletData || view === 'live_sports';
  const walletView = walletData && id !== undefined && wallet.test(id);
  if ((cursor !== undefined || limit !== undefined) && !paged) throw new Error('此视图不支持 cursor 或 limit。');
  if (paged && ((limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 25)) || (cursor?.length ?? 0) > 4096))
    throw new Error('每页须为 1–25 条，请使用官方返回的游标。');
  if ((interval !== undefined || fidelity !== undefined) && view !== 'price_history') throw new Error('时间窗只适用于 price_history。');
  if (condition_id !== undefined && (!(view === 'book' || walletView) || !condition.test(condition_id)))
    throw new Error('condition_id 用于核对盘口身份或筛选公开钱包视图。');
  const hasBounds = start !== undefined || end !== undefined;
  if (hasBounds && ((view !== 'price_history' && (!walletView || !['activity', 'trades'].includes(view)))
    || [start, end].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    || (start !== undefined && end !== undefined && start > end))) throw new Error('历史查询需要有效的秒级 start、end。');
  if (taker_only !== undefined && view !== 'trades') throw new Error('taker_only 只适用于 trades。');
  if (exclude_deposits_withdrawals !== undefined && view !== 'activity') throw new Error('此参数只适用于 activity。');
  if ((position_status !== undefined || include_archived !== undefined || position_min_shares !== undefined) && view !== 'positions')
    throw new Error('持仓参数只适用于 positions。');
  if (position_min_shares !== undefined && (!Number.isFinite(position_min_shares) || position_min_shares < 0))
    throw new Error('position_min_shares 须为非负份数。');
  if (as_of !== undefined && view !== 'price_at') throw new Error('as_of 只适用于 price_at。');
  if ((competition !== undefined || include_lines !== undefined) && view !== 'live_sports')
    throw new Error('competition 和 include_lines 只适用于 live_sports。');
  if (view === 'freshness') {
    if (id) throw new Error('freshness 不需要 id。');
    return new URL('status', api);
  }
  if (view === 'live_sports') {
    const requested = id?.toLowerCase() || 'games';
    const tag = requested === 'cs2' ? 'counter-strike-2' : requested;
    if (!/^[a-z\d][a-z\d-]{0,99}$/.test(tag)) throw new Error('请提供 Polymarket 体育分类的标签 slug。');
    const params = new URLSearchParams({ tag_slug: tag, live: 'true', closed: 'false',
      limit: String(limit ?? 12), order: 'startTime,id', ascending: 'true' });
    if (competition !== undefined) {
      const title = competition.trim();
      if (!title || title.length > 120) throw new Error('请提供赛事标题中可识别的联赛或赛事名称。');
      params.set('title_search', title);
    }
    if (cursor) params.set('after_cursor', cursor);
    return new URL('events/keyset?' + params, gamma);
  }
  if (!id) throw new Error('请提供该视图所需的准确市场、选项或地址 ID。');
  if (view === 'price_at') {
    if (!token.test(id) || as_of === undefined || !Number.isSafeInteger(as_of) || as_of < 1)
      throw new Error('price_at 需要选项 token ID 和秒级 as_of。');
    return new URL('prices-history?' + new URLSearchParams({ token_id: id, as_of: String(as_of) }), api);
  }
  if (view === 'market' || view === 'event') {
    if (!/^[a-z\d][a-z\d-]{0,199}$/i.test(id)) throw new Error('请提供官方数字 ID 或准确 slug。');
    const path = /^\d+$/.test(id) ? id : 'slug/' + id;
    return new URL((view === 'market' ? 'markets/' : 'events/') + path, gamma);
  }
  if (view === 'book' || view === 'price_history') {
    if (!token.test(id)) throw new Error('请提供精确选项 token ID。');
    if (view === 'book') return new URL('book?' + new URLSearchParams({ token_id: id }), clob);
    const minutes = fidelity ?? 15;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('fidelity 须为 1–1440 分钟。');
    if (hasBounds) {
      if (interval || start === undefined || end === undefined || end <= start || end - start > 86_400)
        throw new Error('价格时间窗需要 start、end，跨度最多 24 小时。');
      return new URL('prices-history?' + new URLSearchParams({
        market: id, startTs: String(start), endTs: String(end), fidelity: String(minutes),
      }), clob);
    }
    return new URL('prices-history?' + new URLSearchParams({ market: id, interval: interval ?? '1d', fidelity: String(minutes) }), clob);
  }
  const field = view === 'resolution' || view === 'tokens' || view === 'trades' && condition.test(id) ? 'condition' : 'user';
  if (!(field === 'condition' ? condition : wallet).test(id)) throw new Error('请提供视图对应的 condition ID 或公开钱包地址。');
  const url = new URL(view === 'resolution' ? 'resolutions' : view, api);
  url.searchParams.set(field, id);
  if (view === 'trades') url.searchParams.set('taker_only', String(taker_only ?? true));
  if (walletView && condition_id) url.searchParams.set('condition', condition_id);
  if (start !== undefined) url.searchParams.set('start', String(start));
  if (end !== undefined) url.searchParams.set('end', String(end));
  if (exclude_deposits_withdrawals !== undefined) url.searchParams.set('exclude_deposits_withdrawals', String(exclude_deposits_withdrawals));
  if (position_status !== undefined) url.searchParams.set('status', position_status);
  if (include_archived !== undefined) url.searchParams.set('include_archived', String(include_archived));
  if (position_min_shares !== undefined) url.searchParams.set('filter_amount', String(position_min_shares));
  if (walletData) {
    url.searchParams.set('limit', String(limit ?? 12));
    if (cursor) url.searchParams.set('cursor', cursor);
  }
  return url;
}

async function getJson(url: URL, agent: Transport, signal: AbortSignal) {
  return new Promise<{ httpStatus: number; raw: string; responseDate?: string; cacheStatus?: string; cacheAge?: string }>((accept, reject) => {
    const req = request(url, { agent, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { accept: 'application/json', 'cache-control': 'no-cache' } }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(Object.assign(new Error('Response too large'), { code: 'RESPONSE_TOO_LARGE' })); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => accept({ httpStatus: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8'),
        responseDate: res.headers.date, cacheStatus: String(res.headers['cf-cache-status'] ?? ''), cacheAge: res.headers.age }));
    });
    req.on('error', reject).end();
  });
}

const object = (x: unknown): x is Row => Boolean(x && typeof x === 'object' && !Array.isArray(x));
function arrayField(x: unknown) {
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch { return []; }
  }
  return Array.isArray(x) ? x : [];
}
function marketSummary(m: Row) {
  const labels = arrayField(m.outcomes);
  const tokens = arrayField(m.clobTokenIds);
  const prices = arrayField(m.outcomePrices);
  return { gammaMarketId: m.id, slug: m.slug, title: m.question, conditionId: m.conditionId, active: m.active,
    closed: m.closed, acceptingOrders: m.acceptingOrders, endDate: m.endDate, metadataUpdatedAt: m.updatedAt,
    outcomeTokens: labels.length === tokens.length && tokens.every(t => typeof t === 'string' && token.test(t))
      ? labels.map((label, i) => ({ label, tokenId: tokens[i], gammaReferencePrice: prices[i] })) : [] };
}

function timestamp(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = /^\d{10}$/.test(String(value)) ? Number(value) * 1000
    : /^\d{13}$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

function summarize({ view, id, condition_id: expectedCondition, include_lines }: Args, raw: unknown, retrievedAt: string) {
  if (!object(raw)) throw new Error('invalid_response');
  if (view === 'live_sports') {
    if (!Array.isArray(raw.events) || !raw.events.every(row => object(row)
        && typeof row.slug === 'string' && /^[a-z\d][a-z\d-]*$/.test(row.slug)
        && Array.isArray(row.markets) && row.markets.every(object))
        || (raw.next_cursor != null && (typeof raw.next_cursor !== 'string' || !raw.next_cursor)))
      throw new Error('invalid_response');
    const events = raw.events.filter(event => event.live === true && event.ended !== true
      && event.closed === false && !event.finishedTimestamp).map(event => {
        const markets = event.markets as Row[];
        const winner = markets.find(m => m.sportsMarketType === 'moneyline' && m.slug === event.slug)
          ?? markets.find(m => m.sportsMarketType === 'moneyline');
        const seriesLines = include_lines ? markets.filter(m => {
          if (m.sportsMarketType === 'map_handicap') return true;
          if (m.sportsMarketType === 'spreads') return event.spreadsMainLine == null || Math.abs(Number(m.line)) === Math.abs(Number(event.spreadsMainLine));
          return m.sportsMarketType === 'totals' && (event.totalsMainLine == null || m.line === event.totalsMainLine);
        }).map(m => ({ ...marketSummary(m), marketType: m.sportsMarketType, line: m.line })) : undefined;
        return { gammaEventId: event.id, slug: event.slug, title: event.title, url: sourceSetting('PM_POLYMARKET_WEB_URL') + '/event/' + event.slug,
          startTime: event.startTime, period: event.period, score: event.score, gameStatus: event.gameStatus,
          metadataUpdatedAt: event.updatedAt, winnerMarket: winner ? marketSummary(winner) : null, seriesLines };
      });
    const next = typeof raw.next_cursor === 'string' ? raw.next_cursor : null;
    return { status: events.length ? 'ok' : next ? 'more_pages' : 'empty', result: {
      sourceStatus: 'polymarket_marked_live', returnedCount: events.length, events,
    }, pagination: { next_cursor: next, hasMore: next !== null } };
  }
  if (view === 'market' || view === 'event') {
    if ((/^\d+$/.test(id!) ? String(raw.id) : raw.slug) !== id) throw new Error('identity_mismatch');
    if (view === 'market') return { status: 'ok', result: { ...marketSummary(raw), rules: raw.description, resolutionSource: raw.resolutionSource } };
    if (!Array.isArray(raw.markets) || !raw.markets.every(object)) throw new Error('invalid_response');
    return { status: 'ok', result: { gammaEventId: raw.id, slug: raw.slug, title: raw.title, closed: raw.closed,
      returnedMarketCount: raw.markets.length, previewTruncated: raw.markets.length > 12, markets: raw.markets.slice(0, 12).map(marketSummary) } };
  }
  if (view === 'book') {
    if (raw.asset_id !== id || typeof raw.market !== 'string' || !condition.test(raw.market)
        || expectedCondition && raw.market.toLowerCase() !== expectedCondition.toLowerCase()) throw new Error('identity_mismatch');
    function levels(input: unknown, direction: number) {
      if (!Array.isArray(input)) throw new Error('invalid_response');
      return input.map(x => {
        if (!object(x) || typeof x.price !== 'string' || typeof x.size !== 'string') throw new Error('invalid_response');
        const price = Number(x.price), size = Number(x.size);
        if (!x.price.trim() || !Number.isFinite(price) || price < 0 || price > 1 || !Number.isFinite(size) || size <= 0)
          throw new Error('invalid_response');
        return { price, size };
      }).sort((a, b) => direction * (a.price - b.price));
    }
    const bids = levels(raw.bids, -1), asks = levels(raw.asks, 1);
    const bestBid = bids[0]?.price ?? null, bestAsk = asks[0]?.price ?? null;
    const sourceTime = timestamp(raw.timestamp);
    const ageSeconds = sourceTime === null ? null : (Date.parse(retrievedAt) - Date.parse(sourceTime)) / 1000;
    const bookShape = bestBid === null || bestAsk === null ? 'missing_side' : bestBid > bestAsk ? 'crossed' : 'two_sided';
    return { status: bids.length || asks.length ? 'ok' : 'empty', result: {
      conditionId: raw.market, tokenId: id, observation: 'official_rest_snapshot', sourceTime, ageSeconds,
      timestampStatus: ageSeconds === null ? 'unknown' : ageSeconds < 0 ? 'after_retrieval' : ageSeconds > 30 ? 'older_than_30s' : 'within_30s',
      continuousCoverage: 'unverified', bookShape, bestBid, bestAsk,
      spread: bookShape === 'two_sided' ? Number((bestAsk! - bestBid!).toFixed(8)) : null,
      bidLevels: bids.length, askLevels: asks.length, bids: bids.slice(0, 8), asks: asks.slice(0, 8),
      lastTradePrice: raw.last_trade_price, tickSize: raw.tick_size, minOrderSize: raw.min_order_size,
      units: { price: 'quote currency per share', size: 'shares' },
    } };
  }
  if (view === 'freshness') {
    if (!object(raw.data)) throw new Error('invalid_response');
    return { status: 'ok', result: raw.data };
  }
  const rows = view === 'price_history' ? raw.history : raw.data;
  if (!Array.isArray(rows)) throw new Error('invalid_response');
  if ((view === 'resolution' || view === 'trades') && id && condition.test(id)
      && rows.some(row => !object(row) || typeof row.condition_id !== 'string'
        || row.condition_id.toLowerCase() !== id.toLowerCase())) throw new Error('identity_mismatch');
  const pagination = object(raw.pagination) ? raw.pagination : undefined;
  return { status: rows.length ? 'ok' : 'empty', returnedCount: rows.length, pagination,
    previewTruncated: view === 'price_history' && rows.length > 16,
    result: view === 'price_history' ? rows.slice(-16) : rows };
}

export function createPolymarketPublicReader(saveEvidence: Save) {
  // Scope the operator-selected Rabisu route to this reader. An explicit empty setting uses direct HTTPS.
  const proxy = sourceSetting('PM_POLYMARKET_READ_PROXY');
  let agent: Transport | undefined;
  async function read(args: Args, signal: AbortSignal) {
    const url = endpoint({ ...args, id: args.id?.trim() });
    let httpStatus: number | null = null;
    let retrievedAt = '';
    let raw: unknown;
    let summary: Row & { status: string; result?: Row | unknown[]; pagination?: Row };
    let transport: { responseDate?: string; cacheStatus?: string; cacheAge?: string } | undefined;
    try {
      agent ??= !proxy ? new Agent() : proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
      const response = await getJson(url, agent, signal);
      httpStatus = response.httpStatus;
      retrievedAt = new Date().toISOString();
      if (args.view === 'live_sports' || args.view === 'book') {
        const { responseDate, cacheStatus, cacheAge } = response;
        transport = { responseDate, cacheStatus, cacheAge };
      }
      try { raw = JSON.parse(response.raw); }
      catch { raw = null; }
      if (httpStatus !== 200) summary = { status: httpStatus === 404 ? 'not_found' : httpStatus === 429 ? 'rate_limited' : 'http_error' };
      else {
        summary = summarize({ ...args, id: args.id?.trim() }, raw, retrievedAt);
        if (args.view === 'book' && object(summary.result) && object(raw)) {
          const { responseDate, cacheStatus, cacheAge } = response;
          // A validated, uncached official response can carry an earlier book version.
          const serverTime = Date.parse(responseDate ?? '');
          const confirmed = summary.status === 'ok' && cacheStatus === 'DYNAMIC' && (cacheAge === undefined || cacheAge === '0')
            && Math.abs(Date.parse(retrievedAt) - serverTime) <= 10_000
            && typeof raw.hash === 'string' && /^[a-f0-9]{40,64}$/i.test(raw.hash)
            && summary.result.sourceTime !== null && summary.result.timestampStatus !== 'after_retrieval';
          if (confirmed) summary.result.directlyObservedAt = retrievedAt;
        }
      }
    } catch (cause) {
      signal.throwIfAborted();
      const err = cause as Error & { code?: string; cause?: Error };
      summary = { status: httpStatus === 200 ? 'invalid_response' : 'access_failed',
        reason: httpStatus === 200 ? err.message : err.code ?? err.name };
    }
    retrievedAt ||= new Date().toISOString();
    const { evidenceId } = saveEvidence(url.href, { kind: 'polymarket_public', view: args.view, id: args.id ?? null,
      httpStatus, status: summary.status, response: raw ?? null, reason: summary.reason, ...transport }, retrievedAt);
    return { evidenceId, source: url.href, retrievedAt, view: args.view, httpStatus,
      ...(args.view === 'live_sports' ? transport : undefined), ...summary };
  }
  const tool = defineTool({
    name: 'read_polymarket_public',
    description: '读取 Polymarket 官方公开 API。用 live_sports 查询平台当前标为进行中的体育和电竞比赛及关联胜负盘。也支持市场/事件、盘口、价格历史、成交、公开持仓和活动、结算及 Data API 时效。',
    parameters: {
      view: { ...str, required: true, enum: views },
      id: { ...str, description: 'live_sports 用体育分类标签 slug（如 cs2、nba、tennis，省略时查全部 games）；market/event 用官方数字 ID 或 slug；book/price_history/price_at 用 token；resolution/tokens 用 condition；trades 用 condition 或公开钱包；positions/activity 用公开钱包；freshness 省略。' },
      competition: { ...str, description: '仅 live_sports。按 Gamma 的赛事标题筛选联赛或杯赛，例如 PGL Major。' },
      include_lines: { type: 'boolean', description: '仅 live_sports。问盘口时传 true，随每场胜负盘附该场让分、让图和总数合约（视官方覆盖）。' },
      condition_id: { ...str, description: '可选，核对 book 身份或筛选 wallet 的 trades/positions/activity。' },
      cursor: str, limit: { type: 'integer' },
      interval: { ...str, enum: intervals }, fidelity: { type: 'integer', description: '价格历史的采样间隔，单位分钟。' },
      start: { type: 'integer' }, end: { type: 'integer' }, as_of: { type: 'integer' },
      taker_only: { type: 'boolean', description: 'trades 默认 true。false 包含 maker 和 taker。' },
      position_status: { ...str, enum: positionStatuses }, include_archived: { type: 'boolean' },
      position_min_shares: { type: 'number' }, exclude_deposits_withdrawals: { type: 'boolean' },
    },
    output: { schema: str, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, { signal }) { return JSON.stringify(await read(args, signal)); },
  });
  return { tool, read };
}
