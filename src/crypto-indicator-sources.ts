import { sourceSetting } from './source-config.js';
import { execFile } from 'node:child_process';
import { get } from 'node:https';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const curl = promisify(execFile);
const day = 86_400_000;
const spot = sourceSetting('PM_BINANCE_SPOT_URL') + '/api/v3/klines';
const futures = sourceSetting('PM_BINANCE_FUTURES_URL');
const funding = '/fapi/v1/fundingRate';
const futuresPeriods: Record<string, number> = {
  '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000,
  '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000, '1d': day,
};

export function marketStudyIntervalError(id: string, interval: string, duration: number) {
  if (id === 'SOPR' || id === 'REALIZED_CAP') return interval !== '1d' ? '链上指标使用 UTC 日频数据，请选 1d。' : undefined;
  if (id === 'LIQUIDATION_VOLUME') return day % duration !== 0 ? '日归档仅覆盖能整除 UTC 日的周期。' : undefined;
  if (id !== 'FUNDING_RATE' && !Object.hasOwn(futuresPeriods, interval)) {
    return 'Binance 此接口周期支持 ' + Object.keys(futuresPeriods).join('、') + '。';
  }
}

export function spotUrl(query: Record<string, string | number>) {
  return spot + '?' + new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
}

export async function publicBody(url: string, signal: AbortSignal) {
  const { stdout } = await curl('/usr/bin/curl', [
    '--disable', '--silent', '--show-error', '--noproxy', '*', '--max-time', '12',
    '--max-filesize', '1048576', '--write-out', '\n%{http_code}', url,
  ], { signal, maxBuffer: 1_050_000 }).catch(error => {
    signal.throwIfAborted();
    throw new Error(error.code === 28 ? '行情读取超时。' : '行情读取失败（curl ' + (error.code ?? 'unknown') + '）。');
  });
  const split = stdout.lastIndexOf('\n');
  return { body: stdout.slice(0, split), status: Number(stdout.slice(split + 1)), retrievedAt: new Date().toISOString() };
}

type Point = { time: number; value: unknown };
type Series = {
  provider: string;
  marketType: 'usd_m_perpetual' | 'bitcoin_onchain';
  sourceUrl?: string;
  retrievedAt?: string;
  nativeInterval?: string;
  status: 'ok' | 'delayed' | 'error' | 'no_data' | 'unsupported_interval' | 'invalid_symbol';
  reason?: string;
  points: Point[];
  rows?: unknown;
  method?: string;
};

function finite(value: unknown) {
  return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') &&
    Number.isFinite(Number(value)) ? Number(value) : null;
}

const endpoints: Record<string, string> = {
  FUNDING_RATE: funding, OPEN_INTEREST: '/futures/data/openInterestHist',
  BASIS: '/futures/data/basis', LONG_SHORT_RATIO: '/futures/data/globalLongShortAccountRatio',
};

async function readFutures(id: string, symbol: string, interval: string, cutoff: number, bars: number, signal: AbortSignal): Promise<Series> {
  const base = { provider: 'Binance', marketType: 'usd_m_perpetual' as const };
  if (!/^[A-Z0-9]{4,30}$/.test(symbol)) return { ...base, status: 'invalid_symbol', points: [], reason: '需要 Binance USD-M 永续合约代码。' };
  const path = endpoints[id];
  const native = path === funding ? 'settlement' : interval;
  const query = new URLSearchParams({ limit: String(Math.min(bars, 500)), endTime: String(cutoff) });
  if (path === funding) query.set('symbol', symbol);
  else {
    if (id === 'BASIS') {
      query.set('pair', symbol);
      query.set('contractType', 'PERPETUAL');
    } else query.set('symbol', symbol);
    query.set('period', interval);
  }
  const sourceUrl = futures + path + '?' + query;
  const response = await publicBody(sourceUrl, signal);
  const source = { ...base, sourceUrl, retrievedAt: response.retrievedAt, nativeInterval: native };
  if (response.status !== 200) return { ...source, status: 'error', points: [], reason: 'Binance USD-M HTTP ' + response.status };
  const raw: unknown = JSON.parse(response.body);
  if (!Array.isArray(raw)) return { ...source, status: 'error', points: [], reason: 'Binance USD-M 序列格式无效。' };
  const points: Point[] = [];
  for (const row of raw) {
    if (!row || (row.symbol ?? row.pair) !== symbol) continue;
    const time = finite(row.fundingTime ?? row.timestamp);
    if (time === null || time <= 0 || time > cutoff) continue;
    let value: unknown;
    if (id === 'FUNDING_RATE') value = finite(row.fundingRate);
    else if (id === 'OPEN_INTEREST') {
      const contracts = finite(row.sumOpenInterest), quoteNotional = finite(row.sumOpenInterestValue);
      if (contracts !== null && quoteNotional !== null) value = { contracts, quoteNotional };
    } else if (id === 'BASIS') {
      const basis = finite(row.basis), basisRate = finite(row.basisRate), futuresPrice = finite(row.futuresPrice), indexPrice = finite(row.indexPrice);
      if (basis !== null && basisRate !== null && futuresPrice !== null && indexPrice !== null) {
        value = { basis, basisRate, futuresPrice, indexPrice };
      }
    } else {
      const ratio = finite(row.longShortRatio), longShare = finite(row.longAccount), shortShare = finite(row.shortAccount);
      if (ratio !== null && longShare !== null && shortShare !== null) value = { ratio, longShare, shortShare };
    }
    if (value !== undefined && value !== null) points.push({ time, value });
  }
  points.sort((a, b) => a.time - b.time);
  if (!points.length) return { ...source, status: 'no_data', points, reason: '查询截点没有该指标的 Binance USD-M 记录。' };
  const stale = cutoff - points.at(-1)!.time > (path === funding ? 8 * 3_600_000 : futuresPeriods[interval]) + 300_000;
  return { ...source, status: stale ? 'delayed' : 'ok', points,
    rows: raw, ...(stale ? { reason: '数据源最后观测落后于最近一个原生周期。' } : {}) };
}

