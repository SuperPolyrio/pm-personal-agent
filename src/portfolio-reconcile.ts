import { sourceSetting } from './source-config.js';
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { resolveMarket } from './data.js';
import type { createPolymarketPublicReader } from './polymarket-public.js';
import type { EvidenceRow } from './source-evidence.js';

type Read = ReturnType<typeof createPolymarketPublicReader>['read'];
type Query = Parameters<Read>[0];
type Host = {
  read: Read;
  resolveMarket: typeof resolveMarket;
  loadEvidence: (id: string) => EvidenceRow | undefined;
  saveEvidence: (source: string, data: unknown, retrievedAt: string) => EvidenceRow;
};
type Row = Record<string, unknown>;
type Ref = { evidenceId: string; rowIndex: number };
type Sourced = { row: Row; ref: Ref; sequence: number };
const address = /^0x[0-9a-f]{40}$/i;
const hash = /^0x[0-9a-f]{64}$/i;
const tokenId = /^\d{1,78}$/;
const safeId = /^[a-z0-9_.:-]{1,110}$/i;
const pageSize = 25;
const pageBudget = 8;
const marketBudget = 8;
const precision = 10n ** 18n;
const micro = precision / 1_000_000n;
const receiptKind = 'polymarket_portfolio_support_v1';
const publicCurrency = 'USDC';
const str = { type: 'string' } as const;
const object = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);
const match = (x: unknown, regex: RegExp) => typeof x === 'string' && regex.test(x) ? x : undefined;
const hex = (x: unknown, regex = hash) => match(x, regex)?.toLowerCase();
const iso = (ms: number) => new Date(ms).toISOString();
const txLink = (tx?: string) => tx && sourceSetting('PM_POLYGONSCAN_URL') + '/tx/' + tx;

function timestamp(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const s = String(value);
  const ms = /^\d{10}$/.test(s) ? Number(s) * 1000 : /^\d{13}$/.test(s) ? Number(s) : zonedTime(s);
  return ms !== undefined && Number.isFinite(ms) ? ms : undefined;
}
function zonedTime(s: string) {
  const parts = /^(\d{4})-(\d\d)-(\d\d)T\d\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:?\d\d)$/.exec(s);
  if (!parts || new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3])).toISOString().slice(0, 10) !== s.slice(0, 10))
    return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && ms >= 1000 ? ms : undefined;
}

function decimal(value: unknown): bigint | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parts = /^(\d{1,24})(?:\.(\d{1,24}))?(?:e([+-]?\d{1,2}))?$/i.exec(String(value));
  if (!parts) return undefined;
  const fraction = parts[2] ?? '';
  const exponent = 18 + Number(parts[3] ?? 0) - fraction.length;
  const digits = BigInt(parts[1] + fraction);
  if (exponent >= 0) return exponent <= 42 ? digits * 10n ** BigInt(exponent) : undefined;
  const divisor = 10n ** BigInt(-exponent);
  return digits % divisor === 0n ? digits / divisor : undefined;
}
function display(value: bigint) {
  const sign = value < 0n ? '-' : '';
  const n = value < 0n ? -value : value;
  return sign + String(n / precision) + (n % precision ? '.' + String(n % precision).padStart(18, '0').replace(/0+$/, '') : '');
}
const json = (value: unknown) => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? display(entry) : entry);
const times = (rows: Sourced[]) => {
  const values = rows.flatMap(({ row }) => {
    const ms = timestamp(row.timestamp);
    return ms === undefined ? [] : [ms];
  });
  return values.length ? { oldest: iso(Math.min(...values)), newest: iso(Math.max(...values)) } : null;
};
const multiply = (a: bigint, b: bigint) => a * b / precision;
const absolute = (n: bigint) => n < 0n ? -n : n;
const indexValue = (x: unknown) => (typeof x === 'string' || typeof x === 'number') && /^\d{1,10}$/.test(String(x)) ? Number(x) : undefined;

async function pages(read: Read, query: Query, signal: AbortSignal) {
  const rows: Sourced[] = [];
  const seenCursors = new Set<string>();
  const seenPages = new Set<string>();
  const metadata: { evidenceId: string; retrievedAt: string; source: string; status: unknown; rowCount: number; hasMore: unknown }[] = [];
  let cursor: string | undefined;
  let reason = 'page_budget';
  let rejectedRows = 0;
  if (query.start !== undefined && query.end !== undefined && query.start > query.end)
    return { rows, coverage: { status: 'complete', reason: 'no_source_seconds_in_window', filters: query,
      pages: metadata, cursor, observedRange: null, rejectedRows } };
  for (let i = 0; i < pageBudget; i++) {
    const result = await read({ ...query, limit: pageSize, cursor }, signal);
    const raw = Array.isArray(result.result) ? result.result : [];
    metadata.push({ evidenceId: result.evidenceId, retrievedAt: result.retrievedAt, source: result.source,
      status: result.status, rowCount: raw.length, hasMore: result.pagination?.has_more });
    if (result.status !== 'ok' && result.status !== 'empty') { reason = result.status as string; break; }
    // Profile metadata can change between reads. It does not identify wallet ledger rows.
    const signature = createHash('sha256').update(JSON.stringify(raw.map(x => object(x) ? [
      x.proxy_wallet, x.condition_id, x.token_id, x.type, x.side, x.timestamp, x.transaction_hash,
      x.fill_id, x.log_index, x.size, x.price, x.usdc_size, x.current_size, x.status,
    ] : x))).digest('hex');
    if (raw.length && seenPages.has(signature)) { reason = 'repeated_page'; break; }
    seenPages.add(signature);
    raw.forEach((row, rowIndex) => {
      const ms = object(row) ? timestamp(row.timestamp) : undefined;
      if (!object(row) || hex(row.proxy_wallet, address) !== query.id
        || query.condition_id && hex(row.condition_id) !== query.condition_id
        || query.start !== undefined && (ms === undefined || ms < query.start * 1000)
        || query.end !== undefined && (ms === undefined || ms > query.end * 1000)) { rejectedRows++; return; }
      rows.push({ row, ref: { evidenceId: result.evidenceId, rowIndex }, sequence: rows.length });
    });
    const next = result.pagination?.next_cursor;
    const more = result.pagination?.has_more;
    if (next === null && more === false) { reason = rejectedRows ? 'row_identity_or_window_mismatch' : 'cursor_exhausted'; cursor = undefined; break; }
    if (typeof next !== 'string' || !next || next.length > 4096 || more !== true || !raw.length) {
      reason = 'invalid_pagination'; break;
    }
    if (seenCursors.has(next)) { reason = 'repeated_cursor'; break; }
    seenCursors.add(next);
    cursor = next;
  }
  return { rows, coverage: {
    status: reason === 'cursor_exhausted' ? 'complete' : rows.length ? 'partial' : 'unknown',
    reason, filters: query, pages: metadata, cursor, observedRange: times(rows), rejectedRows,
    ...(cursor ? { continuation: '缩小钱包对账时间窗或指定合约以重新计算。原始分页可给 read_polymarket_public 传同一筛选和 cursor。' } : {}),
  } };
}

