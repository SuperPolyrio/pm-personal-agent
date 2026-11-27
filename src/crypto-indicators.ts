import { defineTool } from '@deepseek-ai/dsh-tools';
import { indicatorCatalog, prepareIndicator, type Candle, type StudyContext } from './crypto-indicator-catalog.js';

import { profileAnchor } from './crypto-indicator-studies.js';
import { publicBody, readMarketStudy, spotUrl } from './crypto-indicator-sources.js';
const intervals = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200,
  '1d': 86400, '3d': 259200, '1w': 604800,
} as const;
export { intervals as cryptoIntervals, normalizeSymbol as normalizeCryptoSymbol };
type Interval = keyof typeof intervals;
type SaveEvidence = (source: string, data: unknown, retrievedAt: string) => { evidenceId: string };
type Prepared = ReturnType<typeof prepareIndicator>;
type MarketSeries = Awaited<ReturnType<typeof readMarketStudy>>;
const str = { type: 'string' } as const;
const output = { schema: str, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const listParameters = {
  query: { ...str, description: '按指标 ID 或名称搜索。' },
  category: { ...str, enum: [...new Set(indicatorCatalog.map(item => item.category))] },
};
const computeParameters = {
  symbols: { type: 'array', items: str, description: 'compute 必填，1 至 3 个完整交易对，例如 BTCUSDT 或 ETH/USDT。指标按目录标明的数据源计算。' },
  intervals: { type: 'array', items: { ...str, enum: Object.keys(intervals) }, description: 'compute 必填，1 至 3 个周期。' },
  indicators: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    id: { ...str, required: true, description: '目录 ID，例如 MACD、BBANDS、RSI。计算全部时只传一项 {"id":"ALL"}。' },
    parameters: { type: 'json', description: '覆盖默认参数的对象，例如 {"period":21}。' },
  } } },
  bars: { type: 'integer', description: '请求已收盘 K 线数，默认 500，支持 2 至 999。' },
  history: { type: 'integer', description: '额外返回最近 0 至 20 根已收盘 K 线的指标值，默认 0。' },
  as_of: { ...str, description: '可选历史截点，ISO 8601 且必须包含时区。只采用该时点已收盘的 K 线。' },
} as const;

function closeAt(bar: Candle) {
  return new Date(bar.closeTime + 1).toISOString();
}

function parseCandle(row: unknown, duration: number): Candle {
  if (!Array.isArray(row) || row.length < 8) throw new Error('Binance 返回了不完整的 K 线。');
  const [openTime, open, high, low, close, volume, closeTime, quoteVolume, , takerBuyVolume] = row;
  if (!Number.isSafeInteger(openTime) || openTime < 0 || !Number.isSafeInteger(closeTime) ||
      closeTime + 1 - openTime !== duration ||
      ![open, high, low, close, volume, quoteVolume].every(value =>
        typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)))) {
    throw new Error('Binance K 线的时间或数值格式无效。');
  }
  const bar: Candle = {
    openTime, closeTime, open: Number(open), high: Number(high), low: Number(low), close: Number(close),
    volume: Number(volume), quoteVolume: Number(quoteVolume),
  };
  if (typeof takerBuyVolume === 'string' && /^\d+(?:\.\d+)?$/.test(takerBuyVolume) &&
      Number(takerBuyVolume) >= 0 && Number(takerBuyVolume) <= bar.volume) bar.takerBuyVolume = Number(takerBuyVolume);
  if (bar.low <= 0 || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) {
    throw new Error('Binance K 线的 OHLC 关系无效。');
  }
  return bar;
}

function calculate(item: Prepared, candles: Candle[], history: number, data: StudyContext) {
  const calculator = item.create!(data);
  const context = { id: item.id, parameters: item.parameters, minimumBars: calculator.minimumBars };
  if (candles.length < calculator.minimumBars) {
    return { ...context, status: 'insufficient_history', latest: null, previous: null };
  }
  const keep = Math.max(2, history);
  const points: { closeTime: string; value: unknown }[] = [];
  for (const [index, bar] of candles.entries()) {
    const show = index >= candles.length - keep;
    const value = calculator.update(bar, show);
    if (show) {
      points.push({
        closeTime: closeAt(bar),
        value: index + 1 < calculator.minimumBars || value == null ||
          (typeof value === 'number' && !Number.isFinite(value)) ||
          (typeof value === 'object' && Object.values(value).some(v => typeof v === 'number' && !Number.isFinite(v)))
          ? null : value,
      });
    }
  }
  const latest = points.at(-1)?.value ?? null;
  return {
    ...context, status: latest === null ? 'unavailable' : 'ok', latest,
    previous: points.at(-2)?.value ?? null,
    ...(latest === null ? { reason: '最后收盘点没有可用的指标值。' } : {}),
    ...(history > 0 ? { history: points.slice(-history) } : {}),
  };
}

