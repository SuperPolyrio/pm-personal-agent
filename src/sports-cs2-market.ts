import { sourceSetting } from './source-config.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Cs2LiveRound } from './sports-cs2-live.js';
import type { researchEngine } from './market-data.js';

export const cs2MarketSocket = sourceSetting('PM_POLYMARKET_WS_URL');
const teamAliases: Record<string, string> = {
  imperialesports: 'imperial', teamliquid: 'liquid', '9zglobant': '9z',
  lynnvisiongaming: 'lynnvision', parivision: 'pvision',
};
export function cs2TeamKey(value: string) {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/clan$/, '');
  return teamAliases[key] ?? key;
}
type Row = Record<string, unknown>;
export type Cs2Market = {
  marketId: number; conditionId: string; tokenId: string; team: string; label: string; slug: string; url: string;
  mapIndex: number | null;
};
type Quote = { bid: number; ask: number; time: number; observedAt: number };
type LiveTrade = { price: string | number; size: string | number; time: number; observedAt: number; transactionHash?: string };
type Trade = {
  trade_time: string; price: string; size: string; tx_hash: string; log_index: number;
  block_number?: string; ingested_at?: string; fact_notional_usd?: string; maker?: string; taker?: string;
};
type Window = { first_price: string; last_price: string; first_time: string; last_time: string; fact_rows: number };
export type Cs2MarketRound = {
  market: Cs2Market; as_of: string; price?: Window; trades?: Trade[];
  quotes?: { before?: Quote; end?: Quote };
  liveTrades?: LiveTrade[];
};
type Research = typeof researchEngine;

export async function bindCs2Markets(eventSlug: string, teams: [string, string], mapCount: number, query: Research) {
  const slugs = [eventSlug, ...Array.from({ length: mapCount }, (_, i) => `${eventSlug}-game${i + 1}`)];
  return Promise.all(slugs.map(async (slug, index): Promise<Cs2Market | null> => {
    const { data } = await query('resolve', { input: slug }, AbortSignal.timeout(3500));
    const outcomes = (Array.isArray(data.outcomes) ? data.outcomes : []) as { label: string; tokenId: string }[];
    const outcome = outcomes.find(row => cs2TeamKey(row.label) === cs2TeamKey(teams[0]));
    if (data.status !== 'found' || data.slug !== slug || data.eventSlug !== eventSlug || typeof data.localMarketId !== 'number'
      || !Number.isSafeInteger(data.localMarketId) || typeof data.conditionId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(data.conditionId)
      || !outcome || !/^\d{1,78}$/.test(outcome.tokenId) || !outcomes.some(row => cs2TeamKey(row.label) === cs2TeamKey(teams[1]))) return null;
    return { marketId: data.localMarketId, conditionId: data.conditionId.toLowerCase(), tokenId: outcome.tokenId, team: teams[0],
      label: index ? `图 ${index} 胜负` : '系列赛胜负', mapIndex: index ? index - 1 : null, slug, url: String(data.url) };
  }).map(task => task.catch(() => null)));
}

export function cs2QuoteTimeline(markets: (Cs2Market | null)[]) {
  const tokens = new Map(markets.flatMap(market => market ? [[market.tokenId, market] as const] : []));
  const values = new Map<string, Quote[]>();
  const liveTrades = new Map<string, LiveTrade[]>();
  const price = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  function record(id: unknown, condition: unknown, bid: number, ask: number, time: number, observedAt: number) {
    if (typeof id !== 'string' || !tokens.has(id) || condition !== tokens.get(id)?.conditionId
      || !(bid > 0 && ask < 1 && bid <= ask) || !Number.isFinite(time) || time > observedAt || observedAt - time > 120_000) return;
    const points = values.get(id) ?? [];
    if (points.at(-1) && time < points.at(-1)!.time) return;
    points.push({ bid, ask, time, observedAt });
    while (points.length > 2500 || observedAt - points[0].observedAt > 480_000) points.shift();
    values.set(id, points);
  }
  function ingest(raw: unknown, observedAt: number) {
    for (const row of (Array.isArray(raw) ? raw : [raw]) as Row[]) {
      if (!row || typeof row !== 'object') continue;
      const time = /^\d{13}$/.test(String(row.timestamp)) ? Number(row.timestamp) : NaN;
      const condition = typeof row.market === 'string' ? row.market.toLowerCase() : undefined;
      if (row.event_type === 'book') {
        const bids = (Array.isArray(row.bids) ? row.bids : []).map(level => price(level?.price)).filter(Number.isFinite);
        const asks = (Array.isArray(row.asks) ? row.asks : []).map(level => price(level?.price)).filter(Number.isFinite);
        record(row.asset_id, condition, Math.max(...bids), Math.min(...asks), time, observedAt);
      } else if (row.event_type === 'price_change' || row.event_type === 'best_bid_ask') {
        const changes = row.event_type === 'price_change' ? (Array.isArray(row.price_changes) ? row.price_changes : []) : [row];
        for (const change of changes) if (change) record(change.asset_id, condition,
          price(change.best_bid), price(change.best_ask), time, observedAt);
      } else if (row.event_type === 'last_trade_price' && typeof row.asset_id === 'string'
        && tokens.get(row.asset_id)?.conditionId === condition && tokens.has(row.asset_id)
        && Number.isFinite(time) && time <= observedAt && observedAt - time <= 120_000) {
        const p = price(row.price), size = price(row.size);
        if (!(p > 0 && p < 1 && size > 0 && Number.isFinite(size))) continue;
        const points = liveTrades.get(row.asset_id) ?? [];
        const rawPrice = String(row.price), rawSize = String(row.size);
        const transactionHash = typeof row.transaction_hash === 'string' ? row.transaction_hash : undefined;
        if (transactionHash && points.some(t => t.transactionHash === transactionHash && t.time === time
          && String(t.price) === rawPrice && String(t.size) === rawSize)) continue;
        points.push({ price: rawPrice, size: rawSize, time, observedAt, transactionHash });
        while (points.length > 800 || observedAt - points[0].observedAt > 480_000) points.shift();
        liveTrades.set(row.asset_id, points);
      }
    }
  }
  function at(market: Cs2Market, asOf?: number) {
    if (asOf === undefined || tokens.get(market.tokenId)?.conditionId !== market.conditionId) return;
    return values.get(market.tokenId)?.findLast(point => point.observedAt <= asOf && point.time <= asOf && asOf - point.time <= 12_000);
  }
  function tradesAt(market: Cs2Market, asOf: number) {
    if (tokens.get(market.tokenId)?.conditionId !== market.conditionId) return [];
    return (liveTrades.get(market.tokenId) ?? []).filter(point =>
      point.observedAt <= asOf && point.time <= asOf && asOf - point.time <= 30_000)
      .sort((a, b) => b.time - a.time).slice(0, 2);
  }
  return { ingest, at, tradesAt, tokens: [...tokens.keys()] };
}

