import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools';

type Scalar = string | number | boolean;
type Period = string | { start: string; end: string };
type Coverage = 'link' | 'summary' | 'body' | 'document';
type TimeKind = 'expected' | 'occurred' | 'published' | 'revised' | 'observed';
type BodyLocator = { pointer: string } | { quote: string; offset?: number };
type Locator = BodyLocator | { url: true } | { query: string };
type Citation = { evidenceId: string; locator: Locator; raw: unknown };
type LocatedValue = { at: BodyLocator; value?: string; mapping?: string };
type Check = { field: string; at: Locator; literal?: Scalar; mapping?: string };
type CheckResult = {
  field: string; expected?: Scalar; status: 'matched' | 'mismatch' | 'unverified';
  citation?: Citation; mapping?: string;
};
type FactScope = {
  key: string; name: string; kind: 'number' | 'status' | 'text'; unit?: string;
  validTime?: Period; qualifiers?: Record<string, Scalar>;
};
type FactCandidate = LocatedValue & { key: string; checks?: Check[] };
type TimeCandidate = LocatedValue & {
  key: string; kind: TimeKind; zone?: string; zoneBasis?: { at: BodyLocator; literal: string }; epochUnit?: 's' | 'ms';
};
type VersionMarker = {
  kind: 'issued' | 'revised' | 'withdrawn'; marker: BodyLocator; mapping: string; id?: BodyLocator; supersedes?: BodyLocator;
};
type SourceTime = {
  original: string; precision: 'date' | 'minute' | 'second' | 'fraction'; zone?: string;
  utc?: string; beijing?: string;
};
export type EvidenceRow = { evidenceId: string; source: string; retrievedAt: string; data: unknown };
type ReadFailure = { stage: 'access' | 'parse' | 'validate'; reason: string; code?: string };

export type SourceSnapshot = {
  evidenceId: string; source: string; retrievedAt: string; recordKey?: string;
  content?: { format: 'text' | 'html' | 'json'; value: unknown };
  coverage: Coverage; truncated?: boolean; gaps?: string[];
  failure?: ReadFailure; unsupported?: string;
};

export type SourceEvidenceRequest = {
  question: string; object?: string; validTime?: Period;
  market?: { id: string; rulesEvidenceId: string };
  facts: FactScope[]; times?: string[]; checks?: Check[];
  minimumCoverage?: Coverage; asOf?: string;
  freshness?: { timeKey: string; maxAgeSeconds: number };
  sourceRole?: 'primary' | 'republication' | 'secondary';
  sourceRequirement?: { status: 'matched' | 'mismatch' | 'unknown'; basis: string };
  originalSource?: { key: string; at: BodyLocator };
  waitFor?: string;
};

export type SourceEvidenceCandidates = {
  facts?: FactCandidate[]; times?: TimeCandidate[]; version?: VersionMarker;
};

