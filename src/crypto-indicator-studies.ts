import * as ta from 'trading-signals';
import type { Calculator, Candle, Definition, Parameters, StudyContext } from './crypto-indicator-catalog.js';

const hour = 3_600_000;
const day = 24 * hour;
const anchors = ['auto', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const typ = (bar: Candle) => (bar.high + bar.low + bar.close) / 3;
const stamp = (time: number) => new Date(time).toISOString();

function windowed<P extends Parameters>(
  name: string, defaults: P, size: (p: P) => number,
  compute: (bars: Candle[], p: P, context?: StudyContext) => unknown,
): Definition {
  return {
    name, defaults,
    create(parameters, context) {
      const p = parameters as P;
      const length = size(p);
      const bars: Candle[] = [];
      return {
        minimumBars: length,
        update(bar) {
          bars.push(bar);
          if (bars.length > length) bars.shift();
          return bars.length === length ? compute(bars, p, context) : null;
        },
      };
    },
  };
}

function study<P extends Parameters>(
  name: string, defaults: P, create: (p: P, context?: StudyContext) => Calculator,
): Definition {
  return { name, defaults, create: (parameters, context) => create(parameters as P, context) };
}

function correlation(a: number[], b: number[]) {
  const am = mean(a), bm = mean(b);
  let aa = 0, bb = 0, ab = 0;
  for (const [i, x] of a.entries()) {
    const da = x - am, db = b[i] - bm;
    aa += da ** 2;
    bb += db ** 2;
    ab += da * db;
  }
  return aa > 0 && bb > 0 ? Math.max(-1, Math.min(1, ab / Math.sqrt(aa * bb))) : null;
}

function roundAnchor(at: number, anchor: string) {
  if (anchor === 'hour') return Math.floor(at / hour) * hour;
  if (anchor === 'day') return Math.floor(at / day) * day;
  if (anchor === 'week') return Math.floor((at + 3 * day) / (7 * day)) * 7 * day - 3 * day;
  const t = new Date(at);
  const month = anchor === 'year' ? 0 : anchor === 'quarter' ? Math.floor(t.getUTCMonth() / 3) * 3 : t.getUTCMonth();
  return Date.UTC(t.getUTCFullYear(), month, 1);
}

function nextAnchor(at: number, anchor: string) {
  if (anchor === 'hour') return at + hour;
  if (anchor === 'day') return at + day;
  if (anchor === 'week') return at + 7 * day;
  const t = new Date(at);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + (anchor === 'year' ? 12 : anchor === 'quarter' ? 3 : 1), 1);
}

function anchorFor(anchor: string, duration: number, pivot = false) {
  if (anchor !== 'auto') return anchor;
  if (pivot) return duration <= 15 * 60_000 ? 'day' : duration < day ? 'week' : 'month';
  return duration <= 180_000 ? 'hour' : duration < day ? 'day' : duration === day ? 'month' : duration <= 3 * day ? 'quarter' : 'year';
}

export function profileAnchor(at: number, anchor: string, duration: number, previous = false) {
  const mode = anchorFor(anchor, duration);
  const start = roundAnchor(at, mode);
  return previous ? roundAnchor(start - 1, mode) : start;
}

type Pivot = { kind: 'high' | 'low'; price: number; time: number; confirmedAt: number };
function pivots(left: number, right: number) {
  const bars: Candle[] = [];
  return (bar: Candle) => {
    bars.push(bar);
    if (bars.length > left + right + 1) bars.shift();
    if (bars.length <= left + right) return [];
    const center = bars[left];
    const others = bars.filter((_, i) => i !== left);
    const found: Pivot[] = [];
    const mark = { time: center.closeTime + 1, confirmedAt: bar.closeTime + 1 };
    if (others.every(other => other.high < center.high)) found.push({ ...mark, kind: 'high', price: center.high });
    if (others.every(other => other.low > center.low)) found.push({ ...mark, kind: 'low', price: center.low });
    return found;
  };
}

function pivotLevels(left: number, right: number): Calculator {
  const find = pivots(left, right);
  let high: Pivot | undefined, low: Pivot | undefined;
  return {
    minimumBars: left + right + 1,
    update(bar) {
      for (const pivot of find(bar)) {
        if (pivot.kind === 'high') high = pivot;
        else low = pivot;
      }
      return high && low ? { high: high.price, low: low.price,
        highAt: stamp(high.time), lowAt: stamp(low.time), highConfirmedAt: stamp(high.confirmedAt), lowConfirmedAt: stamp(low.confirmedAt) } : null;
    },
  };
}

