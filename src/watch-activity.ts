import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { watchSourceExpired, type WatchIntent, type WatchObservation, type WatchRead } from './tasks.js';

type TradeKeyRow = { tx_hash: string; log_index: string | number; block_number: string | number; trade_time: string;
  price: string | number; size?: string | number };
type DepthLevel = { price: number; size: number };
type BookSide = { tokenId: string; bookStatus: string; upstreamReady?: boolean; continuity?: boolean;
  heartbeatAt?: string; receivedAt?: string; eventAt?: string; bids?: DepthLevel[]; asks?: DepthLevel[] };
export const tradeAnomalySource = 'trade_anomalies';
export const bookAnomalySource = 'book_anomalies';
export const largeTradeSource = 'polymarket_trades';
export const largeTradeScope = 'large_trade';
export const largeTradeContextMs = 300_000;
export const activityDay = (at: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(at));
export const thinTradePrices = '每半窗至少需要五条已核对的成交价格';
export const isWatchTimeout = (reason: string) => /\b(?:\w*Timeout(?:Error|Exception)?|ETIMEDOUT)\b|timed out|超时/i.test(reason);

export function watchFailureCounts(db: DatabaseSync, since: string, until: string) {
  const counts = { stale: 0, missingBlockTime: 0, timeout: 0, insufficientSamples: 0, other: 0 };
  const issues = db.prepare(`SELECT c.status, c.detail, r.finished_at,
    json_extract(CASE WHEN json_valid(c.detail) THEN c.detail END,'$.issue') AS issue,
    (SELECT json_extract(item.value,'$.maxAgeSeconds')
     FROM json_each(v.data,'$.marketWatch.items') AS item
     WHERE json_extract(item.value,'$.id')=c.path) AS max_age
    FROM runs r JOIN coverage c ON c.run_id=r.id
    LEFT JOIN watch_versions v ON v.watch_id=r.watch_id AND v.version=r.watch_version
    WHERE r.watch_id IS NOT NULL AND r.finished_at>? AND r.finished_at<=? AND c.status<>'covered' AND c.path<>'$schedule'`);
  for (const row of issues.iterate(since, until)) {
    const issue = row.issue ? JSON.parse(String(row.issue)) as WatchRead['issue'] : undefined;
    const reason = String(issue?.reason ?? row.detail ?? '');
    const thin = reason === thinTradePrices || reason === '窗口样本不足';
    // Older checks can store an expired trade window under the sample gate.
    if (row.status === 'stale' || issue?.status === 'stale' || thin && issue?.sourceThrough &&
        watchSourceExpired(issue.sourceThrough, String(row.finished_at), Number(row.max_age))) counts.stale++;
    else if (isWatchTimeout(reason)) counts.timeout++;
    else if (reason === '审计水位没有可用的区块时间边界' || reason === '窗口缺少可核对的区块时间索引') counts.missingBlockTime++;
    else if (thin) counts.insufficientSamples++;
    else counts.other++;
  }
  return counts;
}

// Trade prices have ten decimal places. A median of two prices can need one more.
const priceScale = 100_000_000_000;
const priceUnits = (price: number) => Math.round(price * priceScale);
const cents = (price: number) => `${Number((price * 100).toFixed(4))}¢`;
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const sharesFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const beijingTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
});

