import * as ta from 'trading-signals';
import { extraStudyGroups } from './crypto-indicator-studies.js';

export type Candle = {
  openTime: number; closeTime: number; open: number; high: number; low: number;
  close: number; volume: number; quoteVolume: number; takerBuyVolume?: number;
};

export type Parameters = Record<string, number | string>;
export type StudyContext = {
  duration: number;
  reference?: ReadonlyMap<number, number>;
  intrabars?: readonly Candle[];
};
type Indicator = {
  inputShape: ta.IndicatorInputShapes;
  getRequiredInputs(): number;
  add(input: never): unknown;
};
export type Calculator = { minimumBars: number; update(bar: Candle, final?: boolean): unknown };
export type Definition = {
  name: string;
  defaults: Readonly<Parameters>;
  description?: string;
  input?: 'reference' | 'intrabar' | 'futures' | 'onchain';
  options?: Readonly<Record<string, readonly string[]>>;
  create?(parameters: Parameters, context?: StudyContext): Calculator;
};

function indicator<P extends Record<string, number>>(name: string, defaults: P, make: (p: P) => Indicator): Definition {
  return {
    name, defaults,
    create(parameters) {
      const calculator = make({ ...defaults, ...parameters } as P);
      const shape = calculator.inputShape;
      return {
        minimumBars: calculator.getRequiredInputs(),
        update(bar) {
          // All candle shapes in trading-signals are subsets of Candle.
          const input = shape === 'price' ? bar.close : shape === 'volume' ? bar.volume : bar;
          return calculator.add(input as never);
        },
      };
    },
  };
}