function swings(depth: number, deviation: number) {
  const side = Math.max(1, Math.floor(depth / 2));
  const find = pivots(side, side);
  const retained: Pivot[] = [];
  return (bar: Candle) => {
    const found = find(bar);
    if (found.length !== 1) return retained;
    const [pivot] = found;
    const last = retained.at(-1);
    if (!last) retained.push(pivot);
    else if (last.kind === pivot.kind) {
      const moreExtreme = pivot.kind === 'high' ? pivot.price > last.price : pivot.price < last.price;
      if (moreExtreme) retained[retained.length - 1] = pivot;
    } else {
      const move = (pivot.price - last.price) * (pivot.kind === 'high' ? 1 : -1);
      if (move / last.price * 100 >= deviation) retained.push(pivot);
    }
    if (retained.length > 3) retained.shift();
    return retained;
  };
}

function swingStudy(mode: 'zigzag' | 'retracement' | 'extension'): Definition {
  const labels = { zigzag: 'Zig Zag', retracement: 'Auto Fibonacci Retracement', extension: 'Auto Fibonacci Extension' };
  const levels = { retracement: [0, .236, .382, .5, .618, .786, 1],
    extension: [.618, 1, 1.272, 1.618, 2, 2.618] };
  return { ...study(labels[mode], { depth: 10, deviation_percent: 3 }, ({ depth, deviation_percent }) => {
    const update = swings(depth, deviation_percent);
    return {
      minimumBars: 2 * Math.floor(depth / 2) + 1,
      update(bar) {
        const points = update(bar);
        const last = points.at(-1), prior = points.at(-2);
        if (!last || !prior) return null;
        const leg = (p: Pivot) => ({ type: p.kind, price: p.price, at: stamp(p.time), confirmedAt: stamp(p.confirmedAt) });
        if (mode === 'zigzag') return { pivot: last.price, previousPivot: prior.price, last: leg(last), previous: leg(prior) };
        const first = points.at(-3);
        if (mode === 'extension' && !first) return null;
        const origin = mode === 'retracement' ? last.price : first!.price;
        const move = prior.price - origin;
        return { from: leg(mode === 'retracement' ? prior : first!), to: leg(mode === 'retracement' ? last : prior),
          ...(mode === 'extension' ? { anchor: leg(last) } : {}),
          ...Object.fromEntries(levels[mode].map(ratio => ['fib' + Math.round(ratio * 1000), last.price + move * ratio])),
        };
      },
    };
  }), description: 'Confirmed pivots only. Reversal threshold is a percentage of the prior pivot.' };
}

function standardPivots(): Definition {
  return { ...study('Pivot Points Standard', { anchor: 'auto', formula: 'traditional' }, (p, context) => {
    const duration = context?.duration ?? hour;
    const anchor = anchorFor(p.anchor, duration, true);
    let start: number | undefined, open = 0, high = 0, low = 0, close = 0, end = 0, full = false;
    let previous: { open: number; high: number; low: number; close: number } | undefined;
    return {
      minimumBars: 2,
      update(bar) {
        const bucket = roundAnchor(bar.openTime, anchor);
        if (start !== bucket) {
          previous = start !== undefined && full && end === bucket ? { open, high, low, close } : undefined;
          start = bucket;
          full = bar.openTime === bucket;
          open = bar.open;
          high = bar.high;
          low = bar.low;
        } else {
          high = Math.max(high, bar.high);
          low = Math.min(low, bar.low);
        }
        close = bar.close;
        end = bar.closeTime + 1;
        if (end > nextAnchor(bucket, anchor)) full = false;
        if (!previous) return null;
        const { high: h, low: l, close: c, open: o } = previous;
        const range = h - l;
        const pivot = p.formula === 'woodie' ? (h + l + 2 * open) / 4 : (h + l + c) / 3;
        if (p.formula === 'fibonacci') return { pivot,
          r1: pivot + .382 * range, s1: pivot - .382 * range, r2: pivot + .618 * range, s2: pivot - .618 * range,
          r3: pivot + range, s3: pivot - range };
        if (p.formula === 'demark') {
          const x = c === o ? h + l + 2 * c : c > o ? 2 * h + l + c : h + 2 * l + c;
          return { pivot: x / 4, r1: x / 2 - l, s1: x / 2 - h };
        }
        if (p.formula === 'camarilla') return { pivot,
          ...Object.fromEntries([12, 6, 4, 2].flatMap((n, i) => [['r' + (i + 1), c + 1.1 * range / n],
            ['s' + (i + 1), c - 1.1 * range / n]])),
          r5: h / l * c, s5: c - (h / l * c - c) };
        const r1 = 2 * pivot - l, s1 = 2 * pivot - h;
        const base = { pivot, r1, s1, r2: pivot + range, s2: pivot - range };
        if (p.formula === 'classic') return { ...base, r3: pivot + 2 * range, s3: pivot - 2 * range,
          r4: pivot + 3 * range, s4: pivot - 3 * range };
        const r3 = h + 2 * (pivot - l), s3 = l - 2 * (h - pivot);
        if (p.formula === 'woodie') return { ...base, r3, s3, r4: r3 + range, s4: s3 - range };
        return { ...base, r3, s3, r4: 3 * pivot + h - 3 * l, s4: 3 * pivot - 3 * h + l,
          r5: 4 * pivot + h - 4 * l, s5: 4 * pivot - 4 * h + l };
      },
    };
  }), options: { anchor: anchors, formula: ['traditional', 'fibonacci', 'woodie', 'classic', 'demark', 'camarilla'] },
    description: 'Uses the previous fully covered UTC period. Woodie uses the current period open.' };
}

