import { sourceSetting } from './source-config.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { researchEngine } from './market-data.js';
import { getWatch, now, saveEvidence, type Watch } from './store.js';

const topics = ['macro', 'economics', 'politics', 'sports', 'crypto', 'weather'] as const;
const directoryLimit = 1000;
const historicalSearchLimit = 50000;
const priceLimit = 512;
const auditLimit = 12;
const stateLimit = 5000;
const catalogAgeSeconds = 7200;
const maxAuditLagSeconds = 180;
const minimumTrades = 10;
const scanTimeoutMs = 50000;
const previewBytes = 18000;
const source = 'market-data/market-screen';
export const screenWatchPrompt = '执行当前原生唤醒的动态市场筛选。';

const parameters = {
  topic: { type: 'string', enum: topics, description: '使用目录主题。省略时跨主题。' },
  region: { type: 'string', description: '与 topic 同用的目录地域，例如 US 或 150（欧洲）。' },
  keywords: { type: 'array', items: { type: 'string' }, description: '来自目录的字面关键词，每个词均须匹配市场标题、事件、slug、分类或标签。' },
  open_only: { type: 'boolean', description: '默认 true，只要求目录证实 active 且未关闭。false 纳入所有状态。' },
  min_volume_24h_usd: { type: 'number', description: 'Gamma 目录滚动24小时成交额下限（美元）。' },
  min_abs_trade_move_30m_pp: { type: 'number', description: '同一选项最近已审计30分钟窗口首末成交参考价绝对变化下限（百分点）。' },
  max_matches: { type: 'integer', description: '展示上限，默认20，范围1–100。' },
} as const;

export const marketScreenSchema = { type: 'object', additionalProperties: false, properties: parameters } as const;
export type MarketScreenInput = {
  topic?: string; region?: string; keywords?: readonly string[]; open_only?: boolean;
  min_volume_24h_usd?: number; min_abs_trade_move_30m_pp?: number; max_matches?: number;
};

function normalizeScreen(input: MarketScreenInput) {
  const topic = input.topic?.trim().toLowerCase() as typeof topics[number] | undefined;
  const region = input.region?.trim().toUpperCase();
  if (topic !== undefined && !topics.includes(topic)) throw new Error('市场主题无效。');
  if (region !== undefined && (!topic || !/^(?:[A-Z]{2}|150)$/.test(region))) throw new Error('地域需要目录主题与两字母 ISO 地区代码或 150。');
  const keywords = [...new Set((input.keywords ?? []).map(term => term.trim().toLowerCase()))].sort();
  if (keywords.length > 12 || keywords.some(term => !term || term.length > 120 || term.includes('\0'))) throw new Error('关键词须非空，最多12个，每个最多120字符。');
  const volume = input.min_volume_24h_usd;
  if (volume !== undefined && (!Number.isFinite(volume) || volume < 0)) throw new Error('24小时成交额下限须为非负有限数。');
  const move = input.min_abs_trade_move_30m_pp;
  if (move !== undefined && (!Number.isFinite(move) || move < 0 || move > 100)) throw new Error('成交参考价变化下限须在0到100个百分点之间。');
  const max = input.max_matches ?? 20;
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error('max_matches 须为1到100的整数。');
  return { topic, region, keywords, open_only: input.open_only ?? true, min_volume_24h_usd: volume,
    min_abs_trade_move_30m_pp: move, max_matches: max };
}

type Screen = ReturnType<typeof normalizeScreen>;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directoryScope = ({ topic, region, keywords, open_only }: Screen) => ({ topic, region, keywords, open_only });

type MarketScreenWatch = { kind: 'market_screen'; screen: Screen; conditionKey: string; notifyOnInitial: boolean; scopeVersion: number };
export function prepareMarketScreenWatch(input: MarketScreenInput, notifyOnInitial: boolean, previous?: MarketScreenWatch): MarketScreenWatch {
  const screen = normalizeScreen(input);
  const { max_matches: _presentation, ...conditions } = screen;
  const conditionKey = fingerprint(conditions);
  return { kind: 'market_screen' as const, screen, conditionKey, notifyOnInitial,
    scopeVersion: previous ? previous.scopeVersion + Number(previous.conditionKey !== conditionKey) : 1 };
}

export function marketScreenWatch(watch: Watch): MarketScreenWatch | undefined {
  if (watch.market_id !== null) return;
  const config = JSON.parse(watch.notify_when);
  return config?.kind === 'market_screen' ? config : undefined;
}

