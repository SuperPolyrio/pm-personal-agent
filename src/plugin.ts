import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ScheduleId } from '@deepseek-ai/dsh-schedule';
import { ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { createServer } from 'node:net';
import { chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openStore, now, stateDir, saveRecord, listRecords, saveEvidence, getWatch, saveWatchVersion, type Watch } from './store.js';
import { polymonitorUrl, readMarketData, resolveMarket, validateSources, sourceCoverage, type Source } from './data.js';
import { researchEngine } from './market-data.js';
import { checkMarketScreenWatch, createMarketScreenTool, marketScreenSchema, marketScreenWatch,
  prepareMarketScreenWatch, screenWatchPrompt } from './market-screen.js';
import { analyzeResults, resultPreview } from './analysis.js';
import { createSourceEvidenceTools, normalizeSourceEvidence, sourceSnapshotFromEvidence,
  type EvidenceRow, type SourceEvidenceCandidates, type SourceEvidenceRequest } from './source-evidence.js';
import { assessRuleEvidence, createResearchTools, type RuleCard, type SavedNormalizedEvidence } from './research.js';
import { createMarketOddsLookupTool, createOddsForecastTools } from './odds-forecast.js';
import { createPolymarketPublicReader } from './polymarket-public.js';
import { createSportsAssistant, sportsTimestamp, sportsWatch, sportsWatchPrompt, sportsWatchSource } from './sports.js';
import { createNbaSports } from './sports-nba.js';
import { createTennisSports } from './sports-tennis.js';
import { createTennisResearchTool } from './tennis-research.js';
import { createCs2Sports } from './sports-cs2.js';
import { createCs2CommentaryTool } from './sports-cs2-stream.js';
import { createPortfolioReconcileTool } from './portfolio-reconcile.js';
import { createMarketWebSearchTools } from './market-web-search.js';
import { createWeatherMarket, weatherInterval, weatherSource } from './weather-market.js';
import { locationWatch, locationWatchPrompt } from './weather-location.js';
import { createXPostsTool } from './x-posts.js';
import { createXTrackerTool } from './xtracker.js';
import { createEqnNewsTool } from './eqn-news.js';
import { eqnWatchNotice, eqnWatchPlan, eqnWatchPrompt, eqnWatchSchema, eqnWatchSource, prepareEqnWatch,
  scanEqnWatch, type EqnWatch, type EqnWatchPage, type EqnWatchState } from './eqn-watch.js';
import { observeXWatch, prepareXWatch, xWatchArguments, xWatchPlan, xWatchPrompt, xWatchSchema, xWatchTool,
  type XWatch, type XWatchReceipt, type XWatchState } from './x-watch.js';
import { createCryptoIndicatorsTool, cryptoIntervals } from './crypto-indicators.js';
import { cryptoPaperPlan, cryptoPaperReady, cryptoPaperSource, cryptoPaperTitle, finishCryptoPaper,
  isCryptoPaper, paperPolicy, paperSignalFields, refreshCryptoPaper, runCryptoPaper, validatePaperPolicy,
  type PaperPolicy, type CryptoPaperRun, type IndicatorStatus } from './crypto-paper.js';
import { cryptoNotice, cryptoOccurrence, cryptoTrigger, cryptoWatchPlan, cryptoWatchPrompt, cryptoWatchSchema,
  cryptoWatchSource, observeCryptoWatch, prepareCryptoWatch, type CryptoWatch } from './crypto-watch.js';
import { telegramMarketGuard, toolEvidenceIds } from './telegram-research.js';
import { createWatchTools, describeWatchState, readWatchSourceEvidence, readWatchRuleEvidence, watchSourceExpired,
  type MarketWatchNotice, type RuntimeWatch, type WatchHost, type WatchRead,
  type WatchItemRequest, type WatchObservation, type WatchPlan, type WatchPlanRequest, type WatchState } from './tasks.js';
import { activityDay, bookAnomalySource, estimateBook, qualifiedBook, tradeActivityBaseline, tradeAnomalySource,
  isWatchTimeout, significantTradePriceChange, spreadWidened, thinTradePrices, tradePriceChange,
  largeTradeContextMs, largeTradeFeedTime, largeTradeFindings, largeTradeScope, largeTradeSource, officialTradeTime,
  formatWatchNotice, watchActivity, watchFailureCounts, type TradeSample } from './watch-activity.js';

export const name = 'pm-personal';
export const inject = ['tools', 'agents', 'sessions', 'schedule', 'systemPrompt', 'llm', 'web'];
const text = { type: 'string', required: true } as const;
const integer = { type: 'integer', required: true } as const;
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const json = (value: unknown) => JSON.stringify(value);
// Field meanings already live on columns; don't repeat them in model context.
function schemaPreview(schema: Record<string, unknown>, preload = false) {
  const { fields: _fields, columns, indexes, storage, notes, coverage, dialectNotes, queryNotes, ...metadata } = schema;
  return { ...metadata, columns: (columns as Record<string, unknown>[]).map(({ name, type, meaning }) =>
    [name, type, meaning].filter(Boolean).join(': ')),
    ...(!preload ? { indexes, storage, notes, coverage, dialectNotes, queryNotes } : {}) };
}
const queryTemperature = Number(process.env.PM_QUERY_TEMPERATURE ?? 0.7);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)).digest('hex');
const watchPrompt = (id: string) => `你是持续任务 ${id} 本次检查的执行者。加载 pm-watch Skill，调用 read_watch_sources 读取本次来源，最后调用 finish_watch_check 保存结果。必须执行这些工具操作，不能只报告任务正在运行或复述历史结果。`;
const marketWatchPrompt = '执行当前原生唤醒的通用市场盯盘检查。';
const optionalText = { type: 'string' } as const;
const optionalInteger = { type: 'integer' } as const;
const sources = { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
  path: text, time_field: { ...text, description: '已读取快照中的来源观察时间字段，用点分隔；缺失将标记 unknown。' }, max_age_seconds: integer,
  checks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { field: text, equals: { type: 'json', required: true } } } },
} } } as const;