function profile(bars: readonly Candle[], bins: number, area: number, timeBased: boolean) {
  let low = Infinity, high = -Infinity;
  for (const bar of bars) { low = Math.min(low, bar.low); high = Math.max(high, bar.high); }
  if (!bars.length) return null;
  const size = (high - low) / bins;
  const rows = Array<number>(size > 0 ? bins : 1).fill(0);
  const index = (price: number) => size > 0 ? Math.min(bins - 1, Math.max(0, Math.floor((price - low) / size))) : 0;
  for (const bar of bars) {
    const first = index(bar.low), last = index(bar.high);
    if (timeBased || first === last) {
      for (let i = first; i <= last; i++) rows[i] += timeBased ? 1 : bar.volume;
    } else {
      for (let i = first; i <= last; i++) {
        const overlap = Math.max(0, Math.min(bar.high, low + size * (i + 1)) - Math.max(bar.low, low + size * i));
        rows[i] += bar.volume * overlap / (bar.high - bar.low);
      }
    }
  }
  const total = rows.reduce((sum, x) => sum + x, 0);
  if (total <= 0) return null;
  const center = rows.indexOf(Math.max(...rows));
  let bottom = center, top = center, covered = rows[center];
  while (covered < total * area / 100 && (bottom > 0 || top + 1 < rows.length)) {
    if ((rows[top + 1] ?? -1) >= (rows[bottom - 1] ?? -1)) covered += rows[++top];
    else covered += rows[--bottom];
  }
  return { poc: low + (center + .5) * size, val: low + bottom * size, vah: low + (top + 1) * size,
    total, profile: rows.map((amount, i) => ({ low: low + size * i, high: low + size * (i + 1), amount })) };
}

