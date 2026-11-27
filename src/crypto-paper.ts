import { sourceSetting } from './source-config.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { now, saveEvidence, type openStore, type Watch } from './store.js';

export const cryptoPaperSource = 'local-paper/crypto-5m';
export const cryptoPaperPlan = { kind: 'crypto_paper_5m' } as const;
export const cryptoPaperTitle = 'BTC、ETH 5 分钟模拟盘';
const assets = ['BTC', 'ETH'] as const;
const sides = ['UP', 'DOWN'] as const;
const paperBase = sourceSetting('PM_PAPER_URL');
const snapshotUrl = sourceSetting('PM_CRYPTO_SNAPSHOT_URL') + '/snapshot';
const shanghai = (time: number) => new Date(time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });

export const paperSignalFields: Record<string, string | null> = {
  RSI: null, MACD: 'histogram', ADX: null, ROC: null, MFI: null, CMF: null, RVOL: null,
};
type Rule = { id: string; field?: string; comparison: 'above' | 'below' | 'crosses_above' | 'crosses_below';
  threshold: number; confirmations: 1 | 2 };
export type PaperPolicy = { name: string; reason: string; sources: string[]; up: Rule[]; down: Rule[] };
type Indicator = { id: string; status: string; latest?: unknown; previous?: unknown };
export type IndicatorStatus = { symbol: string; interval: string; status: string; retrievedAt?: string;
  coverage?: { lastCloseAt?: string }; evidenceId?: string; indicators: Indicator[] };
export function validatePaperPolicy(input: unknown, allowedSources?: string[]): PaperPolicy {
  const p = input as PaperPolicy | null;
  const rules = (value: unknown): value is Rule[] => Array.isArray(value) && value.length >= 1 && value.length <= 3 &&
    value.every(rule => rule && typeof rule === 'object' && Object.hasOwn(paperSignalFields, rule.id) &&
      (rule.field ?? null) === paperSignalFields[rule.id] && Number.isFinite(rule.threshold) &&
      ['above', 'below', 'crosses_above', 'crosses_below'].includes(rule.comparison) &&
      (rule.confirmations === 1 || rule.confirmations === 2 && !rule.comparison.startsWith('crosses_')));
  if (!p || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 64 ||
      typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 500 ||
      !Array.isArray(p.sources) || new Set(p.sources).size < 2 || p.sources.length > 3 ||
      !p.sources.every(s => typeof s === 'string' && (!allowedSources || allowedSources.includes(s))) ||
      !rules(p.up) || !rules(p.down)) throw Error('Agent 没有产出可执行且有来源的指标规则。');
  const select = ({ id, field, comparison, threshold, confirmations }: Rule) => ({ id, field, comparison, threshold, confirmations });
  return { name: p.name.trim(), reason: p.reason.trim(), sources: p.sources, up: p.up.map(select), down: p.down.map(select) };
}

export function isCryptoPaper(watch: Watch) {
  if (watch.market_id !== null) return false;
  try { return JSON.parse(watch.notify_when)?.kind === cryptoPaperPlan.kind; } catch { return false; }
}

export function paperPolicy(watch: Watch) {
  return validatePaperPolicy(JSON.parse(watch.notify_when).policy);
}

type ThresholdStatus = 'met' | 'unmet' | 'unavailable';
type Threshold = { rule: Rule; current: number | null; previous: number | null; status: ThresholdStatus };

