import { prepareIndicator } from './crypto-indicator-catalog.js';
import { cryptoIntervals, normalizeCryptoSymbol } from './crypto-indicators.js';
import { marketStudyIntervalError } from './crypto-indicator-sources.js';
import type { Watch } from './store.js';

const comparisons = ['above', 'at_or_above', 'below', 'at_or_below', 'crosses_above', 'crosses_below'] as const;
type Comparison = typeof comparisons[number];
const text = { type: 'string', required: true } as const;

export const cryptoWatchSchema = {
  type: 'object', additionalProperties: false, description: '单一交易对和指标的持续条件，使用已收盘行情或对应来源的有效观测。',
  properties: {
    symbol: text,
    interval: { ...text, enum: Object.keys(cryptoIntervals) },
    indicator_id: text,
    parameters: { type: 'json', description: '指标参数对象，例如 {"period":14}。' },
    value_field: { type: 'string', description: '多值指标必填，例如 MACD 的 histogram 或 BBANDS 的 upper。' },
    comparison: { ...text, enum: comparisons },
    threshold: { type: 'number', required: true },
    notify_on_initial: { type: 'boolean', description: '阈值条件首次读到已满足时通知，默认 true。穿越条件始终比较连续的最后两根收盘值。' },
  },
} as const;

export function prepareCryptoWatch(input: {
  symbol: string; interval: string; indicator_id: string; parameters?: unknown; value_field?: string;
  comparison: string; threshold: number; notify_on_initial?: boolean;
}) {
  const symbol = normalizeCryptoSymbol(input.symbol);
  if (!symbol || symbol.length > 48 || /[\s/]/.test(symbol)) throw new Error('请提供 Binance 现货完整交易对。');
  if (!Object.hasOwn(cryptoIntervals, input.interval)) throw new Error('指标 K 线周期无效。');
  if (!comparisons.includes(input.comparison as Comparison) || !Number.isFinite(input.threshold)) {
    throw new Error('指标盯盘需要有效的比较方式和有限数值阈值。');
  }
  const valueField = input.value_field?.trim();
  if (valueField !== undefined && !/^[a-zA-Z]\w*$/.test(valueField)) throw new Error('请提供指标实际返回的数字字段名。');
  const { id, parameters, input: source } = prepareIndicator({ id: input.indicator_id, parameters: input.parameters });
  const interval = input.interval as keyof typeof cryptoIntervals;
  if (source === 'futures' || source === 'onchain') {
    const unsupported = marketStudyIntervalError(id, interval, cryptoIntervals[interval] * 1000);
    if (unsupported) throw new Error(unsupported);
  }
  if (id === 'ADR' && interval !== '1d') throw new Error('ADR 请使用 1d。');
  return {
    symbol, interval, indicator: { id, parameters },
    valueField, comparison: input.comparison as Comparison, threshold: input.threshold, notifyOnInitial: input.notify_on_initial ?? true,
  };
}

export type CryptoWatch = ReturnType<typeof prepareCryptoWatch>;

export function cryptoWatchPlan(watch: Watch) {
  if (watch.market_id !== null) return;
  const config = JSON.parse(watch.notify_when);
  return config?.indicator ? config as CryptoWatch : undefined;
}

export const cryptoWatchPrompt = '执行当前原生唤醒的 Crypto 指标检查。';
export function cryptoWatchSource(marketType: string | undefined) {
  return marketType === 'usd_m_perpetual' ? 'binance_usdm_indicators'
    : marketType === 'bitcoin_onchain' ? 'bitcoin_onchain_indicators'
      : marketType === 'spot' ? 'binance_spot_indicators' : 'crypto_indicators';
}

export function cryptoOccurrence(messages: string[], scheduleId: string | null) {
  if (!scheduleId) return;
  const times: string[] = [];
  for (const message of messages) {
    if (message.startsWith('[SCHEDULE REMINDER BATCH]\n')) {
      const batch = message.match(/^reminders_json: (.+)$/m)?.[1];
      if (!batch) continue;
      const entries = JSON.parse(batch) as { schedule_id: string; occurrence_at: string }[];
      times.push(...entries.filter(entry => entry.schedule_id === scheduleId).map(entry => entry.occurrence_at));
    } else if (message.startsWith('[SCHEDULE REMINDER]\n') && message.includes(`\nschedule_id_json: ${JSON.stringify(scheduleId)}\n`)) {
      const time = message.match(/^occurrence_at: (.+)$/m)?.[1];
      if (time) times.push(time);
    }
  }
  return times.filter(time => Number.isFinite(Date.parse(time))).sort().at(-1);
}