type ProfileKind = 'fixed' | 'visible' | 'session' | 'periodic' | 'auto' | 'key' | 'tpo';
function marketProfile(name: string, kind: ProfileKind): Definition {
  const defaults: Parameters = { bins: 24, value_area: 70 };
  if (kind === 'fixed' || kind === 'visible') Object.assign(defaults, { start: '', end: '' });
  if (kind === 'auto') defaults.period = 48;
  if (kind === 'auto') defaults.anchor = 'highest_volume';
  if (kind === 'session' || kind === 'key' || kind === 'tpo') defaults.anchor = 'auto';
  if (kind === 'periodic') defaults.anchor = 'week';
  if (kind === 'key') defaults.period_side = 'previous';
  if (kind === 'tpo') defaults.block_minutes = 30;
  return {
    name, defaults, input: 'intrabar',
    options: { anchor: kind === 'auto' ? ['highest_volume', 'highest_high', 'lowest_low'] : anchors,
      ...(kind === 'key' ? { period_side: ['previous', 'current'] } : {}) },
    description: kind === 'fixed' || kind === 'visible'
      ? 'Explicit UTC-offset start/end. With empty bounds, use the supplied closed-bar window.'
      : 'Price distribution from finer Binance bars. Profile amount is base volume or TPO block count.',
    create(p, context) {
      const history: Candle[] = [];
      const duration = context?.duration ?? hour;
      const anchor = anchorFor(String(p.anchor), duration);
      const finer = context?.intrabars ?? [];
      const size = Number(p.period);
      return {
        minimumBars: kind === 'auto' ? size : 2,
        update(bar, final) {
          history.push(bar);
          if (!final || history.length < 2) return null;
          const endOfBar = bar.closeTime + 1;
          let from = history[0].openTime, to = endOfBar;
          if (kind === 'fixed' || kind === 'visible') {
            if (p.start) from = Date.parse(String(p.start));
            if (p.end) to = Math.min(to, Date.parse(String(p.end)));
          } else if (kind === 'session' || kind === 'periodic' || kind === 'key' || kind === 'tpo') {
            from = roundAnchor(bar.openTime, anchor);
            if (kind === 'key' && p.period_side === 'previous') {
              to = from;
              from = roundAnchor(from - 1, anchor);
            }
          } else {
            const tail = history.slice(-size);
            const key = p.anchor === 'highest_high' ? 'high' : p.anchor === 'lowest_low' ? 'low' : 'volume';
            const best = tail.reduce((a, b) => (key === 'low' ? b[key] <= a[key] : b[key] >= a[key]) ? b : a);
            from = best.openTime;
          }
          const bars = finer.filter(c => c.openTime >= from && c.closeTime + 1 <= to);
          if (from >= to || bars[0]?.openTime !== from || bars.at(-1)?.closeTime !== to - 1 ||
              !bars.every((c, i) => i === 0 || c.openTime === bars[i - 1].closeTime + 1)) return null;
          let values = bars;
          if (kind === 'tpo') {
            const blockMs = Number(p.block_minutes) * 60_000;
            const blocks = new Map<number, Candle>();
            for (const candle of bars) {
              const block = from + Math.floor((candle.openTime - from) / blockMs) * blockMs;
              const prev = blocks.get(block);
              if (!prev) blocks.set(block, { ...candle });
              else { prev.high = Math.max(prev.high, candle.high); prev.low = Math.min(prev.low, candle.low); }
            }
            values = [...blocks.values()];
          }
          const result = profile(values, Number(p.bins), Number(p.value_area), kind === 'tpo');
          if (!result) return null;
          const { profile: distribution, ...levels } = result;
          return { ...levels, start: stamp(from), end: stamp(to), sampleBars: bars.length,
            ...(kind === 'tpo' ? { timeBlocks: values.length } : {}),
            ...(kind === 'key' ? { open: bars[0].open, close: bars.at(-1)!.close,
              high: Math.max(...bars.map(c => c.high)), low: Math.min(...bars.map(c => c.low)) } : { profile: distribution }) };
        },
      };
    },
  };
}

function anchored(name: string, kind: 'vwap' | 'twap' | 'cvd'): Definition {
  return { ...study(name, { anchor: 'auto' }, ({ anchor: choice }, context) => {
    const anchor = anchorFor(choice, context?.duration ?? hour);
    let start: number | undefined, numerator = 0, divisor = 0, complete = false;
    return {
      minimumBars: 1,
      update(bar) {
        const bucket = roundAnchor(bar.openTime, anchor);
        if (bucket !== start) {
          numerator = divisor = 0;
          start = bucket;
          complete = bar.openTime === bucket;
        }
        if (bar.closeTime + 1 > nextAnchor(bucket, anchor)) complete = false;
        if (!complete) return null;
        if (kind === 'cvd') {
          if (bar.takerBuyVolume === undefined) { complete = false; return null; }
          numerator += 2 * bar.takerBuyVolume - bar.volume;
          return numerator;
        }
        const weight = kind === 'twap' ? bar.closeTime + 1 - bar.openTime : bar.volume;
        numerator += typ(bar) * weight;
        divisor += weight;
        return divisor > 0 ? numerator / divisor : null;
      },
    };
  }), options: { anchor: anchors }, description: 'UTC anchor. A period that started before available history is unavailable.' };
}

function autoVwap(): Definition {
  const range = windowed('VWAP Auto Anchored', { anchor: 'auto', period: 48 }, p => p.period, (bars, p) => {
    const key = p.anchor === 'highest_high' ? 'high' : p.anchor === 'lowest_low' ? 'low' : 'volume';
    let index = 0;
    for (const [i, bar] of bars.entries()) if (key === 'low' ? bar[key] <= bars[index][key] : bar[key] >= bars[index][key]) index = i;
    const window = bars.slice(index);
    const volume = window.reduce((sum, bar) => sum + bar.volume, 0);
    return volume > 0 ? { vwap: window.reduce((sum, bar) => sum + typ(bar) * bar.volume, 0) / volume,
      anchorAt: stamp(window[0].openTime) } : null;
  });
  return { ...range, options: { anchor: [...anchors, 'highest_volume', 'highest_high', 'lowest_low'] },
    description: 'HLC3 weighted from a UTC anchor or the most extreme bar in the lookback.',
    create(p, context) {
      if (!anchors.includes(String(p.anchor))) return range.create!(p, context);
      const calc = anchored('VWAP Auto Anchored', 'vwap').create!(p, context);
      const anchor = anchorFor(String(p.anchor), context?.duration ?? hour);
      return { minimumBars: calc.minimumBars, update(bar) {
        const value = calc.update(bar);
        return value === null ? null : { vwap: value, anchorAt: stamp(roundAnchor(bar.openTime, anchor)) };
      } };
    },
  };
}

