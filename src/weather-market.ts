import { sourceSetting } from './source-config.js';
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DatabaseSync } from 'node:sqlite';
import { resolveMarket } from './data.js';
import { officialBody, readOfficialPdf } from './market-web-search.js';
import type { createPolymarketPublicReader } from './polymarket-public.js';
import { buildRuleCard } from './research.js';
import { sourceSnapshotFromEvidence, type EvidenceRow } from './source-evidence.js';
import { now, saveEvidence } from './store.js';
import { weatherConditions, weatherSource, type WatchHost, type WatchItemRequest, type WatchObservation, type WatchRead } from './tasks.js';
import { createWeatherLocation, locationParameters, type LocationQuery, type WeatherDiscoveryQuery } from './weather-location.js';

import { createAirportFactors, supportsAirportFactors } from './weather-airport.js';

export { weatherSource };
export const weatherInterval = 60;
type WeatherCondition = typeof weatherConditions[number];
const hour = 3600_000;
const day = 24 * hour;
const iso = (time: number) => new Date(time).toISOString();
const digest = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const epoch = (time: unknown) => typeof time === 'string' && /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(time) ? Date.parse(time) : NaN;
const months = 'January February March April May June July August September October November December'.split(' ');
const monthPattern = months.map(m => m.slice(0, 3) + '(?:' + m.slice(3) + ')?').join('|');
const dailyTemperatureSlug = new RegExp(`^(highest|lowest)-temperature-in-([a-z]+(?:-[a-z]+)*)-on-(${monthPattern})-(\\d{1,2})-(20\\d{2})$`, 'i');
export function isDailyTemperatureMarketLink(value: string) {
  const url = URL.parse(value);
  const path = url?.pathname.split('/').filter(Boolean);
  return url?.protocol === 'https:' && ['polymarket.com','www.polymarket.com'].includes(url.hostname) &&
    path?.[0] === 'event' && path.length <= 3 && dailyTemperatureSlug.test(path[1] ?? '');
}
const timeZones: Record<string, string> = {
  EGLC: 'Europe/London', EGLL: 'Europe/London', KLGA: 'America/New_York', KJFK: 'America/New_York', KNYC: 'America/New_York',
  KATL: 'America/New_York', KMIA: 'America/New_York', KBOS: 'America/New_York', KPHL: 'America/New_York',
  KORD: 'America/Chicago', KMDW: 'America/Chicago', KDFW: 'America/Chicago', KDAL: 'America/Chicago',
  KIAH: 'America/Chicago', KHOU: 'America/Chicago', KAUS: 'America/Chicago',
  KDEN: 'America/Denver', KPHX: 'America/Phoenix', KLAX: 'America/Los_Angeles', KSFO: 'America/Los_Angeles',
  KSEA: 'America/Los_Angeles', CYYZ: 'America/Toronto', CYVR: 'America/Vancouver', LFPG: 'Europe/Paris', LFPB: 'Europe/Paris',
  EHAM: 'Europe/Amsterdam', EDDB: 'Europe/Berlin', EDDM: 'Europe/Berlin', LEMD: 'Europe/Madrid', LIRF: 'Europe/Rome',
  LIMC: 'Europe/Rome', EFHK: 'Europe/Helsinki', EPWA: 'Europe/Warsaw', UUWW: 'Europe/Moscow',
  RJTT: 'Asia/Tokyo', RKSI: 'Asia/Seoul', RKPK: 'Asia/Seoul', VHHH: 'Asia/Hong_Kong',
  ZSPD: 'Asia/Shanghai', ZBAA: 'Asia/Shanghai', ZUUU: 'Asia/Shanghai', ZUCK: 'Asia/Shanghai', ZHHH: 'Asia/Shanghai',
  ZGSZ: 'Asia/Shanghai', ZGGG: 'Asia/Shanghai', ZSQD: 'Asia/Shanghai', RCSS: 'Asia/Taipei',
  WSSS: 'Asia/Singapore', WMKK: 'Asia/Kuala_Lumpur', RPLL: 'Asia/Manila', VILK: 'Asia/Kolkata', OPKC: 'Asia/Karachi',
  LLBG: 'Asia/Jerusalem', OEJN: 'Asia/Riyadh', LTAC: 'Europe/Istanbul', LTFM: 'Europe/Istanbul',
  YSSY: 'Australia/Sydney', NZAA: 'Pacific/Auckland', NZWN: 'Pacific/Auckland', FACT: 'Africa/Johannesburg',
  MMMX: 'America/Mexico_City', MPMG: 'America/Panama', SBGR: 'America/Sao_Paulo', SAEZ: 'America/Argentina/Buenos_Aires',
};
const wundergroundStations: Record<string, string> = { EGLC: 'gb/london/EGLC', KLGA: 'us/ny/new-york-city/KLGA' };
const stationCoordinates: Record<string, [number, number]> = {
  EGLC: [51.5053, 0.0553], EGLL: [51.4700, -0.4543], KLGA: [40.7772, -73.8726], LFPB: [48.9694, 2.4414],
  KORD: [41.9786, -87.9048], WSSS: [1.3644, 103.9915], KNYC: [40.7790, -73.9692],
  // AWC stationinfo, and HKO's published headquarters location (22°18′07″N 114°10′27″E).
  RKPK: [35.179, 128.938], RKSI: [37.469, 126.451], RJTT: [35.553, 139.781],
  EDDM: [48.348, 11.813], LEMD: [40.466, -3.555], HKO: [22.301944, 114.174167],
};
const regionalModels: Record<string, string> = {
  RKPK: 'jma_msm', RKSI: 'jma_msm', RJTT: 'jma_msm', EDDM: 'icon_d2', LEMD: 'icon_eu',
};

type Target = {
  platform: 'polymarket' | 'kalshi'; market: string; url: string; title: string; conditionId?: string;
  localMarketId?: number; gammaMarketId?: string; eventSlug?: string; selectedToken?: string;
  options: { tokenId: string; label: string }[]; createdAt?: string;
};
type Band = { label: string; min?: number; max?: number; market: string; conditionId: string; yesToken: string; noToken?: string; url: string };
type ContractBase = {
  target: Target; ruleVersion: string; ruleEvidenceIds: string[]; rules: string; quotes: Record<string, string>;
  window: { from: string; to: string; timeZone: string; dayRule: string; date?: string };
  primary: { publisher: string; url: string }; backup?: { publisher: string; condition: string; url?: string };
  online: boolean; cutoff?: string;
};
type Temperature = ContractBase & {
  kind: 'temperature_max' | 'temperature_min'; adapter: 'awc_raw' | 'noaa_integer_table' | 'hko_daily_extract';
  station: string; stationName?: string; unit: 'C' | 'F'; bands: Band[];
};
type Climate = ContractBase & {
  kind: 'snowfall_occurrence' | 'precipitation_sum'; station: string; product: string; siteName: string; unit: 'in';
  dates: string[]; threshold?: { op: 'gt' | 'lt' | 'between'; low: number; high?: number };
};
type Cyclone = ContractBase & {
  kind: 'tropical_cyclone'; measure: 'count' | 'landfall'; basin?: string; region?: string;
  minMph: number; selectedBand?: { min: number; max?: number }; possibleExtensionUntil?: string;
};
export type WeatherContractSpec = Temperature | Climate | Cyclone;
const isTemperature = (spec: WeatherContractSpec): spec is Temperature => ['temperature_max','temperature_min'].includes(spec.kind);
export type WeatherSourceSnapshot = EvidenceRow & { data: { kind: 'weather_source_snapshot'; adapter: string; publisher: string; status: string;
  raw: string; httpStatus: number | null; reason?: string; publishedAt: string | null; responseDate?: string; cacheAgeSeconds?: number } };
type Coverage = 'covered' | 'partial' | 'pending' | 'stale' | 'failed' | 'unsupported';
type Platform = { status: string; evidenceIds: string[]; outcome?: string; tokenId?: string; resolvedAt?: string; source?: string;
  oracleStatus?: string; gammaStatus?: string; closesAt?: string; open?: boolean; comparison?: string };
type Metar = { at: string; local: string; beijing: string; raw: string; line: number; evidenceId: string;
  station: string; tenthsC: number | null; method: 'T' | 'body' | null; field: string | null; column: number | null;
  correction: boolean; publishedAt: null; seenAt: string };
type TempResult = ReturnType<typeof temperatureCheck>;

const monthNumber = (value: string) => months.findIndex(m => m.slice(0, 3).toLowerCase() === value.slice(0, 3).toLowerCase());
const calendarDate = (year: number, month: number, date: number) => {
  const at = new Date(Date.UTC(year, month, date));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month || at.getUTCDate() !== date) throw Error('规则日历日期无效。');
  return at.toISOString().slice(0, 10);
};
const addDays = (date: string, n: number) => iso(Date.parse(date) + n * day).slice(0, 10);
const clocks = new Map<string, Intl.DateTimeFormat>();
function clock(timeZone: string, at: number) {
  let formatter = clocks.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
    clocks.set(timeZone, formatter);
  }
  return formatter.format(at);
}
function atLocal(date: string, zone: string, hhmm = '00:00') {
  const naive = Date.parse(date + 'T' + hhmm + ':00Z');
  const offset = (at: number) => {
    const match = /GMT([+−-])(\d\d):(\d\d)$/.exec(clock(zone, at));
    return match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000 : 0;
  };
  const at = naive - offset(naive - offset(naive));
  if (!clock(zone, at).startsWith(date + ' ' + hhmm)) throw Error('当地时间无法定位。');
  return iso(at);
}
const et = 'America/New_York';
const est = 'Etc/GMT+5';
const dateIn = (at: number, zone: string) => clock(zone, at).slice(0, 10);
const ymd = (month: string, d: string, y: string) => calendarDate(Number(y) + (y.length === 2 ? 2000 : 0), monthNumber(month), Number(d));
const fullDate = new RegExp('(' + monthPattern + ') (\\d{1,2}),? (20\\d{2})', 'i');
const endOfMinute = (date: string, zone: string) => iso(epoch(atLocal(date, zone, '23:59')) + 60_000);
const listDays = (from: string, to: string) => Array.from({ length: (Date.parse(to) - Date.parse(from)) / day }, (_, i) => addDays(from, i));
const optionToken = (target: Target, label: string) => target.options.find(x => x.label.toLowerCase() === label.toLowerCase())?.tokenId;
function https(value: string) {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw Error('需要准确的官方 HTTPS 地址。');
  return url;
}
function awcRequest(value: string, station: string) {
  const url = https(value);
  const fields = [...url.searchParams.keys()].sort().join(',');
  const date = url.searchParams.get('date') ?? '';
  const hours = Number(url.searchParams.get('hours'));
  if (url.hostname !== 'aviationweather.gov' || url.pathname !== '/api/data/metar' || fields !== 'date,format,hours,ids' ||
      url.searchParams.get('ids') !== station || !/^[A-Z][A-Z\d]{3}$/.test(station) || url.searchParams.get('format') !== 'raw' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(date) || iso(epoch(date)).replace('.000Z', 'Z') !== date ||
      !Number.isInteger(hours) || hours < 1 || hours > 72) throw Error('AWC 地址、站点或请求范围和规则不符。');
  return { url: url.href, from: epoch(date) - hours * hour, to: epoch(date) };
}

function band(label: string, unit: 'C' | 'F') {
  const match = new RegExp('^(-?\\d+)(?:\\s*[-–]\\s*(-?\\d+))?\\s*°' + unit + '(?: or (below|higher|above))?$', 'i')
    .exec(label.trim().replaceAll('−', '-'));
  if (!match || match[2] && (match[3] || +match[2] < +match[1])) return;
  return { label, min: match[3] === 'below' ? undefined : +match[1],
    max: match[3] && match[3] !== 'below' ? undefined : +(match[2] ?? match[1]) };
}
const includes = (bounds: { min?: number; max?: number }, n: number) =>
  n >= (bounds.min ?? -Infinity) && n <= (bounds.max ?? Infinity);
function projectedBracketValue(celsius: number, unit: 'C' | 'F') {
  const millic = Math.round(celsius * 1000);
  const numerator = unit === 'F' ? millic * 9 + 160_000 : millic;
  const denominator = unit === 'F' ? 5000 : 1000;
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}
const hkoLive = sourceSetting('PM_HKO_DATA_URL') + '/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv';
const hkoIndex = sourceSetting('PM_HKO_WEB_URL') + '/en/cis/climat.htm';

function bindTemperature(base: Omit<ContractBase, 'window' | 'primary' | 'online' | 'quotes'>, rows: Record<string, any>[]): Temperature {
  const rules = base.rules;
  const awc = /^This market will resolve to the temperature range that contains the (highest|lowest) temperature reported at (.+?) \(([A-Z0-9]{4})\) on (\d\d?) (\w+) '(\d\d)\./.exec(rules);
  const hko = /^This market will resolve to the temperature range that contains the (highest|lowest) temperature recorded by the Hong Kong Observatory in degrees Celsius on (\d\d?) (\w+) '(\d\d)\./.exec(rules);
  const noaa = /^This market will resolve to the temperature range that contains the highest temperature recorded by NOAA at .+? in degrees (Celsius|Fahrenheit) on (\d\d?) (\w+) '(\d\d)\./.exec(rules);
  const noaaUrl = /https:\/\/www\.weather\.gov\/wrh\/timeseries\?site=([a-z\d]{4})\b/i.exec(rules);
  if (!awc && !hko && !(noaa && noaaUrl && rules.includes('"Temp" column') && rules.includes('whole degrees'))) throw Error('最高温来源或精度条款尚待核对。');
  const minimum = (awc?.[1] ?? hko?.[1]) === 'lowest';
  const station = hko ? 'HKO' : awc?.[3] ?? noaaUrl![1].toUpperCase();
  const timeZone = hko ? 'Asia/Hong_Kong' : timeZones[station];
  if (!timeZone) throw Error('尚未核验指定站的 IANA 时区。');
  const date = awc ? ymd(awc[5], awc[4], awc[6]) : hko ? ymd(hko[3], hko[2], hko[4]) : ymd(noaa![3], noaa![2], noaa![4]);
  const next = addDays(date, 1);
  const from = atLocal(date, timeZone);
  const to = atLocal(next, timeZone);
  const unitText = awc ? /states its range in whole degrees (Celsius|Fahrenheit)\./.exec(rules)?.[1] : hko ? 'Celsius' : noaa![1];
  if (!unitText) throw Error('档位单位不明确。');
  const unit = unitText === 'Fahrenheit' ? 'F' : 'C';
  const url = awc ? rules.match(/https:\/\/aviationweather\.gov\/api\/data\/metar\?[^\s<]+/)?.[0]
    : hko ? `${sourceSetting('PM_HKO_WEB_URL')}/cis/dailyExtract/dailyExtract_${date.slice(0, 7).replace('-', '')}.xml` : noaaUrl![0];
  const paragraphs = rules.split(/\n\s*\n/);
  const clauses = (phrases: string[]) => Object.fromEntries(phrases.map(phrase => [phrase, paragraphs.find(p => p.includes(phrase)) ?? '']));
  const quotes = clauses(awc ? ['qualifying value', 'exactly eight digits', 'temperature group in the body', 'exactly half rounded up',
    "including any daylight-saving shift", 'issuance of the first METAR', 'Weather Underground Daily Observations', 'marked as a correction',
    'clearly erroneous'] : hko ? [hkoIndex, minimum ? 'Absolute Daily Min (deg. C)' : 'Absolute Daily Max (deg. C)', 'one decimal place',
    '11:59 PM ET on the seventh day', 'lowest bracket', 'initial publication', 'clearly erroneous']
    : ['"Temp" column', 'Weather Underground Daily Observations', 'lowest bracket', 'whole degrees', 'Revisions to temperatures']);
  if (!url || Object.values(quotes).some(q => !q) || awc && (unit === 'F' && !rules.includes('°F = °C × 9/5 + 32') ||
      !rules.includes('Every other report is routine') || !rules.includes('by 11:59 PM ET on the day following'))) throw Error('报文、换算或冻结规则和已支持版本不符。');
  if (awc) {
    const request = awcRequest(url, station);
    if (request.from > epoch(from) || request.to <= epoch(to) || request.to > epoch(to) + 12 * hour) throw Error('AWC 请求范围无法核对观测日和次日触发。');
  }
  const bands = rows.flatMap(row => {
    if (row.description !== rules || !row.conditionId || awc && row.resolutionSource && row.resolutionSource !== url) return [];
    const range = band(String(row.groupItemTitle ?? ''), unit);
    const tokens = findTokens(row);
    const yes = tokens.find(t => t.label === 'Yes');
    const no = tokens.find(t => t.label === 'No');
    if (!range || !yes || !no || !/^[a-z\d-]+$/.test(row.slug)) return [];
    return [{ ...range, market: row.slug, conditionId: row.conditionId, yesToken: yes.tokenId, noToken: no.tokenId,
      url: `${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${base.target.eventSlug}/${row.slug}` }];
  }).sort((a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity));
  if (!bands.some(b => b.market === base.target.market && b.conditionId === base.target.conditionId &&
      b.yesToken === optionToken(base.target, 'yes'))) throw Error('子合约档位或 Yes token 与官方事件不匹配。');
  if (bands.some((b, i) => i && (bands[i - 1].max ?? Infinity) >= (b.min ?? -Infinity))) throw Error('已核对档位存在重叠。');
  return { ...base, kind: minimum ? 'temperature_min' : 'temperature_max', adapter: awc ? 'awc_raw' : hko ? 'hko_daily_extract' : 'noaa_integer_table', online: Boolean(awc || hko),
    station, stationName: hko ? 'Hong Kong Observatory headquarters' : awc?.[2], unit, bands, quotes,
    window: { date, from, to, timeZone, dayRule: 'station_local_calendar_day' },
    primary: { publisher: awc ? 'NWS Aviation Weather Center' : hko ? 'Hong Kong Observatory Daily Extract' : 'NOAA Weather & Hazards Data Viewer', url },
    backup: hko ? undefined : { publisher: 'Weather Underground Daily Observations', condition: quotes['Weather Underground Daily Observations'],
      url: wundergroundStations[station] && `${sourceSetting('PM_WUNDERGROUND_URL')}/history/daily/${wundergroundStations[station]}/date/${date}` },
    cutoff: atLocal(hko ? addDays(date, 7) : next, et, '23:59') };
}

function findTokens(row: Record<string, any>) {
  function array(value: unknown): unknown[] {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } }
    return Array.isArray(value) ? value : [];
  }
  const tokens = array(row.clobTokenIds);
  const labels = array(row.outcomes);
  return tokens.length === labels.length ? tokens.flatMap((tokenId, i) =>
    typeof tokenId === 'string' && /^\d{1,78}$/.test(tokenId) && typeof labels[i] === 'string'
      ? [{ tokenId, label: labels[i] as string }] : []) : [];
}

function bindSnow(base: Omit<ContractBase, 'window' | 'primary' | 'online' | 'quotes'>, market: Record<string, any>): Climate {
  const r = base.rules;
  const station = /measured only at station ([A-Z0-9]{4}), which the National Weather Service reports as "([^"]+)"/.exec(r);
  const tz = /climate day at [A-Z0-9]{4} \(midnight to midnight local time, ([A-Za-z_]+\/[A-Za-z_]+)\)/.exec(r)?.[1];
  const product = /issued as product (CLI[A-Z]{3})/.exec(r)?.[1];
  const deadline = new RegExp('by (' + monthPattern + ') (\\d{1,2})', 'i').exec(base.target.title);
  const creation = epoch(market.createdAt);
  const version = r.split(/\n\s*\n/).find(p => p.includes('first final Daily Climate Report'));
  if (!station || !tz || !deadline || !product || !version || !Number.isFinite(creation) ||
      !r.includes('"T" (trace)') || !version.includes('shown as "M"') || !version.includes('month-to-date or season-to-date') ||
      !version.includes('3rd day after the specified date')) throw Error('NWS 降雪站、日期或报表版本条款尚待核对。');
  const startDate = dateIn(creation, tz);
  let endDate = ymd(deadline[1], deadline[2], startDate.slice(0, 4));
  if (endDate < startDate) endDate = ymd(deadline[1], deadline[2], String(+startDate.slice(0, 4) + 1));
  const cutoff = atLocal(addDays(endDate, 3), et, '23:59');
  if (epoch(market.endDate) !== epoch(cutoff) || Date.parse(endDate) - Date.parse(startDate) > 180 * day)
    throw Error('市场日期与 3 天发布宽限不一致。');
  const dates = listDays(startDate, addDays(endDate, 1));
  // KPIT/CLIPIT climate reports label standard-time days, including during DST.
  if (product !== 'CLIPIT' || station[1] !== 'KPIT' || station[2] !== 'PITTSBURGH PA' || tz !== et) throw Error('尚未核验该站点的 NWS 气候日与产品对应关系。');
  return { ...base, kind: 'snowfall_occurrence', station: station[1], product, siteName: station[2], unit: 'in', dates, online: true, cutoff,
    quotes: { version, scope: r.split('\n\n')[0] },
    primary: { publisher: 'NWS Daily Climate Report', url: market.resolutionSource },
    window: { from: atLocal(startDate, est), to: atLocal(addDays(endDate, 1), est), timeZone: tz,
      dayRule: 'NWS climate day label, local standard time; market deadlines use the stated local civil clock' } };
}

