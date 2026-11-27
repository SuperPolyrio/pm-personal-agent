import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { compareSourceEvidence, type EvidenceRow } from './source-evidence.js';
import { compareRuleVersions, type RuleCard, type SavedNormalizedEvidence, type assessRuleEvidence } from './research.js';

export const weatherSource = 'weather_observation';
export const weatherConditions = ['bracket', 'revision', 'coverage', 'freeze', 'settlement', 'report', 'cumulative', 'trigger', 'impact'] as const;

type Awaitable<T> = T | Promise<T>;
type WatchKind = 'trading' | 'fact' | 'factor' | 'lifecycle' | 'quality';
type FactValue = string | number | boolean;
type DeliveryMode = 'immediate' | 'summary' | 'record';
type Confidence = 'unconfirmed' | 'confirmed' | 'conflicting';
type Importance = 'low' | 'normal' | 'high';
type Operation = 'gte' | 'gt' | 'lte' | 'lt';
type Comparison = 'level' | 'delta' | 'relative_percent' | 'percentage_points';

type Metric = { key: string; unit: string; windowSeconds?: number; minSamples?: number } & (
  | { kind: 'quote'; priceType: string }
  | { kind: 'spread'; priceType: string }
  | { kind: 'trades'; measure: 'amount' | 'shares' | 'count'; currency?: string; windowSeconds: number }
  | { kind: 'depth'; side: 'bid' | 'ask'; range: string }
);
type Threshold = { op: Operation; value: number };
type Trigger = {
  comparison: Comparison; enter: Threshold; exit?: Threshold; escalate?: Threshold;
  baseline?: 'previous' | 'reference'; consecutive?: number; holdSeconds?: number;
  cooldownSeconds?: number; notifyOnInitial?: boolean;
};
type NotificationPolicy = {
  mode: DeliveryMode; unconfirmed?: 'verify' | DeliveryMode; low?: 'summary' | 'record';
  quality?: DeliveryMode; highDuringQuiet?: boolean;
};
type QuietPeriod = { from: string; until: string };
type WatchBudget = { maxRuns: number; maxModelCalls: number; maxToolCalls: number };

export type WatchItemRequest = {
  id: string; kind: WatchKind; marketId: number; tokenId?: string; sourceId: string;
  scope: string; reason: string; intervalSeconds: number; maxAgeSeconds?: number; until?: string;
  clauseId?: string; ruleRequired?: boolean; recordRefs?: { id: string; version: number }[];
  external?: { normalizedEvidenceId: string; factKey: string; sourceTimeKey: string; ruleAssessmentEvidenceId?: string };
  weather?: { contractEvidenceId: string; conditions: (typeof weatherConditions)[number][]; ruleVersion?: string };
  metric?: Metric; trigger?: Trigger; notify?: NotificationPolicy; tradeWindowEndAt?: string; tradeProjectionEvidenceId?: string;
  // Phase keys are provided by the authorized source. "stop" ends only this item.
  phases?: Record<string, number | 'stop'>;
  trackPhase?: boolean;
};
export type WatchPlanRequest = {
  goal: string; items: WatchItemRequest[]; expiresAt: string; budget: WatchBudget;
  notify: NotificationPolicy; quiet?: QuietPeriod[];
};
export type WatchPlanContext = {
  watchId: string; configVersion: number; now: string;
  // The host resolves these records and restricts them to the user's authorization.
  markets: { resolution: EvidenceRow; tokenIds?: string[]; ruleCard?: RuleCard; membershipEvidenceId?: string }[];
  sources: { id: string; status: 'available' | 'unsupported' | 'restricted'; reason?: string;
    minIntervalSeconds?: number; targets: { marketId: number; tokenId?: string; scope: string; itemId?: string; limitation?: string }[] }[];
  expiresAt: string; budget: WatchBudget; authorizationRef: string;
};

type PlannedItem = WatchItemRequest & {
  baselineKey: string; effectiveIntervalSeconds: number; minSourceIntervalSeconds: number;
  support: 'available' | 'limited' | 'blocked'; issues: string[];
  rule?: { evidenceId: string; contentId: string; clause?: RuleCard['clauses'][number]; unknowns: string[] };
};
export type WatchPlan = Omit<WatchPlanRequest, 'items'> & {
  watchId: string; configVersion: number; authorizationRef: string; items: PlannedItem[];
  markets: { id: number; title: string; evidenceId: string; eventSlug?: string; tokenIds: string[];
    options: { tokenId: string; label?: string }[]; membershipEvidenceId?: string }[];
};

const epoch = (time?: string) => typeof time === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(time) ? Date.parse(time) : NaN;
const iso = (time: number) => new Date(time).toISOString();
const subsecond = (time: string) => (time.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i)?.[1] ?? '').padEnd(9, '0');
const orderAt = (a: string, b: string) => epoch(a) - epoch(b) || subsecond(a).localeCompare(subsecond(b));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positiveInt = (value: number) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const key = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts, (_name, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value,
)).digest('hex');
const unique = <T>(values: T[]) => [...new Set(values)];
const minInterval = 60;