const groups: Record<string, Record<string, Definition>> = {
  averages: {
    SMA: indicator('Simple Moving Average', { period: 20 }, p => new ta.SMA(p.period)),
    EMA: indicator('Exponential Moving Average', { period: 20 }, p => new ta.EMA(p.period)),
    WMA: indicator('Weighted Moving Average', { period: 20 }, p => new ta.WMA(p.period)),
    RMA: indicator('Wilder Moving Average', { period: 14 }, p => new ta.RMA(p.period)),
    DEMA: indicator('Double Exponential Moving Average', { period: 20 }, p => new ta.DEMA(p.period)),
    TEMA: indicator('Triple Exponential Moving Average', { period: 20 }, p => new ta.TEMA(p.period)),
    TRIMA: indicator('Triangular Moving Average', { period: 20 }, p => new ta.TRIMA(p.period)),
    HMA: indicator('Hull Moving Average', { period: 20 }, p => new ta.HMA(p.period)),
    ALMA: indicator('Arnaud Legoux Moving Average', { period: 20, offset: 0.85, sigma: 6 }, p => new ta.ALMA(p.period, p.offset, p.sigma)),
    T3: indicator('Tillson T3 Moving Average', { period: 10, factor: 0.7 }, p => new ta.T3(p.period, p.factor)),
    ZLEMA: indicator('Zero-Lag Exponential Moving Average', { period: 20 }, p => new ta.ZLEMA(p.period)),
    VIDYA: indicator('Variable Index Dynamic Average', { period: 20 }, p => new ta.VIDYA(p.period)),
    FRAMA: indicator('Fractal Adaptive Moving Average', { period: 16 }, p => new ta.FRAMA(p.period)),
    KAMA: indicator('Kaufman Adaptive Moving Average', { period: 10 }, p => new ta.KAMA(p.period)),
    MAMA: indicator('MESA Adaptive Moving Average', { fast_limit: 0.5, slow_limit: 0.05 },
      p => new ta.MAMA({ fastLimit: p.fast_limit, slowLimit: p.slow_limit })),
    MCGINLEY: indicator('McGinley Dynamic', { period: 14 }, p => new ta.McGinleyDynamic(p.period)),
    LINREG: indicator('Linear Regression', { period: 20 }, p => new ta.LinearRegression(p.period)),
    SUPERSMOOTHER: indicator('Ehlers Super Smoother', { period: 20 }, p => new ta.SuperSmoother(p.period)),
    DMA: indicator('Dual Moving Average', { fast: 20, slow: 50 }, p => new ta.DMA(p.fast, p.slow)),
    HT_TRENDLINE: indicator('Hilbert Transform Instantaneous Trendline', {}, () => new ta.HTTrendline()),
  },
  trend: {
    ADX: indicator('Average Directional Index', { period: 14 }, p => new ta.ADX(p.period)),
    ADXR: indicator('Average Directional Movement Index Rating', { period: 14 }, p => new ta.ADXR(p.period)),
    DMI: indicator('Directional Movement Index', { period: 14 }, p => {
      const dx = new ta.DX(p.period);
      return {
        inputShape: dx.inputShape,
        getRequiredInputs: () => dx.getRequiredInputs(),
        add(bar: Candle) {
          const value = dx.add(bar);
          return value === null ? null : { plusDI: dx.pdi, minusDI: dx.mdi, dx: value };
        },
      };
    }),
    AROON: indicator('Aroon', { period: 25 }, p => new ta.Aroon(p.period)),
    ALLIGATOR: indicator('Williams Alligator', {}, () => new ta.Alligator({})),
    GATOR: indicator('Gator Oscillator', {}, () => new ta.GatorOscillator()),
    PSAR: indicator('Parabolic SAR', { step: 0.02, maximum: 0.2 },
      p => new ta.PSAR({ accelerationStep: p.step, accelerationMax: p.maximum })),
    SUPERTREND: indicator('SuperTrend', { period: 10, multiplier: 3 },
      p => new ta.SuperTrend({ interval: p.period, multiplier: p.multiplier })),
    CHANDE_KROLL: indicator('Chande Kroll Stop', { period: 10, multiplier: 1, stop_period: 9 },
      p => new ta.ChandeKrollStop({ interval: p.period, multiplier: p.multiplier, stopInterval: p.stop_period })),
    CHANDELIER: indicator('Chandelier Exit', { period: 22, multiplier: 3 },
      p => new ta.ChandelierExit({ interval: p.period, multiplier: p.multiplier })),
    VSTOP: indicator('Volatility Stop', { period: 20, multiplier: 2 },
      p => new ta.VolatilityStop({ interval: p.period, multiplier: p.multiplier })),
    ICHIMOKU: indicator('Ichimoku Cloud', { conversion: 9, base: 26, span_b: 52 },
      p => new ta.IchimokuCloud({ conversionInterval: p.conversion, baseInterval: p.base, spanBInterval: p.span_b })),
    VORTEX: indicator('Vortex Indicator', { period: 14 }, p => new ta.VortexIndicator(p.period)),
    GANN_HILO: indicator('Gann HiLo Activator', { high_period: 13, low_period: 21 },
      p => new ta.GannHiLo({ highInterval: p.high_period, lowInterval: p.low_period })),
    VHF: indicator('Vertical Horizontal Filter', { period: 28 }, p => new ta.VHF(p.period)),
  },
  momentum: {
    RSI: indicator('Relative Strength Index', { period: 14 }, p => new ta.RSI(p.period)),
    MACD: indicator('Moving Average Convergence Divergence', { fast: 12, slow: 26, signal: 9 },
      p => new ta.MACD(new ta.EMA(p.fast), new ta.EMA(p.slow), new ta.EMA(p.signal))),
    STOCH: indicator('Stochastic Oscillator', { k: 14, d: 3, smoothing: 3 }, p => {
      const stoch = new ta.StochasticOscillator({ kPeriod: p.k, dPeriod: p.d, kSlowingPeriod: p.smoothing });
      return {
        inputShape: stoch.inputShape,
        getRequiredInputs: () => p.k + p.smoothing + p.d - 2,
        add: (bar: Candle) => stoch.add(bar),
      };
    }),
    STOCHRSI: indicator('Stochastic RSI', { period: 14, k: 3, d: 3 }, p => {
      const rsi = new ta.RSI(p.period);
      const stoch = new ta.StochasticOscillator({ kPeriod: p.period, dPeriod: p.d, kSlowingPeriod: p.k });
      return {
        inputShape: 'price',
        getRequiredInputs: () => rsi.getRequiredInputs() + p.period + p.k + p.d - 3,
        add(close: number) {
          const value = rsi.add(close);
          return value === null ? null : stoch.add({ high: value, low: value, close: value });
        },
      };
    }),
    CCI: indicator('Commodity Channel Index', { period: 20 }, p => new ta.CCI(p.period)),
    CMO: indicator('Chande Momentum Oscillator', { period: 14 }, p => new ta.CMO(p.period)),
    ROC: indicator('Rate of Change', { period: 12 }, p => new ta.ROC(p.period)),
    MOM: indicator('Momentum', { period: 10 }, p => new ta.MOM(p.period)),
    PPO: indicator('Percentage Price Oscillator', { fast: 12, slow: 26 }, p => new ta.PPO({ fastPeriod: p.fast, slowPeriod: p.slow })),
    APO: indicator('Absolute Price Oscillator', { fast: 12, slow: 26 }, p => new ta.APO({ fastPeriod: p.fast, slowPeriod: p.slow })),
    TSI: indicator('True Strength Index', { fast: 13, slow: 25 }, p => new ta.TSI({ shortPeriod: p.fast, longPeriod: p.slow })),
    TRIX: indicator('Triple Smoothed Rate of Change', { period: 18 }, p => new ta.TRIX(p.period)),
    WILLR: indicator('Williams %R', { period: 14 }, p => new ta.WilliamsR(p.period)),
    ULTOSC: indicator('Ultimate Oscillator', { short: 7, medium: 14, long: 28 },
      p => new ta.UltimateOscillator({ shortPeriod: p.short, mediumPeriod: p.medium, longPeriod: p.long })),
    SMI: indicator('Stochastic Momentum Index', { period: 10, smooth1: 3, smooth2: 3 },
      p => new ta.SMI({ interval: p.period, smooth1: p.smooth1, smooth2: p.smooth2 })),
    STC: indicator('Schaff Trend Cycle', { fast: 23, slow: 50, cycle: 10 },
      p => new ta.STC({ fastInterval: p.fast, slowInterval: p.slow, cycleInterval: p.cycle })),
    KST: indicator('Know Sure Thing', {}, () => new ta.KST()),
    COPPOCK: indicator('Coppock Curve', { fast: 11, slow: 14, smoothing: 10 },
      p => new ta.CoppockCurve({ shortRocInterval: p.fast, longRocInterval: p.slow, wmaInterval: p.smoothing })),
    CONNORS_RSI: indicator('Connors RSI', { rsi: 3, streak: 2, rank: 100 },
      p => new ta.ConnorsRSI({ rsiInterval: p.rsi, streakRsiInterval: p.streak, percentRankInterval: p.rank })),
    RCI: indicator('Rank Correlation Index', { period: 9 }, p => new ta.RCI(p.period)),
    RMI: indicator('Relative Momentum Index', { period: 14, momentum: 5 },
      p => new ta.RMI({ interval: p.period, momentum: p.momentum })),
    BOP: indicator('Balance of Power', {}, () => new ta.BOP()),
    IMI: indicator('Intraday Momentum Index', { period: 14 }, p => new ta.IMI(p.period)),
    FISHER: indicator('Fisher Transform', { period: 10 }, p => new ta.FisherTransform(p.period)),
    DPO: indicator('Detrended Price Oscillator', { period: 20 }, p => new ta.DPO(p.period)),
    ELDER_RAY: indicator('Elder Ray Index', { period: 13 }, p => new ta.ElderRay(p.period)),
    DEMARKER: indicator('DeMarker', { period: 14 }, p => new ta.DeMarker({ interval: p.period })),
    CG: indicator('Center of Gravity Oscillator', { period: 10, signal: 3 }, p => new ta.CG(p.period, p.signal)),
    DERIVATIVE_OSC: indicator('Derivative Oscillator', {}, () => new ta.DerivativeOscillator()),
    QQE: indicator('Quantitative Qualitative Estimation', { rsi: 14, smoothing: 5, factor: 4.236 },
      p => new ta.QQE({ rsiInterval: p.rsi, smoothInterval: p.smoothing, fastFactor: p.factor })),
  },
  volatility: {
    BBANDS: indicator('Bollinger Bands', { period: 20, deviations: 2 }, p => new ta.BollingerBands(p.period, p.deviations)),
    BB_WIDTH: indicator('Bollinger Bandwidth', { period: 20, deviations: 2 },
      p => new ta.BollingerBandsWidth(new ta.BollingerBands(p.period, p.deviations))),
    BB_PERCENT_B: indicator('Bollinger Percent B', { period: 20, deviations: 2 },
      p => new ta.PercentB({ interval: p.period, deviationMultiplier: p.deviations })),
    ATR: indicator('Average True Range', { period: 14 }, p => new ta.ATR(p.period, ta.WSMA)),
    NATR: indicator('Normalized Average True Range', { period: 14 }, p => new ta.NATR(p.period, ta.WSMA)),
    TR: indicator('True Range', {}, () => new ta.TR()),
    DONCHIAN: indicator('Donchian Channels', { period: 20 }, p => new ta.DonchianChannels(p.period)),
    KELTNER: indicator('Keltner Channels', { period: 20, atr_period: 10, multiplier: 2 },
      p => new ta.KeltnerChannels({ emaInterval: p.period, atrInterval: p.atr_period, multiplier: p.multiplier })),
    ACCEL_BANDS: indicator('Acceleration Bands', { period: 20, factor: 4 }, p => new ta.AccelerationBands(p.period, p.factor)),
    TTM_SQUEEZE: indicator('TTM Squeeze', {}, () => new ta.TTMSqueeze()),
    CHOP: indicator('Choppiness Index', { period: 14 }, p => new ta.CHOP(p.period)),
    ULCER: indicator('Ulcer Index', { period: 14 }, p => new ta.UlcerIndex(p.period)),
    ROGERS_SATCHELL: indicator('Rogers–Satchell Volatility', { period: 20 }, p => new ta.RogersSatchellVolatility(p.period)),
    RVI: indicator('Relative Volatility Index', { period: 14, deviation_period: 10 },
      p => new ta.RelativeVolatilityIndex({ interval: p.period, stddevInterval: p.deviation_period })),
    CHAIKIN_VOL: indicator('Chaikin Volatility', { period: 10 }, p => new ta.CVI(p.period)),
    MASS_INDEX: indicator('Mass Index', { period: 25 }, p => new ta.MassIndex(p.period)),
    ZSCORE: indicator('Rolling Z-Score', { period: 20 }, p => new ta.ZScore(p.period)),
    RWI: indicator('Random Walk Index', { period: 14 }, p => new ta.RandomWalkIndex(p.period)),
  },
  volume: {
    VWAP: {
      name: 'Rolling Volume-Weighted Average Price', defaults: { period: 20 },
      create({ period }) {
        const size = Number(period);
        const window: Candle[] = [];
        return {
          minimumBars: size,
          update(bar) {
            window.push(bar);
            if (window.length > size) window.shift();
            if (window.length < size) return null;
            const base = window.reduce((sum, row) => sum + row.volume, 0);
            return base > 0 ? window.reduce((sum, row) => sum + row.quoteVolume, 0) / base : null;
          },
        };
      },
    },
    VWMA: indicator('Volume Weighted Moving Average', { period: 20 }, p => new ta.VWMA(p.period)),
    OBV: indicator('On Balance Volume', {}, () => new ta.OBV(2)),
    CMF: indicator('Chaikin Money Flow', { period: 20 }, p => new ta.CMF(p.period)),
    MFI: indicator('Money Flow Index', { period: 14 }, p => new ta.MFI(p.period)),
    AD: indicator('Accumulation/Distribution Line', {}, () => new ta.AD()),
    ADOSC: indicator('Chaikin Oscillator', { fast: 3, slow: 10 }, p => new ta.ADOSC({ fastPeriod: p.fast, slowPeriod: p.slow })),
    FORCE_INDEX: indicator('Elder Force Index', { period: 13 }, p => new ta.ForceIndex(p.period)),
    EOM: indicator('Ease of Movement', { period: 14 }, p => new ta.EMV(p.period)),
    KVO: indicator('Klinger Volume Oscillator', { fast: 34, slow: 55 }, p => new ta.KVO(p.fast, p.slow)),
    PVT: indicator('Price Volume Trend', {}, () => new ta.PVT()),
    RVOL: indicator('Relative Volume', { period: 20 }, p => new ta.RVOL(p.period)),
    PVO: indicator('Percentage Volume Oscillator', { fast: 12, slow: 26 }, p => new ta.PVO({ fastPeriod: p.fast, slowPeriod: p.slow })),
    VROC: indicator('Volume Rate of Change', { period: 14 }, p => new ta.VROC(p.period)),
    NVI: indicator('Negative Volume Index', {}, () => new ta.NVI()),
    PVI: indicator('Positive Volume Index', {}, () => new ta.PVI()),
    WAD: indicator('Williams Accumulation/Distribution', {}, () => new ta.WAD()),
  },
};

