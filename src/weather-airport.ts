import { sourceSetting } from './source-config.js';
import { spawn } from 'node:child_process';
import { officialBody } from './market-web-search.js';
import type { WeatherSourceSnapshot } from './weather-market.js';

const minute = 60_000;
const utc = (ms: number) => new Date(ms).toISOString();
const round = (n: number) => Math.round(n * 10) / 10;
const radarUrl = sourceSetting('PM_RAINVIEWER_API_URL') + '/public/weather-maps.json';
const tiles = sourceSetting('PM_RAINVIEWER_TILES_URL');
const himawari = sourceSetting('PM_JMA_URL') + '/bosai/himawari/data/satimg';
const sites: Record<string, { airport?: string; neighbors: string[] }> = {
  RKPK: { neighbors: ['RKPU','RKPS','RKJH','RKTN'] },
  RKSI: { neighbors: ['RKSS','RKSO','RKSG'] },
  HKO: { airport: 'VHHH', neighbors: ['VMMC','ZGSZ'] },
  RJTT: { neighbors: ['RJAA','RJTY','RJTA'] },
  EDDM: { neighbors: ['EDMA','EDMO','ETSI','ETSL'] },
  LEMD: { neighbors: ['LECU','LETO','LEGT'] },
};
export const supportsAirportFactors = (station: string) => Object.hasOwn(sites, station);

type Metar = { icaoId: string; obsTime: number; lat: number; lon: number; temp: number | null;
  wdir: number | 'VRB' | null; wspd: number | null; wgst?: number; wxString?: string;
  clouds?: { cover: string; base?: number }[]; rawOb: string };
type Capture = (url: string, adapter: string, publisher: string, signal: AbortSignal) => Promise<WeatherSourceSnapshot>;
type RadarFrame = { time: number; path: string };
type Sample = { time: number[]; shortwave_radiation: (number | null)[]; direct_radiation: (number | null)[] };
const awcUrl = sourceSetting('PM_AWC_URL') + '/api/data/metar?' + new URLSearchParams({ format: 'json', hours: '2',
  ids: [...new Set(Object.entries(sites).flatMap(([id, s]) => [s.airport ?? id, ...s.neighbors]))].join(',') });

function json<T>(source: WeatherSourceSnapshot): T | undefined {
  try { return JSON.parse(source.data.raw) as T; } catch { return undefined; }
}
function ref(source: WeatherSourceSnapshot) {
  return { evidenceId: source.evidenceId, url: source.source, status: source.data.status };
}
function report(row: Metar) {
  return { station: row.icaoId, at: utc(row.obsTime * 1000), tempC: row.temp, windFromDeg: row.wdir,
    windKt: row.wspd, gustKt: row.wgst ?? null, weather: row.wxString ?? null, clouds: row.clouds ?? [], raw: row.rawOb };
}
function relative(lat: number, lon: number, row: Metar) {
  const north = (row.lat - lat) * 111.2;
  const east = (row.lon - lon) * 111.2 * Math.cos(lat * Math.PI / 180);
  return { distanceKm: round(Math.hypot(north, east)), bearing: (Math.atan2(east, north) * 180 / Math.PI + 360) % 360 };
}

async function raster(url: string, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const png = await officialBody(await fetch(url, { signal: deadline, redirect: 'error' }));
  const pixels = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn('/usr/bin/convert', ['png:-', '-alpha', 'on', '-depth', '8', 'rgba:-'],
      { stdio: ['pipe','pipe','ignore'], signal: deadline });
    const buffers: Buffer[] = [];
    proc.stdout.on('data', b => buffers.push(b));
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(buffers)) : reject(Error('雷达瓦片解码失败')));
    proc.stdin.on('error', reject);
    proc.stdin.end(png);
  });
  if (pixels.length !== 256 * 256 * 4) throw Error('雷达瓦片尺寸不符');
  return { png, pixels };
}