type Side = 'BUY' | 'SELL';
type Receipt = {
  kind: 'fill' | 'order' | 'redemption'; source: 'polymarket_official_export' | 'polygon_receipt';
  wallet: string; conditionId: string; tokenId: string; timestamp: string;
  transactionHash?: string; logIndex?: number; fillId?: string; orderId?: string; side?: Side;
  currency?: string; shares?: string; price?: string; cashAmount?: string; cashBasis?: 'gross' | 'net';
  feeAmount?: string; feeCurrency?: string; originalShares?: string; filledShares?: string;
  orderStatus?: string; creditedAmount?: string;
};
function currency(value: unknown) {
  const code = match(value, /^[A-Z][A-Z0-9.]{1,15}$/i)?.toUpperCase();
  return code === 'PUSD' ? 'pUSD' : code === 'USDC.E' ? 'USDC.e' : code;
}
function receipt(value: unknown, wallet: string, conditionId: string | undefined, cutoff: number): Receipt | undefined {
  if (!object(value) || hex(value.wallet, address) !== wallet) return;
  const condition = hex(value.conditionId);
  const token = match(value.tokenId, tokenId);
  const ms = typeof value.timestamp === 'string' ? zonedTime(value.timestamp) : undefined;
  const { kind, source } = value;
  if (!condition || conditionId && condition !== conditionId || !token || ms === undefined || ms >= cutoff
    || (kind !== 'fill' && kind !== 'order' && kind !== 'redemption')
    || (source !== 'polymarket_official_export' && source !== 'polygon_receipt')) return;
  const base: Receipt = { kind, source, wallet, conditionId: condition, tokenId: token, timestamp: iso(ms) };
  const orderId = match(value.orderId, safeId);
  const tx = hex(value.transactionHash);
  const logIndex = indexValue(value.logIndex);
  if (kind === 'order') {
    const original = decimal(value.originalShares), filled = decimal(value.filledShares);
    if (source === 'polygon_receipt' && (!tx || logIndex === undefined) || !orderId || original === undefined || original <= 0n
      || filled === undefined || filled > original) return;
    const orderStatus = match(value.orderStatus, /^(OPEN|FILLED|PARTIALLY_FILLED|CANCELLED|REJECTED|EXPIRED)$/);
    if (orderStatus === 'FILLED' && filled !== original || orderStatus === 'PARTIALLY_FILLED' && !(filled > 0n && filled < original)
      || orderStatus === 'REJECTED' && filled !== 0n) return;
    return { ...base, orderId, transactionHash: tx, logIndex, originalShares: display(original), filledShares: display(filled), orderStatus };
  }
  const fillId = match(value.fillId, safeId);
  const denomination = currency(value.currency);
  const shares = decimal(value.shares);
  if (!tx || !denomination || (logIndex === undefined && !fillId)) return;
  const trade = { ...base, transactionHash: tx, logIndex, fillId, currency: denomination,
    shares: shares === undefined ? undefined : display(shares) };
  if (kind === 'redemption') {
    const credited = decimal(value.creditedAmount);
    if (source === 'polygon_receipt' && logIndex === undefined || shares === 0n
      || value.creditedAmount !== undefined && (source !== 'polygon_receipt' || credited === undefined)) return;
    return { ...trade, creditedAmount: credited === undefined ? undefined : display(credited) };
  }
  const { side, cashBasis } = value;
  const price = decimal(value.price), cash = decimal(value.cashAmount), fee = decimal(value.feeAmount);
  const feeCurrency = currency(value.feeCurrency);
  if (side !== 'BUY' && side !== 'SELL' || shares === undefined || shares <= 0n || price === undefined || price > precision
    || (value.cashAmount !== undefined && (cash === undefined || cashBasis !== 'gross' && cashBasis !== 'net'))
    || (value.feeAmount !== undefined && (fee === undefined || !feeCurrency))) return;
  if (cash !== undefined && cashBasis === 'net' && feeCurrency === denomination && fee !== undefined
    && side === 'BUY' && fee > cash) return;
  return { ...trade, side, price: display(price), orderId, cashAmount: cash === undefined ? undefined : display(cash),
    cashBasis: cash !== undefined && (cashBasis === 'gross' || cashBasis === 'net') ? cashBasis : undefined,
    feeAmount: fee === undefined ? undefined : display(fee), feeCurrency };
}

type LedgerEntry = {
  action: string; time: number; condition?: string; token?: string; tx?: string; logIndex?: number; id?: string;
  title?: string; denomination: string; shares?: bigint; price?: bigint; cash?: bigint; refs: Ref[];
  feed: 'activity' | 'trades' | 'receipt'; sequence: number; support?: Receipt;
};
type Issue = { reason: string; conditionId?: string; tokenId?: string; transactionHash?: string; evidence?: Ref[]; [key: string]: unknown };
function ledgerEntry(item: Sourced, feed: 'activity' | 'trades'): LedgerEntry | undefined {
  const { row, ref, sequence } = item;
  const time = timestamp(row.timestamp);
  if (time === undefined) return;
  const trade = feed === 'trades' || row.type === 'TRADE';
  return {
    action: trade ? match(row.side, /^(BUY|SELL)$/) ?? 'TRADE_UNCLASSIFIED'
      : match(row.type, /^[A-Z_]{1,48}$/) ?? 'UNKNOWN',
    time, condition: hex(row.condition_id), token: match(row.token_id, tokenId), tx: hex(row.transaction_hash),
    id: match(row.fill_id, safeId), logIndex: indexValue(row.log_index), denomination: publicCurrency,
    shares: decimal(row.size), price: decimal(row.price), cash: decimal(row.usdc_size),
    refs: [ref], feed, sequence, title: typeof row.title === 'string' ? row.title.slice(0, 300) : undefined,
  };
}
const isFill = (line: LedgerEntry) => line.action === 'BUY' || line.action === 'SELL';
const validFill = (line: LedgerEntry) => isFill(line) && !!line.condition && !!line.token
  && line.shares !== undefined && line.shares > 0n && line.price !== undefined && line.price <= precision;
const shape = (line: LedgerEntry) => json([line.tx, line.condition, line.token, line.action, line.time, line.shares, line.price]);
const strong = (line: LedgerEntry) => [
  ...(line.tx && line.logIndex !== undefined ? [json([line.tx, line.logIndex, line.condition, line.token, line.action])] : []),
  ...(line.id ? [json([line.id, line.condition, line.token, line.action])] : []),
];
const leg = (line: LedgerEntry) => line.tx && json([line.tx, line.condition, line.token, line.action]);
const sameTrade = (a: LedgerEntry, b: LedgerEntry) =>
  a.time === b.time && a.shares === b.shares && a.price === b.price && (!a.tx || !b.tx || a.tx === b.tx);
const distinctIdentity = (a: LedgerEntry, b: LedgerEntry) =>
  a.tx === b.tx && a.logIndex !== undefined && b.logIndex !== undefined && a.logIndex !== b.logIndex
  || a.id !== undefined && b.id !== undefined && a.id !== b.id;
function reportIssue(reason: string, line: LedgerEntry): Issue {
  return { reason, conditionId: line.condition, tokenId: line.token, transactionHash: line.tx, evidence: line.refs,
    time: iso(line.time), action: line.action, shares: line.shares, currency: line.denomination, observedAmount: line.cash };
}

function joinLedger(activity: Sourced[], trades: Sourced[], supports: { row: Receipt; ref: Ref }[], issues: Issue[]) {
  let exactDuplicates = 0, crossSourceMatches = 0, ambiguous = 0, importedMatches = 0;
  function unique(rows: Sourced[], feed: 'activity' | 'trades') {
    const ledger: LedgerEntry[] = [];
    const keys = new Map<string, LedgerEntry>();
    const projections = new Map<string, LedgerEntry[]>();
    for (const item of rows) {
      const line = ledgerEntry(item, feed);
      if (!line) continue;
      const identities = strong(line);
      const prior = identities.map(key => keys.get(key)).find(Boolean);
      if (prior) {
        prior.refs.push(...line.refs);
        if (!sameTrade(prior, line) || prior.cash !== line.cash) {
          issues.push(reportIssue('same_identity_conflicting_values', line));
          prior.action = 'CONFLICT';
        } else exactDuplicates++;
      } else {
        ledger.push(line);
        if (!identities.length && line.tx && (validFill(line) || line.action === 'REDEEM')) {
          const key = json([shape(line), line.cash]);
          const group = projections.get(key) ?? [];
          group.push(line);
          projections.set(key, group);
        }
      }
      for (const key of identities) keys.set(key, prior ?? line);
    }
    for (const group of projections.values()) if (group.length > 1) {
      issues.push({ ...reportIssue('same_source_projection_multiplicity_unverified', group[0]),
        rowCount: group.length, evidence: group.flatMap(line => line.refs) });
    }
    return ledger;
  }
  const ledger = unique(activity, 'activity');
  const matched = new Set<LedgerEntry>();
  const activityFills = ledger.filter(validFill);
  for (const line of unique(trades, 'trades')) {
    if (!validFill(line)) { issues.push(reportIssue('invalid_public_trade', line)); continue; }
    const identities = strong(line);
    const exact = activityFills.filter(row => strong(row).some(key => identities.includes(key)));
    const same = exact.length ? exact : activityFills.filter(row => row.tx && shape(row) === shape(line) && !distinctIdentity(row, line));
    if (same.length === 1 && sameTrade(same[0], line) && !matched.has(same[0])) {
      same[0].refs.push(...line.refs);
      same[0].logIndex ??= line.logIndex;
      same[0].id ??= line.id;
      matched.add(same[0]);
      crossSourceMatches++;
    } else if (same.length || leg(line) && activityFills.some(row => leg(row) === leg(line) && !distinctIdentity(row, line))) {
      ambiguous++;
      // Same public projection with indistinguishable legs: preserve the activity multiplicity.
      for (const row of same) row.refs.push(...line.refs);
      issues.push(reportIssue('public_trade_leg_not_uniquely_aligned', line));
    } else ledger.push(line);
  }
  const publicEntries = [...ledger];
  const accepted: LedgerEntry[] = [];
  for (const { row, ref } of supports) {
    if (row.kind === 'order') continue;
    const line: LedgerEntry = {
      action: row.kind === 'redemption' ? 'REDEEM' : row.side!, time: Date.parse(row.timestamp),
      condition: row.conditionId, token: row.tokenId, tx: row.transactionHash, id: row.fillId, logIndex: row.logIndex,
      denomination: row.currency!, shares: decimal(row.shares), price: decimal(row.price),
      refs: [ref], support: row, feed: 'receipt', sequence: 0,
    };
    const identities = strong(line);
    const previous = accepted.find(entry => strong(entry).some(key => identities.includes(key)));
    if (previous) {
      const old = previous.support!;
      previous.refs.push(ref);
      if (json(old) === json(row)) exactDuplicates++;
      else {
        issues.push(reportIssue('conflicting_supplied_receipts', previous));
        previous.support = undefined;
      }
      continue;
    }
    accepted.push(line);
  }
  for (const line of accepted) {
    if (!line.support) continue;
    const sameLeg = publicEntries.filter(entry => leg(entry) === leg(line));
    const ids = strong(line);
    const exact = sameLeg.filter(entry => strong(entry).some(key => ids.includes(key)));
    const same = exact.length ? exact : sameLeg.filter(entry => entry.time === line.time &&
      (line.action === 'REDEEM' ? line.shares === undefined || line.shares === entry.shares
        : sameTrade(entry, line) && !distinctIdentity(entry, line)));
    if (same.length === 1 && same[0].time === line.time
      && (line.action === 'REDEEM' || sameTrade(same[0], line)) && !same[0].support) {
      const entry = same[0];
      entry.support = line.support;
      entry.denomination = line.denomination;
      entry.id ??= line.id;
      entry.logIndex ??= line.logIndex;
      entry.refs.push(...line.refs);
      importedMatches++;
    } else if (sameLeg.length) {
      issues.push(reportIssue('receipt_leg_not_uniquely_aligned', line));
      ambiguous++;
    } else ledger.push(line);
  }
  return { ledger, exactDuplicates, crossSourceMatches, ambiguous, importedMatches };
}