export function prepareWatchPlan(request: WatchPlanRequest, context: WatchPlanContext): WatchPlan {
  if (!nonempty(context.watchId) || !positiveInt(context.configVersion) || !nonempty(context.authorizationRef) ||
      !nonempty(request.goal) || !(epoch(context.now) < epoch(request.expiresAt)) ||
      !(epoch(request.expiresAt) <= epoch(context.expiresAt))) throw new Error('目标、版本、授权或有效期无效。');
  for (const field of ['maxRuns', 'maxModelCalls', 'maxToolCalls'] as const) {
    if (!positiveInt(request.budget[field]) || !(request.budget[field] <= context.budget[field])) {
      throw new Error(`超出授权预算: ${field}`);
    }
  }
  if (request.quiet?.some(period => !(epoch(period.from) < epoch(period.until)))) {
    throw new Error('免打扰时段需要带时区的起止时间。');
  }
  if (!request.items.length || new Set(request.items.map(item => item.id)).size !== request.items.length) {
    throw new Error('监控项需要非空且唯一的 ID。');
  }
  const phaseOwners = request.items.filter(item => item.trackPhase);
  if (phaseOwners.some(item => item.kind !== 'lifecycle') ||
      new Set(phaseOwners.map(item => item.marketId)).size !== phaseOwners.length) {
    throw new Error('每个市场只能指定一个有来源的阶段监控项。');
  }
  const resolved = context.markets.flatMap(({ resolution, tokenIds, membershipEvidenceId, ruleCard }) => {
    const row = resolution.data as Record<string, unknown> | null;
    if (row?.status !== 'found' || !positiveInt(row.localMarketId as number) || !nonempty(row.title) ||
        !nonempty(resolution.evidenceId)) return [];
    const id = row.localMarketId as number;
    const outcomes = Array.isArray(row.outcomes) ? row.outcomes : [];
    const tokens = outcomes.length ? outcomes.map(outcome => outcome?.tokenId) : [row.yesTokenId, row.noTokenId];
    const available = unique(tokens.filter(nonempty)).filter(token => !tokenIds || tokenIds.includes(token));
    const options = available.map(tokenId => {
      const label = outcomes.find(outcome => outcome?.tokenId === tokenId)?.label;
      return { tokenId, label: nonempty(label) ? label : undefined };
    });
    return [{ id, title: row.title, evidenceId: resolution.evidenceId,
      eventSlug: nonempty(row.eventSlug) ? row.eventSlug : undefined,
      tokenIds: available, options, membershipEvidenceId,
      ruleCard: ruleCard?.market.localMarketId === id &&
        ruleCard.rules.evidenceId === resolution.evidenceId ? ruleCard : undefined }];
  });
  const items = request.items.map((item): PlannedItem => {
    const market = resolved.find(m => m.id === item.marketId);
    if (!market || (item.tokenId !== undefined && !market.tokenIds.includes(item.tokenId))) {
      throw new Error(`市场或选项未确认或超出授权: ${item.id}`);
    }
    if (![item.id, item.reason, item.scope, item.sourceId].every(nonempty) ||
        !positiveInt(item.intervalSeconds) || item.intervalSeconds < minInterval ||
        (item.until !== undefined && !(epoch(context.now) < epoch(item.until) && epoch(item.until) <= epoch(request.expiresAt))) ||
        (item.maxAgeSeconds !== undefined && !positiveInt(item.maxAgeSeconds)) ||
        Object.values(item.phases ?? {}).some(n => n !== 'stop' && (!positiveInt(n) || n < minInterval))) {
      throw new Error(`监控项缺少范围、关注依据或有效检查周期: ${item.id}`);
    }
    const { metric, trigger } = item;
    if ((item.sourceId === weatherSource) !== Boolean(item.weather) || item.weather &&
        (!nonempty(item.weather.contractEvidenceId) || !nonempty(item.weather.ruleVersion) ||
        !item.weather.conditions.length || unique(item.weather.conditions).length !== item.weather.conditions.length ||
        item.weather.conditions.some(condition => !weatherConditions.includes(condition)))) {
      throw new Error(`天气来源需要已核对的合约版本和关注条件: ${item.id}`);
    }
    if (metric && (item.kind !== 'trading' || !item.tokenId || !item.maxAgeSeconds || !nonempty(metric.key) || !nonempty(metric.unit) ||
        ('priceType' in metric && !nonempty(metric.priceType)) ||
        (metric.windowSeconds !== undefined && !positiveInt(metric.windowSeconds)) ||
        (metric.minSamples !== undefined && !positiveInt(metric.minSamples)) ||
        (metric.kind === 'trades' && (!metric.windowSeconds || (metric.measure === 'amount' && !nonempty(metric.currency)))) ||
        (metric.kind === 'depth' && !nonempty(metric.range)))) throw new Error(`交易指标口径不完整: ${item.id}`);
    const tradeEnd = epoch(item.tradeWindowEndAt);
    if (item.tradeWindowEndAt !== undefined && (metric?.kind !== 'trades' ||
        !(tradeEnd <= epoch(context.now)) || tradeEnd % 1000 !== 0 || /[1-9]/.test(subsecond(item.tradeWindowEndAt)) ||
        tradeEnd < metric.windowSeconds * 1000)) throw new Error(`成交窗口结束时间须为带时区的历史整秒: ${item.id}`);
    const tradeWindowEndAt = item.tradeWindowEndAt === undefined ? undefined : iso(tradeEnd);
    if (item.tradeProjectionEvidenceId !== undefined && (!tradeWindowEndAt || !nonempty(item.tradeProjectionEvidenceId))) {
      throw new Error(`成交投影凭据需要固定历史窗口: ${item.id}`);
    }
    if (trigger && (!metric || !trigger.enter || !['level', 'delta', 'relative_percent', 'percentage_points'].includes(trigger.comparison) ||
      ![trigger.enter, trigger.exit, trigger.escalate].every(t =>
      !t || (['gt', 'gte', 'lt', 'lte'].includes(t.op) && Number.isFinite(t.value))) ||
      (trigger.consecutive !== undefined && !positiveInt(trigger.consecutive)) ||
      !nonnegative(trigger.holdSeconds ?? 0) || !nonnegative(trigger.cooldownSeconds ?? 0) ||
      (trigger.comparison !== 'level' && !trigger.baseline) ||
      (trigger.comparison === 'percentage_points' && metric.unit !== 'fraction') ||
      (metric.windowSeconds !== undefined && trigger.baseline === 'previous'))) {
      throw new Error(`触发条件或比较基线不完整: ${item.id}`);
    }
    if (trigger) {
      const increasing = trigger.enter.op.startsWith('g');
      const direction = increasing ? 1 : -1;
      const { enter, exit, escalate } = trigger;
      if (exit && (exit.op.startsWith('g') === increasing || direction * (enter.value - exit.value) < 0 ||
          (exit.value === enter.value && exit.op.endsWith('e') && enter.op.endsWith('e')))) {
        throw new Error(`退出条件与触发条件重叠: ${item.id}`);
      }
      if (escalate && (escalate.op.startsWith('g') !== increasing || direction * (escalate.value - enter.value) <= 0)) {
        throw new Error(`加重阈值应比触发阈值更严格: ${item.id}`);
      }
    }
    const card = market.ruleCard;
    const clause = card?.clauses.find(c => c.id === item.clauseId);
    const source = context.sources.find(s => s.id === item.sourceId);
    const issues = [];
    const target = source?.targets.find(target => target.marketId === item.marketId && target.tokenId === item.tokenId &&
      target.scope === item.scope && (target.itemId === undefined || target.itemId === item.id));
    if (!target) {
      issues.push(source?.reason ?? '监控范围尚未获得来源授权');
    }
    if (source?.status !== 'available') issues.push(source?.reason ?? source?.status ?? '缺少已授权来源能力');
    if (item.clauseId && !clause) issues.push('缺少适用规则条款');
    if ((item.ruleRequired || item.clauseId) && (!card || card.rules.incomplete)) issues.push('缺少完整规则卡');
    const blocked = issues.length > 0;
    if (!blocked && target?.limitation) issues.push(target.limitation);
    const minSourceIntervalSeconds = Math.max(minInterval, source?.minIntervalSeconds ?? minInterval);
    const effectiveIntervalSeconds = Math.max(item.intervalSeconds, minSourceIntervalSeconds);
    if ([item.intervalSeconds, ...Object.values(item.phases ?? {}).filter(n => n !== 'stop')]
      .some(interval => interval < minSourceIntervalSeconds)) {
      issues.push(`来源最快每 ${minSourceIntervalSeconds} 秒可检查`);
    }
    const baselineKey = key(item.marketId, item.tokenId, item.kind, item.sourceId, item.scope, metric,
      trigger, item.maxAgeSeconds, item.clauseId, item.trackPhase, item.external, clause?.requirement, clause?.interval, clause?.equals, clause?.window,
      ...(tradeWindowEndAt === undefined ? [] : [tradeWindowEndAt]),
      ...(item.tradeProjectionEvidenceId === undefined ? [] : [item.tradeProjectionEvidenceId]),
      ...(item.weather ? [item.weather.ruleVersion, [...item.weather.conditions].sort()] : []));
    return { ...item, tradeWindowEndAt, baselineKey, effectiveIntervalSeconds, minSourceIntervalSeconds, issues,
      support: blocked ? 'blocked' : issues.length ? 'limited' : 'available',
      rule: card && { evidenceId: card.rules.evidenceId, contentId: card.rules.contentId, clause, unknowns: card.unknowns } };
  });
  return { ...request, expiresAt: iso(epoch(request.expiresAt)), watchId: context.watchId, configVersion: context.configVersion,
    authorizationRef: context.authorizationRef, items,
    markets: resolved.filter(m => items.some(item => item.marketId === m.id)).map(({ ruleCard: _card, ...m }) => m) };
}