const coverageKinds = ['link', 'summary', 'body', 'document'] as const;
const timeKinds = ['expected', 'occurred', 'published', 'revised', 'observed'] as const;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const stableJson = (value: unknown) => JSON.stringify(value, (_key, v: unknown) =>
  isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const rangeLabel = (period?: Period) => typeof period === 'object' ? `${period.start}/${period.end}` : period;

function decodeText(value: string, truncated?: boolean): SourceSnapshot['content'] {
  if (!truncated && /^[\s\uFEFF]*[{[]/.test(value)) {
    try { return { format: 'json', value: JSON.parse(value.replace(/^\uFEFF/, '')) }; } catch { /* Preserve captured text. */ }
  }
  return { format: 'text', value };
}

/** Decode the current saved web_fetch/MCP envelopes or an explicitly described host capture. */
export function sourceSnapshotFromEvidence(row: EvidenceRow): SourceSnapshot {
  const { evidenceId, source, retrievedAt, data } = row;
  const ref = { evidenceId, source, retrievedAt };
  if (isObject(data) && data.kind === 'source_capture') {
    const { kind: _kind, ...capture } = data;
    return { ...(capture as Omit<SourceSnapshot, keyof typeof ref>), ...ref };
  }
  const result = isObject(data) && isObject(data.arguments) && isObject(data.result) ? data.result : undefined;
  if (result && typeof result.url === 'string' && typeof result.statusCode === 'number' && isObject(result.body)) {
    const snapshot = { ...ref, source: result.url, truncated: result.truncated === true };
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return { ...snapshot, coverage: 'link', failure: { stage: 'access', reason: `HTTP ${result.statusCode}` } };
    }
    const { kind, content } = result.body;
    if (typeof content !== 'string' || !content.trim()) {
      return { ...snapshot, coverage: 'link', failure: { stage: 'parse', reason: 'Empty or unreadable response body' } };
    }
    if (kind === 'html') return { ...snapshot, coverage: 'body', content: { format: 'html', value: content } };
    if (kind === 'text') return { ...snapshot, coverage: 'body', content: decodeText(content, snapshot.truncated) };
    return { ...snapshot, coverage: 'link', unsupported: `Web response format: ${String(kind)}` };
  }
  if (result && source.includes('/mcp#') && Array.isArray(result.content)) {
    const recordKey = `${source}:${stableJson((data as Record<string, unknown>).arguments)}`;
    if (result.structuredContent !== undefined) {
      const payload = result.structuredContent;
      const truncated = isObject(payload) && (payload.truncated === true || payload.hasMore === true);
      return { ...ref, recordKey, coverage: 'body', truncated, content: { format: 'json', value: payload } };
    }
    const blocks = result.content.filter((block: unknown) => isObject(block) && block.type === 'text' &&
      typeof block.text === 'string' && block.text.trim());
    if (blocks.length === 0) return { ...ref, recordKey, coverage: 'link', unsupported: 'MCP result has no readable text or structured content' };
    return { ...ref, recordKey, coverage: 'body', content: blocks.length === 1
      ? decodeText(blocks[0].text)
      : { format: 'json', value: result.content } };
  }
  if (isObject(data) || Array.isArray(data)) {
    const truncated = isObject(data) && (data.truncated === true || data.hasMore === true);
    return { ...ref, coverage: 'body', truncated, content: { format: 'json', value: data } };
  }
  if (typeof data === 'string' && data.trim()) {
    if (/^https?:\/\/\S+$/.test(data.trim())) return { ...ref, coverage: 'link' };
    return { ...ref, coverage: 'body', content: decodeText(data) };
  }
  return { ...ref, coverage: 'link', failure: { stage: 'parse', reason: 'Saved evidence has no readable content' } };
}

function locate(snapshot: SourceSnapshot, at: Locator): Citation | undefined {
  if ('url' in at || 'query' in at) {
    const url = URL.parse(snapshot.source);
    if (!url || !['https:', 'http:'].includes(url.protocol)) return;
    if ('url' in at) return { evidenceId: snapshot.evidenceId, locator: at, raw: snapshot.source };
    const values = url.searchParams.getAll(at.query);
    if (values.length === 1) return { evidenceId: snapshot.evidenceId, locator: at, raw: values[0] };
    return;
  }
  const content = snapshot.content;
  if (!content) return;
  if ('pointer' in at) {
    if (content.format !== 'json' || (at.pointer && !at.pointer.startsWith('/')) || /~(?![01])/.test(at.pointer)) return;
    let value = content.value;
    for (const segment of at.pointer === '' ? [] : at.pointer.slice(1).split('/')) {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(value) ? !/^(0|[1-9]\d*)$/.test(key) : !isObject(value)) return;
      if (!Object.hasOwn(value as object, key)) return;
      value = (value as Record<string, unknown>)[key];
    }
    if (value !== undefined) return { evidenceId: snapshot.evidenceId, locator: at, raw: value };
    return;
  }
  if (content.format === 'json' || typeof content.value !== 'string' || !at.quote.trim()) return;
  const offset = at.offset ?? content.value.indexOf(at.quote);
  if (!Number.isInteger(offset) || offset < 0 || !content.value.startsWith(at.quote, offset)) return;
  if (at.offset === undefined && content.value.indexOf(at.quote, offset + 1) !== -1) return;
  return { evidenceId: snapshot.evidenceId, locator: { quote: at.quote, offset }, raw: at.quote };
}

function checkContext(snapshot: SourceSnapshot, expected: Record<string, Scalar>, checks: Check[] = []): CheckResult[] {
  return Object.entries(expected).map(([field, value]) => {
    const check = checks.find(item => item.field === field);
    const located = check && locate(snapshot, check.at);
    const citation = located && isScalar(located.raw) ? located : undefined;
    const literal = check?.literal ?? value;
    const status = !citation || (!isDeepStrictEqual(literal, value) && !check?.mapping?.trim())
      ? 'unverified' : isDeepStrictEqual(citation.raw, literal) ? 'matched' : 'mismatch';
    return { field, expected: value, status, citation, mapping: check?.mapping };
  });
}

function numberValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) || (Number.isFinite(raw) && !Number.isInteger(raw)) ? raw : undefined;
  if (typeof raw !== 'string') return;
  const text = raw.trim().replace(/^−/, '-');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return;
  const value = Number(text.replaceAll(',', ''));
  if (Number.isFinite(value) && (Number.isSafeInteger(value) || !Number.isInteger(value))) return value;
}

function instant(raw: string) {
  // Never let Date.parse treat a wall clock as the system's local time.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) &&
    validWall(raw.replace(/Z$|[+-]\d{2}:\d{2}$/, '')) ? Date.parse(raw) : NaN;
}

function instantOrder(a: string, b: string) {
  const difference = instant(a) - instant(b);
  if (difference !== 0) return difference;
  const fraction = (value: string) => /:\d{2}\.(\d+)/.exec(value)?.[1].replace(/0+$/, '') ?? '';
  return fraction(a).localeCompare(fraction(b));
}

function validWall(raw: string) {
  const day = raw.slice(0, 10);
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day &&
    !/T(?:2[4-9]|[3-9]\d):/.test(raw);
}

function timeValue(snapshot: SourceSnapshot, candidate: TimeCandidate) {
  const citation = locate(snapshot, candidate.at);
  if (!citation || !isScalar(citation.raw)) return;
  const original = String(citation.raw);
  const epoch = candidate.epochUnit ? numberValue(citation.raw) : undefined;
  const epochDate = epoch === undefined ? undefined : new Date(epoch * (candidate.epochUnit === 's' ? 1000 : 1));
  if (candidate.epochUnit && (!epochDate || !Number.isFinite(epochDate.getTime()))) return;
  const iso = epochDate?.toISOString() ?? candidate.value ?? original;
  if ((candidate.value !== undefined || candidate.zone) && !candidate.mapping?.trim()) return;
  const zoneCitation = candidate.zoneBasis && locate(snapshot, candidate.zoneBasis.at);
  const zoneVerified = Boolean(zoneCitation && candidate.zoneBasis?.literal.trim() &&
    typeof zoneCitation.raw === 'string' && zoneCitation.raw.includes(candidate.zoneBasis.literal));
  const zone = zoneVerified ? candidate.zone : undefined;
  const zoneBasis = zoneVerified ? { citation: zoneCitation, literal: candidate.zoneBasis!.literal } : undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && validWall(iso)) {
    return { citation, time: { original, precision: 'date', zone } as SourceTime, local: iso, zoneBasis };
  }
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(iso);
  if (!parts) return;
  const [, minutes, seconds = '', fraction = '', offset] = parts;
  const local = minutes + seconds + fraction;
  const wall = instant(`${local}Z`);
  if (!Number.isFinite(wall)) return;
  if (offset && !epochDate && iso !== original && !zoneVerified && !/(?:Z|[+-]\d{2}:\d{2})$/.test(original)) return;
  let timestamp = offset ? instant(iso) : NaN;
  if (offset && !Number.isFinite(timestamp)) return;
  if (zone) {
    try {
      const format = new Intl.DateTimeFormat('sv-SE', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
      const expected = minutes + (seconds || ':00');
      const wallAt = (t: number) => format.format(t).replace(' ', 'T');
      if (offset) {
        if (wallAt(timestamp) !== expected) return;
      } else {
        const offsets = new Set([-86400000, 0, 86400000].map(delta =>
          Date.parse(`${wallAt(wall + delta)}Z`) - Math.floor((wall + delta) / 1000) * 1000));
        const matches = [...offsets].map(delta => wall - delta).filter(t => wallAt(t) === expected);
        // Ambiguous/nonexistent local times retain the wall clock with no exact conversion.
        if (matches.length === 1) timestamp = matches[0];
      }
    } catch { return; }
  }
  const precision = fraction ? 'fraction' : seconds ? 'second' : 'minute';
  const time: SourceTime = { original, precision, zone: zone ?? offset };
  if (Number.isFinite(timestamp)) {
    time.utc = new Date(timestamp).toISOString();
    time.beijing = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
      ...(fraction ? { fractionalSecondDigits: 3 } : {}),
    }).format(timestamp);
  }
  return { time, citation, local, zoneBasis, epochUnit: candidate.epochUnit };
}