for (const [category, definitions] of Object.entries(extraStudyGroups)) {
  groups[category] = { ...groups[category], ...definitions };
}
export const indicatorCatalog = Object.entries(groups).flatMap(([category, definitions]) =>
  Object.entries(definitions).map(([id, definition]) => ({ id, category, ...definition })));

const byId = new Map(indicatorCatalog.map(definition => [definition.id, definition]));
const fractions = new Set(['offset', 'sigma', 'factor', 'step', 'maximum', 'multiplier', 'deviations',
  'fast_limit', 'slow_limit', 'deviation_percent', 'value_area']);

export function prepareIndicator(input: { id: string; parameters?: unknown }) {
  const id = input.id.trim().toUpperCase();
  const definition = byId.get(id);
  if (!definition) throw new Error(`不支持指标 ${input.id}。请先调用 crypto_indicators（action=list）。`);
  const supplied = input.parameters === undefined ? {} : input.parameters;
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error(`${id} parameters 必须是对象。`);
  }
  const parameters = { ...definition.defaults };
  for (const [key, value] of Object.entries(supplied)) {
    const expected = parameters[key];
    const valid = typeof expected === 'string'
      ? typeof value === 'string' && (definition.options?.[key]?.includes(value) ??
        (key === 'reference_symbol' ? /^[\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+)?$/u.test(value) && value.length <= 48
          : value === '' || /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value))))
      : typeof value === 'number' && Number.isFinite(value) &&
        (fractions.has(key) ? value > 0 && value <= 100 : Number.isInteger(value) && value >= 2 && value <= 500);
    if (!Object.hasOwn(parameters, key) || !valid || (key === 'bins' && Number(value) > 100)) {
      throw new Error(`${id} 的 ${key} 参数无效。支持的参数和默认值：${JSON.stringify(definition.defaults)}`);
    }
    parameters[key] = value as number | string;
  }
  if (parameters.fast !== undefined && Number(parameters.fast) >= Number(parameters.slow)) throw new Error(`${id} 的 fast 应小于 slow。`);
  if (parameters.start && parameters.end && Date.parse(String(parameters.end)) <= Date.parse(String(parameters.start))) {
    throw new Error(`${id} 的 end 必须晚于 start。`);
  }
  const make = definition.create;
  const create = make && ((context?: StudyContext) => make(parameters, context));
  create?.(); // Validate constructors before reading market data.
  return { id, parameters, create, input: definition.input };
}