function bindCyclone(base: Omit<ContractBase, 'window' | 'primary' | 'online' | 'quotes'>, market: Record<string, any>): Cyclone {
  const r = base.rules;
  const dateMatch = fullDate.exec(r);
  const creation = epoch(market.createdAt);
  if (!dateMatch || !r.includes('11:59 PM ET') || !Number.isFinite(creation) || !r.includes('74 mph') ||
      !/initial NHC/.test(r) || !r.includes('nhc.noaa.gov')) throw Error('NHC 风暴强度、初报版本或时间窗尚待核对。');
  const date = ymd(dateMatch[1], dateMatch[2], dateMatch[3]);
  const count = r.includes('number of storms categorized as a hurricane in the Atlantic');
  const landfall = r.includes("surface center intersects with the coastline") && r.includes('at the time of landfall');
  if (!count && !landfall) throw Error('NHC 飓风规则不在可回放口径内。');
  const region = !count ? /landfall in ([A-Za-z ]+?) by /i.exec(base.target.title)?.[1] : undefined;
  const countBand = /^(\d+)(?:(?:-|–)(\d+)|(\+))?$/.exec(String(market.groupItemTitle ?? '').trim());
  if (count && !countBand || landfall && !region) throw Error('风暴档位或州域不明确。');
  return { ...base, kind: 'tropical_cyclone', measure: count ? 'count' : 'landfall', basin: count ? 'AL' : undefined, region, minMph: 74,
    selectedBand: countBand && count ? { min: +countBand[1], max: countBand[3] ? undefined : +(countBand[2] ?? countBand[1]) } : undefined,
    possibleExtensionUntil: !count && r.includes('extension period of 7 days') ? endOfMinute(addDays(date, 7), et) : undefined,
    quotes: { criterion: r }, online: true, primary: { publisher: 'NOAA National Hurricane Center', url: sourceSetting('PM_NHC_URL') + '/' },
    window: { from: iso(creation), to: endOfMinute(date, et), timeZone: et, dayRule: 'contract creation to stated ET deadline' } };
}

function reportTime(code: string, from: number, to: number) {
  const d = +code.slice(0, 2), h = +code.slice(2, 4), m = +code.slice(4);
  if (d < 1 || d > 31 || h > 23 || m > 59) return;
  const start = new Date(from);
  const candidates = [0, 1].flatMap(i => {
    const at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, d, h, m);
    return new Date(at).getUTCDate() === d && at >= from && at <= to ? [at] : [];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function parseMetarSnapshot(spec: Temperature, source: WeatherSourceSnapshot, asOf: string) {
  const request = awcRequest(source.source, spec.station);
  if (request.url !== spec.primary.url) throw Error('存证地址不是合约指定的 AWC 原始地址。');
  const from = epoch(spec.window.from), to = epoch(spec.window.to), seen = epoch(source.retrievedAt);
  const through = Math.min(epoch(asOf), seen, request.to);
  const groups = new Map<string, Metar[]>();
  const counts = { rawLines: 0, outsideDay: 0, afterAsOf: 0, mismatch: 0, malformed: 0, speci: 0, noTemperature: 0, duplicates: 0, conflicts: 0 };
  const nextOutsideDay: { at: string; line: number; evidenceId: string; raw: string }[] = [];
  const exclusions: { line: number; reason: string }[] = [];
  const lines = source.data.status === 'ok' ? source.data.raw.split(/\r?\n/) : [];
  for (const [index, text] of lines.entries()) {
    const raw = text.trim();
    if (!raw) continue;
    counts.rawLines++;
    const line = index + 1;
    const head = /^(?:(METAR|SPECI)\s+)?(?:(COR)\s+)?([A-Z][A-Z0-9]{3})\s+(\d{6})Z(?:\s|$)/.exec(raw);
    if (!head) { counts.malformed++; exclusions.push({ line, reason: 'unrecognized_header' }); continue; }
    if (head[3] !== spec.station) { counts.mismatch++; exclusions.push({ line, reason: 'station_mismatch' }); continue; }
    if (head[1] === 'SPECI') { counts.speci++; continue; }
    const time = reportTime(head[4], request.from, request.to);
    if (time === undefined) { counts.malformed++; exclusions.push({ line, reason: 'ambiguous_report_time' }); continue; }
    if (time > through) { counts.afterAsOf++; continue; }
    const at = iso(time);
    if (time < from || time >= to) {
      if (dateIn(time, spec.window.timeZone) === addDays(spec.window.date!, 1)) nextOutsideDay.push({ at, line, evidenceId: source.evidenceId, raw });
      counts.outsideDay++;
      continue;
    }
    const bodyEnd = raw.search(/\sRMK(?:\s|$)/);
    const remarks = bodyEnd < 0 ? '' : raw.slice(bodyEnd);
    const t = /(?:^|\s)(T([01])(\d{3})\d{4})(?=\s|=|$)/.exec(remarks);
    const b = /(?:^|\s)((M?\d{2})\/(?:M?\d{2}|\/\/)?)(?=\s|=|$)/.exec(raw.slice(0, bodyEnd < 0 ? undefined : bodyEnd));
    const tenthsC = t ? (t[2] === '1' ? -1 : 1) * Number(t[3]) : b ? Number(b[2].replace('M', '-')) * 10 : null;
    if (tenthsC === null) counts.noTemperature++;
    const column = t ? bodyEnd + t.index + t[0].indexOf(t[1]) + 1 : b ? b.index + b[0].indexOf(b[1]) + 1 : null;
    const report: Metar = { at, local: clock(spec.window.timeZone, time), beijing: clock('Asia/Shanghai', time),
      station: spec.station, raw, line, evidenceId: source.evidenceId, tenthsC, method: t ? 'T' : b ? 'body' : null,
      field: t?.[1] ?? b?.[1] ?? null, column, correction: !!head[2] || /(?:^|\s)COR(?:\s|$)/.test(raw),
      publishedAt: null, seenAt: source.retrievedAt };
    const group = groups.get(at) ?? [];
    if (group.some(r => r.raw === raw)) counts.duplicates++;
    else group.push(report);
    groups.set(at, group);
  }
  const conflicts: { at: string; variants: Metar[] }[] = [];
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([at, records]) => {
    if (new Set(records.map(r => r.tenthsC)).size === 1) {
      counts.duplicates += records.length - 1;
      return records.slice(0, 1);
    }
    // AWC raw export carries no versions or publication times within a response.
    counts.conflicts++;
    conflicts.push({ at, variants: records });
    return [];
  });
  const qualified = rows.filter((r): r is Metar & { tenthsC: number } => r.tenthsC !== null);
  const direction = spec.kind === 'temperature_min' ? -1 : 1;
  const peak = qualified.reduce<typeof qualified[number] | undefined>((best, row) =>
    !best || (row.tenthsC - best.tenthsC) * direction > 0 ? row : best, undefined);
  const last = qualified.at(-1);
  const first = qualified[0];
  const rangeEnd = Math.min(to, through);
  const gaps = first ? [epoch(first.at) - from, ...qualified.slice(1).map((r, i) => epoch(r.at) - epoch(qualified[i].at)),
    Math.max(0, rangeEnd - epoch(last!.at))] : [];
  const firstNext = nextOutsideDay.sort((a, b) => a.at.localeCompare(b.at))[0];
  const reliable = source.data.status === 'ok' && !!counts.rawLines && !counts.mismatch && !counts.malformed &&
    !counts.conflicts && (source.data.cacheAgeSeconds ?? 0) <= 120;
  return { source, request, counts, rows, qualified, peak, last, firstNext, conflicts, exclusions, reliable,
    rangeEnd, maxUnobservedMinutes: gaps.length ? Math.max(...gaps) / 60_000 : null };
}

export function temperatureCheck(spec: Temperature, snapshots: WeatherSourceSnapshot[], asOf: string, fallback?: WeatherSourceSnapshot) {
  const frames = snapshots.map(row => parseMetarSnapshot(spec, row, asOf))
    .sort((a, b) => a.source.retrievedAt.localeCompare(b.source.retrievedAt));
  const asOfMs = epoch(asOf);
  const cutoff = epoch(spec.cutoff);
  const currentFrames = frames.filter(frame => epoch(frame.source.retrievedAt) <= asOfMs);
  const latest = currentFrames.at(-1) ?? frames[0];
  const lastCapture = latest;
  const afterCutoff = asOfMs >= cutoff;
  const firstTrigger = currentFrames.find(frame => frame.reliable && !!frame.firstNext && epoch(frame.source.retrievedAt) <= cutoff);
  const prior = firstTrigger && currentFrames[currentFrames.indexOf(firstTrigger) - 1];
  const capturedTransition = !!(firstTrigger && prior?.reliable && !prior.firstNext &&
    epoch(firstTrigger.source.retrievedAt) - epoch(prior.source.retrievedAt) <= 2 * 60_000);
  const deadlineFrame = afterCutoff && currentFrames.find(frame =>
    epoch(frame.source.retrievedAt) >= cutoff && epoch(frame.source.retrievedAt) - cutoff <= 60_000 && frame.reliable);
  const frozen = capturedTransition ? firstTrigger
    : !firstTrigger && deadlineFrame && epoch(deadlineFrame.source.retrievedAt) === cutoff ? deadlineFrame : undefined;
  const selected = frozen || latest;
  const previous = selected && frames[frames.indexOf(selected) - 1];
  const priorByTime = new Map(previous?.rows.map(row => [row.at, row]) ?? []);
  const revisions = selected?.rows.flatMap(row => {
    const old = priorByTime.get(row.at);
    return old && old.raw !== row.raw ? [{ at: row.at, before: old, after: row, material: old.tenthsC !== row.tenthsC }] : [];
  }) ?? [];
  const lostReports = previous?.qualified.filter(row => !selected?.rows.some(r => r.at === row.at)).map(row => row.at) ?? [];
  const freeze = { status: frozen ? 'captured' : (afterCutoff || latest?.firstNext) ? 'snapshot_unverified' : 'awaiting_trigger',
    trigger: firstTrigger?.firstNext ?? latest?.firstNext ?? null, deadline: spec.cutoff, evidenceId: frozen?.source.evidenceId ?? null,
    priorEvidenceId: capturedTransition ? prior!.source.evidenceId : null,
    observedPublicationBetween: capturedTransition ? [prior!.source.retrievedAt, firstTrigger!.source.retrievedAt] : null,
    postFreezeChanges: frozen && lastCapture && lastCapture !== frozen
      ? lastCapture.rows.flatMap(row => {
        const old = frozen.rows.find(r => r.at === row.at);
        return old?.raw === row.raw ? [] : [{ at: row.at, before: old ?? null, after: row }];
      }) : [] };

  const peak = selected?.peak;
  const primaryFailed = !lastCapture || !['ok', 'empty'].includes(lastCapture.source.data.status);
  const latestUsable = latest?.reliable && !lostReports.length;
  const reasons: string[] = [];
  const retrospective = !!selected && epoch(selected.source.retrievedAt) > asOfMs;
  if (retrospective) reasons.push('截点之后取得的回顾快照，报文在截点可见的版本无法确认');
  if (primaryFailed) reasons.push(lastCapture?.source.data.reason ?? '未取得指定 AWC 原文');
  if (!latestUsable && latest?.counts.rawLines) reasons.push('报文身份、时间、版本冲突、缺行或缓存时效需核对');
  if (asOfMs < epoch(spec.window.from)) reasons.push('测站当地观测日尚未开始');
  if (peak && asOfMs < epoch(spec.window.to)) reasons.push('测站当地观测日仍在进行');
  if (freeze.status === 'snapshot_unverified') reasons.push('缺少规则触发时留存的原始快照');
  const sourceStale = !!latest?.last && asOfMs < epoch(spec.window.to) && asOfMs - epoch(latest.last.at) > 2 * hour;
  if (sourceStale) reasons.push('最近合格报文距截点超过两小时');
  let coverage: Coverage = primaryFailed ? 'failed' : sourceStale ? 'stale'
    : peak ? latestUsable && !retrospective && asOfMs >= epoch(spec.window.to) && selected!.maxUnobservedMinutes! <= 120 &&
       !selected!.counts.noTemperature ? 'covered' : 'partial'
    : latest?.counts.mismatch || latest?.counts.conflicts ? 'partial' : 'pending';
  // A responding, identified station around the deadline can establish primary absence.
  // An HTTP failure, 204 alone, or failure to read the backup table cannot establish absence.
  const primaryAbsence = !!deadlineFrame && !deadlineFrame.peak && !frames.some(f => f.peak && epoch(f.source.retrievedAt) <= cutoff) &&
    !primaryFailed;
  const backup = !spec.backup ? 'not_defined' : peak ? 'primary_has_qualifying_reports'
    : !afterCutoff ? 'before_deadline' : !primaryAbsence ? 'primary_absence_unverified'
    : !fallback ? 'backup_evidence_required' : 'backup_unreadable_or_unverified';
  let backupState: string = backup;
  let backupPeak: ReturnType<typeof wunderground>;
  if (fallback && primaryAbsence && !peak && epoch(fallback.retrievedAt) <= asOfMs &&
      epoch(fallback.retrievedAt) >= cutoff && epoch(fallback.retrievedAt) - cutoff <= 60_000) {
    backupPeak = wunderground(spec, fallback);
    if (backupPeak) {
      backupState = backupPeak.value === null ? 'no_data_both_sources' : 'backup_used';
      coverage = 'covered';
    }
  }
  const numerator = peak ? spec.unit === 'F' ? peak.tenthsC * 9 + 1600 : peak.tenthsC : undefined;
  const denominator = spec.unit === 'F' ? 50 : 10;
  const converted = numerator === undefined ? backupPeak?.value ?? null : numerator / denominator;
  const bracketValue = peak ? projectedBracketValue(peak.tenthsC / 10, spec.unit) : backupPeak?.value ?? null;
  const candidates = bracketValue === null ? [] : spec.bands.filter(b => includes(b, bracketValue));
  const lowest = spec.bands[0]?.min === undefined ? spec.bands[0] : undefined;
  const bracket = candidates.length === 1 ? candidates[0] : backupState === 'no_data_both_sources' ? lowest ?? null : null;
  if (bracketValue !== null && !bracket) reasons.push('读数没有唯一匹配的已核对档位');
  const direction = spec.kind === 'temperature_min' ? -1 : 1;
  const bracketStatus = spec.bands.map(b => ({ label: b.label, conditionId: b.conditionId,
    status: b === bracket ? frozen ? 'frozen_bracket' : 'observed_bracket'
      : bracketValue === null || !latestUsable ? 'unverified'
      : frozen ? 'outside_frozen_bracket'
      : direction > 0 && b.max !== undefined && b.max < bracketValue ||
        direction < 0 && b.min !== undefined && b.min > bracketValue ? 'excluded_by_current_observation_subject_to_revision' : 'still_possible' }));
  return { coverage, reasons, statistic: direction > 0 ? 'maximum' : 'minimum', peak: peak ?? null, converted, bracketValue,
    bracket: bracket ?? null, bracketStatus,
    selectedBracketMatches: bracket ? bracket.conditionId === spec.target.conditionId : null,
    state: bracket && (frozen || backupPeak) ? 'rule_observation_determined' :
      latest?.counts.conflicts || latest?.counts.mismatch ? 'rule_review_required' : peak ? 'observed_so_far' : 'awaiting_verified_observation',
    lastObservation: selected?.last ?? null, nextObservation: latest?.firstNext ?? null,
    request: selected?.request ?? null, rawEvidenceId: selected?.source.evidenceId ?? null, readAt: selected?.source.retrievedAt ?? null,
    coverageThrough: selected?.last?.at ?? null, maxUnobservedMinutes: selected?.maxUnobservedMinutes ?? null,
    counts: selected?.counts ?? null, missingPriorReports: lostReports, exclusions: selected?.exclusions ?? [], conflicts: selected?.conflicts ?? [],
    revisions, freeze, backup: { status: backupState, evidence: backupPeak ?? null }, retrospective,
    rows: selected?.rows ?? [], usableForWatch: !primaryFailed && !sourceStale && !!latestUsable && !!peak &&
      (selected!.maxUnobservedMinutes ?? Infinity) <= 120 && !retrospective };
}

function hkoTemperatureCheck(spec: Temperature, captures: WeatherSourceSnapshot[], asOf: string) {
  const date = spec.window.date!;
  const [year, month, dayOfMonth] = date.split('-');
  const minimum = spec.kind === 'temperature_min';
  const field = minimum ? 'Absolute Daily Min (deg. C)' : 'Absolute Daily Max (deg. C)';
  const sources = captures.filter(s => s.retrievedAt <= asOf).sort((a,b) => a.retrievedAt.localeCompare(b.retrievedAt));
  const dailyFrames = sources.filter(s => s.data.adapter === 'hko_daily_extract').map(source => {
    let file;
    try { file = source.data.status === 'ok' ? JSON.parse(source.data.raw) : null; } catch { file = null; }
    const months = file?.stn?.data;
    const rows = Array.isArray(months) ? months.find(m => Number(m?.month) === Number(month))?.dayData : null;
    const matching = Array.isArray(rows) ? rows.filter(r => Array.isArray(r) && r[0] === dayOfMonth) : [];
    const row = matching.length === 1 ? matching[0] : undefined;
    const value = row?.[minimum ? 4 : 2]?.trim?.();
    const daily = typeof value === 'string' && /^-?\d+\.\d$/.test(value) && source.retrievedAt >= spec.window.to
      ? { date, value: +value, field, row, evidenceId: source.evidenceId, source: source.source, retrievedAt: source.retrievedAt } : null;
    return { source, valid: Array.isArray(rows) && matching.length <= 1, daily };
  });
  const first = dailyFrames.find(x => x.daily && x.source.retrievedAt <= spec.cutoff!);
  const prior = first && dailyFrames[dailyFrames.indexOf(first) - 1];
  const capturedFirst = !!(first && prior?.valid && !prior.daily && prior.source.retrievedAt >= spec.window.to &&
    epoch(first.source.retrievedAt) - epoch(prior.source.retrievedAt) <= 20 * 60_000);
  const latestDaily = dailyFrames.filter(x => x.daily).at(-1)?.daily ?? null;
  const daily = capturedFirst ? first!.daily : latestDaily;
  const provisional = sources.filter(s => s.data.adapter === 'hko_provisional' && s.data.status === 'ok').flatMap(source => {
    const lines = source.data.raw.split(/\r?\n/);
    if (!lines[0]?.includes('Maximum Air Temperature Since Midnight') || !lines[0].includes('Minimum Air Temperature Since Midnight')) return [];
    const rows = lines.filter(line => /^\d{12},HK Observatory,/.test(line));
    const row = rows.length === 1 && /^(\d{8})(\d{2})(\d{2}),HK Observatory,(-?\d+\.\d),(-?\d+\.\d)$/.exec(rows[0]);
    if (!row || row[1] !== year + month + dayOfMonth) return [];
    const at = atLocal(date, spec.window.timeZone, row[2] + ':' + row[3]);
    return at <= asOf ? [{ at, value: Number(row[minimum ? 5 : 4]), source: source.source, evidenceId: source.evidenceId,
      raw: row[0], retrievedAt: source.retrievedAt }] : [];
  }).at(-1) ?? null;
  const converted = daily?.value ?? provisional?.value ?? null;
  const matches = converted === null ? [] : spec.bands.filter(b => includes(b, converted));
  const bracket = matches.length === 1 ? matches[0] : null;
  const stale = !daily && !!provisional && asOf < spec.window.to && epoch(asOf) - epoch(provisional.at) > 30 * 60_000;
  const coverage: Coverage = daily ? 'covered' : stale ? 'stale' : provisional ? 'partial' : sources.length && sources.every(s =>
    s.data.status === 'failed') ? 'failed' : 'pending';
  return { coverage, state: daily ? 'hko_daily_extract_published' : provisional ? 'hko_provisional_since_midnight' : 'awaiting_hko_data',
    reasons: [!daily ? '合约指定 Daily Extract 尚无可核对的目标日终值' : !capturedFirst ? '初次发布版本尚未由连续读取证实' : '',
      converted !== null && !bracket ? '官方读数保留一位小数，合约整度标签没有说明小数取整，当前无法唯一落档' : '',
      stale ? '香港天文台日内文件更新时间已超过 30 分钟' : ''].filter(Boolean),
    statistic: minimum ? 'minimum' : 'maximum', converted, bracketValue: converted, bracket,
    selectedBracketMatches: bracket ? bracket.conditionId === spec.target.conditionId : null,
    daily, latestDaily, provisional, lastObservation: provisional, rawEvidenceId: daily?.evidenceId ?? provisional?.evidenceId ?? null,
    freeze: { status: capturedFirst ? 'captured' : daily ? 'snapshot_unverified' : 'awaiting_trigger', deadline: spec.cutoff,
      evidenceId: capturedFirst ? daily?.evidenceId : null, priorEvidenceId: capturedFirst ? prior?.source.evidenceId : null },
    usableForWatch: !!daily || !!provisional && !stale && asOf < spec.window.to };
}

function plain(value: string) {
  return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&deg;|&#176;/g, '°').replace(/&amp;/g, '&').trim();
}

function wunderground(spec: Temperature, capture: WeatherSourceSnapshot) {
  if (capture.data.status !== 'ok') return;
  const doc = capture.data.raw;
  const body = plain(doc).replace(/\s+/g, ' ');
  const date = spec.window.date!;
  const title = doc.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
  if (!new RegExp('\\b' + spec.station + '\\b', 'i').test(body) && !title.includes(spec.station)) return;
  if (!body.includes(date) && !body.includes(new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(Date.parse(date)))) return;
  for (const table of doc.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
      [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => plain(cell[1])));
    const header = rows[0] ?? [];
    const index = header.findIndex(field => /^Temperature$/i.test(field));
    if (index < 0 || !header.some(h => /time/i.test(h))) continue;
    const values = rows.slice(1).flatMap(row => {
      const match = /^(-?\d+)\s*°\s*([CF])$/.exec(row[index] ?? '');
      return match?.[2] === spec.unit ? [{ value: +match[1], field: row[index] }] : [];
    });
    if (values.length) return { ...values.reduce((a, b) => (spec.kind === 'temperature_min' ? a.value <= b.value : a.value >= b.value) ? a : b),
      evidenceId: capture.evidenceId, url: capture.source };
    if (rows.length === 2 && rows[1].some(cell => /^(?:no data available|no observations available)\.?$/i.test(cell)))
      return { value: null, evidenceId: capture.evidenceId, url: capture.source };
  }
}