type EvidenceRef = Pick<EvidenceRow, 'evidenceId' | 'source' | 'retrievedAt'>;
const evidenceRef = ({ evidenceId, source, retrievedAt }: EvidenceRef): EvidenceRef => ({ evidenceId, source, retrievedAt });
type Window = { from: string; to: string; complete: boolean; samples?: number; deduplicated?: boolean };
type Measurement = {
  marketId: number; tokenId: string; metric: Metric; value: number; window?: Window;
  reference?: { value: number; window: Window; evidenceIds: string[] };
};
type Phase = { key: string; eventAt?: string };
type Finding = {
  eventKey: string; revision: string;
  kind: 'added' | 'changed' | 'confirmed' | 'revised' | 'withdrawn' | 'conflict';
  description: string; importance: Importance; confidence: Confidence;
  tradeAt?: string; priceMove?: 'change' | 'range';
  unknowns?: string[]; verify?: string[]; before?: unknown; after?: unknown;
};
export type WatchObservation = {
  id: string; scope: string; observedAt: string; evidence: EvidenceRef; inputEvidenceIds?: string[];
  factAt?: string; sourceVersion?: string; value?: FactValue; findings?: Finding[];
  measurement?: Measurement; phase?: Phase;
  ruleCondition?: { clauseId: string; status: ReturnType<typeof assessRuleEvidence>['conditions'][number]['status']; missing: string[] };
};
type Issue = {
  status: 'failed' | 'stale' | 'partial' | 'pending' | 'unsupported' | 'restricted' | 'budget';
  reason: string; evidenceIds?: string[]; sourceThrough?: string;
};
export type WatchRead = { observations?: WatchObservation[]; issue?: Issue;
  review?: { evidence: EvidenceRef; observedAt: string; finding: Finding } };
type Gap = { from: string; to?: string; issue: Issue; operationKey: string };
type ItemState = {
  baselineKey: string; firstCheckedAt: string; checkedAt: string; last?: Omit<WatchObservation, 'findings' | 'phase'>;
  condition: { count: number; since?: string; entered: boolean; escalated: boolean; lastAlertAt?: string };
  events: Record<string, { latest: string; revisions: string[] }>; gaps: Gap[];
};
function effectiveObservation({ findings: _findings, phase: _phase, ...obs }: WatchObservation): NonNullable<ItemState['last']> {
  return { ...obs, evidence: evidenceRef(obs.evidence) };
}
type MarketPhase = Phase & { at: string; evidence: EvidenceRef; eventEvidence?: EvidenceRef;
  itemId: string; baselineKey: string };
export type WatchState = {
  version: number; checkedAt?: string; lastOperationKey?: string;
  items: Record<string, ItemState>; phases: Record<number, MarketPhase>;
};

type Decision = {
  itemId: string; marketId: number; tokenId?: string; sourceId: string; reason: string;
  rule?: PlannedItem['rule'];
  recordRefs?: PlannedItem['recordRefs']; action: DeliveryMode | 'verify' | 'suppress';
  actionReason: string; notBefore?: string; evidenceIds: string[]; evidence?: EvidenceRef;
  observedAt?: string; factAt?: string; previous?: ItemState['last']; relatedOperationKey?: string;
} & Finding;

export type WatchIntent = {
  operationKey: string; eventKey: string; revision: string; action: Decision['action'];
  // Each member retains its policy, evidence and timing, including when the group can be sent immediately.
  members: Decision[];
};

export type MarketWatchNotice = {
  kind: 'market_watch_notice'; deliveryKey: string; text: string; notBefore?: string;
};

const decisionPriority = ['suppress', 'verify', 'record', 'summary', 'immediate'] as const;
const intentKey = (watchId: string, eventKey: string, revision: string) => key('watch-notice', watchId, eventKey, revision);
const operationKeyFor = (watchId: string, runId: string) => key('watch-check', watchId, runId);
const asState = (state: WatchState, item: PlannedItem) =>
  Object.hasOwn(state.items, item.id) && state.items[item.id].baselineKey === item.baselineKey ? state.items[item.id] : undefined;

// phase policies cannot override a source's minimum interval
function cadence(item: PlannedItem, phase?: MarketPhase) {
  const override = phase && Object.hasOwn(item.phases ?? {}, phase.key) ? item.phases![phase.key] : undefined;
  if (override === 'stop') return override;
  return Math.max(override ?? item.intervalSeconds, item.minSourceIntervalSeconds);
}

function dueAt(plan: WatchPlan, item: PlannedItem, state: WatchState, now: string) {
  const interval = cadence(item, state.phases[item.marketId]);
  if (interval === 'stop' || item.support === 'blocked') return undefined;
  const seen = asState(state, item);
  const next = seen ? epoch(seen.checkedAt) + interval * 1000 : epoch(now);
  const until = item.until ?? plan.expiresAt;
  return epoch(now) < epoch(until) && next < epoch(until) ? iso(next) : undefined;
}

function windowProblem(window: Window | undefined, metric: Metric, end?: string) {
  if (!window?.complete || !(epoch(window.from) < epoch(window.to)) ||
      (end !== undefined && epoch(window.to) !== epoch(end)) ||
      (metric.windowSeconds && epoch(window.to) - epoch(window.from) !== metric.windowSeconds * 1000)) {
    return '所需窗口覆盖不足';
  }
  if (metric.kind === 'trades' && !window.deduplicated) return '缺少成交身份去重凭据';
  if (metric.minSamples && !(Number.isSafeInteger(window.samples) && window.samples! >= metric.minSamples)) {
    return '窗口样本不足';
  }
}

export function watchSourceExpired(observedAt: string, checkedAt: string, maxAgeSeconds?: number) {
  return Boolean(maxAgeSeconds && epoch(checkedAt) - epoch(observedAt) > maxAgeSeconds * 1000);
}

function observationProblem(item: PlannedItem, obs: WatchObservation, now: string) {
  if (obs.scope !== item.scope || !nonempty(obs.id) || !nonempty(obs.evidence.evidenceId) ||
      !nonempty(obs.evidence.source) || !(epoch(obs.observedAt) <= epoch(obs.evidence.retrievedAt)) ||
      !(epoch(obs.evidence.retrievedAt) <= epoch(now))) return '缺少适用的证据身份、真实源时间或取得时间';
  if (watchSourceExpired(obs.observedAt, now, item.maxAgeSeconds)) return '来源已过期';
  if (obs.phase && (!item.trackPhase || !nonempty(obs.phase.key) ||
      (obs.phase.eventAt !== undefined && !Number.isFinite(epoch(obs.phase.eventAt))))) return '阶段缺少有效来源时间或范围';
  const measure = obs.measurement;
  if (item.metric) {
    if (!measure || measure.marketId !== item.marketId || measure.tokenId !== item.tokenId ||
        !isDeepStrictEqual(item.metric, measure.metric) || !Number.isFinite(measure.value) ||
        (item.metric.unit === 'fraction' && item.metric.kind === 'quote' && (measure.value < 0 || measure.value > 1))) {
      return '缺少同选项、口径和单位的有效指标';
    }
    if (item.metric.windowSeconds || item.metric.minSamples) return windowProblem(measure.window, item.metric, obs.observedAt);
  }
}