function fillAmounts(line: LedgerEntry) {
  const nominal = multiply(line.shares!, line.price!);
  const support = line.support;
  const receiptCash = decimal(support?.cashAmount);
  const fee = decimal(support?.feeAmount);
  const sameCurrencyFee = support?.feeCurrency === line.denomination ? fee : undefined;
  const buy = line.action === 'BUY';
  const gross = support?.cashBasis === 'gross' && receiptCash !== undefined ? receiptCash
    : support?.cashBasis === 'net' && receiptCash !== undefined && sameCurrencyFee !== undefined
      ? receiptCash + (buy ? -sameCurrencyFee : sameCurrencyFee)
      : line.denomination === publicCurrency && line.cash !== undefined && absolute(line.cash - nominal) <= micro ? line.cash : nominal;
  const net = support?.cashBasis === 'net' ? receiptCash
    : fee === undefined ? undefined : gross + (buy ? sameCurrencyFee ?? 0n : -(sameCurrencyFee ?? 0n));
  return { nominal, gross, net, fee, feeCurrency: fee !== undefined ? support?.feeCurrency : undefined,
    grossBasis: support?.cashBasis === 'gross' ? 'receipt_gross'
      : support?.cashBasis === 'net' && sameCurrencyFee !== undefined ? 'receipt_net_and_actual_fee'
        : line.denomination === publicCurrency && gross === line.cash ? 'activity_cash_matching_shares_times_price' : 'shares_times_price',
    receiptCash, receiptCashBasis: support?.cashBasis };
}

type Final = { resolution: Awaited<ReturnType<Read>>; tokens: Awaited<ReturnType<Read>> };
function outcome(final: Final | undefined, token?: string) {
  const result = final?.resolution.result;
  const rows = Array.isArray(result) ? result.filter(object) : [];
  const resolved = rows.filter(x => x.status === 'resolved');
  const ref = (Array.isArray(final?.tokens.result) ? final.tokens.result.filter(object) : [])
    .filter(row => row.token_id === token && rows.some(r => r.condition_id === row.condition_id));
  const tokenRow = ref.length === 1 ? ref[0] : undefined;
  const officialRatio = tokenRow?.resolved === true ? decimal(tokenRow.final_price) : undefined;
  const resolution = resolved.length === 1 ? resolved[0] : undefined;
  const resolutionTime = timestamp(resolution?.resolved_at ?? resolution?.last_update_timestamp);
  const index = indexValue(tokenRow?.outcome_index);
  const payout = Array.isArray(resolution?.payouts) && index !== undefined ? decimal(resolution.payouts[index]) : undefined;
  const reported = payout === undefined ? undefined : payout / 1_000_000n;
  const ratio = (reported === undefined || officialRatio === undefined || reported === officialRatio)
    && (officialRatio ?? reported ?? 0n) <= precision ? officialRatio ?? reported : undefined;
  return {
    status: resolution ? 'final' : rows.length && !resolved.length && tokenRow?.resolved !== true
      && rows.every(row => ['initialized', 'posed', 'active', 'proposed', 'challenged', 'reproposed', 'disputed', 'arbitration'].includes(String(row.status)))
      ? 'not_final' : 'unknown',
    resolutionTime, ratio: resolution ? ratio : undefined, outcome: tokenRow?.outcome, module: tokenRow?.module,
    oracleStatus: rows.map(x => x.status), source: resolution?.resolution_source, transactionHash: hex(resolution?.transaction_hash),
    evidenceIds: final ? [final.resolution.evidenceId, final.tokens.evidenceId] : [],
  } as const;
}
type Outcome = ReturnType<typeof outcome>;

function redemption(line: LedgerEntry, resolution: Outcome, duplicate: boolean) {
  const credited = decimal(line.support?.creditedAmount);
  const attributable = !duplicate && !!line.tx && !!line.condition && !!line.token && resolution.status === 'final'
    && resolution.ratio !== undefined && line.shares !== undefined && line.cash !== undefined
    && absolute(multiply(resolution.ratio, line.shares) - line.cash) <= micro;
  const supportedShares = decimal(line.support?.shares);
  return { shares: supportedShares ?? (attributable && line.shares! > 0n ? line.shares : undefined),
    activityAmount: line.cash, attributableAmount: attributable ? line.cash : undefined, credited,
    creditStatus: credited !== undefined ? 'documented_by_supplied_receipt' : 'unknown',
    eventStatus: attributable || credited !== undefined ? 'amount_attributed' : 'observed_allocation_unknown' };
}

type Totals = ReturnType<typeof emptyTotals>;
function emptyTotals() {
  return { fillCount: 0, buyShares: 0n, sellShares: 0n, grossBuys: 0n, grossSales: 0n,
    activityBuyCash: 0n, activitySellCash: 0n, activityCashMissing: 0, activityCashWithoutReceiptBasis: 0,
    knownActualFees: 0n, foreignFeeOutflow: 0n, unknownFeeFills: 0, feeUnknownGrossAmount: 0n, knownNetTradeCash: 0n, unknownNetTradeFills: 0,
    publicAttributedPayout: 0n, receiptCreditedPayout: 0n, payoutEvents: 0, eventsWithoutCredit: 0, unattributedPayoutAmount: 0n,
    unsupportedActivityCount: 0, unsupportedReportedCashMagnitude: 0n,
    grossRealized: 0n, netRealizedInCurrency: 0n, realizedWithGrossCost: 0, realizedWithNetCost: 0, disposals: 0,
    proceedsWithoutGrossCost: 0n, proceedsWithoutNetCost: 0n, grossUnrealized: 0n, netUnrealizedInCurrency: 0n,
    markedPositions: 0, positionsWithGrossMarkPnl: 0, positionsWithNetMarkPnl: 0, pendingPayoutKnown: 0n,
    positionsWithUnknownPendingPayout: 0 };
}
type Lot = { shares: bigint; currency: string; gross?: bigint; net?: bigint; evidence: Ref[] };
type TokenLedger = {
  condition: string; token: string; currency: string; lots: Lot[]; inventoryKnown: boolean; openingKnown: boolean;
  openingShares?: bigint; openingLots: Lot[]; knownIn: bigint; knownOut: bigint; unmatchedShares: bigint;
  accountedRealized: unknown[];
};
function lotTotal(lots: Lot[], basis: 'gross' | 'net', denomination: string) {
  return lots.every(lot => lot.currency === denomination && lot[basis] !== undefined)
    ? lots.reduce((total, lot) => total + lot[basis]!, 0n) : undefined;
}
function takeFifo(state: TokenLedger, shares: bigint) {
  let left = shares;
  const consumed: Lot[] = [];
  if (state.inventoryKnown) {
    while (left > 0n && state.lots.length) {
      const lot = state.lots[0];
      const take = left < lot.shares ? left : lot.shares;
      const gross = lot.gross === undefined ? undefined : lot.gross * take / lot.shares;
      const net = lot.net === undefined ? undefined : lot.net * take / lot.shares;
      consumed.push({ shares: take, currency: lot.currency, gross, net, evidence: lot.evidence });
      left -= take;
      lot.shares -= take;
      if (gross !== undefined) lot.gross! -= gross;
      if (net !== undefined) lot.net! -= net;
      if (lot.shares === 0n) state.lots.shift();
    }
  }
  if (left > 0n) state.inventoryKnown = false;
  return { consumed, unmatched: left };
}