function versionFrom(snapshot: SourceSnapshot, input?: VersionMarker) {
  if (!input?.mapping.trim()) return;
  const marker = locate(snapshot, input.marker);
  const id = input.id && locate(snapshot, input.id);
  const supersedes = input.supersedes && locate(snapshot, input.supersedes);
  if (!marker || !isScalar(marker.raw) || (input.id && (!id || !isScalar(id.raw))) ||
      (input.supersedes && (!supersedes || !isScalar(supersedes.raw)))) return;
  return { kind: input.kind, marker, id, supersedes, mapping: input.mapping, interpretation: 'caller_mapping' as const };
}

export function normalizeSourceEvidence(
  request: SourceEvidenceRequest, snapshot: SourceSnapshot, candidates: SourceEvidenceCandidates = {},
) {
  const { evidenceId, source, retrievedAt, coverage, content, failure, unsupported } = snapshot;
  const context = {
    ...(request.object ? { object: request.object } : {}),
    ...(request.validTime ? { validTime: rangeLabel(request.validTime)! } : {}),
  };
  const scopeChecks = checkContext(snapshot, context, request.checks);
  const match = scopeChecks.some(check => check.status === 'mismatch') ? 'mismatch' :
    request.object && request.validTime && scopeChecks.every(check => check.status === 'matched') ? 'matched' : 'unverified';
  const issues = [...(snapshot.gaps ?? [])];
  if (match !== 'matched') issues.push(`Object or applicable period: ${match}`);
  const sourceRequirement = request.sourceRequirement ?? { status: 'unknown' as const, basis: 'No source-to-rule assessment' };
  if (request.market && sourceRequirement.status !== 'matched') issues.push(`Rule source requirement: ${sourceRequirement.status}`);
  const usable = content !== undefined && !failure && !unsupported && coverageKinds.indexOf(coverage) >= coverageKinds.indexOf('body');
  const facts = request.facts.flatMap(spec => {
    const picks = candidates.facts?.filter(item => item.key === spec.key) ?? [];
    if (picks.length !== 1) {
      if (picks.length > 1) issues.push(`${spec.key}: ambiguous candidate`);
      return [];
    }
    const [item] = picks;
    const citation = usable ? locate(snapshot, item.at) : undefined;
    const raw = citation?.raw;
    const selected = item.value ?? raw;
    const excerpt = item.value !== undefined && typeof raw === 'string' && raw.includes(item.value);
    const mapping = item.value !== undefined && !excerpt && raw !== item.value ? item.mapping?.trim() : undefined;
    const supported = item.value === undefined || excerpt || raw === item.value || Boolean(mapping);
    // Numbers must be read from the snapshot, even when the label or unit is mapped.
    const numericInput = item.value === undefined || (typeof raw === 'string' && raw === item.value) ||
      (excerpt && typeof raw === 'string' && raw.match(/[+−-]?\d[\d,.]*/g)?.length === 1 &&
        numberValue(raw.match(/[+−-]?\d[\d,.]*/g)?.[0]?.replace(/[,.]+$/, '')) === numberValue(selected));
    const value = spec.kind === 'number' ? (numericInput ? numberValue(selected) : undefined) :
      typeof selected === 'string' && selected.trim() ? selected : undefined;
    if (!citation || !isScalar(raw) || !supported || value === undefined) {
      issues.push(`${spec.key}: invalid citation or value`);
      return [];
    }
    const checks = checkContext(snapshot, {
      ...context,
      ...(spec.validTime ? { validTime: rangeLabel(spec.validTime)! } : {}),
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...Object.fromEntries(Object.entries(spec.qualifiers ?? {}).map(([key, v]) => [`qualifier:${key}`, v])),
    }, [...(item.checks ?? []), ...(request.checks ?? [])]);
    const checked = Boolean(request.object && (spec.validTime ?? request.validTime)) &&
      checks.every(check => check.status === 'matched');
    if (!checked) issues.push(`${spec.key}: object, period, unit or qualifiers not confirmed`);
    return [{ ...spec, object: request.object, validTime: spec.validTime ?? request.validTime,
      value, original: raw, citation, checked, checks, mapping,
      extraction: mapping ? 'caller_mapping' as const : 'literal' as const }];
  });
  const times = usable ? (candidates.times ?? []).flatMap(item => {
    const value = timeValue(snapshot, item);
    if (!value || (candidates.times ?? []).filter(t => t.key === item.key).length !== 1) {
      issues.push(`${item.key}: invalid or ambiguous time citation`);
      return [];
    }
    if (value.time.precision !== 'date' && !value.time.utc) issues.push(`${item.key}: exact instant unknown`);
    return [{ key: item.key, kind: item.kind, mapping: item.mapping, ...value }];
  }) : [];
  const official = usable ? versionFrom(snapshot, candidates.version) : undefined;
  if (candidates.version && !official) issues.push('Invalid official version citation');
  const original = usable && request.originalSource ? locate(snapshot, request.originalSource.at) : undefined;
  const commonSource = original && request.originalSource && original.raw === request.originalSource.key
    ? { key: request.originalSource.key, citation: original } : undefined;
  if (request.originalSource && !commonSource) issues.push('Original source reference not verified');
  const obtained = instant(retrievedAt);
  const asOf = request.asOf === undefined ? undefined : instant(request.asOf);
  const availableByAsOf = usable && request.asOf !== undefined && instantOrder(retrievedAt, request.asOf) <= 0;
  const historical = asOf === undefined ? undefined : {
    asOf: request.asOf!, availability: availableByAsOf ? 'available' as const : 'unknown' as const,
    basis: availableByAsOf ? 'snapshot_captured_by_as_of' : 'no_usable_snapshot_captured_by_as_of',
  };
  if (!Number.isFinite(obtained)) issues.push('Invalid host acquisition timestamp');
  if (historical?.availability === 'unknown') issues.push('No evidence that this version was available by asOf');
  const freshnessTime = times.find(time => time.key === request.freshness?.timeKey && time.kind !== 'expected');
  const ageSeconds = freshnessTime?.time.utc ? ((asOf ?? obtained) - instant(freshnessTime.time.utc)) / 1000 : NaN;
  const maxAge = request.freshness?.maxAgeSeconds;
  const freshness = !usable || match !== 'matched' || historical?.availability === 'unknown' ||
    !Number.isFinite(ageSeconds) || ageSeconds < 0 || maxAge === undefined || !Number.isFinite(maxAge) || maxAge < 0
    ? 'unknown' : ageSeconds > maxAge ? 'stale' : 'fresh';
  const missing = [...request.facts.filter(spec => !facts.some(fact => fact.key === spec.key && fact.checked)).map(spec => spec.key),
    ...(request.times ?? []).filter(key => !times.some(t => t.key === key && (t.time.precision === 'date' || t.time.utc)))];
  const minimumCoverage = request.minimumCoverage ?? 'body';
  if (coverageKinds.indexOf(coverage) < coverageKinds.indexOf(minimumCoverage)) issues.push(`Coverage below ${minimumCoverage}`);
  if (snapshot.truncated) issues.push('Capture is truncated');
  if (!content && !failure && !unsupported && coverageKinds.indexOf(minimumCoverage) >= coverageKinds.indexOf('body')) {
    issues.push('No captured body');
  }
  const waiting = times.find(t => t.key === request.waitFor && t.kind === 'expected' && t.time.utc &&
    instant(t.time.utc) > (asOf ?? obtained)) ??
    facts.find(fact => fact.key === request.waitFor && fact.checked && fact.kind === 'status' && fact.value === 'pending');
  const status = failure ? 'failed' : unsupported ? 'unsupported' :
    match === 'matched' && historical?.availability !== 'unknown' && missing.length && waiting ? 'pending' :
    issues.length || missing.length ? 'partial' : 'ok';
  const contentId = content ? createHash('sha256').update(stableJson(content)).digest('hex') : undefined;
  return {
    source, retrievedAt,
    data: {
      kind: 'normalized_source_evidence' as const,
      inputEvidenceIds: [...new Set([evidenceId, ...(request.market ? [request.market.rulesEvidenceId] : [])])],
      sourceRef: { evidenceId, recordKey: snapshot.recordKey ?? source, role: request.sourceRole, requirement: sourceRequirement, commonSource },
      scope: { question: request.question, object: request.object, validTime: request.validTime, market: request.market,
        facts: request.facts, times: request.times },
      facts, times, retrievalTime: Number.isFinite(obtained) ? new Date(obtained).toISOString() : undefined,
      version: { contentId, official, observationOnly: !official, previous: undefined as VersionRef | undefined },
      quality: { status, match, freshness, ageSeconds: freshness === 'unknown' ? undefined : ageSeconds, historical, coverage,
        minimumCoverage, format: content?.format, truncated: snapshot.truncated, captureGaps: snapshot.gaps,
        missing, issues, scopeChecks, waiting: status === 'pending' ? waiting : undefined, failure, unsupported },
      limitations: ['Citations verify captured literals and locations. Context and semantic mappings require review.',
        'Coverage describes this capture. It does not establish complete event or historical coverage.'],
    },
  };
}