export function formatWatchNotice(member: WatchIntent['members'][number], market: { title?: string; url?: unknown; outcome?: string }) {
  const title = market.title || `市场 local:${member.marketId}`;
  const link = typeof market.url === 'string' && /^https:\/\/(?:www\.)?polymarket\.com\/event\/[\w-]+(?:\/[\w-]+)?\/?$/.test(market.url)
    ? market.url : undefined;
  const at = Date.parse(member.tradeAt ?? member.factAt ?? member.observedAt ?? '');
  const time = Number.isFinite(at) ? `${member.tradeAt ? '成交时间' : member.priceMove ? '窗口结束' : '时间'} ${beijingTime.format(at)}（北京时间）` : undefined;
  if (member.sourceId === 'weather_observation') {
    const originalUrl = member.evidence?.source;
    return [title, member.description, member.unknowns?.some(line => line.includes('北京时间')) ? undefined : time, member.reason,
      member.before === undefined ? undefined : `此前 ${JSON.stringify(member.before)}`,
      member.after === undefined ? undefined : `当前 ${JSON.stringify(member.after)}`,
      member.unknowns?.join('\n'),
      originalUrl && !member.unknowns?.some(line => line.includes(originalUrl)) ? originalUrl : undefined,
      member.evidenceIds[0] ? `核对证据 ${member.evidenceIds[0]}` : undefined, link].filter(Boolean).join('\n');
  }
  if (member.tradeAt || member.priceMove) {
    let move: string | undefined;
    if (member.priceMove && typeof member.before === 'number' && typeof member.after === 'number') {
      const difference = (priceUnits(member.after) - priceUnits(member.before)) / priceScale * 100;
      const points = Number(Math.abs(difference).toFixed(2));
      move = member.priceMove === 'range'
        ? `成交价区间 ${cents(member.before)} – ${cents(member.after)}（波动 ${points} 个百分点）`
        : `${member.tradeAt ? '前后成交价' : '前后半窗中位价'} ${cents(member.before)} → ${cents(member.after)}`
          + `（${difference < 0 ? '下跌' : '上涨'} ${points} 个百分点）`;
    }
    return [title, member.tradeAt ? member.description : `价格异动｜${market.outcome ?? '成交价'}`, time, move, link].filter(Boolean).join('\n');
  }
  return [title, member.description, time, member.reason,
    member.before === undefined ? undefined : `此前 ${JSON.stringify(member.before)}`,
    member.after === undefined ? undefined : `当前 ${JSON.stringify(member.after)}`,
    member.unknowns?.join('；'), link].filter(Boolean).join('\n');
}

export function significantTradePriceChange(before: number, after: number) {
  const low = priceUnits(Math.min(before, after)), high = priceUnits(Math.max(before, after));
  const difference = high - low;
  return difference >= priceUnits(.03) || (difference >= priceUnits(.002) && low > 0 && high * 2 >= low * 3);
}

export function largeTradeFeedTime(data: Record<string, unknown> | unknown[], retrievedAt: string) {
  if (Array.isArray(data) || typeof data.computed_at !== 'string') return undefined;
  const computed = Date.parse(data.computed_at);
  const serving = data.serving as { mechanisms?: { name: string; age_seconds?: number }[] } | undefined;
  const lag = Array.isArray(serving?.mechanisms)
    ? serving.mechanisms.find(mechanism => mechanism?.name === 'activity_feed')?.age_seconds : undefined;
  if (!Number.isFinite(computed) || computed > Date.parse(retrievedAt) ||
      typeof lag !== 'number' || !Number.isFinite(lag) || lag < 0) return undefined;
  return Math.floor((computed - lag * 1000) / 1000) * 1000;
}

export function officialTradeTime(row: unknown) {
  const timestamp = (row as { timestamp?: unknown } | null)?.timestamp;
  return typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp * 1000 : NaN;
}