function validateArchive(spec: WeatherContractSpec, value: string) {
  const url = https(value);
  if (isTemperature(spec) && spec.adapter === 'awc_raw') {
    if (url.href === awcRequest(spec.primary.url, spec.station).url) return 'awc_raw';
    if (spec.backup && url.origin === sourceSetting('PM_WUNDERGROUND_URL') && !url.search &&
        new RegExp('^/history/daily/(?:[a-z0-9-]+/){0,5}' + spec.station + '/date/' + spec.window.date + '/?$', 'i').test(url.pathname))
      return 'wunderground_daily';
  } else if (isTemperature(spec) && spec.adapter === 'hko_daily_extract') {
    if (url.href === spec.primary.url) return 'hko_daily_extract';
    if (url.href === hkoLive) return 'hko_provisional';
  } else if (spec.kind === 'snowfall_occurrence' || spec.kind === 'precipitation_sum') {
    if (url.origin === sourceSetting('PM_NWS_URL') && !url.search &&
        /^\/products\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(url.pathname)) return 'nws_cli';
    if (url.origin === sourceSetting('PM_NWS_FORECAST_URL') && url.pathname === '/product.php' &&
        url.searchParams.get('issuedby') === spec.product.slice(3) && url.searchParams.get('product') === 'CLI' &&
        [...url.searchParams.keys()].every(k => ['site', 'issuedby', 'product', 'format', 'version', 'glossary'].includes(k)) &&
        [...url.searchParams.keys()].length === new Set(url.searchParams.keys()).size) return 'nws_cli_html';
    const office = spec.product === 'CLIPIT' ? 'KPBZ' : 'KOKX';
    if (url.origin === sourceSetting('PM_IEM_URL') && !url.search &&
        new RegExp('^/api/1/nwstext/\\d{12}-' + office + '-[A-Z]{4}\\d{2}-' + spec.product + '(?:-[A-Z]{3})?$').test(url.pathname))
      return 'nws_cli_archive';
  } else if (spec.kind === 'tropical_cyclone' && url.origin === sourceSetting('PM_NHC_URL') && !url.search) {
    const id = /^\/archive\/(20\d{2})\/([a-z]{2}\d{2})\/\2\1\.(public(?:_a)?|update)\.\d{3,8}\.shtml$/.exec(url.pathname);
    if (id) return 'nhc_advisory';
    if (/^\/data\/tcr\/[A-Z]{2}\d{6}_[A-Za-z0-9]+\.pdf$/.test(url.pathname))
      return 'nhc_best_track';
  }
  throw Error('官方存证 URL 超出已绑定的合约和来源范围。');
}

function pre(raw: string) {
  return raw.match(/<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/i)?.[1]?.replace(/<\/?a\b[^>]*>/gi, '').replace(/&amp;/g, '&') ?? '';
}

const inches = (value: string) => {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimal = ''] = value.split('.');
  return Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
};
function issuance(line: string) {
  const match = new RegExp('^\\s*(\\d{3,4}) (AM|PM) (EST|EDT|CST|CDT|MST|MDT|PST|PDT|AST|HST) [A-Z]{3} (' +
    monthPattern + ') (\\d{1,2}) (20\\d{2})\\s*$', 'im').exec(line);
  if (!match) return null;
  const offset = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, AST: -4, HST: -10 }[match[3].toUpperCase()]!;
  const h = Number(match[1].slice(0, -2)), m = Number(match[1].slice(-2));
  if (h < 1 || h > 12 || m > 59) return null;
  return iso(Date.parse(ymd(match[4], match[5], match[6])) + (h % 12 + (match[2].toUpperCase() === 'PM' ? 12 : 0) - offset) * hour + m * 60_000);
}

function capturePublication(adapter: string, raw: string) {
  if (adapter === 'nws_cli') {
    const product = JSON.parse(raw);
    return Number.isFinite(epoch(product.issuanceTime)) ? iso(epoch(product.issuanceTime)) : null;
  }
  if (adapter === 'nws_cli_html' || adapter === 'nhc_advisory') return issuance(pre(raw));
  if (adapter === 'nws_cli_archive') return issuance(raw);
  return null;
}

function climateDay(spec: Climate, capture: WeatherSourceSnapshot) {
  if (capture.data.status !== 'ok') return;
  const json = capture.data.adapter === 'nws_cli' ? JSON.parse(capture.data.raw) : null;
  if (json && (!capture.source.endsWith('/' + json.id) || json.productCode !== 'CLI' || json.issuingOffice !== (spec.product === 'CLIPIT' ? 'KPBZ' : 'KOKX'))) return;
  const raw = json ? json.productText : capture.data.adapter === 'nws_cli_archive' ? capture.data.raw : pre(capture.data.raw);
  if (typeof raw !== 'string' || !raw.split(/\r?\n/).some(line => line.trim() === spec.product)) return;
  const title = new RegExp('THE ' + spec.siteName + ' CLIMATE SUMMARY FOR (' + monthPattern + ') (\\d{1,2}) (20\\d{2})', 'i').exec(raw);
  if (!title) return;
  const date = ymd(title[1], title[2], title[3]);
  const at = capture.data.publishedAt;
  if (!at || epoch(at) > epoch(capture.retrievedAt)) return;
  if (capture.data.adapter === 'nws_cli_archive' && !capture.source.includes('/' + at.slice(0, 16).replace(/\D/g, '') + '-')) return;
  const temporary = /VALID TODAY AS OF|PRELIMINARY/i.test(raw.slice(title.index, title.index + 220)) ||
    epoch(at) < epoch(atLocal(addDays(date, 1), est));
  const section = new RegExp('(?:^|\\n)' + (spec.kind === 'snowfall_occurrence' ? 'SNOWFALL' : 'PRECIPITATION') +
    ' \\(IN\\)[^\\n]*\\n([\\s\\S]*?)(?=\\r?\\n[ \\t]*\\r?\\n|$)', 'i').exec(raw);
  if (!section) return;
  const daily = /^\s*(?:TODAY|YESTERDAY)\s+(\d+(?:\.\d+)?|MM?|T)\b[^\r\n]*/im.exec(section[1]);
  const month = /^\s*MONTH TO DATE\s+(\d+(?:\.\d+)?|MM?|T)\b[^\r\n]*/im.exec(section[1]);
  const season = [...section[1].matchAll(/^\s*(SINCE [A-Z]{3} \d+)\s+(\d+(?:\.\d+)?|MM?|T)\b[^\r\n]*/gim)];
  return { date, station: spec.station, product: spec.product, at, temporary, corrected: /\b(?:CC[A-Z]|CORRECTED)\b/i.test(raw.slice(0, 420)),
    daily: daily?.[1] ?? null, month: month?.[1] ?? null, season: Object.fromEntries(season.map(m => [m[1], m[2]])),
    quote: daily?.[0].trim() ?? null, section: section[0].trim(), offset: section.index,
    evidenceId: capture.evidenceId, url: capture.source };
}

export function climateCheck(spec: Climate, captures: WeatherSourceSnapshot[], asOf: string) {
  const visibleThrough = Math.min(epoch(asOf), epoch(spec.cutoff) || Infinity);
  const reports = captures.flatMap(c => climateDay(spec, c) ?? [])
    .filter(r => epoch(r.at) <= visibleThrough).sort((a, b) => a.at.localeCompare(b.at));
  const accepted = new Map<string, typeof reports[number]>();
  const conflicts = new Set<string>();
  const publishedFinals = new Map<string, typeof reports[number]>();
  for (const report of reports) {
    if (report.temporary) continue;
    if (!publishedFinals.has(report.date)) publishedFinals.set(report.date, report);
    const old = accepted.get(report.date);
    // Preserve missing figures as missing. For snow the first non-missing final
    // locks the day. For rain use the latest available daily figure before expiration.
    if (report.daily === null || /^M+$/.test(report.daily) || report.daily !== 'T' && inches(report.daily) === null) continue;
    if (old?.at === report.at && old.daily !== report.daily) conflicts.add(report.date);
    if (!old || spec.kind === 'precipitation_sum' && epoch(old.at) < epoch(report.at)) accepted.set(report.date, report);
  }
  const days = spec.dates.filter(date => epoch(atLocal(date, est)) < epoch(asOf));
  const missing = days.filter(date => !accepted.has(date) || conflicts.has(date));
  const counted = days.flatMap(date => {
    const report = accepted.get(date);
    return report && !conflicts.has(date) ? [report] : [];
  });
  const numeric = (value: string | null) => value === 'T' ? 0.5 : value ? inches(value) : null;
  const grew = (before: string | null, after: string | null) => {
    const b = numeric(before), a = numeric(after);
    return a !== null && b !== null && a > b;
  };
  const inferred = spec.kind === 'snowfall_occurrence' ? missing.flatMap(date => {
    const first = publishedFinals.get(date), previous = publishedFinals.get(addDays(date, -1));
    if (!first || !previous || !first.daily || !/^M+$/.test(first.daily)) return [];
    if (date.slice(0, 7) === previous.date.slice(0, 7) && grew(previous.month, first.month) ||
        Object.entries(first.season).some(([k, v]) => grew(previous.season[k] ?? null, v)))
      return [{ previous, current: first, method: 'increase_in_final_cumulative_snowfall' }];
    return [];
  }) : [];
  const full = counted.length === spec.dates.length;
  const trace = counted.filter(row => row.daily === 'T');
  const lastObservation = counted.at(-1) ?? null;
  const coverage: Coverage = full ? 'covered' : reports.length ? 'partial' : captures.length ? 'failed' : 'pending';
  const common = { coverage, observedPassedDays: days.length, coveredDays: counted.length, missingDates: missing,
    remainingDates: spec.dates.slice(days.length), conflicts: [...conflicts], counted, reports, trace, lastObservation,
    rejectedEvidenceIds: captures.filter(c => !reports.some(row => row.evidenceId === c.evidenceId)).map(c => c.evidenceId),
    versionCoverage: 'earliest_or_latest_among_supplied_official_archives; archive completeness unverified' };
  if (spec.kind === 'snowfall_occurrence') {
    const witness = counted.find(r => (numeric(r.daily) ?? 0) > 0) ?? inferred[0]?.current ?? null;
    return { ...common, witness, inferred, outcome: witness ? 'Yes' : full ? 'No' : null,
      state: witness || full ? 'rule_condition_met_by_supplied_reports' : 'awaiting_final_daily_reports',
      deadlineTreatment: '按规则仅将发布宽限到期后被证实未发布的日值视作零；档案缺页仍待核对。' };
  }
  const totalHundredths = counted.reduce((sum, row) => sum + (inches(row.daily!) ?? 0), 0);
  const changedFinals = counted.flatMap(row => {
    const first = reports.find(r => r.date === row.date && !r.temporary && r.daily !== null && numeric(r.daily) !== null);
    return first && numeric(first.daily) !== numeric(row.daily) ? [{ date: row.date, first, latest: row }] : [];
  });
  const t = spec.threshold!;
  const low = Math.round(t.low * 100), high = Math.round((t.high ?? t.low) * 100);
  const state = t.op === 'gt' ? totalHundredths > low : t.op === 'lt' ? totalHundredths < low : totalHundredths >= low && totalHundredths <= high;
  const required = Math.max(0, low - totalHundredths + (t.op === 'gt' ? 1 : 0));
  return { ...common, totalInches: totalHundredths / 100, threshold: t, meetsOnAvailableDays: state, changedFinals,
    inchesToThreshold: t.op === 'lt' ? null : required / 100,
    outcome: full && !changedFinals.length ? state ? 'Yes' : 'No' : null,
    state: changedFinals.length ? 'awaiting_exchange_revision_treatment' : full ? 'rule_observation_determined' : 'partial_sum' };
}

