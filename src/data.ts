import { sourceSetting } from './source-config.js';
import { isDeepStrictEqual } from 'node:util';
import { researchEngine } from './market-data.js';

export const polymonitorUrl = sourceSetting('POLYMONITOR_URL');

export type Source = { path: string; time_field: string; max_age_seconds: number;
  checks: { field: string; equals: unknown }[] };

export function validateSources(sources: Source[], marketId: number) {
  if (!sources.length || new Set(sources.map(s => s.path)).size !== sources.length) throw new Error('来源不能为空或重复。');
  for (const s of sources) {
    if (![ `/markets/${marketId}`, `/markets/${marketId}/workspace`, `/markets/${marketId}/oracle`, `/runtime/lob/${marketId}` ].includes(s.path)
      && !/^\/runtime\/panels\/[a-z0-9-]+\?limit=10$/.test(s.path)) throw new Error(`来源超出任务市场或 Panel 范围: ${s.path}`);
    if (!(s.max_age_seconds > 0) || /(^|\.)(generatedAt|retrievedAt)$/.test(s.time_field)) throw new Error('需要来源观察时间字段和正数时效阈值，不能用响应生成时间。');
  }
}

export function sourceCoverage(source: Source, data: unknown, at: string) {
  const field = (path: string) => path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | null)?.[key], data);
  const observedAt = field(source.time_field);
  const timestamp = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  const ageSeconds = (Date.parse(at) - timestamp) / 1000;
  const checks = source.checks.map(check => ({ ...check, actual: field(check.field), passed: isDeepStrictEqual(field(check.field), check.equals) }));
  const sourceIssues = ['error', 'partial', 'degraded', 'unavailable', 'unknown'].includes(String(field('status')).toLowerCase())
    || Number(field('failedSources.length') ?? 0) > 0;
  const status = !Number.isFinite(timestamp) || ageSeconds < 0 ? 'unknown'
    : ageSeconds > source.max_age_seconds || field('stale') === true || field('status') === 'stale' ? 'stale'
    : sourceIssues || checks.some(c => !c.passed) ? 'partial' : 'covered';
  return { status, observedAt: observedAt ?? null, ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null, sourceIssues, checks };
}

export async function readMarketData(path: string, signal?: AbortSignal) {
  const url = `${polymonitorUrl}${path}`;
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw new Error(`Polymonitor ${path}: HTTP ${response.status}`);
  return { source: url, retrievedAt: new Date().toISOString(), data: await response.json() };
}

export async function resolveMarket(input: string, signal?: AbortSignal) {
  return researchEngine('resolve', { input }, signal);
}