type IndicatorResult = {
  symbol: string; interval: string; status: string; reason?: string; sourceUrl: string; retrievedAt: string | null;
  marketType?: string; venue?: string;
  coverage?: { lastCloseAt: string | null; continuousBars: number } | null;
  indicators: { id: string; status: string; latest: unknown; previous: unknown; reason?: string;
    observedAt?: string | null; sourceUrl?: string; provider?: string }[];
  evidenceId?: string; evidenceError?: string;
};

export function observeCryptoWatch(config: CryptoWatch, group: IndicatorResult | undefined) {
  const indicator = group?.indicators[0];
  const at = group?.coverage?.lastCloseAt ?? indicator?.observedAt;
  const base = { sourceUrl: indicator?.sourceUrl ?? group?.sourceUrl, retrievedAt: group?.retrievedAt,
    marketType: group?.marketType, provider: indicator?.provider ?? group?.venue,
    evidenceId: group?.evidenceId, lastCloseAt: at, coverage: group?.coverage,
    sourceStatus: group?.status, indicatorStatus: indicator?.status };
  const gap = (reason: string, failed = false) => ({ ...base, coverageStatus: failed ? 'failed' as const : 'partial' as const, reason });
  if (!group || group.symbol !== config.symbol || group.interval !== config.interval || indicator?.id !== config.indicator.id) {
    return gap('指标回执未确认约定的交易对、周期或指标。', true);
  }
  if (group.status !== 'ok' || indicator.status !== 'ok' || !at || !Number.isFinite(Date.parse(at)) || !group.evidenceId) {
    return gap(group.reason ?? indicator.reason ?? group.evidenceError ?? `数据或指标不可用（${group.status}/${indicator.status}）。`,
      group.status === 'error' || group.status === 'invalid_symbol' || indicator.status === 'error');
  }
  function number(value: unknown) {
    const scalar = config.valueField && value && typeof value === 'object' && Object.hasOwn(value, config.valueField)
      ? (value as Record<string, unknown>)[config.valueField] : config.valueField ? undefined : value;
    return typeof scalar === 'number' && Number.isFinite(scalar) ? scalar : null;
  }
  const latest = number(indicator.latest), previous = number(indicator.previous);
  if (latest === null) {
    const choices = indicator.latest && typeof indicator.latest === 'object'
      ? Object.entries(indicator.latest).filter(([, value]) => typeof value === 'number').map(([key]) => key) : [];
    return gap(`指标需要有效的数字值${choices.length ? `，可选字段 ${choices.join('、')}` : ''}。`);
  }
  if (config.comparison.startsWith('crosses_') && previous === null) return gap('穿越条件缺少前一根收盘指标值。');
  return { ...base, coverageStatus: 'covered' as const, latest, previous, lastCloseAt: at, evidenceId: group.evidenceId };
}

export function cryptoTrigger(config: CryptoWatch, latest: number, previous: number | null, first: boolean) {
  const { comparison, threshold } = config;
  if (comparison === 'crosses_above') return previous !== null && previous <= threshold && latest > threshold;
  if (comparison === 'crosses_below') return previous !== null && previous >= threshold && latest < threshold;
  const meets = (value: number) => comparison === 'above' ? value > threshold
    : comparison === 'at_or_above' ? value >= threshold : comparison === 'below' ? value < threshold : value <= threshold;
  return meets(latest) && ((first && config.notifyOnInitial) || (previous !== null && !meets(previous)));
}

const labels: Record<Comparison, string> = {
  above: '高于', at_or_above: '达到或高于', below: '低于', at_or_below: '达到或低于',
  crosses_above: '上穿', crosses_below: '下穿',
};

export function cryptoNotice(watch: Watch, config: CryptoWatch, observation: Extract<ReturnType<typeof observeCryptoWatch>, { coverageStatus: 'covered' }>) {
  const at = new Date(observation.lastCloseAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const metric = [config.indicator.id, config.valueField].filter(Boolean).join('.');
  const venue = observation.marketType === 'usd_m_perpetual' ? 'Binance USD-M 永续'
    : observation.marketType === 'bitcoin_onchain' ? 'Bitcoin 链上' : 'Binance 现货';
  const timeLabel = observation.marketType === 'spot' || !observation.marketType ? '收盘' : '观测';
  const parameters = Object.entries(config.indicator.parameters).map(([key, value]) => `${key}=${value}`).join('，');
  return [
    `Crypto 指标提醒 · ${watch.goal}`,
    `${venue} ${config.symbol} · ${config.interval}${timeLabel === '收盘' ? ' 已收盘' : ''}`,
    `${metric}${parameters ? `（${parameters}）` : ''} ${labels[config.comparison]}${config.threshold}`,
    `实际 ${observation.latest}${observation.previous === null ? '' : `，前值 ${observation.previous}`}`,
    `${timeLabel} ${at}（北京时间）`,
    `证据 ${observation.evidenceId}`, `任务 ${watch.id}`, observation.sourceUrl,
  ].filter(Boolean).join('\n');
}