function relVolumeAtTime(): Definition {
  return { ...study('Relative Volume at Time', { period: 5, mode: 'regular', anchor: 'auto' }, (p, context) => {
    const anchor = p.anchor === 'auto' ? ((context?.duration ?? hour) <= 5 * 60_000 ? 'hour' : 'day') : p.anchor;
    const observations = new Map<number, Map<number, number>>();
    let start = -1, cumulative = 0, complete = false;
    return {
      minimumBars: p.period + 1,
      update(bar) {
        const base = roundAnchor(bar.openTime, anchor);
        if (base !== start) {
          start = base;
          cumulative = 0;
          complete = bar.openTime === base;
          observations.set(base, new Map());
          if (observations.size > p.period + 1) observations.delete(observations.keys().next().value!);
        }
        if (p.mode === 'cumulative' && !complete) return null;
        cumulative += bar.volume;
        const current = p.mode === 'cumulative' ? cumulative : bar.volume;
        const offset = bar.openTime - base;
        const sameTime = [...observations.values()].slice(0, -1).map(values => values.get(offset));
        observations.get(base)!.set(offset, current);
        if (sameTime.length < p.period || sameTime.some(value => value === undefined)) return null;
        const baseline = mean(sameTime as number[]);
        return baseline > 0 ? current / baseline : null;
      },
    };
  }), options: { mode: ['regular', 'cumulative'], anchor: ['auto', 'hour', 'day', 'week', 'month'] },
    description: 'Compares the same elapsed UTC offset in prior periods; auto uses hourly anchors through 5m, daily otherwise.' };
}

function momentumOscillator(): Definition {
  return study('Price Momentum Oscillator', { slow: 35, smooth: 20, signal: 10 }, p => {
    let close: number | undefined, first: number | undefined, second: number | undefined;
    const signal = new ta.EMA(p.signal);
    return {
      minimumBars: p.slow + p.smooth + p.signal,
      update(bar) {
        const roc = close === undefined ? undefined : (bar.close / close - 1) * 100;
        close = bar.close;
        if (roc === undefined) return null;
        first = first === undefined ? roc : first + 2 / p.slow * (roc - first);
        second = second === undefined ? 10 * first : second + 2 / p.smooth * (10 * first - second);
        return { pmo: second, signal: signal.add(second) };
      },
    };
  });
}

function specialK(): Definition {
  return study("Pring's Special K", { signal_first: 100, signal_second: 100 }, p => {
    const lengths = [10, 15, 20, 30, 40, 65, 75, 100, 195, 265, 390, 530];
    const smoothers = [10, 10, 10, 15, 50, 65, 75, 100, 130, 130, 130, 195].map(n => new ta.SMA(n));
    const prices: number[] = [];
    const first = new ta.SMA(p.signal_first), second = new ta.SMA(p.signal_second);
    return {
      minimumBars: 725,
      update(bar) {
        let weighted = 0, ready = true;
        for (const [i, length] of lengths.entries()) {
          const before = prices.at(-length);
          const value = before === undefined ? null : smoothers[i].add((bar.close / before - 1) * 100);
          if (value === null) ready = false;
          else weighted += value * (i % 4 + 1);
        }
        prices.push(bar.close);
        if (prices.length > 530) prices.shift();
        if (!ready) return null;
        const smoothed = first.add(weighted);
        return { specialK: weighted, signal: smoothed === null ? null : second.add(smoothed) };
      },
    };
  });
}