// Compare the decimal operands as reported by the source, including at inclusive boundaries.
function scaled(numbers: number[]) {
  const parts = numbers.map(n => {
    const [mantissa, exponent = '0'] = n.toString().split('e');
    const places = mantissa.split('.')[1]?.length ?? 0;
    return { digits: BigInt(mantissa.replace('.', '')), power: Number(exponent) - places };
  });
  const power = Math.min(0, ...parts.map(part => part.power));
  return { values: parts.map(part => part.digits * 10n ** BigInt(part.power - power)), one: 10n ** BigInt(-power) };
}
function matches(mode: Comparison, value: number, base: number, threshold: Threshold) {
  const { values: [v, b, limit], one } = scaled([value, base, threshold.value]);
  let left = v;
  let right = limit;
  if (mode === 'delta') left = v - b;
  if (mode === 'percentage_points') left = (v - b) * 100n;
  if (mode === 'relative_percent') {
    left = (v - b) * 100n * one;
    right = limit * b;
  }
  switch (threshold.op) {
    case 'gte': return left >= right;
    case 'gt': return left > right;
    case 'lte': return left <= right;
    case 'lt': return left < right;
  }
}

function compareCondition(item: PlannedItem, obs: WatchObservation, state: ItemState, now: string) {
  const trigger = item.trigger!;
  const measure = obs.measurement!;
  const previous = state.last?.measurement;
  const ref = measure.reference;
  const base = trigger.comparison === 'level' ? 0 : trigger.baseline === 'previous' ? previous?.value : ref?.value;
  const refProblem = trigger.comparison !== 'level' && trigger.baseline === 'reference' &&
    (!ref || !ref.evidenceIds.length || !(epoch(ref.window.to) <= epoch(measure.window?.from ?? obs.observedAt)) ||
      windowProblem(ref.window, measure.metric));
  const condition = state.condition;
  if (base === undefined || !Number.isFinite(base) || refProblem ||
      (trigger.comparison === 'relative_percent' && base <= 0)) {
    condition.count = 0;
    condition.since = undefined;
    return { status: 'warming_up' as const, reason: '缺少可比基线、基线样本不足或相对变化基线非正数' };
  }
  const meets = (part: Threshold) => matches(trigger.comparison, measure.value, base, part);
  const hit = meets(trigger.enter);
  const exit = trigger.exit ? meets(trigger.exit) : !hit;
  const wasBaseline = !state.last;
  const advanced = { current: measure.value, base, metric: measure.metric, comparison: trigger.comparison,
    enter: trigger.enter, count: 0, status: 'not_met' as 'not_met' | 'observing' | 'met' | 'warming_up',
    reason: undefined as string | undefined, finding: undefined as Finding | undefined, cooldown: false };
  if (exit) {
    condition.entered = false;
    condition.escalated = false;
  }
  if (!hit || exit) {
    condition.count = 0;
    condition.since = undefined;
    return advanced;
  }
  condition.since ??= obs.observedAt;
  advanced.count = ++condition.count;
  const qualified = condition.count >= (trigger.consecutive ?? 1) &&
    epoch(obs.observedAt) - epoch(condition.since) >= (trigger.holdSeconds ?? 0) * 1000;
  advanced.status = qualified || condition.entered ? 'met' : 'observing';
  if (!qualified) return advanced;
  const escalation = condition.entered && !condition.escalated && trigger.escalate && meets(trigger.escalate);
  if (condition.entered && !escalation) return advanced;
  const initial = wasBaseline && !condition.entered;
  condition.entered = true;
  condition.escalated = Boolean(trigger.escalate && meets(trigger.escalate));
  if (initial && !trigger.notifyOnInitial) return advanced;
  advanced.cooldown = condition.lastAlertAt !== undefined &&
    epoch(now) - epoch(condition.lastAlertAt) < (trigger.cooldownSeconds ?? 0) * 1000;
  advanced.finding = { eventKey: key('threshold', item.marketId, item.tokenId, item.sourceId, item.scope, item.metric, item.trigger),
    revision: key(obs.id, obs.observedAt, escalation ? 'escalated' : initial ? 'initial' : 'entered'),
    kind: 'changed', description: escalation ? '已达标条件加重' : initial ? '初始状态已满足' : '交易指标触发阈值',
    confidence: 'confirmed', importance: escalation ? 'high' : 'normal',
    before: trigger.comparison === 'level' ? previous?.value : base, after: measure.value,
    unknowns: ['原因未核实'] };
  return advanced;
}

function decide(plan: WatchPlan, item: PlannedItem, finding: Finding, now: string, quality: boolean) {
  const policy = { ...plan.notify, ...item.notify };
  let action: Decision['action'] = quality ? policy.quality ?? 'record' : policy.mode;
  let actionReason = '按监控项通知约定';
  if (!quality && finding.confidence === 'conflicting') {
    action = 'verify';
    actionReason = '来源冲突，继续核实';
  } else if (action !== 'record' && finding.confidence === 'unconfirmed') {
    action = policy.unconfirmed ?? 'verify';
    actionReason = '线索尚未确认';
  }
  if (policy.mode === 'summary' && action === 'immediate' && !quality) action = 'summary';
  if (finding.importance === 'low' && (action === 'immediate' || action === 'summary') && policy.low) {
    action = policy.low;
    actionReason = '按低重要性变化约定处理';
  }
  // Quiet periods are resolved by the host from the user's time-zone preference.
  let end = epoch(now);
  for (const period of [...(plan.quiet ?? [])].sort((a, b) => epoch(a.from) - epoch(b.from))) {
    if (epoch(period.from) <= end && epoch(period.until) > end) end = epoch(period.until);
  }
  if (end > epoch(now) && (action === 'immediate' || action === 'summary') &&
      !(finding.importance === 'high' && policy.highDuringQuiet)) {
    return { action: 'summary' as const, actionReason: '免打扰期间延期', notBefore: iso(end) };
  }
  return { action, actionReason };
}

function initialItemState(item: PlannedItem, now: string): ItemState {
  return { baselineKey: item.baselineKey, firstCheckedAt: now, checkedAt: now,
    condition: { count: 0, entered: false, escalated: false }, events: {}, gaps: [] };
}

function currentPhases(plan: WatchPlan, state: WatchState) {
  return Object.fromEntries(Object.entries(state.phases).filter(([, phase]) =>
    plan.items.some(item => item.id === phase.itemId && item.baselineKey === phase.baselineKey && item.support !== 'blocked')));
}