export async function apply(ctx: Context) {
  const db = openStore();
  const marketSkill = readFileSync(new URL('../.dsh/skills/market-data/SKILL.md', import.meta.url), 'utf8');
  ctx.effect(() => () => db.close());
  const active = new Map<string, { id: string; asOf: string; watch?: Watch; models: number; tools: number; reply?: string;
    liveSportsList?: boolean; liveSportsRead?: boolean; liveSportsCompetition?: string; cs2StreamRequested?: boolean;
    marketOddsResult?: { reply: string; judgment?: { summary?: string }; conclusion?: string };
    weatherEvidenceIds?: Set<string>;
    releaseTools?: () => void;
    sourceComparison?: { evidenceId: string; kind: 'source_evidence_comparison'; status: string; after: unknown; before?: unknown };
    marketReads?: Map<number, Promise<ReturnType<typeof saveEvidence>>>;
    pageAttempts?: Map<string, number>;
    externalReads?: Map<string, Promise<SavedNormalizedEvidence>>;
    queries: Map<string, Promise<ReturnType<typeof saveEvidence>>> }>();
  const schemas = new Map<string, Record<string, unknown>>();
  let catalog: unknown;
  async function loadMetadata() {
    const signal = AbortSignal.timeout(18_000);
    const result = await researchEngine('discover', {}, signal);
    catalog = (result.data.datasets as Record<string, unknown>[]).map(({ name, engine, description }) => ({ name, engine, description }));
    const datasets = (process.env.PM_QUERY_SCHEMAS ?? 'research.markets,research_activity,research_prices').split(',').map(s => s.trim()).filter(Boolean);
    if (datasets.length) {
      const result = await researchEngine('describe', { datasets }, signal);
      // Cache schema and semantics only; row presence must be checked at query time.
      for (const schema of result.data.datasets as Record<string, unknown>[]) schemas.set(String(schema.name), schemaPreview(schema, true));
    }
  }
  await loadMetadata().catch(error => ctx.logger.warn(`Schema preload failed; discover_data remains available: ${String(error)}`));
  const owned = new Set<string>();
  const maxModels = Number(process.env.PM_MAX_MODEL_CALLS ?? 24);
  const maxTools = Number(process.env.PM_MAX_TOOL_CALLS ?? 80);
  if (![maxModels, maxTools].every(n => Number.isInteger(n) && n > 0)) throw new Error('模型和工具预算必须是正整数。');
  const socketPath = resolve(stateDir, 'control.sock');
  db.prepare("UPDATE runs SET status='interrupted',finished_at=?,error='宿主退出，未确认完成' WHERE status='running'").run(now());

  function register(tool: Parameters<typeof ctx.tools.register>[0]) {
    owned.add(tool.name);
    ctx.tools.register(tool);
  }
  async function capture(path: string, signal: AbortSignal) {
    const result = await readMarketData(path, signal);
    return json(saveEvidence(db, result.source, result.data, result.retrievedAt));
  }
  register(createCryptoIndicatorsTool((source, data, retrievedAt) => saveEvidence(db, source, data, retrievedAt)));

  const evidenceById = db.prepare('SELECT source,retrieved_at,data FROM evidence WHERE id=?');
  function provenance(id: string, seen = new Set<string>()): Record<string, unknown>[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const row = evidenceById.get(id);
    if (!row) return [];
    const data = JSON.parse(row.data as string);
    if (data.kind !== 'sql_result' && data.kind !== 'code_result') return [];
    const computed = data.kind === 'code_result' || data.kind === 'sql_result'
      && (data.engine === 'evidence' || data.refreshedDatasets?.length === 0);
    const inputs = data.inputEvidence?.map((input: { evidenceId: string }) => input.evidenceId) ?? data.inputEvidenceIds ?? [];
    return [{ evidenceId: id, resultCreatedAt: row.retrieved_at,
      sourceReadAt: computed ? null : row.retrieved_at,
      sourceObservationRanges: (data.kind === 'sql_result' ? data.freshness ?? [] : []).map(({ column, oldestObservedAt, newestObservedAt }: Record<string, unknown>) =>
        ({ column, oldestObservedAt, newestObservedAt })),
      meaning: computed ? '计算已有快照，没有重新采集或读取源库；原始来源见下面输入证据。'
        : 'sourceReadAt是查询读取时间，不能代替来源采集/交易/结算时间；这些时间使用原始字段。' },
      ...inputs.flatMap((input: string) => provenance(input, seen))];
  }
  function loadEvidence(id: string) {
    const row = evidenceById.get(id);
    if (row) return {
      evidenceId: id, source: row.source as string, retrievedAt: row.retrieved_at as string,
      data: JSON.parse(row.data as string),
    };
  }
  function savedEvidence(ids: string[]) {
    return ids.map(id => {
      const evidence = loadEvidence(id);
      if (!evidence) throw new Error(`证据不存在: ${id}`);
      return evidence;
    });
  }

  const saveToolEvidence = (source: string, data: unknown, retrievedAt: string) => saveEvidence(db, source, data, retrievedAt);
  register(createXPostsTool(saveToolEvidence));
  register(createXTrackerTool({ saveEvidence: saveToolEvidence, loadEvidence }));
  const eqnNews = createEqnNewsTool(saveToolEvidence);
  register(eqnNews);

  for (const tool of createSourceEvidenceTools({
    loadEvidence,
    saveEvidence: (source, data, retrievedAt) => saveEvidence(db, source, data, retrievedAt),
    async loadMarketRules(id, signal) {
      const result = await resolveMarket(`local:${id}`, signal);
      return saveEvidence(db, result.source, result.data, result.retrievedAt);
    },
  })) register(tool);
  for (const tool of createResearchTools({
    loadEvidence,
    saveEvidence: (source, data, retrievedAt) => saveEvidence(db, source, data, retrievedAt),
  })) register(tool);
  const publicReader = createPolymarketPublicReader((source, data, retrievedAt) => saveEvidence(db, source, data, retrievedAt));
  register(publicReader.tool);
  const sportsHost = { saveEvidence: (source: string, data: unknown, retrievedAt?: string) => saveEvidence(db, source, data, retrievedAt),
    loadEvidence };
  const sports = createSportsAssistant({ ...sportsHost, db, read: publicReader.read }, [
    createNbaSports(sportsHost), createTennisSports(sportsHost), createCs2Sports({ ...sportsHost, readMarketData }),
  ]);
  register(sports.tool);
  register(createTennisResearchTool({ ...sportsHost, db, read: publicReader.read }));
  const cs2Commentary = createCs2CommentaryTool({ read: publicReader.read, loadEvidence });
  register(cs2Commentary.tool);
  ctx.effect(() => cs2Commentary.close);
  const screenTool = createMarketScreenTool(db, maxTools);
  const weather = createWeatherMarket(db, publicReader.read, loadEvidence, async (city, openOnly, signal) =>
    JSON.parse(await screenTool.execute({ topic: 'weather', keywords: [city], open_only: openOnly, max_matches: 100 },
      { signal } as Parameters<typeof screenTool.execute>[1]) as string));
  register(weather.tool);
  register(createPortfolioReconcileTool({ read: publicReader.read, resolveMarket, loadEvidence,
    saveEvidence: (source, data, retrievedAt) => saveEvidence(db, source, data, retrievedAt) }));
  const oddsHost = {
    resolveTarget: resolveMarket, readOdds: readMarketData,
    readOfficialBook: (target: { tokenId: string; conditionId: string }, signal: AbortSignal) =>
      publicReader.read({ view: 'book', id: target.tokenId, condition_id: target.conditionId }, signal),
    loadEvidence,
    saveEvidence: (source: string, data: unknown, retrievedAt: string, id?: string) => saveEvidence(db, source, data, retrievedAt, id),
  };
  register(createMarketOddsLookupTool(oddsHost));
  for (const tool of createOddsForecastTools(oddsHost)) register(tool);
  for (const tool of createMarketWebSearchTools({
    db, loadEvidence, saveEvidence: (source, data, retrievedAt) => saveEvidence(db, source, data, retrievedAt),
  })) register(tool);

  function savedResults(ids: string[]) {
    const results = savedEvidence(ids);
    for (const item of results) if (item.data.kind !== 'sql_result') throw new Error(`证据不是 SQL 结果: ${item.evidenceId}`);
    return results;
  }


  register(defineTool({ name: 'resolve_market', description: '直接从 market-data 解析 Polymarket 链接、slug、local:ID、gamma:ID 或 condition:0x...，读取规则原文、身份、当前报价和观察时间；事件页返回候选。',
    parameters: { input: text }, output,
    async execute({ input }, exec) {
      const run = active.get(exec.agent?.session.id ?? '');
      const local = /^local:(\d+)$/.exec(input.trim());
      if (run && local) return json(await marketSnapshot(Number(local[1]), run, exec.signal));
      const result = await resolveMarket(input, exec.signal);
      return json(saveEvidence(db, result.source, result.data, result.retrievedAt));
    },
  }));
  register(defineTool({ name: 'discover_data', description: '查看已注册的数据集、引擎和口径；目录不探测存储。已知来源和字段时直接 query_sql；缺少字段时 describe_data。目录不证明采集完整或新鲜。',
    parameters: {}, output,
    async execute(_args, exec) {
      const result = await researchEngine('discover', {}, exec.signal);
      catalog = (result.data.datasets as Record<string, unknown>[]).map(({ name, engine, description }) => ({ name, engine, description }));
      return json(saveEvidence(db, result.source, result.data, result.retrievedAt));
    },
  }));
  register(defineTool({ name: 'describe_data', description: '一次查看多个数据集的实际字段、索引、关联键、口径和访问方法；PostgreSQL 同时返回 hasRows。把需要的表一起传入，已确认空表无需反复 count。',
    parameters: { datasets: { type: 'array', items: { type: 'string' }, required: true, description: 'discover_data 中的数据集名称，可批量读取。' } }, output,
    async execute(args, exec) {
      const result = await researchEngine('describe', args, exec.signal);
      const evidence = saveEvidence(db, result.source, result.data, result.retrievedAt);
      return json({ ...evidence, data: { ...result.data,
        datasets: (result.data.datasets as Record<string, unknown>[]).map(schema => schemaPreview(schema)) } });
    },
  }));
  register(defineTool({ name: 'query_sql', description: 'Execute read-only SQL and save up to 10000 rows with source, timestamps and truncation metadata. postgres/clickhouse read source datasets; evidence queries saved snapshots with DuckDB using result_1,result_2,... or previous_result for one input. Use saved results for follow-ups. Read further rows with read_evidence when needed, then answer the user normally using the evidence.',
    parameters: { engine: { ...text, enum: ['postgres', 'clickhouse', 'evidence'] }, sql: { ...text, description: "只读SQL，:as_of绑定本轮UTC。PostgreSQL/DuckDB: INTERVAL '1 day'；ClickHouse: INTERVAL 1 DAY。排序写DESC NULLS LAST。字段未知用describe_data，不猜字段。" },
      catalog_sql: { type: 'string', description: 'ClickHouse跨库查询：PostgreSQL SELECT绑定为catalog，支持超过10000行的内部关联。投影所需字段；两条SQL均支持:as_of。目录限定主题/地域时用INNER或半连接，仅补字段时可LEFT JOIN。按完整范围聚合后排名；重排已有选集时可使用该选集，说明实际范围。' },
      evidence_ids: { type: 'array', items: { type: 'string' }, description: '绑定完整保存结果为result_1、result_2等。engine=evidence时必填，用于连续筛选/排序；engine=postgres/clickhouse时可选，分别用原生JSON记录集CTE/external tables关联源表，避免把数千ID写进SQL。不会刷新输入快照；ClickHouse输入与catalog的时间列保留UTC DateTime64类型，JSON列为String。' },
      preview_rows: { type: 'integer', description: '模型预览行数，默认20，上限100，最多6000字符；0只返回元数据。完整结果另存，可用read_evidence分页读取。同轮相同SQL复用结果或错误；下一轮重新读取。' } }, output,
    async execute({ engine, sql, catalog_sql, evidence_ids, preview_rows = 20 }, exec) {
      if (engine === 'evidence' && !evidence_ids?.length) throw new Error('engine=evidence需要明确的输入evidence_ids。');
      const run = active.get(exec.agent?.session.id ?? '');
      const cache = run?.queries;
      const key = json([engine, sql.trim().replace(/;+$/, ''), catalog_sql?.trim(), evidence_ids]);
      let pending = cache?.get(key);
      const reused = Boolean(pending);
      if (!pending) {
        pending = researchEngine('query', { engine, sql, catalog_sql, max_rows: 10000, as_of: run?.asOf,
          ...(evidence_ids?.length ? { inputs: savedResults(evidence_ids) } : {}) }, exec.signal)
          .then(result => saveEvidence(db, result.source, result.data, result.retrievedAt));
        cache?.set(key, pending);
      }
      let evidence: Awaited<typeof pending>;
      try { evidence = await pending; }
      catch (error) { throw new Error(`${reused ? '缓存的同一查询错误，本次没有再次访问数据库。' : ''}${String(error)}\n修正SQL或用describe_data查字段；资源错误需调整执行方式而非擅自缩小用户范围。相同SQL在本轮只会返回此错误。`); }
      return json({ ...evidence, reused, data: resultPreview(evidence.data as Record<string, unknown>, Math.max(0, Math.min(100, preview_rows))),
        provenance: provenance(evidence.evidenceId) });
    },
  }));
  register(defineTool({ name: 'analyze_result', description: '用隔离 Python 分析已保存 SQL 结果，可跨查询/数据库关联、统计、排序。环境有 results、frames（同序 pandas DataFrame）、pd、np。results[i] 是 {evidenceId,source,retrievedAt,data:{rows:[{列名:值}],columns,truncated,...}}，行是字典。日期和 Decimal 为 JSON 字符串，需计算时用 pd.to_datetime/pd.to_numeric；数组列已经是列表，不用 eval。用 print 输出所需结果，避免重复输出代码。无网络、宿主目录或数据库凭据；15 秒、2 GiB、64 KiB 输出上限。',
    parameters: { evidence_ids: { type: 'array', items: { type: 'string' }, required: true }, code: text }, output,
    async execute({ evidence_ids, code }, exec) {
      if (!evidence_ids.length) throw new Error('分析需要 SQL 结果证据 ID。');
      let inputBytes = 0;
      const results = evidence_ids.map(id => {
        const saved = db.prepare('SELECT * FROM evidence WHERE id=?').get(id);
        if (!saved) throw new Error(`证据不存在: ${id}`);
        inputBytes += Buffer.byteLength(saved.data as string);
        if (inputBytes > 32 * 1024 * 1024) throw new Error('分析输入超过 32 MiB；先用 SQL 聚合或只选分析需要的列。');
        const data = JSON.parse(saved.data as string);
        if (data.kind !== 'sql_result') throw new Error(`证据不是 SQL 结果: ${id}`);
        return { evidenceId: id, source: saved.source, retrievedAt: saved.retrieved_at, data };
      });
      const result = await analyzeResults(results, code, exec.signal);
      const evidence = saveEvidence(db, 'market-data/analysis/python', { kind: 'code_result', inputEvidenceIds: evidence_ids,
        inputTruncated: results.some(r => r.data.truncated), code, ...result }, now());
      const { code: _code, ...data } = evidence.data as Record<string, unknown>;
      return json({ ...evidence, data });
    },
  }));
  register(defineTool({ name: 'read_market', description: '读取本地市场的规则、身份、原始时效或结算证据并保存快照。market_id 必须是已解析的本地 ID。本轮已有规则正文和证据 ID 时直接使用。',
    parameters: { market_id: integer, view: { ...text, enum: ['rules', 'workspace', 'oracle', 'book'] } }, output,
    async execute({ market_id, view }, exec) {
      if (view === 'rules') {
        const run = active.get(exec.agent?.session.id ?? '');
        if (run) return json(await marketSnapshot(market_id, run, exec.signal));
        const result = await resolveMarket(`local:${market_id}`, exec.signal);
        return json(saveEvidence(db, result.source, result.data, result.retrievedAt));
      }
      const path = view === 'book' ? `/runtime/lob/${market_id}` : `/markets/${market_id}/${view}`;
      return capture(path, exec.signal);
    },
  }));
  register(defineTool({ name: 'read_panel', description: '读取 Polymonitor 一个已知 Panel 的现有快照，保留来源与过期状态；不是创建采集器。',
    parameters: { panel_id: text }, output,
    execute({ panel_id }, exec) { return capture(`/runtime/panels/${encodeURIComponent(panel_id)}?limit=10`, exec.signal); },
  }));
  register(defineTool({ name: 'save_record', description: '按用户要求保存研究、判断、决定或手工持仓。修改用 id 和 expected_version。证据必须引用已经读取的 evidence_id。用户原话与 Agent 分析分开记录。',
    parameters: {
      kind: { ...text, enum: ['research', 'thesis', 'decision', 'position'] }, market_id: integer,
      author: { ...text, enum: ['user', 'agent'] }, text, invalid_when: { type: 'string' },
      evidence_ids: { type: 'array', items: { type: 'string' }, required: true },
      thesis_id: { type: 'string' }, thesis_version: { type: 'integer' }, probability: { type: 'number' }, review_at: { type: 'string' },
      outcome_token_id: { type: 'string' }, quantity: { type: 'number' }, cost: { type: 'number', description: '总成本，未知时省略；不是每份价格。' },
      direction: { type: 'string', enum: ['long', 'short'] }, occurred_at: { type: 'string' },
      action: { type: 'string', enum: ['observe', 'no_trade', 'undecided', 'manual_buy', 'manual_sell', 'plan'] },
      id: { type: 'string' }, expected_version: { type: 'integer' },
    }, output,
    async execute(args, exec) {
      for (const id of args.evidence_ids) if (!db.prepare('SELECT id FROM evidence WHERE id=?').get(id)) throw new Error(`证据不存在: ${id}`);
      if (args.quantity !== undefined && args.quantity < 0) throw new Error('持仓份数不能为负数。');
      if (args.cost !== undefined && args.cost < 0) throw new Error('成本不能为负数。');
      if (args.probability !== undefined && (args.probability < 0 || args.probability > 1)) throw new Error('主观概率范围为 0 到 1。');
      if (args.thesis_id && !db.prepare("SELECT id FROM records WHERE id=? AND version=? AND kind='thesis' AND market_id=?")
        .get(args.thesis_id, args.thesis_version ?? null, args.market_id)) throw new Error('关联判断需要同一市场的明确 ID 和版本。');
      if (args.kind === 'position' && args.outcome_token_id) {
        const evidence = args.evidence_ids.map(id => JSON.parse(db.prepare('SELECT data FROM evidence WHERE id=?').get(id)!.data as string));
        if (!evidence.some(m => m.localMarketId === args.market_id && m.outcomeSemanticsValid === true
          && [m.yesTokenId, m.noTokenId].includes(args.outcome_token_id))) throw new Error('持仓选项必须与所引用的市场身份快照匹配。');
      }
      const { id, expected_version, ...data } = args;
      return json(saveRecord(db, { id, expectedVersion: expected_version, kind: args.kind, marketId: args.market_id,
        data: { ...data, source: args.kind === 'position' ? 'manual' : args.author,
          ...(args.kind === 'position' ? { quantity: args.quantity ?? null, cost: args.cost ?? null, direction: args.direction ?? null, outcome_token_id: args.outcome_token_id ?? null } : {}) },
        operationId: hash([active.get(exec.agent?.session.id ?? '')?.id ?? exec.callId, args]),
      }));
    },
  }));
  register(defineTool({ name: 'read_records', description: '读取个人研究、判断、手工持仓和决策。提供 id 可查看全部历史版本，提供 market_id 可筛选市场。',
    parameters: { id: { type: 'string' }, market_id: { type: 'integer' } }, output,
    async execute({ id, market_id }) { return json(id ? db.prepare('SELECT * FROM records WHERE id=? ORDER BY version').all(id) : listRecords(db, market_id)); },
  }));
  register(defineTool({ name: 'read_evidence', description: '按证据 ID 回看原始快照。SQL 预览可用 offset 翻页；完整数据也可直接交给 analyze_result。连续追问保留原选集，不重新计算全市场榜单。',
    parameters: { id: text, offset: { type: 'integer', description: 'SQL预览起始行，默认0。' }, rows: { type: 'integer', description: '读取行数，默认20，上限100，最多6000字符。' },
      view: { type: 'string', enum: ['data', 'metadata'], description: '默认data读取表格；metadata只读完整SQL、范围和来源时间链，不重读数据库。' } }, output, async execute({ id, offset = 0, rows = 20, view = 'data' }) {
      if (offset < 0) throw new Error('offset 必须非负。');
      const saved = db.prepare('SELECT * FROM evidence WHERE id=?').get(id);
      if (!saved) return json(null);
      const data = JSON.parse(saved.data as string);
      const { rows: _rows, ...metadata } = data;
      if (data.kind === 'crypto_indicator_snapshot') delete metadata.supplemental;
      return json({ evidenceId: id, source: saved.source, retrievedAt: saved.retrieved_at,
        data: view === 'metadata' ? metadata : data.kind === 'sql_result' ? resultPreview(data, Math.max(1, Math.min(100, rows)), offset) : data,
        provenance: provenance(id) });
    },
  }));
  register(defineTool({ name: 'delete_record', description: '仅在用户明确要求删除时，删除一个个人记录的所有版本。其他记录中的引用将成为缺失引用。',
    parameters: { id: text }, output, async execute({ id }) {
      return json({ id, deletedVersions: db.prepare('DELETE FROM records WHERE id=?').run(id).changes, references: '关联记录中的该引用现已缺失' });
    },
  }));

  function marketPlan(watch: Watch): WatchPlan | undefined {
    const version = db.prepare('SELECT data FROM watch_versions WHERE watch_id=? AND version=?').get(watch.id, watch.version);
    return version && JSON.parse(String(version.data)).marketWatch;
  }
  function saveVersion(id: string, marketWatch?: WatchPlan) {
    if (!marketWatch) return saveWatchVersion(db, id);
    const watch = getWatch(db, id);
    const version = { ...watch, marketWatch: { ...marketWatch, watchId: id, configVersion: watch.version } };
    db.prepare('INSERT INTO watch_versions VALUES (?,?,?,?)').run(id, watch.version, now(), json(version));
    return version;
  }
  function draft(id: string, sessionId = 'local-control'): WatchPlan {
    const value = loadEvidence(id)?.data;
    if (value?.kind !== 'market_watch_draft' || value.sessionId !== sessionId) throw new Error('需要本会话核对后的通用盯盘草案凭据。');
    const plan = value.plan as WatchPlan;
    if (plan.expiresAt <= now() || !plan.items.some(item => item.support !== 'blocked')) throw new Error('草案已到期或没有可用监控项。');
    return plan;
  }
  function marketState(watchId: string): WatchState {
    const row = db.prepare(`SELECT result FROM runs WHERE watch_id=? AND
      json_type(CASE WHEN json_valid(result) THEN result END,'$.nextState')='object' ORDER BY rowid DESC LIMIT 1`).get(watchId);
    return row ? JSON.parse(String(row.result)).nextState : { version: 0, items: {}, phases: {} };
  }
  function nextMarketCheck(watch: Watch, plan: WatchPlan) {
    const at = now();
    const status = describeWatchState({ plan, state: marketState(watch.id), status: 'active' }, at);
    const due = status.items.flatMap(item => item.nextDueAt ?? []).sort()[0];
    if (!due) return undefined;
    return new Date(Math.max(Date.parse(due), Date.parse(at) + 1000)).toISOString();
  }
  async function syncMarketSchedule(watch: Watch, plan: WatchPlan, signal?: AbortSignal) {
    if (!watch.schedule_id || watch.status !== 'active' || watch.version !== plan.configVersion) return;
    const id = ScheduleId(watch.schedule_id);
    const schedule = await ctx.schedule.view({ id });
    const current = getWatch(db, watch.id);
    if (current.version !== watch.version || current.status !== 'active') return;
    if ('code' in schedule) throw new Error(schedule.code);
    const exhausted = current.runs >= current.max_runs;
    const next = !exhausted && nextMarketCheck(watch, plan);
    if (next && schedule.status === 'active' && schedule.scheduledAt === next) return schedule;
    const patched = await ctx.schedule.edit({ id, action: 'update', expectedUpdatedAt: schedule.updatedAt ?? null,
      patch: next ? { active: true, timing: { kind: 'at', at: next } } : { active: false } }, undefined, signal);
    if ('code' in patched || !('status' in patched)) throw new Error('code' in patched ? patched.code : '调度已删除');
    if (!next) db.prepare("UPDATE watches SET status=? WHERE id=? AND version=? AND status='active'")
      .run(exhausted ? 'budget_exhausted' : watch.expires_at <= now() ? 'expired' : 'ended', watch.id, watch.version);
    return patched;
  }
  async function choosePaperPolicy(signal: AbortSignal) {
    const skill = readFileSync(new URL('../.dsh/skills/pm-crypto-trading/SKILL.md', import.meta.url), 'utf8');
    const sources = [...skill.matchAll(/^- (https:\/\/\S+)$/gm)].map(m => m[1]);
    const recent = db.prepare(`SELECT json_extract(data,'$.symbol') AS symbol,
      json_extract(data,'$.indicators') AS indicators, retrieved_at FROM evidence
      WHERE json_extract(data,'$.kind')='crypto_indicator_snapshot'
        AND json_extract(data,'$.interval')='5m' AND json_array_length(data,'$.indicators')>100
      ORDER BY rowid DESC LIMIT 8`).all();
    const availability = Object.fromEntries(['BTCUSDT', 'ETHUSDT'].map(symbol => {
      const row = recent.find(r => r.symbol === symbol);
      const values = row ? (JSON.parse(String(row.indicators)) as { id: string; status: string }[])
        .filter(x => Object.hasOwn(paperSignalFields, x.id)).map(({ id, status }) => ({ id, status })) : [];
      return [symbol, { observed: row?.retrieved_at, values }];
    }));
    let answer = '';
    for await (const chunk of ctx.llm.stream({ provider: 'personal', model: process.env.PM_MODEL!,
      maxTokens: 720, temperature: 0.2, signal,
      system: skill,
      messages: [{ role: 'user', content: [{ type: 'text', text: json({
        request: '为这一轮选择指标，输出一个紧凑 JSON。对比 TA20 双收盘 RSI/MACD、单项动量和趋势过滤。只用适合且有依据的指标，保留来源链接。',
        fields: paperSignalFields, availability, references: sources,
      }) }] }],
    })) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') answer += chunk.block.text;
    }
    const body = /\{[\s\S]*\}/.exec(answer)?.[0];
    if (!body) throw Error('Agent 未返回指标策略，本轮保持观望。');
    return validatePaperPolicy(JSON.parse(body), sources);
  }

  async function checkCryptoWatch(watch: Watch, condition: CryptoWatch, runId: string, occurrence: string,
    agent: Parameters<typeof ctx.tools.execute>[0]['agent'], signal: AbortSignal) {
    const conditionKey = hash(condition);
    const row = db.prepare(`SELECT result FROM runs WHERE watch_id=? AND status='complete'
      AND json_extract(CASE WHEN json_valid(result) THEN result END,'$.conditionKey')=?
      ORDER BY started_at DESC LIMIT 1`).get(watch.id, conditionKey);
    type Observation = ReturnType<typeof observeCryptoWatch>;
    const prior = row && (JSON.parse(String(row.result)).observation as Extract<Observation, { coverageStatus: 'covered' }>);
    const nextCandle = prior ? Date.parse(prior.lastCloseAt) + cryptoIntervals[condition.interval] * 1000 : 0;
    const reuse = prior && condition.indicator.id !== 'FUNDING_RATE' && Date.now() < nextCandle;
    let observation: Observation;
    if (reuse) {
      observation = prior;
    } else {
      const { results } = await ctx.tools.execute({ agent, signal, calls: [{
        type: 'tool-call', id: ToolCallId(randomUUID()), name: 'crypto_indicators',
        arguments: json({ action: 'compute', symbols: [condition.symbol], intervals: [condition.interval],
          indicators: [condition.indicator] }),
      }] });
      const result = results[0]?.result;
      if (!result || result.isError || typeof result.value !== 'string') {
        throw new Error(result?.isError ? result.error.message : '指标计算工具缺少回执。');
      }
      observation = observeCryptoWatch(condition, JSON.parse(result.value).analyses?.[0]);
    }
    signal.throwIfAborted();
    const at = now();
    const current = getWatch(db, watch.id);
    if (current.status !== 'active' || current.version !== watch.version || current.expires_at <= at) {
      db.prepare("UPDATE runs SET status='cancelled',finished_at=?,error=? WHERE id=? AND status='running'")
        .run(at, '提交前任务已变更、暂停或到期。', runId);
      return;
    }
    const isNewCandle = !prior || !!observation.lastCloseAt && observation.lastCloseAt > prior.lastCloseAt;
    const triggered = observation.coverageStatus === 'covered' && isNewCandle &&
      cryptoTrigger(condition, observation.latest, observation.previous, !prior);
    const status = observation.coverageStatus === 'covered' ? 'complete' : observation.coverageStatus;
    db.exec('BEGIN IMMEDIATE');
    try {
      const notice = triggered && observation.coverageStatus === 'covered'
        ? db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(), watch.id, runId, hash([conditionKey, observation.lastCloseAt]), cryptoNotice(watch, condition, observation), at).changes
        : 0;
      db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,?,?,?)').run(runId, cryptoWatchSource(observation.marketType),
        observation.evidenceId ?? null, observation.coverageStatus, json({ ...observation, reusedClosedCandle: Boolean(reuse) }));
      db.prepare("UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND status='running'")
        .run(status, at, json({ kind: 'crypto_watch_check', occurrence, scheduleId: watch.schedule_id,
          conditionKey, condition, observation, triggered, reusedClosedCandle: Boolean(reuse), noticeQueued: Boolean(notice) }), runId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async function checkEqnWatch(watch: Watch, config: EqnWatch, runId: string, occurrence: string, checkedAt: string,
    agent: Parameters<typeof ctx.tools.execute>[0]['agent'], signal: AbortSignal) {
    const conditionKey = hash(config);
    const row = db.prepare(`SELECT result FROM runs WHERE watch_id=? AND
      json_extract(CASE WHEN json_valid(result) THEN result END,'$.conditionKey')=? ORDER BY rowid DESC LIMIT 1`)
      .get(watch.id, conditionKey);
    const previous: EqnWatchState = row ? JSON.parse(String(row.result)).eqnState : { through: config.since };
    const scan = await scanEqnWatch(config, previous, checkedAt, async args => {
      const { results } = await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()),
        name: eqnNews.name, arguments: json({ action: 'list', limit: 50, page_limit: 1, ...args }) }] });
      const result = results[0]?.result;
      if (!result || result.isError || typeof result.value !== 'string') {
        throw Error(result?.isError ? result.error.message : 'EQN 缺少读取回执。');
      }
      return JSON.parse(result.value) as EqnWatchPage;
    });
    signal.throwIfAborted();
    const at = now(), current = getWatch(db, watch.id);
    if (current.status !== 'active' || current.version !== watch.version || current.expires_at <= at) {
      db.prepare("UPDATE runs SET status='cancelled',finished_at=?,error=? WHERE id=? AND status='running'")
        .run(at, '提交前任务已变更、暂停或到期。', runId);
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)');
      let notices = 0;
      for (const { item, evidenceId } of scan.matches.reverse()) {
        const eventKey = item.xEvent?.post?.id ? `x-post:${item.xEvent.post.id}` : `eqn:${item.no}`;
        notices += Number(insert.run(randomUUID(), watch.id, runId, eventKey, eqnWatchNotice(watch, item, evidenceId), at).changes);
      }
      const result = { kind: 'eqn_watch_check', occurrence, conditionKey, eqnState: scan.state, notices,
        evidenceIds: scan.evidenceIds, reason: scan.reason, unclassified: scan.unclassified };
      db.prepare('INSERT INTO coverage VALUES (?,?,?,?,?)').run(runId, eqnWatchSource, scan.evidenceIds.at(0) ?? null, scan.status, json(result));
      db.prepare("UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND status='running'").run(scan.status, at, json(result), runId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async function checkXWatch(watch: Watch, config: XWatch, runId: string, occurrence: string,
    agent: Parameters<typeof ctx.tools.execute>[0]['agent'], signal: AbortSignal) {
    const conditionKey = hash(config);
    const row = db.prepare(`SELECT result FROM runs WHERE watch_id=? AND
      json_extract(CASE WHEN json_valid(result) THEN result END,'$.conditionKey')=? AND
      json_type(CASE WHEN json_valid(result) THEN result END,'$.xState')='object' ORDER BY rowid DESC LIMIT 1`).get(watch.id, conditionKey);
    const previous = row ? JSON.parse(String(row.result)).xState as XWatchState : undefined;
    const { results } = await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()),
      name: xWatchTool(config), arguments: json(xWatchArguments(config)) }] });
    const result = results[0]?.result;
    if (!result || result.isError || typeof result.value !== 'string') throw Error(result?.isError ? result.error.message : 'X 缺少读取回执。');
    const receipt: XWatchReceipt = JSON.parse(result.value);
    const observation = observeXWatch(config, previous, receipt, watch.goal);
    signal.throwIfAborted();
    const at = now(), current = getWatch(db, watch.id);
    if (current.status !== 'active' || current.version !== watch.version || current.expires_at <= at) {
      db.prepare("UPDATE runs SET status='cancelled',finished_at=?,error=? WHERE id=? AND status='running'")
        .run(at, '提交前任务已变更、暂停或到期。', runId);
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)');
      let notices = 0;
      for (const change of observation.changes) {
        notices += Number(insert.run(randomUUID(), watch.id, runId, change.key, change.body, at).changes);
      }
      const detail = { kind: config.kind + '_check', conditionKey, occurrence, xState: observation.state,
        evidenceId: receipt.evidenceId, notices, reason: observation.reason };
      db.prepare('INSERT INTO coverage VALUES (?,?,?,?,?)').run(runId, config.kind, receipt.evidenceId, observation.status, json(detail));
      db.prepare("UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND status='running'")
        .run(observation.status, at, json(detail), runId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const marketCatalog = 'market_catalog';
  const externalEvidence = 'external_evidence';
  const tradeHistory = 'research_trades';
  const tradeAuditSource = 'market-data/orderfilled-projection-audit';
  const tradeProjectionGap = '缺少同一市场选项和窗口的热成交事实投影核对凭据，成交阈值待验';
  const priceVolatilityScope = 'price_volatility';
  const anomalyItemSupported = (item: WatchItemRequest) => item.kind === 'trading' && /^\d+$/.test(item.tokenId ?? '') &&
    (item.scope === 'market_anomaly' && [tradeAnomalySource, bookAnomalySource].includes(item.sourceId) ||
      item.scope === priceVolatilityScope && item.sourceId === tradeAnomalySource) &&
    !item.metric && !item.trigger && !item.external && !item.tradeWindowEndAt;
  const largeTradeItemSupported = (item: WatchItemRequest) => item.kind === 'trading' && item.scope === largeTradeScope &&
    item.sourceId === largeTradeSource && !!item.maxAgeSeconds && !item.tokenId && !item.metric && !item.trigger &&
    !item.external && !item.tradeWindowEndAt;
  const marketItemSupported = (item: WatchItemRequest) => item.sourceId === marketCatalog && !item.external &&
    (item.kind === 'lifecycle' && item.scope === 'trading_status' && !item.tokenId ||
      item.kind === 'trading' && item.scope === 'catalog_quote' && item.metric?.kind === 'quote' &&
      item.metric.priceType === 'catalog' && item.metric.unit === 'fraction' && !item.metric.windowSeconds &&
      !item.metric.minSamples && item.trigger?.baseline !== 'reference');
  const tradeItemSupported = (item: WatchItemRequest) => item.sourceId === tradeHistory && item.kind === 'trading' &&
    item.scope === 'trade_window' && !item.external && !item.clauseId && !item.ruleRequired &&
    /^\d+$/.test(item.tokenId ?? '') && item.metric?.kind === 'trades' && item.metric.measure === 'count' &&
    item.metric.key === 'unique_log_events' && item.metric.unit === 'logs' && !item.metric.currency;

  function tradeProjectionReceipt(item: WatchItemRequest) {
    const receipt = item.tradeProjectionEvidenceId && loadEvidence(item.tradeProjectionEvidenceId);
    if (!receipt || receipt.source !== tradeAuditSource || !item.tradeWindowEndAt || !item.metric?.windowSeconds) return;
    const { data } = receipt;
    const end = Date.parse(item.tradeWindowEndAt);
    if (data.kind !== 'trade_projection_audit' || data.marketId !== item.marketId || data.tokenId !== item.tokenId ||
        Date.parse(data.window?.to) !== end || Date.parse(data.window?.from) !== end - item.metric.windowSeconds * 1000 ||
        data.chainRaw?.exact !== true || data.projection?.exact !== true || data.projection.unresolved !== 0 ||
        !Number.isSafeInteger(data.projection.events) || data.projection.events < 0 ||
        !/^[a-f0-9]{64}$/.test(data.eventKeyDigest)) return;
    return receipt;
  }

  async function readAuditedTradeWatch(item: WatchItemRequest, startedAt: string, signal: AbortSignal): Promise<WatchRead> {
    const metric = item.metric!;
    const end = item.tradeWindowEndAt;
    const windowArgs = end ? { from: new Date(Date.parse(end) - metric.windowSeconds! * 1000).toISOString(), to: end }
      : { window_seconds: metric.windowSeconds };
    const result = await researchEngine('trade_projection', { market_id: item.marketId, token_id: item.tokenId,
      as_of: startedAt, ...windowArgs }, signal);
    const receipt = saveEvidence(db, result.source, result.data, result.retrievedAt);
    const data = result.data as { kind: string; marketId: number; tokenId: string; complete: boolean; reason?: string;
      window?: { from: string; to: string }; firstBlock?: number; lastBlock?: number; blockTimeComplete: boolean;
      watermark?: { to: string }; chainRaw?: { exact: boolean };
      projection?: { exact: boolean; events: number; fact_rows: number; missing: number; unassigned: number; eventKeyDigest: string } };
    if (data.kind !== 'trade_projection_audit' || data.marketId !== item.marketId || data.tokenId !== item.tokenId) {
      return { issue: { status: 'partial', reason: 'T-A 投影核对凭据范围不匹配', evidenceIds: [receipt.evidenceId] } };
    }
    const scope = data.window;
    if (!scope) return { issue: { status: 'partial', reason: data.reason ?? tradeProjectionGap, evidenceIds: [receipt.evidenceId] } };
    const from = new Date(scope.from).toISOString(), to = new Date(scope.to).toISOString();
    const projection = data.projection;
    const complete = Boolean(data.complete && data.blockTimeComplete && data.chainRaw?.exact && projection?.exact &&
      projection.missing === 0 && projection.unassigned === 0 && Number.isSafeInteger(projection.events) && projection.events >= 0 &&
      /^[a-f0-9]{64}$/.test(projection.eventKeyDigest) && Date.parse(to) <= Date.parse(startedAt) &&
      Date.parse(to) - Date.parse(from) === metric.windowSeconds! * 1000 && (end ? to === end :
        Date.parse(data.watermark?.to ?? '') === Date.parse(to)));
    const inputEvidenceIds = [receipt.evidenceId];
    const evidence = saveEvidence(db, 'market-watch/trades', { kind: 'market_trade_window', marketId: item.marketId,
      tokenId: item.tokenId, metric, window: { from, to, complete },
      observed: projection && { factRows: projection.fact_rows, uniqueLogEvents: projection.events },
      deduplication: ['tx_hash', 'log_index'], coverage: { blockTimeComplete: data.blockTimeComplete,
        rawAuditComplete: data.chainRaw?.exact ?? false, firstBlock: data.firstBlock, lastBlock: data.lastBlock,
        factProjection: projection?.exact ? 'verified' : projection ? 'unverified' : 'unknown',
        missing: projection?.missing, unassigned: projection?.unassigned,
        projectionEvidenceId: receipt.evidenceId, eventKeyDigest: projection?.eventKeyDigest }, inputEvidenceIds });
    if (!complete) return { issue: { status: 'partial', reason: data.reason ?? tradeProjectionGap, sourceThrough: to,
      evidenceIds: [evidence.evidenceId, ...inputEvidenceIds] } };
    return { observations: [{ id: hash([item.marketId, item.tokenId, from, to, projection!.eventKeyDigest]), scope: item.scope,
      observedAt: to, evidence, inputEvidenceIds, measurement: { marketId: item.marketId, tokenId: item.tokenId!, metric,
        value: projection!.events, window: { from, to, complete, samples: projection!.events, deduplicated: true } } }] };
  }

  async function readTradeWatch(item: WatchItemRequest, startedAt: string, signal: AbortSignal): Promise<WatchRead> {
    if (!item.tradeProjectionEvidenceId) return readAuditedTradeWatch(item, startedAt, signal);
    const end = item.tradeWindowEndAt ? Date.parse(item.tradeWindowEndAt) : Math.floor(Date.parse(startedAt) / 1000) * 1000;
    const start = end - item.metric!.windowSeconds! * 1000;
    if (start < 0) return { issue: { status: 'unsupported', reason: '成交窗口超出查询时间范围' } };
    const from = new Date(start).toISOString(), to = new Date(end).toISOString();
    const utc = (time: string) => `toDateTime('${time.slice(0, 19).replace('T', ' ')}','UTC')`;
    const left = utc(from), right = utc(to), inside = `block_time >= ${left} AND block_time < ${right}`;
    async function query(engine: 'clickhouse' | 'postgres', sql: string, maxRows = 1000) {
      const result = await researchEngine('query', { engine, sql, max_rows: maxRows }, signal);
      const evidence = saveEvidence(db, result.source, result.data, result.retrievedAt);
      if (result.data.kind !== 'sql_result' || !Array.isArray(result.data.rows)) throw new Error('T-A 未返回 SQL 结果');
      return { id: evidence.evidenceId, rows: result.data.rows as Record<string, unknown>[], truncated: result.data.truncated === true };
    }
    const projection = tradeProjectionReceipt(item);
    const selectedTrades = `FROM research_trades(start=${left},end=${right}) WHERE market_id=${item.marketId} AND token_id='${item.tokenId}'`;
    const [facts, index, keys] = await Promise.all([
      query('clickhouse', `SELECT count() AS fact_rows, uniqExactIf(tuple(tx_hash,log_index), tx_hash != '') AS unique_log_events,
        countIf(tx_hash = '') AS missing_log_identity, min(trade_time) AS first_trade_at, max(trade_time) AS last_trade_at
        ${selectedTrades}`),
      query('clickhouse', `SELECT minIf(block_number, ${inside}) AS first_block, maxIf(block_number, ${inside}) AS last_block,
        uniqExactIf(block_number, ${inside}) AS indexed_blocks,
        uniqExactIf(tuple(block_number,block_time), ${inside}) AS indexed_timestamps,
        maxIf(block_number, block_time < ${left}) AS before_start, minIf(block_number, block_time >= ${right}) AS at_or_after_end
        FROM block_timestamps WHERE block_time >= ${left} - INTERVAL 60 SECOND AND block_time < ${right} + INTERVAL 60 SECOND`),
      projection && query('clickhouse', `SELECT DISTINCT tx_hash,log_index,block_number ${selectedTrades}`, 10000),
    ]);
    const blocks = index.rows[0];
    const firstBlock = Number(blocks?.first_block), lastBlock = Number(blocks?.last_block);
    const haveBlocks = !index.truncated && Number.isSafeInteger(firstBlock) && Number.isSafeInteger(lastBlock) &&
      firstBlock > 0 && lastBlock >= firstBlock;
    const blockTimeComplete = haveBlocks && Number(blocks.indexed_blocks) === lastBlock - firstBlock + 1 &&
      Number(blocks.indexed_timestamps) === Number(blocks.indexed_blocks) &&
      Number(blocks.before_start) === firstBlock - 1 && Number(blocks.at_or_after_end) === lastBlock + 1;
    const audits = haveBlocks ? await query('postgres', `SELECT from_block,to_block,status,chain_log_count,db_log_count,
      missing_count,audited_at,last_error FROM core.orderfilled_sync_windows WHERE exchange_set='known_orderfilled'
      AND from_block<=${lastBlock} AND to_block>=${firstBlock} ORDER BY from_block,to_block`) : undefined;
    let nextBlock = firstBlock;
    for (const row of audits?.rows ?? []) {
      if (row.status === 'complete' && row.last_error === null && String(row.missing_count) === '0' &&
          /^\d+$/.test(String(row.chain_log_count)) && String(row.chain_log_count) === String(row.db_log_count) &&
          Number(row.from_block) <= nextBlock && Number(row.to_block) >= nextBlock) nextBlock = Number(row.to_block) + 1;
    }
    const rawAuditComplete = Boolean(audits && !audits.truncated && nextBlock > lastBlock);
    const counts = facts.rows[0];
    const factRows = Number(counts?.fact_rows), uniqueLogEvents = Number(counts?.unique_log_events);
    const missingLogIdentity = Number(counts?.missing_log_identity);
    const observed = !facts.truncated && [factRows, uniqueLogEvents, missingLogIdentity].every(Number.isSafeInteger)
      ? { factRows, uniqueLogEvents, missingLogIdentity, firstTradeAt: factRows ? counts.first_trade_at : null,
        lastTradeAt: factRows ? counts.last_trade_at : null } : undefined;
    const coordinates = keys?.rows.map(({ tx_hash, log_index, block_number }) =>
      [String(tx_hash).toLowerCase().replace(/^0x/, ''), Number(log_index), Number(block_number)] as const);
    const digest = coordinates && hash(coordinates.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]));
    const factProjectionComplete = Boolean(projection && keys && !keys.truncated &&
      projection.data.firstBlock === firstBlock && projection.data.lastBlock === lastBlock &&
      projection.data.projection.events === uniqueLogEvents && uniqueLogEvents === coordinates?.length &&
      projection.data.eventKeyDigest === digest && observed && missingLogIdentity === 0);
    const complete = blockTimeComplete && rawAuditComplete && factProjectionComplete;
    const inputEvidenceIds = [facts.id, index.id, ...(audits ? [audits.id] : []),
      ...(projection ? [projection.evidenceId] : []), ...(keys ? [keys.id] : [])];
    const evidence = saveEvidence(db, 'market-watch/trades', { kind: 'market_trade_window', marketId: item.marketId,
      tokenId: item.tokenId, metric: item.metric, window: { from, to, complete }, observed,
      deduplication: ['tx_hash', 'log_index'], coverage: { blockTimeComplete, rawAuditComplete,
        firstBlock: haveBlocks ? firstBlock : null, lastBlock: haveBlocks ? lastBlock : null,
        factProjection: factProjectionComplete ? 'verified' : projection ? 'unverified' : 'unknown',
        projectionEvidenceId: projection?.evidenceId, eventKeyDigest: digest },
      inputEvidenceIds });
    if (!complete) return { issue: { status: 'partial', reason: !projection ? tradeProjectionGap
      : !blockTimeComplete || !rawAuditComplete ? '区块时间索引或原始日志审计未覆盖成交窗口'
      : '本轮热成交事实事件键未通过投影凭据核对', evidenceIds: [evidence.evidenceId, ...inputEvidenceIds] } };
    return { observations: [{ id: hash([item.marketId, item.tokenId, from, to, digest]), scope: item.scope,
      observedAt: to, evidence, inputEvidenceIds, measurement: { marketId: item.marketId, tokenId: item.tokenId!,
        metric: item.metric!, value: uniqueLogEvents, window: { from, to, complete, samples: uniqueLogEvents, deduplicated: true } } }] };
  }

  async function readTradeAnomaly(item: WatchItemRequest, previousId: string | undefined, startedAt: string, signal: AbortSignal): Promise<WatchRead> {
    const priceOnly = item.scope === priceVolatilityScope;
    const metric = { kind: 'trades', key: 'unique_log_events', measure: 'count', unit: 'logs', windowSeconds: 300 } as const;
    const read = await readAuditedTradeWatch({ ...item, metric }, startedAt, signal);
    const observation = read.observations?.[0];
    if (!observation?.measurement?.window) return read;
    const { from, to } = observation.measurement.window;
    const stale: WatchRead = { issue: { status: 'stale', reason: '来源已过期', sourceThrough: to,
      evidenceIds: [observation.evidence.evidenceId, ...observation.inputEvidenceIds ?? []] } };
    if (watchSourceExpired(to, now(), item.maxAgeSeconds)) return stale;
    const trade = loadEvidence(observation.evidence.evidenceId)!;
    const sample = { from, to, events: observation.measurement.value, evidenceId: observation.evidence.evidenceId };
    const previous = previousId ? loadEvidence(previousId)?.data : undefined;
    const savedWindows = priceOnly ? [] : db.prepare(`SELECT e.id,e.data FROM coverage c JOIN evidence e ON e.id=c.evidence_id
      JOIN runs r ON r.id=c.run_id WHERE c.status='covered' AND r.finished_at>=? AND e.source='market-watch/trades'
      AND json_extract(e.data,'$.marketId')=? AND json_extract(e.data,'$.tokenId')=?
      AND json_extract(e.data,'$.metric.windowSeconds')=300 AND json_extract(e.data,'$.window.complete')=1
      ORDER BY r.finished_at DESC LIMIT 48`).all(new Date(Date.parse(startedAt) - 4 * 3600000).toISOString(), item.marketId, item.tokenId!);
    const known = savedWindows.map(row => {
      const data = JSON.parse(String(row.data));
      return { ...data.window, events: data.observed.uniqueLogEvents, evidenceId: String(row.id) } as TradeSample;
    });
    const history = priceOnly ? undefined : tradeActivityBaseline(sample, [...previous?.history ?? [], ...known]);
    const utc = (at: string) => `toDateTime('${at.slice(0, 19).replace('T', ' ')}','UTC')`;
    let price: ReturnType<typeof tradePriceChange> | { status: 'unavailable'; reason: string };
    const inputEvidenceIds = [sample.evidenceId, ...history?.samples.map(row => row.evidenceId) ?? []];
    try {
      const result = await researchEngine('query', { engine: 'clickhouse', max_rows: 10000, sql: `SELECT tx_hash,log_index,block_number,trade_time,price${priceOnly ? '' : ',size'}
        FROM research_trades(start=${utc(from)},end=${utc(to)}) WHERE market_id=${item.marketId} AND token_id='${item.tokenId}'` }, signal);
      inputEvidenceIds.push(saveEvidence(db, result.source, result.data, result.retrievedAt).evidenceId);
      if (watchSourceExpired(to, now(), item.maxAgeSeconds)) return stale;
      price = result.data.truncated === false && Array.isArray(result.data.rows)
        ? tradePriceChange(result.data.rows, sample.events, trade.data.coverage.eventKeyDigest, from, to, priceOnly)
        : { status: 'unverified' };
    } catch (error) {
      signal.throwIfAborted();
      price = { status: 'unavailable', reason: String(error).slice(0, 240) };
    }
    const signals: { key: string; before: number; after: number; description: string; importance: 'low' | 'high'; priceMove?: 'change' | 'range' }[] = [];
    if (history?.threshold !== undefined && sample.events >= history.threshold) {
      signals.push({ key: 'trade_activity', before: history.median!, after: sample.events,
        description: '五分钟成交日志数显著高于近期完整窗口', importance: 'low' });
    }
    if (price.status === 'covered') {
      const key = priceOnly ? 'trade_price_volatility' : price.change > 0 ? 'trade_price_up' : 'trade_price_down';
      if (significantTradePriceChange(price.before, price.after)) {
        signals.push({ key, before: price.before, after: price.after, priceMove: 'change',
          description: '五分钟窗内前后半窗的成交价格中位数明显变化', importance: 'high' });
      } else if (price.range && significantTradePriceChange(price.range.low, price.range.high)) {
        signals.push({ key, before: price.range.low, after: price.range.high, priceMove: 'range',
          description: '五分钟窗内去掉两端各一成后的成交价格波动明显', importance: 'high' });
      }
    }
    if (!priceOnly && price.status === 'covered' && (price.largestLogShares ?? 0) >= 100 &&
        price.shareOfObservedLogShares !== undefined && price.shareOfObservedLogShares >= .3) {
      signals.push({ key: 'concentrated_fill', before: .3, after: price.shareOfObservedLogShares,
        description: '单条成交日志占该窗已观察日志份数三成以上', importance: 'low' });
    }
    const evidence = saveEvidence(db, 'market-watch/anomalies', { kind: 'market_trade_activity', marketId: item.marketId,
      tokenId: item.tokenId, sample, price, baseline: history, history: history && [sample, ...history.samples], signals, inputEvidenceIds });
    if (priceOnly && price.status !== 'covered') return { issue: { status: 'partial', sourceThrough: to,
      reason: price.status === 'insufficient_samples' ? thinTradePrices : price.status === 'unavailable' && isWatchTimeout(price.reason)
        ? '成交价格查询超时' : '本轮成交价格缺少完整性凭据',
      evidenceIds: [evidence.evidenceId, ...inputEvidenceIds] } };
    return { observations: [{ id: observation.id, scope: item.scope, observedAt: observation.observedAt, evidence, inputEvidenceIds,
      measurement: priceOnly ? observation.measurement : undefined,
      findings: anomalyFindings(item, signals, previous?.signals, to) }] };
  }

  async function readLargeTradeWatch(item: WatchItemRequest, market: WatchPlan['markets'][number],
    snapshot: EvidenceRow, previousAt: string | undefined, signal: AbortSignal): Promise<WatchRead> {
    const data = snapshot.data as { status?: string; localMarketId?: number; conditionId?: string };
    const evidenceIds = [snapshot.evidenceId];
    const issue = (reason: string, status: 'partial' | 'stale' = 'partial'): WatchRead =>
      ({ issue: { reason, status, evidenceIds } });
    if (data.status !== 'found' || data.localMarketId !== item.marketId || !data.conditionId || !/^0x[\da-f]{64}$/i.test(data.conditionId)) {
      return issue('目录未确认大额成交对应的市场身份');
    }
    const health = await publicReader.read({ view: 'freshness' }, signal);
    evidenceIds.push(health.evidenceId);
    if (health.status !== 'ok' || !health.result) return issue(`官方成交源状态 ${health.status}`);
    const through = largeTradeFeedTime(health.result, health.retrievedAt);
    if (through === undefined) return issue('官方成交源缺少可用时效');
    const to = through - largeTradeContextMs;
    const observedAt = new Date(to).toISOString();
    if (watchSourceExpired(observedAt, now(), item.maxAgeSeconds)) return issue('来源已过期', 'stale');
    const last = previousAt ? Date.parse(previousAt) : to - 300_000;
    const from = Math.min(to, Math.max(last, to - item.maxAgeSeconds! * 1000));
    const lower = from - largeTradeContextMs;
    const rows: unknown[] = [];
    let cursor: string | undefined;
    let oldest = Infinity;
    for (let page = 0; page < 6; page++) {
      const response = await publicReader.read({ view: 'trades', id: data.conditionId, limit: 25, cursor }, signal);
      evidenceIds.push(response.evidenceId);
      if (!Array.isArray(response.result)) return issue(`官方成交查询状态 ${response.status}`);
      for (const row of response.result) {
        const at = officialTradeTime(row);
        if (!Number.isFinite(at) || at > oldest) return issue('官方成交流时间顺序无法核对');
        oldest = at;
        rows.push(row);
      }
      if (oldest < lower || response.pagination?.has_more === false) {
        const result = largeTradeFindings(item.marketId, market.options, rows, from, to);
        if (!result) return issue('官方成交记录的选项、身份或金额无法核对');
        const evidence = saveEvidence(db, 'market-watch/large-trades', { kind: 'market_large_trades', marketId: item.marketId,
          window: { from: new Date(from).toISOString(), to: observedAt, feedThrough: new Date(through).toISOString() },
          coverage: 'official_taker_feed', ...(last < from ? { unscannedFrom: new Date(last).toISOString() } : {}),
          matches: result.matches, inputEvidenceIds: evidenceIds });
        return { observations: [{ id: hash([item.marketId, item.scope, observedAt]), scope: item.scope, observedAt,
          evidence, inputEvidenceIds: evidenceIds, findings: result.findings }] };
      }
      const next = response.pagination?.next_cursor;
      if (typeof next !== 'string' || !next || next === cursor) break;
      cursor = next;
    }
    return issue('官方成交分页未覆盖所需时间窗');
  }

  function anomalyFindings(item: WatchItemRequest, signals: { key: string; before: number; after: number;
    description: string; importance: 'low' | 'high'; priceMove?: 'change' | 'range' }[], previous: { key: string }[] | undefined, at: string): WatchObservation['findings'] {
    return signals.filter(signal => !previous?.some(old => old.key === signal.key)).map(({ key, ...change }) => ({
      ...change, eventKey: `market:${item.marketId}:${item.tokenId}:${key}`, revision: hash([at, change.before, change.after]),
      kind: 'changed', confidence: 'confirmed', unknowns: [item.scope === priceVolatilityScope ? '价格波动原因待核实' : '价格、成交或盘口的变化原因待独立核实'],
    }));
  }

  async function readBook(marketId: number, tokenId: string, signal: AbortSignal) {
    const result = await readMarketData(`/runtime/lob/token/${tokenId}?marketId=${marketId}`, signal);
    const raw = saveEvidence(db, result.source, result.data, result.retrievedAt);
    return { raw, book: qualifiedBook(result.data, tokenId, raw.retrievedAt) };
  }

  async function readBookAnomaly(item: WatchItemRequest, previousId: string | undefined, signal: AbortSignal): Promise<WatchRead> {
    const { raw, book } = await readBook(item.marketId, item.tokenId!, signal);
    if (book.status !== 'covered') return { issue: { status: book.sourceStatus === 'stale' ? 'stale' : 'partial',
      reason: `该选项的可用盘口状态为 ${book.sourceStatus}`, evidenceIds: [raw.evidenceId] } };
    const { asks: _asks, bids: _bids, ...current } = book;
    const previous = previousId ? loadEvidence(previousId)?.data : undefined;
    const before = previous?.book;
    const signals: { key: string; before: number; after: number; description: string; importance: 'high' }[] = [];
    if (before && Date.parse(current.observedAt) > Date.parse(before.observedAt) &&
        Date.parse(current.observedAt) - Date.parse(before.observedAt) <= item.intervalSeconds * 2000) {
      if (typeof before.spread === 'number' && current.spread !== undefined && spreadWidened(before.spread, current.spread)) {
        signals.push({ key: 'spread_widened', before: before.spread, after: current.spread, description: '买卖点差显著扩大', importance: 'high' });
      }
      for (const [side, key] of [['买侧', 'bidDepth'], ['卖侧', 'askDepth']] as const) {
        if (before[key] >= 100 && current[key] <= before[key] / 2) signals.push({ key, before: before[key], after: current[key],
          description: `${side}触价起一美分范围的可见深度减半`, importance: 'high' });
      }
    }
    const inputEvidenceIds = [raw.evidenceId, ...(previousId ? [previousId] : [])];
    const evidence = saveEvidence(db, 'market-watch/anomalies', { kind: 'market_book_activity', marketId: item.marketId,
      tokenId: item.tokenId, book: current, before, signals, inputEvidenceIds });
    return { observations: [{ id: hash([item.tokenId, current]), scope: item.scope, observedAt: current.observedAt,
      evidence, inputEvidenceIds, findings: anomalyFindings(item, signals, previous?.signals, current.observedAt) }] };
  }
  type NormalizationPlan = { request: SourceEvidenceRequest; candidates?: SourceEvidenceCandidates };
  type SavedAssessment = ReturnType<typeof assessRuleEvidence> & { ruleCard: { evidenceId?: string } };

  function readExternalSetup(item: WatchItemRequest) {
    const binding = item.external;
    if (item.sourceId !== externalEvidence || !binding || !['fact', 'factor'].includes(item.kind)) return;
    const stored = loadEvidence(binding.normalizedEvidenceId);
    if (stored?.data?.kind !== 'normalized_source_evidence') throw new Error('需要 T-E 规范化证据凭据。');
    const seed = stored as SavedNormalizedEvidence & {
      data: { normalizationPlan?: NormalizationPlan };
    };
    const recipe = seed.data.normalizationPlan;
    const marketRef = seed.data.scope.market;
    const raw = loadEvidence(seed.data.sourceRef.evidenceId);
    const url = URL.parse(seed.source);
    if (!recipe || recipe.request.asOf ||
        seed.data.quality.status !== 'ok' || seed.data.quality.match !== 'matched' ||
        !seed.data.facts.some(fact => fact.key === binding.factKey && fact.checked) ||
        !seed.data.times.some(time => time.key === binding.sourceTimeKey && time.kind !== 'expected' && time.time.utc) ||
        (marketRef && marketRef.id !== `local:${item.marketId}`) || url?.protocol !== 'https:' || url.username || url.password || url.hash ||
        raw?.data?.result?.url !== seed.source || !raw?.data?.arguments?.url) {
      throw new Error('需要同一市场（如有绑定）的 T-E 规范化证据、可重读的 HTTPS 原文和实际源时间。');
    }
    const assessmentId = binding.ruleAssessmentEvidenceId;
    if (!assessmentId && !item.clauseId && !item.ruleRequired) return { seed, recipe, url: url.href };
    const approved = assessmentId && loadEvidence(assessmentId);
    const assessment = approved && approved.source === 'personal-agent/research' ? approved.data as SavedAssessment : undefined;
    const cardId = assessment?.ruleCard?.evidenceId;
    const cardRow = cardId && loadEvidence(cardId);
    const card = cardRow && cardRow.source === 'personal-agent/research' ? cardRow.data as RuleCard : undefined;
    const condition = assessment?.conditions?.find(condition => condition.clauseId === item.clauseId);
    const reviewed = condition?.observations.find(observation => observation.normalizedEvidenceId === seed.evidenceId &&
      observation.factKey === binding.factKey && observation.status === condition.status);
    const resolution = card && loadEvidence(card.rules.evidenceId);
    if (assessment?.kind !== 'rule_evidence_assessment' || assessment.asOf ||
        card?.kind !== 'rule_card' || card.rules.incomplete || card.rules.clarifications.length ||
        card.market.localMarketId !== item.marketId || !resolution || marketRef?.rulesEvidenceId !== card.rules.evidenceId ||
        !condition || !['met', 'not_met'].includes(condition.status) || !reviewed || !seed.data.version.contentId ||
        assessment.ruleCard.interpretationRevision !== card.interpretationRevision) {
      throw new Error('规则项需要同一条款和来源版本的有效 T-B1 核对回执。当前重读路径支持无需补充规则材料的条款。');
    }
    return { seed, recipe, url: url.href, rule: { cardId: cardId!, card, resolution, assessmentId: assessmentId!, reviewed, condition } };
  }
  function marketSnapshot(marketId: number, run: NonNullable<ReturnType<typeof active.get>>, signal: AbortSignal) {
    const readings = run.marketReads ??= new Map();
    let reading = readings.get(marketId);
    if (!reading) {
      reading = resolveMarket(`local:${marketId}`, signal).then(result => saveEvidence(db, result.source, result.data, result.retrievedAt))
        .catch(error => { readings.delete(marketId); throw error; });
      readings.set(marketId, reading);
    }
    return reading;
  }
  function currentRuleMatches(market: Awaited<ReturnType<typeof marketSnapshot>>['data'], card: RuleCard) {
    return market.status === 'found' && market.localMarketId === card.market.localMarketId &&
      market.conditionId === card.market.conditionId && market.title === card.market.title &&
      market.rules === card.rules.capturedText && market.truncated !== true && market.hasMore !== true;
  }
  async function refreshExternal(setup: NonNullable<ReturnType<typeof readExternalSetup>>, signal: AbortSignal) {
    const arguments_ = { url: setup.url };
    let data: unknown;
    try {
      const result: WebFetchResult = await ctx.web.fetch(arguments_, signal);
      data = { arguments: arguments_, result };
    } catch (error) {
      signal.throwIfAborted();
      data = { kind: 'source_capture', coverage: 'link',
        failure: { stage: 'access', reason: error instanceof Error ? error.message : String(error) } };
    }
    signal.throwIfAborted();
    const raw = saveEvidence(db, setup.url, data);
    const snapshot = sourceSnapshotFromEvidence(raw);
    if (URL.parse(snapshot.source)?.href !== setup.url) {
      snapshot.failure = { stage: 'validate', reason: '来源重定向后与已授权的证据 URL 不同' };
    }
    const normalized = normalizeSourceEvidence(setup.recipe.request, snapshot, setup.recipe.candidates);
    const saved = saveEvidence(db, normalized.source, { ...normalized.data, normalizationPlan: setup.recipe }, normalized.retrievedAt);
    return { ...normalized, evidenceId: saved.evidenceId };
  }
  async function readExternalWatch(item: WatchItemRequest, previousId: string | undefined,
    run: NonNullable<ReturnType<typeof active.get>>, signal: AbortSignal): Promise<WatchRead> {
    const setup = readExternalSetup(item);
    if (!setup) return { issue: { status: 'unsupported', reason: '缺少已核对的 T-E 外部来源证据' } };
    const cache = run.externalReads ??= new Map();
    let reading = cache.get(setup.seed.evidenceId);
    if (!reading) {
      reading = refreshExternal(setup, signal);
      cache.set(setup.seed.evidenceId, reading);
    }
    const current = await reading;
    const row = previousId ? loadEvidence(previousId) : undefined;
    const prior = row?.data.kind === 'normalized_source_evidence' ? row as SavedNormalizedEvidence : undefined;
    const { factKey, sourceTimeKey } = item.external!;
    const result = readWatchSourceEvidence({ item, current, previous: prior, factKey, sourceTimeKey,
      confidence: setup.rule ? 'confirmed' : 'unconfirmed', importance: 'normal' });
    const observation = result.observations?.[0];
    const rule = setup.rule;
    if (!rule || !observation) return result;
    const market = await marketSnapshot(item.marketId, run, signal);
    const reviewInputs = [current.evidenceId, market.evidenceId, rule.cardId, rule.assessmentId];
    const unresolved = (reason: string): WatchRead => ({ issue: { status: 'partial', reason, evidenceIds: reviewInputs } });
    if (!currentRuleMatches(market.data, rule.card)) return unresolved('市场规则或身份已有变化，需要新的 T-B1 规则卡与核对回执');
    const literalPoint = rule.reviewed.review === 'literal' && rule.reviewed.coverage === 'complete' &&
      rule.condition.window?.mode === 'point' && Boolean(rule.condition.interval || rule.condition.equals !== undefined);
    if (!literalPoint && current.data.version.contentId !== setup.seed.data.version.contentId) {
      return unresolved('来源正文已变化，需要重新确认规则的语义映射与覆盖');
    }
    const assessment = assessRuleEvidence(rule.card, [current], [{
      clauseId: rule.reviewed.clauseId, normalizedEvidenceId: current.evidenceId, factKey,
      review: rule.reviewed.review, coverage: rule.reviewed.coverage, basis: rule.reviewed.basis,
    }], { now: now() });
    assessment.inputEvidenceIds = [...new Set([...assessment.inputEvidenceIds, ...reviewInputs])];
    const proof = saveEvidence(db, 'personal-agent/research',
      { ...assessment, ruleCard: { ...assessment.ruleCard, evidenceId: rule.cardId } }, assessment.checkedAt);
    return readWatchRuleEvidence({ item, current: rule.card, assessment,
      observation: { ...observation, inputEvidenceIds: [...observation.inputEvidenceIds ?? [], proof.evidenceId] } });
  }
  const marketHost: WatchHost = {
    now,
    load({ watchId, operationKey }) {
      const watch = getWatch(db, watchId);
      const plan = marketPlan(watch);
      if (!plan) return;
      const state = marketState(watchId);
      const duplicate = db.prepare(`SELECT finished_at,result FROM runs WHERE watch_id=? AND
        json_extract(CASE WHEN json_valid(result) THEN result END,'$.operationKey')=?`).get(watchId, operationKey);
      return { plan, state, status: watch.status as RuntimeWatch['status'],
        receipt: duplicate ? { status: 'already_committed', operationKey,
          stateVersion: JSON.parse(String(duplicate.result)).nextState.version, committedAt: String(duplicate.finished_at) } : undefined };
    },
    async read(item, context, signal) {
      if (item.sourceId === weatherSource) return weather.readWatch(item, context, signal);
      const { plan, previous, startedAt } = context;
      const run = active.get(getWatch(db, plan.watchId).session_id)!;
      if (largeTradeItemSupported(item)) return readLargeTradeWatch(item,
        plan.markets.find(market => market.id === item.marketId)!, await marketSnapshot(item.marketId, run, signal), previous?.last?.observedAt, signal);
      if (anomalyItemSupported(item)) return item.sourceId === tradeAnomalySource
        ? readTradeAnomaly(item, previous?.last?.evidence.evidenceId, startedAt, signal)
        : readBookAnomaly(item, previous?.last?.evidence.evidenceId, signal);
      if (item.sourceId === externalEvidence) return readExternalWatch(item, previous?.last?.evidence.evidenceId, run, signal);
      if (tradeItemSupported(item)) return readTradeWatch(item, startedAt, signal);
      if (!marketItemSupported(item)) return { issue: { status: 'unsupported', reason: '来源读取能力没有接线' } };
      const evidence = await marketSnapshot(item.marketId, run, signal);
      const data = evidence.data as Record<string, unknown>;
      const issue = (reason: string, status: 'partial' | 'stale' = 'partial') =>
        ({ issue: { status, reason, evidenceIds: [evidence.evidenceId] } });
      if (data.status !== 'found' || data.localMarketId !== item.marketId) return issue('目录未返回已确认的目标市场');
      if (item.metric) {
        if (data.quoteStatus !== 'recent') return issue(`目录报价状态 ${String(data.quoteStatus)}`, data.quoteStatus === 'stale' ? 'stale' : 'partial');
        const quotes = data.outcomes as { tokenId: string; price?: unknown }[] | undefined;
        const price = quotes?.find(quote => quote.tokenId === item.tokenId)?.price;
        if ((typeof price !== 'number' && (typeof price !== 'string' || !price.trim())) ||
            !Number.isFinite(Number(price)) || typeof data.quoteObservedAt !== 'string') return issue('目录缺少该选项的报价或实际观察时间');
        return { observations: [{ id: hash([item.tokenId, data.quoteObservedAt]), scope: item.scope, evidence,
          observedAt: data.quoteObservedAt, measurement: { marketId: item.marketId, tokenId: item.tokenId!, metric: item.metric, value: Number(price) } }] };
      }
      const status = data.closed === true ? 'closed' : data.acceptingOrders === true ? 'trading'
        : data.acceptingOrders === false ? 'orders_paused' : data.active === false ? 'inactive' : undefined;
      if (!status || typeof data.stateObservedAt !== 'string') return issue('目录缺少实际交易状态或观察时间');
      const observedAt = data.stateObservedAt;
      const before = previous?.last?.value;
      return { observations: [{ id: hash([item.marketId, observedAt]), scope: item.scope, evidence, observedAt,
        value: status, phase: item.trackPhase ? { key: status } : undefined,
        findings: before !== undefined && before !== status ? [{ eventKey: `market:${item.marketId}:trading-status`,
          revision: hash([observedAt, status]), kind: 'changed', confidence: 'confirmed', importance: 'normal',
          description: '市场交易状态变化', before, after: status }] : undefined }] };
    },
    commit(check, signal) {
      signal.throwIfAborted();
      const committedAt = now();
      const deliveries: { operationKey: string; status: 'pending'; enqueuedAt: string }[] = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const watch = getWatch(db, check.watchId);
        const plan = marketPlan(watch);
        const run = db.prepare('SELECT status,watch_version FROM runs WHERE id=? AND watch_id=?').get(check.runId, watch.id);
        if (watch.status !== 'active' || watch.expires_at <= committedAt || watch.version !== check.configVersion ||
            !plan || run?.status !== 'running' || run.watch_version !== check.configVersion ||
            marketState(watch.id).version !== check.expectedStateVersion) {
          db.exec('ROLLBACK');
          return { status: 'rejected', reason: '任务或检查版本已变化' };
        }
        for (const item of check.checks) {
          db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,?,?,?)')
            .run(check.runId, item.itemId, item.evidenceIds[0] ?? null, item.status, json(item));
        }
        for (const intent of check.intents) {
          const routes = new Map<string, MarketWatchNotice>();
          for (const member of intent.members) {
            if (member.action !== 'immediate' && !(member.action === 'summary' && member.notBefore)) continue;
            const deliveryKey = hash([plan.authorizationRef, intent.eventKey, intent.revision, member.action, member.notBefore]);
            const market = plan.markets.find(market => market.id === member.marketId);
            const sample = member.sourceId === weatherSource && member.evidence && loadEvidence(member.evidence.evidenceId)?.data;
            const airport = sample && sample.kind === 'weather_airport_impact' ? sample : undefined;
            const text = formatWatchNotice(member, { title: airport?.title ?? market?.title,
              url: airport?.market ?? (market && loadEvidence(market.evidenceId)?.data.url),
              outcome: market?.options.find(option => option.tokenId === member.tokenId)?.label });
            const prior = routes.get(deliveryKey);
            if (prior) prior.text += `\n\n${text}`;
            else routes.set(deliveryKey, { kind: 'market_watch_notice', deliveryKey, text, notBefore: member.notBefore });
          }
          for (const notice of routes.values()) {
            const id = hash([watch.id, notice.deliveryKey]);
            const saved = db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
              .run(id, watch.id, check.runId, id, json(notice), committedAt);
            if (saved.changes) deliveries.push({ operationKey: id, status: 'pending', enqueuedAt: committedAt });
          }
        }
        db.prepare('UPDATE runs SET status=?,result=?,finished_at=? WHERE id=?').run(check.coverage, json(check), committedAt, check.runId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { status: 'committed', operationKey: check.operationKey, stateVersion: check.nextState.version, committedAt, deliveries };
    },
  };
  for (const tool of createWatchTools({
    ...marketHost,
    activeCheck(sessionId) {
      const run = active.get(sessionId);
      if (run?.watch && marketPlan(run.watch)) return { watchId: run.watch.id, runId: run.id, configVersion: run.watch.version };
    },
    saveDraft(plan, sessionId) {
      return saveEvidence(db, 'market-watch/prepare', { kind: 'market_watch_draft', sessionId, plan }).evidenceId;
    },
    async authorizeProposal(proposal, sessionId, signal) {
      const original = proposal as WatchPlanRequest;
      const request = { ...original, items: original.items.map(item => item.weather ? { ...item } : item) };
      const ids = [...new Set(request.items.map(item => item.marketId))];
      if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || ids.length > maxTools) throw new Error('市场范围超出本次工具预算。');
      const externalItems = new Set<string>();
      const weatherItems = new Set<string>();
      const ruleCards = new Map<number, NonNullable<NonNullable<ReturnType<typeof readExternalSetup>>['rule']>>();
      for (const item of request.items) {
        const setup = readExternalSetup(item);
        if (!setup) continue;
        externalItems.add(item.id);
        const rule = setup.rule;
        if (!rule) continue;
        const existing = ruleCards.get(item.marketId);
        if (existing && existing.cardId !== rule.cardId) throw new Error('同一市场的盯盘条款须使用同一规则卡版本。');
        ruleCards.set(item.marketId, rule);
      }
      const markets = [];
      for (const id of ids) {
        const result = await resolveMarket(`local:${id}`, signal);
        const rule = ruleCards.get(id);
        if (rule && !currentRuleMatches(result.data, rule.card)) throw new Error(`市场 ${id} 的规则或身份已经变化，请更新核对凭据。`);
        const resolution = rule?.resolution ?? saveEvidence(db, result.source, result.data, result.retrievedAt);
        for (const item of request.items.filter(item => item.marketId === id && (item.weather || item.sourceId === weatherSource))) {
          const ruleVersion = weather.authorize(item, resolution);
          const authorized = item.weather!;
          item.weather = { ...authorized, ruleVersion };
          item.notify = { ...request.notify, ...item.notify, quality: authorized.conditions.includes('coverage')
            ? item.notify?.quality ?? request.notify.quality ?? item.notify?.mode ?? request.notify.mode : 'record' };
          weatherItems.add(item.id);
        }
        markets.push({ resolution, ...(rule ? { ruleCard: rule.card } : {}) });
      }
      const sources = [...new Set(request.items.map(item => item.sourceId))].map(id => ({
        id, status: [marketCatalog, externalEvidence, tradeHistory, tradeAnomalySource, bookAnomalySource, largeTradeSource, weatherSource].includes(id) ? 'available' as const : 'unsupported' as const,
        ...(id === weatherSource ? { minIntervalSeconds: weatherInterval } : {}),
        reason: id === externalEvidence ? '需提供可重读的 T-E 规范化证据，规则项另需 T-B1 核对回执'
          : id === tradeHistory ? '历史成交支持指定市场选项的 trade_window 和 unique_log_events'
          : [tradeAnomalySource, bookAnomalySource].includes(id) ? 'market_anomaly 或成交价 price_volatility 需要已解析的选项 token'
          : id === largeTradeSource ? 'large_trade 使用同一市场的官方主动方成交'
          : id === weatherSource ? '已核对的 AWC METAR、NWS CLI 或 NHC 公告。规则变更时待复核'
          : '目录支持 trading_status 和无窗口 catalog_quote',
        targets: request.items.filter(item => item.sourceId === id &&
          (marketItemSupported(item) || tradeItemSupported(item) || anomalyItemSupported(item) || largeTradeItemSupported(item) ||
            externalItems.has(item.id) || weatherItems.has(item.id)))
          .map(item => ({ ...item, itemId: item.id,
            limitation: id === tradeHistory && item.tradeProjectionEvidenceId && !tradeProjectionReceipt(item) ? tradeProjectionGap : undefined })),
      }));
      return { request, context: { watchId: hash([sessionId, randomUUID()]), configVersion: 1, now: now(),
        authorizationRef: 'public-market-catalog', markets, sources, expiresAt: request.expiresAt,
        budget: { maxRuns: request.budget.maxRuns, maxModelCalls: maxModels, maxToolCalls: maxTools } } };
    },
  })) register(tool);

  register(defineTool({ name: 'create_watch_task', description: '仅按用户明确要求创建持续只读任务。地点天气、天气发现或 Kalshi 天气用 weather_location_evidence_id，条件和来源已在凭据内，另填周期、到期、任务名和预算。EQN 新动态传 eqn，X 新帖或 XTracker 计数变化传 x_watch，默认每 5 分钟检查、持续 24 小时，只通知新动态或计数变化。动态市场筛选传 screen_markets 回执中的 screen、interval_seconds、expires_at，默认首次有效观察只建基线。Crypto 指标传 crypto；通用市场盯盘传 plan_evidence_id；体育赛事传 sports_watch_evidence_id，带 preset 的 CS2 草案可省略周期和到期时间；旧市场任务使用市场、来源和预算字段。',
    parameters: { plan_evidence_id: optionalText, market_id: optionalInteger, crypto: cryptoWatchSchema, screen: marketScreenSchema, eqn: eqnWatchSchema, x_watch: xWatchSchema,
      crypto_paper: { type: 'boolean', description: '由 Telegram /crypto_paper 入口启动固定的 BTC/ETH 模拟盘任务。' },
      sports_watch_evidence_id: optionalText,
      weather_location_evidence_id: { ...optionalText, description: 'inspect_weather_market 的地点、发现或 Kalshi 订阅凭据。省略 market_id、sources、notify_when 等旧市场参数。' },
      notify_on_initial: { type: 'boolean', description: '仅动态筛选任务使用，明确要求时发送初始命中，默认 false。' }, goal: optionalText, sources,
      notify_when: optionalText, interval_seconds: optionalInteger, expires_at: optionalText,
      max_runs: optionalInteger, max_model_calls: optionalInteger, max_tool_calls: optionalInteger,
    }, output,
    async execute(input, exec) {
      const x = input.x_watch && prepareXWatch(input.x_watch);
      if (x && (input.eqn || input.screen || input.crypto || input.crypto_paper || input.sports_watch_evidence_id ||
          input.weather_location_evidence_id || input.plan_evidence_id || input.market_id !== undefined || input.sources !== undefined ||
          input.notify_when !== undefined || input.notify_on_initial !== undefined || input.max_model_calls !== undefined || input.max_tool_calls !== undefined)) {
        throw Error('X 订阅只填 x_watch、周期、到期时间、可选任务名和检查次数。');
      }
      const paper = input.crypto_paper === true;
      if (paper && (exec.agent || process.env.PM_TELEGRAM_ENABLED !== 'true' || Object.keys(input).some(key => key !== 'crypto_paper'))) {
        throw Error('请通过 Telegram /crypto_paper 启动固定的模拟盘任务。');
      }
      const sportId = input.sports_watch_evidence_id;
      if (sportId && (input.weather_location_evidence_id !== undefined || input.plan_evidence_id !== undefined ||
          input.crypto !== undefined || input.eqn !== undefined || input.screen !== undefined || input.market_id !== undefined ||
          input.sources !== undefined || input.notify_when !== undefined || input.notify_on_initial !== undefined ||
          input.max_model_calls !== undefined || input.max_tool_calls !== undefined))
        throw Error('体育订阅只使用已核对凭据、周期、到期时间、任务名和检查次数。');
      const sport = sportId ? await sports.draft(sportId, exec.agent?.session.id, exec.signal) : undefined;
      const sportExpiry = input.expires_at ?? sport?.preset?.expiresAt;
      const sportInterval = input.interval_seconds ?? sport?.preset?.intervalSeconds;
      if (sport && (!sportsTimestamp(sportExpiry) || !Number.isSafeInteger(sportInterval) ||
          (sportInterval ?? 0) < sport.minIntervalSeconds))
        throw Error(`体育任务需要带时区的到期时间，检查周期至少 ${sport.minIntervalSeconds} 秒。`);
      const place = input.weather_location_evidence_id && weather.locations.draft(input.weather_location_evidence_id);
      if (place && (input.plan_evidence_id || input.crypto || input.eqn || input.screen || input.market_id !== undefined ||
          input.sources?.length || input.notify_when || input.notify_on_initial === true))
        throw Error('天气来源和条件已绑定在 weather_location_evidence_id。创建时省略 market_id、sources、notify_when、notify_on_initial 和其他任务类型。');
      if (place && ((input.max_model_calls ?? 1) > maxModels || (input.max_tool_calls ?? 1) > maxTools))
        throw Error('天气任务预算超过当前宿主上限。');
      const eqn = input.eqn && prepareEqnWatch(input.eqn);
      if (eqn && (input.screen !== undefined || input.crypto !== undefined || input.plan_evidence_id !== undefined ||
          input.market_id !== undefined || input.sources !== undefined || input.notify_when !== undefined ||
          input.max_model_calls !== undefined || input.max_tool_calls !== undefined)) {
        throw Error('EQN 订阅只填 eqn、周期、到期时间、可选任务名和检查次数。');
      }
      let paperRules: PaperPolicy | undefined;
      if (paper) {
        await cryptoPaperReady(exec.signal);
        const existingQuery = db.prepare(`SELECT * FROM watches WHERE status IN ('pending','active') AND expires_at>?
          AND json_extract(CASE WHEN json_valid(notify_when) THEN notify_when END,'$.kind')=?`);
        let existing = existingQuery.get(now(), cryptoPaperPlan.kind);
        if (existing) return json({ ...existing, alreadyStarted: true });
        paperRules = await choosePaperPolicy(exec.signal);
        existing = existingQuery.get(now(), cryptoPaperPlan.kind);
        if (existing) return json({ ...existing, alreadyStarted: true });
      }
      const since = now();
      const eqnExpiry = input.expires_at ?? new Date(Date.parse(since) + 86_400_000).toISOString();
      const eqnInterval = input.interval_seconds ?? 300;
      const screen = input.screen && prepareMarketScreenWatch(input.screen, input.notify_on_initial ?? false);
      if (screen && (input.crypto !== undefined || input.plan_evidence_id !== undefined || input.market_id !== undefined ||
          input.sources !== undefined || input.notify_when !== undefined)) throw new Error('screen 与 Crypto、草案和单市场参数互斥。');
      if (!screen && input.notify_on_initial !== undefined) throw new Error('顶层 notify_on_initial 仅用于动态筛选任务。');
      const crypto = input.crypto && prepareCryptoWatch(input.crypto);
      if (crypto && (input.plan_evidence_id !== undefined || input.market_id !== undefined || input.sources !== undefined ||
          input.notify_when !== undefined || input.max_model_calls !== undefined || input.max_tool_calls !== undefined)) {
        throw new Error('Crypto 指标任务只填 crypto、检查周期、到期时间、可选任务名和检查次数。');
      }
      const plan = input.plan_evidence_id && draft(input.plan_evidence_id, exec.agent?.session.id);
      const args = paper ? {
        market_id: null, goal: cryptoPaperTitle, sources: [], notify_when: json({ ...cryptoPaperPlan, policy: paperRules }),
        interval_seconds: 300, expires_at: new Date(Date.parse(since) + 86_400_000).toISOString(),
        max_runs: 288, max_model_calls: 1, max_tool_calls: 14,
      } : plan ? {
        market_id: plan.markets[0]!.id, goal: plan.goal, sources: [],
        notify_when: json(plan.notify), interval_seconds: Math.min(...plan.items.filter(item => item.support !== 'blocked').map(item => item.effectiveIntervalSeconds)),
        expires_at: plan.expiresAt, max_runs: plan.budget.maxRuns, max_model_calls: plan.budget.maxModelCalls, max_tool_calls: plan.budget.maxToolCalls,
      } : sport ? {
        market_id: null, goal: input.goal?.trim() || `${sport.sport.toUpperCase()} ${sport.event.participants.map(p => p.name).join(' vs ')}`,
        sources: [], notify_when: json(sport), interval_seconds: sportInterval, expires_at: sportExpiry,
        max_model_calls: 1, max_tool_calls: 1,
        max_runs: input.max_runs ?? Math.max(1, Math.ceil((Date.parse(sportExpiry!) - Date.now()) / (sportInterval! * 1000))),
      } : place ? {
        market_id: null, goal: input.goal?.trim() || '个人天气条件检查', sources: [], notify_when: json(place),
        interval_seconds: Math.max(input.interval_seconds ?? 300, place.q.query_type === 'discover' ? 180 : 60),
        expires_at: input.expires_at, max_runs: input.max_runs ?? 24,
        max_model_calls: input.max_model_calls ?? 1, max_tool_calls: input.max_tool_calls ?? 1,
      } : eqn || x ? {
        market_id: null, goal: input.goal?.trim() || (eqn ? 'EQN ' + (eqn.handles.length ? eqn.handles.map(h => '@' + h).join('、') : eqn.channel)
          : (x!.kind === 'x_timeline' ? 'X 新帖 @' : 'XTracker @') + x!.handle),
        sources: [], notify_when: json({ ...(eqn ?? x), since }), interval_seconds: eqnInterval, expires_at: eqnExpiry,
        max_model_calls: 1, max_tool_calls: x ? 1 : 5, max_runs: input.max_runs ?? Math.max(1, Math.ceil((Date.parse(eqnExpiry) - Date.parse(since)) / (eqnInterval * 1000))),
      } : screen ? {
        ...input, market_id: null, goal: input.goal?.trim() || 'Polymarket 动态市场筛选', sources: [], notify_when: json(screen),
        max_model_calls: input.max_model_calls ?? 1, max_tool_calls: input.max_tool_calls ?? maxTools,
        max_runs: input.max_runs ?? Math.max(1, Math.floor((Date.parse(input.expires_at ?? '') - Date.now()) /
          ((input.interval_seconds ?? 60) * 1000))),
      } : crypto ? {
        ...input, market_id: null, goal: input.goal?.trim() || `${crypto.symbol} ${crypto.interval} ${crypto.indicator.id} 指标盯盘`,
        sources: [], notify_when: json(crypto), max_model_calls: 1, max_tool_calls: 1,
        max_runs: input.max_runs ?? Math.max(1, Math.ceil((Date.parse(input.expires_at ?? '') - Date.now()) /
          ((input.interval_seconds ?? 60) * 1000))),
      } : input;
      const { market_id, goal, sources: sourceList, notify_when, interval_seconds, expires_at, max_runs, max_model_calls, max_tool_calls } = args;
      if ((!paper && !sport && !place && !eqn && !x && !screen && !crypto && !market_id) || market_id === undefined || !goal || !sourceList || !notify_when || !expires_at ||
          interval_seconds === undefined || interval_seconds < 60 ||
          !max_runs || !Number.isSafeInteger(max_runs) || max_runs <= 0 || !max_model_calls || max_model_calls <= 0 || !max_tool_calls || max_tool_calls <= 0) {
        throw new Error('需要已核对的草案或完整的旧任务约定，周期最少 60 秒。');
      }
      if (screen && !/(?:Z|[+-]\d\d:\d\d)$/i.test(expires_at)) throw new Error('动态筛选任务到期时间需包含时区。');
      if (crypto && !/(?:Z|[+-]\d\d:\d\d)$/i.test(expires_at)) throw new Error('Crypto 任务到期时间需包含时区。');
      if ((eqn || x) && !/(?:Z|[+-]\d\d:\d\d)$/i.test(expires_at)) throw Error('订阅到期时间需包含时区。');
      if (place && !/(?:Z|[+-]\d\d:\d\d)$/i.test(expires_at)) throw Error('天气地点任务到期时间需包含时区。');
      const expiry = new Date(expires_at).toISOString();
      if (expiry <= now()) throw new Error('任务需要未来的到期时间。');
      if (!plan && market_id !== null) validateSources(sourceList, market_id);
      const operation = active.get(exec.agent?.session.id ?? '')?.id ?? exec.callId;
      const id = plan ? plan.watchId : sport ? hash([sportId, goal, interval_seconds, expiry, input.max_runs]) : hash([operation, screen ? [screen, goal, interval_seconds, expiry, input.max_runs, max_model_calls, max_tool_calls]
        : eqn || x ? [eqn ?? x, goal, interval_seconds, input.expires_at, input.max_runs] : args]);
      const existing = db.prepare('SELECT * FROM watches WHERE id=?').get(id);
      if (existing) return json(screen ? { ...existing, marketScreen: screen } : existing);
      const sessionId = SessionId(`watch-${id}`);
      db.prepare(`INSERT INTO watches (id,session_id,version,market_id,goal,sources,notify_when,interval_seconds,expires_at,max_runs,max_model_calls,max_tool_calls,status)
        VALUES (?,?,1,?,?,?,?,?,?,?,?,?,'pending')`).run(id, sessionId, market_id, goal, json(sourceList), notify_when, interval_seconds, expiry, max_runs, max_model_calls, max_tool_calls);
      if (plan) saveVersion(id, plan);
      const handle = await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions: {
        provider: 'personal', model: process.env.PM_MODEL!, reasoningEffort: ReasoningEffortId(process.env.PM_QUERY_REASONING ?? 'off'), maxTokens: Number(process.env.PM_MAX_OUTPUT_TOKENS ?? 4096),
      } });
      try { await ctx.sessions.flush(handle.agent.session); } finally { await handle.dispose(); }
      const schedule = await ctx.schedule.create({ title: goal.slice(0, 120),
        prompt: paper ? cryptoPaperTitle : plan ? marketWatchPrompt : sport ? sportsWatchPrompt : place ? locationWatchPrompt : x ? xWatchPrompt : eqn ? eqnWatchPrompt : screen ? screenWatchPrompt : crypto ? cryptoWatchPrompt : watchPrompt(id),
        timing: plan ? { kind: 'at', at: new Date(Date.now() + 1000).toISOString() }
          : { kind: 'every', every_seconds: interval_seconds }, target: { kind: 'session', sessionId },
      }, exec.agent?.session.id, exec.signal);
      db.prepare("UPDATE watches SET schedule_id=?,status='active' WHERE id=?").run(schedule.id, id);
      const saved = plan ? { ...getWatch(db, id), marketWatch: plan } : saveVersion(id);
      if (plan) db.prepare('UPDATE watch_versions SET data=? WHERE watch_id=? AND version=1').run(json(saved), id);
      if (paper) {
        const started = await ctx.schedule.run({ id: ScheduleId(schedule.id) }, exec.signal);
        const describeRules = (rules: PaperPolicy['up'] | undefined) => rules?.map(rule =>
          `${[rule.id, rule.field].filter(Boolean).join('.')} ${{ above: '高于', below: '低于', crosses_above: '上穿', crosses_below: '下穿' }[rule.comparison]} ${rule.threshold}（${rule.confirmations} 根）`).join(' 且 ');
        db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(), id, '', 'started', [
            cryptoPaperTitle + '已启动', '首轮 24 小时，每 5 分钟汇总。指标与实时 TWAP 同向才在专用钱包尝试模拟成交。',
            'Agent 选择 ' + paperRules?.name, 'Up ' + describeRules(paperRules?.up),
            'Down ' + describeRules(paperRules?.down), paperRules?.reason, ...(paperRules?.sources ?? []),
          ].join('\n'), now());
        return json({ ...saved, nextCheck: schedule.scheduledAt, started });
      }
      const beijing = sport?.preset ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }) : undefined;
      return json({ ...saved, ...(beijing ? { expiresAtBeijing: beijing.format(new Date(expiry)),
        nextCheckBeijing: schedule.scheduledAt ? beijing.format(new Date(schedule.scheduledAt)) : undefined } : {}),
        ...(screen ? { marketScreen: screen, scheduleStatus: schedule.status } : {}),
        ...(eqn ? { eqnWatch: eqnWatchPlan(saved), scheduleStatus: schedule.status } : {}),
        ...(x ? { xWatch: xWatchPlan(saved), scheduleStatus: schedule.status } : {}),
        ...(sport ? { sportsWatch: sport, scheduleStatus: schedule.status } : {}),
        ...(crypto ? { cryptoWatch: crypto } : {}), ...(place ? { weatherLocation: place } : {}), nextCheck: schedule.scheduledAt });
    },
  }));
  register(defineTool({ name: 'update_watch_task', description: '修改范围、周期、预算、到期时间或启停状态。edit 仅在暂停且无在途检查时修改；cancel 停止当前研究及未来唤醒。删除会移除任务及检查/提醒历史，已存证据和 DSH 会话仍保留。',
    parameters: { id: text, expected_version: integer, action: { ...text, enum: ['edit', 'pause', 'resume', 'cancel', 'run', 'delete'] }, plan_evidence_id: optionalText,
      crypto: cryptoWatchSchema, screen: marketScreenSchema, eqn: eqnWatchSchema, notify_on_initial: { type: 'boolean' },
      goal: { type: 'string' }, sources, notify_when: { type: 'string' }, interval_seconds: { type: 'integer' }, expires_at: { type: 'string' },
      max_runs: { type: 'integer' }, max_model_calls: { type: 'integer' }, max_tool_calls: { type: 'integer' },
    }, output,
    async execute({ id, action, expected_version, plan_evidence_id, crypto: cryptoInput, screen: screenInput, eqn: eqnInput, notify_on_initial, ...changes }, exec) {
      const watch = getWatch(db, id);
      if (isCryptoPaper(watch) && action === 'edit') throw Error('模拟盘任务采用固定参数。');
      if (isCryptoPaper(watch) && action === 'resume') paperPolicy(watch);
      const plan = marketPlan(watch);
      const screen = marketScreenWatch(watch);
      const eqn = eqnWatchPlan(watch);
      const x = xWatchPlan(watch);
      const place = locationWatch(watch);
      const sport = sportsWatch(watch);
      const crypto = !sport && !screen && cryptoWatchPlan(watch);
      if ((screenInput || notify_on_initial !== undefined) && (!screen || action !== 'edit')) throw new Error('只能在编辑动态筛选任务时修改 screen 或初始通知。');
      if (cryptoInput && (!crypto || action !== 'edit')) throw new Error('只能在编辑 Crypto 指标任务时更新 crypto 条件。');
      if (eqnInput && (!eqn || action !== 'edit')) throw Error('只能在编辑 EQN 订阅时更新 eqn 条件。');
      if (watch.version !== expected_version) throw new Error('任务版本已变化，请先读取当前版本。');
      if (!watch.schedule_id) throw new Error('该任务尚未成功关联调度计划。');
      if (action === 'resume' && (watch.expires_at <= now() || watch.runs >= watch.max_runs)) throw new Error('任务已到期或检查预算已用尽。');
      if (action === 'run') {
        if (watch.status !== 'active' || watch.expires_at <= now() || watch.runs >= watch.max_runs) throw new Error('任务必须处于有效期和预算内，且为 active。');
        return json(await ctx.schedule.run({ id: ScheduleId(watch.schedule_id) }, exec.signal));
      }
      if (action === 'edit' || action === 'delete') {
        if (watch.status === 'active' || active.has(watch.session_id)) throw new Error('请先 cancel 当前任务再修改或删除。');
        if (action === 'delete') {
          const removed = await ctx.schedule.edit({ id: ScheduleId(watch.schedule_id), action: 'delete' }, exec.agent?.session.id, exec.signal);
          if ('code' in removed) throw new Error(json(removed));
          db.prepare('DELETE FROM coverage WHERE run_id IN (SELECT id FROM runs WHERE watch_id=?)').run(id);
          for (const table of ['notices', 'runs', 'watch_versions']) db.prepare(`DELETE FROM ${table} WHERE watch_id=?`).run(id);
          db.prepare('DELETE FROM watches WHERE id=?').run(id);
          return json({ id, deleted: true, retained: ['evidence', 'DSH session'] });
        }
        if (plan) {
          if (!plan_evidence_id) throw new Error('编辑通用盯盘需提供新的已核对草案凭据。');
          const updated = draft(plan_evidence_id, exec.agent?.session.id);
          if (updated.budget.maxRuns <= watch.runs) throw new Error('草案的剩余检查预算不足。');
          const interval = Math.min(...updated.items.filter(item => item.support !== 'blocked').map(item => item.effectiveIntervalSeconds));
          const schedule = await ctx.schedule.edit({ id: ScheduleId(watch.schedule_id), action: 'update',
            patch: { title: updated.goal.slice(0, 120), active: false } }, exec.agent?.session.id, exec.signal);
          if ('code' in schedule) throw new Error(json(schedule));
          db.prepare(`UPDATE watches SET market_id=?,goal=?,notify_when=?,interval_seconds=?,expires_at=?,max_runs=?,
            max_model_calls=?,max_tool_calls=?,version=version+1,status='paused' WHERE id=?`).run(
            updated.markets[0]!.id, updated.goal, json(updated.notify), interval, updated.expiresAt,
            updated.budget.maxRuns, updated.budget.maxModelCalls, updated.budget.maxToolCalls, id);
          return json(saveVersion(id, updated));
        }
        const updated = { ...watch, ...changes, sources: changes.sources ? json(changes.sources) : watch.sources,
          expires_at: new Date(changes.expires_at ?? watch.expires_at).toISOString() };
        if (sport) {
          if (plan_evidence_id !== undefined || changes.sources !== undefined || changes.notify_when !== undefined ||
              changes.max_model_calls !== undefined || changes.max_tool_calls !== undefined)
            throw Error('体育任务的赛事和条件取自订阅凭据。');
          if (changes.expires_at !== undefined && !sportsTimestamp(changes.expires_at)) throw Error('体育任务到期时间需包含时区。');
        } else if (place) {
          if (plan_evidence_id !== undefined || changes.sources !== undefined || changes.notify_when !== undefined)
            throw Error('天气地点范围和条件取自已核对的凭据。');
        } else if (eqn) {
          if (plan_evidence_id !== undefined || changes.sources !== undefined || changes.notify_when !== undefined ||
              changes.max_model_calls !== undefined || changes.max_tool_calls !== undefined) throw Error('EQN 订阅使用 eqn 保存筛选条件。');
          if (changes.expires_at !== undefined && !/(?:Z|[+-]\d\d:\d\d)$/i.test(changes.expires_at)) {
            throw Error('EQN 订阅到期时间需包含时区。');
          }
          if (eqnInput) {
            const condition = prepareEqnWatch(eqnInput);
            const { since, ...previous } = eqn;
            updated.notify_when = json({ ...condition, since: hash(condition) === hash(previous) ? since : now() });
          }
        } else if (x) {
          if (plan_evidence_id !== undefined || changes.sources !== undefined || changes.notify_when !== undefined ||
              changes.max_model_calls !== undefined || changes.max_tool_calls !== undefined) throw Error('X 订阅可修改任务名、检查周期、到期时间和检查次数。');
          if (changes.expires_at !== undefined && !/(?:Z|[+-]\d\d:\d\d)$/i.test(changes.expires_at)) {
            throw Error('X 订阅到期时间需包含时区。');
          }
        } else if (screen) {
          if (plan_evidence_id !== undefined || changes.sources !== undefined || changes.notify_when !== undefined) {
            throw new Error('动态筛选任务使用 screen 保存条件。');
          }
          if (changes.expires_at !== undefined && !/(?:Z|[+-]\d\d:\d\d)$/i.test(changes.expires_at)) throw new Error('动态筛选任务到期时间需包含时区。');
          updated.notify_when = json(prepareMarketScreenWatch(screenInput ?? screen.screen, notify_on_initial ?? screen.notifyOnInitial, screen));
        } else if (crypto) {
          if (plan_evidence_id !== undefined || changes.sources !== undefined || changes.notify_when !== undefined ||
              changes.max_model_calls !== undefined || changes.max_tool_calls !== undefined) {
            throw new Error('Crypto 任务只可编辑指标条件、检查周期、到期时间、任务名及检查次数。');
          }
          if (changes.expires_at !== undefined && !/(?:Z|[+-]\d\d:\d\d)$/i.test(changes.expires_at)) {
            throw new Error('Crypto 任务到期时间需包含时区。');
          }
          updated.notify_when = json(cryptoInput ? prepareCryptoWatch(cryptoInput) : crypto);
        } else if (watch.market_id !== null) validateSources(JSON.parse(updated.sources), watch.market_id);
        if (updated.interval_seconds < (sport?.minIntervalSeconds ?? (place?.q.query_type === 'discover' ? 180 : 60)) ||
            updated.max_runs <= watch.runs || updated.max_model_calls <= 0 || updated.max_tool_calls <= 0 || updated.expires_at <= now())
          throw new Error('检查周期、到期时间及剩余预算必须有效。');
        const schedule = await ctx.schedule.edit({ id: ScheduleId(watch.schedule_id), action: 'update', patch: {
          title: updated.goal.slice(0, 120), prompt: sport ? sportsWatchPrompt : place ? locationWatchPrompt : eqn ? eqnWatchPrompt : x ? xWatchPrompt : screen ? screenWatchPrompt : crypto ? cryptoWatchPrompt : watchPrompt(id),
          timing: { kind: 'every', every_seconds: updated.interval_seconds }, active: false,
        } }, exec.agent?.session.id, exec.signal);
        if ('code' in schedule) throw new Error(json(schedule));
        db.prepare('UPDATE watches SET goal=?,sources=?,notify_when=?,interval_seconds=?,expires_at=?,max_runs=?,max_model_calls=?,max_tool_calls=?,version=version+1,status=\'paused\' WHERE id=?')
          .run(updated.goal, updated.sources, updated.notify_when, updated.interval_seconds, updated.expires_at, updated.max_runs, updated.max_model_calls, updated.max_tool_calls, id);
        const saved = saveWatchVersion(db, id);
        return json(eqn ? { ...saved, eqnWatch: eqnWatchPlan(saved) } : x ? { ...saved, xWatch: x } : screen ? { ...saved, marketScreen: marketScreenWatch(saved) } : saved);
      }
      const next = plan && action === 'resume' ? nextMarketCheck(watch, plan) : undefined;
      if (plan && action === 'resume' && !next) throw new Error('已无可恢复的通用监控项。');
      const schedule = await ctx.schedule.edit({ id: ScheduleId(watch.schedule_id), action: 'update',
        patch: { active: action === 'resume', ...(next ? { timing: { kind: 'at' as const, at: next } } : {}) } }, exec.agent?.session.id, exec.signal);
      if ('code' in schedule) throw new Error(json(schedule));
      db.prepare('UPDATE watches SET status=?,version=version+1 WHERE id=?').run(action === 'resume' ? 'active' : 'paused', id);
      if (action === 'cancel') {
        const agent = ctx.agents.get(SessionId(watch.session_id));
        if (agent) { agent.cancel({ kind: 'user' }); await agent.whenIdle(); }
      }
      return json({ task: saveVersion(id, plan), ...(sport ? { sportsWatch: sport } : {}), ...(eqn ? { eqnWatch: eqn } : {}), ...(x ? { xWatch: x } : {}), ...(screen ? { marketScreen: screen } : {}), schedule });
    },
  }));
  register(defineTool({ name: 'read_watch_sources', description: '读取本次任务约定的全部来源，保存真实快照并按各自时效和质量字段计算覆盖。失败、过期和缺少源时间分别记录；不是连续历史补采。',
    parameters: {}, output,
    async execute(_args, exec) {
      const run = active.get(exec.agent?.session.id ?? '');
      if (!run?.watch) throw new Error('仅能在持续任务执行会话中读取任务来源。');
      const results = [];
      for (const source of JSON.parse(run.watch.sources) as Source[]) {
        exec.signal.throwIfAborted();
        try {
          const result = await readMarketData(source.path, exec.signal);
          const evidence = saveEvidence(db, result.source, result.data, result.retrievedAt);
          const coverage = sourceCoverage(source, result.data, result.retrievedAt);
          db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,?,?,?)').run(run.id, source.path, evidence.evidenceId, coverage.status, json(coverage));
          results.push({ ...evidence, coverage });
        } catch (error) {
          const detail = String(error);
          db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,NULL,?,?)').run(run.id, source.path, 'failed', detail);
          results.push({ path: source.path, status: 'failed', error: detail });
        }
      }
      return json({ sources: results, previousComplete: db.prepare("SELECT * FROM runs WHERE watch_id=? AND status='complete' ORDER BY started_at DESC LIMIT 1").get(run.watch.id) ?? null,
        coverageScope: '本次来源快照；检查间隔内的变化与中断期间历史没有自动补查' });
    },
  }));
  register(defineTool({ name: 'finish_watch_check', description: '记录本次持续检查结果。只有约定来源均成功检查才允许 complete。需要提醒时给出具体变化、影响和已读取证据；通知先持久化为 pending，由 Telegram 宿主发送并更新真实送达状态。',
    parameters: { status: { ...text, enum: ['complete', 'partial', 'failed'] }, summary: text,
      evidence_ids: { type: 'array', items: { type: 'string' }, required: true },
      notification: { type: 'string' }, event_key: { type: 'string' },
    }, output,
    async execute(args, exec) {
      const run = active.get(exec.agent?.session.id ?? '');
      if (!run?.watch) throw new Error('仅能在持续任务自己的执行会话中记录检查。');
      const saved = db.prepare('SELECT status,result FROM runs WHERE id=?').get(run.id)!;
      if (saved.status !== 'running') { exec.concludeTurn(); return json(saved); }
      const coverage = db.prepare('SELECT * FROM coverage WHERE run_id=?').all(run.id);
      if (args.status === 'complete' && (coverage.length !== JSON.parse(run.watch.sources).length
        || coverage.some(c => c.status !== 'covered' || !args.evidence_ids.includes(c.evidence_id as string)))) throw new Error('约定来源未全部取得有效证据，不能标记完整检查。');
      for (const id of args.evidence_ids) if (!db.prepare('SELECT id FROM evidence WHERE id=? AND retrieved_at >= (SELECT started_at FROM runs WHERE id=?)').get(id, run.id)) throw new Error(`本次检查没有取得证据: ${id}`);
      if (args.notification && (!args.event_key || args.evidence_ids.length === 0)) throw new Error('提醒需要稳定的事件去重标识和证据。');
      db.prepare('UPDATE runs SET status=?,result=?,finished_at=? WHERE id=?').run(args.status, json(args), now(), run.id);
      if (args.notification) {
        db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(), run.watch.id, run.id, args.event_key!, args.notification, now());
      }
      exec.concludeTurn();
      return json({ runId: run.id, status: args.status, notificationDelivery: args.notification ? 'pending' : 'not_requested' });
    },
  }));
  register(defineTool({ name: 'get_personal_status', description: '查看个人记录、任务版本、调度、最近检查及待发送提醒。用量是模型请求尝试和工具调用次数；费用未知。lastComplete 仅表示成功检查到的快照。',
    parameters: {}, output,
    async execute() {
      const schedules = await ctx.schedule.list();
      const tasks = (db.prepare('SELECT * FROM watches').all() as Watch[]).map(w => {
        const plan = marketPlan(w);
        const screen = marketScreenWatch(w);
        const eqn = eqnWatchPlan(w);
        const x = xWatchPlan(w);
        const sport = sportsWatch(w);
        const schedule = schedules.items.find(item => item.id === w.schedule_id);
        const resultColumn = screen ? "json_remove(result,'$.state','$.changes') AS result" : 'result';
        return { ...w, lastComplete: db.prepare(`SELECT started_at,finished_at,${resultColumn} FROM runs WHERE watch_id=? AND status='complete' ORDER BY started_at DESC LIMIT 1`).get(w.id) ?? null,
          ...(sport ? { sportsWatch: sport, scheduleStatus: schedule?.status ?? 'unknown',
            lastSports: db.prepare("SELECT id,status,started_at,finished_at,json_remove(result,'$.baseline') AS result,error FROM runs WHERE watch_id=? ORDER BY rowid DESC LIMIT 1").get(w.id) ?? null,
          } : screen ? { marketScreen: screen, scheduleStatus: schedule?.status ?? 'unknown',
            lastScreen: db.prepare(`SELECT id,status,error,started_at,finished_at,${resultColumn} FROM runs WHERE watch_id=? ORDER BY rowid DESC LIMIT 1`).get(w.id) ?? null,
          } : eqn ? { eqnWatch: eqn, scheduleStatus: schedule?.status ?? 'unknown',
            lastEqn: db.prepare('SELECT id,status,error,started_at,finished_at,result FROM runs WHERE watch_id=? ORDER BY rowid DESC LIMIT 1').get(w.id) ?? null,
          } : x ? { xWatch: x, scheduleStatus: schedule?.status ?? 'unknown',
            lastX: db.prepare('SELECT id,status,error,started_at,finished_at,result FROM runs WHERE watch_id=? ORDER BY rowid DESC LIMIT 1').get(w.id) ?? null,
          } : isCryptoPaper(w) ? { cryptoPaper: true, scheduleStatus: schedule?.status ?? 'unknown' }
            : { cryptoWatch: cryptoWatchPlan(w), weatherLocation: locationWatch(w) }), nextCheck: schedule?.status === 'active' ? schedule.scheduledAt : undefined,
          marketWatch: plan && describeWatchState({ plan, state: marketState(w.id), status: w.status as RuntimeWatch['status'],
            nextScheduleAt: schedule?.status === 'active' ? schedule.scheduledAt : undefined }, now()) };
      });
      return json({ records: db.prepare('SELECT kind,COUNT(DISTINCT id) AS count FROM records GROUP BY kind').all(), tasks, schedules,
        runs: db.prepare('SELECT id,watch_id,watch_version,started_at,finished_at,status,model_calls,tool_calls,error FROM runs ORDER BY started_at DESC LIMIT 10').all(),
        coverage: db.prepare('SELECT * FROM coverage WHERE run_id IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT 10)').all(),
        notices: db.prepare('SELECT * FROM notices ORDER BY created_at DESC LIMIT 30').all(), cost: null,
        notificationChannel: process.env.PM_TELEGRAM_ENABLED === 'true' ? 'telegram' : 'local_records_only' });
    },
  }));
  register(defineTool({ name: 'read_run', description: '按运行 ID 回看完整检查结论及来源覆盖；complete 是当次覆盖，不代表此后仍有效。',
    parameters: { id: text }, output,
    async execute({ id }) { return json({ run: db.prepare('SELECT * FROM runs WHERE id=?').get(id) ?? null,
      coverage: db.prepare('SELECT * FROM coverage WHERE run_id=?').all(id),
      notices: db.prepare('SELECT id,event_key,created_at,delivery_status FROM notices WHERE run_id=?').all(id) }); },
  }));
  register(defineTool({ name: 'read_watch_history', description: '读取一个持续任务约定的全部历史版本。',
    parameters: { id: text }, output,
    async execute({ id }) { return json(db.prepare('SELECT * FROM watch_versions WHERE watch_id=? ORDER BY version').all(id)); },
  }));

  register(defineTool({ name: 'read_watch_anomalies', description: '查看关注列表最近24小时的异常、已保存事实、来源覆盖和到期判断。使用实际检查和通知回执。',
    parameters: {}, output, async execute() {
      const until = now();
      return json(watchActivity(db, new Date(Date.parse(until) - 86400000).toISOString(), until, true));
    },
  }));
  register(defineTool({ name: 'read_anomaly_detail', description: '用异动的 evidence_id 回读交易比较窗口、盘口或事实的原始证据、可能受影响的判断和已登记持仓。',
    parameters: { evidence_id: text, market_id: integer }, output, async execute({ evidence_id, market_id }) {
      const evidence = loadEvidence(evidence_id);
      if (!evidence) throw new Error('异动证据不存在');
      const linked = db.prepare(`SELECT c.run_id,w.market_id,c.detail FROM coverage c JOIN runs r ON r.id=c.run_id
        JOIN watches w ON w.id=r.watch_id WHERE c.evidence_id=? ORDER BY r.started_at DESC LIMIT 20`).all(evidence_id);
      const verifiedMarket = evidence.data.marketId ?? evidence.data.localMarketId;
      if (verifiedMarket !== undefined ? verifiedMarket !== market_id : !linked.some(row =>
        (JSON.parse(String(row.detail)).marketId ?? row.market_id) === market_id)) {
        throw new Error('该证据未关联指定市场');
      }
      const relevant = listRecords(db, market_id).filter(row => ['position', 'thesis'].includes(String(row.kind)))
        .map(row => ({ id: row.id, kind: row.kind, version: row.version, createdAt: row.created_at, data: JSON.parse(String(row.data)) }))
        .filter(row => row.kind !== 'position' || !evidence.data.tokenId || !row.data.outcome_token_id || row.data.outcome_token_id === evidence.data.tokenId);
      const inputs = (evidence.data.inputEvidenceIds ?? []) as string[];
      const until = now();
      const context = watchActivity(db, new Date(Date.parse(until) - 86400000).toISOString(), until, true).anomalies
        .filter(change => change.affected.some(ref => ref.marketId === market_id) && change.change.sourceId === externalEvidence);
      const relatedChecks = db.prepare(`SELECT c.path,c.status,c.evidence_id,c.detail FROM coverage c
        WHERE c.run_id=(SELECT run_id FROM coverage WHERE evidence_id=? ORDER BY rowid DESC LIMIT 1)
        AND (c.evidence_id IS NULL OR c.evidence_id<>?) AND json_extract(CASE WHEN json_valid(c.detail) THEN c.detail END,'$.marketId')=?`)
        .all(evidence_id, evidence_id, market_id).map(row => ({ itemId: row.path, status: row.status, evidenceId: row.evidence_id,
          issue: JSON.parse(String(row.detail)).issue }));
      return json({ evidence, inputSources: inputs.map(id => {
        const row = loadEvidence(id);
        return row && { evidenceId: id, source: row.source, retrievedAt: row.retrievedAt, kind: row.data.kind };
      }).filter(Boolean), runIds: linked.map(r => r.run_id), relatedChecks, relatedRecords: relevant, observedExternalChanges: context });
    },
  }));
  register(defineTool({ name: 'estimate_visible_execution', description: '精确选项的当前盘口逐档估算。quantity 为份数，buy 使用卖盘，sell 使用买盘。只读，报价过期或来源不合格时不估算。',
    parameters: { market_id: integer, token_id: text, side: { ...text, enum: ['buy', 'sell'] }, quantity: { type: 'number', required: true } }, output,
    async execute({ market_id, token_id, side, quantity }, exec) {
      if (!Number.isSafeInteger(market_id) || market_id <= 0 || !/^\d+$/.test(token_id) || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('请输入有效的市场、选项和正数份数');
      }
      const market = await resolveMarket(`local:${market_id}`, exec.signal);
      if (market.data.status !== 'found' || !(market.data.outcomes as { tokenId: string }[] | undefined)?.some(o => o.tokenId === token_id)) {
        throw new Error('该选项未与市场匹配');
      }
      const { raw, book } = await readBook(market_id, token_id, exec.signal);
      return json({ marketId: market_id, tokenId: token_id, bookStatus: book.sourceStatus, sourceObservedAt: book.observedAt,
        evidenceId: raw.evidenceId, estimate: estimateBook(book, side, quantity) });
    },
  }));
  register(screenTool);
  register(defineTool({ name: 'discover_price_moves', description: '在选定主题的开放市场中扫描最近30分钟成交参考价变化，返回初筛候选和原始证据。候选的热事实窗口覆盖需进一步核对。',
    parameters: { topic: { ...text, enum: ['macro', 'economics', 'politics', 'sports', 'crypto', 'weather'] } }, output,
    async execute({ topic }, exec) {
      const result = await researchEngine('query', { engine: 'clickhouse', max_rows: 10,
        catalog_sql: `SELECT m.market_id,o.token_id,o.outcome AS outcome_label,m.title FROM research.markets('${topic}') m
          JOIN research.outcomes o USING (market_id) WHERE m.is_open`,
        sql: `SELECT p.market_id,c.token_id AS token_id,c.outcome_label,c.title,p.first_price,p.last_price,p.price_change,p.fact_rows,
          p.first_time,p.last_time FROM research_prices(start=:as_of-INTERVAL 30 MINUTE,end=:as_of) p
          JOIN catalog c ON p.market_id=c.market_id AND p.token_id=c.token_id
          WHERE p.fact_rows>=10 ORDER BY abs(p.price_change) DESC,p.market_id,c.token_id LIMIT 10` }, exec.signal);
      const evidence = saveEvidence(db, result.source, result.data, result.retrievedAt);
      return json({ evidenceId: evidence.evidenceId, topic, method: '已观察到的成交参考价变动初筛，至少10条源事实，最多10项',
        coverage: 'candidate_only', result: resultPreview(result.data, 10) });
    },
  }));

  const dailySession = SessionId('pm-watch-daily-summary');
  const dailySource = 'market-watch/daily-summary';
  const digestActivity = (since: string, until: string) => ({ ...watchActivity(db, since, until, true),
    failureCounts: watchFailureCounts(db, since, until) });
  const dailySchedule = async () => (await ctx.schedule.list({ limit: 500 })).items.find(item => item.target?.kind === 'session' && item.target.sessionId === dailySession);
  const savedDigest = (day: string) => db.prepare("SELECT id,data FROM evidence WHERE source=? AND json_extract(data,'$.day')=? ORDER BY rowid DESC LIMIT 1")
    .get(dailySource, day);
  let digestChanging = false;
  register(defineTool({ name: 'configure_watch_digest', description: '管理个人每日待处理摘要的原生调度。start 创建或更新北京时间的生成时间，pause 暂停，status 回读。摘要保存为证据。',
    parameters: { action: { ...text, enum: ['start', 'pause', 'status'] }, time: { ...optionalText, description: '北京时间 HH:mm，缺省20:00' } }, output,
    async execute({ action, time = '20:00' }, exec) {
      if (action === 'status') return json(await dailySchedule() ?? null);
      if (digestChanging) throw new Error('摘要调度正在更新');
      digestChanging = true;
      try {
        const current = await dailySchedule();
        if (action === 'pause' && !current) return json(null);
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('时间须为北京时间 HH:mm');
        const timing = { kind: 'daily' as const, daily: { time: `${time}:00`, time_zone: 'Asia/Shanghai' } };
        if (current) {
          const patch = action === 'pause' ? { active: false } : { active: true, timing };
          const result = await ctx.schedule.edit({ id: current.id, action: 'update', expectedUpdatedAt: current.updatedAt ?? null, patch }, exec.agent?.session.id, exec.signal);
          if ('code' in result) throw new Error(result.code);
          return json(result);
        }
        const handle = await ctx.agents.create({ sessionId: dailySession, meta: { cwd: process.cwd() }, agentOptions: {
          provider: 'personal', model: process.env.PM_MODEL!, maxTokens: 1024,
        } });
        try { await ctx.sessions.flush(handle.agent.session); } finally { await handle.dispose(); }
        return json(await ctx.schedule.create({ title: '每日盯盘待处理摘要', prompt: '保存本次待处理摘要。',
          timing, target: { kind: 'session', sessionId: dailySession } }, exec.agent?.session.id, exec.signal));
      } finally { digestChanging = false; }
    },
  }));
  register(defineTool({ name: 'read_watch_digest', description: '读取每日待处理摘要及失败原因分项计数。计数按来源检查，包含期间运行过的已暂停和已到期任务。date按北京时间YYYY-MM-DD。',
    parameters: { date: optionalText }, output, async execute({ date = activityDay(now()) }) {
      const start = Date.parse(`${date}T00:00:00+08:00`);
      if (!Number.isFinite(start) || activityDay(new Date(start).toISOString()) !== date || start > Date.now()) {
        throw new Error('需要有效且未到未来的北京时间日期');
      }
      const saved = savedDigest(date);
      if (saved) {
        const data = JSON.parse(String(saved.data));
        return json({ evidenceId: saved.id, ...data, failureCounts: data.failureCounts ?? watchFailureCounts(db, data.since, data.until) });
      }
      return json({ kind: 'watch_digest_preview', day: date, ...digestActivity(new Date(start).toISOString(),
        new Date(Math.min(Date.now(), start + 86400000)).toISOString()) });
    },
  }));

  // Catalog discovery has one owner: market-data. Polymonitor supplies external research views.
  const allowed = (tool: string) => owned.has(tool)
    || tool.startsWith('mcp__polymonitor__') && tool !== 'mcp__polymonitor__search_markets'
    || tool.startsWith('mcp__memory__') || ['skill', 'todo_write', 'ask_user_question', 'web_fetch'].includes(tool);
  ctx.on('agent/created', ({ agent }) => {
    const watch = db.prepare('SELECT * FROM watches WHERE session_id=?').get(agent.session.id) as Watch | undefined;
    const isWatch = Boolean(watch);
    const x = watch && xWatchPlan(watch);
    agent.ctx.tools.restrict({ allow: watch ? (x ? [xWatchTool(x), 'read_run'] : eqnWatchPlan(watch) ? ['read_eqn_news', 'read_run']
      : sportsWatch(watch) || marketScreenWatch(watch) || locationWatch(watch) ? ['read_run'] : watch.market_id === null ? ['crypto_indicators', 'read_run']
      : marketPlan(watch) ? ['check_market_watch', 'read_run']
      : ['skill', 'read_records', 'read_evidence', 'read_watch_sources', 'finish_watch_check', 'read_run'])
      : ctx.tools.schemas().map(tool => tool.name).filter(allowed) });
    agent.ctx.systemPrompt.section({ name: 'pm-sports-usage', order: 308, interpolate: false, text: () => isWatch ? '' :
      '问 Polymarket 上哪些比赛正在打，先用 read_polymarket_public 的 live_sports。联赛或杯赛传 competition，问盘口传 include_lines=true。逐场列出符合该赛事范围的比赛和盘口。具体查询 NBA 赛程、出战、球员统计、NBA 篮板盘，网球比赛的开打、比分、退赛或 CS2 对阵、禁选、逐图和回放时加载 pm-sports，使用 sports_assistant。用户明确要求持续提醒时先 watch_draft，再用 sports_watch_evidence_id 创建任务。CS2 用户明确要求持续解说、逐回合播报或实时文字直播时，先用 Polymarket 官方列表查同场赛事，再查同场 HLTV 链接和已公布的地图顺序，调用 cs2_live_commentary。只在回执状态为 streaming 时回复已接入逐回合直播。delivery=journal_only 时，仅该进程存证，不能承诺推送到对话；Telegram 送达以 lastMessageId 为准。用户只要求开赛或每图等进度提醒时用 watch_preset=cs2_commentary；到期和下次检查用回执的北京时间字段。从快照 times 直接引用北京时间和星期，引用原始链接和证据，区分官方统计、ESPN 数据、规则判断与平台结算。' });
    agent.ctx.systemPrompt.section({ name: 'pm-tennis-usage', order: 308, interpolate: false, text: () => isWatch ? '' :
      '网球发接发、分场地画像、比分情景概率、已存比分与盘口时间线、网球子盘研究加载 pm-tennis。画像、计算和时间线用 tennis_research，赛事、合约及提醒复用 sports_assistant。' });
    agent.ctx.systemPrompt.section({ name: 'pm-weather-usage', order: 309, interpolate: false, text: () => isWatch ? '' :
      '天气统一用 inspect_weather_market。用户问最高温盘今天还会不会跨档、模型峰值、报价深度或刚才的预报有什么变化，直接用 query_type=temperature_desk 和市场链接。比较先前结果加 previous_snapshot_evidence_id。观测窗口直接引用 desk.observationWindow 的当地和北京时间字段。按 pm-weather-market Skill 解读实测、未经校准的样本频率和盘口深度，引用原始来源。' });
    agent.ctx.systemPrompt.section({ name: 'pm-x-market-usage', order: 308, interpolate: false, text: () => isWatch ? '' :
      '问 X 账号动态、EQN 快讯、XTracker 或 X 合约时使用 pm-x-market。直接查 X 用 read_x_posts。EQN 人物账号固定映射为马斯克=elonmusk（elon 频道）、CZ 或赵长鹏=cz_binance（cz 频道）、何一=heyibinance（cz 频道）。例如用户问何一最新一条动态，直接调用 read_eqn_news，参数 {"action":"list","channel":"cz","x_handle":"heyibinance","limit":1}，命中即回答；只在需要详情字段时按 no 用 get。EQN 回答给出公开快讯编号和原帖链接，按 pm-output 展示。多个账号的最新动态各调一次。查合约计数先 resolve_market 读规则，再按规则账号和纽约窗口用 read_xtracker_count。用户明确要求自动提醒时，EQN 快讯用 create_watch_task 的 eqn 参数，X 账号直读用 x_watch 的 timeline 模式，XTracker 计数变化先读规则并核对计数，再用 x_watch 的 count 模式传账号、带时区的起止时间、准确市场链接和可选 target。默认每 5 分钟、持续 24 小时。执行成功才确认订阅，回报任务 ID、下次检查和到期时间。' });
    agent.ctx.systemPrompt.context({ name: 'personal-research-budget', order: 295, required: true, interpolate: false, text: () => {
      const run = active.get(agent.session.id);
      if (!run || run.watch) return '';
      return `本轮时间基准（UTC）：${run.asOf}。剩余模型调用 ${maxModels - run.models} 次，工具调用 ${maxTools - run.tools} 次。`
        + (run.liveSportsCompetition ? `本轮只查 CS2 的 ${run.liveSportsCompetition} 在赛赛事。调用 read_polymarket_public 的 live_sports 时传 competition=${run.liveSportsCompetition}，逐场按用户所问回答。` : '')
        + (maxModels - run.models <= 1 || run.tools >= maxTools ? '请根据已有证据完成回答，说明仍未解决的部分。' : '');
    } });
    agent.ctx.systemPrompt.section({ name: 'source-evidence-usage', order: 302, interpolate: false, text: () =>
      isWatch ? '' : '外部证据对照直接用工具回执答复。指定已保存的 Binance Spot K 线及价格路径时，normalize_source_evidence 只传 evidenceId、pointer 和用户指定的数字 marketId，由程序读取规则和口径。首次基线调用 compare_source_evidence 只传该次规范化的 afterEvidenceId。同一快照按原口径重测时，normalize_source_evidence 只传同一原始 evidenceId 和上次的规范化 previousEvidenceId；compare_source_evidence 以旧规范化 ID 为 before、新 ID 为 after。直接回复证据 ID、状态和变化项。' });
    agent.ctx.systemPrompt.section({ name: 'pm-public-data-usage', order: 304, interpolate: false, text: () =>
      isWatch ? '' : '用户单独查询 Polymarket 官方数据或当前盘口时加载 pm-public-data Skill。只有用户明确要求单市场只列书商原始赔率与官方五档时，调用 lookup_market_odds。' });
    agent.ctx.systemPrompt.section({ name: 'crypto-indicator-usage', order: 306, interpolate: false, text: () => isWatch ? '' :
      '用户问加密货币技术指标时调用 crypto_indicators，目录 action=list，实际计算 action=compute。布林带用 BBANDS，MACD、RSI 使用对应 ID。未指定交易对时常见币种使用 Binance 现货 USDT 对并说明；现货未指定周期时查询默认 1h。资金费率、未平仓量、基差、多空账户比和爆仓采用对应的 USD-M 永续指标，链上 SOPR、已实现市值使用 Bitcoin 日频 1d。分开报告各源实际观测时间、覆盖、延迟和证据 ID。用户明确要求指标提醒时直接用 create_watch_task 的 crypto 字段与 interval_seconds 和带时区的 expires_at。单个任务包含一个交易对、来源支持的周期、指标和数值条件。MACD 上穿信号线可用 histogram 上穿 0。延迟或限流的来源不产生指标提醒。用 get_personal_status 和 update_watch_task 查看或管理。任务检查由程序执行。' });
    agent.ctx.systemPrompt.section({ name: 'pm-world-search-usage', order: 305, interpolate: false, text: () =>
      isWatch || agent.session.id === dailySession ? '' : '问公开政策、事件事实、外部官方数据或市场规则证据时，加载一次 pm-world-search Skill。纯事实问题直接用 search_market_sources（省略 marketEvidenceId）检索和读取原文，无需查市场。要求核对规则时再定位逐字引文及 offset，调用 verify_market_source_fact。只有用户问实际结算时才读 Oracle。' });
    agent.ctx.systemPrompt.section({ name: 'odds-forecast-usage', order: 303, interpolate: false, text: () =>
      isWatch ? '' : '用户问单场比赛的赔率、胜率或融合，先加载 pm-forecast。只有球队名时按 Skill 查找最近未开赛的全场胜负盘和球队选项。默认调用 forecast_market_odds，包括只写「最近一场比赛的赔率是多少」的问法。完整回复包含书商赔率、官方五档、Agent 判断、融合对照和末尾默认概率。数据缺口按工具 diagnostic 区分赛程覆盖、匹配和读取故障。用户明确只要原始报价时才调用 lookup_market_odds。' });
    agent.ctx.systemPrompt.section({ name: 'market-data-schema', order: 300, interpolate: false, text: () =>
      isWatch || !catalog ? '' : 'market-data 数据目录与真实表结构（结构可复用，业务数据须实际查询）：\n'
        + json({ catalog, schemas: [...schemas.values()] }),
    });
    agent.ctx.systemPrompt.section({ name: 'market-data-usage', order: 301, interpolate: false,
      text: () => isWatch ? '' : `market-data Skill 已加载，无需再次调用 skill：\n${marketSkill}` });
    agent.ctx.systemPrompt.context({ name: 'previous-query-selection', order: 296, required: true, interpolate: false, text: () => {
      if (isWatch) return '';
      const previous = db.prepare("SELECT result FROM runs WHERE session_id=? AND status='complete' AND result IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get(agent.session.id);
      return previous ? '最近一次结果的证据回执（程序保存）。SQL选集可用query_sql engine=evidence继续筛选；code_result先用read_evidence读取；source_evidence_comparison的after.evidenceId是原始证据，after.normalizedEvidenceId是规范化证据。\n' + previous.result : '';
    } });
    agent.ctx.systemPrompt.context({ name: 'personal-watch-run', order: 300, required: true, interpolate: false, text: () => {
      const watch = db.prepare('SELECT * FROM watches WHERE session_id=?').get(agent.session.id) as Watch | undefined;
      if (!watch) return '';
      if (xWatchPlan(watch)) return xWatchPrompt;
      if (eqnWatchPlan(watch)) return eqnWatchPrompt;
      if (marketScreenWatch(watch)) return screenWatchPrompt;
      if (sportsWatch(watch)) return sportsWatchPrompt;
      if (watch.market_id === null) return cryptoWatchPrompt;
      if (marketPlan(watch)) return marketWatchPrompt;
      const run = active.get(agent.session.id);
      return `你正在执行的任务约定（程序提供）：${json({ taskId: watch.id, version: watch.version, status: watch.status,
        goal: watch.goal, marketId: watch.market_id, notifyWhen: watch.notify_when, sources: JSON.parse(watch.sources),
        runId: run?.id ?? '本次触发尚未开始', modelCalls: run?.models ?? 0, maxModelCalls: watch.max_model_calls,
        toolCalls: run?.tools ?? 0, maxToolCalls: watch.max_tool_calls, expiresAt: watch.expires_at })}。
你就是本次检查的执行者，running 表示需要你继续执行。每次调度是新的检查，预算按本次独立计数。历史记录不能代替本次 read_watch_sources 和 finish_watch_check；后者必填 status、summary、evidence_ids，不通知时省略 notification。只有本次真实工具结果确认已记录才能结束。`;
    } });
  });
  ctx.tools.guard(exec => {
    if (!allowed(exec.name)) return '该工具不属于个人研究实例的工具集合。';
    const run = active.get(exec.agent?.session.id ?? '');
    if (!run) return;
    if (exec.name === 'cs2_live_commentary' && (exec.arguments as { action?: string } | null)?.action === 'start'
      && (!run.cs2StreamRequested || run.watch)) return '启动逐回合推送需要用户明确要求持续解说或逐回合播报。';
    if (run.cs2StreamRequested && exec.name === 'sports_assistant') {
      const args = exec.arguments as { action?: string; sport?: string } | null;
      if (args?.sport === 'cs2' && args.action === 'watch_draft')
        return '逐回合解说用 cs2_live_commentary。先确认 Polymarket 赛事、同场 HLTV 链接和实际地图顺序。';
    }
    if (run.liveSportsList) {
      if (['lookup_market_odds', 'forecast_market_odds', 'compare_odds_forecasts'].includes(exec.name))
        return '这轮查询的是进行中的赛事列表和逐场 Polymarket 盘口。请用 read_polymarket_public 的 live_sports，include_lines=true。';
      if (exec.name === 'sports_assistant' && !run.liveSportsRead)
        return '请先用 read_polymarket_public 的 live_sports 确认官方在赛赛事列表。';
      if (exec.name === 'read_polymarket_public' && run.liveSportsCompetition) {
        const args = exec.arguments as { view?: string; competition?: string } | null;
        if (args?.view === 'live_sports' && !/\bmajor\b/i.test(args.competition ?? ''))
          return `本轮指定了赛事范围。请用 id=cs2，并传 competition=${run.liveSportsCompetition}。`;
      }
    }
    if (!run.watch && process.env.PM_TELEGRAM_ENABLED === 'true' && exec.agent) {
      const mismatch = telegramMarketGuard(db, exec.agent.session.id, exec.name, exec.arguments);
      if (mismatch) return mismatch;
      if (exec.name === 'web_fetch' || exec.name === 'read_market_source_copy') {
        const url = (exec.arguments as { url?: unknown } | null)?.url;
        if (typeof url === 'string') {
          run.pageAttempts ??= new Map();
          const key = `${exec.name}:${url.trim()}`;
          const count = run.pageAttempts.get(key) ?? 0;
          if (exec.name === 'web_fetch' && count) return '本轮已直读过该 URL。复用已有正文，或在直读失败时使用已有搜索回执调用 read_market_source_copy。';
          if (count >= 2) return '同一读页通道已尝试该地址两次。请读取其他搜索候选或通过独立正文通道补读。';
          run.pageAttempts.set(key, count + 1);
        }
      }
    }
    if (run.watch && (['search_market_sources', 'read_market_source_copy', 'read_official_market_data', 'locate_market_source_passages', 'verify_market_source_fact',
      'save_record', 'delete_record', 'create_watch_task', 'update_watch_task'].includes(exec.name)
      || /^mcp__memory__(create|add|delete)/.test(exec.name))) return '定时研究只能读取已授权范围并保存检查结果，不能自行修改个人记录、记忆或任务权限。';
    if (run.watch && run.watch.expires_at <= now()) return '任务已到期。';
    if (run.tools >= (run.watch?.max_tool_calls ?? maxTools)) return '本次工具调用预算已用尽。';
    run.tools++;
    db.prepare('UPDATE runs SET tool_calls=? WHERE id=?').run(run.tools, run.id);
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept' || 'value' in decision) return decision;
    const run = active.get(exec.agent?.session.id ?? '');
    if (run && exec.name === 'read_polymarket_public' && !result.isError
      && (exec.arguments as { view?: string } | null)?.view === 'live_sports') run.liveSportsRead = true;
    if (run && exec.name === 'inspect_weather_market' && !result.isError) {
      const ids = run.weatherEvidenceIds ??= new Set<string>();
      for (const id of toolEvidenceIds(exec.name, result)) ids.add(id);
    }
    if (run && !result.isError && exec.name === 'compare_source_evidence' && typeof result.value === 'string') {
      const { evidenceId, data } = JSON.parse(result.value);
      run.sourceComparison = { evidenceId, kind: data.kind, status: data.status, before: data.before, after: data.after };
    }
    if (run && !run.watch && !run.liveSportsList && !run.liveSportsRead && !result.isError && ['lookup_market_odds', 'forecast_market_odds', 'compare_odds_forecasts'].includes(exec.name)
        && typeof result.value === 'string') {
      const { reply, status, judgment, diagnostic, conclusion, evidenceId, marketEvidenceId } = JSON.parse(result.value);
      run.marketOddsResult = reply ? { reply, judgment, conclusion } : undefined;
      if (reply) return { ...decision, content: [{ type: 'text', text: json({ status, judgment, diagnostic, evidenceId: evidenceId ?? marketEvidenceId }) }] };
    }
    const source = exec.name === 'web_fetch' ? (exec.arguments as { url?: string } | null)?.url
      : exec.name.startsWith('mcp__polymonitor__') ? `${polymonitorUrl}/mcp#${exec.name}` : undefined;
    if (typeof source !== 'string' || !source) return decision;
    let data: unknown = { arguments: exec.arguments, result: result.value };
    if (result.isError) {
      const code = result.error.info?.code;
      if (exec.signal.aborted || code === 'WEB_ABORTED' || code === 'UNKNOWN_TOOL') return decision;
      data = {
        kind: 'source_capture', coverage: 'link',
        ...(code === 'WEB_UNSUPPORTED_CONTENT_TYPE' ? { unsupported: result.error.message }
          : { failure: { stage: 'access', code, reason: result.error.message } }),
      };
    }
    const { evidenceId, retrievedAt } = saveEvidence(db, source, data);
    const receipt = { type: 'text' as const, text: json({ evidenceId, source, retrievedAt,
      ...(exec.name === 'web_fetch' ? { pageReads: 1 } : {}) }) };
    const content = decision.content ?? result.content;
    return { ...decision, content: exec.name === 'web_fetch' ? [receipt, ...content] : [...content, receipt] };
  });
  ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = payload.agent.session.id;
    if (sessionId === dailySession) {
      const schedule = await dailySchedule();
      const native = payload.messages.filter(m => String(m.source.kind) === 'schedule').flatMap(m => m.content);
      if (schedule?.status === 'active') for (const c of native) {
        if (c.type !== 'text') continue;
        const batch = c.text.startsWith('[SCHEDULE REMINDER BATCH]') && c.text.match(/^reminders_json: (.+)$/m)?.[1];
        const occurrence = batch ? (JSON.parse(batch) as { schedule_id: string; occurrence_at: string }[])
          .find(r => r.schedule_id === schedule.id)?.occurrence_at
          : c.text.startsWith('[SCHEDULE REMINDER]') && c.text.includes(`\nschedule_id_json: ${json(schedule.id)}\n`)
            ? c.text.match(/^occurrence_at: (.+)$/m)?.[1] : undefined;
        if (!occurrence || !Number.isFinite(Date.parse(occurrence))) continue;
        const exists = db.prepare("SELECT id FROM evidence WHERE source=? AND json_extract(data,'$.scheduleId')=? AND json_extract(data,'$.occurrence')=? LIMIT 1")
          .get(dailySource, schedule.id, occurrence);
        if (exists) continue;
        const until = now(), day = activityDay(until);
        saveEvidence(db, dailySource, { kind: 'watch_daily_digest', day, scheduleId: schedule.id, occurrence,
          ...digestActivity(new Date(Date.parse(until) - 86400000).toISOString(), until) }, until);
      }
      return { kind: 'reject' };
    }
    let run = active.get(sessionId);
    if (!run) {
      const watch = db.prepare('SELECT * FROM watches WHERE session_id=?').get(sessionId) as Watch | undefined;
      if (watch && (watch.status !== 'active' || watch.expires_at <= now() || watch.runs >= watch.max_runs)) {
        if (watch.schedule_id) await ctx.schedule.edit({ id: ScheduleId(watch.schedule_id), action: 'update', patch: { active: false } });
        if (watch.status === 'active') db.prepare('UPDATE watches SET status=? WHERE id=?')
          .run(watch.expires_at <= now() ? 'expired' : 'budget_exhausted', watch.id);
        return { kind: 'reject' };
      }
      const native = payload.messages.filter(m => String(m.source.kind) === 'schedule').flatMap(m => m.content);
      const triggers = native.filter(c => c.type === 'text' && c.text.startsWith('[SCHEDULE REMINDER]'));
      const screen = watch && marketScreenWatch(watch);
      const eqn = watch && eqnWatchPlan(watch);
      const x = watch && xWatchPlan(watch);
      const sport = watch && sportsWatch(watch);
      const paper = watch && isCryptoPaper(watch);
      const crypto = watch && !sport && !screen && !paper && cryptoWatchPlan(watch);
      const place = watch && locationWatch(watch);
      const messageTexts = native.flatMap(c => c.type === 'text' ? [c.text] : []);
      const timedOccurrence = watch && screen && cryptoOccurrence(messageTexts.filter(message => message.startsWith('[SCHEDULE REMINDER BATCH]\n')), watch.schedule_id);
      const nativeWatch = sport || eqn || x || screen || crypto || paper || place;
      const occurrence = timedOccurrence || (watch && nativeWatch && cryptoOccurrence(messageTexts, watch.schedule_id));
      if (watch && (nativeWatch ? !occurrence : !triggers.length)) return { kind: 'reject' };
      const plan = watch && marketPlan(watch);
      if (plan && !triggers.some(c => c.type === 'text' &&
          c.text.includes(`\nschedule_id_json: ${json(watch.schedule_id)}\n`))) return { kind: 'reject' };
      const id = watch ? sport || screen ? hash([watch.id, watch.schedule_id, occurrence]) : hash([watch.id, occurrence ?? triggers]) : `${sessionId}:${payload.turn}`;
      if (db.prepare('SELECT id FROM runs WHERE id=?').get(id)) return { kind: 'reject' };
      run = { id, watch, asOf: now(), models: 0, tools: 0, queries: new Map() };
      const question = payload.messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
        ?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
      run.cs2StreamRequested = !watch && (
        /(?:持续|实时|直播|流式).{0,22}(?:解说|播报)|(?:每回合|逐回合).{0,12}(?:推送|播报|直播)|\blive (?:commentary|play.by.play)\b/i.test(question)
        || /逐回合.{0,8}解说/.test(question) && !/复盘|回放|昨天|历史/.test(question));
      run.liveSportsList = !watch && /比赛|赛事|对阵|对局|\b(?:games|matches)\b/i.test(question)
        && /正在(?:打|进行)|在(?:打|进行)|进行中|已开打|\blive\b/i.test(question)
        && /哪(?:些|几|场)|有什么|多少场|有几场|有(?:正在|在)(?:打|进行)|有.{0,10}(?:比赛|赛事|对局).{0,5}(?:在打|在进行|进行中)|\b(?:which|what|any)\b/i.test(question)
        && !/\b(?:GRID|HLTV|ESPN|bookmaker|pinnacle|bet365)\b|书商|融合预测/i.test(question);
      if (run.liveSportsList && /\bcs2\b|反恐精英/i.test(question) && /\bmajor\b|特锦赛/i.test(question))
        run.liveSportsCompetition = /\bPGL\b/i.test(question) ? 'PGL Major' : 'Major';
      active.set(sessionId, run);
      db.prepare("INSERT INTO runs(id,session_id,watch_id,watch_version,started_at,status) VALUES (?,?,?,?,?,'running')").run(id, sessionId, watch?.id ?? null, watch?.version ?? null, run.asOf);
      if (watch) db.prepare('UPDATE watches SET runs=runs+1 WHERE id=?').run(watch.id);
      if (watch && nativeWatch && occurrence) {
        try {
          if (sport) {
            const finished = await sports.run(watch, sport, id, occurrence, payload.signal);
            if (finished && watch.schedule_id) await ctx.schedule.edit({ id: ScheduleId(watch.schedule_id), action: 'update', patch: { active: false } });
          }
          else if (eqn) await checkEqnWatch(watch, eqn, id, occurrence, run.asOf, payload.agent, payload.signal);
          else if (x) await checkXWatch(watch, x, id, occurrence, payload.agent, payload.signal);
          else if (screen) await checkMarketScreenWatch(db, watch, screen, id, occurrence, run.asOf, timedOccurrence ? 'timed' : 'manual', payload.signal);
          else if (paper) {
            const daily = (ids: string[]) => ids.map(id => ({ id }));
            const policy = paperPolicy(watch);
            const signalIds = [...new Set([...policy.up, ...policy.down].map(rule => rule.id))];
            let checkedAt = 0;
            let signals: IndicatorStatus[] = [];
            async function readSignals() {
              const time = Date.now();
              const close = time - time % 300_000;
              const ready = signals.length === 2 && signals.every(a => {
                const end = Date.parse(a.coverage?.lastCloseAt ?? '');
                return a.status === 'ok' && (end === close || end === close - 1);
              });
              if (ready || time - checkedAt < 35_000) return signals;
              checkedAt = time;
              const { results } = await ctx.tools.execute({ agent: payload.agent, signal: payload.signal, calls: [{
                type: 'tool-call', id: ToolCallId(randomUUID()), name: 'crypto_indicators', arguments: json({
                  action: 'compute', symbols: ['BTCUSDT', 'ETHUSDT'], intervals: ['5m'], indicators: daily(signalIds),
                }),
              }] });
              const result = results[0]?.result;
              signals = result && !result.isError && typeof result.value === 'string' ? JSON.parse(result.value).analyses : [];
              return signals;
            }
            const requests = [
              { symbols: ['BTCUSDT'], intervals: ['5m'], indicators: daily(['ALL']) },
              { symbols: ['ETHUSDT'], intervals: ['5m'], indicators: daily(['ALL']) },
              { symbols: ['BTCUSDT'], intervals: ['1d'], indicators: daily(['ADR', 'SOPR', 'REALIZED_CAP']) },
              { symbols: ['ETHUSDT'], intervals: ['1d'], indicators: daily(['ADR']) },
            ];
            const compute = ctx.tools.execute({ agent: payload.agent, signal: payload.signal, calls: requests.map(args => ({
              type: 'tool-call', id: ToolCallId(randomUUID()), name: 'crypto_indicators', arguments: json({ action: 'compute', ...args }),
            })) });
            const [execution, computed] = await Promise.allSettled([runCryptoPaper(db, watch, occurrence, readSignals, payload.signal), compute]);
            payload.signal.throwIfAborted();
            const issues: string[] = [];
            const analyses = computed.status === 'fulfilled' ? computed.value.results.flatMap(({ result }) => {
              if (result.isError || typeof result.value !== 'string') {
                issues.push(result.isError ? result.error.message : '缺少指标计算回执');
                return [];
              }
              return JSON.parse(result.value).analyses ?? [];
            }) : [];
            if (computed.status === 'rejected') issues.push(String(computed.reason));
            if (execution.status === 'rejected') issues.push(String(execution.reason));
            const simulation: CryptoPaperRun = execution.status === 'fulfilled' ? execution.value : {
              accountId: null, outcomes: [],
            };
            const prior = db.prepare(`SELECT result FROM runs WHERE watch_id=? AND id<>?
              AND json_extract(result,'$.kind')='crypto_paper_check' ORDER BY rowid DESC LIMIT 1`).get(watch.id, id);
            const priorRun = prior ? JSON.parse(String(prior.result)) as CryptoPaperRun : undefined;
            const [, reconciled] = await Promise.all([
              refreshCryptoPaper(simulation.outcomes.flatMap(o => o.legs), payload.signal),
              refreshCryptoPaper(priorRun?.outcomes.flatMap(o => o.legs) ?? [], payload.signal),
            ]);
            finishCryptoPaper(db, watch, id, occurrence, simulation, analyses, issues, reconciled);
          }
          else if (crypto) await checkCryptoWatch(watch, crypto, id, occurrence, payload.agent, payload.signal);
          else if (place) await weather.locations.run(watch, place, id, occurrence, payload.signal);
        } catch (error) {
          db.prepare("UPDATE runs SET status=?,finished_at=?,error=? WHERE id=? AND status='running'")
            .run(payload.signal.aborted ? 'cancelled' : 'failed', now(), String(error), id);
          db.prepare('INSERT OR IGNORE INTO coverage VALUES (?,?,NULL,?,?)')
            .run(id, sport ? sportsWatchSource : eqn ? eqnWatchSource : x ? x.kind : screen ? 'market-data/market-screen' : place ? 'weather_location' : paper ? cryptoPaperSource : cryptoWatchSource(undefined), payload.signal.aborted ? 'cancelled' : 'failed',
              json({ scheduleId: watch.schedule_id, occurrence, error: String(error) }));
        }
        const current = getWatch(db, watch.id);
        const ended = current.expires_at <= now() ? 'expired' : current.runs >= current.max_runs ? 'budget_exhausted' : undefined;
        if (ended && current.status === 'active' && current.version === watch.version && current.schedule_id) {
          db.prepare("UPDATE watches SET status=? WHERE id=? AND version=? AND status='active'").run(ended, watch.id, current.version);
          try {
            const schedule = await ctx.schedule.edit({ id: ScheduleId(current.schedule_id), action: 'update', patch: { active: false } });
            if ('code' in schedule) throw new Error(schedule.code);
            db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,NULL,?,?)').run(id, '$schedule', ended, json(schedule));
          } catch (error) {
            db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,NULL,?,?)').run(id, '$schedule', 'failed', json({ error: String(error) }));
          }
        }
        return { kind: 'reject' };
      }
      if (watch && plan) {
        try {
          const { results } = await ctx.tools.execute({ agent: payload.agent, signal: payload.signal,
            calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name: 'check_market_watch', arguments: '{}' }] });
          const result = results[0]?.result;
          if (!result || result.isError) throw new Error(result?.error.message ?? '通用检查工具无回执');
          const status = db.prepare('SELECT status FROM runs WHERE id=?').get(id)?.status;
          if (status === 'running') throw new Error('通用检查未提交');
        } catch (error) {
          db.prepare("UPDATE runs SET status=?,finished_at=?,error=? WHERE id=? AND status='running'")
            .run(payload.signal.aborted ? 'cancelled' : 'failed', now(), String(error), id);
        }
        if (!payload.signal.aborted) {
          try {
            const schedule = await syncMarketSchedule(getWatch(db, watch.id), plan, payload.signal);
            if (schedule) db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,?,?,?)')
              .run(id, '$schedule', null, schedule.status, json(schedule));
          } catch (error) {
            db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,?,?,?)')
              .run(id, '$schedule', null, 'failed', String(error));
          }
        }
        return { kind: 'reject' };
      }
    }
    if (run.watch && run.watch.expires_at <= now()) {
      db.prepare("UPDATE runs SET status='expired',finished_at=? WHERE id=?").run(now(), run.id);
      return { kind: 'reject' };
    }
    // Budget narrowing also blocks unstarted calls in the current resolved set.
    if (!run.watch && !run.releaseTools && (run.models >= maxModels - 1 || run.tools >= maxTools)) {
      run.releaseTools = payload.agent.ctx.tools.restrict({ deny: ctx.tools.schemas().map(t => t.name).filter(allowed) });
    }
    return next();
  }, { prepend: true });
  ctx.on('llm/stream', async function* (options, next) {
    const run = active.get(options.sessionId ?? '');
    if (!run) { yield* next(); return; }
    const odds = !options.purpose && run.marketOddsResult;
    if (odds) {
      let interpretation = '';
      if (odds.judgment && run.models < maxModels) {
        run.models++;
        db.prepare('UPDATE runs SET model_calls=? WHERE id=?').run(run.models, run.id);
        const judgment = ctx.llm.stream({ provider: options.provider, model: options.model, temperature: queryTemperature,
          maxTokens: 512, signal: options.signal,
          system: '你是 Polymarket 研究 Agent。针对这场，用一两句解释书商报价分歧大小、双方估计接近五五开还是存在明显优势，以及盘口深度对报价的意义。以程序的 summary 为准，不重复其中的球队方向或数值。前文已经展示所有赔率和五档，不重复数据。挂单说明流动性，不能据此推断赛果。historical 为 true 时称当时快照。不要补充赛况、权重或融合概率。',
          messages: [{ role: 'user', content: [{ type: 'text', text: json(odds.judgment) }] }],
        });
        for await (const chunk of judgment) {
          if (chunk.type === 'block-end' && chunk.block.type === 'text') interpretation += chunk.block.text;
          if (chunk.type === 'usage') yield chunk;
          if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
            if (chunk.reason.kind === 'aborted') { yield chunk; return; }
            interpretation = '';
          }
        }
      }
      const judgment = [odds.judgment?.summary, interpretation.trim()].filter(Boolean).join(' ');
      const text = [odds.reply, judgment ? `**Agent 判断** ${judgment}` : '',
        odds.conclusion].filter(Boolean).join('\n\n');
      const block = { type: 'text', text } as const;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: block.text };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (run.models >= (run.watch?.max_model_calls ?? maxModels)) {
      db.prepare("UPDATE runs SET status='budget_exhausted',finished_at=?,error='模型调用预算用尽' WHERE id=? AND status='running'").run(now(), run.id);
      throw new Error('模型调用预算用尽。');
    }
    run.models++;
    db.prepare('UPDATE runs SET model_calls=? WHERE id=?').run(run.models, run.id);
    yield* next();
  });
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: queryTemperature }));
  ctx.on('agent/error', ({ agent, error }) => {
    const run = active.get(agent.session.id);
    if (run) db.prepare("UPDATE runs SET status='failed',error=?,finished_at=? WHERE id=? AND status='running'").run(String(error), now(), run.id);
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      const run = active.get(session.id);
      if (run) run.reply = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return;
    }
    if (event.type !== 'turn/end') return;
    const run = active.get(session.id);
    if (!run) return;
    const reason = event.data.reason;
    const status = reason.kind === 'completed' ? (run.watch ? 'incomplete' : 'complete') : reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'error' ? 'failed' : reason.kind;
    db.prepare("UPDATE runs SET status=?,finished_at=?,error=? WHERE id=? AND status='running'").run(status, now(), reason.kind === 'error' ? reason.error.message : null, run.id);
    if (status === 'complete') {
      const ids = [...new Set((run.reply ?? '').match(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/gi) ?? [])];
      const queryIds = ids.flatMap(id => {
        const row = db.prepare('SELECT data FROM evidence WHERE id=?').get(id);
        const data = row ? JSON.parse(row.data as string) : undefined;
        return data?.kind === 'data_answer' ? data.evidenceIds as string[] : [id];
      });
      const selection = [...new Set(queryIds)].flatMap<Record<string, unknown>>(id => {
        const row = db.prepare('SELECT * FROM evidence WHERE id=?').get(id);
        if (!row) return [];
        const data = JSON.parse(row.data as string);
        return data.kind === 'sql_result' ? [{ evidenceId: id, source: row.source, retrievedAt: row.retrieved_at,
          queryAsOf: data.asOf ?? run.asOf, rowCount: data.rowCount, columns: data.columns,
          provenance: provenance(id), truncated: data.truncated }] : data.kind === 'code_result' ? [{
          evidenceId: id, kind: data.kind, source: row.source, retrievedAt: row.retrieved_at,
          status: data.status, inputEvidenceIds: data.inputEvidenceIds }] : [];
      });
      for (const id of run.weatherEvidenceIds ?? []) {
        const row = loadEvidence(id);
        if (row) selection.push({ evidenceId: id, kind: row.data.kind, status: row.data.status ?? row.data.desk?.status,
          source: row.source, retrievedAt: row.retrievedAt, inputEvidenceIds: row.data.inputEvidenceIds });
      }
      if (run.sourceComparison) selection.push(run.sourceComparison);
      db.prepare('UPDATE runs SET result=? WHERE id=?').run(json(selection), run.id);
    }
    run.releaseTools?.();
    active.delete(session.id);
  });

  // 本机控制入口供 CLI 调用同一套运行时工具，不另建 HTTP 服务。
  const server = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    const readRequest = (chunk: string) => {
      input += chunk;
      if (!input.includes('\n')) return;
      socket.off('data', readRequest);
      socket.pause();
      void dispatch();
    };
    socket.on('data', readRequest);
    async function dispatch() {
      try {
        const request = JSON.parse(input);
        if (request.action === 'list') { socket.end(json(ctx.tools.schemas().filter(t => allowed(t.name))) + '\n'); return; }
        const agent = request.sessionId ? ctx.agents.get(SessionId(request.sessionId)) : undefined;
        if (request.action === 'cancel') {
          if (!agent) throw new Error('会话未运行。');
          agent.cancel({ kind: 'user' }); await agent.whenIdle(); socket.end(json({ status: 'stopped', sessionId: agent.session.id }) + '\n'); return;
        }
        if (request.action === 'reply-stream') {
          if (!agent || process.env.PM_TELEGRAM_ENABLED !== 'true') throw new Error('Telegram 会话未运行。');
          let textOnly = false;
          const tools = new Map<string, string>();
          const unsubscribe = ctx.on('agent/assistant-stream', ({ agent: owner, frame }) => {
            if (owner !== agent || socket.destroyed) return;
            if (frame.type === 'start') {
              textOnly = true;
              socket.write('{"type":"reset"}\n');
            } else if (frame.type === 'chunk' && textOnly) {
              const { chunk } = frame;
              if (chunk.type === 'text-delta') {
                socket.write(json({ type: 'text', text: chunk.text }) + '\n');
              } else if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
                textOnly = false;
                socket.write('{"type":"reset"}\n');
              }
            }
          }, { global: true });
          const unsubscribeProgress = ctx.on('session/event', (session, event) => {
            if (session.id !== agent.session.id || socket.destroyed) return;
            if (event.type === 'tool/call') {
              if (request.verifySources === true) tools.set(event.data.callId, event.data.name);
              socket.write(json({ type: 'tool-start', id: event.data.callId, name: event.data.name }) + '\n');
            } else if (event.type === 'tool/result') {
              const message = event.data.message;
              const evidenceIds = request.verifySources === true ? [...toolEvidenceIds(tools.get(message.toolCallId), message)] : undefined;
              socket.write(json({ type: 'tool-end', id: message.toolCallId, failed: message.isError, evidenceIds }) + '\n');
            }
          }, { global: true });
          socket.once('close', () => { unsubscribe(); unsubscribeProgress(); });
          socket.on('error', () => socket.destroy());
          socket.resume();
          socket.write('{"type":"ready"}\n');
          return;
        }
        if (!allowed(request.name)) throw new Error('该工具未开放。');
        const signal = AbortSignal.timeout(60_000);
        const modelSelection = agent?.model.current();
        const toolSet = agent && modelSelection ? await ctx.tools.resolve({ agent, modelSelection, signal }) : undefined;
        try {
          const result = await ctx.tools.execute({ agent, toolSet, signal, calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name: request.name, arguments: request.arguments ?? {} }] });
          socket.end(json(result) + '\n');
        } finally {
          toolSet?.dispose();
        }
      } catch (error) { socket.end(json({ error: String(error) }) + '\n'); }
    }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(socketPath, accept); });
  chmodSync(socketPath, 0o600);
  // Schedule storage waits for plugin initialization, so recovery must let apply return.
  void (async () => {
    for (const watch of db.prepare("SELECT * FROM watches WHERE status='active'").all() as Watch[]) {
      const plan = marketPlan(watch);
      if (plan) await syncMarketSchedule(watch, plan).catch(error => ctx.logger.warn(`盯盘 ${watch.id} 恢复调度失败: ${String(error)}`));
    }
  })().catch(error => ctx.logger.warn(`盯盘恢复调度失败: ${String(error)}`));
  ctx.effect(() => () => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())));
}