async function readCandles(sourceUrl: string, duration: number, cutoff: number, limit: number, signal: AbortSignal) {
  const { body, status: httpStatus, retrievedAt } = await publicBody(sourceUrl, signal);
  if (httpStatus !== 200) {
    let detail: { code?: number } | null = null;
    try { detail = JSON.parse(body); } catch { /* HTTP errors may return HTML. */ }
    if (detail?.code === -1121) {
      return { status: 'invalid_symbol' as const, retrievedAt, reason: 'Binance 现货没有该交易对（-1121）。' };
    }
    if (detail?.code === -1100) {
      return { status: 'invalid_symbol' as const, retrievedAt, reason: '交易对包含 Binance 不接受的字符（-1100）。' };
    }
    return { status: 'error' as const, retrievedAt, reason: `Binance 行情 HTTP ${httpStatus}。` };
  }
  const response: unknown = JSON.parse(body);
  if (!Array.isArray(response) || response.length > limit + 1) throw new Error('Binance K 线响应无效。');
  const candles = response.map(row => parseCandle(row, duration));
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].openTime <= candles[index - 1].closeTime) {
      throw new Error('Binance K 线重复、重叠或时间无序。');
    }
  }
  const closed = candles.filter(bar => bar.closeTime < cutoff).slice(-limit);
  let continuousFrom = 0;
  let gapCount = 0;
  for (let index = 1; index < closed.length; index++) {
    if (closed[index].openTime !== closed[index - 1].closeTime + 1) {
      continuousFrom = index;
      gapCount++;
    }
  }
  const newest = closed.at(-1);
  const coverage = { retrievedAt, closed, continuousFrom, gapCount };
  if (!newest) return { ...coverage, status: 'no_data' as const, reason: '查询截点前没有已收盘的 K 线。' };
  if (newest.closeTime + 1 + duration <= cutoff) {
    return { ...coverage, status: 'stale' as const, reason: '截至查询截点至少缺少最近一根应收盘的 K 线。' };
  }
  if (gapCount || closed.length < limit) {
    return { ...coverage, status: 'partial' as const,
      reason: gapCount ? 'K 线存在时间缺口，从最后一处缺口之后计算。' : '已收盘 K 线少于请求根数。' };
  }
  return { ...coverage, status: 'ok' as const };
}

function normalizeSymbol(input: string) {
  // Uppercase ordinary tickers and keep the spelling of non-ASCII Binance symbols.
  return input.trim().replace(/[a-z]/g, letter => letter.toUpperCase()).replace(/^([^\s/]+)\/([^\s/]+)$/, '$1$2');
}

async function readIntrabars(symbol: string, duration: number, start: number, end: number, signal: AbortSignal, blockDuration?: number) {
  const ceiling = Math.min(duration - 1, blockDuration ?? duration);
  const [interval, seconds] = Object.entries({ '1s': 1, ...intervals }).reverse()
    .find(([, s]) => s * 1000 <= ceiling && duration % (s * 1000) === 0 && (!blockDuration || blockDuration % (s * 1000) === 0))!;
  const step = seconds * 1000;
  const first = Math.ceil(start / step) * step;
  const count = Math.floor((end - first) / step);
  if (count <= 0 || count > 60_000) throw new Error('价格分布所需细粒度 K 线最多 60,000 根，请缩短时间范围。');
  const urls: string[] = [];
  for (let offset = 0; offset < count; offset += 1000) {
    const limit = Math.min(1000, count - offset);
    const begin = first + offset * step;
    urls.push(spotUrl({ symbol, interval, startTime: begin, endTime: begin + limit * step - 1, limit }));
  }
  const rows: Candle[] = [];
  for (let cursor = 0; cursor < urls.length; cursor += 4) {
    const group = await Promise.all(urls.slice(cursor, cursor + 4).map(async url => {
      const response = await publicBody(url, signal).then(
        result => result.status >= 500 ? publicBody(url, signal) : result,
        () => { signal.throwIfAborted(); return publicBody(url, signal); },
      );
      if (response.status !== 200) throw new Error('Binance 细粒度 K 线 HTTP ' + response.status);
      const raw: unknown = JSON.parse(response.body);
      if (!Array.isArray(raw) || raw.length > 1000) throw new Error('细粒度 K 线格式无效。');
      return raw.map(row => parseCandle(row, step));
    }));
    rows.push(...group.flat());
  }
  if (rows.some((bar, i) => bar.openTime < first || bar.closeTime >= end ||
      (i > 0 && bar.openTime <= rows[i - 1].closeTime))) throw new Error('细粒度 K 线的时间顺序或范围无效。');
  return { rows, urls, interval, retrievedAt: new Date().toISOString() };
}