export type NormalizedSourceEvidence = ReturnType<typeof normalizeSourceEvidence>;
type VersionRef = { evidenceId: string; normalizedEvidenceId?: string; contentId?: string };
const refFor = (item: NormalizedSourceEvidence, normalizedEvidenceId?: string): VersionRef => ({
  evidenceId: item.data.sourceRef.evidenceId, normalizedEvidenceId, contentId: item.data.version.contentId,
});

type EvidenceChange = { kind: 'number' | 'state' | 'text' | 'schedule' | 'time' | 'content' | 'availability' | 'official_version';
  key: string; before: unknown; after: unknown; delta?: number };

export function compareSourceEvidence(before: NormalizedSourceEvidence | undefined, after: NormalizedSourceEvidence) {
  const current = after.data;
  const previous = before?.data;
  const changes: EvidenceChange[] = [];
  const conflicts: EvidenceChange[] = [];
  const reasons: string[] = [];
  const inputEvidenceIds = [...new Set([...(previous?.inputEvidenceIds ?? []), ...current.inputEvidenceIds])];
  const result = (status: 'baseline' | 'unchanged' | 'changed' | 'incomparable') => ({
    source: after.source, retrievedAt: after.retrievedAt, data: {
      kind: 'source_evidence_comparison' as const, status, inputEvidenceIds,
      before: before && refFor(before), after: refFor(after), changes, conflicts, reasons,
      previousCheck: previous?.quality, currentCheck: current.quality,
      coverageNote: 'Comparison covers these captures only.',
    },
  });
  const unusable = (item: typeof current) =>
    ['failed', 'unsupported', 'pending'].includes(item.quality.status) || item.quality.historical?.availability === 'unknown' ||
    coverageKinds.indexOf(item.quality.coverage) < coverageKinds.indexOf('body') || !item.version.contentId || !item.retrievalTime;
  if (previous && previous.quality.status !== current.quality.status) {
    changes.push({ kind: 'availability', key: 'status', before: previous.quality.status, after: current.quality.status });
  }
  if (unusable(current) || (previous && unusable(previous))) {
    reasons.push('One or more captures lack usable evidence for this comparison');
    return result('incomparable');
  }
  if (current.quality.match !== 'matched' || (previous && previous.quality.match !== 'matched')) {
    reasons.push('Object or applicable period not aligned');
    return result('incomparable');
  }
  if (!previous || !before) return result('baseline');

  const identity = (item: typeof current) => ({
    object: item.scope.object, validTime: item.scope.validTime, market: item.scope.market?.id,
    facts: item.scope.facts.map(({ name: _name, ...fact }) => ({
      ...fact, qualifiers: fact.qualifiers ?? {}, validTime: fact.validTime ?? item.scope.validTime,
    })).sort((a, b) => a.key.localeCompare(b.key)),
    times: [...(item.scope.times ?? [])].sort(),
  });
  if (stableJson(identity(previous)) !== stableJson(identity(current))) {
    reasons.push('Object, market, period, fact keys, units, or qualifiers differ');
    return result('incomparable');
  }
  const sameSource = previous.sourceRef.recordKey === current.sourceRef.recordKey;
  const sameOrigin = (previous.sourceRef.commonSource?.key ?? previous.sourceRef.recordKey) ===
    (current.sourceRef.commonSource?.key ?? current.sourceRef.recordKey) ||
    (previous.sourceRef.commonSource?.key ?? before.source) === (current.sourceRef.commonSource?.key ?? after.source);
  if (!sameSource) reasons.push(sameOrigin ? 'Attributed to a common origin; captures are not independent' : 'Different source identities');
  if (sameSource && instantOrder(before.retrievedAt, after.retrievedAt) > 0) {
    reasons.push('Snapshots are out of acquisition order');
    return result('incomparable');
  }
  const sameContent = previous.version.contentId === current.version.contentId;
  let comparableFacts = 0;
  for (const old of previous.facts.filter(fact => fact.checked)) {
    const next = current.facts.find(fact => fact.key === old.key && fact.checked);
    if (!next) continue;
    comparableFacts++;
    if (old.value !== next.value && sameSource && sameContent) {
      reasons.push(`Conflicting extraction from identical content: ${old.key}`);
    } else if (old.value !== next.value && (sameSource || !sameOrigin)) {
      const delta = sameSource && typeof old.value === 'number' && typeof next.value === 'number' ? next.value - old.value : undefined;
      (sameSource ? changes : conflicts).push( { kind: old.kind === 'status' ? 'state' : old.kind,
        key: old.key, before: old, after: next, delta: delta !== undefined && Number.isFinite(delta) ? delta : undefined });
    }
  }
  if (!sameSource) return result('incomparable');

  let comparableTimes = 0;
  for (const old of previous.times) {
    const next = current.times.find(time => time.key === old.key && time.kind === old.kind);
    if (!next) continue;
    const dateOnly = old.time.precision === 'date' && next.time.precision === 'date';
    if (!dateOnly && (!old.time.utc || !next.time.utc || old.time.precision !== next.time.precision)) continue;
    comparableTimes++;
    if (dateOnly ? old.local !== next.local : old.time.utc !== next.time.utc) {
      if (sameContent) {
        reasons.push(`Conflicting time extraction from identical content: ${old.key}`);
        continue;
      }
      changes.push({ kind: old.kind === 'expected' ? 'schedule' : 'time', key: old.key, before: old, after: next });
    }
  }
  if (comparableFacts < current.scope.facts.length ||
      comparableTimes < new Set([...(current.scope.times ?? []), ...current.times.map(t => t.key), ...previous.times.map(t => t.key)]).size) {
    reasons.push('Some facts or times are missing, unconfirmed, or have incompatible precision');
  }
  if (previous.quality.status !== 'ok' || current.quality.status !== 'ok') reasons.push('At least one capture has coverage or verification gaps');
  const comparableContent = !previous.quality.truncated && !current.quality.truncated &&
    !previous.quality.captureGaps?.length && !current.quality.captureGaps?.length &&
    previous.quality.coverage === current.quality.coverage && previous.quality.format === current.quality.format &&
    coverageKinds.indexOf(current.quality.coverage) >= coverageKinds.indexOf(previous.quality.minimumCoverage) &&
    coverageKinds.indexOf(current.quality.coverage) >= coverageKinds.indexOf(current.quality.minimumCoverage);
  if (!comparableContent) reasons.push('Content capture formats or coverage differ or are incomplete');
  if (comparableContent && !sameContent) {
    changes.push({ kind: 'content', key: 'contentId', before: previous.version.contentId, after: current.version.contentId });
  }
  const oldVersion = previous.version.official;
  const newVersion = current.version.official;
  if (newVersion && oldVersion?.id && newVersion.kind !== 'issued' && newVersion.supersedes?.raw === oldVersion.id.raw &&
      !sameContent) {
    changes.push({ kind: 'official_version', key: newVersion.kind, before: oldVersion, after: newVersion });
  }
  if (changes.some(change => change.kind !== 'availability')) return result('changed');
  return result(reasons.length ? 'incomparable' : changes.length ? 'changed' : 'unchanged');
}