export function largeTradeFindings(marketId: number, options: { tokenId: string; label?: string }[], rows: unknown[],
  from: number, to: number) {
  const labels = new Map(options.map(option => [option.tokenId, option.label]));
  const byKey = new Map<string, { key: string; at: number; tx: string; tokenId: string; label: string;
    side: 'BUY' | 'SELL'; price: number; shares: number; usd: number }>();
  for (const raw of rows) {
    const at = officialTradeTime(raw);
    if (!Number.isFinite(at)) return undefined;
    if (at < from - largeTradeContextMs || at >= to + largeTradeContextMs) continue;
    const { token_id: tokenId, transaction_hash: tx, proxy_wallet: wallet, side, price, size: shares } = raw as Record<string, unknown>;
    const label = typeof tokenId === 'string' ? labels.get(tokenId) : undefined;
    if (typeof tokenId !== 'string' || !label || typeof tx !== 'string' || !/^0x[\da-f]{64}$/i.test(tx) ||
        typeof wallet !== 'string' || !/^0x[\da-f]{40}$/i.test(wallet) || (side !== 'BUY' && side !== 'SELL') ||
        typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1 ||
        typeof shares !== 'number' || !Number.isFinite(shares) || shares <= 0) return undefined;
    const key = createHash('sha256').update(JSON.stringify([tx.toLowerCase(), wallet.toLowerCase(), tokenId, side, at, price, shares])).digest('hex');
    // The public feed has no fill ID. Indistinguishable repeated rows share one alert key.
    byKey.set(key, { key, at, tx: tx.toLowerCase(), tokenId, label, side, price, shares, usd: price * shares });
  }
  const rowsByTime = [...byKey.values()].sort((a, b) => a.at - b.at);
  const findings: NonNullable<WatchObservation['findings']> = [];
  const matches = rowsByTime.filter(trade => trade.at >= from && trade.at < to && trade.usd >= 500).map(trade => {
    const nearby = rowsByTime.filter(row => row.tokenId === trade.tokenId && row.tx !== trade.tx &&
      Math.abs(row.at - trade.at) <= largeTradeContextMs);
    const earlier = nearby.filter(row => row.at < trade.at);
    const later = nearby.filter(row => row.at > trade.at);
    const before = earlier.at(-1), after = later[0];
    const unambiguous = (row: typeof before, candidates: typeof nearby) => row &&
      !candidates.some(other => other.at === row.at && other.price !== row.price);
    const comparison = before && after && unambiguous(before, earlier) && unambiguous(after, later)
      ? { before, after, significant: significantTradePriceChange(before.price, after.price) } : undefined;
    const description = `大额成交｜${trade.side === 'BUY' ? '买入' : '卖出'} ${trade.label} · ${dollars.format(trade.usd)}\n`
      + `${sharesFormat.format(trade.shares)} 份 @ ${cents(trade.price)}`;
    findings.push({ eventKey: `market:${marketId}:large-trade:${trade.key}`, revision: trade.key,
      kind: 'added', confidence: 'confirmed', importance: 'high', description, tradeAt: new Date(trade.at).toISOString(),
      ...(comparison?.significant ? { priceMove: 'change', before: comparison.before.price, after: comparison.after.price } : {}) });
    return { ...trade, comparison };
  });
  return { matches, findings };
}