type CatalogRow = {
  market_id: number; condition_id: string | null; gamma_market_id: string | null; title: string; slug: string | null;
  event_slug: string | null; event_id: string | null; is_open: boolean; active: boolean | null; closed: boolean | null;
  state_observed_at: string | null; metadata_observed_at: string | null; quote_observed_at: string | null;
  quote_source_updated_at: string | null; quote_identity_matches: boolean | null; gamma_volume_24h_usd: string | null;
  scope_count: number; token_id: string | null; outcome: string | null; clob_token_ids: string[];
};
type PriceRow = {
  market_id: number; token_id: string; first_price: string; last_price: string; first_time: string; last_time: string;
  price_change: string; fact_rows: number | string; last_ingested_at: string;
};
type Audit = {
  kind: string; marketId: number; tokenId: string; complete: boolean; blockTimeComplete: boolean;
  window?: { from: string; to: string }; watermark?: { to: string; exclusiveBlock: number; audited_at: string };
  chainRaw?: { exact: boolean; coveredThroughBlock: number };
  projection?: { exact: boolean; events: number; fact_rows: number; missing: number; unassigned: number; eventKeyDigest: string };
};
type Status = 'match' | 'excluded' | 'unknown';
type Item = ReturnType<typeof marketIdentity> & {
  key: string; tokenId?: string; outcome?: string; status: Status; reason?: string; passed: string[];
  volume24h?: { value: string; unit: 'USD'; observedAt: string; sourceUpdatedAt: string | null };
  tradeMove30m?: ReturnType<typeof priceSample> & { auditedEvents?: number }; auditEvidenceId?: string;
};
type Entry = { marketKey: string; marketId: number; tokenId?: string; firstOpenAt?: string; everMatched?: boolean;
  last?: { status: 'match' | 'excluded'; at: string; evidenceId: string } };
type ScreenState = { establishedAt?: string; baselineEvidenceId?: string; entries: Record<string, Entry> };

function marketIdentity(row: CatalogRow) {
  const conditionId = /^0x[0-9a-f]{64}$/i.test(row.condition_id ?? '') ? row.condition_id!.toLowerCase() : null;
  const marketKey = conditionId ? `polymarket:${conditionId}` : `polymarket:market-data/local:${row.market_id}`;
  const slug = row.slug && encodeURIComponent(row.slug);
  const eventSlug = row.event_slug && encodeURIComponent(row.event_slug);
  const marketUrl = eventSlug ? `${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${eventSlug}${slug && slug !== eventSlug ? `/${slug}` : ''}`
    : slug ? `${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${slug}` : null;
  return { marketKey, platform: 'polymarket' as const, marketId: row.market_id, conditionId, gammaMarketId: row.gamma_market_id,
    marketUrl, title: row.title, eventId: row.event_id, isOpen: row.is_open,
    stateObservedAt: row.state_observed_at, metadataObservedAt: row.metadata_observed_at };
}