export async function followCs2MarketQuotes(timeline: ReturnType<typeof cs2QuoteTimeline>, signal: AbortSignal,
  status: (state: string, detail: unknown) => void, connect = (url: string) => new WebSocket(url)) {
  if (!timeline.tokens.length) return;
  while (!signal.aborted) {
    await new Promise<void>(resolve => {
      const ws = connect(cs2MarketSocket);
      let last = Date.now();
      const stop = () => ws.close();
      const heartbeat = setInterval(() => {
        if (Date.now() - last > 22_000 || ws.readyState === WebSocket.CONNECTING) return stop();
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, 10_000);
      const connected = setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) stop(); }, 5000);
      signal.addEventListener('abort', stop, { once: true });
      ws.addEventListener('open', () => {
        last = Date.now();
        ws.send(JSON.stringify({ assets_ids: timeline.tokens, type: 'market', custom_feature_enabled: true }));
        status('pm_connected', { source: cs2MarketSocket, tokens: timeline.tokens.length });
      });
      ws.addEventListener('message', ({ data }) => {
        last = Date.now();
        if (typeof data !== 'string' || data === 'PONG') return;
        try { timeline.ingest(JSON.parse(data), last); } catch { /* Ignore a non-market frame. */ }
      });
      ws.addEventListener('close', ({ code }) => {
        clearTimeout(connected);
        clearInterval(heartbeat);
        signal.removeEventListener('abort', stop);
        if (!signal.aborted) status('pm_disconnected', { source: cs2MarketSocket, code });
        resolve();
      }, { once: true });
    });
    if (!signal.aborted) await sleep(12_000, undefined, { signal }).catch(() => {});
  }
}

export async function cs2RoundMarkets(bindings: (Cs2Market | null)[], round: Cs2LiveRound, query: Research,
  timeline?: ReturnType<typeof cs2QuoteTimeline>): Promise<Cs2MarketRound[]> {
  const markets = [bindings[0], bindings[round.mapIndex + 1]].filter((row): row is Cs2Market => Boolean(row));
  return Promise.all(markets.map(async market => {
    const as_of = new Date(round.receivedAt).toISOString();
    const before = timeline?.at(market, round.start?.receivedAt);
    const end = timeline?.at(market, round.receivedAt);
    const liveTrades = timeline?.tradesAt(market, round.receivedAt);
    // When replayed later, trades must still have been available at the round observation cutoff.
    const where = `FROM research_trades(start=:as_of-INTERVAL 3 MINUTE,end=:as_of)
      WHERE market_id=${market.marketId} AND token_id='${market.tokenId}' AND ingested_at <= :as_of`;
    const signal = AbortSignal.timeout(2200);
    const [price, trades] = await Promise.allSettled([
      query('query', { engine: 'clickhouse', as_of, max_rows: 1,
        sql: `SELECT argMin(price,(trade_time,block_number,log_index)) AS first_price,
        argMax(price,(trade_time,block_number,log_index)) AS last_price, min(trade_time) AS first_time,
        max(trade_time) AS last_time, count() AS fact_rows ${where} HAVING fact_rows > 0` }, signal),
      query('query', { engine: 'clickhouse', as_of, max_rows: 2,
        sql: `SELECT trade_time,price,size,fact_notional_usd,block_number,tx_hash,log_index,maker,taker,ingested_at ${where}
          ORDER BY trade_time DESC,block_number DESC,log_index DESC LIMIT 2` }, signal),
    ]);
    return { market, as_of, price: price.status === 'fulfilled' ? (price.value.data.rows as Window[])[0] : undefined,
      trades: trades.status === 'fulfilled' ? trades.value.data.rows as Trade[] : undefined,
      ...(before || end ? { quotes: { before, end } } : {}), ...(liveTrades?.length ? { liveTrades } : {}) };
  }));
}