const str = { type: 'string' } as const;
const reqStr = { ...str, required: true } as const;
const obj = <const T extends ParameterSchemaSpec>(properties: T) =>
  ({ type: 'object', additionalProperties: false, properties } as const);
const list = <const T extends ValueSchemaSpec>(items: T) => ({ type: 'array', items } as const);
const choice = <const T extends readonly string[]>(values: T) => ({ ...str, enum: values } as const);
const period = { oneOf: [str, obj({ start: reqStr, end: reqStr })] } as const;
const pathLocation = obj({ pointer: { ...reqStr, description: 'RFC 6901 path in decoded JSON. Empty string references the root.' } });
const quoteLocation = obj({ quote: { ...reqStr, description: 'Exact substring of the saved body, including any HTML markup.' },
  offset: { type: 'integer', description: 'Zero-based UTF-16 index, required if the quote appears more than once.' } });
const bodyLocation = { oneOf: [pathLocation, quoteLocation] } as const;
const location = { oneOf: [
  pathLocation, quoteLocation,
  obj({ url: { type: 'boolean', const: true, required: true, description: 'Use the actual host-recorded source URL.' } }),
  obj({ query: { ...reqStr, description: 'Read a single named parameter from the host-recorded source URL.' } }),
] } as const;
const checks = list(obj({
  field: { ...reqStr, description: 'object, validTime, unit, or qualifier:<key>.' },
  at: { ...location, required: true },
  literal: { oneOf: [str, { type: 'number' }, { type: 'boolean' }] },
  mapping: { ...str, description: 'Explain why the exact source literal maps to the expected scope value.' },
}));
const factScopes = list(obj({
  key: reqStr, name: reqStr, kind: { ...choice(['number', 'status', 'text']), required: true },
  unit: str, validTime: period,
  qualifiers: { type: 'object', additionalProperties: true, description: 'Expected qualifier keys and scalar values.' },
}));
const located = {
  key: reqStr, at: { ...bodyLocation, required: true } as const, value: str,
  mapping: { ...str, description: 'Explain any interpretation of the cited raw value.' },
};
const output = {
  schema: str,
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
};