const inventoryNeutral = new Set(['REWARD', 'YIELD', 'MAKER_REBATE', 'TAKER_REBATE', 'REFERRAL_REWARD', 'DEPOSIT', 'WITHDRAWAL', 'TIP']);
const keyed = (condition: string, token: string) => condition + ':' + token;
function walletPositions(rows: Sourced[], issues: Issue[]) {
  const positions = new Map<string, Sourced>();
  for (const item of rows) {
    const condition = hex(item.row.condition_id), token = match(item.row.token_id, tokenId);
    if (!condition || !token) {
      issues.push({ reason: 'invalid_position_identity', evidence: [item.ref] });
      continue;
    }
    const key = keyed(condition, token);
    const first = positions.get(key);
    if (first && (first.row.current_size !== item.row.current_size || first.row.status !== item.row.status)) {
      issues.push({ reason: 'inconsistent_position_snapshots', conditionId: condition, tokenId: token, evidence: [item.ref, first.ref] });
      continue;
    }
    positions.set(key, item);
  }
  return positions;
}

function summarizeOrders(supports: { row: Receipt; ref: Ref }[], used: LedgerEntry[], from: number, issues: Issue[]) {
  const groups = new Map<string, { row: Receipt; ref: Ref }[]>();
  const orderKey = (row: Receipt) => keyed(row.conditionId, row.tokenId) + ':' + row.orderId;
  for (const entry of supports) {
    if (entry.row.kind !== 'order') continue;
    const key = orderKey(entry.row);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups].flatMap(([key, group]) => {
    group.sort((a, b) => b.row.timestamp.localeCompare(a.row.timestamp));
    const { row, ref } = group[0];
    const joined = used.filter(line => line.support?.orderId && orderKey(line.support) === key);
    if (Date.parse(row.timestamp) < from && !joined.some(line => line.time >= from)) return [];
    const original = decimal(row.originalShares)!;
    const filled = decimal(row.filledShares)!;
    const observed = joined.filter(line => line.time <= Date.parse(row.timestamp)).reduce((sum, line) => sum + line.shares!, 0n);
    const consistent = observed <= filled && joined.every(line => line.time <= Date.parse(row.timestamp))
      && group.every(item => item.row.originalShares === row.originalShares
        && (item.row.timestamp === row.timestamp ? item.row.filledShares === row.filledShares && item.row.orderStatus === row.orderStatus
          : decimal(item.row.filledShares)! <= filled));
    if (!consistent) issues.push({ reason: 'inconsistent_order_receipt', conditionId: row.conditionId, tokenId: row.tokenId, evidence: group.map(x => x.ref) });
    return [{ conditionId: row.conditionId, tokenId: row.tokenId, orderId: row.orderId, originalShares: original,
      cumulativeFilledShares: filled, observedAttributedShares: observed, asOf: row.timestamp,
      fillRatio: consistent ? filled * precision / original : null, orderStatus: consistent ? row.orderStatus ?? 'unknown' : 'unknown',
      fillState: !consistent ? 'unknown' : filled === 0n ? 'no_fill_in_order_record' : filled < original ? 'partially_filled' : 'fully_filled',
      source: row.source, transactionUrl: txLink(row.transactionHash), logIndex: row.logIndex,
      evidence: [ref, ...joined.flatMap(line => line.refs)] }];
  });
}

function sourceRef(result: Awaited<ReturnType<Read>>) {
  return { evidenceId: result.evidenceId, retrievedAt: result.retrievedAt, status: result.status, source: result.source };
}
function sourceComplete(value: { coverage: { status: string } }) {
  return value.coverage.status === 'complete';
}
function settlementState(result: Outcome, quantity: bigint | undefined, creditedEvents: number, observedEvents: number, redeemable?: boolean) {
  if (result.status !== 'final') return result.status;
  if (quantity === undefined) return 'unknown';
  if (quantity === 0n) return creditedEvents ? 'redeemed' : observedEvents ? 'redemption_observed_credit_unknown'
    : result.ratio === 0n ? 'resolved_no_payout' : 'no_positive_position';
  if (result.ratio === 0n) return 'resolved_no_payout';
  if (result.ratio === undefined || redeemable === false) return 'unknown';
  return observedEvents ? 'partial_redemption_claim_remaining' : 'resolved_redeemable';
}
function cashSummary(t: Totals) {
  const grossTradeCash = t.grossSales - t.grossBuys;
  return {
    fillCount: t.fillCount, buyShares: t.buyShares, sellShares: t.sellShares, grossBuys: t.grossBuys, grossSales: t.grossSales, grossTradeCash,
    weightedBuyPrice: t.buyShares ? t.grossBuys * precision / t.buyShares : null,
    weightedSellPrice: t.sellShares ? t.grossSales * precision / t.sellShares : null,
    activityBuyCash: t.activityBuyCash, activitySellCash: t.activitySellCash, activityCashMissing: t.activityCashMissing,
    activityCashWithoutReceiptBasis: t.activityCashWithoutReceiptBasis,
    knownActualFees: t.knownActualFees, unknownFeeFills: t.unknownFeeFills, feeUnknownGrossAmount: t.feeUnknownGrossAmount,
    knownNetTradeCash: t.knownNetTradeCash, unknownNetTradeFills: t.unknownNetTradeFills,
    netTradeCashStatus: !t.unknownNetTradeFills ? 'complete_for_counted_fills' : t.unknownNetTradeFills < t.fillCount ? 'partial' : 'unknown',
    publicAttributedPayout: t.publicAttributedPayout, receiptCreditedPayout: t.receiptCreditedPayout, payoutEvents: t.payoutEvents,
    eventsWithoutCredit: t.eventsWithoutCredit, unattributedPayoutAmount: t.unattributedPayoutAmount,
    supportedWalletCashSubtotal: t.knownNetTradeCash + t.receiptCreditedPayout - t.foreignFeeOutflow,
    unsupportedActivityCount: t.unsupportedActivityCount, unsupportedReportedCashMagnitude: t.unsupportedReportedCashMagnitude,
  };
}
function pnlSummary(t: Totals) {
  const completeness = (known: number, total: number) => known === total ? 'complete_for_observed_items' : known > 0 ? 'partial' : 'unknown';
  return {
    grossRealizedSubtotal: t.realizedWithGrossCost ? t.grossRealized : null,
    grossRealizedStatus: completeness(t.realizedWithGrossCost, t.disposals),
    netRealizedInCurrencySubtotal: t.realizedWithNetCost ? t.netRealizedInCurrency : null,
    netRealizedStatus: completeness(t.realizedWithNetCost, t.disposals),
    matchedGrossDisposals: t.realizedWithGrossCost, matchedNetDisposals: t.realizedWithNetCost, disposals: t.disposals,
    proceedsWithoutGrossCost: t.proceedsWithoutGrossCost, proceedsWithoutNetCost: t.proceedsWithoutNetCost,
    grossUnrealizedSubtotal: t.positionsWithGrossMarkPnl ? t.grossUnrealized : null,
    netUnrealizedInCurrencySubtotal: t.positionsWithNetMarkPnl ? t.netUnrealizedInCurrency : null,
    grossUnrealizedStatus: completeness(t.positionsWithGrossMarkPnl, t.markedPositions),
    netUnrealizedStatus: completeness(t.positionsWithNetMarkPnl, t.markedPositions),
    positionsForMark: t.markedPositions, grossMarksWithCost: t.positionsWithGrossMarkPnl, netMarksWithCost: t.positionsWithNetMarkPnl,
    pendingPayoutSubtotal: t.pendingPayoutKnown, positionsWithUnknownPendingPayout: t.positionsWithUnknownPendingPayout,
  };
}

type Input = { wallet: string; from: string; to: string; market?: string;
  supporting_evidence_ids?: string[]; supporting_records?: unknown[] };