function cycloneCheck(spec: Cyclone, captures: WeatherSourceSnapshot[], asOf: string) {
  const rows = captures.flatMap(c => {
    if (c.data.status !== 'ok' || c.data.adapter !== 'nhc_advisory') return [];
    const product = pre(c.data.raw);
    const expected = /\/([a-z]{2}\d{6})\.(?:public(?:_a)?|update)\./.exec(c.source)?.[1]?.toUpperCase();
    const storm = /^NWS (?:National|Central Pacific) Hurricane Center .*?\b([A-Z]{2}\d{6})\s*$/m.exec(product)?.[1];
    const category = /^(Hurricane|Tropical Storm|Post-Tropical Cyclone|Tropical Depression) (.+?) (?:Special )?(?:Advisory Number\s+([\dA-Z]+)|Tropical Cyclone Update)\s*$/im.exec(product);
    const intensity = /^MAXIMUM SUSTAINED WINDS\.{3}(\d+) MPH/m.exec(product);
    const publication = c.data.publishedAt;
    if (!category || !storm || storm !== expected || !intensity || !publication ||
        epoch(publication) > Math.min(epoch(asOf), epoch(c.retrievedAt))) return [];
    const landing = /\bmade landfall(?:\s+near|\s+at|\s+on)?\s+([A-Za-z .'-]+?),\s*([A-Za-z ]+?),?\s+(?:around|at|about)\s+\d{3,4}\s*[AP]M\s+[A-Z]{3}\s*\((\d{4}) UTC\)\s+with\s+maximum\s+sustained\s+winds\s+of\s+(\d+)\s+mph/i.exec(product);
    let landfall;
    if (landing) {
      const utc = Date.parse(publication.slice(0, 10)) + +landing[3].slice(0, 2) * hour + +landing[3].slice(2) * 60_000;
      const time = [utc, utc - day].find(at => at <= epoch(publication) && epoch(publication) - at < 18 * hour);
      if (time !== undefined) landfall = { location: landing[1].replace(/\s+/g, ' ').trim(), region: landing[2].trim(),
        at: iso(time), mph: +landing[4], quote: landing[0].replace(/\s+/g, ' '), offset: landing.index };
    }
    return [{ storm, category: category[1], name: category[2], advisory: category[3] ?? 'TCU', publication,
      mph: +intensity[1], quote: intensity[0], offset: intensity.index, landfall, evidenceId: c.evidenceId, url: c.source }];
  }).sort((a, b) => a.publication.localeCompare(b.publication));
  const from = epoch(spec.window.from), to = epoch(spec.window.to);
  const storms = new Map<string, typeof rows[number]>();
  const extensionCandidates = rows.filter(r => r.landfall && epoch(r.landfall.at) >= to &&
    epoch(r.landfall.at) < epoch(spec.possibleExtensionUntil) && r.landfall.mph >= spec.minMph &&
    r.landfall.region.toLowerCase() === spec.region?.toLowerCase());
  for (const row of rows) {
    const fact = spec.measure === 'count' ? epoch(row.publication) : epoch(row.landfall?.at);
    if (fact < from || !(fact < to) || storms.has(row.storm)) continue;
    const qualifies = spec.measure === 'count' ? row.storm.startsWith(spec.basin!) &&
      /^Hurricane$/i.test(row.category) && row.mph >= spec.minMph
      : row.landfall?.region.toLowerCase() === spec.region?.toLowerCase() && (row.landfall?.mph ?? 0) >= spec.minMph;
    if (qualifies) storms.set(row.storm, row);
  }
  const qualifying = [...storms.values()];
  const bestTrack = captures.filter(c => c.data.adapter === 'nhc_best_track').map(({ evidenceId, source }) => ({ evidenceId, source }));
  return { coverage: rows.length ? 'partial' : captures.length ? 'failed' : 'pending', qualifying, rows,
    bestTrack, count: qualifying.length, selectedBandMatchesObservedCount: spec.selectedBand && includes(spec.selectedBand, qualifying.length),
    outcome: spec.measure === 'landfall' && qualifying.length ? 'Yes' : null,
    state: spec.measure === 'landfall' && qualifying.length ? 'rule_condition_met' : 'awaiting_full_advisory_coverage',
    extensionCandidates, extensionStatus: spec.possibleExtensionUntil ? 'requires_qualified_over_water_status_at_deadline' : undefined,
    lastObservation: rows.at(-1) ?? null,
    rejectedEvidenceIds: captures.filter(c => c.data.adapter !== 'nhc_best_track' && !rows.some(row => row.evidenceId === c.evidenceId)).map(c => c.evidenceId) };
}

const fileRuleUrl = sourceSetting('PM_CFTC_URL') + '/filings/orgrules/rules09022622986.pdf';
const kalshiApi = sourceSetting('PM_KALSHI_API_URL') + '/trade-api/v2/markets/';
const weatherCheckSource = 'personal-agent/weather-market/check';
const weatherContractSource = 'personal-agent/weather-market/contract';
const str = { type: 'string' } as const;

type PublicRead = ReturnType<typeof createPolymarketPublicReader>['read'];
type Mode = 'live' | 'historical_replay' | 'archival_capture' | 'current_platform_only';

export function createWeatherMarket(db: DatabaseSync, readPublic: PublicRead, load: (id: string) => EvidenceRow | undefined,
    screen: (city: string, openOnly: boolean, signal: AbortSignal) => Promise<{ matches: Record<string, any>[]; evidenceId: string; coverage: Record<string, unknown> }>) {
  const locations = createWeatherLocation(db, load, async (q, signal) => {
    if (q.query_type === 'discover') {
      const r = await discover(q, signal);
      const facts = r.results.flatMap(result => 'freshness' in result &&
        (result.status === 'match' || result.status === 'unverified' || result.status === 'excluded_stale')
        ? [{ key: result.event, value: [result.status, result.freshness].join('|'),
          text: [`天气盘 ${result.city} · ${result.date ?? '当地日待核对'} · ${result.status}`,
            `本次观察 ${result.observedAt ?? '未知'} · Gamma 创建时间 ${result.createdAt ?? '未知'}`, result.url].join('\n') }] : []);
      return { evidenceId: r.evidenceId, inputEvidenceIds: r.inputEvidenceIds, covered:
        r.catalog.some(c => c.coverage.status === 'covered') || r.exact.some(c => c.status === 'ok'), facts };
    }
    const r = await inspect({ market: q.market }, signal);
    if (!('contract' in r) || r.contract.ruleVersion !== q.ruleVersion) return { evidenceId: r.evidenceId,
      inputEvidenceIds: r.inputEvidenceIds ?? [], covered: false, facts: [] };
    const hold = r.observation as { coverage?: string; totalInches?: number; outcome?: string; lastObservation?: { url?: string; date?: string } };
    const facts = hold.lastObservation ? [{ key: q.market, value: String([hold.totalInches,hold.outcome,r.platform.status,r.platform.outcome]),
      text: [`月累计降水 ${hold.totalInches} in · ${hold.coverage}`, hold.lastObservation.date, hold.lastObservation.url,
        `平台 ${r.platform.status}`, r.contract.target.url].filter(Boolean).join('\n') }] : [];
    return { evidenceId: r.evidenceId, inputEvidenceIds: r.inputEvidenceIds, covered: !!hold.lastObservation, facts };
  });
  const save = <T>(source: string, data: T, at?: string) => ({ ...saveEvidence(db, source, data, at), data });
  const airportFactors = createAirportFactors(capture, (url, data) => save(url, data).evidenceId);
  const loadRaw = db.prepare(`SELECT id AS evidenceId, source, retrieved_at AS retrievedAt, data FROM evidence
    WHERE source=? AND json_extract(data,'$.kind')='weather_source_snapshot'
    ORDER BY retrieved_at DESC LIMIT 5`);
  const firstNextEvidence = db.prepare(`SELECT id, data FROM evidence WHERE source=? AND
    json_extract(data,'$.kind')='weather_market_check' AND json_extract(data,'$.contract.ruleVersion')=? AND
    json_extract(data,'$.observation.freeze.status')='captured' AND json_extract(data,'$.sourceMode')='live_poll' ORDER BY retrieved_at LIMIT 1`);

  async function capture(url: string, adapter: string, publisher: string, signal: AbortSignal): Promise<WeatherSourceSnapshot> {
    let raw = '', status = 'failed', reason: string | undefined, httpStatus: number | null = null, publishedAt: string | null = null;
    let responseDate: string | undefined, cacheAgeSeconds: number | undefined;
    try {
      if (adapter === 'rain_rule' || adapter === 'nhc_best_track') {
        const document = await readOfficialPdf(https(url), signal);
        if (document.truncated) throw Error('official_document_truncated');
        raw = document.body;
        httpStatus = 200;
      } else {
        const response = await fetch(https(url), { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
          headers: { 'User-Agent': 'pm-personal-agent/0.1 (weather source evidence)', 'Cache-Control': 'no-cache',
            Accept: ['nws_cli', 'kalshi_market'].includes(adapter) ? 'application/json' : '*/*' } });
        httpStatus = response.status;
        responseDate = response.headers.get('date') ?? undefined;
        if (response.headers.has('age')) cacheAgeSeconds = Number(response.headers.get('age'));
        // AWC returns 204 for a valid request with no reports in its window.
        if (adapter !== 'awc_raw' || response.status !== 204) raw = (await officialBody(response)).toString('utf8');
      }
      publishedAt = capturePublication(adapter, raw);
      status = raw.trim() ? 'ok' : 'empty';
    } catch (error) {
      signal.throwIfAborted();
      reason = error instanceof Error ? error.cause instanceof Error ? error.cause.message : error.message : String(error);
    }
    return save(url, { kind: 'weather_source_snapshot' as const, adapter, publisher, status, raw, httpStatus,
      reason, publishedAt, responseDate, cacheAgeSeconds });
  }

  async function capturesForMarket(spec: Climate | Cyclone, signal: AbortSignal) {
    const list: WeatherSourceSnapshot[] = [];
    const readNow = (url: string, adapter: string) => capture(url, adapter, spec.primary.publisher, signal);
    async function readArchive(url: string) {
      const adapter = validateArchive(spec, url);
      const cached = loadRaw.get(url);
      if (cached) {
        const data = JSON.parse(String(cached.data)) as WeatherSourceSnapshot['data'];
        if (data.status === 'ok') return { ...cached, data } as WeatherSourceSnapshot;
      }
      return readNow(url, adapter);
    }
    const links = new Set<string>();
    if (spec.kind === 'tropical_cyclone') {
      const year = spec.window.from.slice(0, 4);
      const [index, current] = await Promise.all([
        readNow(`${sourceSetting('PM_NHC_URL')}/archive/${year}/`, 'nhc_index'),
        readNow(sourceSetting('PM_NHC_URL') + '/CurrentStorms.json', 'nhc_current'),
      ]);
      list.push(index, current);
      const names = [...index.data.raw.matchAll(/atcf_index=(al\d{2})\s*--><a href="([A-Z0-9]+\.shtml\?)">Hurricane /g)];
      for (const [, storm, name] of names.slice(0, 4)) {
        const advisoryIndex = await readNow(`${sourceSetting('PM_NHC_URL')}/archive/${year}/${name}`, 'nhc_index');
        list.push(advisoryIndex);
        for (const m of advisoryIndex.data.raw.matchAll(new RegExp('href="(/archive/' + year + '/' + storm + '/[^"?]+\\.shtml)"', 'g'))) {
          const url = sourceSetting('PM_NHC_URL') + m[1];
          if (spec.measure === 'count' ? /\.public(?:_a)?\./.test(url) : /\.(?:update|public(?:_a)?)\./.test(url)) links.add(url);
        }
      }
      if (current.data.status === 'ok') {
        const body = JSON.parse(current.data.raw);
        for (const storm of body.activeStorms ?? []) {
          const url = storm.publicAdvisory?.url;
          if (typeof url === 'string' && url.startsWith(sourceSetting('PM_NHC_URL') + '/archive/')) {
            try { validateArchive(spec, url); links.add(url); } catch { /* Recorded index includes non-archive notices. */ }
          }
        }
      }
    } else {
      const index = await readNow(`${sourceSetting('PM_NWS_URL')}/products/types/CLI/locations/${spec.product.slice(3)}`, 'nws_cli_index');
      list.push(index);
      if (index.data.status === 'ok') {
        const body = JSON.parse(index.data.raw);
        for (const row of body['@graph'] ?? []) {
          if (typeof row['@id'] === 'string' &&
              /^https:\/\/api\.weather\.gov\/products\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row['@id'])) links.add(row['@id']);
        }
      }
    }
    const candidates = [...links];
    const selected = candidates.slice(0, spec.kind === 'tropical_cyclone' ? 40 : 16);
    for (let i = 0; i < selected.length; i += 6) list.push(...await Promise.all(selected.slice(i, i + 6).map(readArchive)));
    return { list, discovered: candidates.length, attempted: selected.length, truncated: selected.length < candidates.length };
  }

  async function bindRain(ticker: string, signal: AbortSignal) {
    const [marketEvidence, rule] = await Promise.all([
      capture(kalshiApi + ticker, 'kalshi_market', 'Kalshi', signal),
      capture(fileRuleUrl, 'rain_rule', 'Kalshi filing with CFTC', signal),
    ]);
    const raw = rule.data.raw.replace(/[\u200B-\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ');
    const result = marketEvidence.data.status === 'ok' ? JSON.parse(marketEvidence.data.raw).market : undefined;
    const inputEvidenceIds = [marketEvidence.evidenceId, rule.evidenceId];
    const error = (reason: string) => ({ reason, inputEvidenceIds } as const);
    if (!result || result.ticker !== ticker || result.event_ticker !== ticker.split('-').slice(0, 2).join('-') || rule.data.status !== 'ok')
      return error('Kalshi 市场或 CFTC 合同条款无法读取。');
    const rules = String(result.rules_primary ?? '');
    const first = new RegExp('total precipitation at Central Park, New York City in (' + monthPattern + ') (20\\d{2}) is (.*?),? then the market resolves to Yes', 'i').exec(rules);
    const strict = /^strictly (greater|less) than (\d+(?:\.\d{1,2})?) inches$/i.exec(first?.[3] ?? '');
    const between = /^between (\d+(?:\.\d{1,2})?) and (\d+(?:\.\d{1,2})?) inches(?:,? inclusive)?$/i.exec(first?.[3] ?? '');
    const dailyRule = raw.match(/(?:U\s*)?nderlying: The Underlying for this Contract is the number of inches of precipitation recorded.*?Expiration Value\./i)?.[0];
    const exception = raw.match(/Only initial non-preliminary reported values.*?sole discretion\./i)?.[0];
    if (!first || !(strict || between) || !dailyRule?.includes('most recent daily climate reports') || !exception ||
        !dailyRule.includes('Central Park') || !raw.includes('Rulebook: RAINNYCM')) return error('累计降水阈值、来源或版本与已核对合同不符。');
    if (between && !/inclusive/i.test(between[0])) return error('累计降水区间端点是否包含仍待核对。');
    const month = monthNumber(first[1]), year = +first[2];
    if (ticker.split('-')[1] !== first[2].slice(2) + months[month].slice(0, 3).toUpperCase())
      return error('市场 ticker 与合约月不符。');
    const date = calendarDate(year, month, 1);
    const next = iso(Date.UTC(year, month + 1, 1)).slice(0, 10);
    const target: Target = { platform: 'kalshi', market: ticker, title: result.title, options: [],
      url: sourceSetting('PM_KALSHI_WEB_URL') + '/markets/kxrainnycm/monthly-rain-in-new-york/' + result.event_ticker.toLowerCase() };
    const terminal = ['finalized', 'settled'].includes(result.status);
    const platform: Platform = { status: terminal && /^(yes|no)$/.test(result.result) ? 'settled' : result.status,
      evidenceIds: [marketEvidence.evidenceId], outcome: terminal ? result.result : undefined, source: marketEvidence.source, open: result.status === 'active' };
    const expiration = terminal ? (result.expiration_time || result.expected_expiration_time) : result.latest_expiration_time;
    const spec: Climate = { kind: 'precipitation_sum', target, rules, ruleVersion: digest(rules, raw),
      ruleEvidenceIds: inputEvidenceIds, quotes: { dailyRule, exception, payout: rules }, station: 'KNYC', siteName: 'CENTRAL PARK NY',
      product: 'CLINYC', online: true, unit: 'in', dates: listDays(date, next), cutoff: expiration || undefined,
      threshold: strict ? { op: strict[1].toLowerCase() === 'greater' ? 'gt' : 'lt', low: +strict[2] }
        : { op: 'between', low: +between![1], high: +between![2] },
      primary: { publisher: 'NWS Daily Climate Report', url: sourceSetting('PM_NWS_URL') + '/products/types/CLI/locations/NYC' },
      backup: { publisher: 'The Weather Company', condition: 'Source Agency hierarchy in RAINNYCM; exchange exception/approval must be verified.' },
      window: { date, from: atLocal(date, est), to: atLocal(next, est), timeZone: et, dayRule: 'Central Park NWS local standard climate day' } };
    return { spec, platform };
  }

  type GammaEvent = { evidenceId: string; event: Record<string, any> | null; inputEvidenceIds: string[] };
  async function readGammaEvent(slug: string, signal: AbortSignal, airportMode: boolean): Promise<GammaEvent> {
    const ids: string[] = [];
    if (airportMode) {
      const source = await capture(sourceSetting('PM_POLYMARKET_GAMMA_URL') + '/events/slug/' + slug, 'airport_gamma_event', 'Polymarket Gamma', signal);
      ids.push(source.evidenceId);
      if (source.data.status === 'ok') {
        try { return { evidenceId: source.evidenceId, event: JSON.parse(source.data.raw), inputEvidenceIds: ids }; } catch { /* Fall back to the shared reader. */ }
      }
    }
    const receipt = await readPublic({ view: 'event', id: slug }, signal);
    return { evidenceId: receipt.evidenceId, inputEvidenceIds: [...ids, receipt.evidenceId],
      event: receipt.status === 'ok' ? (load(receipt.evidenceId)?.data as Record<string, any> | undefined)?.response ?? null : null };
  }

  async function bindPolymarket(input: string, signal: AbortSignal, temperatureDesk = false, airportMode = false, priorEvent?: GammaEvent) {
    const link = /^https?:\/\//i.test(input) ? URL.parse(input) : null;
    const child = link?.searchParams.get('marketSlug');
    if (link && (!['polymarket.com', 'www.polymarket.com'].includes(link.hostname) || link.protocol !== 'https:' ||
        !/^\/event\/[a-z\d-]+(?:\/[a-z\d-]+)?\/?$/i.test(link.pathname))) return { reason: '需要 Polymarket 市场链接或可解析 ID。', inputEvidenceIds: [] };
    if (child && !/^[a-z\d-]{1,200}$/.test(child)) return { reason: '子合约 slug 无效。', inputEvidenceIds: [] };
    const rawResolution = await resolveMarket(child || (/^\d+$/.test(input) ? 'local:' + input : input), signal);
    const resolved = save(rawResolution.source, rawResolution.data, rawResolution.retrievedAt);
    const data = resolved.data as Record<string, any>;
    const inputEvidenceIds = [resolved.evidenceId];
    const error = (reason: string) => ({ reason, inputEvidenceIds });
    const eventSlug = link?.pathname.split('/')[2] ?? (data.status === 'found' ? data.eventSlug :
      data.items?.[0]?.url?.split('/')[4] ?? (!input.includes(':') ? input : undefined));
    if (data.status !== 'found' && data.status !== 'selection_required') return error('市场解析状态 ' + data.status);
    if (!eventSlug || !/^[a-z\d-]{1,200}$/.test(eventSlug) || data.status === 'found' && data.eventSlug !== eventSlug)
      return error('事件和子市场身份不一致。');
    const eventRead = priorEvent ?? await readGammaEvent(eventSlug, signal, airportMode);
    inputEvidenceIds.push(...eventRead.inputEvidenceIds);
    const event = eventRead.event;
    if (!event || event.slug !== eventSlug || !Array.isArray(event.markets) || event.markets.length > 200)
      return error('未取得官方事件和精确选项列表。');
    const rows = event.markets as Record<string, any>[];
    if (data.status === 'selection_required' && !child && (!link || link.pathname.split('/').filter(Boolean).length === 2)) {
      const anchor = rows.find(r => r.active === true && r.acceptingOrders === true) ?? rows[0];
      if (temperatureDesk && typeof anchor?.description === 'string' && /highest temperature/i.test(anchor.description) &&
          /^[a-z\d-]+$/.test(anchor.slug) && rows.every(r => r.description === anchor.description &&
            r.resolutionSource === anchor.resolutionSource)) {
        return bindPolymarket(`${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${eventSlug}/${anchor.slug}`, signal, false, airportMode, eventRead);
      }
      return { inputEvidenceIds, candidates: rows.flatMap(m => {
        const tokens = findTokens(m);
        return tokens.length && typeof m.conditionId === 'string' && /^[a-z\d-]+$/.test(m.slug) ? [{ market: m.slug,
          title: m.question, label: m.groupItemTitle, conditionId: m.conditionId, options: tokens,
          url: `${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${eventSlug}/${m.slug}` }] : [];
      }) };
    }
    const market = rows.find(m => m.slug === data.slug && m.conditionId === data.conditionId && String(m.id) === String(data.gammaMarketId));
    const options = market ? findTokens(market) : [];
    const index = link?.searchParams.get('outcomeIndex');
    if (index !== null && index !== undefined && (!/^\d+$/.test(index) || !options[Number(index)])) return error('链接的 outcomeIndex 无法映射到准确 token。');
    if (!market || !options.length || !/^(0x)[a-f0-9]{64}$/i.test(market.conditionId) ||
        options.length !== 2 || !options.some(o => o.label === 'Yes' && o.tokenId === data.yesTokenId) ||
        !options.some(o => o.label === 'No' && o.tokenId === data.noTokenId) ||
        data.rules !== market.description || typeof data.rules !== 'string' || data.truncated || data.hasMore)
      return error('市场、选项或规则版本在目录与 Gamma 之间不一致。');
    const target: Target = { platform: 'polymarket', market: market.slug, gammaMarketId: String(market.id), eventSlug,
      title: data.title, url: data.url, localMarketId: data.localMarketId, conditionId: market.conditionId,
      options, createdAt: market.createdAt, selectedToken: index === undefined || index === null ? undefined : options[Number(index)].tokenId };
    const base = { target, rules: data.rules as string, ruleVersion: digest(data.rules), ruleEvidenceIds: inputEvidenceIds };
    try {
      const spec = /(?:highest|lowest) temperature/i.test(base.rules) ? bindTemperature(base, rows)
        : /snowfall/.test(base.rules) ? bindSnow(base, market)
        : /hurricane/i.test(base.rules) ? bindCyclone(base, market) : undefined;
      if (!spec) return error('规则未识别为已支持的天气统计量。');
      const card = buildRuleCard(resolved, { clauses: Object.entries(spec.quotes).map(([id, quote], i) => ({
        id: 'weather-' + (i + 1), kind: 'definition', explanation: id,
        citations: [{ part: 'rules', quote, offset: base.rules.indexOf(quote) }],
      })) });
      spec.ruleEvidenceIds = [...inputEvidenceIds, save(weatherContractSource + '/rule-card', card).evidenceId];
      return { spec, resolved, market, rows, eventRead };
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const readError = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  const gammaWinner = (market: Record<string, any>) => {
    if (market.closed !== true || market.umaResolutionStatus !== 'resolved') return;
    const prices: unknown = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    const tokens = findTokens(market);
    if (Array.isArray(prices) && prices.length === tokens.length && prices.filter(p => Number(p) === 1).length === 1 &&
        prices.every(p => [0, 1].includes(Number(p)))) return tokens[prices.findIndex(p => Number(p) === 1)];
  };
  async function platformStatus(spec: WeatherContractSpec, market: Record<string, any>, proof: string, asOf: string, signal: AbortSignal): Promise<Platform> {
    const condition = spec.target.conditionId!;
    const official = await readPublic({ view: 'resolution', id: condition }, signal);
    const states = Array.isArray(official.result) ? official.result as Record<string, any>[] : [];
    const all = states.map(row => ({ status: row.status, price: row.price, time: Number(row.last_update_timestamp) * 1000 }))
      .filter(row => Number.isFinite(row.time)).sort((a, b) => b.time - a.time);
    const current = all.find(row => row.time <= epoch(asOf));
    const final = gammaWinner(market);
    const close = epoch(market.closedTime);
    const gammaVisible = Number.isFinite(close) && close <= epoch(asOf);
    const oracleStatus = typeof current?.status === 'string' ? current.status.toLowerCase() : undefined;
    const oracleOutcome = oracleStatus === 'resolved' && ['0', '1000000000000000000', '500000000000000000'].includes(String(current?.price))
      ? String(current?.price) === '0' ? 'No' : String(current?.price) === '1000000000000000000' ? 'Yes' : 'Split' : undefined;
    const gammaStatus = typeof market.umaResolutionStatus === 'string' ? market.umaResolutionStatus : undefined;
    const base = { evidenceIds: [proof, official.evidenceId], source: official.source, oracleStatus, gammaStatus };
    const outcome = oracleOutcome ?? (gammaVisible ? final?.label : undefined);
    if (gammaVisible && final && oracleOutcome && final.label !== oracleOutcome)
      return { ...base, status: 'conflicting_official_receipts', comparison: `Gamma ${final.label}, Oracle ${oracleOutcome}` };
    if (outcome) return { ...base, status: 'settled', outcome, tokenId: optionToken(spec.target, outcome),
      resolvedAt: oracleOutcome && current ? iso(current.time) : iso(close), open: false };
    if (oracleStatus === 'resolved') return { ...base, status: 'resolved_outcome_unverified', resolvedAt: iso(current!.time), open: false };
    if (oracleStatus && ['disputed', 'challenged', 'arbitration'].includes(oracleStatus) || gammaVisible && gammaStatus === 'disputed')
      return { ...base, status: 'disputed' };
    if (oracleStatus && ['proposed', 'reproposed'].includes(oracleStatus) || gammaVisible && gammaStatus === 'proposed')
      return { ...base, status: 'proposed' };
    const open = market.closed === false && market.acceptingOrders === true;
    return { ...base, status: open ? 'trading' : gammaVisible ? 'awaiting_settlement' : 'unverified_at_cutoff',
      open, closesAt: market.endDate };
  }

  function replayRow(id: string, spec: WeatherContractSpec): WeatherSourceSnapshot {
    const row = load(id);
    if (!row) throw Error('证据不存在 ' + id);
    const adapter = validateArchive(spec, row.source);
    const data = row.data as Partial<WeatherSourceSnapshot['data']>;
    if (data.kind === 'weather_source_snapshot' && data.adapter === adapter && typeof data.raw === 'string') return row as WeatherSourceSnapshot;
    const snapshot = sourceSnapshotFromEvidence(row);
    if (snapshot.source === row.source && ['body', 'document'].includes(snapshot.coverage) &&
        !snapshot.truncated && !snapshot.gaps?.length && !snapshot.failure && !snapshot.unsupported && snapshot.content) {
      const raw = typeof snapshot.content.value === 'string' ? snapshot.content.value
        : adapter === 'nws_cli' && snapshot.content.format === 'json' ? JSON.stringify(snapshot.content.value) : null;
      if (raw && raw.trim() && (adapter !== 'awc_raw' || snapshot.content.format === 'text')) {
        return { ...row, data: { kind: 'weather_source_snapshot', adapter, raw, status: 'ok', httpStatus: null,
          publisher: adapter === 'wunderground_daily' ? spec.backup!.publisher : spec.primary.publisher,
          publishedAt: capturePublication(adapter, raw) } };
      }
    }
    throw Error('证据不是此天气合约可读取的官方原始存证 ' + id);
  }

  async function captureHko(spec: Temperature, signal: AbortSignal) {
    const previous = loadRaw.all(spec.primary.url).map(row => ({ ...row, data: JSON.parse(String(row.data)) }) as WeatherSourceSnapshot);
    const frozen = firstNextEvidence.get(weatherCheckSource, spec.ruleVersion);
    if (frozen) {
      const { priorEvidenceId, evidenceId } = JSON.parse(String(frozen.data)).observation.freeze;
      for (const id of [priorEvidenceId, evidenceId]) if (id && !previous.some(s => s.evidenceId === id)) previous.push(replayRow(id, spec));
    }
    const current = await capture(spec.primary.url, 'hko_daily_extract', spec.primary.publisher, signal);
    if (current.retrievedAt < spec.window.from || current.retrievedAt >= spec.window.to) return [...previous, current];
    const live = await capture(hkoLive, 'hko_provisional', 'Hong Kong Observatory regional observations', signal);
    return [...previous, current, live];
  }

  async function inspect(args: { market: string; as_of?: string; replay_evidence_ids?: string[]; official_urls?: string[] },
      signal: AbortSignal, temperatureDesk = false, airportMode = false) {
    const { as_of, replay_evidence_ids: ids = [], official_urls: urls = [] } = args;
    const input = args.market.trim();
    const stamp = as_of === undefined ? undefined : epoch(as_of);
    if (stamp !== undefined && (!/(?:Z|[+-]\d\d:\d\d)$/i.test(as_of!) || !Number.isFinite(stamp) || stamp > Date.now()))
      throw Error('as_of 需为带时区的已发生时刻。');
    if (ids.length > 200 || urls.length > 40) throw Error('单次最多 200 份已有证据、40 个官方档案地址。');
    const kalshi = /^KXRAINNYCM-\d{2}[A-Z]{3}-[A-Z\d.-]+$/i.test(input);
    const binding = kalshi ? await bindRain(input.toUpperCase(), signal) : await bindPolymarket(input, signal, temperatureDesk, airportMode);
    if (!('spec' in binding) || !binding.spec) {
      const outcome = { kind: 'weather_market_check', ...binding, status: 'candidates' in binding ? 'selection_required' : 'unsupported_or_ambiguous' };
      return { ...outcome, evidenceId: save(weatherCheckSource, outcome).evidenceId };
    }
    const { spec } = binding;
    const caps = [...new Set(ids)].map(id => replayRow(id, spec));
    const archives = [...new Set(urls)].map(value => {
      const url = https(value).href;
      const adapter = validateArchive(spec, url);
      if (adapter === 'awc_raw') throw Error('合约指定的 AWC 原文由工具直接读取。已有版本请用 replay_evidence_ids。');
      const publisher = adapter === 'wunderground_daily' ? spec.backup!.publisher : spec.primary.publisher;
      return { url, adapter, publisher };
    });
    for (let i = 0; i < archives.length; i += 5) {
      caps.push(...await Promise.all(archives.slice(i, i + 5).map(r => capture(r.url, r.adapter, r.publisher, signal))));
    }
    const temperature = isTemperature(spec) && spec.adapter === 'awc_raw';
    const hko = isTemperature(spec) && spec.adapter === 'hko_daily_extract';
    const explicitReplay = !!(as_of || ids.length);
    let mode: Mode = explicitReplay ? 'historical_replay' : urls.length ? 'archival_capture' : spec.online ? 'live' : 'current_platform_only';
    const automatic = !explicitReplay && !urls.length && !isTemperature(spec) ? await capturesForMarket(spec, signal) : undefined;
    if (automatic) caps.push(...automatic.list);
    if (hko && !explicitReplay && !urls.length) caps.push(...await captureHko(spec, signal));
    const awcUrl = temperature ? awcRequest(spec.primary.url, spec.station).url : '';
    if (temperature && !caps.some(c => c.data.adapter === 'awc_raw')) {
      if (Date.now() - epoch(spec.window.to) < 30 * day) {
        const current = await capture(awcUrl, 'awc_raw', spec.primary.publisher, signal);
        caps.push(current);
        if (!explicitReplay) {
          const history = loadRaw.all(awcUrl).filter(row => row.evidenceId !== current.evidenceId).reverse()
            .map(row => ({ ...row, data: JSON.parse(String(row.data)) } as WeatherSourceSnapshot));
          // Keep the triggering pair addressable after many polls.
          const frozen = firstNextEvidence.get(weatherCheckSource, spec.ruleVersion);
          if (frozen) {
            const prior = JSON.parse(String(frozen.data)).observation.freeze;
            for (const id of [prior.priorEvidenceId, prior.evidenceId]) if (id && !history.some(c => c.evidenceId === id)) {
              const row = replayRow(id, spec);
              history.unshift(row);
            }
          }
          caps.unshift(...history);
        }
      }
    }
    let asOf = stamp === undefined ? now() : iso(stamp);
    const metar = () => caps.filter(c => c.data.adapter === 'awc_raw');
    const backup = () => caps.filter(c => c.data.adapter === 'wunderground_daily').at(-1);
    let temperatureObservation = temperature ? temperatureCheck(spec, metar(), asOf, backup()) : undefined;
    if (!explicitReplay && temperatureObservation?.backup.status === 'backup_evidence_required' && spec.backup?.url) {
      caps.push(await capture(spec.backup.url, 'wunderground_daily', spec.backup.publisher, signal));
      asOf = now();
      temperatureObservation = temperatureCheck(spec as Temperature, metar(), asOf, backup());
    }
    const options: Platform = 'market' in binding && binding.market ? airportMode && binding.market.closed === false && binding.market.acceptingOrders === true
      ? { status: 'trading', evidenceIds: [binding.eventRead!.evidenceId], open: true, closesAt: binding.market.endDate }
      : await platformStatus(spec, binding.market, binding.eventRead!.evidenceId, asOf, signal)
      : ('platform' in binding ? binding.platform : undefined) ?? { status: 'unverified', evidenceIds: [] };
    if (mode === 'live' && options.status === 'settled' && epoch(asOf) >= epoch(spec.window.to)) mode = 'historical_replay';
    const rawSources = caps.map(({ source, evidenceId, retrievedAt, data }) => ({ source, evidenceId, retrievedAt,
      publisher: data.publisher, status: data.status, reason: data.reason, publishedAt: data.publishedAt, httpStatus: data.httpStatus }));
    const observation = isTemperature(spec) ? (hko ? hkoTemperatureCheck(spec, caps, asOf) : temperatureObservation) ??
      { coverage: 'unsupported', state: 'noaa_integer_table_required', reasons: ['早期 NOAA Temp 整数站表口径，当前缺少可核验原表读数。'] }
      : spec.kind === 'tropical_cyclone' ? cycloneCheck(spec, caps.filter(c => c.data.adapter.startsWith('nhc_') &&
        !['nhc_index','nhc_current'].includes(c.data.adapter)), asOf)
      : climateCheck(spec, caps.filter(c => c.data.adapter !== 'nws_cli_index'), asOf);
    const eventWinners = 'rows' in binding && binding.rows && isTemperature(spec) ? binding.rows.flatMap(row => {
      const matched = spec.bands.find(b => b.conditionId === row.conditionId);
      return matched && gammaWinner(row)?.label === 'Yes' && epoch(row.closedTime) <= epoch(asOf) ? [matched] : [];
    }) : [];
    const matchedBracket = 'bracket' in observation ? observation.bracket : undefined;
    const comparableOutcome = 'outcome' in observation && observation.outcome;
    const comparison = eventWinners.length === 1 && matchedBracket ? eventWinners[0].conditionId === matchedBracket.conditionId ? 'agrees' : 'conflict'
      : comparableOutcome && options.outcome ? comparableOutcome.toLowerCase() === options.outcome.toLowerCase() ? 'agrees' : 'conflict' : 'not_comparable';
    const platform = { ...options, eventWinner: eventWinners.length === 1 ? eventWinners[0] : undefined, comparison };
    const contract = save(weatherContractSource, { kind: 'weather_contract', mode, spec });
    const sourceMode = explicitReplay ? 'replay' : urls.length ? 'official_archive' : caps.length ? 'live_poll' : 'none';
    const payload = { kind: 'weather_market_check', mode, sourceMode, asOf, status: 'checked', contractEvidenceId: contract.evidenceId,
      contract: spec, platform, observation, sourceSnapshots: rawSources,
      sourceDiscovery: automatic && { discovered: automatic.discovered, attempted: automatic.attempted, truncated: automatic.truncated,
        status: automatic.list[0]?.data.status },
      watch: spec.online && mode === 'live' && !!spec.target.localMarketId ? { status: 'available', sourceId: weatherSource, scope: spec.kind,
        marketId: spec.target.localMarketId, contractEvidenceId: contract.evidenceId, minIntervalSeconds: weatherInterval,
        ...(hko ? { recommendedIntervalSeconds: 600, conditions: ['report', 'bracket', 'revision', 'coverage', 'freeze', 'settlement'] } : {}) } :
        mode === 'live' && spec.kind === 'precipitation_sum' ? locations.prepare({ query_type: 'market_ticker',
          market: spec.target.market, ruleVersion: spec.ruleVersion }) :
        { status: 'unsupported', reason: '该快照或平台没有已绑定的本地市场订阅入口。' },
      inputEvidenceIds: [...new Set([contract.evidenceId, ...spec.ruleEvidenceIds, ...platform.evidenceIds, ...caps.map(c => c.evidenceId)])] };
    const evidence = save(weatherCheckSource, payload);
    return { ...payload, evidenceId: evidence.evidenceId };
  }

  async function airportImpact(spec: Temperature, observation: object, asOf: number, checkId: string, signal: AbortSignal) {
    const [latitude, longitude] = stationCoordinates[spec.station];
    const start = epoch(spec.window.from), end = epoch(spec.window.to);
    const hko = spec.adapter === 'hko_daily_extract';
    const primaryModel = regionalModels[spec.station] ?? 'ecmwf_ifs';
    const stationForecast = (model: string) => locations.stationForecast({ id: spec.station, label: spec.station,
      latitude, longitude, timeZone: spec.window.timeZone }, start, end, asOf, [model], [], signal, undefined, true);
    const [factors, regional, headquarters] = await Promise.all([
      airportFactors(spec.station, latitude, longitude, asOf, signal),
      asOf < end ? stationForecast(primaryModel) : null,
      hko ? capture(sourceSetting('PM_HKO_DATA_URL') + '/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en',
        'hko_current', 'Hong Kong Observatory', signal) : null,
    ]);
    const fallback = regional && primaryModel !== 'ecmwf_ifs' && regional.records[0]?.temperatureCoverage !== 'covered'
      ? await stationForecast('ecmwf_ifs') : null;
    const forecast = fallback?.records[0]?.temperatureCoverage === 'covered' ? fallback : regional;
    const hkoValue = hko ? observation as ReturnType<typeof hkoTemperatureCheck> : null;
    const metarValue = hko ? null : observation as TempResult;
    const observedC = hkoValue?.usableForWatch ? hkoValue.converted
      : metarValue?.usableForWatch && metarValue.peak ? metarValue.peak.tenthsC / 10 : null;

    let headquartersNow: { at: string; tempC: number } | null = null;
    if (headquarters?.data.status === 'ok') {
      try {
        const data = JSON.parse(headquarters.data.raw).temperature;
        const row = data?.data?.find((t: { place: string }) => t.place === 'Hong Kong Observatory');
        const at = epoch(data?.recordTime);
        if (row?.unit === 'C' && Number.isFinite(row.value) && at <= asOf && asOf - at <= hour)
          headquartersNow = { at: iso(at), tempC: row.value };
      } catch { /* A malformed report cannot contribute a current temperature. */ }
    }
    const surface = hko ? headquartersNow : factors.surface;
    const surfaceTime = epoch(surface?.at);
    const model = forecast?.records[0];
    const rows = model?.hourly.rows ?? [];
    const exact = (at: number) => rows.find(r => epoch(r.validAt) === at);
    const left = Math.floor(surfaceTime / hour) * hour;
    const leftC = exact(left)?.values.temperature_2m;
    const rightC = exact(left + hour)?.values.temperature_2m;
    const modelNow = typeof leftC === 'number' ? leftC + (typeof rightC === 'number' ? (rightC - leftC) * (surfaceTime - left) / hour : 0) : null;
    const residualC = surface?.tempC != null && surfaceTime >= start && surfaceTime < end && modelNow != null ? surface.tempC - modelNow : null;
    const rowsLeft = rows.filter(r => epoch(r.validAt) >= asOf && typeof r.values.temperature_2m === 'number');
    const hottest = rowsLeft.reduce<(typeof rowsLeft)[number] | undefined>((best, row) =>
      !best || row.values.temperature_2m! > best.values.temperature_2m! ? row : best, undefined);
    const adjusted = rowsLeft.map(row => {
      const lag = Math.max(0, epoch(row.validAt) - surfaceTime);
      const discount = Math.exp(-lag / (3 * hour));
      return row.values.temperature_2m! + (residualC === null ? 0 : Math.max(-2, Math.min(2, residualC * 0.65 * discount)));
    });
    if (hottest && asOf >= start && surface?.tempC != null && surfaceTime >= start) adjusted.push(surface.tempC);
    const usableModel = model?.temperatureCoverage === 'covered';
    const remainingC = usableModel && adjusted.length ? Math.max(...adjusted) : null;
    const peakUnrounded = remainingC == null ? asOf >= end - hour && (usableModel || asOf >= end) ? observedC : null
      : Math.max(observedC ?? -Infinity, remainingC);
    const peakC = peakUnrounded == null ? null : Math.round(peakUnrounded * 100) / 100;
    const projectedBand = (c: number) => spec.bands.find(b => includes(b, projectedBracketValue(c, spec.unit)))?.label ?? null;
    const band = peakUnrounded === null ? null : projectedBand(peakUnrounded);
    const observedBand = 'bracket' in observation ? (observation.bracket as Band | null)?.label ?? null : null;

    const sunshine = factors.sunlight.latest;
    const lightModel = sunshine ? exact(Math.ceil(epoch(sunshine.at) / hour) * hour)?.values.shortwave_radiation : null;
    const nearby = factors.neighbors.filter(n => n.upwind && n.temperatureDifferenceC !== null)
      .sort((a,b) => a.distanceKm - b.distanceKm)[0];
    const oldEcho = factors.radar.frames.at(-2), echo = factors.radar.frames.at(-1);
    const echoDelta = oldEcho?.nearestEchoKm != null && echo?.nearestEchoKm != null ? echo.nearestEchoKm - oldEcho.nearestEchoKm : null;
    const tempTrend = factors.tempChangeC;
    const lightTrend = factors.sunlight.changeWm2;
    const localWeather = factors.surface?.weather;
    const airportName = hko ? '香港机场（区域参考）' : spec.station;
    const links = [
      `合约 ${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${spec.target.eventSlug}`,
      `风温云原报 ${factors.metar.url}`,
      ...(hko ? [`香港天文台日内原表 ${hkoLive}`] : []),
      ...(sunshine ? [`卫星辐照度 ${factors.sunlight.url}`] : []),
      ...(factors.cloudImages?.images[0] ? [`日本气象厅红外云图 ${factors.cloudImages.images[0].url}`] : []),
      `雷达 ${factors.radar.frames.at(-1)?.url ?? factors.radar.source.url}`,
    ];
    const context = [
      tempTrend !== null ? `${airportName}约一小时温差 ${tempTrend > 0 ? '+' : ''}${tempTrend}°C` : '',
      nearby ? `上风向近站 ${nearby.station} 相对 ${airportName} ${nearby.temperatureDifferenceC! > 0 ? '+' : ''}${nearby.temperatureDifferenceC}°C（${nearby.distanceKm} km）` : '',
      sunshine && sunshine.shortwaveWm2 >= 30 && lightTrend !== null && Math.abs(lightTrend) >= 40 ?
        `卫星短波辐照度 ${sunshine.shortwaveWm2} W/m²，近一小时 ${lightTrend > 0 ? '+' : ''}${lightTrend} W/m²` : '',
      localWeather ? `${airportName}报 ${localWeather}` : '',
      echoDelta !== null && echoDelta <= -5 ? `最近雷达回波靠近 ${Math.round(-echoDelta)} km，距目标 ${echo?.nearestEchoKm} km` : '',
      residualC !== null ? `实温较同刻模型 ${residualC > 0 ? '+' : ''}${residualC.toFixed(1)}°C` : '',
    ].filter(Boolean);
    // Near a boundary, flag observed weather changes in the time before the expected peak.
    const peakTime = epoch(hottest?.validAt);
    const airportWind = factors.surface?.windFromDeg;
    const priorWind = factors.previousSurface?.windFromDeg;
    const windShift = typeof airportWind === 'number' && typeof priorWind === 'number' &&
      Math.abs((airportWind - priorWind + 540) % 360 - 180) >= 40;
    const solarPriorModel = sunshine ?
      exact(Math.ceil(epoch(sunshine.at) / hour) * hour - hour)?.values.shortwave_radiation : null;
    const lightSurprise = typeof solarPriorModel === 'number' && typeof lightModel === 'number' && lightTrend !== null
      ? lightTrend - (lightModel - solarPriorModel) : null;
    const reasons: { direction: number; text: string }[] = [];
    if (windShift && !hko && nearby?.temperatureDifferenceC != null && Math.abs(nearby.temperatureDifferenceC) >= 2)
      reasons.push({ direction: Math.sign(nearby.temperatureDifferenceC),
        text: `风向改变，上风向 ${nearby.station} 与本站相差 ${nearby.temperatureDifferenceC}°C` });
    if (sunshine && Math.max(lightModel ?? 0, sunshine.shortwaveWm2) >= 120 && lightSurprise !== null && Math.abs(lightSurprise) >= 90)
      reasons.push({ direction: Math.sign(lightSurprise), text: `卫星日照变化较模型同期 ${Math.round(lightSurprise)} W/m²` });
    const lowCloud = (report: typeof factors.surface) => {
      const amounts: Record<string, number> = { FEW: 2, SCT: 4, BKN: 7, OVC: 8, VV: 8, CLR: 0, SKC: 0, NSC: 0 };
      if (!report || !report.clouds.length && !/\bCAVOK\b/.test(report.raw)) return null;
      return Math.max(0, ...report.clouds.filter(c => c.base === undefined || c.base <= 5000).map(c => amounts[c.cover] ?? 0));
    };
    const oldCloud = lowCloud(factors.previousSurface), currentCloud = lowCloud(factors.surface);
    const localSolarForecast = exact(Math.ceil(asOf / hour) * hour)?.values.shortwave_radiation ?? 0;
    if (!hko && !sunshine && localSolarForecast >= 120 && oldCloud !== null && currentCloud !== null && Math.abs(currentCloud - oldCloud) >= 4)
      reasons.push({ direction: Math.sign(oldCloud - currentCloud),
        text: '机场报文显示 5000 英尺以下云量明显改变，可能影响达峰前日照' });
    if (echo?.nearestEchoKm != null && echo.nearestEchoKm < 15 && (echoDelta !== null && echoDelta <= -5 ||
        oldEcho && oldEcho.nearestEchoKm === null))
      reasons.push({ direction: -1, text: `新一帧近站降水回波距目标 ${echo.nearestEchoKm} km` });
    const risks = peakUnrounded !== null && band && asOf >= start && peakTime >= asOf && peakTime - asOf <= 3 * hour
      ? reasons.flatMap(({ direction, text }) => {
        const toBand = projectedBand(Math.max(observedC ?? -Infinity, peakUnrounded + direction * 0.6));
        return toBand && toBand !== band ? [{ toBand, reason: text }] : [];
      }) : [];
    const eventUrl = sourceSetting('PM_POLYMARKET_WEB_URL') + '/event/' + spec.target.eventSlug;
    const title = ({ RKPK: '釜山金海机场', RKSI: '首尔仁川机场', HKO: '香港天文台总部',
      RJTT: '东京羽田机场', EDDM: '慕尼黑机场', LEMD: '马德里机场' } as Record<string, string>)[spec.station];
    const payload = { kind: 'weather_airport_impact', asOf: iso(asOf), event: spec.target.eventSlug, market: eventUrl, title,
      station: spec.station, day: spec.window.date, window: spec.window, observedC, observedBand, headquartersNow,
      projection: { peakC, band, interpretation: hko ? '模拟整数档，正式读数保留小数' : '剩余时段预估加当日已观测最高',
        observedFloorC: observedC, unadjustedRemainingC: hottest?.values.temperature_2m ?? null, remainingC,
        model: model?.model ?? null, modelInit: model?.modelInitializedAt ?? null, forecastPeakAt: hottest?.validAt ?? null,
        modelPeakWeather: hottest?.values ?? null, stationResidualC: residualC, modelSunlightWm2: lightModel ?? null,
        modelSource: model?.source ?? null, fallbackFrom: fallback && forecast === fallback ? primaryModel : null,
        coverage: model?.temperatureCoverage ?? null },
      factors, context, risks, links, inputEvidenceIds: [checkId, ...factors.inputEvidenceIds,
        ...(regional?.inputEvidenceIds ?? []), ...(fallback?.inputEvidenceIds ?? []),
        ...(headquarters ? [headquarters.evidenceId] : [])] };
    return save('personal-agent/weather-market/airport-impact', payload);
  }

  function authorize(item: WatchItemRequest, current: EvidenceRow): string {
    const data = item.weather && load(item.weather.contractEvidenceId)?.data as { kind?: string; mode?: Mode; spec?: WeatherContractSpec } | undefined;
    const spec = data?.spec;
    const c = current.data as Record<string, any>;
    if (item.sourceId !== weatherSource || item.scope !== spec?.kind || item.kind !== 'fact' || !item.weather ||
        data?.kind !== 'weather_contract' || data.mode !== 'live' || !spec?.online ||
        spec.target.localMarketId !== item.marketId || c.status !== 'found' || c.conditionId !== spec.target.conditionId ||
        c.slug !== spec.target.market || c.rules !== spec.rules || c.truncated || c.hasMore ||
        item.tokenId && (!spec.target.options.some(o => o.tokenId === item.tokenId) ||
          spec.target.selectedToken && item.tokenId !== spec.target.selectedToken))
      throw Error('天气任务需要同市场、同选项和当前规则的实时核对凭据。');
    if (item.weather.ruleVersion !== undefined && item.weather.ruleVersion !== spec.ruleVersion)
      throw Error('天气规则凭据版本已变化。');
    if (item.weather.conditions.includes('impact') && (item.weather.conditions.length !== 1 ||
        spec.kind !== 'temperature_max' || !supportsAirportFactors(spec.station)))
      throw Error('跨档预警须作为单独监控项，使用已接入因素数据的最高温测站。');
    if (!item.weather.conditions.includes('coverage') && item.notify?.quality && item.notify.quality !== 'record')
      throw Error('来源覆盖通知需要 coverage 关注条件。');
    return spec.ruleVersion;
  }

  const readWatch: WatchHost['read'] = async (item, { previous }, signal): Promise<WatchRead> => {
    const stored = item.weather && load(item.weather.contractEvidenceId)?.data as { spec?: WeatherContractSpec } | undefined;
    const contract = stored?.spec;
    const issue = (status: NonNullable<WatchRead['issue']>['status'], reason: string, evidenceIds: string[] = []) =>
      ({ issue: { status, reason, evidenceIds } });
    if (!contract || !item.weather) return issue('unsupported', '缺少已授权的天气合约凭据。');
    let result;
    try {
      const query = { market: 'local:' + item.marketId };
      result = await inspect(query, signal, false, item.weather.conditions.includes('impact'));
    } catch (error) {
      signal.throwIfAborted();
      return issue('failed', readError(error), [item.weather.contractEvidenceId]);
    }
    const ids = 'inputEvidenceIds' in result ? result.inputEvidenceIds ?? [] : [];
    if (!('contract' in result) || result.contract.ruleVersion !== contract.ruleVersion ||
        result.contract.target.conditionId !== contract.target.conditionId || result.contract.primary.url !== contract.primary.url ||
        result.contract.kind !== contract.kind || result.contract.window.from !== contract.window.from ||
        result.contract.window.to !== contract.window.to ||
        result.contract.target.options.some(o => optionToken(contract.target, o.label) !== o.tokenId))
      return issue('pending', '天气合约规则或绑定范围有变化，待重新核对。', [result.evidenceId, ...ids]);
    if (contract.kind === 'temperature_max' && item.weather.conditions.includes('impact')) {
      const sample = await airportImpact(contract, result.observation, epoch(result.asOf), result.evidenceId, signal);
      const after = sample.data;
      const before = previous?.last && load(previous.last.evidence.evidenceId)?.data as typeof after | undefined;
      const old = before?.projection;
      const next = after.projection;
      // An incomplete upstream reading must not replace a bracket baseline.
      if (!next.band || next.peakC === null) return issue('partial', '跨档预估暂缺有效测站或预报数据。', [sample.evidenceId]);
      const changed = old?.band && old.peakC !== null && old.band !== next.band &&
        (old.model === next.model || before?.observedC !== after.observedC);
      const risk = old?.band && after.risks.find(r => !before?.risks?.some(p => p.toBand === r.toBand));
      const when = `核对 ${clock('Asia/Shanghai', epoch(after.asOf))}（北京时间）`;
      const forecastTiming = next.forecastPeakAt && `模型达峰 ${clock(contract.window.timeZone, epoch(next.forecastPeakAt))}（测站当地）`;
      const findings: NonNullable<WatchObservation['findings']> = changed ? [{
        eventKey: digest(contract.target.conditionId, contract.ruleVersion, 'impact'),
        revision: digest(before?.asOf, after.asOf, old.band, next.band), kind: 'changed', confidence: 'unconfirmed', importance: 'normal',
        description: `${after.station} · ${after.day} 最高温预估跨档`,
        before: `${old.peakC}°C · ${old.band}`, after: `${next.peakC}°C · ${next.band}`,
        unknowns: [when, `测站当地 ${after.day} · ${next.interpretation}`,
          `当日已测最高 ${after.observedC == null ? '待观测' : after.observedC + '°C'} · ${next.model ?? '无模型'}`,
          ...(forecastTiming ? [forecastTiming] : []), ...after.context, ...after.links, `证据 ${sample.evidenceId}`],
      }] : risk ? [{
        eventKey: digest(contract.target.conditionId, contract.ruleVersion, 'impact_risk', risk.toBand),
        revision: digest(before?.asOf, after.asOf, risk.toBand), kind: 'changed', confidence: 'unconfirmed', importance: 'normal',
        description: `${after.station} · ${after.day} 出现可能改档的天气变化`,
        before: next.band, after: `关注 ${risk.toBand}`,
        unknowns: [when, risk.reason, `当前最高温预估 ${next.peakC}°C · ${next.interpretation}`,
          ...after.context, ...after.links, `证据 ${sample.evidenceId}`],
      }] : [];
      return { observations: [{ id: sample.evidenceId, scope: item.scope, observedAt: sample.retrievedAt, value: next.band,
        factAt: after.station === 'HKO' ? after.headquartersNow?.at : after.factors.surface?.at,
        evidence: { evidenceId: sample.evidenceId, source: contract.primary.url, retrievedAt: sample.retrievedAt },
        inputEvidenceIds: after.inputEvidenceIds, findings }] };
    }
    if (isTemperature(contract) && result.asOf < contract.window.from && result.observation.coverage === 'pending')
      return issue('pending', `等待测站当地观测日开始，北京时间 ${clock('Asia/Shanghai', epoch(contract.window.from))}\n${contract.primary.url}`,
        [result.evidenceId, ...ids]);
    if (!isTemperature(contract)) {
      const input = result.observation as { coverage: string; lastObservation?: { evidenceId: string; at?: string; publication?: string; url: string };
        outcome?: string; count?: number; totalInches?: number };
      const latest = input.lastObservation;
      const previousCheck = previous?.last && load(previous.last.evidence.evidenceId)?.data as Record<string, any> | undefined;
      const patch = [latest?.at ?? latest?.publication, input.totalInches, input.count, input.outcome, result.platform.status, result.platform.outcome];
      const key = digest(contract.ruleVersion, contract.target.conditionId, patch);
      const resultRef = { evidenceId: result.evidenceId, retrievedAt: load(result.evidenceId)!.retrievedAt, source: latest?.url ?? contract.primary.url };
      if (!latest && result.sourceDiscovery?.status !== 'ok') return issue('failed', '天气官方来源目录读取失败。 ' + contract.primary.url, ids);
      const prior = previousCheck?.observation;
      const findings: NonNullable<WatchObservation['findings']> = [];
      const add = (type: WeatherCondition, description: string, before: unknown, after: unknown) => {
        if (!item.weather!.conditions.includes(type) || before === after) return;
        findings.push({ eventKey: digest(contract.target.conditionId, contract.ruleVersion, type), revision: digest(type, patch),
          kind: 'changed', description, importance: 'normal', confidence: 'confirmed', before, after,
          unknowns: [`原始来源 ${resultRef.source}`, `气象覆盖 ${input.coverage} · 平台 ${result.platform.status}`] });
      };
      if (prior) {
        add('report', '官方气象报告更新', prior.lastObservation?.at ?? prior.lastObservation?.publication, patch[0]);
        add('cumulative', '已覆盖的累计值变化', prior.totalInches ?? prior.count, input.totalInches ?? input.count);
        add('trigger', '合约天气条件状态变化', prior.outcome, input.outcome);
        add('settlement', '平台结算状态变化', previousCheck?.platform?.status, result.platform.status);
      }
      const lastGap = previous?.gaps.at(-1);
      const version = lastGap && !lastGap.to ? digest(key,lastGap.operationKey) : key;
      return { observations: [{ id: version, scope: item.scope, observedAt: previous?.last?.id === version ? previous.last.observedAt : resultRef.retrievedAt,
        factAt: latest?.at ?? latest?.publication, evidence: resultRef, inputEvidenceIds: [latest?.evidenceId, ...result.platform.evidenceIds].filter((id): id is string => !!id),
        value: input.totalInches ?? input.count ?? input.outcome ?? 'pending', findings }] };
    }
    if (contract.adapter === 'hko_daily_extract') {
      const value = result.observation as ReturnType<typeof hkoTemperatureCheck>;
      const platform = result.platform;
      const prior = previous?.last && load(previous.last.evidence.evidenceId)?.data as
        { observation?: typeof value; platform?: Platform } | undefined;
      const before = prior?.observation;
      const raw = value.rawEvidenceId && load(value.rawEvidenceId);
      const ref = { evidenceId: result.evidenceId, source: raw ? raw.source : contract.primary.url,
        retrievedAt: load(result.evidenceId)!.retrievedAt };
      const key = digest(contract.ruleVersion, contract.target.conditionId);
      const findings: NonNullable<WatchObservation['findings']> = [];
      const report = (type: WeatherCondition, description: string, oldValue: unknown, newValue: unknown) => {
        if (!item.weather!.conditions.includes(type)) return;
        findings.push({ eventKey: digest(key,type), revision: digest(key,type,oldValue,newValue), description,
          kind: type === 'revision' ? 'revised' : 'changed', before: oldValue, after: newValue,
          confidence: 'confirmed', importance: type === 'settlement' ? 'high' : 'normal',
          unknowns: [`香港观测日 ${contract.window.date}`, ...(value.provisional && !value.daily ?
            [`日内数据发布 ${clock(contract.window.timeZone, epoch(value.provisional.at))}（香港／北京时间）`] : []),
          `官方原文 ${ref.source}`, `证据 ${result.evidenceId}`, `阶段 ${value.state} / ${platform.status}`] });
      };
      if (before && value.usableForWatch) {
        if (!before.daily && value.daily) report('report', '香港天文台发布合约指定 Daily Extract', null, value.daily.value);
        else if (!value.daily && before.provisional && value.provisional && before.provisional.value !== value.provisional.value)
          report('report', '香港天文台日内极值变化，正式日报待发布', before.provisional.value, value.provisional.value);
        if (value.bracket && before.bracket?.conditionId !== value.bracket.conditionId)
          report('bracket', value.daily ? '香港天文台日报读数对应档位变化' : '香港天文台日内读数对应档位变化，日报待发布',
            before.bracket?.label ?? null, value.bracket.label);
        if (before.latestDaily && value.latestDaily && before.latestDaily.value !== value.latestDaily.value)
          report('revision', '香港天文台日报读数发生修订，按合约及平台澄清核对是否可用', before.latestDaily.value, value.latestDaily.value);
        if (before.freeze.status !== 'captured' && value.freeze.status === 'captured')
          report('freeze', '已留存香港天文台首次发布前后的日报原文', before.freeze.status, value.daily?.value);
      }
      if (prior?.platform && ['proposed','disputed','settled'].includes(platform.status) &&
          (platform.status !== prior.platform.status || platform.outcome !== prior.platform.outcome))
        report('settlement', '平台结算状态变化', prior.platform.status, platform.outcome ?? platform.status);
      if ((!raw || !value.usableForWatch) && !findings.length)
        return issue(value.coverage === 'failed' ? 'failed' : value.coverage === 'stale' ? 'stale' : 'pending',
          `${value.reasons.join('；')}\n${ref.source}`, [result.evidenceId, ...ids]);
      const sourceVersion = digest(key, value.state, value.converted, value.latestDaily?.value, value.freeze.status, platform.status, platform.outcome);
      const observedAt = previous?.last?.sourceVersion === sourceVersion ? previous.last.observedAt : ref.retrievedAt;
      return { observations: [{ id: sourceVersion, scope: item.scope, evidence: ref,
        inputEvidenceIds: [...new Set([value.rawEvidenceId, ...platform.evidenceIds, item.weather.contractEvidenceId].filter((id): id is string => !!id))],
        observedAt, sourceVersion, factAt: platform.resolvedAt ?? (value.daily ? undefined : value.provisional?.at),
        value: value.converted ?? previous?.last?.value ?? 'pending', findings }] };
    }
    const value = result.observation as TempResult;
    const platform = result.platform;
    const ref = { evidenceId: result.evidenceId, source: contract.primary.url, retrievedAt: load(result.evidenceId)!.retrievedAt };
    const before = previous?.last && (load(previous.last.evidence.evidenceId)?.data as
      { observation?: TempResult; platform?: Platform; previousWeatherEvidenceId?: string } | undefined);
    const last = before?.previousWeatherEvidenceId
      ? (load(before.previousWeatherEvidenceId)?.data as { observation?: TempResult } | undefined)?.observation
      : before?.observation;
    const rawId = value.rawEvidenceId;
    const raw = rawId && load(rawId);
    const fact = value.lastObservation?.at;
    const watched = item.weather.conditions;
    const settled = platform.status === 'settled';
    const eventPrefix = digest(contract.target.conditionId, contract.ruleVersion, contract.window);
    const signature = (o: TempResult) => o.rows.map(row => [row.at, row.tenthsC, row.method]);
    const outputStatus = platform.status === 'settled' ? [platform.status, platform.outcome, platform.resolvedAt] : [platform.status];
    const previousStatus = before?.platform?.status === 'settled' ? [before.platform.status, before.platform.outcome, before.platform.resolvedAt]
      : [before?.platform?.status];
    const priorGap = previous?.gaps.at(-1);
    const sourceVersion = digest(eventPrefix, signature(value), value.freeze.status, outputStatus);
    const same = previous?.last?.sourceVersion === sourceVersion;
    const sourceRecovered = same && priorGap && !priorGap.to && priorGap.issue.status !== 'stale';
    const key = sourceRecovered ? digest(sourceVersion, priorGap.operationKey) : same ? previous!.last!.id : sourceVersion;
    const findings: NonNullable<WatchObservation['findings']> = [];
    const attach = (field: WeatherCondition, description: string, earlier: unknown, after: unknown,
        version: unknown, observed?: string, outcome = false) => {
      if (!watched.includes(field)) return;
      const local = observed && Number.isFinite(epoch(observed)) ? clock(contract.window.timeZone, epoch(observed)) : undefined;
      const beijing = local ? clock('Asia/Shanghai', epoch(observed)) : undefined;
      findings.push({ eventKey: digest(eventPrefix, field), revision: digest(eventPrefix, field, version),
        kind: field === 'revision' ? 'revised' : 'changed', description,
        before: earlier, after, confidence: 'confirmed', importance: outcome ? 'high' : 'normal',
        unknowns: [local ? `测站当地时间 ${local}（${contract.window.timeZone}） · 北京时间 ${beijing}` : '',
          `官方原文 ${contract.primary.url}`, `证据 ${result.evidenceId} / 原始 ${rawId}`,
          `阶段 ${value.freeze.status} / 平台 ${platform.status}`].filter(Boolean),
      });
    };
    const oldPeak = last?.peak;
    const peak = value.peak;
    const maximum = contract.kind === 'temperature_max';
    if (last && oldPeak && peak && (maximum ? peak.tenthsC > oldPeak.tenthsC : peak.tenthsC < oldPeak.tenthsC) &&
        value.bracket?.conditionId !== last.bracket?.conditionId && value.bracket) {
      attach('bracket', maximum ? '观测最高温升入新档' : '观测最低温降入新档', last.bracket?.label ?? last.bracketValue, value.bracket.label,
        [peak.at, peak.tenthsC, value.bracket.conditionId], peak.at);
    }
    if (last) {
      const priorRows = new Map(last.rows.map(r => [r.at, r]));
      const changed = value.rows.flatMap(r => {
        const old = priorRows.get(r.at);
        return old && old.tenthsC !== r.tenthsC ? [{ at: r.at, before: old.tenthsC, after: r.tenthsC }] : [];
      });
      if (changed.length) attach('revision', '同一观测时刻的原始温度值有修订', changed.map(r => [r.at, r.before === null ? null : r.before / 10]),
        changed.map(r => [r.at, r.after === null ? null : r.after / 10]), changed, changed.at(-1)?.at);
      if (last.freeze.status !== 'captured' && value.freeze.status === 'captured')
        attach('freeze', '已留存规则触发后的首份轮询快照', last.freeze.status, value.bracket?.label ?? null,
          [value.freeze.trigger?.at, value.bracketValue], value.freeze.trigger?.at);
    }
    const platformChanged = JSON.stringify(previousStatus) !== JSON.stringify(outputStatus);
    if (before?.platform && platformChanged && ['proposed', 'disputed', 'settled'].includes(platform.status))
      attach('settlement', settled ? '平台实际结算' : '平台结算流程状态变化', before.platform.status,
        platform.outcome ?? platform.status, outputStatus, platform.resolvedAt, true);
    if (!raw || !fact || !value.usableForWatch) {
      const settlement = findings.find(finding => finding.eventKey === digest(eventPrefix, 'settlement'));
      if (settlement && previous?.last) {
        const platformOnly = save(weatherCheckSource, { kind: 'weather_watch_platform_change', platform,
          previousWeatherEvidenceId: before?.previousWeatherEvidenceId ?? previous.last.evidence.evidenceId,
          inputEvidenceIds: [result.evidenceId, ...platform.evidenceIds],
          weatherCoverage: { status: value.coverage, reasons: value.reasons } });
        return { observations: [{ id: digest(eventPrefix, outputStatus, 'platform'), scope: item.scope,
          observedAt: platformOnly.retrievedAt, factAt: platform.resolvedAt, evidence: platformOnly,
          inputEvidenceIds: platformOnly.data.inputEvidenceIds, value: previous.last.value,
          findings: [{ ...settlement, unknowns: [...settlement.unknowns ?? [], `气象覆盖 ${value.coverage}，保留上次有效气象基线`,
            ...(platform.source ? [`平台原文 ${platform.source}`] : [])] }] }] };
      }
      return issue(value.coverage === 'failed' ? 'failed' : value.coverage === 'stale' ? 'stale' : value.coverage === 'pending' ? 'pending' : 'partial',
        `天气原文需核对。 ${value.reasons.join('；') || value.state}\n${contract.primary.url}`, [result.evidenceId, ...ids]);
    }
    const observedAt = same && !sourceRecovered ? previous!.last!.observedAt : ref.retrievedAt;
    if (item.maxAgeSeconds && epoch(ref.retrievedAt) - epoch(observedAt) > item.maxAgeSeconds * 1000)
      return issue('stale', `天气来源仍为同一版本，超过任务新鲜度阈值。\n${contract.primary.url}`, [result.evidenceId, raw.evidenceId]);
    return { observations: [{ id: key, scope: item.scope, evidence: ref,
      inputEvidenceIds: [...new Set([raw.evidenceId, ...platform.evidenceIds, item.weather.contractEvidenceId])],
      observedAt, sourceVersion, factAt: settled && platformChanged ? platform.resolvedAt ?? fact : fact,
      value: value.bracket?.label ?? undefined, findings }] };
  };

  async function books(spec: Temperature, signal: AbortSignal, bothSides = false) {
    const targets = spec.bands.flatMap(b => [{ band: b, tokenId: b.yesToken, outcome: 'Yes' },
      ...(bothSides && b.noToken ? [{ band: b, tokenId: b.noToken, outcome: 'No' }] : [])]);
    const result = [];
    for (let i = 0; i < targets.length; i += 4) {
      result.push(...await Promise.all(targets.slice(i, i + 4).map(async ({ band: b, tokenId, outcome }) => {
        const read = await readPublic({ view: 'book', id: tokenId, condition_id: b.conditionId }, signal);
        const value = (read.result ?? {}) as Record<string, any>;
        return { label: b.label, conditionId: b.conditionId, tokenId, market: b.url, outcome,
          bid: value.bestBid ?? null, ask: value.bestAsk ?? null, status: read.status,
          source: read.source, evidenceId: read.evidenceId, quotedAt: value.sourceTime ?? null, retrievedAt: read.retrievedAt,
          ...(bothSides ? { spread: value.spread ?? null, bids: value.bids?.slice(0, 3) ?? [], asks: value.asks?.slice(0, 3) ?? [],
            lastTradePrice: value.lastTradePrice ?? null, tickSize: value.tickSize ?? null, bookShape: value.bookShape ?? null,
            timestampStatus: value.timestampStatus ?? 'unknown', ageSeconds: value.ageSeconds ?? null,
            directlyObservedAt: value.directlyObservedAt ?? null } : {}) };
      })));
    }
    return result;
  }

  async function reportTiming(spec: Temperature, rows: (Metar | null)[], signal: AbortSignal) {
    if (!rows.some(Boolean)) return null;
    const url = new URL(awcRequest(spec.primary.url, spec.station).url);
    url.searchParams.set('format', 'json');
    const snapshot = await capture(url.href, 'awc_timing_json', spec.primary.publisher, signal);
    let data: Record<string, unknown>[] = [];
    let status = snapshot.data.status;
    if (snapshot.data.status === 'ok') {
      try {
        const parsed = JSON.parse(snapshot.data.raw);
        if (Array.isArray(parsed)) data = parsed;
        else status = 'invalid_json';
      } catch { status = 'invalid_json'; }
    }
    const normalized = (raw: string) => raw.trim().replace(/=$/, '').trim().replace(/\s+/g, ' ');
    return { source: snapshot.source, evidenceId: snapshot.evidenceId, retrievedAt: snapshot.retrievedAt,
      status, reason: snapshot.data.reason,
      reports: [...new Map(rows.flatMap(row => row ? [[row.at, row] as const] : [])).values()].map(row => {
        const matches = data.filter(r => r?.icaoId === spec.station && Number(r.obsTime) * 1000 === epoch(row.at) &&
          typeof r.rawOb === 'string' && normalized(r.rawOb) === normalized(row.raw));
        const received = matches.length === 1 ? epoch(matches[0].receiptTime) : NaN;
        const delaySeconds = (received - epoch(row.at)) / 1000;
        const valid = delaySeconds >= 0 && received <= epoch(snapshot.retrievedAt);
        return { observedAt: row.at, rawEvidenceId: row.evidenceId, rawSnapshotReadAt: row.seenAt,
          awcReceivedAt: valid ? iso(received) : null, awcDelaySeconds: valid ? delaySeconds : null };
      }) };
  }

  async function forecastPosition(spec: Temperature, signal: AbortSignal) {
    const verified = stationCoordinates[spec.station];
    if (verified) return { coordinates: verified };
    if (spec.adapter !== 'awc_raw') return {};
    const url = sourceSetting('PM_AWC_URL') + '/api/data/stationinfo?' + new URLSearchParams({ ids: spec.station, format: 'json' });
    const row = await capture(url, 'awc_stationinfo', spec.primary.publisher, signal);
    const reference = { source: row.source, evidenceId: row.evidenceId, retrievedAt: row.retrievedAt, status: row.data.status };
    if (row.data.status === 'ok') {
      try {
        const data = JSON.parse(row.data.raw);
        if (Array.isArray(data) && data.length === 1 && data[0]?.icaoId === spec.station) {
          const { lat, lon } = data[0];
          if (Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180)
            return { coordinates: [lat, lon] as [number, number], reference };
        }
      } catch { /* A malformed metadata response does not verify a station position. */ }
    }
    return { reference: { ...reference, status: row.data.status === 'ok' ? 'unverified_station' : row.data.status } };
  }

  function modelBrackets(spec: Temperature, peaks: number[]) {
    // HKO rules preserve decimals without defining an integer projection for exact-degree bands.
    if (!peaks.length || spec.adapter === 'hko_daily_extract') return null;
    const expected = peaks.map(c => projectedBracketValue(c, spec.unit));
    const counts = spec.bands.map(b => ({ label: b.label, conditionId: b.conditionId, min: b.min, max: b.max,
      members: expected.filter(value => includes(b, value)).length }));
    return { samples: expected.length, outOfBands: expected.length - counts.reduce((sum,c) => sum + c.members, 0),
      bands: counts.map(b => ({ ...b, frequency: b.members / expected.length })), calibration: 'not_evaluated' };
  }

  type StationForecast = Awaited<ReturnType<typeof locations.stationForecast>>;
  function compareForecastSnapshot(id: string, spec: Temperature, current: StationForecast) {
    const row = load(id);
    const before = row?.data as { kind?: string; event?: string; ruleVersion?: string; forecast?: StationForecast } | undefined;
    if (before?.kind !== 'weather_temperature_desk' || before.event !== spec.target.eventSlug || before.ruleVersion !== spec.ruleVersion ||
        before.forecast?.place.id !== spec.station || before.forecast.target.from !== spec.window.from ||
        before.forecast.target.to !== spec.window.to) throw Error('上次快照必须来自同一事件、测站、观测日和规则版本的温度盯盘。');
    const models = current.records.flatMap(after => {
      const prior = before.forecast!.records.find(r => r.model === after.model);
      if (!prior || prior.source.retrievedAt > after.source.retrievedAt || prior.temperatureCoverage !== 'covered' ||
          after.temperatureCoverage !== 'covered' || prior.peakC === null || after.peakC === null) return [];
      const previous = new Map(prior.hourly.rows.map(r => [r.validAt, r.values.temperature_2m]));
      const changed = after.hourly.rows.flatMap(r => {
        const from = previous.get(r.validAt), to = r.values.temperature_2m;
        return typeof from === 'number' && typeof to === 'number' && from !== to ? [{ at: r.validAt, beforeC: from, afterC: to }] : [];
      });
      return [{ model: after.model, before: prior.source, after: after.source, beforePeakC: prior.peakC, afterPeakC: after.peakC,
        beforePeakAt: prior.peakAt, afterPeakAt: after.peakAt, changed }];
    });
    const prior = before.forecast.ensemble;
    const latest = current.ensemble;
    const left = prior && modelBrackets(spec, prior.memberPeaks);
    const right = latest && modelBrackets(spec, latest.memberPeaks);
    const ensemble = left && right && prior?.model === latest?.model && prior && latest &&
        prior.samples === prior.selectedColumns && latest.samples === latest.selectedColumns && left.samples === right.samples ? {
        model: latest.model, before: prior.source, after: latest.source, samples: right.samples,
        bandsChanged: right.bands.flatMap((b, i) => b.members === left.bands[i]?.members ? [] :
          [{ label: b.label, beforeMembers: left.bands[i]?.members, afterMembers: b.members }]),
      } : null;
    return { evidenceId: id, basis: 'observed_snapshots_publication_time_unverified',
      status: models.length || ensemble ? 'compared' : 'no_comparable_model', models, ensemble };
  }

  function remainingTemperature(spec: Temperature, read: StationForecast, asOf: string, observedC: number | null, threshold?: number) {
    const { from, to } = spec.window;
    const remaining = read.ensemble?.remaining;
    const start = epoch(asOf) < epoch(from);
    const hasFuture = epoch(asOf) < epoch(to);
    const peaks = !hasFuture || (!start && observedC === null) ? []
      : (remaining?.memberPeaks ?? []).map(c => observedC === null ? c : Math.max(c, observedC));
    const range = (values: number[]) => values.length ? [Math.min(...values), Math.max(...values)] : null;
    const reached = threshold !== undefined && peaks.length
      ? peaks.filter(c => (spec.unit === 'F' ? c * 9 / 5 + 32 : c) >= threshold).length : null;
    const thresholdReads = threshold === undefined ? undefined : {
      value: threshold, unit: spec.unit, basis: 'physical_temperature_threshold_before_contract_rounding',
      reachedInSamples: reached, frequency: reached === null ? null : reached / peaks.length,
      observedReached: observedC === null ? null : (spec.unit === 'F' ? observedC * 9 / 5 + 32 : observedC) >= threshold,
    };
    const distribution = modelBrackets(spec, peaks);
    const floorBand = spec.adapter === 'awc_raw' && observedC !== null ? projectedBracketValue(observedC, spec.unit) : null;
    const next = floorBand === null ? undefined : spec.bands.find(b => b.min !== undefined && b.min > floorBand);
    const crossing = next && peaks.length ? peaks.filter(c => projectedBracketValue(c, spec.unit) >= next.min!).length : null;
    return { status: !hasFuture ? 'observation_day_ended' : !start && observedC === null ? 'verified_observed_floor_needed'
      : !peaks.length ? 'remaining_ensemble_unavailable' : 'available',
      basis: 'maximum_of_observed_floor_and_remaining_hourly_ensemble_member_maximum',
      from: remaining?.from ?? (start ? from : asOf), to, expectedHours: remaining?.expectedHours ?? 0,
      observedFloorC: observedC, fullDayMemberPeakRangeC: range(read.ensemble?.memberPeaks ?? []), remainingMemberPeakRangeC: range(peaks),
      samples: peaks.length, calibration: 'not_evaluated',
      bands: distribution?.bands ?? null, outOfBands: distribution?.outOfBands ?? null, threshold: thresholdReads,
      nextBracket: next ? { label: next.label, conditionId: next.conditionId, lowerBound: next.min,
        membersAtOrAbove: crossing, frequencyAtOrAbove: crossing === null ? null : crossing / peaks.length } : null,
      mappingStatus: spec.adapter === 'hko_daily_extract' ? 'contract_integer_mapping_unverified' : peaks.length ? 'projected_with_contract_rounding' : 'unavailable' };
  }

  async function listMarketCities(dates: string[], metrics: NonNullable<WeatherDiscoveryQuery['metrics']>, signal: AbortSignal) {
    if (dates.length > 4 || dates.some(date => {
      const [y,m,d] = date.split('-').map(Number);
      return !/^20\d\d-\d\d-\d\d$/.test(date) || calendarDate(y,m - 1,d) !== date;
    })) throw Error('最多提供 4 个有效观测日。');

    const source = new URL(sourceSetting('PM_POLYMARKET_GAMMA_URL') + '/events/keyset?tag_slug=daily-temperature&active=true&closed=false&archived=false&order=id&ascending=true&limit=50');
    const pages: { source: string; count: number; retrievedAt: string }[] = [];
    const events = new Map<string, { id: string; city: string; title: string; name: string; date: string; metric: string; url: string; openMarkets: string[] }>();
    let complete = false, issue: string | undefined;
    for (let page = 0; page < 10; page++) {
      try {
        const response = await fetch(source, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
        const body = JSON.parse((await officialBody(response)).toString('utf8'));
        if (!Array.isArray(body.events)) throw Error('Gamma 缺少 events 列表。');
        pages.push({ source: source.href, count: body.events.length, retrievedAt: now() });
        for (const event of body.events) {
          const slug = typeof event.slug === 'string' && dailyTemperatureSlug.exec(event.slug);
          if (!slug || event.active !== true || event.closed !== false || event.archived || !Array.isArray(event.markets)) continue;
          const date = ymd(slug[3],slug[4],slug[5]);
          const metric = slug[1].toLowerCase() === 'lowest' ? 'temperature_min' : 'temperature_max';
          if (dates.length && !dates.includes(date) || !metrics.includes(metric)) continue;
          const openMarkets = event.markets.filter((market: Record<string, unknown>) => market.active === true && market.closed === false &&
            market.acceptingOrders === true && typeof market.slug === 'string').map((market: { slug: string }) => market.slug);
          if (!openMarkets.length) continue;
          const title = typeof event.title === 'string' ? event.title : event.slug;
          const name = /^(?:highest|lowest) temperature in (.+?) on [a-z]+ \d/i.exec(title)?.[1] ?? slug[2];
          events.set(event.slug, { id: String(event.id), city: slug[2], title, name, date, metric,
            url: `${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${event.slug}`, openMarkets });
        }
        if (!body.next_cursor) { complete = true; break; }
        if (typeof body.next_cursor !== 'string' || body.next_cursor === source.searchParams.get('after_cursor'))
          throw Error('Gamma 翻页游标无效。');
        source.searchParams.set('after_cursor', body.next_cursor);
      } catch (error) {
        signal.throwIfAborted();
        issue = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    const groups = new Map<string, { city: string; name: string; markets: { date: string; metric: string; url: string }[] }>();
    for (const { city, name, date, metric, url } of events.values()) {
      const group = groups.get(city) ?? { city, name, markets: [] };
      group.markets.push({ date, metric, url });
      groups.set(city, group);
    }
    const cities = [...groups.values()].sort((a,b) => a.name.localeCompare(b.name));
    const payload = { kind: 'weather_market_cities', dates, metrics, cities, cityCount: cities.length,
      eventCount: events.size, coverage: complete ? 'covered' : pages.length ? 'partial' : 'failed',
      reason: complete ? undefined : issue ?? '已达 Gamma 分页上限。', source: sourceSetting('PM_POLYMARKET_WEB_URL') + '/weather/temperature',
      asOf: now(), pages };
    const { evidenceId } = save(weatherCheckSource, { ...payload, events: [...events.values()] });
    return { ...payload, evidenceId };
  }

  async function discover({ cities, dates, fresh, metrics = ['temperature_max'], marketStatus = 'open' }: WeatherDiscoveryQuery, signal: AbortSignal) {
    const supportedCities: Record<string, string> = { '伦敦': 'london', '纽约': 'nyc', '芝加哥': 'chicago', '首尔': 'seoul',
      '巴黎': 'paris', '新加坡': 'singapore', 'new york': 'nyc', 'new york city': 'nyc' };
    const names = [...new Set(cities.map(c => supportedCities[c.trim().toLowerCase()] ?? c.trim().toLowerCase()))];
    if (!names.length || names.length > 4 || names.some(c => !/^[a-z]+(?:-[a-z]+)*$/.test(c)) ||
        !dates.length || dates.length > 4 || dates.some(d => !/^20\d\d-\d\d-\d\d$/.test(d) || !Number.isFinite(Date.parse(d))) ||
        fresh !== undefined && (!Number.isFinite(fresh) || fresh < 60 || fresh > 86_400))
      throw Error('天气盘筛选需 1–4 个城市、明确的测站当地日期和有效新鲜度。');
    const scans = [];
    for (const city of names) scans.push({ city, ...await screen(city.replaceAll('-', ' '), marketStatus === 'open', signal) });
    const patterns = [...new Set(metrics)].map(metric => ({ metric, word: metric === 'temperature_min' ? 'lowest' : 'highest' }));
    if (!patterns.length || metrics.some(m => m !== 'temperature_max' && m !== 'temperature_min')) throw Error('筛选类型须为支持的日高或日低。');
    const candidates = new Map<string, { city: string; url: string }>();
    for (const scan of scans) {
      for (const match of scan.matches) {
        if (typeof match.marketUrl !== 'string') continue;
        const parsed = URL.parse(match.marketUrl);
        const event = parsed?.pathname.split('/')[2];
        const prefix = patterns.map(p => `${p.word}-temperature-in-${scan.city}-on-`).find(p => event?.startsWith(p));
        if (!prefix || !event) continue;
        const matchDate = new RegExp('^(' + monthPattern + ')-(\\d{1,2})-(20\\d{2})$', 'i').exec(event.slice(prefix.length));
        if (!matchDate || !dates.includes(ymd(matchDate[1],matchDate[2],matchDate[3]))) continue;
        candidates.set(event, { city: scan.city, url: match.marketUrl });
      }
    }
    const exact = [];
    for (const city of names) for (const date of dates) for (const { word } of patterns) {
      const [y, m, d] = date.split('-');
      if (calendarDate(+y,+m - 1,+d) !== date) throw Error('观测日无效。');
      const event = `${word}-temperature-in-${city}-on-${months[+m - 1].toLowerCase()}-${+d}-${y}`;
      if (candidates.has(event)) continue;
      const proof = await readPublic({ view: 'event', id: event }, signal);
      exact.push({ event, city, date, status: proof.status, evidenceId: proof.evidenceId, source: proof.source });
      const doc = (load(proof.evidenceId)?.data as Record<string, any> | undefined)?.response;
      const sub = doc?.markets?.find((row: Record<string, any>) =>
        (marketStatus === 'all' || row.closed === (marketStatus === 'closed')) && typeof row.slug === 'string' &&
        row.slug.startsWith(event + '-') && /^[a-z\d-]+$/.test(row.slug) && findTokens(row).length === 2);
      if (proof.status === 'ok' && doc?.slug === event && sub) candidates.set(event, { city, url: `${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${event}/${sub.slug}` });
    }
    const results = [];
    for (const [event, candidate] of [...candidates].slice(0, 8)) {
      const checked = await inspect({ market: candidate.url }, signal);
      if (!('contract' in checked)) {
        results.push({ ...candidate, event, status: 'unverified', evidenceId: checked.evidenceId });
        continue;
      }
      const data = checked.observation as TempResult;
      const ageSeconds = data.lastObservation?.at ? Math.max(0,(Date.now() - epoch(data.lastObservation.at))/1000) : null;
      const freshness = fresh === undefined ? 'unfiltered' : ageSeconds === null ? 'unverified' : ageSeconds <= fresh ? 'fresh' : 'stale';
      const marketMatches = marketStatus === 'open' ? checked.platform.open === true :
        marketStatus === 'closed' ? checked.platform.open === false : true;
      results.push({ ...candidate, event, status: marketMatches && ['fresh','unfiltered'].includes(freshness)
        ? 'match' : freshness === 'stale' ? 'excluded_stale' : 'unverified', station: isTemperature(checked.contract) ? checked.contract.station : null,
        date: checked.contract.window.date, coverage: data.coverage, ageSeconds, freshness, evidenceId: checked.evidenceId,
        createdAt: checked.contract.target.createdAt, metric: checked.contract.kind, bracket: data.bracket?.label,
        contractEvidenceId: checked.contractEvidenceId, observedAt: data.lastObservation?.at ?? null, quoteScope: 'catalog_candidates_and_weather_read' });
    }
    const payload = { kind: 'weather_market_discovery', cities: names, dates, maxAgeSeconds: fresh, metrics, marketStatus, results,
      catalog: scans.map(({ city, coverage, evidenceId }) => ({ city, coverage, evidenceId })), exact, candidates: candidates.size,
      truncated: candidates.size > 8 || scans.some(s => (s.coverage.unscannedMarkets as number ?? 0) > 0 || s.coverage.status === 'failed'),
      scope: 'Polymarket daily maximum/minimum temperature, exact city and station day',
      inputEvidenceIds: [...scans.map(s => s.evidenceId), ...exact.map(r => r.evidenceId), ...results.map(r => r.evidenceId)] };
    return { ...payload, evidenceId: save(weatherCheckSource, payload).evidenceId };
  }

  async function compareMarkets(markets: string[], signal: AbortSignal) {
    if (markets.length < 2 || markets.length > 4) throw Error('提供 2–4 个精确天气子合约。');
    const rows = [];
    for (const market of markets) {
      if (hourlyTicker.test(market)) {
        const checked = await pointContract(market.toUpperCase(),signal);
        rows.push({ market, evidenceId: checked.evidenceId, ...checked.contract, platform: checked.platform });
        continue;
      }
      const checked = await inspect({ market }, signal);
      if ('contract' in checked) {
        const c = checked.contract;
        rows.push({ market, evidenceId: checked.evidenceId, kind: c.kind, target: c.target,
          window: c.window, primary: c.primary, backup: c.backup, quotes: c.quotes, ruleVersion: c.ruleVersion,
          observation: { coverage: checked.observation.coverage, bracket: 'bracket' in checked.observation ? checked.observation.bracket : undefined,
            value: 'converted' in checked.observation ? checked.observation.converted : undefined } });
      } else {
        const resolver = checked.inputEvidenceIds?.[0] && load(checked.inputEvidenceIds[0]);
        const r = (resolver && resolver.data || {}) as Record<string, any>;
        const rules = String(r.rules ?? '');
        const low = rules.match(/[^\n.]*lowest temperature[^\n.]*/i)?.[0];
        const at = rules.match(/[^\n.]*temperature[^\n.]*(?:at \d{1,2}:\d\d|at \d{1,2}\s*(?:AM|PM)|specified time)[^\n.]*/i)?.[0];
        rows.push({ market, evidenceId: checked.evidenceId, targetEvidenceId: resolver && resolver.evidenceId,
          kind: low ? 'temperature_min' : at ? 'temperature_at' : 'unclassified', status: 'rule_review_required',
          quotes: { measure: low ?? at ?? rules.split('\n\n')[0], source: rules.split('\n\n').find(p => /resolution source/i.test(p)) } });
      }
    }
    const payload = { kind: 'weather_contract_comparison', rows,
      inputEvidenceIds: rows.flatMap(r => [r.evidenceId, 'targetEvidenceId' in r ? r.targetEvidenceId : undefined].filter(Boolean)) };
    return { ...payload, evidenceId: save(weatherCheckSource, payload).evidenceId };
  }

  const hourlyTicker = /^KXTEMPNYCHS-\d{2}[A-Z]{3}\d{4}-T\d+(?:\.\d{1,2})?$/i;
  async function pointContract(ticker: string, signal: AbortSignal) {
    const raw = await capture(kalshiApi + ticker,'kalshi_market','Kalshi',signal);
    const m = raw.data.status === 'ok' ? JSON.parse(raw.data.raw).market : undefined;
    const criteria = String(m?.rules_primary ?? '');
    const methodology = String(m?.rules_secondary ?? '');
    const target = new RegExp('New York City for (' + monthPattern + ') (\\d{1,2}), (20\\d{2}) at (\\d{1,2}) (AM|PM) (EST|EDT) as reported by Synoptic Data, is above (\\d+(?:\\.\\d+)?)°').exec(criteria);
    const url = sourceSetting('PM_KALSHI_WEB_URL') + '/markets/kxtempnychs/hourly-directional-nyc-temperature/' + ticker.split('-').slice(0,2).join('-').toLowerCase();
    const common = { kind: 'temperature_at', ticker, url, title: m?.title, ruleEvidenceIds: [raw.evidenceId],
      ruleVersion: digest(criteria,methodology), primary: { publisher: 'Synoptic Data / Kalshi Weather Index Methodology', url: raw.source },
      quotes: { criteria, methodology } };
    const valid = m?.ticker === ticker && target && +target[7] === m.floor_strike && methodology.includes('Kalshi Weather Index Methodology');
    let window;
    if (valid) {
      const h = +target[4] % 12 + (target[5] === 'PM' ? 12 : 0);
      const date = ymd(target[1],target[2],target[3]);
      const at = atLocal(date,target[6] === 'EST' ? est : 'Etc/GMT+4',String(h).padStart(2,'0') + ':00');
      const tickerHour = date.slice(2,4) + months[monthNumber(target[1])].slice(0,3).toUpperCase() + date.slice(-2) + String(h).padStart(2,'0');
      if (ticker.split('-')[1] === tickerHour) window = { at, timeZone: target[6], date, acceptedTimeTolerance: null };
    }
    const contract = { ...common, status: window ? 'rule_bound' : 'rule_review_required', window,
      object: 'New York City weather index', station: null, unit: null,
      threshold: valid ? { op: 'gt', value: Number(target[7]) } : undefined };
    const platform = { status: m?.status ?? 'unverified', outcome: ['settled','finalized'].includes(m?.status) ? m.result : undefined,
      evidenceIds: [raw.evidenceId] };
    const payload = { kind: 'weather_market_check', mode: 'current_platform_only', contract, platform,
      observation: { coverage: 'unsupported', state: 'confirmed_index_observation_required',
        reason: '公开市场规则指定 Synoptic Data 指数。尚未取得指数适用测站、精度、允许时差及权威读数。' },
      watch: { status: 'unsupported' }, inputEvidenceIds: [raw.evidenceId] };
    return { ...payload, evidenceId: save(weatherCheckSource,payload).evidenceId };
  }

  const tool = defineTool({ name: 'inspect_weather_market',
    description: '核对真实天气合约。temperature_desk 把最高温合约的指定站点实测、剩余时段跨档频率、分档买卖深度及快照变动接在一起。airport_factors 查看六站观测因素和跨档预警状态。雪、累计降水及飓风读取专用来源，个人天气支持预报、警报和条件。按 pm-weather-market Skill 选择查询及订阅。',
    parameters: { market: { ...str, description: 'Polymarket 市场链接、slug、本地 ID、condition，或 Kalshi KXRAINNYCM ticker。' },
      query_type: { ...str, enum: ['market','compare','discover','station_forecast','forecast_history','temperature_desk','airport_factors','personal','alerts','conditions'] },
      markets: { type: 'array', items: str }, cities: { type: 'array', items: str }, observation_dates: { type: 'array', items: str },
      contract_types: { type: 'array', items: { ...str, enum: ['temperature_max','temperature_min'] } },
      market_status: { ...str, enum: ['open','closed','all'] },
      max_age_seconds: { type: 'integer' }, include_books: { type: 'boolean' },
      previous_snapshot_evidence_id: { ...str, description: 'temperature_desk 上次同一事件的 supplementalEvidenceId，用于对照同模型实际读取的版本。' },
      temperature_threshold: { type: 'number', description: 'temperature_desk 可选，按合约单位统计达到此物理温度的集合成员数，先于结算取整。' },
      forecast_runs: { type: 'array', items: str }, ensemble_model: { ...str, enum: ['icon_seamless','gfs_seamless','ecmwf_ifs025'] },
      ...locationParameters,
      as_of: { ...str, description: '可选带时区的历史截点。之后取得的 AWC 快照只用于回顾，不能证明截点的版本。' },
      replay_evidence_ids: { type: 'array', items: str, description: '本工具先前保存的官方原始证据 ID。' },
      official_urls: { type: 'array', items: str, description: '允许的指定官方档案，如 NWS CLI 产品 UUID 链接、NHC 原始公告链接、合约范围内 WU 原表。' } },
    output: { schema: str, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, { signal }) {
      const intent = args.query_type ?? 'market';
      if (intent === 'compare') return JSON.stringify(await compareMarkets(args.markets ?? [], signal));
      if (intent === 'discover') {
        if (!args.cities?.length) {
          if (args.market_status && args.market_status !== 'open' || args.max_age_seconds !== undefined)
            throw Error('列城市默认仅看当前可下单市场。核对已关闭市场或观测新鲜度时，请提供城市和观测日。');
          return JSON.stringify(await listMarketCities(args.observation_dates ?? [], args.contract_types ?? ['temperature_max','temperature_min'], signal));
        }
        const result = await discover({ query_type: 'discover', cities: args.cities ?? [], dates: args.observation_dates ?? [],
          fresh: args.max_age_seconds, metrics: args.contract_types, marketStatus: args.market_status }, signal);
        return JSON.stringify({ ...result, watch: locations.prepare({ query_type: 'discover',
          cities: result.cities, dates: result.dates, fresh: result.maxAgeSeconds, metrics: result.metrics, marketStatus: result.marketStatus }) });
      }
      if (intent === 'personal' || intent === 'alerts' || intent === 'conditions')
        return JSON.stringify(await locations.inspect({ ...args, query_type: intent, locations: args.locations ?? [] } as LocationQuery, signal));
      if (intent === 'airport_factors') {
        if (args.as_of || args.replay_evidence_ids?.length || args.official_urls?.length)
          throw Error('机场因素查询读取当前观测。');
        const markets = args.markets?.length ? [...new Set(args.markets)] : args.market ? [args.market] : [];
        if (!markets.length || markets.length > 6) throw Error('请提供 1–6 个真实最高温市场。');
        const checked = async (market: string) => {
          try {
            const r = await inspect({ market }, signal, true, true);
            if (!('contract' in r)) return r;
            if (r.contract.kind !== 'temperature_max' || !supportsAirportFactors(r.contract.station))
              return { market, status: 'unsupported', reason: '该市场不在已接入的六站最高温范围。', evidenceId: r.evidenceId };
            const sample = await airportImpact(r.contract, r.observation, epoch(r.asOf), r.evidenceId, signal);
            return { ...sample.data, evidenceId: sample.evidenceId, watch: { ...r.watch, conditions: ['impact'], recommendedIntervalSeconds: 600 } };
          } catch (error) {
            signal.throwIfAborted();
            return { market, status: 'failed', reason: readError(error) };
          }
        };
        const results: Awaited<ReturnType<typeof checked>>[] = [];
        for (let i = 0; i < markets.length; i += 2)
          results.push(...await Promise.all(markets.slice(i, i + 2).map(checked)));
        return JSON.stringify(markets.length === 1 ? results[0] : { kind: 'weather_airport_impact_batch', results });
      }
      if (!args.market) throw Error('需要准确的天气市场链接、slug 或本地 ID。');
      const deskMode = intent === 'temperature_desk';
      if (deskMode && (args.as_of || args.forecast_runs?.length || args.replay_evidence_ids?.length || args.official_urls?.length))
        throw Error('温度盯盘读取当前快照。回放请使用 market 或 forecast_history。');
      if (!deskMode && (args.previous_snapshot_evidence_id || args.temperature_threshold !== undefined))
        throw Error('快照比较和温度阈值仅用于 temperature_desk。');
      if (intent === 'market' && hourlyTicker.test(args.market.trim())) return JSON.stringify(await pointContract(args.market.trim().toUpperCase(),signal));
      const result = await inspect({ ...args, market: args.market }, signal, deskMode);
      if (!('observation' in result)) return JSON.stringify(result);
      const { observation, contract, ...other } = result;
      const { rules: _rules, ...shortContract } = contract;
      const { rows: _rows, reports: _reports, counted: _counted, ...preview } = observation as typeof observation &
        { rows?: unknown[]; reports?: unknown[]; counted?: unknown[] };
      const wantBook = args.include_books ?? deskMode;
      const readBooks = () => wantBook && !args.as_of && isTemperature(contract) && (!deskMode || result.platform.open)
        ? books(contract, signal, deskMode) : Promise.resolve(undefined);
      let forecast;
      let book: Awaited<ReturnType<typeof readBooks>>;
      if (deskMode || intent === 'station_forecast' || intent === 'forecast_history') {
        const position = contract.kind === 'temperature_max' ? await forecastPosition(contract, signal) : undefined;
        if (contract.kind !== 'temperature_max' || !position?.coordinates) {
          if (deskMode) {
            return JSON.stringify({ ...other, contract: shortContract, observation: preview, book,
              desk: { status: 'unsupported', stationMetadata: position?.reference, reason: '当前只支持已核验预报坐标的最高温合约。' } });
          }
          throw Error('该合约尚未核验测站预报坐标。');
        }
        const [latitude, longitude] = position.coordinates;
        const positionEvidence = position.reference ? [position.reference.evidenceId] : [];
        const runs = args.forecast_runs ?? [];
        if (intent === 'forecast_history' && !runs.length) throw Error('预报历史需提供实际模型初始化时刻。');
        if (args.as_of && !runs.length) throw Error('历史截点须绑定已保存预报或指定历史模型版本。');
        const asOf = epoch(result.asOf);
        const from = epoch(contract.window.from);
        const to = epoch(contract.window.to);
        const configuredModels = args.models?.length ? args.models : undefined;
        const models = configuredModels ?? (runs.length ? ['gfs_global']
          : [deskMode ? regionalModels[contract.station] ?? 'icon_global' : 'icon_seamless', 'ecmwf_ifs']);
        const [read, timing, snapshots] = await Promise.all([
          deskMode && asOf >= to ? Promise.resolve(null) : locations.stationForecast(
            { id: contract.station, label: contract.station, latitude, longitude, timeZone: contract.window.timeZone },
            from, to, asOf, models, runs, signal, args.ensemble_model ?? (deskMode ? 'ecmwf_ifs025' : 'icon_seamless'), deskMode),
          deskMode && contract.adapter === 'awc_raw' && 'peak' in observation
            ? reportTiming(contract, [observation.peak, observation.lastObservation], signal) : undefined,
          readBooks(),
        ]);
        book = snapshots;
        if (deskMode) {
          const observedC = 'usableForWatch' in observation && observation.usableForWatch && asOf >= from && asOf < to
            ? 'peak' in observation ? (observation.peak?.tenthsC ?? NaN) / 10 : observation.provisional?.value ?? null
            : null;
          const desk = { status: read ? 'checked' : 'observation_day_ended', timing, stationMetadata: position.reference,
            observedBasis: contract.adapter === 'hko_daily_extract' ? 'hko_provisional_since_midnight' : 'eligible_metar_as_observed',
            observationWindow: { phase: asOf < from ? 'not_started' : asOf < to ? 'in_progress' : 'ended',
              timeZone: contract.window.timeZone,
              fromLocal: clock(contract.window.timeZone, from), toLocal: clock(contract.window.timeZone, to),
              fromBeijing: clock('Asia/Shanghai', from), toBeijing: clock('Asia/Shanghai', to),
              nowLocal: clock(contract.window.timeZone, asOf), nowBeijing: clock('Asia/Shanghai', asOf) },
            books: { status: !wantBook ? 'not_requested' : !book ? 'market_not_open' : book.some(r => r.status === 'ok') ? 'snapshots' : 'no_book',
              firstReadAt: book?.map(r => r.retrievedAt).sort()[0] ?? null,
              lastReadAt: book?.map(r => r.retrievedAt).sort().at(-1) ?? null,
              coveredTokens: book?.filter(r => r.status === 'ok').length ?? 0, requestedTokens: book?.length ?? 0,
              continuousCoverage: 'unverified' },
            remaining: read && remainingTemperature(contract, read, result.asOf,
              observedC !== null && Number.isFinite(observedC) ? observedC : null, args.temperature_threshold),
            forecastChanges: read && args.previous_snapshot_evidence_id
              ? compareForecastSnapshot(args.previous_snapshot_evidence_id, contract, read) : undefined,
            models: read?.records.map(r => ({ model: r.model, source: r.source, grid: r.grid, publishedAt: r.publishedAt,
              peakC: r.peakC, coverage: r.temperatureCoverage,
              peakAt: r.peakAt.map(at => ({ at, local: clock(contract.window.timeZone, epoch(at)) })),
              upcoming: r.hourly.rows.filter(row => epoch(row.validAt) >= asOf).slice(0, 3),
              peakConditions: r.hourly.rows.find(row => row.validAt === r.peakAt[0]) ?? null })),
            ensemble: read?.ensemble && { source: read.ensemble.source, model: read.ensemble.model, grid: read.ensemble.grid,
              coverage: read.ensemble.coverage, memberCount: read.ensemble.samples, selectedColumns: read.ensemble.selectedColumns,
              sampleBasis: read.ensemble.sampleBasis, publishedAt: read.ensemble.publishedAt } };
          const evidence = save(weatherCheckSource, { kind: 'weather_temperature_desk', event: contract.target.eventSlug,
            ruleVersion: contract.ruleVersion, asOf: result.asOf, desk, book, forecast: read,
            inputEvidenceIds: [...new Set([result.evidenceId, ...book?.map(r => r.evidenceId) ?? [],
              ...read?.inputEvidenceIds ?? [], ...positionEvidence, ...timing ? [timing.evidenceId] : [],
              ...desk.forecastChanges ? [desk.forecastChanges.evidenceId] : []])] });
          return JSON.stringify({ ...other, sourceSnapshots: other.sourceSnapshots.slice(-8), contract: shortContract,
            observation: preview, book, desk, supplementalEvidenceId: evidence.evidenceId });
        }
        if (!read) throw Error('未取得站点预报。');
        const observations = observation as TempResult;
        const finalReading = runs.length ? await inspect({ market: args.market, replay_evidence_ids: args.replay_evidence_ids }, signal) : undefined;
        const outcomeRead = finalReading && 'observation' in finalReading ? finalReading.observation as TempResult : undefined;
        const distribution = modelBrackets(contract, read.ensemble?.memberPeaks ?? []);
        const peakC = read.records.flatMap(r => r.peakC === null ? [] : [r.peakC]);
        const errors = read.records.flatMap(r => r.availableAtCutoff && r.hourly.coverage === 'covered' &&
          r.peakC !== null && outcomeRead?.coverage === 'covered' && outcomeRead.peak ?
          [{ forecastAt: r.modelInitializedAt, leadHours: r.leadHours, errorC: Math.round((r.peakC - outcomeRead.peak.tenthsC/10) * 100)/100 }] : []);
        const versionChanges = read.records.slice(1).map((r,i) => {
          const prior = read.records[i];
          const seen = new Map(prior.hourly.rows.map(row => [row.validAt, row.values.temperature_2m]));
          const changed = r.hourly.rows.flatMap(row => {
            const before = seen.get(row.validAt);
            const value = row.values.temperature_2m;
            return typeof before === 'number' && typeof value === 'number' && before !== value ?
              [{ at: row.validAt, beforeC: before, afterC: value, changeC: Math.round((value - before)*100)/100 }] : [];
          });
          return { before: prior.modelInitializedAt, after: r.modelInitializedAt, changed };
        });
        forecast = { ...read, stationMetadata: position.reference,
          inputEvidenceIds: [...read.inputEvidenceIds, ...positionEvidence, ...finalReading ? [finalReading.evidenceId] : []],
          rangeOfModelPeaksC: peakC.length ? [Math.min(...peakC), Math.max(...peakC)] : null,
          distribution: distribution && { method: 'map_full_window_hourly_member_max_to_contract_brackets', ...distribution },
          versionChanges: runs.length ? versionChanges : undefined,
          historyEvaluation: runs.length ? { status: errors.length ? 'verified_upstream_publication' : 'coverage_or_publication_unverified',
            availableAtCutoff: read.records.filter(r => r.availableAtCutoff).length,
            samples: errors.length, errors, maeC: errors.length ? errors.reduce((sum,r) => sum + Math.abs(r.errorC),0)/errors.length : null,
            observationEvidenceId: finalReading?.evidenceId, rawObservationEvidenceId: outcomeRead?.rawEvidenceId,
            historicalObservationCoverage: outcomeRead?.coverage, observedC: outcomeRead?.peak ? outcomeRead.peak.tenthsC/10 : null,
            forecastObservedAsOf: observations.coverage } : undefined };
      } else book = await readBooks();
      const supplemental = forecast || book ? save(weatherCheckSource, { kind: 'weather_market_augmentation',
        inputEvidenceIds: [result.evidenceId, ...book?.map(b => b.evidenceId) ?? [], ...forecast?.inputEvidenceIds ?? []], forecast, book }) : undefined;
      return JSON.stringify({ ...other, sourceSnapshots: other.sourceSnapshots.slice(-8), contract: shortContract,
        observation: preview, book, forecast, supplementalEvidenceId: supplemental?.evidenceId });
    },
  });
  return { tool, authorize, readWatch, locations };
}