let soprCache: { rows: unknown[]; retrievedAt: string; expires: number } | undefined;

async function readChain(id: string, symbol: string, cutoff: number, bars: number, signal: AbortSignal): Promise<Series> {
  const sopr = id === 'SOPR';
  const base = { provider: sopr ? 'BGeometrics' : 'Coin Metrics Community', marketType: 'bitcoin_onchain' as const, nativeInterval: '1d' };
  if (!/^BTC(?:USDT|USDC|FDUSD|USD|EUR|JPY|BRL|GBP|TRY|AUD|DAI|TUSD|ETH|BNB|MXN)$/.test(symbol)) {
    return { ...base, status: 'invalid_symbol', points: [], reason: '当前链上指标只覆盖 Bitcoin。' };
  }
  const utcStart = Math.floor(cutoff / day) * day;
  const query = new URLSearchParams({ assets: 'btc', metrics: 'CapMrktCurUSD,CapMVRVCur', frequency: '1d',
    start_time: new Date(Math.max(0, utcStart - (bars + 2) * day)).toISOString(),
    end_time: new Date(utcStart - day).toISOString(), page_size: String(bars + 2) });
  const sourceUrl = sopr ? sourceSetting('PM_BGEOMETRICS_URL') + '/v1/sopr'
    : sourceSetting('PM_COINMETRICS_URL') + '/v4/timeseries/asset-metrics?' + query;
  let raw: unknown;
  let retrievedAt: string;
  if (sopr && soprCache && Date.now() < soprCache.expires) {
    raw = soprCache.rows;
    retrievedAt = soprCache.retrievedAt;
  } else {
    const response = await publicBody(sourceUrl, signal);
    retrievedAt = response.retrievedAt;
    if (response.status !== 200) return { ...base, sourceUrl, retrievedAt, status: 'error', points: [],
      reason: base.provider + ' HTTP ' + response.status +
        (sopr && response.status === 429 ? '，公开 API 当前限流。' : '') };
    const decoded = JSON.parse(response.body);
    raw = sopr ? decoded : decoded?.data;
    if (sopr && Array.isArray(raw) && raw.length) soprCache = { rows: raw, retrievedAt, expires: Date.now() + 12 * 3_600_000 };
  }
  const source = { ...base, sourceUrl, retrievedAt };
  if (!Array.isArray(raw)) return { ...source, status: 'error', points: [], reason: '链上序列格式无效。' };
  const selected = raw.flatMap(row => {
    const start = sopr ? Number(row?.unixTs) * 1000 : Date.parse(row?.time);
    const cap = finite(row?.CapMrktCurUSD), mvrv = finite(row?.CapMVRVCur);
    const value = sopr ? finite(row?.sopr) : row?.asset === 'btc' && cap !== null && mvrv !== null && mvrv > 0 ? cap / mvrv : null;
    if (!Number.isFinite(start) || start <= 0 || value === null || value < 0 || start % day !== 0 || start + day > cutoff) return [];
    return [{ time: start + day, value, row }];
  }).sort((a, b) => a.time - b.time).slice(-bars);
  const points = selected.map(({ time, value }) => ({ time, value }));
  if (!points.length) return { ...source, status: 'no_data', points, reason: '已完成的 UTC 日没有可用值。' };
  const latest = points.at(-1)!.time;
  const delayed = cutoff - latest >= day;
  return { ...source, status: delayed ? 'delayed' : 'ok', points, rows: selected.map(p => p.row),
    method: sopr ? 'BGeometrics BTC daily SOPR; historical revisions are not reconstructed.'
      : 'Coin Metrics UTC daily CapMrktCurUSD / CapMVRVCur; historical revisions are not reconstructed.',
    ...(delayed ? { reason: sopr ? '公开 SOPR 有约 7 天延迟，实际日期见最后观测。' : '提供商尚未发布最近一个已完成的 UTC 日。' } : {}) };
}