export function spreadWidened(before: number, after: number) {
  const previous = priceUnits(before);
  return previous > 0 && priceUnits(after) >= Math.max(previous * 2, previous + priceUnits(.01));
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function tradePriceChange(rows: TradeKeyRow[], expected: number, digest: string, from: string, to: string, priceOnly = false) {
  const prices = new Map<string, { time: number; price: number; size: number }>();
  const start = Date.parse(from), end = Date.parse(to);
  for (const row of rows) {
    const key = `${row.tx_hash}:${row.log_index}:${row.block_number}`;
    const time = Date.parse(row.trade_time.replace(' ', 'T').replace(/(?<=\d\d:\d\d:\d\d)$/, 'Z'));
    const price = Number(row.price), size = priceOnly ? 0 : Number(row.size);
    const previous = prices.get(key);
    if (!(time >= start && time < end) || row.price === '' || !Number.isFinite(price) || price < 0 || price > 1 ||
        (!priceOnly && (!Number.isFinite(size) || size <= 0)) ||
        (previous && (previous.price !== price || previous.time !== time || previous.size !== size))) return { status: 'unverified' as const };
    prices.set(key, { time, price, size });
  }
  if (prices.size !== expected || createHash('sha256').update([...prices.keys()].sort().join('\n')).digest('hex') !== digest) {
    return { status: 'unverified' as const };
  }
  const middle = (start + end) / 2;
  const samples = [...prices.values()];
  const early = samples.filter(row => row.time < middle).map(row => row.price);
  const late = samples.filter(row => row.time >= middle).map(row => row.price);
  if (early.length < 5 || late.length < 5) return { status: 'insufficient_samples' as const, early: early.length, late: late.length };
  const before = median(early), after = median(late);
  const largestLogShares = priceOnly ? undefined : Math.max(...samples.map(row => row.size));
  const shareOfObservedLogShares = largestLogShares === undefined ? undefined : largestLogShares / samples.reduce((sum, row) => sum + row.size, 0);
  const ordered = priceOnly ? samples.map(row => row.price).sort((a, b) => a - b) : undefined;
  const trim = Math.floor(samples.length / 10);
  const range = ordered && { low: ordered[trim]!, high: ordered[ordered.length - trim - 1]! };
  return { status: 'covered' as const, before, after, early: early.length, late: late.length, change: (priceUnits(after) - priceUnits(before)) / priceScale,
    range, largestLogShares, shareOfObservedLogShares };
}

export type TradeSample = { from: string; to: string; events: number; evidenceId: string };
export function tradeActivityBaseline(current: TradeSample, history: TradeSample[]) {
  const samples: TradeSample[] = [];
  let edge = Date.parse(current.from);
  for (const row of [...history].sort((a, b) => b.to.localeCompare(a.to))) {
    if (Date.parse(row.to) > edge || Date.parse(row.from) < Date.parse(current.from) - 4 * 3600000) continue;
    samples.push(row);
    edge = Date.parse(row.from);
    if (samples.length === 12) break;
  }
  const value = samples.length >= 6 ? median(samples.map(row => row.events)) : undefined;
  return { samples, median: value, threshold: value === undefined || value === 0 ? undefined : Math.ceil(Math.max(value * 1.5, value + 25)) };
}

export function qualifiedBook(data: { yes?: BookSide; no?: BookSide }, tokenId: string, retrievedAt: string) {
  const side = [data.yes, data.no].find(row => row?.tokenId === tokenId);
  const available = side?.bookStatus === 'available' && side.upstreamReady === true;
  const live = side?.bookStatus === 'live' && side.continuity === true;
  const observedAt = live ? side?.heartbeatAt : side?.receivedAt ?? side?.eventAt;
  const age = (Date.parse(retrievedAt) - Date.parse(observedAt ?? '')) / 1000;
  if ((!live && !available) || !observedAt || !(age >= 0 && age <= 30)) {
    return { status: 'unavailable' as const, sourceStatus: side?.bookStatus ?? 'unknown', observedAt };
  }
  const usable = (levels?: DepthLevel[]) => Array.isArray(levels) && levels.every(row => row && Number.isFinite(row.price) &&
    row.price > 0 && row.price <= 1 && Number.isFinite(row.size) && row.size > 0);
  if (!usable(side.bids) || !usable(side.asks)) {
    return { status: 'unavailable' as const, sourceStatus: 'invalid_levels', observedAt };
  }
  const bids = [...side.bids!].sort((a, b) => b.price - a.price);
  const asks = [...side.asks!].sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price, bestAsk = asks[0]?.price;
  if (bestBid !== undefined && bestAsk !== undefined && bestBid > bestAsk) return { status: 'unavailable' as const, sourceStatus: 'crossed', observedAt };
  const depth = (levels: DepthLevel[], best?: number) => best === undefined ? 0 : levels.filter(row => Math.abs(priceUnits(row.price) - priceUnits(best)) <= priceUnits(.01))
    .reduce((sum, row) => sum + row.size, 0);
  return { status: 'covered' as const, sourceStatus: side.bookStatus, observedAt, bids, asks, bestBid, bestAsk,
    spread: bestBid !== undefined && bestAsk !== undefined ? (priceUnits(bestAsk) - priceUnits(bestBid)) / priceScale : undefined,
    bidDepth: depth(bids, bestBid), askDepth: depth(asks, bestAsk), depthRange: .01 };
}

export function estimateBook(book: ReturnType<typeof qualifiedBook>, side: 'buy' | 'sell', quantity: number) {
  if (book.status !== 'covered') return { status: 'unavailable' as const };
  const levels = side === 'buy' ? book.asks : book.bids;
  let shares = 0, notional = 0;
  for (const level of levels) {
    const filled = Math.min(quantity - shares, level.size);
    shares += filled;
    notional += filled * level.price;
    if (shares >= quantity) break;
  }
  const averagePrice = shares > 0 ? notional / shares : undefined;
  return { status: shares >= quantity ? 'covered' : 'insufficient_visible_depth', side, quantity, shares, notional,
    averagePrice, bestPrice: levels[0]?.price, slippage: averagePrice !== undefined ? Math.abs(averagePrice - levels[0]!.price) : undefined,
    observedAt: book.observedAt, feesIncluded: false };
}

export function watchActivity(db: DatabaseSync, since: string, until: string, onlyActive: boolean) {
  const watches = db.prepare(`SELECT id,market_id,goal,status,expires_at,runs FROM watches WHERE (?=0 OR status='active') ORDER BY rowid`).all(Number(onlyActive));
  const runs = db.prepare(`SELECT r.id,r.watch_id,r.finished_at,r.status,r.result,
    json_extract(v.data,'$.marketWatch.authorizationRef') AS authorization_ref FROM runs r JOIN watches w ON w.id=r.watch_id
    LEFT JOIN watch_versions v ON v.watch_id=w.id AND v.version=r.watch_version
    WHERE r.finished_at>? AND r.finished_at<=? AND (?=0 OR w.status='active') ORDER BY r.finished_at DESC LIMIT 1001`)
    .all(since, until, Number(onlyActive));
  const notices = new Map<string, string>();
  for (const notice of db.prepare(`SELECT run_id,delivery_status,json_extract(CASE WHEN json_valid(body) THEN body END,'$.deliveryKey') AS key
    FROM notices WHERE created_at>? AND created_at<=?`).all(since, until)) {
    if (notice.key) notices.set(`${notice.run_id}:${notice.key}`, String(notice.delivery_status));
  }
  const changes = new Map<string, { runId: string; watchIds: string[]; detectedAt: string; delivery: string[];
    affected: { marketId: number; tokenId?: string }[]; action: WatchIntent['action']; change: WatchIntent['members'][number] }>();
  const coverage = new Map<string, { watchId: string; runId: string; status: string; at: string; items: unknown[] }>();
  for (const row of runs.slice(0, 1000)) {
    const id = String(row.watch_id), at = String(row.finished_at);
    const result = row.result && String(row.result).startsWith('{') ? JSON.parse(String(row.result)) as {
      intents?: WatchIntent[]; checks?: { status: string; marketId: number; itemId: string; evidenceIds: string[]; issue?: unknown }[] } : {};
    if (!coverage.has(id)) coverage.set(id, { watchId: id, runId: String(row.id), status: String(row.status), at,
      items: (result.checks ?? []).map(({ marketId, itemId, issue, status, evidenceIds }) => ({ marketId, itemId, status, issue, evidenceId: evidenceIds[0] })) });
    for (const intent of result.intents ?? []) for (const change of intent.members) {
      if (change.action === 'suppress') continue;
      const key = `${intent.eventKey}:${intent.revision}`;
      const route = createHash('sha256').update(JSON.stringify([row.authorization_ref, intent.eventKey, intent.revision, change.action, change.notBefore])).digest('hex');
      const delivery = notices.get(`${row.id}:${route}`);
      const affected = { marketId: change.marketId, tokenId: change.tokenId };
      const old = changes.get(key);
      if (old) {
        old.watchIds = [...new Set([...old.watchIds, id])];
        if (delivery && !old.delivery.includes(delivery)) old.delivery.push(delivery);
        if (!old.affected.some(a => a.marketId === affected.marketId && a.tokenId === affected.tokenId)) old.affected.push(affected);
      } else {
        changes.set(key, { runId: String(row.id), watchIds: [id], detectedAt: at, delivery: delivery ? [delivery] : [], affected: [affected], action: change.action, change });
      }
    }
  }
  const priority = { high: 0, normal: 1, low: 2 };
  const ranked = [...changes.values()].sort((a, b) => priority[a.change.importance] - priority[b.change.importance]);
  const due = db.prepare(`SELECT r.id,r.market_id,r.version,json_extract(r.data,'$.review_at') AS reviewAt
    FROM records r WHERE r.kind='thesis' AND r.version=(SELECT max(version) FROM records WHERE id=r.id) AND
    julianday(json_extract(r.data,'$.review_at'))<=julianday(?) ORDER BY julianday(reviewAt) LIMIT 31`).all(until);
  return { since, until, scope: onlyActive ? 'active_watches' : 'all_watches', watches, coverage: [...coverage.values()],
    anomalies: ranked.slice(0, 30), anomalyCount: ranked.length, reviewsDue: due.slice(0, 30),
    truncated: runs.length > 1000 || ranked.length > 30 || due.length > 30 };
}