function indicatorThresholds(policy: PaperPolicy, group: IndicatorStatus | undefined, asset: string, at: number) {
  const close = Date.parse(group?.coverage?.lastCloseAt ?? '');
  const boundary = at - at % 300_000;
  const valid = group?.evidenceId && group.symbol === asset + 'USDT' && group.interval === '5m' &&
    group.status === 'ok' && (close === boundary - 1 || close === boundary);
  const checks = (rules: Rule[]): Threshold[] => rules.map(rule => {
    const indicator = valid ? group.indicators.find(i => i.id === rule.id && i.status === 'ok') : undefined;
    const value = (v: unknown) => {
      const field = rule.field && v && typeof v === 'object' ? (v as Record<string, unknown>)[rule.field] : v;
      return typeof field === 'number' && Number.isFinite(field) ? field : null;
    };
    const current = value(indicator?.latest), previous = value(indicator?.previous), n = rule.threshold;
    const crossed = rule.comparison.startsWith('crosses_');
    const above = rule.comparison === 'above' || rule.comparison === 'crosses_above';
    if (current === null || (crossed || rule.confirmations === 2) && previous === null) {
      return { rule, current, previous, status: 'unavailable' };
    }
    const compare = (x: number) => above ? x > n : x < n;
    const met = compare(current) && (crossed
      ? (above ? previous! <= n : previous! >= n)
      : rule.confirmations === 1 || compare(previous!));
    return { rule, current, previous, status: met ? 'met' : 'unmet' };
  });
  return { up: checks(policy.up), down: checks(policy.down), close: valid ? group.coverage?.lastCloseAt : undefined,
    indicatorEvidenceId: valid ? group.evidenceId : undefined };
}

function credentials() {
  const path = sourceSetting('PM_PAPER_CREDENTIALS_FILE') || join(homedir(), '.config/paper-trading/strategies/pm-telegram-crypto-wallet.json');
  const config = JSON.parse(readFileSync(path, 'utf8')) as { base_url: string; account_id: string; strategy_id: string; api_key: string; virtual_wallet_id: string };
  if (config.base_url !== paperBase || !config.account_id || !config.strategy_id || !config.api_key || !config.virtual_wallet_id?.startsWith('pwallet_')) {
    throw Error('缺少本机模拟盘专用钱包配置。');
  }
  return config;
}

async function fetchJson(url: string, signal: AbortSignal, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]) });
  const result = await response.json();
  if (!response.ok) {
    const code = result.error?.code ?? `HTTP ${response.status}`;
    const details = result.error?.details;
    const reasons = code === 'PAPER_EXECUTION_NOT_READY' ? [
      ...(details?.worker?.reasons ?? []), ...(details?.operations?.reasons ?? []),
      ...(details?.database?.status && details.database.status !== 'READY' ? [details.database.status] : []),
    ] : [];
    throw Error([code, ...reasons].join(' '));
  }
  return result;
}