export function evaluateWatchCheck(input: {
  plan: WatchPlan; state: WatchState; runId: string; startedAt: string; now: string;
  reads: ReadonlyMap<string, WatchRead>;
}) {
  const { plan, state, runId, startedAt, now, reads } = input;
  if (!nonempty(runId) || !(epoch(startedAt) <= epoch(now)) || !(epoch(now) < epoch(plan.expiresAt)) ||
      (state.checkedAt && epoch(startedAt) < epoch(state.checkedAt))) throw new Error('检查运行、版本顺序或有效期无效。');
  const operationKey = operationKeyFor(plan.watchId, runId);
  if (state.lastOperationKey === operationKey) throw new Error('运行已提交，请读取宿主提交回执。');
  const initialPhases = currentPhases(plan, state);
  const previousState = { ...state, phases: initialPhases };
  const nextState: WatchState = { version: state.version + 1, checkedAt: now, lastOperationKey: operationKey,
    items: Object.create(null) as WatchState['items'], phases: { ...initialPhases } };
  const intents = new Map<string, WatchIntent>();
  const phaseChanges: { marketId: number; before?: MarketPhase; after: MarketPhase }[] = [];
  const checks = plan.items.map(item => {
    const saved = asState(state, item);
    const cadenceBefore = cadence(item, initialPhases[item.marketId]);
    if (saved) nextState.items[item.id] = saved;
    const due = dueAt(plan, item, previousState, startedAt);
    const end = epoch(item.until ?? plan.expiresAt);
    const scope = { itemId: item.id, marketId: item.marketId, sourceId: item.sourceId,
      intervalSeconds: cadenceBefore, dueAt: due, evidenceIds: [] as string[],
      support: item.support, issues: item.issues, baselineReset: Object.hasOwn(state.items, item.id) && !saved };
    if (item.support === 'blocked') return { ...scope, status: 'blocked' as const };
    if (cadenceBefore === 'stop' || !due || epoch(now) >= end) return { ...scope, status: 'ended' as const };
    if (epoch(due) > epoch(startedAt)) return { ...scope, status: 'not_due' as const };

    const itemState = saved ? structuredClone(saved) : initialItemState(item, now);
    nextState.items[item.id] = itemState;
    if (saved && epoch(startedAt) - epoch(due) >= cadenceBefore * 1000) {
      itemState.condition.count = 0;
      itemState.condition.since = undefined;
      if (!itemState.gaps.some(gap => !gap.to)) itemState.gaps.push({ from: due, to: startedAt, operationKey,
        issue: { status: 'partial', reason: '计划检查间隔有未覆盖区间' } });
    }
    itemState.checkedAt = now;
    const read = reads.get(item.id);
    const observed = read?.observations ?? [];
    const evidenceIds = unique([...(read?.issue?.evidenceIds ?? []), ...(read?.review ? [read.review.evidence.evidenceId] : []),
      ...observed.flatMap(obs => [obs.evidence.evidenceId, ...(obs.inputEvidenceIds ?? []),
        ...(obs.measurement?.reference?.evidenceIds ?? [])])]);
    const conditions: ReturnType<typeof compareCondition>[] = [];
    const ignored: { observationId: string; reason: string; observedAt: string; factAt?: string; evidence: EvidenceRef }[] = [];
    function record(finding: Finding, obs?: WatchObservation, issue?: Issue, forcedReason?: string) {
      const eventId = key(finding.eventKey);
      const event = itemState.events[eventId];
      if (event?.revisions.includes(finding.revision)) return;
      const operationKey = intentKey(plan.watchId, finding.eventKey, finding.revision);
      const current = decide(plan, item, finding, now, Boolean(issue) || item.kind === 'quality');
      const delivery = forcedReason ? { action: 'suppress' as const, actionReason: forcedReason } : current;
      const member: Decision = { ...finding, ...delivery, itemId: item.id, marketId: item.marketId,
        tokenId: item.tokenId, sourceId: item.sourceId, reason: item.reason, recordRefs: item.recordRefs, rule: item.rule,
        evidenceIds: unique([...(obs ? [obs.evidence.evidenceId, ...(obs.inputEvidenceIds ?? []),
          ...(obs.measurement?.reference?.evidenceIds ?? [])] : []), ...(issue?.evidenceIds ?? [])]),
        evidence: obs && evidenceRef(obs.evidence), observedAt: obs?.observedAt, factAt: obs?.factAt, previous: itemState.last,
        relatedOperationKey: event && intentKey(plan.watchId, finding.eventKey, event.latest) };
      const group = intents.get(operationKey);
      if (group) {
        group.members.push(member);
        if (decisionPriority.indexOf(member.action) > decisionPriority.indexOf(group.action)) group.action = member.action;
      } else {
        intents.set(operationKey, { operationKey, eventKey: member.eventKey, revision: member.revision,
          action: member.action, members: [member] });
      }
      // Initial observations are remembered for deduplication. Historical additions after startup
      // are kept in the check receipt without advancing that event's latest revision.
      if (!forcedReason || !itemState.last || forcedReason === '冷却期内') {
        itemState.events[eventId] = { latest: forcedReason && event ? event.latest : finding.revision,
          revisions: [...(event?.revisions ?? []), finding.revision] };
      }
      return delivery.action;
    }

    const qualityKey = key('coverage', item.marketId, item.sourceId, item.scope);
    function cover(issue: Issue) {
      itemState.condition.count = 0;
      itemState.condition.since = undefined;
      if (itemState.gaps.at(-1)?.to === undefined && itemState.gaps.length) return;
      const gap: Gap = { from: now, issue, operationKey };
      itemState.gaps.push(gap);
      record({ eventKey: qualityKey, revision: key('gap', operationKey), kind: 'changed',
        description: issue.reason, importance: 'normal', confidence: 'confirmed',
        unknowns: ['来源缺口期间的变化待补查'] }, undefined, issue);
    }
    let valid = 0;
    let advanced = 0;
    let issue = read?.issue;
    const sourceOrder = [...observed].sort((a, b) => orderAt(a.observedAt, b.observedAt));
    // A start-up read may include a history page. Seed a numeric condition from its latest snapshot.
    const ordered = !saved && item.trigger ? sourceOrder.slice(-1) : sourceOrder;
    if (!issue && !ordered.length) issue = { status: 'failed', reason: '未取得本轮观察或实际错误凭据' };
    if (issue) {
      cover(issue);
      const review = read?.review;
      if (review && review.finding.confidence === 'conflicting' && review.evidence.evidenceId &&
          epoch(review.observedAt) <= epoch(review.evidence.retrievedAt) && epoch(review.evidence.retrievedAt) <= epoch(now)) {
        record(review.finding, { id: review.finding.revision, scope: item.scope, observedAt: review.observedAt,
          evidence: review.evidence, inputEvidenceIds: evidenceIds });
      }
    } else for (const obs of ordered) {
      const problem = observationProblem(item, obs, now);
      const last = itemState.last;
      if (problem) {
        issue = { status: problem === '来源已过期' ? 'stale' : 'partial', reason: problem,
          evidenceIds: [obs.evidence.evidenceId] };
        cover(issue);
        ignored.push({ observationId: obs.id, reason: problem, observedAt: obs.observedAt, factAt: obs.factAt,
          evidence: evidenceRef(obs.evidence) });
        continue;
      }
      if (last && (obs.id === last.id || orderAt(obs.observedAt, last.observedAt) <= 0)) {
        const reason = obs.id === last.id ? '重复观察' : '乱序或同源时间观察，仅保留历史证据';
        ignored.push({ observationId: obs.id, reason, observedAt: obs.observedAt, factAt: obs.factAt, evidence: evidenceRef(obs.evidence) });
        if (orderAt(obs.observedAt, last.observedAt) === 0 && isDeepStrictEqual(obs.value, last.value) &&
            isDeepStrictEqual(obs.measurement, last.measurement)) {
          if (obs.id === last.id) valid++;
          if (obs.evidence.evidenceId !== last.evidence.evidenceId) {
            for (const finding of obs.findings ?? []) {
              if (finding.kind === 'confirmed' && itemState.events[key(finding.eventKey)] && record(finding, obs)) {
                itemState.last = effectiveObservation(obs);
                valid++;
              }
            }
          }
        }
        continue;
      }

      const gap = itemState.gaps.at(-1);
      const openGap = gap && !gap.to;
      const freshAfterGap = openGap && (gap.issue.sourceThrough && obs.measurement?.window?.complete
        ? orderAt(obs.observedAt, gap.issue.sourceThrough) >= 0 : orderAt(obs.observedAt, gap.from) > 0);
      if (openGap && !freshAfterGap && last) {
        ignored.push({ observationId: obs.id, reason: '缺口开始前的来源记录仅作历史补充',
          observedAt: obs.observedAt, factAt: obs.factAt, evidence: evidenceRef(obs.evidence) });
        continue;
      }
      if (freshAfterGap) {
        gap.to = now;
        record({ eventKey: qualityKey, revision: key('recovered', gap.operationKey), kind: 'changed',
          description: '来源已取得新的有效观察', confidence: 'confirmed', importance: 'normal',
          before: gap.from, after: obs.observedAt, unknowns: ['中断区间仍未证明已补齐'] }, obs, gap.issue);
      }
      const findings = [...(obs.findings ?? [])];
      if (last?.ruleCondition && obs.ruleCondition && obs.ruleCondition.status !== last.ruleCondition.status) {
        findings.push({ eventKey: key('rule-condition', item.marketId, item.clauseId, item.scope),
          revision: key(obs.id, obs.ruleCondition.status), kind: 'changed',
          description: '规则条件核对状态变化', confidence: 'confirmed', importance: 'normal',
          before: last.ruleCondition, after: obs.ruleCondition, unknowns: ['市场最终结算仍需独立核对'] });
      }
      for (const finding of findings) {
        const preexisting = !saved || (epoch(obs.observedAt) <= epoch(itemState.firstCheckedAt) &&
          (!last || (finding.kind === 'added' && !itemState.events[key(finding.eventKey)])));
        record(finding, obs, undefined, preexisting ? '初始或历史事实仅建基线' : undefined);
      }
      if (item.trigger && (!openGap || freshAfterGap)) {
        const condition = compareCondition(item, obs, itemState, now);
        conditions.push(condition);
        if ('finding' in condition && condition.finding) {
          const action = record(condition.finding, obs, undefined, condition.cooldown ? '冷却期内' : undefined);
          if (action === 'immediate' || action === 'summary') itemState.condition.lastAlertAt = now;
        }
      }
      const before = nextState.phases[item.marketId];
      if (obs.phase && (!before || orderAt(obs.observedAt, before.at) > 0)) {
        const eventAt = obs.phase.eventAt ?? (before?.key === obs.phase.key ? before.eventAt : undefined);
        const evidence = evidenceRef(obs.evidence);
        const after: MarketPhase = { ...obs.phase, eventAt, at: obs.observedAt, evidence,
          eventEvidence: obs.phase.eventAt ? evidence : eventAt ? before?.eventEvidence ?? before?.evidence : undefined,
          itemId: item.id, baselineKey: item.baselineKey };
        nextState.phases[item.marketId] = after;
        const rescheduled = before?.eventAt && eventAt ? orderAt(before.eventAt, eventAt) !== 0 : before?.eventAt !== eventAt;
        if (!before || before.key !== after.key || rescheduled) phaseChanges.push({ marketId: item.marketId, before, after });
      }

      itemState.last = effectiveObservation(obs);
      valid++;
      advanced++;
    }

    if (!valid && !issue) {
      issue = { status: 'partial', reason: '未得到可推进或核对当前基线的观察', evidenceIds };
      cover(issue);
    }
    const gapOpen = itemState.gaps.some(gap => !gap.to);
    const warmingUp = conditions.at(-1)?.status === 'warming_up';
    return { ...scope, evidenceIds, conditions, issue, ignored, advanced,
      status: issue || gapOpen || warmingUp ? 'partial' as const : 'covered' as const };
  });
  // Each item is admitted against the schedule at the start of the check. Phase
  // transitions affect subsequent checks, never retroactively authorize a read.
  const nextDueAt = plan.items.flatMap(item => dueAt(plan, item, nextState, now) ?? []).sort()[0];
  const coverage = checks.some(check => check.status === 'partial' || check.status === 'blocked')
    ? checks.some(check => check.status === 'covered' || ('advanced' in check &&
        (check.advanced > 0 || check.sourceId === weatherSource && check.issue?.status === 'pending')))
      ? 'partial' as const : 'failed' as const
    : checks.some(check => check.status === 'covered') ? 'complete' as const : 'idle' as const;
  return { watchId: plan.watchId, configVersion: plan.configVersion, expectedStateVersion: state.version,
    runId, operationKey, startedAt, checkedAt: now, nextState, checks, intents: [...intents.values()],
    coverage, phaseChanges, nextDueAt, scheduleStatus: 'host_required' as const };
}