export function createAirportFactors(capture: Capture, saveTile: (url: string, data: unknown) => string) {
  let shared: { at: number; awc: Promise<WeatherSourceSnapshot>; manifest: Promise<WeatherSourceSnapshot>;
    cloudIndex?: Promise<WeatherSourceSnapshot> } | undefined;
  const siteReads = new Map<string, { at: number; result: ReturnType<typeof read> }>();

  async function radar(lat: number, lon: number, manifest: WeatherSourceSnapshot, asOf: number, signal: AbortSignal) {
    const base = { source: ref(manifest), coverageId: undefined as string | undefined, frames: [] as { at: string; url: string; nearestEchoKm: number | null; evidenceId: string }[] };
    const frames = json<{ radar?: { past?: RadarFrame[] } }>(manifest)?.radar?.past ?? [];
    const recent = frames.filter(f => f.time * 1000 <= asOf && f.time * 1000 >= asOf - 40 * minute &&
      /^\/v2\/radar\/[a-z\d_-]+$/i.test(f.path)).sort((a,b) => a.time - b.time).slice(-2);
    const suffix = '/256/7/' + lat.toFixed(6) + '/' + lon.toFixed(6);
    const coverageUrl = tiles + '/v2/coverage/0' + suffix + '/0/0_0.png';
    if (!recent.length) return { ...base, status: 'no_fresh_frames' };
    try {
      const coverage = await raster(coverageUrl, signal);
      const coverageId = saveTile(coverageUrl, { kind: 'weather_radar_coverage', png: coverage.png.toString('base64') });
      if (coverage.pixels[(128 * 256 + 128) * 4 + 3] > 0) return { ...base, coverageId, status: 'outside_coverage' };
      const kmPerPixel = 40_075 * Math.cos(lat * Math.PI / 180) / (256 * 128);
      const measurements = await Promise.all(recent.map(async frame => {
        const url = tiles + frame.path + suffix + '/2/0_0.png';
        const { png, pixels } = await raster(url, signal);
        let nearest = Infinity;
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * 4;
          if (coverage.pixels[i + 3] === 0 && pixels[i + 3] > 0)
            nearest = Math.min(nearest, Math.hypot(x - 128, y - 128) * kmPerPixel);
        }
        const nearestEchoKm = nearest <= 40 ? round(nearest) : null;
        const at = utc(frame.time * 1000);
        const evidenceId = saveTile(url, { kind: 'weather_radar_frame', at, nearestEchoKm, coverageId, png: png.toString('base64') });
        return { at, url, nearestEchoKm, evidenceId };
      }));
      return { ...base, coverageId, status: 'covered', frames: measurements };
    } catch (error) {
      signal.throwIfAborted();
      return { ...base, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function infrared(lat: number, lon: number, asOf: number, signal: AbortSignal) {
    const index = await (shared!.cloudIndex ??= capture(himawari + '/targetTimes_fd.json',
      'jma_himawari_index', 'Japan Meteorological Agency', AbortSignal.timeout(14_000)));
    const frames = json<{ basetime: string; validtime: string }[]>(index) ?? [];
    const candidates = frames.flatMap(f => {
      const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(f.validtime);
      if (!m || !/^\d{14}$/.test(f.basetime)) return [];
      const time = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
      return time <= asOf && asOf - time < 45 * minute ? [{ ...f, time }] : [];
    }).sort((a,b) => b.time - a.time).slice(0, 2);
    const x = Math.floor((lon + 180) / 360 * 32);
    const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) * 16);
    const images = (await Promise.all(candidates.map(async f => {
      const url = `${himawari}/${f.basetime}/fd/${f.validtime}/B13/TBB/5/${x}/${y}.jpg`;
      try {
        const jpg = await officialBody(await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }));
        if (jpg[0] !== 0xff || jpg[1] !== 0xd8) return null;
        const at = utc(f.time);
        const evidenceId = saveTile(url, { kind: 'weather_himawari_infrared', band: 'B13', at, jpg: jpg.toString('base64') });
        return { at, url, evidenceId };
      } catch { signal.throwIfAborted(); return null; }
    }))).filter(image => image !== null);
    return { index: ref(index), images, status: images.length ? 'covered' : 'no_fresh_frames' };
  }

  async function read(station: string, latitude: number, longitude: number, asOf: number, signal: AbortSignal) {
    const site = sites[station];
    const airport = site.airport ?? station;
    const now = Date.now();
    if (!shared || now - shared.at > 3 * minute) {
      const deadline = AbortSignal.timeout(14_000);
      shared = { at: now, awc: capture(awcUrl, 'awc_surface_json', 'NOAA/NWS Aviation Weather Center', deadline),
        manifest: capture(radarUrl, 'weather_radar_index', 'RainViewer radar composite', deadline) };
    }
    const url = sourceSetting('PM_OPEN_METEO_SATELLITE_URL') + '/v1/archive?' + new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), models: 'satellite_radiation_seamless',
      hourly: 'shortwave_radiation,direct_radiation', timeformat: 'unixtime', temporal_resolution: 'native',
      start_date: utc(asOf - 3 * 60 * minute).slice(0,10), end_date: utc(asOf).slice(0,10),
    });
    const [awc, solar, precipitation, cloudImages] = await Promise.all([shared.awc,
      capture(url, 'satellite_irradiance', 'Open-Meteo / JMA-JAXA, EUMETSAT-DWD satellite retrieval', signal),
      shared.manifest.then(m => radar(latitude, longitude, m, asOf, signal)),
      longitude > 90 ? infrared(latitude, longitude, asOf, signal) : null]);
    const rows = (json<Metar[]>(awc) ?? []).filter(r => Number.isFinite(r.obsTime) && r.obsTime * 1000 <= asOf)
      .sort((a,b) => b.obsTime - a.obsTime);
    const local = rows.filter(r => r.icaoId === airport);
    const surface = local.find(r => asOf - r.obsTime * 1000 <= 90 * minute);
    const prior = surface && local.find(r => surface.obsTime - r.obsTime >= 45 * 60 && surface.obsTime - r.obsTime <= 85 * 60);
    const tempChangeC = surface?.temp != null && prior?.temp != null ? round(surface.temp - prior.temp) : null;
    const neighbors = site.neighbors.flatMap(id => {
      const r = rows.find(m => m.icaoId === id && asOf - m.obsTime * 1000 <= 90 * minute && Number.isFinite(m.lat) && Number.isFinite(m.lon));
      if (!r) return [];
      const { distanceKm, bearing } = relative(latitude, longitude, r);
      const upwind = !!surface && typeof surface.wdir === 'number' && (surface.wspd ?? 0) >= 3 &&
        distanceKm <= 85 && Math.abs(r.obsTime - surface.obsTime) <= 45 * 60 &&
        Math.abs((bearing - surface.wdir + 540) % 360 - 180) <= 65;
      return [{ ...report(r), distanceKm, bearing: Math.round(bearing), upwind,
        temperatureDifferenceC: surface?.temp != null && r.temp != null ? round(r.temp - surface.temp) : null }];
    });
    const radiation = json<{ hourly?: Sample }>(solar)?.hourly;
    const clear = radiation?.time.flatMap((t, i) => {
      const w = radiation.shortwave_radiation?.[i];
      return t * 1000 <= asOf && typeof w === 'number' && Number.isFinite(w)
        ? [{ at: utc(t * 1000), shortwaveWm2: w, directWm2: radiation.direct_radiation?.[i] ?? null }] : [];
    }) ?? [];
    const latest = clear.at(-1);
    const fresh = latest && asOf - Date.parse(latest.at) <= 90 * minute ? latest : null;
    const earlier = fresh && clear.findLast(r => Date.parse(fresh.at) - Date.parse(r.at) >= 45 * minute);
    return { asOf: utc(asOf), station, airport, surface: surface ? report(surface) : null,
      previousSurface: prior ? report(prior) : null, tempChangeC, neighbors, metar: ref(awc),
      sunlight: { ...ref(solar), latest: fresh, changeWm2: fresh && earlier && Date.parse(fresh.at) - Date.parse(earlier.at) <= 75 * minute
        ? round(fresh.shortwaveWm2 - earlier.shortwaveWm2) : null },
      radar: precipitation, cloudImages, inputEvidenceIds: [awc.evidenceId, solar.evidenceId, precipitation.source.evidenceId,
        precipitation.coverageId, ...precipitation.frames.map(f => f.evidenceId),
        cloudImages?.index.evidenceId, ...(cloudImages?.images.map(f => f.evidenceId) ?? [])].filter((id): id is string => !!id) };
  }
  return (station: string, latitude: number, longitude: number, asOf: number, signal: AbortSignal) => {
    const cached = siteReads.get(station);
    if (cached && Date.now() - cached.at < 4 * minute) return cached.result;
    const result = read(station, latitude, longitude, asOf, AbortSignal.timeout(25_000));
    const entry = { at: Date.now(), result };
    siteReads.set(station, entry);
    void result.catch(() => { if (siteReads.get(station) === entry) siteReads.delete(station); });
    return signal.aborted ? Promise.reject(signal.reason) : result;
  };
}