type NormalizationPlan = { request: SourceEvidenceRequest; candidates?: SourceEvidenceCandidates };

const binancePricePath = /^\/(0|[1-9]\d*)\/([1-4])$/;
function binanceKlineURL(snapshot: SourceSnapshot) {
  const url = URL.parse(snapshot.source);
  if (url?.protocol === 'https:' && ['data-api.binance.vision', 'api.binance.com'].includes(url.host) &&
      url.pathname === '/api/v3/klines' && !snapshot.truncated && snapshot.content?.format === 'json') return url;
}

function legacyKlinePointer(snapshot: SourceSnapshot, request: SourceEvidenceRequest, candidates?: SourceEvidenceCandidates) {
  if (!binanceKlineURL(snapshot) || request.facts.length !== 1 || request.facts[0].kind !== 'number' ||
      request.originalSource || request.waitFor || request.freshness || candidates?.version || candidates?.times?.length ||
      candidates?.facts?.length && (candidates.facts.length !== 1 || candidates.facts[0].key !== request.facts[0].key)) return;
  const recorded = candidates?.facts?.[0];
  // Complete advanced requests retain their caller's scope and fact keys.
  const fields = new Set([...(request.checks ?? []), ...(recorded?.checks ?? [])].map(check => check.field));
  if (['object', 'validTime', 'unit'].every(field => fields.has(field))) return;
  if (Object.keys(request.facts[0].qualifiers ?? {}).some(key => !['interval', 'closeAt'].includes(key))) return;
  const periods = [request.validTime, request.facts[0].validTime, ...(request.times ?? [])].filter(x => x !== undefined);
  if (periods.some(period => typeof period !== 'string' || !Number.isFinite(instant(period)))) return;
  const paths = new Set([...request.question.matchAll(/(?<![\w/])(\/\d+\/\d+)(?![\w/])/g)].map(match => match[1]!));
  if (recorded) {
    if (!('pointer' in recorded.at)) return;
    paths.add(recorded.at.pointer);
  }
  if (!paths.size || [...paths].every(path => !binancePricePath.test(path))) return;
  if (paths.size !== 1) throw new Error('Conflicting Binance price paths. Select one explicit field in the saved candle.');
  const pointer = [...paths][0]!;
  const open = locate(snapshot, { pointer: pointer.replace(/\d+$/, '0') })?.raw;
  if (periods.some(period => instant(period as string) !== open)) {
    throw new Error('The requested period does not match the selected Binance kline open time.');
  }
  return pointer;
}