export type WatchCheck = ReturnType<typeof evaluateWatchCheck>;
type CheckRequest = { watchId: string; runId: string; configVersion: number };
type HostReceipt = {
  status: 'committed' | 'already_committed'; operationKey: string;
  stateVersion: number; committedAt: string;
  deliveries?: { operationKey: string; status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
    enqueuedAt?: string; sentAt?: string; messageIds?: string[] }[];
};
export type RuntimeWatch = { plan: WatchPlan; state: WatchState;
  status: 'active' | 'paused' | 'cancelled' | 'expired' | 'budget_exhausted' | 'ended';
  nextScheduleAt?: string; receipt?: HostReceipt; budgetReason?: string };
export function describeWatchState(runtime: RuntimeWatch, now: string) {
  const { plan, state, status, budgetReason, nextScheduleAt, receipt } = runtime;
  const phases = currentPhases(plan, state);
  return { watchId: plan.watchId, configVersion: plan.configVersion, stateVersion: state.version,
    status, budgetReason, nextScheduleAt, expiresAt: plan.expiresAt, checkedAt: state.checkedAt, phases, receipt,
    items: plan.items.map(item => ({ itemId: item.id, marketId: item.marketId, tokenId: item.tokenId,
      support: item.support, issues: item.issues, sourceId: item.sourceId, intervalSeconds: cadence(item, phases[item.marketId]),
      nextDueAt: status === 'active' && !budgetReason ? dueAt(plan, item, { ...state, phases }, now) : undefined,
      last: asState(state, item)?.last, condition: asState(state, item)?.condition, gaps: asState(state, item)?.gaps ?? [] })) };
}

export type WatchHost = {
  now(): string;
  load(request: CheckRequest & { operationKey: string }, signal: AbortSignal): Awaitable<RuntimeWatch | undefined>;
  read(item: PlannedItem, context: { request: CheckRequest; plan: WatchPlan; previous?: ItemState; startedAt: string },
    signal: AbortSignal): Awaitable<WatchRead>;
  // In one host transaction: look up this operation key, fence status, expiry,
  // configVersion and expectedStateVersion, then store check + state + intents.
  commit(check: WatchCheck, signal: AbortSignal): Awaitable<HostReceipt | { status: 'rejected'; reason: string }>;
};