function rsiDivergence(): Definition {
  return study('RSI Divergence', { period: 14, left: 5, right: 5 }, p => {
    const rsi = new ta.RSI(p.period);
    const samples: { value: number; bar: Candle }[] = [];
    let priorHigh: typeof samples[number] | undefined, priorLow: typeof samples[number] | undefined;
    return {
      minimumBars: p.period + p.left + p.right + 2,
      update(bar) {
        const value = rsi.add(bar.close);
        if (value === null) return null;
        samples.push({ value, bar });
        if (samples.length > p.left + p.right + 1) samples.shift();
        if (samples.length <= p.left + p.right) return null;
        const candidate = samples[p.left];
        const peers = samples.filter((_, i) => i !== p.left);
        let bullish = false, bearish = false;
        if (peers.every(other => other.value > candidate.value)) {
          bullish = !!priorLow && candidate.value > priorLow.value && candidate.bar.low < priorLow.bar.low;
          priorLow = candidate;
        }
        if (peers.every(other => other.value < candidate.value)) {
          bearish = !!priorHigh && candidate.value < priorHigh.value && candidate.bar.high > priorHigh.bar.high;
          priorHigh = candidate;
        }
        return { rsi: value, bullish: Number(bullish), bearish: Number(bearish),
          pivotAt: bullish || bearish ? stamp(candidate.bar.closeTime + 1) : null };
      },
    };
  });
}

function vigor(): Definition {
  return study('Relative Vigor Index', { period: 10 }, p => {
    const numerator = new ta.SMA(p.period), denominator = new ta.SMA(p.period);
    const bars: Candle[] = [], results: number[] = [];
    const swma = (x: number[]) => (x[0] + 2 * x[1] + 2 * x[2] + x[3]) / 6;
    return {
      minimumBars: p.period + 6,
      update(bar) {
        bars.push(bar);
        if (bars.length > 4) bars.shift();
        if (bars.length < 4) return null;
        const a = numerator.add(swma(bars.map(b => b.close - b.open)));
        const b = denominator.add(swma(bars.map(b => b.high - b.low)));
        if (a === null || b === null || b === 0) { results.length = 0; return null; }
        const vigor = a / b;
        results.push(vigor);
        if (results.length > 4) results.shift();
        return results.length === 4 ? { vigor, signal: swma(results) } : null;
      },
    };
  });
}

function technicalRatings(): Definition {
  return study('Technical Ratings', {}, () => {
    const lengths = [10, 20, 30, 50, 100, 200];
    const averages = [...lengths.map(n => new ta.SMA(n)), ...lengths.map(n => new ta.EMA(n)), new ta.HMA(9)];
    const vwma = new ta.VWMA(20);
    const ichi = new ta.IchimokuCloud({ conversionInterval: 9, baseInterval: 26, spanBInterval: 52 });
    const rsi = new ta.RSI(14), cci = new ta.CCI(20), dx = new ta.DX(14), adx = new ta.ADX(14);
    const stoch = new ta.StochasticOscillator({ kPeriod: 14, dPeriod: 3, kSlowingPeriod: 3 });
    const aoFast = new ta.SMA(5), aoSlow = new ta.SMA(34), mom = new ta.MOM(10);
    const macd = new ta.MACD(new ta.EMA(12), new ta.EMA(26), new ta.EMA(9));
    const sRsi = new ta.StochasticOscillator({ kPeriod: 14, dPeriod: 3, kSlowingPeriod: 3 });
    const will = new ta.WilliamsR(14), elder = new ta.ElderRay(13), ultimate = new ta.UltimateOscillator({
      shortPeriod: 7, mediumPeriod: 14, longPeriod: 28,
    });
    const trendEma = new ta.EMA(50);
    let previous: { rs: number; cc: number; ax: number; ao: number; priorAo: number; mo: number; wr: number;
      bull: number; bear: number } | undefined;
    const signal = (bull: boolean, bear: boolean) => bull ? 1 : bear ? -1 : 0;
    const label = (v: number) => v < -.5 ? 'strong_sell' : v < -.1 ? 'sell' : v <= .1 ? 'neutral' : v <= .5 ? 'buy' : 'strong_buy';
    return {
      minimumBars: 200,
      update(bar) {
        const close = bar.close;
        const ma = averages.map(avg => avg.add(close));
        const vw = vwma.add(bar), cloud = ichi.add(bar), k = stoch.add(bar);
        const rs = rsi.add(close), cc = cci.add(bar), direct = dx.add(bar), ax = adx.add(bar);
        const mid = (bar.high + bar.low) / 2, f = aoFast.add(mid), s = aoSlow.add(mid), mo = mom.add(close);
        const mac = macd.add(close), sr = rs === null ? null : sRsi.add({ high: rs, low: rs, close: rs });
        const wr = will.add(bar), e = elder.add(bar), u = ultimate.add(bar), trend = trendEma.add(close);
        if (rs === null || cc === null || direct === null || ax === null || f === null || s === null || mo === null ||
            wr === null || e === null) return null;
        const ao = f - s, before = previous;
        previous = { rs, cc, ax, ao, priorAo: before?.ao ?? ao, mo, wr, bull: e.bullPower, bear: e.bearPower };
        const plus = dx.pdi, minus = dx.mdi;
        if (!before || plus === undefined || minus === undefined || ma.some(v => v === null) || vw === null || cloud === null || k === null ||
            mac === null || sr === null || u === null || trend === null) return null;
        const cloudScore = signal(cloud.spanA > cloud.spanB && cloud.base > cloud.spanA && cloud.conversion > cloud.base && close > cloud.conversion,
          cloud.spanA < cloud.spanB && cloud.base < cloud.spanA && cloud.conversion < cloud.base && close < cloud.conversion);
        const maScore = mean([...(ma as number[]).map(v => Math.sign(close - v)), Math.sign(close - vw), cloudScore]);
        const osc = mean([
          signal(rs < 30 && rs > before.rs, rs > 70 && rs < before.rs),
          signal(k.stochK < 20 && k.stochD < 20 && k.stochK > k.stochD, k.stochK > 80 && k.stochD > 80 && k.stochK < k.stochD),
          signal(cc < -100 && cc > before.cc, cc > 100 && cc < before.cc),
          signal(plus > minus && ax > 20 && ax > before.ax, plus < minus && ax > 20 && ax < before.ax),
          signal(ao > 0 && before.ao <= 0 || ao > 0 && ao > before.ao && before.ao < before.priorAo,
            ao < 0 && before.ao >= 0 || ao < 0 && ao < before.ao && before.ao > before.priorAo),
          Math.sign(mo - before.mo), Math.sign(mac.macd - mac.signal),
          signal(close < trend && sr.stochK < 20 && sr.stochD < 20 && sr.stochK > sr.stochD,
            close > trend && sr.stochK > 80 && sr.stochD > 80 && sr.stochK < sr.stochD),
          signal(wr < -80 && wr > before.wr, wr > -20 && wr < before.wr),
          signal(close > trend && e.bearPower < 0 && e.bearPower > before.bear, close < trend && e.bullPower > 0 && e.bullPower < before.bull),
          signal(u > 70, u < 30),
        ]);
        const overall = (maScore + osc) / 2;
        return { overall, movingAverages: maScore, oscillators: osc, rating: label(overall) };
      },
    };
  });
}