// Binance Spot's positional response supplies these checks without asking the
// caller to transcribe the candle. Other sources use explicit candidates.
function binancePricePlan(snapshot: SourceSnapshot, pointer: string, rules?: EvidenceRow): NormalizationPlan {
  const index = binancePricePath.exec(pointer);
  if (!binanceKlineURL(snapshot) || !index) {
    throw new Error('The pointer shortcut requires a saved Binance Spot kline and its exact Open, High, Low, or Close JSON pointer. For other sources supply request and candidates.');
  }
  const symbol = locate(snapshot, { query: 'symbol' })?.raw;
  const interval = locate(snapshot, { query: 'interval' })?.raw;
  const row = `/${index[1]}`;
  const open = locate(snapshot, { pointer: `${row}/0` })?.raw;
  const close = locate(snapshot, { pointer: `${row}/6` })?.raw;
  if (typeof symbol !== 'string' || !/^[A-Z0-9]+$/.test(symbol) ||
      typeof interval !== 'string' || !/^[1-9]\d*[smhdwM]$/.test(interval) ||
      typeof open !== 'number' || !Number.isSafeInteger(open) || typeof close !== 'number' || !Number.isSafeInteger(close) ||
      open < 0 || close <= open || close >= instant(snapshot.retrievedAt) || !Number.isFinite(instant(snapshot.retrievedAt)) ||
      !Number.isFinite(new Date(open).getTime()) || numberValue(locate(snapshot, { pointer })?.raw) === undefined) {
    throw new Error('The saved Binance response does not confirm a closed kline, symbol, interval and selected price.');
  }
  const ruleData = isObject(rules?.data) ? rules.data : undefined;
  const rule = typeof ruleData?.rules === 'string' ? ruleData.rules : '';
  const quoteInRule = [...rule.matchAll(/\b([A-Z0-9]+)[/_]([A-Z0-9]+)\b/g)]
    .find(match => match[1] + match[2] === symbol)?.[2];
  const unit = quoteInRule ?? ['USDT', 'USDC'].find(asset => symbol.length > asset.length && symbol.endsWith(asset));
  if (!unit) throw new Error('Quote asset is unknown. Supply matching market rules or explicit unit evidence.');
  const price = ['open', 'high', 'low', 'close'][Number(index[2]) - 1]!;
  const market = rules && { id: String(ruleData?.localMarketId), rulesEvidenceId: rules.evidenceId };
  const matchesRule = Boolean(quoteInRule && /binance\.com\/[^\s]+/i.test(rule) &&
    rule.toLowerCase().includes(price) && rule.includes(interval));
  return {
    request: {
      question: `Binance Spot ${symbol} ${interval} kline ${price}`, object: symbol,
      validTime: new Date(open).toISOString(), market, sourceRole: 'primary',
      sourceRequirement: market ? { status: matchesRule ? 'matched' : 'unknown',
        basis: 'Compare venue, symbol, interval and price field against the saved market rules' } : undefined,
      facts: [{ key: price, name: `${interval} ${price} price`, kind: 'number', unit,
        qualifiers: { interval, closeAt: close } }],
      checks: [
        { field: 'object', at: { query: 'symbol' } },
        { field: 'validTime', at: { pointer: `${row}/0` }, literal: open, mapping: 'Kline open time in Unix milliseconds' },
        { field: 'unit', at: { query: 'symbol' }, literal: symbol, mapping: 'Quote asset of the Binance Spot symbol' },
        { field: 'qualifier:interval', at: { query: 'interval' } },
        { field: 'qualifier:closeAt', at: { pointer: `${row}/6` } },
      ],
    },
    candidates: { facts: [{ key: price, at: { pointer } }] },
  };
}

type EvidenceAccess = {
  loadEvidence: (id: string, signal: AbortSignal) => EvidenceRow | undefined | Promise<EvidenceRow | undefined>;
  saveEvidence: (source: string, data: unknown, retrievedAt: string) => EvidenceRow | Promise<EvidenceRow>;
  loadMarketRules?: (id: number, signal: AbortSignal) => Promise<EvidenceRow>;
};