export async function runWatchCheck(request: CheckRequest, host: WatchHost, signal: AbortSignal) {
  signal.throwIfAborted();
  const operationKey = operationKeyFor(request.watchId, request.runId);
  const runtime = await host.load({ ...request, operationKey }, signal);
  signal.throwIfAborted();
  if (runtime?.receipt?.operationKey === operationKey) return { status: 'already_committed' as const, receipt: runtime.receipt };
  const startedAt = host.now();
  if (!runtime || !nonempty(request.runId) || runtime.plan.watchId !== request.watchId ||
      runtime.plan.configVersion !== request.configVersion || runtime.status !== 'active' ||
      runtime.budgetReason || !(epoch(startedAt) < epoch(runtime.plan.expiresAt))) {
    return { status: 'rejected' as const, reason: runtime?.budgetReason ?? '任务状态、检查版本或有效期不允许执行' };
  }
  const { plan, state } = runtime;
  const admitted = { ...state, phases: currentPhases(plan, state) };
  const reads = new Map<string, WatchRead>();
  let readsLeft = plan.budget.maxToolCalls;
  for (const item of plan.items) {
    signal.throwIfAborted();
    const due = dueAt(plan, item, admitted, startedAt);
    if (!due || epoch(due) > epoch(startedAt)) continue;
    if (!(epoch(host.now()) < epoch(plan.expiresAt))) return { status: 'rejected' as const, reason: '检查期间任务到期' };
    if (readsLeft-- <= 0) {
      reads.set(item.id, { issue: { status: 'budget', reason: '本轮来源读取预算已用尽' } });
      continue;
    }
    try {
      reads.set(item.id, await host.read(item, { request, plan, previous: asState(state, item), startedAt }, signal));
    } catch (error) {
      signal.throwIfAborted();
      reads.set(item.id, { issue: { status: 'failed', reason: error instanceof Error ? error.message : String(error) } });
    }
  }
  signal.throwIfAborted();
  const now = host.now();
  if (!(epoch(now) < epoch(plan.expiresAt))) return { status: 'rejected' as const, reason: '检查期间任务到期' };
  const check = evaluateWatchCheck({ plan, state, runId: request.runId, startedAt, now, reads });
  const receipt = await host.commit(check, signal);
  if (receipt.status === 'rejected') return receipt;
  if (receipt.operationKey !== operationKey) throw new Error('宿主提交回执与检查操作键不匹配。');
  if (receipt.status === 'already_committed') return { status: receipt.status, receipt };
  return { status: receipt.status, check, receipt, nextScheduleAt: runtime.nextScheduleAt };
}

/** Use the E result and its previous effective version, loaded from the evidence store. */
export function readWatchSourceEvidence(input: {
  item: WatchItemRequest; current: SavedNormalizedEvidence; previous?: SavedNormalizedEvidence;
  sourceTimeKey: string; factKey?: string; eventTimeKey?: string;
  eventKey?: string; importance: Importance; confidence: Confidence;
}): WatchRead {
  const { item, current, previous } = input;
  const { quality, scope, sourceRef, version, times } = current.data;
  const evidenceIds = unique([current.evidenceId, ...current.data.inputEvidenceIds]);
  const unavailable = (status: Issue['status'], reason: string): WatchRead => ({ issue: { status, reason, evidenceIds } });
  const possibleWithdrawal = quality.status === 'partial' && version.official?.kind === 'withdrawn' &&
    ['body', 'document'].includes(quality.coverage) && !quality.captureGaps?.length &&
    (!scope.market || sourceRef.requirement.status === 'matched');
  if ((quality.status !== 'ok' && !possibleWithdrawal) || quality.match !== 'matched' || quality.truncated ||
      quality.freshness === 'stale' || quality.historical?.availability === 'unknown') {
    const status = quality.status === 'failed' || quality.status === 'pending' || quality.status === 'unsupported'
      ? quality.status : quality.freshness === 'stale' ? 'stale' : 'partial';
    return unavailable(status, quality.failure?.reason ?? quality.unsupported ??
      (quality.issues.join('；') || '来源正文、对象、质量或时效尚未满足'));
  }
  if (scope.market && scope.market.id !== `local:${item.marketId}`) return unavailable('partial', '规范化证据的市场身份不同');
  const time = times.find(t => t.key === input.sourceTimeKey && t.kind !== 'expected');
  if (!time?.time.utc) return unavailable('partial', '缺少可排序的实际源时间');
  const fact = current.data.facts.find(f => f.key === input.factKey && f.checked);
  const diff = compareSourceEvidence(previous, current).data;
  const originalConfirms = input.confidence === 'confirmed' && previous &&
    previous.data.sourceRef.role === 'republication' && sourceRef.role === 'primary' &&
    [sourceRef.recordKey, current.source].includes(previous.data.sourceRef.commonSource?.key ?? '') &&
    fact && isDeepStrictEqual(
      previous.data.facts.find(f => f.checked && f.key === fact.key)?.value, fact.value);
  if (diff.status === 'incomparable' && !originalConfirms) {
    const result = unavailable('partial', diff.reasons.join('；') || '来源版本无法比较');
    result.issue!.evidenceIds = unique([...evidenceIds, ...diff.inputEvidenceIds]);
    const conflict = diff.conflicts.find(change => change.key === input.factKey);
    if (conflict) result.review = { evidence: evidenceRef(current), observedAt: time.time.utc, finding: {
      eventKey: input.eventKey ?? key('fact-conflict', item.marketId, scope.object, scope.validTime, input.factKey),
      revision: key(diff.before?.contentId, diff.after?.contentId, conflict.key), kind: 'conflict',
      description: '对齐口径的来源事实出现冲突', confidence: 'conflicting', importance: input.importance,
      before: conflict.before, after: conflict.after, verify: diff.reasons,
    } };
    return result;
  }
  const diffEntry = diff.changes.find(change => change.kind !== 'availability' &&
    change.key === (input.factKey ?? input.eventTimeKey ?? input.sourceTimeKey));
  const official = diff.changes.find(change => change.kind === 'official_version');
  if (input.factKey && !fact && official?.key !== 'withdrawn') return unavailable('partial', '缺少要求的已核对事实');
  const origin = sourceRef.commonSource?.key ?? sourceRef.recordKey;
  const sourceVersion = version.official?.id?.raw?.toString() ?? version.contentId;
  const eventKey = input.eventKey ?? key('source-fact', origin, scope.object, scope.validTime, input.factKey ?? input.eventTimeKey);
  const factAt = times.find(t => t.key === input.eventTimeKey && t.kind !== 'expected')?.time.utc;
  const expected = times.find(t => t.key === input.eventTimeKey && t.kind === 'expected')?.time.utc;
  const findings: Finding[] = [];
  if (official || diffEntry || (diff.status === 'baseline' && (fact || expected))) {
    const kind = official?.key === 'withdrawn' ? 'withdrawn' : official?.key === 'revised' ? 'revised'
      : diff.status === 'baseline' ? 'added' : 'changed';
    const description = official ? (kind === 'withdrawn' ? '来源撤回已发布版本' : '来源发布修订版本')
      : diffEntry?.kind === 'schedule' ? '来源更新事件安排' : fact?.name ?? '取得带引用的来源更新';
    findings.push({ eventKey, revision: key(version.official?.id?.raw, fact?.value ?? expected, factAt ?? time.time.utc, kind),
      kind, description, importance: input.importance, confidence: input.confidence,
      before: diffEntry?.before ?? official?.before, after: diffEntry?.after ?? official?.after ?? fact ?? expected,
      unknowns: current.data.limitations });
  }
  if (originalConfirms && !findings.length) {
    findings.push({ eventKey, revision: key('confirmed', sourceVersion), kind: 'confirmed',
      description: '已取得确认此事实的原始来源', importance: input.importance, confidence: input.confidence, after: fact });
  }
  return { observations: [{
    id: key(origin, item.scope, time.time.utc, version.official?.id?.raw),
    scope: item.scope, observedAt: time.time.utc, factAt, evidence: {
      evidenceId: current.evidenceId, source: current.source, retrievedAt: current.retrievedAt,
    }, inputEvidenceIds: evidenceIds, sourceVersion, value: fact?.value, findings,
  }] };
}

