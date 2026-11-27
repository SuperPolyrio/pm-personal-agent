import { sourceSetting } from './source-config.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { officialBody } from './market-web-search.js';
import { getWatch, now, saveEvidence, type Watch } from './store.js';
import type { EvidenceRow } from './source-evidence.js';

const hour = 3600_000;
const iso = (at: number) => new Date(at).toISOString();
const digest = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const instant = (at?: string) => at && /(?:Z|[+-]\d\d:\d\d)$/i.test(at) ? Date.parse(at) : NaN;
const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const obj = <const T extends Record<string, unknown>>(properties: T) => ({ type: 'object', additionalProperties: false, properties } as const);
const metrics = ['forecast_rain_mm', 'observed_rain_mm', 'temperature_c', 'relative_humidity_pct', 'wind_kmh', 'gust_kmh',
  'wave_m', 'snowfall_cm', 'us_aqi', 'european_aqi', 'grass_pollen'] as const;
const ops = ['lt', 'lte', 'gt', 'gte'] as const;
const activities = ['commute', 'laundry', 'run', 'hike', 'ski', 'sail'] as const;

type Point = { name?: string; latitude?: number; longitude?: number; country_code?: string };
type Place = { id: string; label: string; latitude: number; longitude: number; timeZone?: string; countryCode?: string };
type Condition = { metric: typeof metrics[number]; op: typeof ops[number]; value: number; hours?: number };
export type LocationQuery = { query_type: 'personal' | 'alerts' | 'conditions'; locations: Point[]; start?: string; end?: string;
  as_of?: string; activity?: typeof activities[number]; models?: string[]; conditions?: Condition[]; alert_events?: string[];
  alert_severities?: string[]; alert_urls?: string[]; replay_evidence_ids?: string[] };
export type WeatherDiscoveryQuery = { query_type: 'discover'; cities: string[]; dates: string[]; fresh?: number;
  metrics?: ('temperature_max' | 'temperature_min')[]; marketStatus?: 'open' | 'closed' | 'all' };
export type WeatherTaskQuery = LocationQuery | WeatherDiscoveryQuery |
  { query_type: 'market_ticker'; market: string; ruleVersion: string };
type ExternalFacts = { evidenceId: string; inputEvidenceIds: string[]; covered: boolean;
  facts: { key: string; value: string; text?: string }[] };
const pointSchema = obj({ name: str, latitude: num, longitude: num, country_code: str });
export const locationParameters = {
  locations: { type: 'array', items: pointSchema }, start: str, end: str,
  activity: { ...str, enum: activities }, models: { type: 'array', items: str },
  conditions: { type: 'array', items: obj({ metric: { ...str, required: true, enum: metrics },
    op: { ...str, required: true, enum: ops }, value: { ...num, required: true }, hours: num }) },
  alert_events: { type: 'array', items: str }, alert_severities: { type: 'array', items: str }, alert_urls: { type: 'array', items: str },
} as const;
type WeatherRow = Record<string, any>;
type Saved = Omit<EvidenceRow, 'data'> & { data: { kind: 'weather_location_source'; status: string; response?: WeatherRow; httpStatus?: number; error?: string } };
const weatherModels = ['best_match', 'ecmwf_ifs025', 'ecmwf_ifs', 'gfs_seamless', 'gfs_global', 'icon_seamless', 'icon_global',
  'ukmo_seamless', 'jma_msm', 'icon_d2', 'icon_eu'];
const hourly = ['temperature_2m','relative_humidity_2m','precipitation_probability','precipitation','rain','showers','snowfall',
  'wind_speed_10m','wind_gusts_10m'];
const minute = ['precipitation','rain','showers','snowfall','temperature_2m','relative_humidity_2m','wind_speed_10m','wind_gusts_10m'];
const ns = 'personal-agent/weather-location';
export const locationWatchPrompt = '执行当前原生唤醒的天气条件检查。';
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const forecastURL = (path: string, fields: Record<string, string>) => path + '?' + new URLSearchParams(fields);
const obsField = (sum: number | undefined, coverage: boolean, unit: string) => ({ value: coverage ? sum ?? null : null, unit, coverage });
const close = (a: number, b: number) => Math.abs(a - b) <= .6;
const meets = (v: number, c: Condition) => c.op === 'gt' ? v > c.value : c.op === 'gte' ? v >= c.value : c.op === 'lt' ? v < c.value : v <= c.value;
function rounded(value: number) { return Math.round(value * 1000) / 1000; }

function coordinates(point: Point): Place | undefined {
  if (!finite(point.latitude) || !finite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return;
  const id = point.latitude.toFixed(4) + ',' + point.longitude.toFixed(4);
  return { id, label: point.name?.trim().slice(0, 100) || id, latitude: +point.latitude.toFixed(4), longitude: +point.longitude.toFixed(4),
    countryCode: /^[A-Z]{2}$/.test(point.country_code ?? '') ? point.country_code : undefined };
}

function pointInRing(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i], [c, d] = ring[j];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}
function inAlert(geom: WeatherRow | undefined, point: Place) {
  const polygons = geom?.type === 'Polygon' ? [geom.coordinates] : geom?.type === 'MultiPolygon' ? geom.coordinates : [];
  return (polygons as number[][][][]).some(([outer, ...holes]) => outer &&
    pointInRing(point.longitude, point.latitude, outer) && !holes.some(hole => pointInRing(point.longitude, point.latitude, hole)));
}
const alertReference = (value: unknown) => typeof value === 'string' ? value.split('/').at(-1) : undefined;
const alertVersion = (p: WeatherRow) => digest(p.id, p.sent, p.messageType, p.status, p.severity, p.headline, p.expires);