const market = (name: string, input: 'futures' | 'onchain', description: string): Definition =>
  ({ name, input, defaults: {}, description });

export const extraStudyGroups: Record<string, Record<string, Definition>> = {
  trend: {
    PIVOT_POINTS_STANDARD: standardPivots(),
    PIVOT_HIGH_LOW: study('Pivot Points High Low', { left: 10, right: 10 }, p => pivotLevels(p.left, p.right)),
    WILLIAMS_FRACTAL: study('Williams Fractal', { period: 2 }, p => pivotLevels(p.period, p.period)),
    ZIGZAG: swingStudy('zigzag'),
    AUTO_FIB_RETRACEMENT: swingStudy('retracement'),
    AUTO_FIB_EXTENSION: swingStudy('extension'),
    AUTO_KEY_LEVELS: marketProfile('Auto Key Levels', 'key'),
    TREND_STRENGTH: windowed('Trend Strength Index', { period: 14 }, p => p.period,
      bars => correlation(bars.map(b => b.close), bars.map((_, i) => i))),
    TECHNICAL_RATINGS: { ...technicalRatings(), description: '26-component aggregate score on closed bars.' },
  },
  momentum: {
    AO: windowed('Awesome Oscillator', { fast: 5, slow: 34 }, p => p.slow,
      (bars, p) => mean(bars.slice(-p.fast).map(b => (b.high + b.low) / 2)) - mean(bars.map(b => (b.high + b.low) / 2))),
    PMO: momentumOscillator(),
    PRINGS_SPECIAL_K: specialK(),
    RSI_DIVERGENCE: rsiDivergence(),
    RELATIVE_VIGOR: vigor(),
  },
  volatility: {
    ADR: { ...windowed('Average Daily Range', { period: 14 }, p => p.period,
      (bars, _, context) => context?.duration === day ? mean(bars.map(b => b.high - b.low)) : null),
      description: 'Call with interval 1d. Arithmetic mean of daily high minus low.' },
    HISTORICAL_VOLATILITY: windowed('Historical Volatility', { period: 20, annual_days: 365 }, p => p.period + 1,
      (bars, p, context) => {
        const returns = bars.slice(1).map((b, i) => Math.log(b.close / bars[i].close));
        const avg = mean(returns);
        return Math.sqrt(mean(returns.map(r => (r - avg) ** 2)) * p.annual_days * day / (context?.duration ?? day)) * 100;
      }),
    STDDEV: windowed('Standard Deviation', { period: 20 }, p => p.period, bars => {
      const prices = bars.map(b => b.close), avg = mean(prices);
      return Math.sqrt(mean(prices.map(x => (x - avg) ** 2)));
    }),
    ENVELOPES: windowed('Moving Average Envelopes', { period: 20, deviation_percent: 2.5 }, p => p.period, (bars, p) => {
      const middle = mean(bars.map(b => b.close));
      return { middle, upper: middle * (1 + p.deviation_percent / 100), lower: middle * (1 - p.deviation_percent / 100) };
    }),
    BBTREND: windowed('BBTrend', { fast: 20, slow: 50, deviations: 2 }, p => p.slow, (bars, p) => {
      const bands = (prices: number[]) => {
        const m = mean(prices), d = p.deviations * Math.sqrt(mean(prices.map(x => (x - m) ** 2)));
        return { m, lower: m - d, upper: m + d };
      };
      const a = bands(bars.slice(-p.fast).map(b => b.close)), b = bands(bars.map(b => b.close));
      return (Math.abs(a.lower - b.lower) - Math.abs(a.upper - b.upper)) / a.m * 100;
    }),
  },
  volume: {
    VWAP_ANCHORED: anchored('Anchored VWAP', 'vwap'),
    VWAP_AUTO_ANCHORED: autoVwap(),
    TWAP: anchored('Time Weighted Average Price', 'twap'),
    RVOL_AT_TIME: relVolumeAtTime(),
    VOLUME_DELTA: { ...study('Volume Delta', {}, () => ({ minimumBars: 1,
      update: bar => bar.takerBuyVolume === undefined ? null : 2 * bar.takerBuyVolume - bar.volume })),
      description: 'Binance taker buy minus taker sell in base units. No intrabar extrema are inferred.' },
    CVD: { ...anchored('Cumulative Volume Delta', 'cvd'),
      description: 'Cumulates Binance taker-sided base volume from a fully covered UTC anchor.' },
    VOLUME_PROFILE_FIXED: marketProfile('Fixed Range Volume Profile', 'fixed'),
    VOLUME_PROFILE_VISIBLE: marketProfile('Visible Range Volume Profile', 'visible'),
    VOLUME_PROFILE_SESSION: marketProfile('Session Volume Profile', 'session'),
    VOLUME_PROFILE_PERIODIC: marketProfile('Periodic Volume Profile', 'periodic'),
    VOLUME_PROFILE_AUTO: marketProfile('Auto Anchored Volume Profile', 'auto'),
    TPO: marketProfile('Time Price Opportunity', 'tpo'),
  },
  cross_asset: {
    CORRELATION: { ...windowed('Cross-symbol Pearson Correlation', { period: 20, reference_symbol: 'BTCUSDT' },
      p => p.period, (bars, _, context) => {
        const reference = bars.map(bar => context?.reference?.get(bar.openTime));
        return reference.some(x => x === undefined) ? null : correlation(bars.map(b => b.close), reference as number[]);
      }), input: 'reference', description: 'Aligns closes by timestamp on two Binance Spot symbols.' },
  },
  derivatives: {
    FUNDING_RATE: market('Settled USD-M Perpetual Funding Rate', 'futures', 'Actual Binance funding settlements; native cadence.'),
    OPEN_INTEREST: market('USD-M Futures Open Interest', 'futures', 'Quantity and quote notional from Binance USD-M.'),
    BASIS: market('USD-M Perpetual Basis', 'futures', 'Binance perpetual futures price minus its underlying index price.'),
    LONG_SHORT_RATIO: market('USD-M Long Short Account Ratio', 'futures', 'Binance account ratio and directional shares.'),
    LIQUIDATION_VOLUME: market('USD-M Liquidation Volume', 'futures', 'Published forced-liquidation events, with source coverage stated.'),
  },
  onchain: {
    SOPR: market('Bitcoin Spent Output Profit Ratio', 'onchain', 'BTC only, daily provider data.'),
    REALIZED_CAP: market('Bitcoin Realized Market Cap', 'onchain', 'BTC only, daily USD valuation.'),
  },
};