/** Attach B's version comparison and clause state to a source-timed observation. */
export function readWatchRuleEvidence(input: {
  item: WatchItemRequest; current: RuleCard; previous?: RuleCard;
  assessment?: ReturnType<typeof assessRuleEvidence>; observation: WatchObservation;
}): WatchRead {
  const { item, current, previous, assessment, observation } = input;
  const evidenceIds = unique([observation.evidence.evidenceId, ...(observation.inputEvidenceIds ?? []),
    ...current.inputEvidenceIds, ...(previous?.inputEvidenceIds ?? []), ...(assessment?.inputEvidenceIds ?? [])]);
  const missing = (reason: string): WatchRead => ({ issue: { status: 'partial', reason, evidenceIds } });
  if (current.market.localMarketId !== item.marketId || current.rules.incomplete ||
      (item.clauseId && !current.clauses.some(clause => clause.id === item.clauseId))) {
    return missing('规则版本、市场身份或监控条款覆盖不足');
  }
  if (assessment && (assessment.ruleCard.market.localMarketId !== item.marketId ||
      assessment.ruleCard.rulesEvidenceId !== current.rules.evidenceId ||
      assessment.ruleCard.interpretationRevision !== current.interpretationRevision)) {
    return missing('规则核对与本次规则版本不一致');
  }
  const condition = assessment?.conditions.find(condition => condition.clauseId === item.clauseId);
  const findings = [...(observation.findings ?? [])];
  if (previous) {
    const diff = compareRuleVersions(previous, current);
    if (diff.rawChange === 'coverage_unknown') return missing('无法对照两个规则版本的来源覆盖');
    if (diff.rawChange === 'observed_content_change' &&
        (!item.clauseId || diff.reviewClauseIds.includes(item.clauseId) || diff.reviewUnmappedChanges)) {
      findings.push({ eventKey: key('rule', item.marketId), revision: key(previous.rules.contentId, current.rules.contentId,
        observation.sourceVersion ?? observation.observedAt),
      kind: 'changed', description: '已观察到规则内容变化，适用影响待核对', confidence: 'confirmed', importance: 'high',
      before: diff.before, after: diff.after, unknowns: current.unknowns, verify: diff.reviewClauseIds });
    }
  }
  if (item.kind === 'fact' && item.clauseId && !condition) return missing('缺少本条规则条件的事实核对');
  if (condition && !['met', 'not_met', 'not_applicable'].includes(condition.status)) {
    return missing(`${condition.status}: ${condition.missing.join('；') || '规则条件证据不足或相互冲突'}`);
  }
  return { observations: [{ ...observation, inputEvidenceIds: evidenceIds, findings,
    value: condition?.status ?? observation.value,
    ruleCondition: condition && { clauseId: item.clauseId!, status: condition.status, missing: condition.missing } }] };
}

const string = { type: 'string' } as const;
const integer = { type: 'integer' } as const;
const number = { type: 'number' } as const;
const boolean = { type: 'boolean' } as const;
const object = <const P extends ParameterSchemaSpec>(properties: P) =>
  ({ type: 'object', additionalProperties: false, properties } as const);
const array = <const S extends ValueSchemaSpec>(items: S) => ({ type: 'array', items } as const);
const required = <const S extends ValueSchemaSpec>(schema: S) => ({ ...schema, required: true as const });
const choice = <const T extends readonly string[]>(values: T) => ({ ...string, enum: values } as const);
const modes = ['immediate', 'summary', 'record'] as const;
const notificationSchema = object({
  mode: required(choice(modes)), unconfirmed: choice(['verify', ...modes]), low: choice(['summary', 'record']),
  quality: choice(modes), highDuringQuiet: boolean,
});
const metricFields = { key: required(string), unit: required(string), windowSeconds: integer, minSamples: integer };
const metricSchema = { oneOf: [
  object({ ...metricFields, kind: required(choice(['quote', 'spread'])), priceType: required(string) }),
  object({ ...metricFields, kind: required(choice(['trades'])), windowSeconds: required(integer),
    measure: required(choice(['amount', 'shares', 'count'])), currency: string }),
  object({ ...metricFields, kind: required(choice(['depth'])), side: required(choice(['bid', 'ask'])), range: required(string) }),
] } as const;
const thresholdSchema = object({ op: required(choice(['gte', 'gt', 'lte', 'lt'])), value: required(number) });
const proposalSchema = {
  goal: required(string), expiresAt: required(string),
  budget: required(object({ maxRuns: required(integer), maxModelCalls: required(integer), maxToolCalls: required(integer) })),
  notify: required(notificationSchema), quiet: array(object({ from: required(string), until: required(string) })),
  items: required(array(object({
    id: required(string), kind: required(choice(['trading', 'fact', 'factor', 'lifecycle', 'quality'])),
    marketId: required(integer), tokenId: string, sourceId: required(string), scope: required(string),
    reason: required(string), intervalSeconds: required(integer), maxAgeSeconds: integer, until: string,
    clauseId: string, ruleRequired: boolean,
    external: object({ normalizedEvidenceId: required(string), factKey: required(string), sourceTimeKey: required(string),
      ruleAssessmentEvidenceId: string }),
    weather: object({ contractEvidenceId: required(string), conditions: required(array(choice(weatherConditions))),
      ruleVersion: string }),
    recordRefs: array(object({ id: required(string), version: required(integer) })),
    metric: metricSchema,
    tradeWindowEndAt: string, tradeProjectionEvidenceId: string,
    trigger: object({
      comparison: required(choice(['level', 'delta', 'relative_percent', 'percentage_points'])),
      enter: required(thresholdSchema), exit: thresholdSchema, escalate: thresholdSchema,
      baseline: choice(['previous', 'reference']), consecutive: integer, holdSeconds: number,
      cooldownSeconds: number, notifyOnInitial: boolean,
    }),
    notify: notificationSchema, trackPhase: boolean,
    phases: { type: 'object', additionalProperties: true, description: '来源阶段名到检查秒数或 stop 的映射。' },
  }))),
} as const satisfies ParameterSchemaSpec;

const watchOutput = { schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

export function createWatchTools(host: WatchHost & {
  authorizeProposal(proposal: unknown, sessionId: string, signal: AbortSignal):
    Awaitable<{ request: WatchPlanRequest; context: WatchPlanContext }>;
  activeCheck(sessionId: string, signal: AbortSignal): Awaitable<CheckRequest | undefined>;
  saveDraft?(plan: WatchPlan, sessionId: string): Awaitable<string>;
}) {
  return [
    defineTool({
      name: 'prepare_market_watch',
      description: '核对通用市场盯盘草案的身份、来源范围、周期与预算。返回草案与覆盖缺口，不创建或启动任务。',
      parameters: proposalSchema, output: watchOutput,
      async execute(proposal, exec) {
        const sessionId = exec.agent?.session.id ?? (host.saveDraft ? 'local-control' : undefined);
        if (!sessionId) throw new Error('需要用户会话。');
        const { request, context } = await host.authorizeProposal(proposal, sessionId, exec.signal);
        const plan = prepareWatchPlan(request, context);
        const planEvidenceId = await host.saveDraft?.(plan, sessionId);
        return JSON.stringify({ ...plan, planEvidenceId });
      },
    }),
    defineTool({
      name: 'check_market_watch',
      description: '执行当前原生 Schedule 唤醒的通用盯盘检查，并返回宿主提交与已知投递回执。',
      parameters: {}, output: watchOutput,
      async execute(_args, exec) {
        const sessionId = exec.agent?.session.id;
        const request = sessionId && await host.activeCheck(sessionId, exec.signal);
        if (!request) throw new Error('仅可在已授权通用盯盘任务的当前原生检查中调用。');
        return JSON.stringify(await runWatchCheck(request, host, exec.signal));
      },
    }),
  ];
}