function paperClient(signal: AbortSignal) {
  const config = credentials();
  async function request(path: string, body?: object, key?: string) {
    const headers = { Authorization: `Bearer ${config.api_key}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) };
    return (await fetchJson(paperBase + '/v1/paper' + path, signal,
      { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })).data;
  }
  return { config, request };
}

export async function cryptoPaperReady(signal: AbortSignal) {
  const { config, request } = paperClient(signal);
  const [ready, account] = await Promise.all([
    fetchJson(paperBase + '/v1/paper/execution-ready', signal), request('/accounts/' + config.account_id),
  ]);
  if (ready.data?.status !== 'READY' || !ready.data?.capabilities?.execution_clocks?.includes('ACTUAL') ||
      ready.data?.capabilities?.new_order !== true || account?.default_strategy_id !== config.strategy_id) {
    throw Error('本机模拟盘尚未确认 ACTUAL 撮合与专用账户。');
  }
  return config.account_id;
}

type Twap = { id: string; value: string; event_at_ms: number; received_at_ms: number; window_seconds: number; precision: string; feed_id: string };
type LiveAsset = {
  market?: { slug: string; market_id: string; condition_id: string; starts_at_ms: number; ends_at_ms: number;
    window_seconds: number; accepting_orders: boolean; minimum_shares: number;
    anchor?: Twap & { condition_id: string }; outcomes: Record<(typeof sides)[number], string> };
  last_twap?: Twap;
  quotes?: Record<string, { best_ask: string; condition_id: string; asset_id: string; received_at_ms: number; book_observed_at: string; hash: string }>;
  forecast?: { forecast_id: string; condition_id: string; p_up_raw: number | null; p_up_calibrated: number | null; target_at_ms: number; point_estimate: number | null };
};
type StrategyEvaluation = ReturnType<typeof evaluatePaperStrategy>;
type Leg = { side: string; key?: string; intentId?: string | number; status: string; filled?: string | number;
  error?: string; marketStart?: number; evaluation?: StrategyEvaluation };
type PaperOrder = { intent_id?: string | number; status: string; accounting_applied?: boolean; last_error?: string;
  result?: { status?: string; filled_size?: string | number; reason?: string } };
export type CryptoPaperRun = { accountId: string | null; outcomes: { asset: string; slug?: string; twap?: Twap;
  anchor?: Twap; forecast?: LiveAsset['forecast']; decision?: string; evaluation?: StrategyEvaluation; legs: Leg[] }[] };

export function evaluatePaperStrategy(policy: PaperPolicy, asset: string, group: IndicatorStatus | undefined,
  market: LiveAsset['market'], twap: Twap | undefined, at: number) {
  const indicators = indicatorThresholds(policy, group, asset, at);
  const anchor = market?.anchor;
  const exact = (value?: string) => {
    if (!value || !/^\d+(?:\.\d{1,18})?$/.test(value)) return 0n;
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(18, '0'));
  };
  const price = exact(twap?.value), opening = exact(anchor?.value);
  const twapValid = market && market.slug === `${asset.toLowerCase()}-updown-5m-${Math.floor(market.starts_at_ms / 1000)}` &&
    market.window_seconds === 60 && market.ends_at_ms - market.starts_at_ms === 300_000 &&
    at >= market.starts_at_ms && at < market.ends_at_ms &&
    anchor && anchor.condition_id === market.condition_id && anchor.event_at_ms === market.starts_at_ms &&
    anchor.precision === 'exact_e18' && anchor.received_at_ms >= anchor.event_at_ms && anchor.received_at_ms <= at &&
    twap && twap.window_seconds === 60 && twap.precision === 'exact_e18' &&
    twap.feed_id === `rtds:crypto_prices_twap_sixty:${asset.toLowerCase()}/usd` && twap.event_at_ms >= market.starts_at_ms &&
    twap.event_at_ms <= twap.received_at_ms && twap.received_at_ms <= at && at - twap.event_at_ms <= 6500 &&
    price > 0n && opening > 0n;
  const twapDirection = !twapValid ? undefined : price >= opening ? 'UP' : 'DOWN';
  const state = (checks: Threshold[]) => checks.some(rule => rule.status === 'unmet') ? 'unmet'
    : checks.some(rule => rule.status === 'unavailable') ? 'unavailable' : 'met';
  const up = state(indicators.up), down = state(indicators.down);
  const indicatorSide = up === 'met' && down === 'unmet' ? 'UP' : down === 'met' && up === 'unmet' ? 'DOWN' : undefined;
  const side = indicatorSide && indicatorSide === twapDirection ? indicatorSide : undefined;
  const reason = side ? 'STRATEGY_TRIGGERED'
    : up === 'met' && down === 'met' ? 'CONFLICT'
      : up === 'unavailable' || down === 'unavailable' ? 'INDICATORS_UNAVAILABLE'
        : !indicatorSide ? 'THRESHOLDS_UNMET' : !twapDirection ? 'TWAP_UNAVAILABLE' : 'TWAP_OPPOSED';
  return { ...indicators, at, marketStart: market?.starts_at_ms, currentTwap: twapValid ? twap?.value : undefined,
    openingTwap: twapValid ? anchor?.value : undefined, twapAt: twapValid ? twap?.event_at_ms : undefined,
    indicatorSide, twapDirection, side, reason } as const;
}

function orderReceipt(leg: Leg, order: PaperOrder | undefined): Leg {
  if (!order?.accounting_applied || !['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(order.status)) return leg;
  return { ...leg, intentId: order.intent_id ?? leg.intentId, status: order.result?.status ?? order.status,
    filled: order.result?.filled_size ?? (order.status !== 'COMPLETED' ? '0' : undefined),
    error: order.result?.reason ?? order.last_error };
}

export async function refreshCryptoPaper(legs: Leg[], signal: AbortSignal) {
  const { request } = paperClient(signal);
  return Promise.all(legs.filter(leg => leg.intentId && leg.filled == null).map(async leg => {
    try {
      const latest = orderReceipt(leg, await request('/orders/' + leg.intentId));
      Object.assign(leg, latest);
      return latest;
    } catch { return leg; }
  }));
}

export async function runCryptoPaper(db: ReturnType<typeof openStore>, watch: Watch, occurrence: string,
  readSignals: () => Promise<IndicatorStatus[]>, signal: AbortSignal): Promise<CryptoPaperRun> {
  const { config, request } = paperClient(signal);
  const active = () => !signal.aborted && !!db.prepare("SELECT 1 FROM watches WHERE id=? AND version=? AND status='active' AND expires_at>?")
    .get(watch.id, watch.version, now());
  const age = (at: number, max: number) => Date.now() - at >= 0 && Date.now() - at <= max;
  const policy = paperPolicy(watch);
  const marketKey = (condition: string) => 'tg-crypto-' + createHash('sha256').update([config.account_id, condition].join('/')).digest('hex');
  const priorIntent = db.prepare('SELECT 1 FROM evidence WHERE id=?');
  const catalogs = new Map<string, { lookup: ReturnType<typeof request>; retryAt: number }>();
  function prepareMarket(slug: string) {
    const cached = catalogs.get(slug);
    if (cached && Date.now() < cached.retryAt) return cached.lookup;
    const entry = { lookup: request('/retail/markets/' + encodeURIComponent(slug)), retryAt: Infinity };
    catalogs.set(slug, entry);
    entry.lookup.catch(() => { entry.retryAt = Date.now() + 5000; });
    return entry.lookup;
  }
  const snapshot = async () => {
    const live: { mode: string; assets: Record<(typeof assets)[number], LiveAsset> } = await fetchJson(snapshotUrl, signal);
    if (live.mode !== 'live') throw Error('TWAP 来源未返回实时行情。');
    return live.assets;
  };
  async function trade(asset: (typeof assets)[number], market: NonNullable<LiveAsset['market']>,
    side: (typeof sides)[number], group: IndicatorStatus, trigger: StrategyEvaluation): Promise<Leg> {
    if (!market.accepting_orders || market.ends_at_ms - Date.now() <= 12_000) {
      return { side, status: 'MARKET_UNAVAILABLE', evaluation: trigger };
    }
    // This endpoint registers a rolling market with Paper's existing catalog and worker.
    let catalog;
    try { catalog = await prepareMarket(market.slug); }
    catch (error) { return { side, status: 'PAPER_MARKET_UNAVAILABLE', evaluation: trigger,
      error: error instanceof Error ? error.message : String(error) }; }
    if (catalog?.condition_id !== market.condition_id || !sides.every(side =>
      catalog.outcomes?.some((option: { asset_id: string; name: string }) =>
        option.asset_id === market.outcomes[side] &&
        [side, side === 'UP' ? 'YES' : 'NO'].includes(option.name?.toUpperCase())))) {
      return { side, status: 'PAPER_MARKET_IDENTITY_MISMATCH', evaluation: trigger };
    }
    const token = market.outcomes[side];
    const maxBookAgeMs = 1000;
    let paperBook;
    try {
      const [, quotes] = await Promise.all([cryptoPaperReady(signal),
        request('/retail/quotes?asset_ids=' + encodeURIComponent(token))]);
      paperBook = quotes.items?.find((item: { asset_id: string }) => item.asset_id === token);
    } catch (error) {
      return { side, status: 'PAPER_EXECUTION_UNAVAILABLE', evaluation: trigger,
        error: error instanceof Error ? error.message : String(error) };
    }
    // Re-read fresh TWAP and quotes if discovery consumed the original quote's latency budget.
    const latest = (await snapshot())?.[asset];
    const quoteTwap = latest?.last_twap, evaluatedAt = Date.now();
    const evaluation = evaluatePaperStrategy(policy, asset, group, latest?.market, quoteTwap, evaluatedAt);
    if (!active() || latest?.market?.condition_id !== market.condition_id || evaluation.side !== side) {
      return { side, status: 'STRATEGY_CLEARED', evaluation };
    }
    if (!paperBook?.state_ready || !paperBook.checkpoint_id ||
        !age(Date.parse(paperBook.book_source_observed_at), maxBookAgeMs) ||
        !age(Date.parse(paperBook.book_observed_at), maxBookAgeMs)) {
      return { side, status: 'PAPER_BOOK_NOT_READY', evaluation };
    }
    const quote = latest?.quotes?.[token];
    if (!latest.market.accepting_orders || !/^\d+$/.test(token) || !quote ||
        quote.condition_id !== market.condition_id || quote.asset_id !== token ||
        !age(quote.received_at_ms, 4500) || !age(Date.parse(quote.book_observed_at), 4500) ||
        !(Number(quote.best_ask) > 0 && Number(quote.best_ask) < 1) ||
        !(market.minimum_shares > 0 && market.minimum_shares <= 20) || market.ends_at_ms - Date.now() <= 8000) {
      return { side, status: 'QUOTE_OR_MARKET_UNAVAILABLE', evaluation };
    }
    const key = marketKey(market.condition_id);
    const payload = { account_id: config.account_id, strategy_id: config.strategy_id, asset_id: token,
      market_id: market.market_id, side: 'BUY', time_in_force: 'FOK', amount_unit: 'SHARES',
      size: String(market.minimum_shares), limit_price: quote.best_ask, execution_clock: 'ACTUAL', max_book_age_ms: maxBookAgeMs,
      cash_limit: String(market.minimum_shares), expires_at: new Date(Math.min(market.ends_at_ms, Date.now() + 20_000)).toISOString() };
    const claimed = db.prepare('INSERT OR IGNORE INTO evidence(id,source,retrieved_at,data) VALUES (?,?,?,?)')
      .run(key, cryptoPaperSource, now(), JSON.stringify({ kind: 'crypto_paper_intent', watchId: watch.id, payload,
        conditionId: market.condition_id, twap: quoteTwap, anchor: latest.market.anchor, quote, side,
        paperCheckpoint: { id: paperBook.checkpoint_id, sourceAt: paperBook.book_source_observed_at, observedAt: paperBook.book_observed_at },
        policy, indicatorEvidenceId: evaluation.indicatorEvidenceId, evaluation })).changes;
    const lookup = '/orders/by-key/' + key + '?account_id=' + config.account_id;
    let submitted: { intent_id?: string | number } | undefined;
    let error: string | undefined;
    if (claimed) {
      try { submitted = await request('/orders', payload, key); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    }
    const until = Date.now() + 9000;
    let order: PaperOrder | undefined;
    do {
      try { order = submitted?.intent_id ? await request('/orders/' + submitted.intent_id) : (await request(lookup)).order; }
      catch { /* An unavailable lookup leaves the existing intent's outcome unknown. */ }
      if (order && ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(order.status) && order.accounting_applied === true) break;
      if ((!submitted?.intent_id && error?.startsWith('PAPER_') && !order) || Date.now() >= until) break;
      await delay(700, undefined, { signal });
    } while (Date.now() < until);
    return orderReceipt({ side, key, intentId: order?.intent_id ?? submitted?.intent_id,
      status: submitted?.intent_id || order ? 'PENDING' : error ? 'SUBMIT_UNCONFIRMED' : 'UNKNOWN',
      error, evaluation }, order);
  }
  const until = Math.min(Date.parse(occurrence) + 297_000, Date.parse(watch.expires_at));
  let context: Awaited<ReturnType<typeof snapshot>> | undefined;
  let refreshed = 0;
  let revision = '';
  const attempted = new Map<string, number>();
  const previousMarkets = new Set<string>();
  const last = new Map<string, CryptoPaperRun['outcomes'][number]>();
  const receipts = new Map<string, Map<number, Leg[]>>();
  const pending = new Map<string, Promise<void>>();
  while (active() && Date.now() < until) {
    const turn = Date.now();
    try {
      const prices = await fetchJson(new URL('/prices?after=' + encodeURIComponent(revision), snapshotUrl).href, signal);
      revision = typeof prices.revision === 'string' ? prices.revision : '';
      const marketStart = turn - turn % 300_000;
      if (!context || (turn - refreshed >= 12_000 && assets.some(asset =>
          context?.[asset]?.market?.starts_at_ms !== marketStart || !context?.[asset]?.market?.anchor ||
          !context?.[asset]?.forecast))) {
        context = await snapshot();
        refreshed = Date.now();
      }
      const signals = await readSignals();
      for (const asset of assets) {
        const input = context[asset], twap = prices.assets?.[asset]?.last_twap as Twap | undefined;
        const group = signals.find(x => x.symbol === asset + 'USDT');
        const market = input?.market;
        if (market && market.starts_at_ms === marketStart && market.ends_at_ms === marketStart + 300_000 &&
            market.slug === `${asset.toLowerCase()}-updown-5m-${marketStart / 1000}`) {
          void prepareMarket(market.slug);
          if (market.ends_at_ms - turn <= 75_000) {
            void prepareMarket(`${asset.toLowerCase()}-updown-5m-${market.ends_at_ms / 1000}`);
          }
        }
        const evaluation = evaluatePaperStrategy(policy, asset, group, market, twap, Date.now());
        const side = evaluation.side;
        last.set(asset, { asset, slug: market?.slug, twap, anchor: market?.anchor,
          forecast: input?.forecast, legs: [], evaluation,
          decision: market && previousMarkets.has(market.condition_id) ? '执行｜这个市场已提交过模拟单' : undefined });
        if (pending.has(asset) || !side || !group || !market ||
            (attempted.get(market.condition_id) ?? 0) > Date.now()) continue;
        if (priorIntent.get(marketKey(market.condition_id))) {
          previousMarkets.add(market.condition_id);
          attempted.set(market.condition_id, Infinity);
          continue;
        }
        attempted.set(market.condition_id, Date.now() + 15_000);
        const job = trade(asset, market, side, group, evaluation)
          .catch((error): Leg => ({ side, status: 'ERROR', evaluation,
            error: error instanceof Error ? error.message : String(error) }))
          .then(leg => {
            if (leg.key) attempted.set(market.condition_id, Infinity);
            else if (leg.status === 'PAPER_BOOK_NOT_READY' || leg.status === 'PAPER_EXECUTION_UNAVAILABLE')
              attempted.set(market.condition_id, Date.now() + 2000);
            const assetReceipts = receipts.get(asset) ?? new Map<number, Leg[]>();
            assetReceipts.set(market.starts_at_ms, [{ ...leg, marketStart: market.starts_at_ms }]);
            receipts.set(asset, assetReceipts);
          })
          .finally(() => { pending.delete(asset); });
        pending.set(asset, job);
      }
    } catch (error) {
      signal.throwIfAborted();
      for (const asset of assets) if (!last.has(asset)) last.set(asset, { asset, legs: [],
        decision: '行情或指标读取失败，观望 ' + (error instanceof Error ? error.message : String(error)) });
    }
    const sleep = Math.min(until - Date.now(), Math.max(50, 1000 - (Date.now() - turn)));
    if (sleep > 0) await delay(sleep, undefined, { signal });
  }
  await Promise.all(pending.values());
  const outcomes = assets.map(asset => {
    const outcome = last.get(asset) ?? { asset, legs: [], decision: '本轮未触发，观望' };
    const assetReceipts = receipts.get(asset);
    return assetReceipts ? { ...outcome, legs: [...assetReceipts.values()].flat() } : outcome;
  });
  return { accountId: config.account_id, outcomes };
}

export function finishCryptoPaper(db: ReturnType<typeof openStore>, watch: Watch, runId: string, occurrence: string,
  paper: CryptoPaperRun, analyses: IndicatorStatus[], issues: string[], previous: Leg[]) {
  const at = now();
  const data = { kind: 'crypto_paper_check', occurrence, policy: paperPolicy(watch), ...paper, analyses: analyses.map(a => ({
    ...a, indicators: a.indicators.map(({ id, status }) => ({ id, status })),
  })), issues, previous };
  const evidence = saveEvidence(db, cryptoPaperSource, data, at);
  const number = (value: number | string | null | undefined, threshold?: number | string) => {
    if (value == null) return '—';
    const format = (n: number | string) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
    return threshold !== undefined && String(value) !== String(threshold) && format(value) === format(threshold)
      ? String(value) : format(value);
  };
  const name = (rule: Rule) => rule.id === 'MACD' && rule.field === 'histogram' ? 'MACD 柱值'
    : rule.id === 'RSI' ? 'RSI(14)' : [rule.id, rule.field].filter(Boolean).join('.');
  const comparison = { above: '>', below: '<', crosses_above: '上穿', crosses_below: '下穿' } as const;
  const statusText = { met: '达标', unmet: '未达标', unavailable: '数据缺失' } as const;
  const instruction = (rule: Rule) => `${name(rule)} ${comparison[rule.comparison]} ${rule.threshold}${rule.confirmations === 2 ? '（两根）' : ''}`;
  const check = ({ rule, status }: Threshold) => `${instruction(rule)} ${statusText[status]}`;
  const values = ({ rule, current, previous }: Threshold) => `${name(rule)} ${number(current, rule.threshold)} / ${number(previous, rule.threshold)}`;
  const sideLabel = (side: string) => side === 'UP' ? 'Up' : 'Down';
  const twapGate = (evaluation: StrategyEvaluation, side: 'UP' | 'DOWN') => {
    const threshold = evaluation.openingTwap ? number(evaluation.openingTwap, evaluation.currentTwap) : '开盘价';
    const status = evaluation.twapDirection ? evaluation.twapDirection === side ? 'met' : 'unmet' : 'unavailable';
    return `TWAP ${side === 'UP' ? '≥' : '<'} ${threshold} ${statusText[status]}`;
  };
  const reasons = {
    CONFLICT: 'Up 和 Down 的技术指标同时达标，观望',
    INDICATORS_UNAVAILABLE: '所需收盘指标缺失或过期，观望',
    THRESHOLDS_UNMET: '技术指标阈值未全部达标，观望',
    TWAP_UNAVAILABLE: '技术指标达标，等待当场 TWAP 或开盘值',
    TWAP_OPPOSED: '技术指标达标，实时 TWAP 未确认同向，观望',
  } as const;
  const orderStatus: Record<string, string> = { DATA_NOT_READY: '模拟盘数据未就绪', PENDING: '已提交，等待撮合',
    PAPER_MARKET_UNAVAILABLE: '模拟盘市场数据缺失', MARKET_UNAVAILABLE: '市场暂不可下单',
    PAPER_BOOK_NOT_READY: '等待模拟盘有效盘口', PAPER_EXECUTION_UNAVAILABLE: '模拟盘暂不可下单',
    QUOTE_OR_MARKET_UNAVAILABLE: '盘口或市场未通过校验', STRATEGY_CLEARED: '提交前复核未达标' };
  const orderError: Record<string, string> = { actual_clock_integrity_unverified: '交易所时钟校验未通过',
    actual_clock_deadline_expired: '模拟单已过有效期', PAPER_CATALOG_UNAVAILABLE: '市场目录查询失败' };
  const lines = ['BTC / ETH 5 分钟模拟盘', shanghai(Date.parse(at)) + ' 北京时间', '策略 ' + data.policy.name];
  if (issues.length) lines.push(...issues.map(issue => '本轮异常｜' + issue));
  const orderLine = (leg: Leg) => `${leg.marketStart ? shanghai(leg.marketStart).slice(11, 16) + ' 场 ' : ''}${sideLabel(leg.side)}｜${orderStatus[leg.status] ?? leg.status}${leg.filled != null ? `｜成交 ${leg.filled} 份` : ''}${leg.intentId ? `｜模拟单 #${leg.intentId}` : ''}${leg.error ? `｜${orderError[leg.error] ?? leg.error}` : ''}`;
  for (const outcome of paper.outcomes) {
    const { asset, legs, evaluation } = outcome;
    lines.push('', asset);
    if (evaluation) {
      const { close, up, down, side, reason, currentTwap, openingTwap, twapAt } = evaluation;
      const distinct = new Map([...up, ...down].map(item => [name(item.rule), item]));
      if (close) lines.push(`K 线收盘 ${shanghai(Date.parse(close)).slice(11, 16)}｜指标值（最新 / 前一根）`,
        [...distinct.values()].map(values).join('｜'));
      if (twapAt !== undefined) lines.push(`Chainlink 60 秒 TWAP ${number(currentTwap, openingTwap)} USD｜开盘 ${number(openingTwap, currentTwap)} USD｜观测 ${shanghai(twapAt).slice(11)}`);
      lines.push(`Up｜${[...up.map(check), twapGate(evaluation, 'UP')].join('，')}`,
        `Down｜${[...down.map(check), twapGate(evaluation, 'DOWN')].join('，')}`,
        `判定｜${side ? sideLabel(side) + ' 策略阈值全部达标' : reasons[reason === 'STRATEGY_TRIGGERED' ? 'THRESHOLDS_UNMET' : reason]}`);
    } else {
      lines.push(`Up｜${data.policy.up.map(instruction).join(' 且 ')}，TWAP ≥ 开盘`,
        `Down｜${data.policy.down.map(instruction).join(' 且 ')}，TWAP < 开盘`,
        '判定｜本轮无可核对的策略输入，观望');
    }
    if (outcome.decision) lines.push(outcome.decision);
    for (const leg of legs) {
      lines.push(orderLine(leg));
      const entry = leg.evaluation;
      if (entry?.side === leg.side) {
        const rules = entry.side === 'UP' ? entry.up : entry.down;
        lines.push(`触发 ${shanghai(entry.at).slice(11)}｜${rules.map(item => `${values(item)}（${instruction(item.rule)}）`).join('｜')}｜TWAP ${number(entry.currentTwap, entry.openingTwap)} ${entry.side === 'UP' ? '≥' : '<'} ${number(entry.openingTwap, entry.currentTwap)}`);
      }
    }
    if ('slug' in outcome && outcome.slug) lines.push(sourceSetting('PM_POLYMARKET_WEB_URL') + '/event/' + outcome.slug);
  }
  if (previous.length) lines.push('', '上一轮模拟单回执', ...previous.map(orderLine));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND status='running'")
      .run(paper.outcomes.some(o => !o.evaluation?.close || !o.evaluation.twapDirection ||
        o.evaluation.reason === 'INDICATORS_UNAVAILABLE' || o.legs.some(l => !l.intentId || l.filled == null)) ||
        issues.length ? 'partial' : 'complete', at, JSON.stringify({ ...data, evidenceId: evidence.evidenceId }), runId);
    db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
      .run(runId, watch.id, runId, occurrence, lines.join('\n'), at);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