export function createSourceEvidenceTools({ loadEvidence, saveEvidence, loadMarketRules }: EvidenceAccess) {
  async function load(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const row = id.trim() && await loadEvidence(id, signal);
    if (!row || row.evidenceId !== id) throw new Error(`Evidence not found: ${id}`);
    return row;
  }

  async function loadNormalized(id: string, signal: AbortSignal) {
    const row = await load(id, signal);
    if (!isObject(row.data) || row.data.kind !== 'normalized_source_evidence') {
      throw new Error(`Expected normalized source evidence: ${id}`);
    }
    const snapshot = { ...row, data: row.data as NormalizedSourceEvidence['data'] & { normalizationPlan?: NormalizationPlan } };
    await load(snapshot.data.sourceRef.evidenceId, signal);
    if (snapshot.data.scope.market) await load(snapshot.data.scope.market.rulesEvidenceId, signal);
    return snapshot;
  }

  async function rulesFor(id: number, signal: AbortSignal, savedId?: string) {
    if (!Number.isSafeInteger(id) || id <= 0 || (!savedId && !loadMarketRules)) {
      throw new Error('The Binance price check requires a valid local market ID and an available market rules reader.');
    }
    const rules = savedId ? await load(savedId, signal) : await loadMarketRules!(id, signal);
    if (!isObject(rules.data) || String(rules.data.localMarketId) !== String(id) || typeof rules.data.rules !== 'string') {
      throw new Error('Market rules evidence does not match the requested local market.');
    }
    return rules;
  }

  return [
    defineTool({
      name: 'normalize_source_evidence',
      description: 'Verify facts against saved raw evidence. For a Binance Spot kline use {evidenceId,pointer,marketId}, with an exact path such as /0/4 for Close, and omit request and candidates. To repeat the same normalization use {evidenceId,previousEvidenceId} with the previous normalized ID. Other sources require request plus candidates with same-key fact locators and object/time/unit checks.',
      parameters: {
        evidenceId: reqStr,
        previousEvidenceId: { ...str, description: 'Prior normalized evidence ID. With evidenceId alone, reapply its saved plan.' },
        pointer: { ...str, description: 'Exact Binance Spot price path from the request, e.g. /0/4 for Close. Omit request and candidates in this mode.' },
        marketId: { type: 'integer', description: 'Requested local market ID for the Binance pointer shortcut. The host reads its rules.' },
        request: obj({
          question: reqStr, object: str, validTime: period,
          market: obj({ id: reqStr, rulesEvidenceId: reqStr }),
          facts: { ...factScopes, required: true }, times: list(str), checks, minimumCoverage: choice(coverageKinds), asOf: str,
          freshness: obj({ timeKey: reqStr, maxAgeSeconds: { type: 'number', required: true } }),
          sourceRole: choice(['primary', 'republication', 'secondary']),
          sourceRequirement: obj({ status: { ...choice(['matched', 'mismatch', 'unknown']), required: true }, basis: reqStr }),
          originalSource: obj({ key: reqStr, at: { ...bodyLocation, required: true } }),
          waitFor: { ...str, description: 'Key of a cited future event time or a cited status fact mapped to pending.' },
        }),
        candidates: obj({
          facts: list(obj({ ...located, checks })),
          times: list(obj({ ...located, kind: { ...choice(timeKinds), required: true },
            zone: { ...str, description: 'IANA source time zone, applied only with a verified zoneBasis.' },
            zoneBasis: obj({ at: { ...bodyLocation, required: true }, literal: reqStr }),
            epochUnit: { ...choice(['s', 'ms']), description: 'Unix epoch unit of the cited numeric field.' } })),
          version: obj({
            kind: { ...choice(['issued', 'revised', 'withdrawn']), required: true },
            marker: { ...bodyLocation, required: true }, mapping: reqStr, id: bodyLocation, supersedes: bodyLocation,
          }),
        }),
      },
      output,
      async execute({ evidenceId, previousEvidenceId, pointer, marketId, request, candidates }, { signal }) {
        const raw = await load(evidenceId, signal);
        if (isObject(raw.data) && ['normalized_source_evidence', 'source_evidence_comparison'].includes(String(raw.data.kind))) {
          throw new Error('Expected a raw source snapshot');
        }
        const snapshot = sourceSnapshotFromEvidence(raw);
        const previous = previousEvidenceId ? await loadNormalized(previousEvidenceId, signal) : undefined;
        let plan: NormalizationPlan;
        if (pointer) {
          if (request || candidates) throw new Error('For the Binance pointer shortcut send evidenceId, pointer and marketId only, with optional previousEvidenceId.');
          plan = binancePricePlan(snapshot, pointer, marketId === undefined ? undefined : await rulesFor(marketId, signal));
        } else if (request && marketId === undefined) {
          const legacy = request as SourceEvidenceRequest;
          const legacyPointer = legacyKlinePointer(snapshot, legacy, candidates);
          if (!legacyPointer) plan = { request: legacy, candidates };
          else {
            const ids = new Set([...legacy.question.matchAll(/\blocal:(\d+)\b/gi)].map(match => match[1]!));
            if (legacy.market) ids.add(legacy.market.id);
            if (ids.size > 1) throw new Error('Conflicting local market IDs in the Binance price request.');
            const market = [...ids][0];
            const rules = market === undefined ? undefined : await rulesFor(Number(market), signal, legacy.market?.rulesEvidenceId);
            plan = binancePricePlan(snapshot, legacyPointer, rules);
            for (const [key, value] of Object.entries(legacy.facts[0].qualifiers ?? {})) {
              if (plan.request.facts[0].qualifiers?.[key] !== value) throw new Error(`The saved Binance kline does not match ${key}.`);
            }
            plan.request.asOf = legacy.asOf;
            plan.request.minimumCoverage = legacy.minimumCoverage;
          }
        } else if (!request && !candidates && marketId === undefined && previous?.data.normalizationPlan) {
          plan = previous.data.normalizationPlan;
        } else {
          throw new Error('Supply a Binance pointer, an explicit request with candidates, or a previous normalized evidence ID with a saved plan.');
        }
        const { request: scope, candidates: locatedFacts } = plan;
        if (!scope.question.trim() || new Set(scope.facts.map(spec => spec.key)).size !== scope.facts.length ||
            scope.facts.some(spec => !spec.key.trim() || Object.values(spec.qualifiers ?? {}).some(value => !isScalar(value)))) {
          throw new Error('A question, unique non-empty fact keys and scalar qualifiers are required');
        }
        if (snapshot.content && !snapshot.failure && !snapshot.unsupported && scope.facts.length && !locatedFacts?.facts) {
          throw new Error('request.facts declares scope. Add candidates.facts with the same key and an exact location per fact, or use the Binance pointer shortcut. Supply [] when the fact is absent from the capture.');
        }
        if (scope.market?.rulesEvidenceId && scope.market.rulesEvidenceId !== evidenceId) {
          await load(scope.market.rulesEvidenceId, signal);
        }
        const normalized = normalizeSourceEvidence(scope, snapshot, locatedFacts);
        if (previous) {
          const a = previous.data;
          const b = normalized.data;
          if (a.sourceRef.recordKey !== b.sourceRef.recordKey || a.scope.object !== b.scope.object ||
              !isDeepStrictEqual(a.scope.validTime, b.scope.validTime) || a.scope.market?.id !== b.scope.market?.id ||
              !a.retrievalTime || !b.retrievalTime || instantOrder(previous.retrievedAt, raw.retrievedAt) > 0) {
            throw new Error('Previous version must have the same source, object and period, at an earlier or equal acquisition time');
          }
          b.version.previous = refFor(previous, previous.evidenceId);
          b.inputEvidenceIds = [...new Set([...b.inputEvidenceIds, previous.evidenceId, a.sourceRef.evidenceId])];
        }
        signal.throwIfAborted();
        const saved = await saveEvidence(normalized.source, { ...normalized.data, normalizationPlan: plan }, normalized.retrievedAt);
        return JSON.stringify({ ...saved, data: normalized.data });
      },
    }),
    defineTool({
      name: 'compare_source_evidence',
      description: 'Compare normalized evidence IDs. First baseline: pass afterEvidenceId only. Repeated check: pass the original normalized ID as beforeEvidenceId and the repeat result as afterEvidenceId. Report returned status and changes directly in chat.',
      parameters: { afterEvidenceId: reqStr, beforeEvidenceId: str },
      output,
      async execute({ afterEvidenceId, beforeEvidenceId }, { signal }) {
        const after = await loadNormalized(afterEvidenceId, signal);
        const before = beforeEvidenceId ? await loadNormalized(beforeEvidenceId, signal) : undefined;
        const compared = compareSourceEvidence(before, after);
        compared.data.before = before && refFor(before, before.evidenceId);
        compared.data.after = refFor(after, after.evidenceId);
        compared.data.inputEvidenceIds = [...new Set([after.evidenceId, ...(before ? [before.evidenceId] : []), ...compared.data.inputEvidenceIds])];
        signal.throwIfAborted();
        return JSON.stringify(await saveEvidence(compared.source, compared.data, compared.retrievedAt));
      },
    }),
  ];
}
