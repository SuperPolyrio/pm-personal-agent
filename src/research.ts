import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { sourceSnapshotFromEvidence, type EvidenceRow, type NormalizedSourceEvidence,
  type SourceEvidenceRequest } from './source-evidence.js';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const unique = <T>(values: T[]) => [...new Set(values)];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, v) =>
  object(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v)).digest('hex');
const instant = (value?: string) => value && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value.slice(0, 10)))
  && new Date(value.slice(0, 10)).toISOString().startsWith(value.slice(0, 10))
  ? Date.parse(value) : NaN;
const compareTime = (a: string, b: string) => {
  const delta = instant(a) - instant(b);
  return delta === 0 ? (a.match(/T\d\d:\d\d:\d\d\.(\d+)/)?.[1].replace(/0+$/, '') ?? '')
    .localeCompare(b.match(/T\d\d:\d\d:\d\d\.(\d+)/)?.[1].replace(/0+$/, '') ?? '') : delta;
};
const coverageLevels = ['link', 'summary', 'body', 'document'] as const;
const clauseKinds = ['condition', 'exception', 'subject', 'timing', 'source', 'definition'] as const;
type Fact = SourceEvidenceRequest['facts'][number];
type Bound = { value: string; inclusive: boolean };
type Interval = { lower?: Bound; upper?: Bound };
type Location = { part: 'rules' | 'title' | 'clarification'; quote: string; offset?: number; evidenceId?: string };
type Requirement = {
  object: string; validTime: NonNullable<SourceEvidenceRequest['validTime']>;
  fact: Omit<Fact, 'key' | 'validTime'>; source: string; coverage: string;
  minimumCoverage?: 'body' | 'document'; freshness?: SourceEvidenceRequest['freshness'];
};
export type RuleClauseInput = {
  id: string; kind: typeof clauseKinds[number]; citations: Location[]; explanation: string;
  outcomes?: string[]; requirement?: Requirement;
  interval?: Interval; equals?: string;
  thresholdFromTitle?: boolean;
  window?: { description: string; mode: 'point' | 'ever'; closesAt?: string };
  dependencies?: string;
};
export type RuleCardInput = {
  clauses: RuleClauseInput[];
  unknowns?: string[];
  ambiguities?: { description: string; citations: Location[]; clauseIds?: string[] }[];
  incomplete?: boolean;
};
type Option = { label: string; tokenId: string };
type RulePart = { part: Location['part']; evidenceId: string; source: string; retrievedAt: string; body: string; incomplete: boolean };

const readOptions = (row: Record<string, unknown>) => {
  const listed = Array.isArray(row.outcomes) ? row.outcomes : [];
  const named = text(row.yesTokenId) && text(row.noTokenId) && row.yesTokenId !== row.noTokenId
    ? [{ label: 'Yes', tokenId: row.yesTokenId }, { label: 'No', tokenId: row.noTokenId }] : [];
  const valid = listed.every(item => object(item) && text(item.label) && text(item.tokenId))
    && new Set(listed.map(item => item.label)).size === listed.length
    && new Set(listed.map(item => item.tokenId)).size === listed.length;
  // The catalog's named Yes/No identifiers remain available when there is no matching quote row.
  const explicit = valid && listed.length > 0 ? listed.map(({ label, tokenId }): Option => ({ label, tokenId })) : [];
  if (listed.length && (!valid || (named.length && named.some(n => !explicit.some(o =>
    o.tokenId === n.tokenId && o.label === n.label))))) return { options: [], basis: 'unknown' };
  return { options: listed.length ? explicit : named, basis: listed.length ? 'resolver_outcomes' : named.length ? 'catalog_named_tokens' : 'unknown' };
};

function locate(parts: RulePart[], at: Location) {
  const matches = parts.filter(p => p.part === at.part && (at.evidenceId === undefined || p.evidenceId === at.evidenceId));
  if (matches.length !== 1 || !text(at.quote)) throw new Error(`缺少唯一的引文来源: ${at.part}`);
  const { body, incomplete: _incomplete, ...ref } = matches[0];
  const offset = at.offset ?? body.indexOf(at.quote);
  if (!Number.isInteger(offset) || offset < 0 || !body.startsWith(at.quote, offset)) {
    throw new Error(`规则引文未命中 (${ref.evidenceId}): ${at.quote}。请核对引文及 offset。`);
  }
  const next = at.offset === undefined ? body.indexOf(at.quote, offset + 1) : -1;
  if (next !== -1) {
    const occurrences = [offset, next].map(offset => ({
      offset,
      context: body.slice(Math.max(0, offset - 45), offset + at.quote.length + 45),
    }));
    throw new Error(`规则引文重复 (${ref.evidenceId})。请按上下文选用对应 offset 或引用唯一片段。前两处：${JSON.stringify(occurrences)}`);
  }
  return { ...ref, quote: at.quote, offset, end: offset + at.quote.length };
}