const stamp = (time: number) => new Date(time).toISOString();
const secondAt = (time: string) => Math.floor(Date.parse(time) / 1000) * 1000;
const utc = (time: string) => stamp(Date.parse(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`));
const isFresh = (time: string | null, at: string) => {
  const age = Date.parse(at) - Date.parse(time ?? '');
  return age >= 0 && age <= catalogAgeSeconds * 1000;
};
const tokenKey = (id: string) => BigInt(id).toString(16).padStart(64, '0');
const validToken = (id: string | null): id is string => !!id && /^[1-9]\d{0,77}$/.test(id) && BigInt(id) < 2n ** 256n;

function priceSample(row: PriceRow, window: { from: string; to: string }) {
  const change = Number((Number(row.price_change) * 100).toFixed(8));
  return { firstPrice: row.first_price, lastPrice: row.last_price, firstAt: utc(row.first_time), lastAt: utc(row.last_time),
    delta: change, unit: 'pp' as const, factRows: Number(row.fact_rows), lastIngestedAt: utc(row.last_ingested_at), window };
}

async function executeScreen(db: DatabaseSync, screen: Screen, options: {
  asOf: string; catalogEvidenceId?: string; historical?: boolean; signal: AbortSignal; maxCalls: number; previous?: ScreenState;
}) {
  const { asOf, signal, previous } = options;
  const start = now();
  const deadline = AbortSignal.timeout(scanTimeoutMs);
  const readSignal = AbortSignal.any([signal, deadline]);
  const inputEvidenceIds: string[] = [];
  const errors: Record<string, string> = {};
  let calls = 0;
  const read = async (stage: string, operation: 'query' | 'trade_projection', args: Record<string, unknown>, metadata = {}) => {
    signal.throwIfAborted();
    if (calls >= options.maxCalls || deadline.aborted) return;
    calls++;
    try {
      const result = await researchEngine(operation, args, readSignal);
      const data: Record<string, unknown> = { ...result.data, ...metadata };
      const receipt = { ...saveEvidence(db, result.source, data, result.retrievedAt), data };
      inputEvidenceIds.push(receipt.evidenceId);
      return receipt;
    } catch (error) {
      signal.throwIfAborted();
      errors[stage] = deadline.aborted ? 'scan_time_budget_exhausted' : String(error);
    }
  };
  const bind = (columns: { name: string; type: string }[], rows: Record<string, unknown>[]) => {
    const receipt = saveEvidence(db, `${source}/parameters`, { kind: 'market_screen_parameters', columns, rows, datasets: [],
      rowCount: rows.length, truncated: false });
    inputEvidenceIds.push(receipt.evidenceId);
    return receipt;
  };

  const scope = directoryScope(screen);
  const scopeKey = fingerprint(scope);
  let catalog: Awaited<ReturnType<typeof read>>;
  if (options.historical) {
    const row = options.catalogEvidenceId
      ? db.prepare('SELECT * FROM evidence WHERE id=?').get(options.catalogEvidenceId)
      : db.prepare(`SELECT * FROM evidence WHERE source='market-data/research/query'
          AND json_extract(data,'$.screenCatalogAsOf')=? AND json_extract(data,'$.screenCatalogScopeKey')=? ORDER BY rowid DESC LIMIT 1`).get(asOf, scopeKey);
    if (row) {
      const data = JSON.parse(String(row.data));
      if (data.screenCatalogAsOf === asOf && data.screenCatalogScopeKey === scopeKey) {
        catalog = { evidenceId: String(row.id), source: String(row.source), retrievedAt: String(row.retrieved_at), data };
        inputEvidenceIds.push(catalog.evidenceId);
      }
    }
    if (!catalog) errors.catalog = 'historical_catalog_unavailable';
  } else {
    const from = screen.topic ? `research.markets('${screen.topic}'${screen.region ? `,'${screen.region}'` : ''})` : 'research.markets';
    const tracked = [...new Set(Object.values(previous?.entries ?? {}).filter(entry => entry.last?.status === 'match')
      .map(entry => entry.marketId))].filter(Number.isSafeInteger);
    const keywords = screen.keywords.map(pattern => ({ pattern: pattern.replace(/[!%_]/g, '!$&') }));
    const inputs = keywords.length ? [bind([{ name: 'pattern', type: 'text' }], keywords)] : undefined;
    const words = keywords.length ? `AND NOT EXISTS (SELECT 1 FROM result_1 k WHERE NOT (m.search_text LIKE '%' || k.pattern || '%' ESCAPE '!'))` : '';
    const trackedSql = tracked.length && screen.open_only ? `UNION ALL
      SELECT m.market_id FROM ${from} m WHERE NOT m.is_open AND m.market_id IN (${tracked.join(',')}) ${words}` : '';
    // Counting the unrestricted closed history can exceed the research statement budget.
    const searchLimit = screen.open_only ? undefined : historicalSearchLimit;
    const universe = searchLimit ? `recent AS MATERIALIZED (
      SELECT market_id, search_text FROM ${from} ORDER BY market_id DESC LIMIT ${searchLimit}
    ), ` : '';
    const population = searchLimit ? 'recent' : from;
    const tokenColumns = screen.min_abs_trade_move_30m_pp === undefined ? '' : ', c.clob_token_ids, o.token_id, o.outcome';
    const outcomeJoin = tokenColumns ? `LEFT JOIN LATERAL (
      SELECT o.token_id,o.outcome FROM research.outcomes o WHERE o.market_id=s.market_id AND o.condition_id=m.condition_id OFFSET 0
    ) o ON TRUE` : '';
    catalog = await read('catalog', 'query', { engine: 'postgres', as_of: asOf, inputs, max_rows: tokenColumns ? 6000 : directoryLimit,
      sql: `WITH ${universe}scoped AS (
        SELECT market_id, COUNT(*) OVER() AS scope_count FROM (
          SELECT m.market_id FROM ${population} m WHERE ${screen.open_only ? 'm.is_open' : 'TRUE'} ${words}
          ${trackedSql}
        ) population ORDER BY market_id DESC LIMIT ${directoryLimit}
      ) SELECT s.market_id,s.scope_count,m.condition_id,m.gamma_market_id,m.title,m.slug,m.event_id,m.is_open,m.active,m.closed,
        m.state_observed_at,m.metadata_observed_at,m.quote_observed_at,m.quote_source_updated_at,m.quote_identity_matches,
        m.gamma_volume_24h_usd,c.event_slug${tokenColumns}
        FROM scoped s LEFT JOIN LATERAL (SELECT * FROM research.markets m WHERE m.market_id=s.market_id OFFSET 0) m ON TRUE
        LEFT JOIN core.markets c ON c.id=s.market_id ${outcomeJoin}
        ORDER BY s.market_id DESC${tokenColumns ? ', o.token_id' : ''}` },
    { screenCatalogAsOf: asOf, screenCatalogScopeKey: scopeKey, screenCatalogScope: scope, includesOutcomes: Boolean(tokenColumns), searchLimit });
  }

  const directoryRows = new Map<number, CatalogRow[]>();
  const catalogRows = (catalog?.data.rows ?? []) as CatalogRow[];
  for (const row of catalogRows) {
    const rows = directoryRows.get(row.market_id) ?? [];
    rows.push(row);
    directoryRows.set(row.market_id, rows);
  }
  const items: Item[] = [];
  const pending: Item[] = [];
  for (const rows of directoryRows.values()) {
    const row = rows[0]!;
    const market = marketIdentity(row);
    const base: Item = { ...market, key: market.marketKey, status: 'match', passed: [
      ...(screen.topic ? ['topic'] : []), ...(screen.region ? ['region'] : []), ...(screen.keywords.length ? ['keywords'] : []),
    ] };
    if (Date.parse(row.metadata_observed_at ?? '') > Date.parse(asOf)) {
      items.push({ ...base, status: 'unknown', reason: 'catalog_metadata_after_cutoff' });
      continue;
    }
    const volume = row.gamma_volume_24h_usd;
    const volumeValid = row.quote_identity_matches === true && volume !== null && Number.isFinite(Number(volume)) && Number(volume) >= 0
      && isFresh(row.quote_observed_at, asOf) && (!row.quote_source_updated_at || Date.parse(row.quote_source_updated_at) <= Date.parse(asOf));
    if (volumeValid) base.volume24h = { value: volume, unit: 'USD', observedAt: row.quote_observed_at!, sourceUpdatedAt: row.quote_source_updated_at };
    const statusTimeValid = isFresh(row.state_observed_at, asOf);
    const visibleOpen = statusTimeValid && row.is_open;
    const statusKnown = statusTimeValid && (row.closed === true || row.active === false || visibleOpen);
    if (screen.open_only && statusKnown && !visibleOpen) {
      items.push({ ...base, status: 'excluded', reason: 'market_not_open' });
      continue;
    }
    if (screen.open_only && statusKnown) base.passed.push('open_only');
    if (screen.min_volume_24h_usd !== undefined && volumeValid && Number(volume) < screen.min_volume_24h_usd) {
      items.push({ ...base, status: 'excluded', reason: 'volume_below_threshold' });
      continue;
    }
    if (screen.open_only && !statusKnown) {
      items.push({ ...base, status: 'unknown', reason: 'open_state_missing_or_stale' });
      continue;
    }
    if (screen.min_volume_24h_usd !== undefined) {
      if (!volumeValid) {
        items.push({ ...base, status: 'unknown', reason: 'gamma_volume_missing_stale_or_unaligned' });
        continue;
      }
      base.passed.push('min_volume_24h_usd');
    }
    if (screen.min_abs_trade_move_30m_pp === undefined) {
      items.push(base);
      continue;
    }
    const tokens = new Map(rows.flatMap(r => validToken(r.token_id) && r.outcome ? [[r.token_id, r.outcome] as const] : []));
    if (!tokens.size || tokens.size !== new Set(row.clob_token_ids ?? []).size) {
      items.push({ ...base, status: 'unknown', reason: 'option_mapping_incomplete' });
    }
    for (const [tokenId, outcome] of tokens) {
      const item: Item = { ...base, key: `${base.key}/${tokenId}`, tokenId, outcome, status: 'unknown', passed: [...base.passed] };
      items.push(item);
      pending.push(item);
    }
  }

  let priceEvidenceId: string | undefined;
  let watermarkEvidenceId: string | undefined;
  let window: { from: string; to: string } | undefined;
  let watermark: Audit['watermark'];
  const activeFirst = (a: Item, b: Item) => Number(previous?.entries[b.key]?.last?.status === 'match') - Number(previous?.entries[a.key]?.last?.status === 'match');
  pending.sort(activeFirst);
  if (pending.length) {
    const anchor = pending[0]!;
    const initial = options.historical ? undefined : await read('trade_watermark', 'trade_projection', {
      market_id: anchor.marketId, token_id: anchor.tokenId, window_seconds: 1800, as_of: asOf,
    });
    watermarkEvidenceId = initial?.evidenceId;
    watermark = (initial?.data as Audit | undefined)?.watermark ?? undefined;
    const cutoff = options.historical ? secondAt(asOf) : Date.parse(watermark?.to ?? '');
    const lag = (secondAt(asOf) - cutoff) / 1000;
    const batch = pending.slice(0, priceLimit);
    if (Number.isFinite(cutoff) && lag >= 0 && lag <= maxAuditLagSeconds) {
      window = { from: stamp(cutoff - 1800000), to: stamp(cutoff) };
      const inputs = [bind([{ name: 'market_id', type: 'bigint' }, { name: 'token_key', type: 'text' }],
        batch.map(item => ({ market_id: item.marketId, token_key: tokenKey(item.tokenId!) })))];
      const prices = await read('trade_prices', 'query', { engine: 'clickhouse', inputs, max_rows: batch.length + 1, as_of: window.to,
        sql: `SELECT p.market_id,p.token_id,p.first_price,p.last_price,p.price_change,p.fact_rows,p.first_time,p.last_time,p.last_ingested_at
          FROM research_prices(start=:as_of-INTERVAL 30 MINUTE,end=:as_of) p
          INNER JOIN result_1 c ON p.market_id=c.market_id AND p.token_key=c.token_key
          WHERE p.market_id IN (SELECT market_id FROM result_1) AND p.token_key IN (SELECT token_key FROM result_1)` });
      priceEvidenceId = prices?.evidenceId;
      const byToken = new Map(((prices?.data.rows ?? []) as PriceRow[]).map(row => [`${row.market_id}/${row.token_id}`, row]));
      for (const item of batch) {
        const row = byToken.get(`${item.marketId}/${item.tokenId}`);
        if (row) item.tradeMove30m = priceSample(row, window);
        item.reason = !prices || prices.data.truncated ? 'price_query_unavailable_or_truncated' : !row ? 'no_observed_trades'
          : Number(row.fact_rows) < minimumTrades || item.tradeMove30m!.firstAt >= item.tradeMove30m!.lastAt ? 'sparse_trade_sample' : 'projection_audit_budget';
      }
      const candidates = batch.filter(item => item.reason === 'projection_audit_budget').sort((a, b) =>
        Math.abs(b.tradeMove30m!.delta) - Math.abs(a.tradeMove30m!.delta));
      const wasMatch = (item: Item) => previous?.entries[item.key]?.last?.status === 'match';
      const closing = candidates.filter(wasMatch).slice(0, auditLimit / 2);
      const emerging = candidates.filter(item => !wasMatch(item)).slice(0, auditLimit / 2);
      const toAudit = [...new Set([...closing, ...emerging, ...candidates])].slice(0, auditLimit);
      for (const item of toAudit) {
        const receipt = (item === anchor ? initial : undefined) ?? await read(item.key, 'trade_projection', {
          market_id: item.marketId, token_id: item.tokenId, as_of: now(), ...window,
        });
        if (!receipt) {
          if (errors[item.key]) item.reason = 'projection_audit_unavailable';
          continue;
        }
        item.auditEvidenceId = receipt.evidenceId;
        const audit = receipt.data as Audit, projection = audit.projection;
        const sample = item.tradeMove30m!;
        const verified = audit.kind === 'trade_projection_audit' && audit.marketId === item.marketId && audit.tokenId === item.tokenId
          && Date.parse(audit.window?.from ?? '') === cutoff - 1800000 && Date.parse(audit.window?.to ?? '') === cutoff
          && audit.complete && audit.blockTimeComplete && audit.chainRaw?.exact && projection?.exact && Number.isSafeInteger(projection.events) && projection.missing === 0
          && projection.unassigned === 0 && /^[a-f0-9]{64}$/.test(projection.eventKeyDigest)
          && projection.fact_rows === sample.factRows && sample.firstAt >= window.from && sample.lastAt < window.to;
        if (!verified || projection.events < minimumTrades) {
          item.reason = !verified ? 'trade_window_not_verified' : 'sparse_trade_sample';
          continue;
        }
        sample.auditedEvents = projection.events;
        if (Math.abs(sample.delta) >= screen.min_abs_trade_move_30m_pp!) {
          item.status = 'match';
          delete item.reason;
          item.passed.push('min_abs_trade_move_30m_pp');
        } else {
          item.status = 'excluded';
          item.reason = 'trade_move_below_threshold';
        }
      }
    }
    for (const item of pending) item.reason ??= item.status === 'unknown'
      ? window ? 'price_candidate_budget' : 'trade_audit_watermark_unavailable_or_lagging' : undefined;
  }

  const searchLimit = catalog?.data.searchLimit as number | undefined;
  const candidatesInSearch = catalog ? Number(catalogRows[0]?.scope_count ?? 0) : null;
  const candidateMarkets = searchLimit ? null : candidatesInSearch;
  const unscannedMarkets = candidateMarkets === null ? null : Math.max(0, candidateMarkets - directoryRows.size);
  const truncated = Boolean(catalog?.data.truncated || unscannedMarkets || searchLimit);
  const unknown: Record<string, number> = {};
  for (const item of items) if (item.status === 'unknown') unknown[item.reason!] = (unknown[item.reason!] ?? 0) + 1;
  const unknownCount = Object.values(unknown).reduce((sum, count) => sum + count, 0);
  const matches = items.filter(item => item.status === 'match').sort((a, b) => Math.abs(b.tradeMove30m?.delta ?? 0) - Math.abs(a.tradeMove30m?.delta ?? 0)
    || Number(b.volume24h?.value ?? -1) - Number(a.volume24h?.value ?? -1) || b.marketId - a.marketId || a.key.localeCompare(b.key));
  let previewSize = 0;
  const preview = matches.slice(0, screen.max_matches).filter(item => {
    previewSize += Buffer.byteLength(JSON.stringify(item));
    return previewSize <= previewBytes;
  });
  const coverage = { status: !catalog ? options.historical ? 'partial' as const : 'failed' as const : truncated || unknownCount ? 'partial' as const : 'complete' as const,
    scope, candidateMarkets, scannedMarkets: directoryRows.size, unscannedMarkets, evaluatedUnits: catalog ? items.length - unknownCount : null,
    ...(searchLimit ? { searchLimit, searchOrder: 'market_id_desc', candidatesInSearch } : {}),
    unit: screen.min_abs_trade_move_30m_pp === undefined ? 'market' : 'token_or_market_gate',
    matched: catalog ? matches.length : null, unknown: catalog ? unknownCount : null, excluded: catalog ? items.length - unknownCount - matches.length : null,
    directoryTruncated: catalog ? truncated : null, displayTruncated: matches.length > preview.length, displayed: preview.length, directoryLimit,
    catalogMode: options.historical ? 'saved_point_in_time' : 'current_directory', catalogEvidenceId: catalog?.evidenceId,
    catalogReadAt: catalog?.retrievedAt, maxCatalogAgeSeconds: catalogAgeSeconds,
    priceEvidenceId, watermarkEvidenceId, tradeWindow: window, auditWatermark: watermark, maxAuditLagSeconds, minimumTradeEvents: minimumTrades,
    priceLimit, auditLimit, calls, maxCalls: options.maxCalls, timeBudgetMs: scanTimeoutMs, errors };
  const columns = Object.entries({ marketId: 'bigint', marketUrl: 'text', conditionId: 'text', tokenId: 'text', outcome: 'text', title: 'text',
    status: 'text', reason: 'text', passed: 'text[]', volume24h: 'jsonb', tradeMove30m: 'jsonb',
    auditEvidenceId: 'text', stateObservedAt: 'timestamptz', metadataObservedAt: 'timestamptz' }).map(([name, type]) => ({ name, type }));
  const rows = [...matches, ...items.filter(item => item.status !== 'match')];
  const evidence = saveEvidence(db, source, { kind: 'sql_result', purpose: 'market_screen', engine: 'evidence', asOf,
    startedAt: start, readAt: now(), screen, coverage, selection: coverage, rows, columns, rowCount: rows.length, truncated,
    unknown: { count: coverage.unknown, reasons: unknown }, inputEvidenceIds });
  return { asOf, retrievedAt: evidence.retrievedAt, screen, coverage, evidenceId: evidence.evidenceId, items, matches: preview,
    unknown: { count: coverage.unknown, reasons: unknown } };
}

export function createMarketScreenTool(db: DatabaseSync, maxCalls: number) {
  return defineTool({ name: 'screen_markets', description: '用户按主题、关键词、开放状态、Gamma 24小时成交额或30分钟成交参考价变动筛选 Polymarket 市场时，直接用此工具。条件为 AND。美国等地域与主题同传 region。返回查询范围、未判定原因、市场链接与证据。明确要求订阅时，把回执的 screen 原样传给 create_watch_task。',
    parameters: { ...parameters, as_of: { type: 'string', description: '回放截点，须带时区，并有同截点同范围的已保存目录。' },
      catalog_evidence_id: { type: 'string', description: '选填，回放所用的目录快照 evidence ID。' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ as_of, catalog_evidence_id, ...input }, exec) {
      if (catalog_evidence_id && !as_of) throw new Error('目录回放需要 as_of。');
      if (as_of && (!/(?:Z|[+-]\d\d:\d\d)$/i.test(as_of) || !Number.isFinite(Date.parse(as_of)) || Date.parse(as_of) > Date.now())) {
        throw new Error('as_of 须是带时区且不超过当前时间的有效截点。');
      }
      const screen = normalizeScreen(input);
      const { items, matches, ...result } = await executeScreen(db, screen, {
        asOf: as_of ? stamp(Date.parse(as_of)) : now(), historical: Boolean(as_of), catalogEvidenceId: catalog_evidence_id,
        maxCalls, signal: exec.signal,
      });
      return JSON.stringify({ ...result, matches, observedUnknown: items
        .filter(item => item.status === 'unknown' && item.tradeMove30m).slice(0, Math.min(screen.max_matches, 5)) });
    },
  });
}

function noticeText(watch: Watch, scan: Awaited<ReturnType<typeof executeScreen>>, changes: { item: Item; change: string; gap: boolean }[]) {
  const kinds: Record<string, string> = { initial: '初始命中', first_seen: '本次首次观察到', first_entry: '首次进入', reentry: '退出后重新进入' };
  return [`${watch.goal} · ${changes.length} 项提醒`, `UTC ${scan.asOf} · 本轮共 ${scan.coverage.matched} 项命中，${scan.coverage.unknown} 项未判定，${scan.coverage.unscannedMarkets ?? '未知'} 个市场未扫描`,
    ...changes.slice(0, 10).map(({ item, change, gap }) => {
      const move = item.tradeMove30m, volume = item.volume24h;
      return [`${kinds[change]} · ${item.title}${item.outcome ? ` · ${item.outcome}` : ''}${gap ? '（检查间有缺口，触发时间未知）' : ''}`,
        volume && `Gamma 24h 成交额 ${volume.value} USD，观察于 ${volume.observedAt}`,
        move && `30分钟已审计成交参考价 ${move.firstPrice}（${move.firstAt}）→ ${move.lastPrice}（${move.lastAt}），${move.delta > 0 ? '+' : ''}${move.delta} 个百分点，${move.auditedEvents} 条唯一日志，窗口截至 ${move.window.to}`,
        item.marketUrl].filter(Boolean).join('\n');
    }), `证据 ${scan.evidenceId}`].join('\n\n');
}

export async function checkMarketScreenWatch(db: DatabaseSync, watch: Watch, config: MarketScreenWatch, runId: string,
  occurrence: string, asOf: string, trigger: 'timed' | 'manual', signal: AbortSignal) {
  const rows = db.prepare(`SELECT watch_version, status, result FROM runs WHERE watch_id=? AND id<>?
    AND json_valid(result) AND json_extract(result,'$.scopeVersion')=? AND json_extract(result,'$.conditionKey')=?
    ORDER BY rowid DESC LIMIT 1`).get(watch.id, runId, config.scopeVersion, config.conditionKey);
  const prior = rows && JSON.parse(String(rows.result)) as { state: ScreenState; asOf: string; evidenceId: string } | undefined;
  const state: ScreenState = prior?.state ?? { entries: {} };
  const scan = await executeScreen(db, config.screen, { asOf, signal, previous: state, maxCalls: watch.max_tool_calls });
  const hadBaseline = Boolean(state.establishedAt);
  if (!hadBaseline && ((scan.coverage.evaluatedUnits ?? 0) > 0 || scan.coverage.status === 'complete')) {
    state.establishedAt = scan.asOf;
    state.baselineEvidenceId = scan.evidenceId;
  }
  let entries = Object.keys(state.entries).length;
  let stateOmitted = 0;
  const changes: { item: Item; change: string; gap: boolean }[] = [];
  const trackedByMarket = new Map<string, Entry[]>();
  for (const entry of Object.values(state.entries)) {
    const tracked = trackedByMarket.get(entry.marketKey) ?? [];
    tracked.push(entry);
    trackedByMarket.set(entry.marketKey, tracked);
  }
  const update = (entry: Entry, status: 'match' | 'excluded') => { entry.last = { status, at: scan.asOf, evidenceId: scan.evidenceId }; };
  const differentOccurrence = prior && Date.parse(scan.asOf) - Date.parse(prior.asOf) > (watch.interval_seconds + 15) * 1000;
  const gap = Boolean(prior && (rows?.status !== 'complete' || rows.watch_version !== watch.version || differentOccurrence));
  const tokenScreen = config.screen.min_abs_trade_move_30m_pp !== undefined;
  for (const item of scan.items) {
    if (tokenScreen && !item.tokenId && item.status === 'excluded') {
      for (const entry of trackedByMarket.get(item.marketKey) ?? []) update(entry, 'excluded');
    }
    let entry = state.entries[item.key];
    const wasTracked = Boolean(entry);
    if (!entry) {
      if (entries >= stateLimit) { stateOmitted++; continue; }
      entries++;
      entry = state.entries[item.key] = { marketKey: item.marketKey, marketId: item.marketId, tokenId: item.tokenId };
    }
    const seenOpen = Boolean(entry.firstOpenAt);
    if (item.isOpen && isFresh(item.stateObservedAt, scan.asOf)) entry.firstOpenAt ??= scan.asOf;
    if (item.status === 'unknown') continue;
    if (item.status === 'match' && entry.last?.status !== 'match') {
      const change = !hadBaseline ? config.notifyOnInitial ? 'initial' : undefined
        : entry.everMatched ? 'reentry' : entry.last?.status === 'excluded' || seenOpen || state.entries[item.marketKey]?.firstOpenAt ? 'first_entry' : 'first_seen';
      if (change) changes.push({ item, change, gap: gap || Boolean(prior && wasTracked && entry.last?.at !== prior.asOf) });
      entry.everMatched = true;
    }
    update(entry, item.status);
  }

  signal.throwIfAborted();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getWatch(db, watch.id), at = now();
    const running = db.prepare("SELECT id FROM runs WHERE id=? AND status='running'").get(runId);
    if (!running) {
      db.exec('COMMIT');
      return;
    }
    if (current.status !== 'active' || current.version !== watch.version || current.expires_at <= at || current.schedule_id !== watch.schedule_id) {
      db.prepare("UPDATE runs SET status='cancelled',finished_at=?,error=? WHERE id=? AND status='running'")
        .run(at, '提交前任务已变更、暂停或到期。', runId);
    } else {
      const status = stateOmitted && scan.coverage.status === 'complete' ? 'partial' : scan.coverage.status;
      const coverage = { ...scan.coverage, status, stateOmitted, stateLimit };
      const eventKey = changes.length ? fingerprint([config.conditionKey, config.scopeVersion, watch.schedule_id, occurrence,
        changes.map(({ item, change }) => [item.key, change]).sort()]) : undefined;
      const noticeId = eventKey ? randomUUID() : undefined;
      if (eventKey) db.prepare('INSERT INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
        .run(noticeId!, watch.id, runId, eventKey, noticeText(watch, scan, changes), at);
      db.prepare('INSERT INTO coverage VALUES (?,?,?,?,?)').run(runId, source, scan.evidenceId, status, JSON.stringify(coverage));
      db.prepare("UPDATE runs SET status=?,finished_at=?,tool_calls=?,result=? WHERE id=? AND status='running'")
        .run(status, at, coverage.calls, JSON.stringify({ kind: 'market_screen_check', scheduleId: watch.schedule_id, occurrence, trigger, asOf: scan.asOf,
          conditionKey: config.conditionKey, scopeVersion: config.scopeVersion, evidenceId: scan.evidenceId, coverage, state,
          changes: changes.map(({ item, ...change }) => ({ ...change, marketId: item.marketId, tokenId: item.tokenId, key: item.key })),
          noticeId, eventKey }), runId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