const tardisOrigin = new URL(sourceSetting('PM_TARDIS_URL')).origin;

function archive(url: string, signal: AbortSignal, key?: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, signal, headers: { Accept: 'application/gzip', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    }, response => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode) &&
          response.headers.location && redirects < 2) {
        response.resume();
        const destination = new URL(response.headers.location, url);
        const sameOrigin = destination.origin === tardisOrigin;
        if (destination.protocol !== 'https:' || destination.username || destination.password ||
            (!sameOrigin && destination.hostname !== 's3.us-east-1.wasabisys.com')) {
          reject(new Error('Tardis 归档返回了未验证的跳转地址。'));
          return;
        }
        resolve(archive(destination.href, signal, sameOrigin ? key : undefined, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Tardis HTTP ' + response.statusCode));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > 4_000_000) { response.destroy(new Error('爆仓文件超过读取上限。')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Tardis 读取超时。')));
    request.on('error', reject);
  });
}

async function readLiquidations(symbol: string, interval: string, duration: number, cutoff: number, bars: number, signal: AbortSignal): Promise<Series> {
  const base = { provider: 'Tardis.dev / Binance USD-M', marketType: 'usd_m_perpetual' as const, nativeInterval: interval };
  if (!/^[A-Z0-9]{4,30}$/.test(symbol)) return { ...base, status: 'invalid_symbol', points: [], reason: '需要 Binance USD-M 永续合约代码。' };
  const key = process.env.PM_CRYPTO_TARDIS_API_KEY;
  const lastDay = Math.floor(cutoff / day) * day - day;
  const target = new Date(lastDay);
  if (!key) target.setUTCDate(1);
  const start = target.getTime();
  const date = target.toISOString().slice(0, 10);
  const sourceUrl = sourceSetting('PM_TARDIS_URL') + '/v1/binance-futures/liquidations/' + date.replaceAll('-', '/') + '/' + symbol + '.csv.gz';
  const source = { ...base, sourceUrl };
  try {
    const body = await archive(sourceUrl, signal, key);
    const text = gunzipSync(body, { maxOutputLength: 16_000_000 }).toString();
    const [header, ...lines] = text.trim().split(/\r?\n/);
    if (header !== 'exchange,symbol,timestamp,local_timestamp,id,side,price,amount') throw new Error('爆仓归档字段与文档不一致。');
    const bins = Array.from({ length: day / duration }, () => ({ quoteNotional: 0, forcedBuy: 0, forcedSell: 0, events: 0 }));
    const accepted: string[] = [];
    for (const line of lines) {
      const [exchange, market, event, arrival, , side, price, amount] = line.split(',');
      const time = Number(arrival) / 1000;
      const notional = Number(price) * Number(amount);
      if (exchange !== 'binance-futures' || market !== symbol || !Number.isFinite(Number(event)) ||
          !Number.isFinite(time) || time < start || time >= start + day ||
          !Number.isFinite(notional) || notional <= 0 || (side !== 'buy' && side !== 'sell')) continue;
      const bin = bins[Math.floor((time - start) / duration)];
      bin.quoteNotional += notional;
      bin[side === 'buy' ? 'forcedBuy' : 'forcedSell'] += notional;
      bin.events++;
      accepted.push(line);
    }
    if (accepted.length !== lines.length) throw new Error('爆仓归档存在交易对、日期或字段不匹配的行。');
    const points = bins.map((value, i) => ({ time: start + (i + 1) * duration, value })).slice(-bars);
    const delayed = cutoff - points.at(-1)!.time >= duration;
    return { ...source, retrievedAt: new Date().toISOString(), status: delayed ? 'delayed' : 'ok',
      points, rows: { date, header, events: accepted },
      method: 'Binance forced-liquidation events bucketed by Tardis receipt time, which defines the archive day. Binance throttles publication.',
      ...(delayed ? { reason: key ? '日归档只覆盖已完成的 UTC 日。' : '公开归档只开放每月首日，返回最近一份已覆盖的公开日。' } : {}) };
  } catch (error) {
    signal.throwIfAborted();
    return { ...source, status: 'error', points: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function readMarketStudy(id: string, symbol: string, interval: string, duration: number, cutoff: number, bars: number, signal: AbortSignal): Promise<Series> {
  const chain = id === 'SOPR' || id === 'REALIZED_CAP';
  const reason = marketStudyIntervalError(id, interval, duration);
  if (reason) return { provider: id === 'SOPR' ? 'BGeometrics' : id === 'REALIZED_CAP' ? 'Coin Metrics Community' : 'Binance',
    marketType: chain ? 'bitcoin_onchain' : 'usd_m_perpetual', status: 'unsupported_interval', points: [], reason };
  if (id === 'LIQUIDATION_VOLUME') return readLiquidations(symbol, interval, duration, cutoff, bars, signal);
  if (chain) return readChain(id, symbol, cutoff, bars, signal);
  return readFutures(id, symbol, interval, cutoff, bars, signal);
}