async function reconcile(host: Host, args: Input, signal: AbortSignal) {
  const wallet = hex(args.wallet.trim(), address);
  if (!wallet || wallet === '0x' + '0'.repeat(40)) throw new Error('请指定一个公开的 Polymarket 交易钱包地址。');
  const parsedFrom = zonedTime(args.from.trim()), parsedTo = zonedTime(args.to.trim());
  if (parsedFrom === undefined || parsedTo === undefined || parsedFrom >= parsedTo)
    throw new Error('from 和 to 须是带时区的 ISO 8601 时间，且 from 早于 to。');
  const from = parsedFrom, to = parsedTo;
  const started = Date.now();
  const cutoff = Math.min(to, started);
  if (from >= started) throw new Error('该时间窗尚未开始。');
  const issues: Issue[] = [];
  let condition: string | undefined, marketIdentityEvidenceId: string | undefined;
  const market = args.market?.trim();
  if (market) {
    if (market.length > 500) throw new Error('market 需要准确的 Polymarket 链接、slug 或 ID。');
    const explicit = hex(market.replace(/^condition:/i, ''));
    try {
      const result = await host.resolveMarket(explicit ? 'condition:' + explicit : market, signal);
      marketIdentityEvidenceId = host.saveEvidence(result.source, result.data, result.retrievedAt).evidenceId;
      if (result.data.status === 'found') condition = hex(result.data.conditionId);
      if (explicit && condition && condition !== explicit) condition = undefined;
      else if (explicit && !condition) condition = explicit;
      if (!condition) return { status: 'market_identity_unresolved', marketIdentityEvidenceId,
        candidates: result.data.candidates ?? result.data.markets ?? [], wallet, from: iso(from), to: iso(to) };
    } catch {
      signal.throwIfAborted();
      if (!explicit) throw new Error('市场身份来源暂不可用。可传已知 condition ID 重试。');
      condition = explicit;
    }
  }

  const incoming = args.supporting_records ?? [];
  const ids = [...new Set(args.supporting_evidence_ids ?? [])];
  if (incoming.length > 100 || ids.length > 10) throw new Error('每次最多传 100 条脱敏回执和 10 个证据 ID。');
  const supported: { row: Receipt; ref: Ref }[] = [];
  let rejectedRecordCount = 0;
  const evidenceSupport: { evidenceId: string; status: string }[] = [];
  const accepted = incoming.map(value => receipt(value, wallet, condition, cutoff)).filter(row => row !== undefined);
  rejectedRecordCount += incoming.length - accepted.length;
  if (accepted.length) {
    const { evidenceId } = host.saveEvidence('user-supplied:polymarket-portfolio', {
      kind: receiptKind, trust: 'user_supplied_document_fields_not_authenticated_by_agent', records: accepted,
    }, iso(started));
    evidenceSupport.push({ evidenceId, status: 'accepted' });
    accepted.forEach((row, rowIndex) => supported.push({ row, ref: { evidenceId, rowIndex } }));
  }
  for (const id of ids) {
    if (!match(id, safeId)) { rejectedRecordCount++; continue; }
    const evidence = host.loadEvidence(id);
    const data = evidence?.data;
    if (!object(data) || data.kind !== receiptKind || !Array.isArray(data.records) || data.records.length > 100) {
      evidenceSupport.push({ evidenceId: id, status: evidence ? 'unsupported_evidence_type' : 'missing' });
      continue;
    }
    data.records.forEach((value, rowIndex) => {
      const row = receipt(value, wallet, condition, cutoff);
      if (row) supported.push({ row, ref: { evidenceId: id, rowIndex } });
      else rejectedRecordCount++;
    });
    evidenceSupport.push({ evidenceId: id, status: 'read' });
  }

  const timeFilters = { id: wallet, condition_id: condition, start: Math.ceil(from / 1000), end: Math.ceil(cutoff / 1000) - 1 };
  const openingFilters = { ...timeFilters, start: 1, end: Math.ceil(from / 1000) - 1 };
  const activityQuery = { view: 'activity', exclude_deposits_withdrawals: false } as const;
  const tradesQuery = { view: 'trades', taker_only: false } as const;
  const [activity, trades, historyActivity, historyTrades, open, closed, freshness] = await Promise.all([
    pages(host.read, { ...activityQuery, ...timeFilters }, signal),
    pages(host.read, { ...tradesQuery, ...timeFilters }, signal),
    pages(host.read, { ...activityQuery, ...openingFilters }, signal),
    pages(host.read, { ...tradesQuery, ...openingFilters }, signal),
    pages(host.read, { view: 'positions', id: wallet, condition_id: condition, position_status: 'OPEN',
      include_archived: true, position_min_shares: 0 }, signal),
    ...(condition ? [pages(host.read, { view: 'positions', id: wallet, condition_id: condition, position_status: 'CLOSED' }, signal) as
      ReturnType<typeof pages>] as const : [Promise.resolve(undefined)] as const),
    host.read({ view: 'freshness' }, signal),
  ]);
  const positions = walletPositions([...open.rows, ...closed?.rows ?? []], issues);
  const publicWindow = [...activity.rows, ...trades.rows];
  const rowCondition = ({ row }: Sourced) => hex(row.condition_id) ?? [];
  const conditions = [...new Set([...(condition ? [condition] : []),
    ...publicWindow.flatMap(rowCondition), ...open.rows.flatMap(rowCondition),
    ...supported.map(({ row }) => row.conditionId),
    ...historyActivity.rows.filter(({ row }) => row.type === 'REDEEM').flatMap(rowCondition)])];
  const finalByCondition = new Map<string, Final>(await Promise.all(conditions.slice(0, marketBudget).map(async id => {
    const [resolution, tokens] = await Promise.all([
      host.read({ view: 'resolution', id }, signal), host.read({ view: 'tokens', id }, signal),
    ]);
    return [id, { resolution, tokens }] as const;
  })));
  const publicIdentities = new Set([...publicWindow, ...historyActivity.rows, ...historyTrades.rows, ...positions.values()]
    .map(({ row }) => json([hex(row.condition_id), match(row.token_id, tokenId)])));
  const usableSupport = supported.filter(({ row, ref }) => {
    const tokens = finalByCondition.get(row.conditionId)?.tokens;
    const refs = Array.isArray(tokens?.result) ? tokens.result.filter(object) : [];
    const verified = refs.some(token => token.token_id === row.tokenId && hex(token.condition_id) === row.conditionId);
    const absent = tokens?.status === 'ok' && refs.length > 0 && !verified;
    if (!absent && (verified || publicIdentities.has(json([row.conditionId, row.tokenId])))) return true;
    rejectedRecordCount++;
    issues.push({ reason: absent ? 'receipt_token_condition_mismatch' : 'receipt_token_condition_unverified',
      conditionId: row.conditionId, tokenId: row.tokenId, transactionHash: row.transactionHash, evidence: [ref] });
    return false;
  });
  const joined = joinLedger(activity.rows, trades.rows, usableSupport.filter(({ row }) => Date.parse(row.timestamp) >= from), issues);
  const history = joinLedger(historyActivity.rows, historyTrades.rows, usableSupport.filter(({ row }) => Date.parse(row.timestamp) < from), issues);
  const windowComplete = sourceComplete(activity) && sourceComplete(trades);
  const historyComplete = sourceComplete(historyActivity) && sourceComplete(historyTrades);
  const states = new Map<string, TokenLedger>();
  const cashCurrencies = new Map<string, Totals>(), byMarket = new Map<string, Totals>();
  function bucket(map: Map<string, Totals>, id: string) {
    let totals = map.get(id);
    if (!totals) { totals = emptyTotals(); map.set(id, totals); }
    return totals;
  }
  const totalsFor = (conditionId: string | undefined, denomination: string) => [
    bucket(cashCurrencies, denomination), bucket(byMarket, json([conditionId ?? null, denomination])),
  ];
  function tokenState(conditionId: string, token: string) {
    const key = keyed(conditionId, token);
    let state = states.get(key);
    if (!state) {
      state = { condition: conditionId, token, currency: publicCurrency, lots: [], openingLots: [],
        openingKnown: historyComplete, inventoryKnown: historyComplete, knownIn: 0n, knownOut: 0n, unmatchedShares: 0n,
        accountedRealized: [] };
      states.set(key, state);
    }
    return state;
  }
  const allLines = [...history.ledger, ...joined.ledger];
  for (const line of allLines) if (line.condition && line.token && (isFill(line) || line.action === 'REDEEM'))
    tokenState(line.condition, line.token);
  for (const { row } of positions.values()) tokenState(hex(row.condition_id)!, match(row.token_id, tokenId)!);

  const redemptions: unknown[] = [];
  const unsupported: Issue[] = [];
  const fillRows: { line: LedgerEntry; detail: Row }[] = [];
  const allRedeems = new Map<string, { credited: number; observed: number }>();
  const orderDetails = summarizeOrders(usableSupport, allLines.filter(validFill), from, issues);
  const orderKey = (line: LedgerEntry) => line.support?.orderId && json([line.condition, line.token, line.support.orderId]);
  const ordersByKey = new Map(orderDetails.map(row => [json([row.conditionId, row.tokenId, row.orderId]), row]));
  function applyLedger(range: LedgerEntry[], complete: boolean, inWindow: boolean) {
    const counts = new Map<string, number>();
    for (const line of range) if (line.action === 'REDEEM') {
      const key = json([shape(line), line.cash]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const blockedAt = new Map<string, number>();
    for (const issue of issues) {
      if (!['public_trade_leg_not_uniquely_aligned', 'receipt_leg_not_uniquely_aligned', 'invalid_public_trade', 'same_source_projection_multiplicity_unverified',
        'same_identity_conflicting_values', 'conflicting_supplied_receipts'].includes(issue.reason) || typeof issue.time !== 'string') continue;
      const time = Date.parse(issue.time);
      if ((time >= from) !== inWindow) continue;
      const key = issue.conditionId ?? '';
      blockedAt.set(key, Math.min(time, blockedAt.get(key) ?? time));
    }
    const ordered = [...range].sort((a, b) => a.time - b.time
      || (a.feed === b.feed && a.feed !== 'receipt' ? b.sequence - a.sequence
        : a.tx && a.tx === b.tx && a.logIndex !== undefined && b.logIndex !== undefined ? a.logIndex - b.logIndex : 0));
    const byTime = new Map<string, LedgerEntry[]>();
    for (const line of ordered) if (line.condition && line.token && (validFill(line) || line.action === 'REDEEM')) {
      const key = json([line.condition, line.token, line.time]);
      const same = byTime.get(key) ?? [];
      same.push(line);
      byTime.set(key, same);
    }
    for (const group of byTime.values()) {
      // Mixed feed rows from the same second have no common sequence unless they share on-chain log order.
      if (new Set(group.map(row => row.feed)).size > 1 && !group.every(row => row.tx && row.tx === group[0].tx && row.logIndex !== undefined)) {
        for (const line of group) issues.push(reportIssue('same_second_sequence_unverified', line));
        const first = group[0];
        blockedAt.set(first.condition!, Math.min(first.time, blockedAt.get(first.condition!) ?? first.time));
      }
    }
    for (const line of ordered) {
      const state = line.condition && line.token && (isFill(line) || line.action === 'REDEEM')
        ? tokenState(line.condition, line.token) : undefined;
      if (state && (!complete || line.time >= (blockedAt.get(line.condition!) ?? Infinity) || line.time >= (blockedAt.get('') ?? Infinity)))
        state.inventoryKnown = false;
      const entries = inWindow ? totalsFor(line.condition, line.denomination) : [];
      const amounts = validFill(line) ? fillAmounts(line) : undefined;
      const resolution = outcome(line.condition ? finalByCondition.get(line.condition) : undefined, line.token);
      const redeem = line.action === 'REDEEM' ? redemption(line, resolution, (counts.get(json([shape(line), line.cash])) ?? 0) > 1 && !strong(line).length) : undefined;
      if (!amounts && !redeem) {
        const issue = reportIssue('activity_allocation_unsupported', line);
        issues.push(issue);
        if (inWindow) unsupported.push(issue);
        for (const t of entries) { t.unsupportedActivityCount++; t.unsupportedReportedCashMagnitude += line.cash ?? 0n; }
        if (!inventoryNeutral.has(line.action)) {
          const key = line.condition ?? '';
          blockedAt.set(key, Math.min(line.time, blockedAt.get(key) ?? line.time));
          for (const item of states.values()) if (!line.condition || item.condition === line.condition) item.inventoryKnown = false;
        }
        continue;
      }
      if (amounts) {
        const { nominal, gross, net, fee, feeCurrency } = amounts;
        const buy = line.action === 'BUY';
        for (const t of entries) {
          t.fillCount++;
          if (buy) { t.buyShares += line.shares!; t.grossBuys += gross; }
          else { t.sellShares += line.shares!; t.grossSales += gross; }
          if (line.cash === undefined) t.activityCashMissing++;
          if (fee === undefined) { t.unknownFeeFills++; t.feeUnknownGrossAmount += gross; }
          if (net === undefined) t.unknownNetTradeFills++;
          else t.knownNetTradeCash += buy ? -net : net;
        }
        if (inWindow && line.cash !== undefined) for (const t of totalsFor(line.condition, publicCurrency)) {
          if (buy) t.activityBuyCash += line.cash;
          else t.activitySellCash += line.cash;
          if (!amounts.receiptCashBasis || line.denomination !== publicCurrency) t.activityCashWithoutReceiptBasis++;
        }
        if (inWindow && fee !== undefined && feeCurrency) {
          for (const t of totalsFor(line.condition, feeCurrency)) {
            t.knownActualFees += fee;
            if (feeCurrency !== line.denomination) t.foreignFeeOutflow += fee;
          }
        }
        if (line.cash !== undefined && absolute(line.cash - nominal) > micro)
          issues.push({ ...reportIssue('observed_trade_cash_differs_from_shares_times_price', line),
            sharesTimesPrice: nominal, difference: line.cash - nominal, minimumCollateralUnit: '0.000001' });
        if (buy && state) {
          state.lots.push({ shares: line.shares!, currency: line.denomination, gross, net, evidence: [...line.refs] });
          if (inWindow) state.knownIn += line.shares!;
        }
        if (inWindow) {
          const order = ordersByKey.get(orderKey(line) ?? '');
          fillRows.push({ line, detail: { platform: 'Polymarket', wallet, conditionId: line.condition, tokenId: line.token,
            title: line.title, action: line.action, timestamp: iso(line.time), shares: line.shares, price: line.price,
            currency: line.denomination, amounts, activityCash: line.cash, activityCashCurrency: line.cash === undefined ? undefined : publicCurrency,
            feeStatus: fee === undefined ? 'unknown' : 'documented_by_supplied_receipt',
            transactionHash: line.tx, transactionUrl: txLink(line.tx), logIndex: line.logIndex, fillId: line.id,
            orderId: line.support?.orderId, orderFillStatus: order?.fillState ?? 'unknown',
            orderGap: order ? undefined : '需要同订单标识、委托原始量和对应成交量。',
            evidence: line.refs, suppliedDocumentSource: line.support?.source } });
        }
      }
      if (redeem) {
        if (resolution.resolutionTime !== undefined && line.time < resolution.resolutionTime)
          issues.push({ ...reportIssue('redemption_precedes_official_resolution_timestamp', line),
            resolvedAt: iso(resolution.resolutionTime), resolutionEvidenceIds: resolution.evidenceIds });
        if (line.condition && line.token) {
          const key = keyed(line.condition, line.token);
          const count = allRedeems.get(key) ?? { credited: 0, observed: 0 };
          count.observed++;
          if (redeem.credited !== undefined) count.credited++;
          allRedeems.set(key, count);
        }
        for (const t of entries) {
          t.payoutEvents++;
          t.receiptCreditedPayout += redeem.credited ?? 0n;
          if (redeem.credited === undefined) t.eventsWithoutCredit++;
        }
        if (inWindow && redeem.activityAmount !== undefined) for (const t of totalsFor(line.condition, publicCurrency)) {
          t.publicAttributedPayout += redeem.attributableAmount ?? 0n;
          if (redeem.attributableAmount === undefined) t.unattributedPayoutAmount += redeem.activityAmount;
        }
        if (inWindow) redemptions.push({ wallet, conditionId: line.condition, tokenId: line.token, currency: line.denomination,
          activityCurrency: redeem.activityAmount === undefined ? undefined : publicCurrency, timestamp: iso(line.time),
          transactionHash: line.tx, transactionUrl: txLink(line.tx), logIndex: line.logIndex, evidence: line.refs, ...redeem });
        if (redeem.shares === undefined) {
          if (state) state.inventoryKnown = false;
          else for (const item of states.values()) if (!line.condition || item.condition === line.condition) item.inventoryKnown = false;
          issues.push(reportIssue('redeemed_shares_or_allocation_unknown', line));
        }
        if (redeem.attributableAmount !== undefined && redeem.credited !== undefined && line.denomination === publicCurrency
          && absolute(redeem.attributableAmount - redeem.credited) > micro)
          issues.push({ ...reportIssue('redemption_credit_differs_from_activity', line), credited: redeem.credited,
            difference: redeem.credited - redeem.attributableAmount });
      }

      const sells = line.action === 'SELL' && amounts;
      if (!sells && !redeem) continue;
      const shares = sells ? line.shares : redeem?.shares;
      const matched = shares !== undefined && state ? takeFifo(state, shares) : undefined;
      const grossProceeds = sells ? amounts.gross : redeem?.attributableAmount ?? redeem?.credited;
      const grossCurrency = redeem?.attributableAmount !== undefined ? publicCurrency : line.denomination;
      const netProceeds = sells ? amounts.net : redeem?.credited;
      const grossBasis = matched?.unmatched === 0n ? lotTotal(matched.consumed, 'gross', grossCurrency) : undefined;
      const netBasis = matched?.unmatched === 0n ? lotTotal(matched.consumed, 'net', line.denomination) : undefined;
      const grossPnl = grossBasis !== undefined && grossProceeds !== undefined ? grossProceeds - grossBasis : undefined;
      const netPnl = netBasis !== undefined && netProceeds !== undefined ? netProceeds - netBasis : undefined;
      if (inWindow) for (const denomination of new Set([grossCurrency, line.denomination])) for (const t of totalsFor(line.condition, denomination)) {
        t.disposals++;
        if (denomination === grossCurrency) {
          if (grossPnl !== undefined) { t.grossRealized += grossPnl; t.realizedWithGrossCost++; }
          else t.proceedsWithoutGrossCost += grossProceeds ?? 0n;
        }
        if (denomination === line.denomination) {
          if (netPnl !== undefined) { t.netRealizedInCurrency += netPnl; t.realizedWithNetCost++; }
          else t.proceedsWithoutNetCost += netProceeds ?? (denomination === grossCurrency ? grossProceeds : undefined) ?? 0n;
        }
      }
      if (inWindow && state) {
        state.knownOut += shares ?? 0n;
        state.unmatchedShares += matched?.unmatched ?? shares ?? 0n;
        state.accountedRealized.push({ timestamp: iso(line.time), shares, unmatchedShares: matched?.unmatched, grossProceeds, netProceeds,
          grossCurrency, netCurrency: line.denomination, consumedLots: matched?.consumed, grossPnl, netPnl, evidence: line.refs });
      }
      if ((matched?.unmatched ?? 0n) > 0n) issues.push({ ...reportIssue('fifo_inventory_or_opening_cost_missing', line),
        unmatchedShares: matched?.unmatched, grossProceeds });
    }
  }
  applyLedger(history.ledger, historyComplete, false);
  for (const state of states.values()) {
    state.openingKnown = state.inventoryKnown;
    if (state.openingKnown) state.openingShares = state.lots.reduce((sum, lot) => sum + lot.shares, 0n);
    state.openingLots = state.lots.map(lot => ({ ...lot }));
    state.inventoryKnown &&= windowComplete;
    const snapshot = positions.get(keyed(state.condition, state.token));
    const firstEntry = timestamp(snapshot?.row.first_entry_at);
    if (firstEntry !== undefined && firstEntry < from && !allLines.some(line => line.condition === state.condition
      && line.token === state.token && line.time < from && line.action === 'BUY')) {
      state.openingKnown = false;
      state.openingShares = undefined;
      state.inventoryKnown = false;
      issues.push({ reason: 'position_first_entry_before_window_missing_in_feeds', conditionId: state.condition,
        tokenId: state.token, firstEntryAt: iso(firstEntry), evidence: snapshot ? [snapshot.ref] : [] });
    }
  }
  applyLedger(joined.ledger, windowComplete, true);

  const markCandidates = [...states.values()].filter(state => state.inventoryKnown && state.lots.length > 0
    && (outcome(finalByCondition.get(state.condition), state.token).resolutionTime ?? Infinity) >= cutoff);
  const marks = new Map(await Promise.all(markCandidates.slice(0, marketBudget).map(async state => [
    state.token, await host.read({ view: 'price_at', id: state.token, as_of: timeFilters.end }, signal),
  ] as const)));
  const positionAndSettlement = [];
  for (const state of states.values()) {
    const key = keyed(state.condition, state.token);
    const snapshot = positions.get(key);
    const result = outcome(finalByCondition.get(state.condition), state.token);
    const snapshotShares = decimal(snapshot?.row.current_size);
    const snapshotPrice = decimal(snapshot?.row.current_price);
    const lastEvent = timestamp(snapshot?.row.last_event_at);
    const reconstructed = state.inventoryKnown ? state.lots.reduce((sum, lot) => sum + lot.shares, 0n) : undefined;
    const aligned = lastEvent !== undefined && lastEvent < cutoff;
    const shareGap = aligned && snapshotShares !== undefined && reconstructed !== undefined ? snapshotShares - reconstructed : undefined;
    if (shareGap !== undefined && shareGap !== 0n)
      issues.push({ reason: 'position_quantity_difference', conditionId: state.condition, tokenId: state.token,
        difference: shareGap, minimumShareUnit: '0.000001', withinSourcePrecision: absolute(shareGap) <= micro,
        openingShares: state.openingShares, knownIn: state.knownIn, knownOut: state.knownOut,
        reconstructed, currentSnapshotShares: snapshotShares, evidence: snapshot ? [snapshot.ref] : [],
        relatedActivityReferences: issues.filter(issue => issue.conditionId === state.condition
          && issue.reason === 'activity_allocation_unsupported').flatMap(issue => issue.evidence ?? []) });
    const grossCost = state.inventoryKnown ? lotTotal(state.lots, 'gross', state.currency) : undefined;
    const netCost = state.inventoryKnown ? lotTotal(state.lots, 'net', state.currency) : undefined;
    const acquired = allRedeems.get(key);
    const pastSettlement = result.status === 'final' && result.resolutionTime !== undefined && result.resolutionTime < cutoff;
    const atCutoff = result.status === 'final' && !pastSettlement
      ? { ...result, status: result.resolutionTime !== undefined && !acquired?.observed ? 'not_final' as const : 'unknown' as const, ratio: undefined }
      : result.status === 'not_final' ? { ...result, ratio: undefined } : result;
    const eligibleReconstructed = shareGap === undefined || absolute(shareGap) <= micro ? reconstructed : undefined;
    const historicalPayout = pastSettlement && result.ratio !== undefined && eligibleReconstructed !== undefined
      ? multiply(eligibleReconstructed, result.ratio) : undefined;
    const currentPayout = result.status === 'final' && result.ratio !== undefined && snapshotShares !== undefined
      && (result.ratio === 0n || snapshotShares === 0n || snapshot?.row.redeemable === true) ? multiply(snapshotShares, result.ratio) : undefined;
    const historicalPositionStatus = settlementState(atCutoff, eligibleReconstructed, acquired?.credited ?? 0, acquired?.observed ?? 0);
    const currentPositionStatus = settlementState(result, snapshotShares, acquired?.credited ?? 0, acquired?.observed ?? 0, snapshot?.row.redeemable === true);
    const markSource = marks.get(state.token);
    const points = Array.isArray(markSource?.result) ? markSource.result.filter(object) : [];
    const point = points.length === 1 && markSource?.status === 'ok' ? points[0] : undefined;
    const observed = timestamp(point?.timestamp), price = decimal(point?.price);
    const grain = indexValue(point?.resolution_seconds);
    const validatedMark = atCutoff.status === 'not_final' && observed !== undefined && grain !== undefined
      && observed < cutoff && observed + grain * 1000 <= cutoff && price !== undefined && price <= precision;
    const mark = validatedMark ? { price, observedAt: iso(observed), resolutionSeconds: grain,
      value: eligibleReconstructed === undefined ? undefined : multiply(eligibleReconstructed, price), evidenceId: markSource?.evidenceId,
      basis: 'official_as_of_latest_eligible_price' } : undefined;
    const grossUnrealized = mark?.value !== undefined && grossCost !== undefined ? mark.value - grossCost : undefined;
    const netUnrealized = mark?.value !== undefined && netCost !== undefined ? mark.value - netCost : undefined;
    if (pastSettlement || reconstructed !== 0n || snapshotShares !== undefined && snapshotShares > 0n
      || state.accountedRealized.length || state.knownIn) {
      for (const t of totalsFor(state.condition, state.currency)) {
        if (pastSettlement) {
          if (historicalPayout === undefined) t.positionsWithUnknownPendingPayout++;
          else t.pendingPayoutKnown += historicalPayout;
        }
        if (!pastSettlement && (reconstructed === undefined || reconstructed > 0n)) {
          t.markedPositions++;
          if (grossUnrealized !== undefined) { t.grossUnrealized += grossUnrealized; t.positionsWithGrossMarkPnl++; }
          if (netUnrealized !== undefined) { t.netUnrealizedInCurrency += netUnrealized; t.positionsWithNetMarkPnl++; }
        }
      }
    }
    const snapAt = snapshot && [...open.coverage.pages, ...closed?.coverage.pages ?? []].find(page => page.evidenceId === snapshot.ref.evidenceId)?.retrievedAt;
    positionAndSettlement.push({
      conditionId: state.condition, tokenId: state.token, currency: state.currency, outcome: result.outcome ?? snapshot?.row.outcome,
      opening: { status: state.openingKnown ? 'reconstructed_from_disclosed_history' : 'unknown', shares: state.openingShares,
        grossCost: state.openingKnown ? lotTotal(state.openingLots, 'gross', state.currency) : undefined,
        netCost: state.openingKnown ? lotTotal(state.openingLots, 'net', state.currency) : undefined, lots: state.openingLots },
      quantity: { windowKnownIn: state.knownIn, windowKnownOut: state.knownOut, reconstructed, unmatchedDisposalShares: state.unmatchedShares,
        snapshotAlignedByLastReportedEvent: aligned, difference: shareGap, minimumShareUnit: '0.000001' },
      atWindowEnd: { observedCutoff: iso(cutoff), settlementStatus: historicalPositionStatus, remainingGrossCost: grossCost, remainingNetCost: netCost,
        pendingPayout: historicalPayout, historicalMark: mark, markStatus: mark ? 'observed' : markSource ? String(markSource.status) === 'ok'
          ? 'observation_does_not_establish_window_end_mark' : markSource.status : 'unavailable',
        markEvidenceId: markSource?.evidenceId, grossUnrealized, netUnrealized },
      currentSnapshot: snapshot ? { status: snapshot.row.status, shares: snapshotShares, currentPrice: snapshotPrice,
        marketValue: decimal(snapshot.row.current_value), currency: publicCurrency, observedAt: snapAt,
        lastReportedEventAt: lastEvent === undefined ? undefined : iso(lastEvent), redeemable: snapshot.row.redeemable,
        settlementStatus: currentPositionStatus, pendingPayout: currentPayout, evidence: snapshot.ref,
        sourceReportedEntryFeesAggregate: decimal(snapshot.row.entry_fees_usdc) } : undefined,
      resolution: { ...result, resolvedAt: result.resolutionTime === undefined ? undefined : iso(result.resolutionTime),
        resolutionTime: undefined, transactionUrl: txLink(result.transactionHash) },
      fifoDisposals: state.accountedRealized,
    });
  }

  const fills = fillRows.sort((a, b) => b.line.time - a.line.time).map(({ detail }) => detail);
  const walletBound = activity.rows.length + trades.rows.length + historyActivity.rows.length + historyTrades.rows.length + positions.size > 0;
  const payoutRefs = redemptions as { evidence: Ref[]; creditStatus: string }[];
  const unresolvedConditions = conditions.filter(id => outcome(finalByCondition.get(id)).status === 'unknown');
  const endReached = to <= started;
  const scope = {
    platform: 'Polymarket International', wallet, walletIdentityStatus: walletBound ? 'confirmed_by_matching_public_proxy_wallet_rows' : 'no_matching_public_rows_to_confirm',
    from: iso(from), to: iso(to), window: '[from,to) UTC', observedCutoff: iso(cutoff), requestedEndReached: endReached,
    conditionId: condition, marketIdentityEvidenceId, calculation: 'FIFO', currencyBasis: '官方公开活动的货币口径为 USDC。回执按声明的币种入账。各币种分别汇总。',
    fifoBasis: '毛盈亏用可匹配的入仓批次与成交金额，净盈亏只使用有现金口径和费用依据的批次。跨币种费用单列。官方界面持仓成本和净值可能使用其他口径。',
    sourceLimitations: [
      '覆盖状态描述公开索引和查询边界。交易读取包含 maker 与 taker，交易接口有官方最小成交过滤。活动不保证覆盖全部直属链上转账。',
      ...(condition ? ['按 condition 过滤的活动不含只归属到整个事件的方向性转换。'] : []),
      '当前持仓价格和可兑付状态对应各页实际读取时间。历史标记只取截止时间前的官方历史点。',
    ],
  };
  const coverage = {
    activity: activity.coverage,
    trades: { ...trades.coverage, roles: 'maker_and_taker_requested', defaultTradeSizeFloor: '0.01 shares per official spec; activity can include other fills' },
    positions: { ...open.coverage, closed: closed?.coverage ?? { status: 'not_requested', reason: 'closed_book_only_checked_for_single_contract' } },
    resolution: { status: !conditions.length ? 'unknown' : unresolvedConditions.length === 0 ? 'complete'
      : unresolvedConditions.length < conditions.length ? 'partial' : 'unknown', conditions: conditions.length,
      unresolvedConditions, uncheckedConditions: conditions.slice(marketBudget),
      sources: [...finalByCondition].map(([conditionId, result]) => ({ conditionId, resolution: sourceRef(result.resolution), tokens: sourceRef(result.tokens) })) },
    redemption: { status: !payoutRefs.length ? sourceComplete(activity) && endReached ? 'no_event_in_public_window' : 'unknown'
      : payoutRefs.every(row => row.creditStatus !== 'unknown') && sourceComplete(activity) && endReached ? 'documented' : 'partial',
    eventCount: payoutRefs.length, withDocumentedCredit: payoutRefs.filter(row => row.creditStatus !== 'unknown').length,
    evidenceIds: [...new Set(payoutRefs.flatMap(row => row.evidence.map(ref => ref.evidenceId)))] },
    opening: { status: historyComplete ? 'source_pages_complete' : 'partial',
      activity: historyActivity.coverage, trades: historyTrades.coverage },
    freshness: { ...sourceRef(freshness), observation: freshness.result },
    support: { evidence: evidenceSupport, rejectedRecordCount, trust: 'user_supplied_document_fields_not_authenticated_by_agent' },
    deduplication: {
      sourceKeyDuplicates: joined.exactDuplicates, crossSourceMatches: joined.crossSourceMatches, receiptMatches: joined.importedMatches,
      ambiguousLegs: joined.ambiguous, activityFillRows: joined.ledger.filter(line => line.feed === 'activity' && validFill(line)).length,
      tradeOnlyFillRows: joined.ledger.filter(line => line.feed === 'trades' && validFill(line)).length,
      opening: { sourceKeyDuplicates: history.exactDuplicates, crossSourceMatches: history.crossSourceMatches, ambiguousLegs: history.ambiguous },
    },
  };
  const cashFlowsByCurrency = Object.fromEntries([...cashCurrencies].map(([id, totals]) => [id, cashSummary(totals)]));
  const pnlByCurrency = Object.fromEntries([...cashCurrencies].map(([id, totals]) => [id, pnlSummary(totals)]));
  const byMarketAndCurrency = [...byMarket].map(([key, totals]) => {
    const [conditionId, currency] = JSON.parse(key);
    return { conditionId, currency, cash: cashSummary(totals), pnl: pnlSummary(totals) };
  });
  const status = !walletBound && !fills.length && !redemptions.length ? 'unknown'
    : !windowComplete || !historyComplete || !sourceComplete(open) || !endReached || !walletBound
      || coverage.resolution.status !== 'complete' || issues.length || (fills.length && fills.some(x => x.feeStatus === 'unknown' || x.orderFillStatus === 'unknown'))
      || coverage.redemption.status === 'partial' || rejectedRecordCount > 0 || evidenceSupport.some(x => !['read', 'accepted'].includes(x.status))
      ? 'partial' : 'reconciled_for_observed_scope';
  const evidencePreview = fills.slice(0, 3).map(({ action, timestamp, shares, transactionUrl, evidence }) =>
    ({ action, timestamp, shares, transactionUrl, evidence }));
  const report = { kind: 'polymarket_portfolio_reconciliation', status, evidencePreview, scope, coverage, fills, orders: orderDetails,
    cashFlowsByCurrency, positionAndSettlement, pnlByCurrency, byMarketAndCurrency, redemptions,
    unsupportedActivity: unsupported, discrepancies: issues };
  const { evidenceId } = host.saveEvidence('calculation:polymarket-portfolio-reconciliation', JSON.parse(json(report)), iso(Date.now()));
  const smallCoverage = (value: typeof activity.coverage) => ({
    ...value, pages: value.pages.length, firstPageEvidenceId: value.pages[0]?.evidenceId, lastPageEvidenceId: value.pages.at(-1)?.evidenceId,
  });
  return { status, scope, coverage: {
    ...coverage, activity: smallCoverage(activity.coverage), trades: { ...smallCoverage(trades.coverage), roles: coverage.trades.roles },
    positions: { ...smallCoverage(open.coverage), closed: closed ? smallCoverage(closed.coverage) : coverage.positions.closed },
    opening: { status: coverage.opening.status, activity: smallCoverage(historyActivity.coverage), trades: smallCoverage(historyTrades.coverage) },
    resolution: { ...coverage.resolution, sources: coverage.resolution.sources.slice(0, 2) },
    freshness: sourceRef(freshness), redemption: { ...coverage.redemption, evidenceIds: coverage.redemption.evidenceIds.slice(0, 4) },
  }, fills: fills.slice(0, 5), orders: orderDetails.slice(0, 5), cashFlowsByCurrency,
  positionAndSettlement: positionAndSettlement.slice(0, 5).map(({ fifoDisposals, opening, ...row }) =>
    ({ ...row, opening: { ...opening, lots: opening.lots.length }, fifoDisposalCount: fifoDisposals.length })),
  pnlByCurrency, redemptions: redemptions.slice(0, 5), discrepancies: issues.slice(0, 5),
  counts: { fills: fills.length, positions: positionAndSettlement.length, discrepancies: issues.length, redemptions: redemptions.length }, evidenceId };
}

export function createPortfolioReconcileTool(host: Host) {
  return defineTool({
    name: 'reconcile_polymarket_portfolio',
    description: '只读对账一个明确指定的 Polymarket 公开交易钱包。按 UTC 时间窗和可选市场核对成交、实际手续费、FIFO 盈亏、持仓、可兑付和到账。缺项会注明金额范围。报告 ID 可用 read_evidence 回读。',
    parameters: {
      wallet: { ...str, required: true, description: '用户明确指定的公开 Polymarket 交易地址。' },
      from: { ...str, required: true, description: 'ISO 8601 带时区的开始时间（含）。' },
      to: { ...str, required: true, description: 'ISO 8601 带时区的截止时间（不含）。' },
      market: { ...str, description: '可选，一个市场的 Polymarket 链接、slug 或 condition ID。' },
      supporting_evidence_ids: { type: 'array', items: str, description: '用户明确提供的已存结构化对账回执证据 ID。' },
      supporting_records: { type: 'array', items: { type: 'json' }, description: '用户明确提供的脱敏结构化官方回执行。格式见 pm-public-data Skill。' },
    },
    output: { schema: str, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, { signal }) { return json(await reconcile(host, args, signal)); },
  });
}