function queryCutoff(value?: string) {
  const now = Date.now();
  if (value === undefined) return now;
  const parsed = Date.parse(value);
  const zoned = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!zoned.test(value) || !Number.isFinite(parsed) || parsed <= 0 || parsed > now ||
      new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('as_of 需要使用有效的带时区 ISO 8601 时间且不得在未来，例如 2026-01-01T12:00:00+08:00。');
  }
  return parsed;
}

function unavailableIndicator({ id, parameters }: ReturnType<typeof prepareIndicator>, status: string) {
  return { id, parameters, status, latest: null, previous: null };
}

function isExternal(item: Prepared) {
  return item.input === 'futures' || item.input === 'onchain';
}

function seriesResult(item: Prepared, series: MarketSeries, history: number) {
  const { points, rows: _, ...source } = series;
  const latest = points.at(-1), previous = points.at(-2);
  return { id: item.id, parameters: item.parameters, ...source,
    latest: latest?.value ?? null, previous: previous?.value ?? null,
    observedAt: latest ? new Date(latest.time).toISOString() : null,
    previousObservedAt: previous ? new Date(previous.time).toISOString() : null,
    firstObservedAt: points.length ? new Date(points[0].time).toISOString() : null,
    observations: points.length,
    ...(history > 0 ? { history: points.slice(-history).map(point => ({ observedAt: new Date(point.time).toISOString(), value: point.value })) } : {}),
  };
}