// Decimal comparison keeps the published digits. No rounding or unit conversion.
function decimal(raw: string) {
  const value = raw.trim().replace(/^−/, '-');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return;
  const [whole, fraction = ''] = value.replaceAll(',', '').split('.');
  return { digits: BigInt(whole + fraction), scale: fraction.length };
}
function compareDecimal(a: string, b: string) {
  const x = decimal(a);
  const y = decimal(b);
  if (!x || !y) return NaN;
  const scale = Math.max(x.scale, y.scale);
  const delta = x.digits * 10n ** BigInt(scale - x.scale) - y.digits * 10n ** BigInt(scale - y.scale);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
const numbersIn = (value: string) => value.match(/[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g) ?? [];
function boundOrder(a: Bound | undefined, b: Bound | undefined, side: 'lower' | 'upper') {
  if (!a && !b) return 0;
  if (!a || !b) return (!a ? -1 : 1) * (side === 'lower' ? 1 : -1);
  return compareDecimal(a.value, b.value) || (Number(b.inclusive) - Number(a.inclusive)) * (side === 'lower' ? 1 : -1);
}
function validInterval({ lower, upper }: Interval) {
  return Boolean((lower || upper) && [lower, upper].every(bound => !bound || decimal(bound.value)) &&
    (!lower || !upper || compareDecimal(lower.value, upper.value) < 0 ||
      (compareDecimal(lower.value, upper.value) === 0 && lower.inclusive && upper.inclusive)));
}

export function buildRuleCard(snapshot: EvidenceRow, input: RuleCardInput, clarifications: EvidenceRow[] = []) {
  const row = snapshot.data;
  if (!object(row) || row.status !== 'found' || !Number.isSafeInteger(row.localMarketId) ||
      !text(row.title) || !snapshot.evidenceId || !Number.isFinite(instant(snapshot.retrievedAt))) {
    throw new Error('需要已解析的单市场规则快照，含本地市场 ID、标题和取得时间。');
  }
  const { options, basis } = readOptions(row);
  const market = { localMarketId: row.localMarketId as number, title: row.title, slug: row.slug,
    eventSlug: row.eventSlug, conditionId: row.conditionId, gammaMarketId: row.gammaMarketId,
    url: row.url, catalogEndDate: row.endDate, options, optionMapping: basis };
  const body = typeof row.rules === 'string' ? row.rules : '';
  const ref = { evidenceId: snapshot.evidenceId, source: snapshot.source, retrievedAt: snapshot.retrievedAt };
  const parts: RulePart[] = [
    { ...ref, part: 'title', body: row.title, incomplete: false },
    { ...ref, part: 'rules', body, incomplete: !text(body) || row.truncated === true || row.hasMore === true },
  ];
  for (const capture of clarifications.map(sourceSnapshotFromEvidence)) {
    const { evidenceId, source, retrievedAt, content, coverage, truncated, gaps, failure, unsupported } = capture;
    if (failure || unsupported || !text(content?.value) || !['body', 'document'].includes(coverage)) {
      throw new Error(`澄清材料无可引用正文: ${evidenceId}`);
    }
    parts.push({ part: 'clarification', evidenceId, source, retrievedAt, body: content.value,
      incomplete: !!truncated || !!gaps?.length });
  }
  const ids = input.clauses.map(c => c.id);
  if (!ids.length && text(body) && !input.incomplete) {
    throw new Error('有规则正文时，规则卡至少要收录一条有原文依据的条款。');
  }
  if (new Set(ids).size !== ids.length || ids.some(id => !text(id))) throw new Error('条款 ID 必须非空且唯一。');
  const clauses = input.clauses.map(c => {
    const { requirement, equals, interval } = c;
    const citations = c.citations.map(at => locate(parts, at));
    if (!text(c.explanation) || !citations.length) throw new Error(`条款需要解释和引文: ${c.id}`);
    const bodyCited = citations.some(ref => ref.part !== 'title');
    if ((c.kind === 'condition' || c.kind === 'exception') && !bodyCited) {
      throw new Error(`结算条件和例外须引用规则正文或适用澄清: ${c.id}`);
    }
    if (requirement && (!text(requirement.object) || !text(requirement.source) || !text(requirement.coverage) ||
        !text(requirement.fact.name) || (typeof requirement.validTime === 'string' ? !text(requirement.validTime)
          : !text(requirement.validTime?.start) || !text(requirement.validTime?.end)) ||
        Object.values(requirement.fact.qualifiers ?? {}).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) {
      throw new Error(`事实要求需要对象、期间、口径、来源及覆盖: ${c.id}`);
    }
    if (c.window?.closesAt && !Number.isFinite(instant(c.window.closesAt))) throw new Error(`截止时间必须含明确时区: ${c.id}`);
    // Some contracts expressly refer to the threshold in their title.
    const thresholds = citations.filter(r => r.part !== 'title' || (c.thresholdFromTitle && bodyCited))
      .flatMap(r => numbersIn(r.quote));
    if (equals !== undefined && (interval || !text(equals) || !requirement || requirement.fact.kind === 'number')) {
      throw new Error(`equals 需要文本或状态事实要求，且不能和 interval 同用: ${c.id}。只做规则对照时可保留引文和解释，省略计算字段。`);
    }
    if (interval && (requirement?.fact.kind !== 'number' || !text(requirement.fact.unit) || !validInterval(interval) ||
        [interval.lower, interval.upper].some(bound => bound && !thresholds.includes(bound.value)))) {
      throw new Error(`区间需要数值事实要求、单位和已引用的原文端点: ${c.id}。`);
    }
    const labels = unique(c.outcomes ?? []);
    return { ...c, outcomes: labels, citations, optionRefs: labels.flatMap(label => options.filter(o => o.label === label)),
      unmappedOutcomes: labels.filter(label => !options.some(o => o.label === label)),
      citationStatus: 'located' as const, semanticStatus: 'agent_interpretation' as const, assessment: 'insufficient' as const };
  });
  const ambiguities = (input.ambiguities ?? []).map(issue => {
    if (!text(issue.description) || issue.citations.length < 2 || issue.clauseIds?.some(id => !ids.includes(id))) {
      throw new Error('歧义需要说明、至少两个出处及有效的受影响条款 ID。');
    }
    return { ...issue, citations: issue.citations.map(at => locate(parts, at)) };
  });
  const supplements = parts.filter(p => p.part === 'clarification');
  const rules = { ...ref, url: market.url, capturedText: body,
    clarifications: supplements,
    contentId: hash([body, supplements.map(p => JSON.stringify([p.source, p.body])).sort()]),
    observationOnly: true, incomplete: !!input.incomplete || parts.some(p => p.part !== 'title' && p.incomplete) };
  const unknowns = unique([...(input.unknowns ?? []), ...(!text(body) ? ['缺少规则正文'] : []),
    ...(rules.incomplete ? ['规则材料覆盖不完整'] : []), ...(!options.length ? ['选项 token 映射未知'] : []),
    ...clauses.flatMap(c => c.unmappedOutcomes.map(label => `${c.id}: 未映射选项 ${label}`))]);
  const evidenceRequirements = clauses.flatMap(clause => {
    if (!clause.requirement) return [];
    const { object, validTime, fact, minimumCoverage = 'body', freshness } = clause.requirement;
    const factKey = `local:${market.localMarketId}/${clause.id}`;
    const request: SourceEvidenceRequest = { question: fact.name, object, validTime,
      market: { id: `local:${market.localMarketId}`, rulesEvidenceId: ref.evidenceId },
      facts: [{ ...fact, key: factKey }], minimumCoverage, freshness,
      ...(freshness ? { times: [freshness.timeKey] } : {}) };
    return [{ clauseId: clause.id, factKey, citations: clause.citations, source: clause.requirement.source,
      coverage: clause.requirement.coverage, request }];
  });
  const meaning = clauses.map(({ citations, optionRefs, unmappedOutcomes, citationStatus, semanticStatus, assessment, ...c }) => c)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { kind: 'rule_card' as const, market, rules, clauses, unknowns, ambiguities, evidenceRequirements,
    inputEvidenceIds: unique(parts.map(p => p.evidenceId)),
    interpretationRevision: hash([meaning, input.unknowns ?? [], ambiguities.map(({ description, clauseIds }) => ({ description, clauseIds }))]) };
}

export type RuleCard = ReturnType<typeof buildRuleCard>;
const cardRef = (card: RuleCard) => ({ market: card.market, rulesEvidenceId: card.rules.evidenceId,
  source: card.rules.source, retrievedAt: card.rules.retrievedAt, contentId: card.rules.contentId,
  interpretationRevision: card.interpretationRevision, incomplete: card.rules.incomplete });
type Clause = RuleCard['clauses'][number];
const clauseRef = (c: Clause) => ({ clauseId: c.id, explanation: c.explanation, outcomes: c.outcomes,
  optionRefs: c.optionRefs, citations: c.citations, kind: c.kind, requirement: c.requirement,
  interval: c.interval, equals: c.equals, thresholdFromTitle: c.thresholdFromTitle,
  window: c.window, dependencies: c.dependencies });

const comparisonFields = ['kind', 'outcomes', 'requirement', 'interval', 'equals', 'thresholdFromTitle',
  'window', 'dependencies', 'explanation'] as const;
type Finding = {
  kind: 'divergence' | 'equivalent' | 'contains' | 'mutually_exclusive' | 'exhaustive';
  basis: string; scope: string; refs: { localMarketId: number; clauseId: string }[];
};
function comparePredicates(a: Clause, b: Clause) {
  if (!a.requirement || !isDeepStrictEqual(a.requirement, b.requirement) || !isDeepStrictEqual(a.window, b.window) ||
      a.window?.mode === 'ever' || a.dependencies || b.dependencies || a.kind !== 'condition' || b.kind !== 'condition' ||
      [a, b].some(c => !c.optionRefs.length || c.unmappedOutcomes.length ||
        !c.citations.some(ref => ref.part !== 'title'))) return;
  if (a.equals !== undefined && b.equals !== undefined && a.equals !== b.equals) {
    return { relation: 'mutually_exclusive' as const, exhaustive: 'unknown' as const };
  }
  if (!a.interval || !b.interval) return;
  const x = a.interval;
  const y = b.interval;
  const low = boundOrder(x.lower, y.lower, 'lower');
  const high = boundOrder(x.upper, y.upper, 'upper');
  const [left, right] = low <= 0 ? [x, y] : [y, x];
  const touch = left.upper && right.lower ? compareDecimal(left.upper.value, right.lower.value) : 1;
  const overlap = touch > 0 || (touch === 0 && left.upper!.inclusive && right.lower!.inclusive);
  const gap = touch < 0 || (touch === 0 && !left.upper!.inclusive && !right.lower!.inclusive);
  const exhaustive = !left.lower && (!left.upper || !right.upper) && !gap;
  return { relation: low === 0 && high === 0 ? 'equivalent' as const : low <= 0 && high >= 0 ? 'left_contains' as const
    : low >= 0 && high <= 0 ? 'right_contains' as const : overlap ? 'overlap' as const : 'mutually_exclusive' as const,
    exhaustive, gap, domain: 'continuous_numeric' as const };
}

export type RuleComparisonScope = { eventSlug: string; catalog: EvidenceRow };
export function compareRuleCards(cards: RuleCard[], scope?: RuleComparisonScope, findings: Finding[] = []) {
  const ids = cards.map(c => c.market.localMarketId);
  const conditions = cards.map(c => c.market.conditionId).filter(text);
  if (ids.length < 2 || new Set(ids).size !== ids.length || new Set(conditions).size !== conditions.length) {
    throw new Error('需要两个或更多不同合约，同一市场的快照请比较规则版本。');
  }
  const catalog = scope?.catalog.data;
  const members = object(catalog) && catalog.status === 'selection_required' && Array.isArray(catalog.items)
    ? catalog.items.filter(row => object(row) && Number.isSafeInteger(row.localMarketId)) : [];
  const matchesEvent = scope && members.length > 0 && cards.every(c => c.market.eventSlug === scope.eventSlug) &&
    members.every(row => typeof row.url === 'string' &&
      URL.parse(row.url)?.pathname.split('/')[2] === scope.eventSlug);
  const memberIds: number[] = members.map(row => row.localMarketId);
  const missingIds = matchesEvent ? memberIds.filter(id => !ids.includes(id)) : [];
  const complete = !!(matchesEvent && object(catalog) && catalog.hasMore === false &&
    members.length === (catalog.items as unknown[]).length && ids.every(id => memberIds.includes(id)) && !missingIds.length);
  const comparisons = cards.flatMap((left, i) => cards.slice(i + 1).map(right => ({
    leftMarketId: left.market.localMarketId, rightMarketId: right.market.localMarketId,
    identityDifferences: ['title', 'eventSlug', 'options'].filter(key =>
      !isDeepStrictEqual(left.market[key as keyof RuleCard['market']], right.market[key as keyof RuleCard['market']])),
    clauses: unique([...left.clauses, ...right.clauses].map(c => c.id)).map(id => {
      const a = left.clauses.find(c => c.id === id);
      const b = right.clauses.find(c => c.id === id);
      const canCompare = a && b && ![left, right].some(card => card.rules.incomplete || card.ambiguities.some(issue =>
        !issue.clauseIds?.length || issue.clauseIds.includes(id)));
      return { clauseId: id, left: a && clauseRef(a), right: b && clauseRef(b),
        differences: a && b ? comparisonFields.filter(key => !isDeepStrictEqual(a[key], b[key])) : ['unpaired'],
        computedConditionRelation: canCompare ? comparePredicates(a, b) : undefined };
    }),
  })));
  const interpretations = findings.map(finding => {
    if (!text(finding.basis) || !text(finding.scope) || new Set(finding.refs.map(r => r.localMarketId)).size < 2) {
      throw new Error('对照推断需要适用范围、说明和至少两个市场的条款。');
    }
    return { ...finding, status: 'agent_interpretation' as const, refs: finding.refs.map(r => {
      const clause = cards.find(c => c.market.localMarketId === r.localMarketId)?.clauses.find(c => c.id === r.clauseId);
      if (!clause) throw new Error(`无法定位对照条款: ${r.localMarketId}/${r.clauseId}`);
      return { ...r, citations: clause.citations };
    }) };
  });
  return { kind: 'rule_card_comparison' as const, cards: cards.map(card => ({ ...cardRef(card), unknowns: card.unknowns })),
    scope: { kind: scope ? 'event_catalog' : 'selected_markets', eventSlug: scope?.eventSlug, selectedIds: ids,
      catalogEvidenceId: scope?.catalog.evidenceId, catalogComplete: scope ? complete : undefined, missingIds,
      truncated: object(catalog) && typeof catalog.hasMore === 'boolean' ? catalog.hasMore : undefined },
    comparisons, interpretations, contractRelations: 'require_semantic_review' as const,
    inputEvidenceIds: unique([...cards.flatMap(c => c.inputEvidenceIds), ...(scope ? [scope.catalog.evidenceId] : [])]) };
}

export function compareRuleVersions(before: RuleCard, after: RuleCard) {
  if (before.market.localMarketId !== after.market.localMarketId ||
      (before.market.conditionId && after.market.conditionId && before.market.conditionId !== after.market.conditionId) ||
      (before.market.gammaMarketId && after.market.gammaMarketId && before.market.gammaMarketId !== after.market.gammaMarketId)) {
    throw new Error('规则版本必须来自同一市场身份。');
  }
  if (compareTime(before.rules.retrievedAt, after.rules.retrievedAt) > 0) throw new Error('规则版本取得顺序相反。');
  const rawChanged = before.rules.contentId !== after.rules.contentId;
  const incomplete = before.rules.incomplete || after.rules.incomplete;
  const textRefs = (c: Clause) => c.citations.filter(r => r.part !== 'title');
  const textKey = (r: Clause['citations'][number]) => JSON.stringify([r.part, r.source, r.quote]);
  const stillPresent = (r: Clause['citations'][number], inCard: RuleCard) => r.part === 'rules'
    ? inCard.rules.capturedText.includes(r.quote)
    : inCard.rules.clarifications.some(p => p.source === r.source && p.body.includes(r.quote));
  const sameSources = isDeepStrictEqual(before.rules.clarifications.map(p => p.source).sort(),
    after.rules.clarifications.map(p => p.source).sort());
  const clauses = unique([...before.clauses, ...after.clauses].map(c => c.id)).flatMap(id => {
    const a = before.clauses.find(c => c.id === id);
    const b = after.clauses.find(c => c.id === id);
    const fields = a && b ? comparisonFields.filter(key => !isDeepStrictEqual(a[key], b[key])) : [];
    const oldRefs = a ? textRefs(a) : [];
    const newRefs = b ? textRefs(b) : [];
    const oldOnly = oldRefs.filter(r => !newRefs.some(next => textKey(r) === textKey(next)));
    const newOnly = newRefs.filter(r => !oldRefs.some(prev => textKey(r) === textKey(prev)));
    const changedRefs = oldOnly.length || newOnly.length;
    const removed = oldOnly.length > 0 && oldOnly.every(r => !stillPresent(r, after));
    const added = newOnly.length > 0 && newOnly.every(r => !stillPresent(r, before));
    const titleReferenceChanged = [...(a?.citations ?? []), ...(b?.citations ?? [])].some(r => r.part === 'title') &&
      before.market.title !== after.market.title;
    const type = a && b
      ? titleReferenceChanged ? 'title_reference_changed' : changedRefs && rawChanged
        ? (!incomplete && sameSources && removed && added ? 'modified' : 'alignment_unknown')
        : fields.length || changedRefs ? 'interpretation' : undefined
      : incomplete || !sameSources ? 'coverage_unknown'
        : rawChanged && removed ? 'removed' : rawChanged && added ? 'added' : 'extraction_difference';
    return type ? [{ clauseId: id, type, fields, before: a && clauseRef(a), after: b && clauseRef(b) }] : [];
  });
  return { kind: 'rule_version_comparison' as const, before: cardRef(before), after: cardRef(after),
    rawChange: incomplete || !sameSources ? 'coverage_unknown' : rawChanged ? 'observed_content_change' : 'unchanged',
    interpretationChanged: before.interpretationRevision !== after.interpretationRevision,
    identityFieldsChanged: (['title', 'options', 'catalogEndDate'] as const).filter(key =>
      !isDeepStrictEqual(before.market[key], after.market[key])),
    ruleEffect: 'unknown' as const, clauses, reviewClauseIds: clauses.map(c => c.clauseId),
    textChangeBasis: 'captured_clause_quotes' as const,
    reviewUnmappedChanges: rawChanged && (!clauses.length || clauses.some(c => ['alignment_unknown', 'coverage_unknown'].includes(c.type))),
    inputEvidenceIds: unique([...before.inputEvidenceIds, ...after.inputEvidenceIds]) };
}

const reviews = ['literal', 'supports', 'refutes', 'not_applicable', 'unverified'] as const;
export type RuleFactBinding = {
  clauseId: string; normalizedEvidenceId: string; factKey: string;
  review: typeof reviews[number]; coverage: 'observation' | 'complete' | 'unknown'; basis: string;
};
export type SavedNormalizedEvidence = NormalizedSourceEvidence & { evidenceId: string };
type AssessmentOptions = { asOf?: string; now: string };
const periodLabel = (p: Requirement['validTime']) => typeof p === 'string' ? p : `${p.start}/${p.end}`;
type ConditionState = 'met' | 'not_met' | 'insufficient' | 'conflicting' | 'not_applicable';
type SourceFact = NormalizedSourceEvidence['data']['facts'][number];

function checkRuleFact(
  requirement: RuleCard['evidenceRequirements'][number], clause: Clause, evidence: SavedNormalizedEvidence,
  binding: RuleFactBinding, options: AssessmentOptions,
) {
  const { quality, scope, sourceRef, times } = evidence.data;
  const { request } = requirement;
  const fact = evidence.data.facts.find(f => f.key === binding.factKey);
  const spec = request.facts[0];
  const expected = {
    object: request.object, validTime: periodLabel(request.validTime!),
    ...(spec.unit ? { unit: spec.unit } : {}),
    ...Object.fromEntries(Object.entries(spec.qualifiers ?? {}).map(([key, v]) => [`qualifier:${key}`, v])),
  };
  const at = options.asOf ?? options.now;
  if (quality.failure || quality.unsupported || quality.truncated || quality.captureGaps?.length ||
      ['failed', 'unsupported'].includes(quality.status) ||
      coverageLevels.indexOf(quality.coverage) < coverageLevels.indexOf(request.minimumCoverage!)) return '来源读取或正文覆盖不足';
  if (quality.historical?.availability === 'unknown' || compareTime(evidence.retrievedAt, at) > 0 ||
      !Number.isFinite(instant(evidence.retrievedAt))) return '无法证明核对时点已取得这个版本';
  if (quality.freshness === 'stale') return '来源实时状态已过期';
  if (request.freshness) {
    const time = times.find(t => t.key === request.freshness!.timeKey && t.kind !== 'expected' && t.time.utc);
    const age = (instant(at) - instant(time?.time.utc)) / 1000;
    if (quality.freshness !== 'fresh' || !Number.isFinite(age) || age < 0 ||
        age > request.freshness.maxAgeSeconds) return '缺少核对时点足够新鲜的观测';
  }
  if (quality.match !== 'matched' || !fact?.checked || fact.citation.evidenceId !== sourceRef.evidenceId ||
      !isDeepStrictEqual(scope.market, request.market) || fact.object !== request.object ||
      !isDeepStrictEqual(fact.validTime, request.validTime) ||
      fact.name !== spec.name || fact.kind !== spec.kind || fact.unit !== spec.unit ||
      !isDeepStrictEqual(fact.qualifiers ?? {}, spec.qualifiers ?? {}) ||
      Object.entries(expected).some(([field, value]) => !fact.checks.some(c => c.field === field &&
        c.status === 'matched' && c.citation?.evidenceId === sourceRef.evidenceId && isDeepStrictEqual(c.expected, value)))) {
    return '事实引用、规则快照、对象、期间、指标单位或限定口径未匹配';
  }
  if (sourceRef.requirement.status !== 'matched' || !text(sourceRef.requirement.basis)) return '规则指定来源未获证实';
  if (binding.review === 'unverified' || !text(binding.basis) ||
      (binding.review === 'literal' && fact.extraction !== 'literal')) return '事实与条款的语义对应待核实';
  if (binding.coverage === 'unknown' || (clause.window?.mode !== 'ever' && binding.coverage !== 'complete')) {
    return '事实或时间范围覆盖不足';
  }
}

function evaluateFact(clause: Clause, fact: SourceFact, review: RuleFactBinding['review']): boolean | undefined {
  if (clause.interval) {
    if (review !== 'literal' || fact.kind !== 'number') return;
    // A parsed JSON number has already lost its decimal lexeme.
    const values = typeof fact.original === 'string' ? numbersIn(fact.original) : [];
    if (values.length !== 1 || Number(values[0].replaceAll(',', '').replace(/^−/, '-')) !== fact.value || !decimal(values[0])) return;
    const { lower, upper } = clause.interval;
    const low = lower ? compareDecimal(values[0], lower.value) : 1;
    const high = upper ? compareDecimal(values[0], upper.value) : -1;
    return (low > 0 || (low === 0 && !!lower?.inclusive)) && (high < 0 || (high === 0 && !!upper?.inclusive));
  }
  if (clause.equals !== undefined) return review === 'literal' ? fact.value === clause.equals : undefined;
  if (review === 'supports' || review === 'refutes') return review === 'supports';
}

export function assessRuleEvidence(
  card: RuleCard, evidence: SavedNormalizedEvidence[], bindings: RuleFactBinding[], options: AssessmentOptions,
) {
  if (!Number.isFinite(instant(options.now)) || (options.asOf && !Number.isFinite(instant(options.asOf)))) {
    throw new Error('核对时间需要带时区。');
  }
  if (options.asOf && compareTime(options.asOf, options.now) > 0) throw new Error('核对时点不能晚于当前时间。');
  const requirements = new Map(card.evidenceRequirements.map(r => [r.clauseId, r]));
  const sources = new Map(evidence.map(e => [e.evidenceId, e]));
  if (new Set(bindings.map(b => JSON.stringify([b.clauseId, b.normalizedEvidenceId, b.factKey]))).size !== bindings.length) {
    throw new Error('同一条款与事实证据只可绑定一次。');
  }
  for (const b of bindings) {
    if (requirements.get(b.clauseId)?.factKey !== b.factKey || !sources.has(b.normalizedEvidenceId)) {
      throw new Error(`未知条款事实 key 或证据 ID: ${b.clauseId}/${b.factKey}/${b.normalizedEvidenceId}`);
    }
  }
  const at = options.asOf ?? options.now;
  const conditions = card.clauses.filter(c => c.kind === 'condition' || c.kind === 'exception' || c.requirement).map(clause => {
    const requirement = requirements.get(clause.id);
    const ruleGaps = [
      ...(!requirement ? ['需要明确可核实的事实要求'] : []),
      ...(card.rules.incomplete ? ['规则材料覆盖不完整'] : []),
      ...(!clause.citations.some(c => c.part !== 'title') ? ['需要规则正文或适用澄清'] : []),
      ...(clause.unmappedOutcomes.length ? ['涉及选项尚未绑定到 token'] : []),
      ...([card.rules, ...card.rules.clarifications].some(c =>
        !Number.isFinite(instant(c.retrievedAt)) || compareTime(c.retrievedAt, at) > 0) ? ['核对时点无法确认此规则版本可得'] : []),
      ...(card.ambiguities.some(x => !x.clauseIds?.length || x.clauseIds.includes(clause.id)) ? ['存在待解决的规则歧义'] : []),
    ];
    const observations = bindings.filter(b => b.clauseId === clause.id).map(binding => {
      const item = sources.get(binding.normalizedEvidenceId)!;
      const data = item.data;
      const fact = data.facts.find(f => f.key === binding.factKey);
      const ref = { ...binding, source: item.source, retrievedAt: item.retrievedAt, sourceRef: data.sourceRef,
        version: data.version, quality: data.quality, fact };
      const issue = checkRuleFact(requirement!, clause, item, binding, options);
      if (issue || ruleGaps.length) return { ...ref, status: 'insufficient' as const, issue: issue ?? ruleGaps[0] };
      if (binding.review === 'not_applicable') {
        return { ...ref, status: 'not_applicable' as const, issue: undefined };
      }
      const match = evaluateFact(clause, fact!, binding.review);
      if (match === undefined) return { ...ref, status: 'insufficient' as const, issue: '谓词缺少可复核的语义对应或原始数值' };
      if (!match && clause.window?.mode === 'ever' && (binding.coverage !== 'complete' ||
          !clause.window.closesAt || compareTime(at, clause.window.closesAt) < 0)) {
        return { ...ref, status: 'insufficient' as const, issue: '需要已结束且完整覆盖的窗口才能否定曾发生条件' };
      }
      return { ...ref, status: match ? 'met' as const : 'not_met' as const, issue: undefined };
    });
    const accepted = observations.filter(o => o.status !== 'insufficient');
    const states = unique(accepted.map(o => o.status));
    const differentValues = clause.window?.mode !== 'ever' && unique(accepted.map(o =>
      JSON.stringify(o.fact?.value))).length > 1;
    const status: ConditionState = states.length > 1 || differentValues ? 'conflicting' : states[0] ?? 'insufficient';
    const missing = unique([...ruleGaps, ...observations.flatMap(o => o.issue ? [o.issue] : []),
      ...(!observations.length && requirement ? [`缺少 ${requirement.request.question} 的规范化证据`] : []),
      ...(status === 'conflicting' ? ['需要核对相互矛盾的来源、版本与适用范围'] : [])]);
    return { ...clauseRef(clause), status, requirement, observations, missing };
  });
  return { kind: 'rule_evidence_assessment' as const, ruleCard: cardRef(card), checkedAt: options.now,
    asOf: options.asOf, conditions, settlement: 'unknown' as const,
    reviewClauseIds: conditions.filter(c => c.status !== 'not_applicable').map(c => c.clauseId),
    inputEvidenceIds: unique([...card.inputEvidenceIds, ...evidence.flatMap(e => [e.evidenceId, ...e.data.inputEvidenceIds])]) };
}

const str = { type: 'string' } as const;
const req = { ...str, required: true } as const;
const integer = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const obj = <const T extends ParameterSchemaSpec>(properties: T) =>
  ({ type: 'object', additionalProperties: false, properties } as const);
const list = <const T extends ValueSchemaSpec>(items: T) => ({ type: 'array', items } as const);
const choice = <const T extends readonly string[]>(values: T) => ({ ...str, enum: values } as const);
const citations = list(obj({
  part: { ...choice(['rules', 'title', 'clarification']), required: true },
  quote: { ...req, description: 'Exact substring in the saved field. Use a unique quote or add its UTF-16 offset.' },
  offset: integer, evidenceId: { ...str, description: 'Saved clarification evidence ID when selecting between captures.' },
}));
const bound = obj({ value: { ...req, description: 'Original decimal from the citation without the unit.' }, inclusive: { ...bool, required: true } });
const requirement = obj({
  object: req, validTime: { oneOf: [str, obj({ start: req, end: req })], required: true },
  fact: { ...obj({
    name: req, kind: { ...choice(['number', 'status', 'text']), required: true }, unit: str,
    qualifiers: { type: 'object', additionalProperties: true, description: 'Scalar qualifiers to verify in T-E, including adjustment, source series, rounding or observation type where applicable.' },
  }), required: true },
  source: { ...req, description: 'Rule authority and applicable fallback or unknown. Cite its wording on this clause.' },
  coverage: { ...req, description: 'What observation or full interval/record would establish this condition.' },
  minimumCoverage: choice(['body', 'document']),
  freshness: obj({ timeKey: req, maxAgeSeconds: { type: 'number', required: true } }),
});
const clause = obj({
  id: { ...req, description: 'Short stable semantic key. Reuse across versions; align across comparable contracts.' },
  kind: { ...choice(clauseKinds), required: true }, citations: { ...citations, required: true }, explanation: req,
  outcomes: { ...list(str), description: 'Exact rule outcome labels; token IDs come only from the resolver.' },
  requirement, interval: obj({ lower: bound, upper: bound }),
  thresholdFromTitle: { ...bool, description: 'Use only when a cited rule incorporates the threshold given in the cited title.' },
  equals: { ...str, description: 'Exact categorical value for a text/status requirement. Omit for numeric amounts or for rule comparison without a fact requirement.' },
  window: obj({ description: req, mode: { ...choice(['point', 'ever']), required: true },
    closesAt: { ...str, description: 'Explicit zoned instant only. Preserve unresolved or date-only cutoff in description.' } }),
  dependencies: { ...str, description: 'Cited AND/OR and exception applicability, if relevant. Individual condition results do not evaluate this logic.' },
});
const output = { schema: str, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
type EvidenceAccess = {
  loadEvidence: (id: string, signal: AbortSignal) => EvidenceRow | undefined | Promise<EvidenceRow | undefined>;
  saveEvidence: (source: string, data: unknown, retrievedAt: string) => EvidenceRow | Promise<EvidenceRow>;
};

export function createResearchTools({ loadEvidence, saveEvidence }: EvidenceAccess) {
  async function load(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const row = await loadEvidence(id, signal);
    if (!row || row.evidenceId !== id) throw new Error(`证据不存在: ${id}`);
    return row;
  }
  async function loadCard(id: string, signal: AbortSignal) {
    const row = await load(id, signal);
    if (!object(row.data) || row.data.kind !== 'rule_card' || row.source !== 'personal-agent/research') {
      throw new Error(`需要规则卡证据: ${id}`);
    }
    const card = row.data as RuleCard;
    await Promise.all(card.inputEvidenceIds.map(id => load(id, signal)));
    return card;
  }
  async function save<T extends { kind: string; inputEvidenceIds: string[] }>(data: T, signal: AbortSignal) {
    signal.throwIfAborted();
    return JSON.stringify(await saveEvidence('personal-agent/research', data, new Date().toISOString()));
  }
  return [
    defineTool({
      name: 'build_rule_card',
      description: '用户问某个 Polymarket 市场怎么结算、什么情况算某结果时，读取 resolve_market/read_market(rules) 保存的原文后，调用本工具校验条款再回答。一般解读只需条款 ID、类型、逐字引文和解释；程序核对出处与位置。结算条件与例外须引规则正文或适用澄清。此工具解释规则，实际结算结果另查 Oracle。',
      parameters: {
        rulesEvidenceId: req, clarificationEvidenceIds: list(str),
        clauses: { ...list(clause), required: true }, unknowns: list(str), incomplete: bool,
        ambiguities: list(obj({ description: req, citations: { ...citations, required: true }, clauseIds: list(str) })),
      }, output,
      async execute({ rulesEvidenceId, clarificationEvidenceIds = [], ...input }, { signal }) {
        const snapshot = await load(rulesEvidenceId, signal);
        if (snapshot.source !== 'market-data/research/resolve') throw new Error('需要 resolver 保存的市场规则证据。');
        const clarifications = await Promise.all(unique(clarificationEvidenceIds).map(id => load(id, signal)));
        return save(buildRuleCard(snapshot, input as RuleCardInput, clarifications), signal);
      },
    }),
    defineTool({
      name: 'compare_rule_cards',
      description: '对照两个或更多规则卡。可附有条款引用的差异情景或关系推断。只有确有事件目录快照时传 eventCatalog。',
      parameters: {
        cardEvidenceIds: { ...list(str), required: true },
        eventCatalog: obj({ eventSlug: req, evidenceId: req }),
        findings: list(obj({
          kind: { ...choice(['divergence', 'equivalent', 'contains', 'mutually_exclusive', 'exhaustive']), required: true },
          basis: req, scope: req, refs: { ...list(obj({ localMarketId: { ...integer, required: true }, clauseId: req })), required: true },
        })),
      }, output,
      async execute({ cardEvidenceIds, eventCatalog, findings }, { signal }) {
        const cards = await Promise.all(cardEvidenceIds.map(id => loadCard(id, signal)));
        const catalog = eventCatalog && await load(eventCatalog.evidenceId, signal);
        if (catalog && catalog.source !== 'market-data/research/resolve') throw new Error('需要 resolver 的事件成员证据。');
        const result = compareRuleCards(cards, eventCatalog && catalog ? { eventSlug: eventCatalog.eventSlug, catalog } : undefined, findings);
        result.inputEvidenceIds = unique([...cardEvidenceIds, ...result.inputEvidenceIds]);
        return save({ ...result, cardEvidenceIds }, signal);
      },
    }),
    defineTool({
      name: 'compare_rule_versions',
      description: '对照同一市场两张规则卡，区分观察到的文本变化、解释修订和覆盖缺口。',
      parameters: { beforeCardEvidenceId: req, afterCardEvidenceId: req }, output,
      async execute({ beforeCardEvidenceId, afterCardEvidenceId }, { signal }) {
        const ids = [beforeCardEvidenceId, afterCardEvidenceId];
        const [before, after] = await Promise.all(ids.map(id => loadCard(id, signal)));
        const result = compareRuleVersions(before, after);
        result.inputEvidenceIds = unique([...ids, ...result.inputEvidenceIds]);
        return save({ ...result, beforeCardEvidenceId, afterCardEvidenceId }, signal);
      },
    }),
    defineTool({
      name: 'assess_rule_evidence',
      description: '消费 T-E 已保存的 normalized_source_evidence，核对单张规则卡。逐项说明来源匹配、语义依据、事实覆盖与缺口。状态是条件核对，结算另查。',
      parameters: {
        cardEvidenceId: req, asOf: str,
        bindings: { ...list(obj({
          clauseId: req, normalizedEvidenceId: req, factKey: req,
          review: { ...choice(reviews), required: true, description: 'Use literal for an interval or equals predicate with a directly cited value, even when it fails the predicate. Use supports/refutes for reviewed natural-language predicates and unverified when unresolved.' },
          coverage: { ...choice(['observation', 'complete', 'unknown']), required: true,
            description: 'Complete means the cited evidence covers the rule requirement. A single final record can fully cover a specified result or time point. Observation means only part of the required record or window is covered.' },
          basis: { ...req, description: 'Explain how cited raw facts, authority, context and time coverage support this binding.' },
        })), required: true },
      }, output,
      async execute({ cardEvidenceId, bindings, asOf }, { signal }) {
        const card = await loadCard(cardEvidenceId, signal);
        const evidence = await Promise.all(unique(bindings.map(b => b.normalizedEvidenceId)).map(async id => {
          const row = await load(id, signal);
          if (!object(row.data) || row.data.kind !== 'normalized_source_evidence') throw new Error(`需要 T-E 规范化证据: ${id}`);
          const item = { ...row, data: row.data as NormalizedSourceEvidence['data'] };
          await Promise.all(item.data.inputEvidenceIds.map(id => load(id, signal)));
          return item;
        }));
        const result = assessRuleEvidence(card, evidence, bindings, { now: new Date().toISOString(), asOf });
        result.inputEvidenceIds = unique([cardEvidenceId, ...result.inputEvidenceIds]);
        return save({ ...result, ruleCard: { ...result.ruleCard, evidenceId: cardEvidenceId } }, signal);
      },
    }),
  ];
}
