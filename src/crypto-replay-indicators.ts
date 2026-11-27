import { readFileSync } from 'node:fs';
import { indicatorCatalog, prepareIndicator, type Candle, type StudyContext } from './crypto-indicator-catalog.js';

type AvailableCandle = Candle & { availableAt: number };
type Asset = 'BTC' | 'ETH';
type Bars = Record<Asset, { minute: AvailableCandle[]; five: AvailableCandle[]; daily: AvailableCandle[] }>;
const minute = 60_000;
const five = 5 * minute;
const day = 288 * five;

function numericFields(value: unknown, key: string, output: Record<string, number>) {
  if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
  else if (typeof value === 'boolean') output[key] = Number(value);
  else if (typeof value === 'string') output[`${key}=${value}`] = 1;
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, field] of Object.entries(value)) numericFields(field, `${key}.${name}`, output);
  }
}

function firstAtOrAfter(bars: AvailableCandle[], time: number) {
  let left = 0;
  let right = bars.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (bars[mid].openTime < time) left = mid + 1;
    else right = mid;
  }
  return left;
}

/** Calculate once per closed bar. The replay joins each snapshot by availableAt. */
export function* replayIndicatorSnapshots(input: Bars, from: number) {
  for (const asset of ['BTC', 'ETH'] as const) {
    const { minute: intrabars, five: main, daily } = input[asset];
    const referenceAsset = asset === 'BTC' ? 'ETH' : 'BTC';
    const reference = new Map(input[referenceAsset].five.map(bar => [bar.openTime, bar]));
    const dailyItem = prepareIndicator({ id: 'ADR' });
    let adr = dailyItem.create!({ duration: day });
    let dailyIndex = 0;
    let dailyCount = 0;
    let dailyValue: unknown;
    const joinedReference = new Map<number, number>();
    const context: StudyContext = { duration: five, reference: joinedReference, intrabars };
    const items = indicatorCatalog.filter(entry => entry.id !== dailyItem.id).map(entry => prepareIndicator({
      id: entry.id, ...(entry.input === 'reference' ? { parameters: { reference_symbol: referenceAsset + 'USDT' } } : {}),
    }));
    const continuous = items.filter(item => item.create && item.input !== 'intrabar');
    let calculators = continuous.map(item => item.create!(context));
    let continuousFrom = 0;
    let availableAt = 0;

    for (const [index, bar] of main.entries()) {
      if (index && bar.openTime !== main[index - 1].closeTime + 1) {
        continuousFrom = index;
        calculators = continuous.map(item => item.create!(context));
        joinedReference.clear();
      }
      // Both symbols' closes are admissible at the joint availability time.
      const peer = reference.get(bar.openTime);
      availableAt = Math.max(availableAt, bar.availableAt, peer?.availableAt ?? 0);
      if (peer) joinedReference.set(peer.openTime, peer.close);
      while (dailyIndex < daily.length && daily[dailyIndex].availableAt <= availableAt) {
        const candle = daily[dailyIndex];
        if (dailyIndex && candle.openTime !== daily[dailyIndex - 1].closeTime + 1) {
          adr = dailyItem.create!({ duration: day });
          dailyCount = 0;
        }
        dailyCount += 1;
        dailyValue = adr.update(candle, true);
        dailyIndex += 1;
      }
      const features: Record<string, number> = {};
      const status: Record<string, string> = {};
      const record = (id: string, value: unknown, reason: string) => {
        const before = Object.keys(features).length;
        numericFields(value, id, features);
        status[id] = Object.keys(features).length > before ? 'ok' : reason;
      };
      const count = index - continuousFrom + 1;
      const emit = availableAt >= from;
      for (const [i, item] of continuous.entries()) {
        const calculator = calculators[i];
        const value = calculator.update(bar, emit);
        if (emit) record(item.id, count >= calculator.minimumBars ? value : null,
          count < calculator.minimumBars ? 'insufficient_history' : 'unavailable');
      }
      if (!emit) continue;
      record(dailyItem.id, dailyCount >= adr.minimumBars ? dailyValue : null, 'insufficient_daily_history');
      const profileBars = main.slice(Math.max(continuousFrom, index - 287), index + 1);
      const start = Math.min(profileBars[0].openTime, bar.openTime - 8 * day);
      const first = firstAtOrAfter(intrabars, start);
      const last = firstAtOrAfter(intrabars, bar.closeTime + 1);
      const visible = intrabars.slice(first, last).filter(candle => candle.availableAt <= availableAt);
      for (const item of items) {
        if (!item.create) status[item.id] = `missing_pit_${item.input}`;
        if (item.input !== 'intrabar') continue;
        const calculator = item.create!({ duration: five, intrabars: visible });
        let value: unknown;
        for (const candle of profileBars) value = calculator.update(candle, candle === bar);
        record(item.id, value, 'unavailable_intrabar_coverage');
      }
      yield { asset, barEnd: bar.closeTime + 1, availableAt, referenceSymbol: referenceAsset + 'USDT',
        close: bar.close, status, features };
    }
  }
}

if (process.argv[1]?.endsWith('/crypto-replay-indicators.js')) {
  const bars: Bars = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for (const row of replayIndicatorSnapshots(bars, Number(process.argv[3]))) {
    process.stdout.write(JSON.stringify(row) + '\n');
  }
}