export function createWeatherLocation(db: DatabaseSync, load: (id: string) => EvidenceRow | undefined,
    external: (q: Exclude<WeatherTaskQuery, LocationQuery>, signal: AbortSignal) => Promise<ExternalFacts>) {
  async function read(url: string, signal: AbortSignal): Promise<Saved> {
    let httpStatus: number | undefined;
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(12_000), signal]),
        headers: { Accept: 'application/geo+json, application/json', 'User-Agent': 'pm-personal-agent/0.1 weather evidence' } });
      httpStatus = response.status;
      const raw = (await officialBody(response)).toString('utf8');
      const body = JSON.parse(raw);
      if (!body || Array.isArray(body) || body.error) throw Error(body?.reason ?? 'unexpected_json_response');
      const data = { kind: 'weather_location_source' as const, status: 'ok', httpStatus, response: body };
      return { ...saveEvidence(db, url, data), data };
    } catch (e) {
      signal.throwIfAborted();
      const data = { kind: 'weather_location_source' as const, status: 'failed', httpStatus,
        error: e instanceof Error ? e.message : String(e) };
      return { ...saveEvidence(db, url, data), data };
    }
  }

  async function locate(point: Point, signal: AbortSignal) {
    if (point.latitude !== undefined || point.longitude !== undefined) {
      const place = coordinates(point);
      if (!place) throw Error('需要一对有效的纬度、经度。');
      return { place };
    }
    const name = point.name?.trim();
    if (!name || name.length > 100) throw Error('提供地点名称或一对坐标。');
    const capture = await read(forecastURL(sourceSetting('PM_OPEN_METEO_GEOCODING_URL') + '/v1/search', {
      name, count: '10', ...(point.country_code ? { countryCode: point.country_code.toUpperCase() } : {}), language: 'en', format: 'json',
    }), signal);
    const candidates = ((capture.data.response?.results ?? []) as WeatherRow[]).flatMap(row => {
      const pos = coordinates({ latitude: row.latitude, longitude: row.longitude });
      return pos ? [{ ...pos, id: 'geonames:' + row.id, label: [row.name, row.admin1, row.country].filter(Boolean).join(', '),
        timeZone: row.timezone, countryCode: row.country_code, population: row.population ?? 0 }] : [];
    });
    const significant = candidates.filter(row => row.population >= 100_000);
    // A common city name can be reused across countries. Accept a unique large match; otherwise return choices.
    const place = candidates.length === 1 ? candidates[0] : significant.length === 1 ? significant[0] : undefined;
    return { place, candidates, evidence: capture };
  }

  const meteo = (path: string, place: Place, more: Record<string, string>) =>
    forecastURL(path, { latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'UTC', ...more });

  async function forecast(place: Place, start: number, end: number, model: string, signal: AbortSignal, run?: string, temperatureDesk = false) {
    const url = meteo(run ? sourceSetting('PM_OPEN_METEO_RUNS_URL') + '/v1/forecast' : sourceSetting('PM_OPEN_METEO_URL') + '/v1/forecast', place, {
      hourly: (temperatureDesk ? [...hourly, 'cloud_cover','wind_direction_10m','dew_point_2m','shortwave_radiation'] : hourly).join(','),
      ...(run ? { run: run.replace(/:\d\d\.\d+Z$/, '').replace(/Z$/, '') } : temperatureDesk ? {} : { minutely_15: minute.join(',') }),
      models: model, timezone: 'auto', timeformat: 'unixtime',
      ...(run ? {} : { start_date: iso(start - 24 * hour).slice(0, 10), end_date: iso(end + 24 * hour).slice(0, 10) }),
    });
    const source = await read(url, signal);
    return { source, model, modelInitializedAt: run ?? null, publishedAt: null,
      grid: grid(source, place), hourly: series(source, 'hourly', start, end, 60), minutely15: series(source, 'minutely_15', start, end, 15) };
  }

  function grid(source: Saved, p: Place) {
    const d = source.data.response;
    return d && finite(d.latitude) && finite(d.longitude) ? { latitude: d.latitude, longitude: d.longitude,
      elevationM: d.elevation ?? null, closeToTarget: close(p.latitude, d.latitude) && close(p.longitude, d.longitude) } : null;
  }

  async function gfsRelease(run: string, start: number, end: number, signal: AbortSignal) {
    const initialized = instant(run);
    const first = Math.ceil((start - initialized) / hour);
    const last = Math.ceil((end - initialized) / hour) - 1;
    const hourOfRun = run.slice(11, 13);
    if (!['00','06','12','18'].includes(hourOfRun) || first < 0 || last > 120 || last < first) return;
    const prefix = `gfs.${run.slice(0, 10).replaceAll('-', '')}/${hourOfRun}/atmos/gfs.t${hourOfRun}z.pgrb2.0p25.f`;
    const url = forecastURL(sourceSetting('PM_NOAA_GFS_URL') + '/', { 'list-type': '2', prefix, 'max-keys': '400' });
    let raw = '', issue: string | undefined;
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal,AbortSignal.timeout(12_000)]) });
      raw = (await officialBody(response)).toString('utf8');
    } catch (e) {
      signal.throwIfAborted();
      issue = e instanceof Error ? e.message : String(e);
    }
    const stamps = new Map<number, string>();
    for (const row of raw.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(row[1])?.[1];
      const stamp = /<LastModified>([^<]+)<\/LastModified>/.exec(row[1])?.[1];
      if (!key?.startsWith(prefix) || !/^\d{3}$/.test(key.slice(prefix.length)) || !stamp || !(instant(stamp) >= initialized)) continue;
      const lead = +key.slice(prefix.length);
      if (lead >= first && lead <= last) stamps.set(lead, iso(instant(stamp)));
    }
    const published = stamps.size === last - first + 1 ? [...stamps.values()].sort().at(-1) ?? null : null;
    const proof = { kind: 'weather_forecast_publication', model: 'NOAA GFS 0.25°', run, expectedHours: last - first + 1,
      coveredHours: stamps.size, publishedAt: published, raw, issue };
    const entry = saveEvidence(db, url, proof);
    return { ...proof, raw: undefined, source: url, evidenceId: entry.evidenceId };
  }

  // Precipitation/snow/wave series carry their published interval end timestamps.
  function series(source: Saved, section: string, start: number, end: number, step: number) {
    const doc = source.data.response?.[section] as WeatherRow | undefined;
    const units = source.data.response?.[section + '_units'] ?? {};
    const rows: { validAt: string; intervalFrom: string; values: Record<string, number | null> }[] = [];
    if (Array.isArray(doc?.time)) {
      for (const [i, value] of doc.time.entries()) {
        const at = typeof value === 'number' ? value * 1000 : Date.parse(value + 'Z');
        if (!(at >= start && at <= end)) continue;
        const values = Object.fromEntries(Object.entries(doc).flatMap(([k, v]) => k !== 'time' && Array.isArray(v) ?
          [[k, finite(v[i]) ? v[i] : null]] : []));
        rows.push({ validAt: iso(at), intervalFrom: iso(at - step * 60_000), values });
      }
    }
    const content = rows.filter(r => Object.values(r.values).some(finite));
    const expected = Math.floor(end / (step * 60_000)) - Math.ceil(start / (step * 60_000)) + 1;
    return { stepMinutes: step, units, rows, coverage: content.length >= expected && expected > 0 ? 'covered'
      : content.length ? 'partial' : source.data.status === 'failed' ? 'failed' : 'pending',
      coveredFrom: content[0]?.validAt ?? null, coveredThrough: content.at(-1)?.validAt ?? null, expected };
  }

  async function observedRain(p: Place, start: number, end: number, signal: AbortSignal) {
    const point = await read(`${sourceSetting('PM_NWS_URL')}/points/${p.latitude},${p.longitude}`, signal);
    const sources = [point];
    const url = point.data.response?.properties?.observationStations;
    const unavailable = { sources, windows: [] as { at: string; mm: number }[], ...obsField(undefined, false, 'mm') };
    if (typeof url !== 'string' || !/^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3}\/\d+,\d+\/stations$/.test(url)) return unavailable;
    const stations = await read(url, signal);
    sources.push(stations);
    const id = stations.data.response?.features?.[0]?.properties?.stationIdentifier;
    if (typeof id !== 'string' || !/^[A-Z][A-Z0-9]{3,7}$/.test(id)) return unavailable;
    const readings = await read(forecastURL(sourceSetting('PM_NWS_URL') + '/stations/' + id + '/observations',
      { start: iso(start), end: iso(end), limit: '100' }), signal);
    sources.push(readings);
    const byBucket = new Map<number, { at: string; mm: number }>();
    for (const row of (readings.data.response?.features ?? []) as WeatherRow[]) {
      const at = instant(row.properties?.timestamp);
      const data = row.properties?.precipitationLastHour;
      const h = Math.ceil(at / hour) * hour;
      if (h - hour < start || h > end || data?.unitCode !== 'wmoUnit:mm' || !finite(data.value) ||
          String(row.properties?.station).split('/').at(-1) !== id || at - Math.floor(at / hour) * hour < 45 * 60_000) continue;
      const old = byBucket.get(h);
      if (!old || at > instant(old.at)) byBucket.set(h, { at: iso(at), mm: data.value });
    }
    const windows = [...byBucket.values()].sort((a, b) => a.at.localeCompare(b.at));
    const expected = Math.floor((end - start) / hour);
    const coverage = expected > 0 && windows.length === expected && !readings.data.response?.pagination?.next;
    return { sources, station: id, windows, expected, ...obsField(rounded(windows.reduce((s, r) => s + r.mm, 0)), coverage, 'mm') };
  }

  async function alerts(place: Place, q: LocationQuery, asOf: number, signal: AbortSignal) {
    const live = !q.as_of && !q.alert_urls?.length && !q.replay_evidence_ids?.length;
    const sources: Saved[] = [];
    if (live) sources.push(...await Promise.all([
      read(`${sourceSetting('PM_NWS_URL')}/alerts/active?point=${place.latitude},${place.longitude}`, signal),
      read(forecastURL(sourceSetting('PM_NWS_URL') + '/alerts', { point: `${place.latitude},${place.longitude}`,
        start: iso(asOf - 48 * hour), limit: '30' }), signal),
    ]));
    const isAlert = (source: string) => /^https:\/\/api\.weather\.gov\/alerts\/urn:(?:oid|uuid):[A-Za-z0-9.-]+$/.test(source);
    for (const url of q.alert_urls ?? []) {
      if (!isAlert(url)) throw Error('警报档案只接受 NWS 官方 CAP 标识 URL。');
      sources.push(await read(url, signal));
    }
    for (const id of q.replay_evidence_ids ?? []) {
      const row = load(id) as Saved | undefined;
      if (!row || row.data.kind !== 'weather_location_source' || !isAlert(row.source)) throw Error('需要匹配的 NWS 官方警报证据。');
      sources.push(row);
    }
    const point = live ? undefined : await read(`${sourceSetting('PM_NWS_URL')}/points/${place.latitude},${place.longitude}`, signal);
    const zones = ['county','forecastZone','fireWeatherZone'].map(k => point?.data.response?.properties?.[k]).filter(Boolean);
    const warnings = sources.flatMap(source => {
      const d = source.data.response;
      return ((d?.features ?? (d?.properties ? [d] : [])) as WeatherRow[]).flatMap(feature => {
        const p = feature.properties;
        if (!p || p.status !== 'Actual' || !(instant(p.sent) <= asOf) ||
            q.alert_events?.length && !q.alert_events.includes(p.event) ||
            q.alert_severities?.length && !q.alert_severities.includes(p.severity)) return [];
        if (!live && !inAlert(feature.geometry, place) && !(p.affectedZones as string[] | undefined)?.some(zone => zones.includes(zone))) return [];
        const id = p.id ?? alertReference(feature.id);
        if (!id) return [];
        return [{ id, version: alertVersion(p), messageType: p.messageType, event: p.event, severity: p.severity,
          sender: p.senderName, sent: p.sent, effective: p.effective, onset: p.onset, expires: p.expires, ends: p.ends,
          area: p.areaDesc, headline: p.headline, status: p.messageType === 'Cancel' ? 'cancelled'
            : instant(p.expires) <= asOf ? 'expired' : 'active', evidenceId: source.evidenceId,
          links: [`${sourceSetting('PM_NWS_URL')}/alerts/${id}`], references: (p.references ?? []).map((r: WeatherRow) => r.identifier),
          applicability: live ? 'official_point_filter' : inAlert(feature.geometry, place) ? 'cap_polygon' : 'official_zone' }];
      });
    });
    const liveComplete = live && sources.every(s => s.data.status === 'ok' && !s.data.response?.pagination?.next);
    return { place, live, warnings: [...new Map(warnings.map(w => [w.version, w])).values()].sort((a, b) => a.sent.localeCompare(b.sent)),
      coverage: liveComplete ? 'covered' : warnings.length ? 'partial' : sources.length ? 'pending' : 'unsupported',
      sources: [...sources, ...(point ? [point] : [])] };
  }

  async function personal(place: Place, q: LocationQuery, start: number, end: number, signal: AbortSignal) {
    const models = q.models?.length ? [...new Set(q.models)] : ['best_match'];
    if (models.length > 3 || models.some(m => !weatherModels.includes(m))) throw Error('天气模型超出已接入的提供方范围。');
    const needAir = q.conditions?.some(c => ['us_aqi','european_aqi','grass_pollen'].includes(c.metric));
    const marine = q.activity === 'sail' || q.conditions?.some(c => c.metric === 'wave_m');
    const observedHours = Math.max(0, ...q.conditions?.filter(c => c.metric === 'observed_rain_mm').map(c => c.hours ?? 24) ?? []);
    const nowHour = Math.floor(Date.now() / hour) * hour;
    const [forecasts, ocean, air, observation] = await Promise.all([
      Promise.all(models.map(model => forecast(place, start, end, model, signal))),
      marine ? read(meteo(sourceSetting('PM_OPEN_METEO_MARINE_URL') + '/v1/marine', place,
        { hourly: 'wave_height,wave_period,swell_wave_height', cell_selection: 'sea', start_date: iso(start).slice(0, 10), end_date: iso(end).slice(0,10) }), signal) : undefined,
      needAir ? read(meteo(sourceSetting('PM_OPEN_METEO_AIR_URL') + '/v1/air-quality', place,
        { hourly: 'us_aqi,european_aqi,grass_pollen', start_date: iso(start).slice(0, 10), end_date: iso(end).slice(0, 10) }), signal) : undefined,
      observedHours ? observedRain(place, nowHour - observedHours * hour, nowHour, signal) : undefined,
    ]);
    const selected = forecasts[0];
    const timeZone = place.timeZone ?? selected.source.data.response?.timezone ?? null;
    const display = typeof timeZone === 'string' ? new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }) : null;
    const localAt = (at: string) => display ? display.format(instant(at)) : null;
    const timeWindow = (from: string, to: string) => ({ from, to, fromLocal: localAt(from), toLocal: localAt(to) });
    const marineGrid = ocean && grid(ocean, place);
    const wave = ocean && marineGrid?.closeToTarget ? series(ocean, 'hourly', start, end, 60) : undefined;
    const airQuality = air && series(air, 'hourly', start, end, 60);
    const samples = selected.minutely15.rows.some(r => finite(r.values.precipitation)) ? selected.minutely15 : selected.hourly;
    const rain = samples.rows.filter(row => finite(row.values.rain) && finite(row.values.showers)).map(row => ({
      from: row.intervalFrom, to: row.validAt, mm: rounded(row.values.rain! + row.values.showers!) }));
    const whollyInWindow = rain.filter(row => instant(row.from) >= start);
    const rainStep = samples.stepMinutes * 60_000;
    const expectedRain = Math.floor(end / rainStep) - Math.ceil(start / rainStep);
    const rainCoverage = whollyInWindow.length > 0 && whollyInWindow.length === expectedRain ? 'covered'
      : whollyInWindow.length ? 'partial' : 'pending';
    const wet: { from: string; to: string; totalMm: number; maxMmPerHour: number }[] = [];
    for (const r of rain.filter(r => r.mm > 0 && instant(r.from) >= start)) {
      const intensity = rounded(r.mm * 60 / samples.stepMinutes);
      const last = wet.at(-1);
      if (last?.to === r.from) {
        last.to = r.to;
        last.totalMm = rounded(last.totalMm + r.mm);
        last.maxMmPerHour = Math.max(last.maxMmPerHour, intensity);
      } else wet.push({ from: r.from, to: r.to, totalMm: r.mm, maxMmPerHour: intensity });
    }
    const dry: { from: string; to: string }[] = [];
    for (const r of whollyInWindow.filter(r => r.mm === 0)) {
      const last = dry.at(-1);
      if (last?.to === r.from) last.to = r.to;
      else dry.push({ from: r.from, to: r.to });
    }
    const perHour = 60 / samples.stepMinutes;
    const leastRainHours = whollyInWindow.flatMap((r,i) => {
      const rows = whollyInWindow.slice(i,i + perHour);
      const last = rows.at(-1);
      if (rows.length !== perHour || !last || instant(last.to) - instant(r.from) !== hour) return [];
      return [{ ...timeWindow(r.from,last.to), totalMm: rounded(rows.reduce((sum,row) => sum + row.mm,0)),
        maxMmPerHour: rounded(Math.max(...rows.map(row => row.mm))*perHour) }];
    }).sort((a,b) => a.totalMm - b.totalMm || a.maxMmPerHour - b.maxMmPerHour || a.from.localeCompare(b.from)).slice(0,3);
    const conditions = q.conditions ?? [];
    const approved = conditions.map(c => {
      const pairs = { temperature_c: 'temperature_2m', relative_humidity_pct: 'relative_humidity_2m',
        wind_kmh: 'wind_speed_10m', gust_kmh: 'wind_gusts_10m', snowfall_cm: 'snowfall', wave_m: 'wave_height',
        us_aqi: 'us_aqi', european_aqi: 'european_aqi', grass_pollen: 'grass_pollen' };
      const to = Math.min(end, start + (c.hours ?? (end - start) / hour) * hour);
      let value: number | null, unit: string;
      if (c.metric === 'observed_rain_mm') {
        const span = (c.hours ?? 24) * hour;
        const readings = observation?.windows.filter(r => instant(r.at) >= nowHour - span) ?? [];
        value = readings.length === span / hour ? rounded(readings.reduce((sum,r) => sum + r.mm, 0)) : null;
        unit = 'mm';
      } else if (c.metric === 'forecast_rain_mm') {
        const selectedRain = rain.filter(r => instant(r.from) >= start && instant(r.to) <= to);
        const needed = Math.floor(to / (samples.stepMinutes * 60_000)) - Math.ceil(start / (samples.stepMinutes * 60_000));
        value = selected.grid?.closeToTarget && needed > 0 && selectedRain.length === needed ?
          rounded(selectedRain.reduce((sum,r) => sum + r.mm, 0)) : null;
        unit = 'mm';
      } else {
        const field = pairs[c.metric];
        const src = c.metric === 'wave_m' ? wave : c.metric.endsWith('aqi') || c.metric === 'grass_pollen' ? airQuality :
          selected.grid?.closeToTarget ? selected.hourly : undefined;
        const rows = src?.rows.filter(row => instant(row.validAt) >= start && instant(row.validAt) <= to) ?? [];
        const expected = Math.floor(to / hour) - Math.ceil(start / hour) + 1;
        const v = rows.map(row => row.values[field]).filter(finite);
        value = v.length && expected === v.length ? Math.max(...v) : null;
        unit = src?.units[field] ?? 'unknown';
      }
      return { ...c, measured: value, unit, state: value === null ? 'unknown' : meets(value,c) ? 'met' : 'not_met',
        interval: c.metric === 'observed_rain_mm' ? { from: iso(nowHour - (c.hours ?? 24) * hour), to: iso(nowHour) } : { from: iso(start), to: iso(to) } };
    });
    const windows = selected.hourly.rows.map(r => {
      const m = wave?.rows.find(w => w.validAt === r.validAt);
      const values = { ...r.values, ...m?.values };
      const limits = conditions.filter(c => ['temperature_c','wind_kmh','gust_kmh','wave_m','snowfall_cm','relative_humidity_pct'].includes(c.metric));
      const fields: Record<string, string> = { temperature_c: 'temperature_2m', wind_kmh: 'wind_speed_10m', gust_kmh: 'wind_gusts_10m',
        snowfall_cm: 'snowfall', wave_m: 'wave_height', relative_humidity_pct: 'relative_humidity_2m' };
      const checks = limits.map(c => finite(values[fields[c.metric]]) ? meets(values[fields[c.metric]]!, c) : null);
      return { ...r, values, state: checks.includes(null) ? 'unknown' : checks.length ? checks.every(Boolean) ? 'met' : 'not_met' : 'no_threshold' };
    });
    const sources = [...forecasts.map(f => f.source), ...[ocean, air].filter((entry): entry is Saved => !!entry), ...observation?.sources ?? []];
    return { place, activity: q.activity, coverage: selected.grid?.closeToTarget ? selected.hourly.coverage : 'partial',
      timeZone, window: timeWindow(iso(start),iso(end)),
      forecasts: forecasts.map(f => ({ ...f, source: reference(f.source) })), marine: wave && { ...wave, grid: marineGrid }, airQuality,
      rain: { kind: 'model_forecast', wet: wet.map(r => ({ ...r, ...timeWindow(r.from,r.to) })),
        dry: dry.map(r => timeWindow(r.from,r.to)), leastRainHours,
        mm: whollyInWindow.length ? rounded(whollyInWindow.reduce((sum,r) => sum + r.mm,0)) : null,
        stepMinutes: samples.stepMinutes, interpolation: samples.stepMinutes === 15 ? 'regional_model_or_hourly_interpolation' : 'hourly',
        coveredIntervals: whollyInWindow.length, expectedIntervals: expectedRain, coverage: rainCoverage },
      observedRain: observation && { ...observation, sources: observation.sources.map(reference) },
      conditions: approved, conditionState: !approved.length || approved.some(c => c.state === 'unknown') ? 'unknown'
        : approved.every(c => c.state === 'met') ? 'met' : 'not_met', windows, sources };
  }

  const reference = ({ data, ...row }: Saved) => ({ ...row, status: data.status, httpStatus: data.httpStatus, error: data.error });
  async function inspect(q: LocationQuery, signal: AbortSignal) {
    if (!q.locations.length || q.locations.length > 8 || (q.conditions?.length ?? 0) > 12 ||
        (q.alert_urls?.length ?? 0) > 20 || (q.replay_evidence_ids?.length ?? 0) > 20 ||
        q.conditions?.some(c => !finite(c.value) || c.hours !== undefined && (!Number.isInteger(c.hours) || c.hours < 1 || c.hours > 48)))
      throw Error('地点、时间窗或条件超出本次可读取范围。');
    const asOf = q.as_of ? instant(q.as_of) : Date.now();
    if (!Number.isFinite(asOf) || asOf > Date.now()) throw Error('历史截点必须明确时区且已发生。');
    const start = q.start ? instant(q.start) : Math.ceil(asOf / (15 * 60_000)) * 15 * 60_000;
    const end = q.end ? instant(q.end) : start + 24 * hour;
    if (!(end > start && end - start <= 7 * 24 * hour)) throw Error('需要带时区且最多七天的有效起止。');
    if (q.as_of && q.query_type !== 'alerts') throw Error('历史预报请用 forecast_history 指定同一目标和运行版本。');
    const resolved = await Promise.all(q.locations.map(p => locate(p, signal)));
    const places = resolved.map(r => r.place);
    const readings = [];
    for (const place of places) {
      if (place) readings.push(await (q.query_type === 'alerts' ? alerts(place, q, asOf, signal) : personal(place, q, start, end, signal)));
    }
    const raw = readings.flatMap(r => r.sources).concat(resolved.flatMap(r => r.evidence ?? []));
    const locations = readings.map(({ sources, ...row }) => ({ ...row, sources: sources.map(reference) }));
    const mode = q.as_of || q.replay_evidence_ids?.length ? 'historical_replay' : q.alert_urls?.length ? 'official_archive' : 'live';
    const payload = { kind: 'weather_location_check', queryType: q.query_type, mode, asOf: iso(asOf), window: { from: iso(start), to: iso(end), timeZone: 'UTC' },
      locations, unresolved: resolved.flatMap((r, i) => !r.place ? [{ input: q.locations[i], candidates: r.candidates, evidenceId: r.evidence?.evidenceId }] : []),
      inputs: raw.map(reference), inputEvidenceIds: raw.map(r => r.evidenceId) };
    const result = saveEvidence(db, ns, payload);
    const canWatch = mode === 'live' && places.every(Boolean) && (q.query_type === 'alerts' || q.conditions?.length);
    const watch = canWatch ? prepare({ ...q, locations: places.map(p => ({ name: p!.label, latitude: p!.latitude,
      longitude: p!.longitude, country_code: p!.countryCode })) }) : { status: 'unsupported' };
    return { ...payload, evidenceId: result.evidenceId, watch };
  }

  async function stationForecast(place: Place, start: number, end: number, asOf: number, models: string[], runs: string[],
      signal: AbortSignal, ensemble?: string, temperatureDesk = false) {
    if (!(end > start && end - start <= 48 * hour) || models.length > 3 || models.some(m => !weatherModels.includes(m)) || runs.length > 4)
      throw Error('站点预报需已支持模型和不超过 48 小时的目标窗。');
    const runTimes = runs.map(r => instant(r));
    if (runs.length && runTimes.some(r => !Number.isFinite(r) || r > asOf || r >= end)) throw Error('历史模式初始化时间必须早于截点及目标结束时间。');
    const records = await Promise.all((runs.length ? runTimes.map(at => [models[0] ?? 'ecmwf_ifs', iso(at)] as const)
      : (models.length ? models : ['best_match']).map(m => [m, undefined] as const)).map(([m,r]) =>
      forecast(place, start, end - 1, m, signal, r, temperatureDesk)));
    const releases = await Promise.all(records.map(r => r.model === 'gfs_global' && r.modelInitializedAt
      ? gfsRelease(r.modelInitializedAt, start, end, signal) : undefined));
    const distribution = ensemble && !runs.length ? await read(meteo(sourceSetting('PM_OPEN_METEO_ENSEMBLE_URL') + '/v1/ensemble', place,
      { hourly: 'temperature_2m', models: ensemble, timeformat: 'unixtime', start_date: iso(start).slice(0,10), end_date: iso(end - 1).slice(0,10) }), signal) : undefined;
    const seriesByModel = records.map((r, i) => {
      const valid = r.hourly.rows.filter(row => finite(row.values.temperature_2m));
      const peak = valid.length ? Math.max(...valid.map(row => row.values.temperature_2m!)) : null;
      const release = releases[i];
      return { ...r, source: reference(r.source), peakC: peak, peakAt: valid.filter(row => row.values.temperature_2m === peak).map(row => row.validAt),
        temperatureCoverage: r.hourly.coverage === 'covered' && valid.length === r.hourly.expected &&
          valid.every((row, index) => instant(row.validAt) === (Math.ceil(start / hour) + index) * hour)
          ? 'covered' : valid.length ? 'partial' : r.hourly.coverage,
        leadHours: r.modelInitializedAt ? (start - instant(r.modelInitializedAt)) / hour : null,
        publishedAt: release?.publishedAt ?? null, publicationEvidence: release,
        availableAtCutoff: r.modelInitializedAt ? Boolean(instant(r.source.retrievedAt) <= asOf ||
          release?.publishedAt && instant(release.publishedAt) <= asOf) : null };
    });
    const e = distribution && series(distribution,'hourly',start,end - 1,60);
    const keys = Object.keys(e?.rows[0]?.values ?? {}).filter(k => /^temperature_2m_member\d+$/.test(k) ||
      !temperatureDesk && k === 'temperature_2m');
    function peaks(window: typeof e, from: number) {
      const first = Math.ceil(from / hour) * hour;
      if (!window?.expected || window.rows.length !== window.expected ||
          !window.rows.every((row, i) => instant(row.validAt) === first + i * hour)) return [];
      return keys.flatMap(k => window.rows.every(row => finite(row.values[k]))
        ? [Math.max(...window.rows.map(row => row.values[k]!))] : []);
    }
    const memberPeaks = peaks(e, start);
    const remainingFrom = Math.max(start, asOf);
    const remaining = temperatureDesk && distribution && remainingFrom < end
      ? series(distribution, 'hourly', remainingFrom, end - 1, 60) : undefined;
    return { place, target: { from: iso(start), to: iso(end) }, records: seriesByModel, modelNames: models,
      ensemble: distribution && { source: reference(distribution), model: ensemble, memberPeaks, samples: memberPeaks.length,
        expectedHours: e?.expected, coverage: e?.coverage, grid: grid(distribution,place), publishedAt: null, calibration: 'not_evaluated',
        selectedColumns: keys.length, sampleBasis: temperatureDesk ? 'perturbed_members' : 'control_and_perturbed_members',
        ...(temperatureDesk ? { remaining: { from: iso(remainingFrom), expectedHours: remaining?.expected ?? 0,
          memberPeaks: peaks(remaining, remainingFrom) } } : {}) },
      inputEvidenceIds: [...records.map(r => r.source.evidenceId), ...releases.flatMap(r => r?.evidenceId ?? []),
        ...(distribution ? [distribution.evidenceId] : [])] };
  }

  function prepare(q: WeatherTaskQuery) {
    const draft = saveEvidence(db, ns + '/draft', { kind: 'weather_location_draft', q });
    return { status: 'available', weather_location_evidence_id: draft.evidenceId,
      minIntervalSeconds: q.query_type === 'discover' ? 180 : 60 };
  }

  function draft(id: string) {
    const entry = load(id)?.data as { kind?: string; q?: WeatherTaskQuery } | undefined;
    if (entry?.kind !== 'weather_location_draft' || !entry.q) throw Error('需要实时天气条件或警报的已核对凭据。');
    return { kind: 'weather_location_watch' as const, q: entry.q, draftId: id };
  }

  async function run(watch: Watch, config: ReturnType<typeof draft>, runId: string, occurrence: string, signal: AbortSignal) {
    const q = config.q;
    const outside = q.query_type === 'discover' || q.query_type === 'market_ticker' ? await external(q, signal) : undefined;
    const result = q.query_type === 'discover' || q.query_type === 'market_ticker' ? undefined : await inspect(q, signal);
    const key = digest(config.q);
    const saved = db.prepare(`SELECT result FROM runs WHERE watch_id=? AND
      json_extract(result,'$.configKey')=? AND json_extract(result,'$.hasBaseline')=1
      AND status IN ('complete','partial') ORDER BY rowid DESC LIMIT 1`).get(watch.id,key);
    const previous = saved ? JSON.parse(String(saved.result)).state as Record<string, string> : undefined;
    const state = { ...previous };
    const changes: { id: string; text: string }[] = [];
    if (outside?.covered) {
      for (const fact of outside.facts) {
        if (state[fact.key] === fact.value) continue;
        if (previous && fact.text) changes.push({ id: digest(key, fact.key, fact.value),
          text: [watch.goal, fact.text, `证据 ${outside.evidenceId}`].join('\n') });
        state[fact.key] = fact.value;
      }
    }
    for (const row of result?.locations ?? []) {
      if ('warnings' in row) {
        if (row.coverage !== 'covered') continue;
        for (const a of row.warnings) {
          if (state[a.id] === a.version) continue;
          if (previous) changes.push({ id: digest(key,a.version), text: [watch.goal, row.place.label, `官方警报 ${a.event} / ${a.severity} / ${a.messageType}`,
            a.sender, a.area, `发布时间 ${a.sent}　失效 ${a.expires}`, ...a.links, `证据 ${a.evidenceId}`].join('\n') });
          state[a.id] = a.version;
        }
      } else if (row.conditionState !== 'unknown') {
        const old = state[row.place.id];
        state[row.place.id] = row.conditionState;
        if (row.conditionState === 'met' && old === 'not_met') changes.push({ id: digest(key,row.place.id,
          row.conditions.map(c => [c.metric,c.state,c.measured,c.interval.from])), text: [watch.goal,row.place.label,'个人天气条件成立',
          ...row.conditions.map(c => `${c.metric} ${c.measured} ${c.unit} ${c.op} ${c.value}`),
          ...row.sources.map(s => s.source), `证据 ${result!.evidenceId}`].join('\n') });
      }
    }
    signal.throwIfAborted();
    const endedAt = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getWatch(db, watch.id);
      if (current.status !== 'active' || current.version !== watch.version || current.expires_at <= endedAt) throw Error('天气任务状态或版本已变化。');
      const notices = [];
      for (const change of changes) {
        const id = digest(watch.id,change.id);
        const body = { kind: 'market_watch_notice', deliveryKey: id, text: change.text };
        if (db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
          .run(id,watch.id,runId,id,JSON.stringify(body),endedAt).changes) notices.push(id);
      }
      const covered = outside?.covered ?? (!!result?.locations.length &&
        result.locations.every(row => 'warnings' in row ? row.coverage === 'covered' : row.conditionState !== 'unknown'));
      const status = covered && !result?.unresolved.length ? 'complete' : 'partial';
      const evidenceId = outside?.evidenceId ?? result!.evidenceId;
      db.prepare('INSERT OR REPLACE INTO coverage VALUES (?,?,?,?,?)')
        .run(runId,'weather_location',evidenceId,status,JSON.stringify({ inputs: outside?.inputEvidenceIds ?? result!.inputEvidenceIds,
          matched: outside?.facts.length ?? result!.locations.length }));
      db.prepare('UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND status=\'running\'')
        .run(status,endedAt,JSON.stringify({ kind: 'weather_location_check', configKey: key, scheduleId: watch.schedule_id, occurrence,
          evidenceId, hasBaseline: Boolean(covered || previous), state, notices }),runId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { inspect, stationForecast, prepare, draft, run };
}

export function locationWatch(watch: Watch) {
  if (watch.market_id !== null) return;
  const config = JSON.parse(watch.notify_when);
  if (config?.kind === 'weather_location_watch') return config as { kind: 'weather_location_watch'; q: WeatherTaskQuery; draftId: string };
}