export function createCryptoIndicatorsTool(saveEvidence?: SaveEvidence) {
  return defineTool({
    name: 'crypto_indicators',
    description: 'list 查询加密货币指标、默认参数及数据源。compute 计算 Binance 现货已收盘技术指标，并可查询 USD-M 永续合约及 Bitcoin 日频链上指标。返回实际数据时间、覆盖、最新值、前值和来源。',
    parameters: {
      action: { ...str, enum: ['list', 'compute'], required: true },
      ...listParameters,
      ...computeParameters,
    },
    output,
    async execute(args, exec) {
      const allowed = args.action === 'list' ? listParameters : computeParameters;
      for (const key of Object.keys(args)) {
        if (key !== 'action' && !Object.hasOwn(allowed, key)) throw new Error(`action=${args.action} 不支持参数 ${key}。`);
      }
      if (args.action === 'list') {
        const search = args.query?.trim().toLowerCase();
        const rows = indicatorCatalog.filter(item => (!args.category || item.category === args.category) && (!search ||
          item.id.toLowerCase().includes(search) || item.name.toLowerCase().includes(search)));
        return JSON.stringify({
          total: indicatorCatalog.length, matched: rows.length,
          indicators: rows.map(({ id, name, category, defaults, input, description, options }) =>
            ({ id, name, category, parameters: defaults, input, description, options })),
        });
      }

      if (!args.symbols?.length || args.symbols.length > 3 || !args.intervals?.length || args.intervals.length > 3) {
        throw new Error('compute 需要提供 1 至 3 个交易对（symbols）和 1 至 3 个支持的周期（intervals）。交易对或周期超限时请拆分请求。');
      }
      const symbols = [...new Set(args.symbols.map(normalizeSymbol))];
      const periods = [...new Set(args.intervals)] as Interval[];
      const history = args.history ?? 0;
      if ((args.bars !== undefined && (args.bars < 2 || args.bars > 999)) || history < 0 || history > 20) throw new Error('bars 支持 2 至 999，history 支持 0 至 20。');
      const cutoff = queryCutoff(args.as_of);
      const requested: { id: string; parameters?: unknown }[] =
        args.indicators ?? ['RSI', 'MACD', 'BBANDS', 'EMA', 'ATR', 'RVOL'].map(id => ({ id }));
      const all = requested.some(item => item.id.trim().toUpperCase() === 'ALL');
      if (all && (requested.length !== 1 || requested[0].parameters !== undefined)) {
        throw new Error('ALL 只能作为唯一指标使用，且不能传 parameters。');
      }
      const selected = all ? indicatorCatalog.map(({ id }) => ({ id })) : requested;
      if (!selected.length) throw new Error('indicators 至少需要一项指标。');
      if (selected.length > indicatorCatalog.length || symbols.length * periods.length * selected.length * Math.max(2, history) > 400) {
        throw new Error('单次结果过多，请把指定的交易对、周期或指标拆成多次请求，或减少返回的历史点数。');
      }
      const indicators = selected.map(prepareIndicator);
      const spotStudies = indicators.filter(item => !isExternal(item));
      const marketStudies = indicators.filter(isExternal);
      const minimum = Math.max(500, ...spotStudies.map(item => {
        const warmup = item.id === 'PRINGS_SPECIAL_K' ? Number(item.parameters.signal_first) + Number(item.parameters.signal_second) - 2 : 0;
        return item.create!().minimumBars + warmup + Math.max(1, history - 1);
      }));
      const bars = args.bars ?? Math.min(999, minimum);
      const asOf = new Date(cutoff).toISOString();
      function persist<T extends { retrievedAt: string | null }>(snapshot: T, source: string, rows: unknown, extra: object) {
        if (!saveEvidence || !snapshot.retrievedAt) return snapshot;
        try {
          const { evidenceId } = saveEvidence(source, { kind: 'crypto_indicator_snapshot', ...snapshot,
            calculator: 'trading-signals@8.4.1', rows, ...extra }, snapshot.retrievedAt);
          return { ...snapshot, evidenceId };
        } catch (error) {
          return { ...snapshot, evidenceError: error instanceof Error ? error.message : String(error) };
        }
      }
      const analyses = await Promise.all(symbols.flatMap(symbol => periods.map(async interval => {
        const duration = intervals[interval] * 1000;
        const spotSource = spotUrl({ symbol, interval, endTime: cutoff - 1, limit: bars + 1 });
        const instrument = { venue: 'Binance', marketType: 'spot', symbol, interval, asOf, sourceUrl: spotSource };
        const failure = (status: 'invalid_symbol' | 'error', reason: string, retrievedAt: string | null) => ({
          ...instrument, status, reason, retrievedAt, coverage: null,
          indicators: indicators.map(item => unavailableIndicator(item, status)),
        });
        if (!symbol || /[\s/]/.test(symbol)) {
          return failure('invalid_symbol', '请提供 Binance 完整交易对，例如 BTCUSDT 或 BTC/USDT。', null);
        }
        const [spot, market] = await Promise.all([
          spotStudies.length ? readCandles(spotSource, duration, cutoff, bars, exec.signal).catch(error => {
            exec.signal.throwIfAborted();
            return { status: 'error' as const, retrievedAt: null, reason: error instanceof Error ? error.message : String(error) };
          }) : undefined,
          Promise.all(marketStudies.map(async item => {
            const series: MarketSeries = await readMarketStudy(item.id, symbol, interval, duration, cutoff, bars, exec.signal).catch(error => {
              exec.signal.throwIfAborted();
              return { status: 'error' as const, provider: item.input === 'onchain' ? 'BGeometrics' : 'Binance',
                marketType: item.input === 'onchain' ? 'bitcoin_onchain' as const : 'usd_m_perpetual' as const,
                points: [], reason: error instanceof Error ? error.message : String(error) };
            });
            return { item, series, value: seriesResult(item, series, history) };
          })),
        ]);
        if (spot && !('closed' in spot) && !market.length) return failure(spot.status, spot.reason, spot.retrievedAt);
        const input = spot && 'closed' in spot ? spot.closed.slice(spot.continuousFrom) : [];
        const coverage = spot && 'closed' in spot ? {
          requestedBars: bars, receivedClosedBars: spot.closed.length, continuousBars: input.length, gapCount: spot.gapCount,
          firstOpenAt: input.length ? new Date(input[0].openTime).toISOString() : null,
          lastCloseAt: input.length ? closeAt(input[input.length - 1]) : null,
        } : null;
        const sources: Record<string, unknown> = {};
        const referenceInputs = new Map<string, ReturnType<typeof readCandles>>();
        const profileInputs = new Map<string, ReturnType<typeof readIntrabars>>();
        const supplementalTimes: string[] = [];
        const canCompute = (spot?.status === 'ok' || spot?.status === 'partial') && input.length > 0;
        function profileRange(item: Prepared) {
          const last = input.at(-1)!;
          const earliest = input.at(-Math.max(2, history)) ?? input[0];
          const end = last.closeTime + 1;
          if (item.id === 'VOLUME_PROFILE_AUTO') {
            const back = Number(item.parameters.period) + Math.max(1, history - 1);
            return { start: (input.at(-back) ?? input[0]).openTime, end };
          }
          if (item.parameters.anchor && item.parameters.anchor !== 'highest_volume') {
            const anchor = String(item.parameters.anchor);
            const previous = item.id === 'AUTO_KEY_LEVELS' && item.parameters.period_side === 'previous';
            return { start: profileAnchor(earliest.openTime, anchor, duration, previous), end };
          }
          return { start: item.parameters.start ? Date.parse(String(item.parameters.start)) : input[0].openTime,
            end: Math.min(end, item.parameters.end ? Date.parse(String(item.parameters.end)) : end) };
        }
        const results = await Promise.all(indicators.map(async item => {
          const m = market.find(entry => entry.item === item);
          if (m) {
            if (m.series.rows) sources[item.id] = { source: m.value.sourceUrl, rows: m.series.rows };
            return m.value;
          }
          if (!canCompute) return { ...unavailableIndicator(item, spot?.status ?? 'no_data'),
            reason: spot && 'reason' in spot ? spot.reason : undefined };
          if (item.id === 'ADR' && interval !== '1d') return { ...unavailableIndicator(item, 'unsupported_interval'), reason: 'ADR 请使用 1d。' };
          const context: StudyContext = { duration };
          try {
            let finer: Awaited<ReturnType<typeof readIntrabars>> | undefined;
            if (item.input === 'intrabar') {
              const { start, end } = profileRange(item);
              const block = item.parameters.block_minutes ? Number(item.parameters.block_minutes) * 60_000 : undefined;
              const key = [start, end, block].join(':');
              let promise = profileInputs.get(key);
              if (!promise) {
                promise = readIntrabars(symbol, duration, start, end, exec.signal, block);
                profileInputs.set(key, promise);
              }
              finer = await promise;
              context.intrabars = finer.rows;
              sources['intrabar:' + key] = finer;
              supplementalTimes.push(finer.retrievedAt);
            }
            let referenceSource: string | undefined;
            if (item.input === 'reference') {
              const reference = normalizeSymbol(String(item.parameters.reference_symbol));
              referenceSource = spotUrl({ symbol: reference, interval, endTime: cutoff - 1, limit: bars + 1 });
              let promise = referenceInputs.get(reference);
              if (!promise) {
                promise = readCandles(referenceSource, duration, cutoff, bars, exec.signal);
                referenceInputs.set(reference, promise);
              }
              const series = await promise;
              if (series.status !== 'ok' && series.status !== 'partial') {
                return { ...unavailableIndicator(item, series.status), reason: series.reason, referenceSource };
              }
              const aligned = series.closed.slice(series.continuousFrom);
              context.reference = new Map(aligned.map(c => [c.openTime, c.close]));
              sources[referenceSource] = { rows: aligned, retrievedAt: series.retrievedAt };
              supplementalTimes.push(series.retrievedAt);
            }
            return { ...calculate(item, input, history, context), ...(referenceSource ? { referenceSource } : {}),
              ...(item.input === 'intrabar' ? { inputInterval: finer?.interval, inputSources: finer?.urls,
                method: 'finer_bar_price_range_distribution' } : {}) };
          } catch (error) {
            exec.signal.throwIfAborted();
            return { ...unavailableIndicator(item, 'error'), reason: error instanceof Error ? error.message : String(error) };
          }
        }));
        const marketResult = market.find(entry => entry.value.sourceUrl)?.value;
        const sourceUrl = spot ? spotSource : marketResult?.sourceUrl ?? null;
        const times = [spot?.retrievedAt, ...supplementalTimes, ...market.map(entry => entry.value.retrievedAt)]
          .filter((time): time is string => typeof time === 'string').sort();
        const status = !market.length ? spot?.status : !spot && results.length === 1 ? results[0].status : results.every(item => item.status === 'ok') && (!spot || spot.status === 'ok')
          ? 'ok' : results.some(item => item.latest !== null) ? 'partial' : results[0].status;
        const marketTypes = new Set<string>(market.map(entry => entry.value.marketType));
        if (spot) marketTypes.add('spot');
        const snapshot = { ...instrument, marketType: marketTypes.size > 1 ? 'mixed' : spot ? 'spot' : market[0].value.marketType,
          venue: spot ? instrument.venue : marketResult?.provider ?? market[0].value.provider,
          status, ...(spot && 'reason' in spot ? { reason: spot.reason } : {}), sourceUrl,
          retrievedAt: times.at(-1) ?? null, coverage, indicators: results };
        if (!sourceUrl) return snapshot;
        return persist(snapshot, sourceUrl, spot && 'closed' in spot ? spot.closed : [], {
          ...(spot && 'closed' in spot ? { continuousFrom: spot.continuousFrom } : {}),
          ...(Object.keys(sources).length ? { supplemental: sources } : {}),
        });
      })));
      return JSON.stringify({ asOf, candlePolicy: 'closed_only', candleTimeZone: 'UTC', analyses });
    },
  });
}
