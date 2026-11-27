import { sourceSetting } from './source-config.js';
import { spawn } from 'node:child_process';
import { polymonitorUrl, readMarketData } from './data.js';
import { sportsEventKey, sportsTimestamp, sportsVersion, type SportsAdapter, type SportsCondition,
  type SportsCoverage, type SportsEvidence, type SportsEvent, type SportsEventChange, type SportsFindInput,
  type SportsHost, type SportsInspectInput, type SportsMarket, type SportsSnapshot } from './sports.js';

// Raw NBA, ESPN and PDF data is narrowed to the fields that are saved and used below.
type Json = Record<string, any>;
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const rows = (v: unknown): Json[] => Array.isArray(v) ? v.map(obj) : [];
const str = (v: unknown) => typeof v === 'string' ? v : '';
const num = (v: unknown): number | null => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '')
  && Number.isFinite(Number(v)) ? Number(v) : null;
const normalize = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim();
const nba = sourceSetting('PM_NBA_URL');
const espn = sourceSetting('PM_ESPN_API_URL') + '/apis/site/v2/sports/basketball/nba';
const injuryIndex = nba + '/players/injury-report';
const eastern = 'America/New_York';
const browser = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const compactDate = (date: string) => date.replaceAll('-', '');
const dayIn = (at: string, zone = eastern) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric',
  month: '2-digit', day: '2-digit' }).format(new Date(at));
function localTime(at: string | null, timeZone: string) {
  return at && new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(at));
}
function easternTime(date: string, hour: number, minute: number) {
  const local = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  for (const offset of ['-04:00', '-05:00']) {
    const at = sportsTimestamp(local + offset);
    if (at && localTime(at, eastern) === local.replace('T', ' ')) return at;
  }
  return null;
}

const teamRows = [
  ['ATL', 2737, 'Hawks', '老鹰'], ['BOS', 2738, 'Celtics', '凯尔特人'], ['BKN', 2751, 'Nets', '篮网'],
  ['CHA', 2766, 'Hornets', '黄蜂'], ['CHI', 2741, 'Bulls', '公牛'], ['CLE', 2739, 'Cavaliers', '骑士'],
  ['DAL', 2742, 'Mavericks', '独行侠 小牛'], ['DEN', 2743, 'Nuggets', '掘金'], ['DET', 2765, 'Pistons', '活塞'],
  ['GSW', 2744, 'Warriors', '勇士'], ['HOU', 2745, 'Rockets', '火箭'], ['IND', 2754, 'Pacers', '步行者'],
  ['LAC', 2746, 'Clippers', '快船'], ['LAL', 2747, 'Lakers', '湖人'], ['MEM', 2763, 'Grizzlies', '灰熊'],
  ['MIA', 2748, 'Heat', '热火'], ['MIL', 2749, 'Bucks', '雄鹿'], ['MIN', 2750, 'Timberwolves', '森林狼'],
  ['NOP', 2740, 'Pelicans', '鹈鹕'], ['NYK', 2752, 'Knicks', '尼克斯'], ['OKC', 2760, 'Thunder', '雷霆'],
  ['ORL', 2753, 'Magic', '魔术'], ['PHI', 2755, '76ers', '76人 七六人'], ['PHX', 2756, 'Suns', '太阳'],
  ['POR', 2757, 'Trail Blazers', '开拓者'], ['SAC', 2758, 'Kings', '国王'], ['SAS', 2759, 'Spurs', '马刺'],
  ['TOR', 2761, 'Raptors', '猛龙'], ['UTA', 2762, 'Jazz', '爵士'], ['WAS', 2764, 'Wizards', '奇才'],
] as const;
const teams = teamRows.map(([code, id, name, cn]) => ({ code, id: String(1610610000 + id), name, cn, slug: name === 'Trail Blazers' ? 'blazers' : name.toLowerCase() }));
const teamFor = (code: string) => teams.find(t => t.code === ({ GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', BRK: 'BKN' }[code] ?? code));
const teamMatch = (query: string) => teams.filter(t => normalize(query).split(' ').includes(t.code.toLowerCase()) ||
  (' ' + normalize(query) + ' ').includes(' ' + normalize(t.name) + ' ') || t.cn.split(' ').some(alias => query.includes(alias)));
const playerQuery = (q: string) => /\bsga\b|亚历山大/i.test(q) ? 'Shai Gilgeous-Alexander'
  : /\bgiannis\b|字母哥/i.test(q) ? 'Giannis Antetokounmpo' : q;
const hasPlayerName = (query: string, name: string) => name !== '' &&
  (' ' + normalize(playerQuery(query)) + ' ').includes(' ' + normalize(name) + ' ');

type NbaTeam = { [key: string]: unknown; id: string; name: string; code: string; side: 'away' | 'home' };
type RosterPlayer = { id: string; name: string; teamId: string };
type NbaEvent = SportsEvent<NbaTeam> & { nbaId?: string; espnId?: string; date: string; phase: string;
  startedAt?: string | null; endedAt?: string | null; scheduledState: string; roster?: RosterPlayer[]; rosterEvidence?: string[]; player?: RosterPlayer };
type Source = { evidenceId: string; url: string; provider: 'nba' | 'espn'; version: string; retrievedAt: string; observedAt: string | null; publishedAt?: string | null; versionAt?: string | null };
type Player = RosterPlayer & { starter: boolean | null; played: boolean | null; minutes: string | null;
  rebounds: number | null; points: number | null; assists: number | null; reason?: string };
type Box = { source: Source; state: string; scores: [number | null, number | null]; period: number | null; clock: string | null;
  startedAt: string | null; endedAt: string | null; zone: string | null; players: Player[]; freshness: 'covered' | 'stale' | 'pending' };
type InjuryRow = { teamId: string; player: string; status: string; reason: string; page: number; line: string };
type Report = { source: Source; rows: InjuryRow[]; teams: Record<string, 'submitted' | 'not_submitted'> };
type BookPlayer = { teamId: string; name: string; line: string; played: boolean; rebounds: number | null };
type Book = { source: Source; page: number; players: BookPlayer[]; releaseStatus: 'observed_postgame_version' | 'first_release_unverified' };
type NbaFacts = { ids: { nba?: string; espn?: string }; event: NbaEvent; times: Record<string, unknown>; official: Box | null;
  espn: Box | null; injury: Report | null; historicalInjury: Report[]; gameBook: Book | null;
  versions: { source: Source; state: string; changes: { id: string; name: string; metric: string; before: number; after: number }[] }[];
  lineupClues: { sourceMode: string; source: Source; data: Json } | null; recent: unknown; marketCheck: Check | null };
type NbaSnapshot = SportsSnapshot<NbaFacts>;
type Check = { status: string; binding: 'verified' | 'unverified' | 'mismatch'; rule?: ReboundRule | WinnerRule;
  player?: Player; progress?: string; officialOutcome?: string; candidateOutcome?: string; trigger?: { at: string; basis: string; value: number; source: Source };
  currentBookPlayer?: BookPlayer; reason?: string; evidenceIds?: string[]; freezeStatus?: string };
type WinnerRule = { kind: 'winner'; overtime: true; noResultAt: string | null; noResultRule: string | undefined; quotes: string[] };
type ReboundRule = { kind: 'rebounds'; playerName: string; line: number; liveLine: number | null; overtime: true;
  firstGameBook: boolean; dnpOutcome: 'No' | null; noResultAt: string | null; noResultRule: string | undefined;
  freezeOnTrigger: boolean; correctionCutoff: string | null; quotes: string[] };
const state = (n: unknown, label: string) => /cancel|abandon|postpon|suspend/i.test(label) ? label.toLowerCase().replace(/\s+/g, '_')
  : n === 3 || n === 'post' ? 'final' : n === 2 || n === 'in' ? 'live' : n === 1 || n === 'pre' ? 'scheduled' : 'unknown';
const teamName = (t: Json) => [t.teamCity, t.teamName].filter(Boolean).join(' ');
const gameUrl = (id: string, away?: string, home?: string) => `${nba}/game/${away && home ? away.toLowerCase() + '-vs-' + home.toLowerCase() + '-' : ''}${id}`;
const espnGame = (id: string) => sourceSetting('PM_ESPN_WEB_URL') + '/nba/game/_/gameId/' + id;
const ymd = (s: string) => /^20\d\d-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s));
function officialEvent(card: Json, date?: string): NbaEvent | undefined {
  const id = str(card.gameId);
  const scheduledAt = sportsTimestamp(card.gameTimeUtc ?? card.gameDateTimeUTC ?? card.gameTimeUTC);
  const participants = (['away', 'home'] as const).map(side => {
    const t = obj(card[side + 'Team']);
    const known = teamFor(str(t.teamTricode));
    return { side, id: String(t.teamId ?? ''), code: str(t.teamTricode),
      name: t.teamCity ? teamName(t) : known?.name ?? str(t.teamName) };
  });
  if (!/^\d{10}$/.test(id) || !scheduledAt || participants.some(t => !t.id || !t.code || !t.name)) return;
  return { eventKey: sportsEventKey('nba', 'nba', id), nbaId: id, participants, competition: 'NBA', scheduledAt,
    date: date ?? dayIn(scheduledAt), phase: str(card.gameSubtype || card.gameLabel || card.seasonType),
    sourceUrl: gameUrl(id, participants[0].code, participants[1].code),
    scheduledState: state(card.gameStatus, str(card.gameStatusText)), startedAt: sportsTimestamp(card.actualStartTimeUTC),
    endedAt: sportsTimestamp(card.actualEndTimeUTC) };
}

async function fetchBody(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { 'user-agent': browser, referer: nba + '/', 'cache-control': 'no-cache' } });
  if (!response.ok || !response.body) throw Error(`HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4_000_000) throw Error('响应超出读取上限。');
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), modified: response.headers.get('last-modified'), etag: response.headers.get('etag'),
    responseDate: response.headers.get('date'), age: Number(response.headers.get('age') ?? 0) };
}
async function nbaPage(url: string, signal: AbortSignal) {
  const result = await fetchBody(url, signal);
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(result.body.toString());
  if (!match) throw Error('NBA 页面缺少结构化数据。');
  return { ...result, props: obj(JSON.parse(match[1]).props?.pageProps) };
}
function readPdf(body: Buffer, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', '-', '-'], { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    let text = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      text += chunk;
      if (text.length > 2_000_000) child.kill();
    });
    child.stdin.on('error', reject);
    child.on('error', reject).on('close', code => code ? reject(Error('官方 PDF 无法提取。')) : resolve(text));
    child.stdin.end(body);
  });
}
const httpTime = (v: string | null) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
function reference(evidence: SportsEvidence, provider: Source['provider'], observedAt: string | null,
  version: string, publishedAt?: string | null, url = evidence.source): Source {
  return { evidenceId: evidence.evidenceId, url, provider, observedAt, publishedAt, version, retrievedAt: evidence.retrievedAt };
}
function secondsShown(value: unknown) {
  const s = str(value);
  const duration = /^PT(?:(\d+)M)?(\d+)(?:\.\d+)?S$/.exec(s);
  return duration ? `${duration[1] ?? '0'}:${duration[2].padStart(2, '0')}` : s || null;
}
function minutesPlayed(minutes: string | null) {
  return minutes !== null && /[1-9]/.test(minutes);
}
function nbaPlayer(t: NbaTeam, row: Json, ended: boolean, inactive = false): Player {
  const stats = obj(row.statistics);
  const minutes = str(stats.minutes) || null;
  const starter = ['1', '0', 1, 0, true, false].includes(row.starter) ? ['1', 1, true].includes(row.starter)
    : inactive ? false : str(row.position) && minutesPlayed(minutes) ? true : null;
  const played = inactive ? false : minutesPlayed(minutes) || ['1', 1, true].includes(row.played) ? true
    : minutes || ended && /^DNP|inactive/i.test(str(row.comment)) ? false : null;
  return { id: String(row.personId ?? ''), name: str(row.name) || [row.firstName, row.familyName].filter(Boolean).join(' '),
    teamId: t.id, starter, played, minutes: played === null ? null : secondsShown(minutes),
    rebounds: played === true ? num(stats.reboundsTotal) : null, points: played === true ? num(stats.points) : null,
    assists: played === true ? num(stats.assists) : null, reason: str(row.comment) || undefined };
}
const zones: Record<string, string> = { Eastern: eastern, Central: 'America/Chicago', Mountain: 'America/Denver',
  Pacific: 'America/Los_Angeles', Arizona: 'America/Phoenix', 'US/Eastern': eastern };
function officialBox(evidence: SportsEvidence, event: NbaEvent, asOf: string): Box | null {
  const d = obj(evidence.data), g = obj(d.game);
  if (g.gameId !== event.nbaId || event.participants.some(t => String(obj(g[t.side + 'Team']).teamId) !== t.id)) return null;
  const status = state(g.gameStatus, str(g.gameStatusText));
  const players = event.participants.flatMap(t => {
    const raw = obj(g[t.side + 'Team']);
    const regular = rows(raw.players).map(p => nbaPlayer(t, p, status === 'final'));
    if ((status === 'live' || status === 'final') && regular.filter(p => p.starter === true).length === 5)
      for (const p of regular) p.starter ??= false;
    return [...regular, ...rows(raw.inactives).filter(p => !regular.some(x => x.id === String(p.personId)))
      .map(p => nbaPlayer(t, p, status === 'final', true))];
  }).filter(p => p.id && p.name);
  const last = obj(d.lastPlay);
  const observedAt = sportsTimestamp(last.timeActual);
  const modified = sportsTimestamp(d.modified);
  const box: Box = { source: { ...reference(evidence, 'nba', observedAt, sportsVersion([g.gameStatus, g.period, g.gameClock,
    g.awayTeam?.score, g.homeTeam?.score, players, modified])), versionAt: modified },
    state: status, scores: [num(g.awayTeam?.score), num(g.homeTeam?.score)], period: num(g.period),
    clock: secondsShown(g.gameClock), startedAt: sportsTimestamp(g.actualStartTimeUTC) ?? sportsTimestamp(obj(d.firstPlay).timeActual) ?? event.startedAt ?? null,
    endedAt: status === 'final' ? event.endedAt ?? observedAt : null, zone: zones[str(g.arena?.arenaTimezone)] ?? null,
    players, freshness: status === 'live' && (!observedAt || Date.parse(asOf) - Date.parse(observedAt) > 180_000 ||
      Date.parse(observedAt) > Date.parse(evidence.retrievedAt) + 5000) ? 'stale' : status === 'scheduled' ? 'pending' : 'covered' };
  return box;
}
function espnSchedule(raw: Json): NbaEvent | undefined {
  const c = rows(raw.competitions)[0];
  const participants = c ? rows(c.competitors).map(t => ({ id: String(t.id ?? t.team?.id ?? ''), name: str(t.team?.displayName),
    code: teamFor(str(t.team?.abbreviation))?.code ?? '', side: t.homeAway as 'away' | 'home' })) :
    (['away', 'home'] as const).map((side, i) => ({ side, id: str(raw[side + 'TeamId']), name: str(raw[side + 'Team']),
      code: teamFor(str(raw.name).split(' @ ')[i])?.code ?? '' }));
  participants.sort((a, b) => Number(a.side === 'home') - Number(b.side === 'home'));
  const scheduledAt = sportsTimestamp(raw.date ?? raw.tipoff ?? c?.date);
  const id = str(raw.id);
  if (!/^\d{9,12}$/.test(id) || !scheduledAt || participants.length !== 2 || participants.some(t => !t.code || !t.id || !t.name) ||
    participants[0].side !== 'away' || participants[1].side !== 'home') return;
  return { eventKey: sportsEventKey('nba', 'espn', id), espnId: id, participants, competition: 'NBA', scheduledAt,
    date: dayIn(scheduledAt), phase: str(raw.season?.slug ?? raw.season?.name), sourceUrl: espnGame(id),
    scheduledState: state(raw.state ?? raw.status?.type?.state ?? c?.status?.type?.state, str(typeof raw.status === 'string' ? raw.status : raw.status?.type?.description)) };
}
function sameGame(a: NbaEvent, b: NbaEvent) {
  return a.date === b.date && a.scheduledAt && b.scheduledAt && Math.abs(Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)) <= 120_000 &&
    a.participants.every(t => b.participants.some(p => p.code === t.code && p.side === t.side)) &&
    ['preseason', 'playoffs'].every(phase => !a.phase || !b.phase || normalize(a.phase).includes(phase) === normalize(b.phase).includes(phase));
}
function espnBox(evidence: SportsEvidence, event: NbaEvent, asOf: string): Box | null {
  const d = obj(evidence.data), summary = obj(d.summary), c = rows(summary.header?.competitions)[0];
  if (!c || String(c.id) !== event.espnId || !sameGame(event, espnSchedule({ id: c.id, date: c.date, competitions: [c] }) ?? { ...event, date: '' })) return null;
  const status = state(c.status?.type?.state, str(c.status?.type?.description));
  const teams = rows(c.competitors);
  const players = rows(summary.boxscore?.players).flatMap(team => {
    const mapped = event.participants.find(t => t.code === teamFor(str(team.team?.abbreviation))?.code);
    if (!mapped) return [];
    return rows(team.statistics).flatMap(group => rows(group.athletes).map(p => {
      const get = (key: string) => p.stats?.[group.keys?.indexOf(key) ?? -1];
      const minutes = str(get('minutes')) || null;
      const played = p.didNotPlay === true ? false : minutesPlayed(minutes) ? true : minutes ? false : null;
      return { id: str(p.athlete?.id), name: str(p.athlete?.displayName), teamId: mapped.id,
        starter: typeof p.starter === 'boolean' && status !== 'scheduled' ? p.starter : null, played, minutes,
        rebounds: played ? num(get('rebounds')) : null, points: played ? num(get('points')) : null,
        assists: played ? num(get('assists')) : null, reason: !played ? str(p.reason) || undefined : undefined };
    }));
  }).filter(p => p.id && p.name);
  const observedAt = sportsTimestamp(rows(summary.plays).at(-1)?.wallclock);
  const sourceFetchedAt = sportsTimestamp(d.summaryFetchedAt);
  return { state: status, period: num(c.status?.period), clock: str(c.status?.displayClock) || null,
    scores: (['away', 'home'] as const).map(side => num(teams.find(t => t.homeAway === side)?.score)) as Box['scores'],
    source: reference(evidence, 'espn', observedAt, sportsVersion([status, c.status?.period, c.status?.displayClock, players]),
      null, espnGame(event.espnId!)), players,
    startedAt: sportsTimestamp(rows(summary.plays)[0]?.wallclock), endedAt: status === 'final' ? observedAt : null, zone: null,
    freshness: status === 'scheduled' ? 'pending' : status === 'live' && (d.status === 'stale' ||
      !sourceFetchedAt || !observedAt || Date.parse(asOf) - Date.parse(observedAt) > 180_000 ||
      Date.parse(asOf) - Date.parse(sourceFetchedAt) > 180_000) ? 'stale' : 'covered' };
}

function reportTime(url: string) {
  const m = /^https:\/\/ak-static\.cms\.nba\.com\/referee\/injury\/Injury-Report_(20\d\d-\d\d-\d\d)_(\d\d)_(\d\d)(AM|PM)\.pdf$/.exec(url);
  return m && easternTime(m[1], Number(m[2]) % 12 + (m[4] === 'PM' ? 12 : 0), Number(m[3]));
}
function injuryRows(text: string, event: NbaEvent) {
  const selected: InjuryRow[] = [];
  const submitted: Report['teams'] = {};
  let date = '', pairing = '', teamId = '';
  let last: InjuryRow | undefined;
  const matchup = event.participants.map(t => t.code).join('@');
  for (const [index, page] of text.split('\f').entries()) for (const original of page.split('\n')) {
    const line = original.trim();
    if (!line || /^(Injury Report:|Game Date\s|Page \d)/.test(line)) continue;
    let parts = line.split(/\s{2,}/);
    const d = /^(\d{2})\/(\d{2})\/(20\d\d)$/.exec(parts[0]);
    if (d) { date = `${d[3]}-${d[1]}-${d[2]}`; parts = parts.slice(1); pairing = ''; teamId = ''; last = undefined; }
    if (/^\d{1,2}:\d\d \(ET\)$/.test(parts[0])) parts = parts.slice(1);
    if (/^[A-Z]{2,3}@[A-Z]{2,3}$/.test(parts[0])) {
      pairing = parts.shift()!.split('@').map(x => teamFor(x)?.code ?? x).join('@'); teamId = ''; last = undefined;
    }
    if (date !== event.date || pairing !== matchup) continue;
    const team = event.participants.find(t => parts[0] && parts[0] !== '' &&
      (normalize(parts[0]) === normalize(t.name) || normalize(parts[0]).endsWith(' ' + normalize(teamFor(t.code)?.name ?? t.name))));
    if (team) { teamId = team.id; parts = parts.slice(1); last = undefined; }
    if (!teamId) continue;
    if (parts.some(value => /NOT YET SUBMITTED/i.test(value))) { submitted[teamId] = 'not_submitted'; continue; }
    if (/^(?:NO INJURIES TO REPORT|NONE)$/i.test(parts[0] ?? '')) { submitted[teamId] = 'submitted'; continue; }
    const status = /^(Available|Probable|Questionable|Doubtful|Out)$/i.exec(parts[1] ?? '');
    if (status && parts[0].includes(',')) {
      submitted[teamId] = 'submitted';
      last = { teamId, player: parts[0].split(',').reverse().map(x => x.trim()).join(' '), status: status[1],
        page: index + 1, reason: parts.slice(2).join(' '), line };
      selected.push(last);
    } else if (last && parts.length === 1 && original.search(/\S/) >= 65 && !/^Injury\/Illness -/.test(parts[0])) {
      last.reason = [last.reason, line].filter(Boolean).join(' ');
    }
  }
  return { rows: selected, teams: submitted };
}
function parseBook(text: string, event: NbaEvent) {
  const page = text.split('\f')[0];
  const players: BookPlayer[] = [];
  if (!/OFFICIAL SCORER'S REPORT[\s\S]*FINAL BOX/.test(page)) return;
  let team: NbaTeam | undefined;
  const encountered = new Set<string>();
  for (const line of page.split('\n')) {
    const header = /^(VISITOR|HOME):\s+(.+?)\s+\(/.exec(line);
    if (header) {
      team = event.participants.find(t => t.side === (header[1] === 'HOME' ? 'home' : 'away') &&
        normalize(header[2]).endsWith(normalize(teamFor(t.code)?.name ?? t.name)));
      if (team) encountered.add(team.id);
    }
    if (!team) continue;
    const p = /^\s*\d+\s+(.+?)\s{2,}(?:[FCG](?:-[FCG])?\s+)?(?:(\d+:\d\d)\s+([\d+\-\s]+)|(DNP|DND|NWT|Inactive)\b)/i.exec(line);
    if (p) {
      const values = p[3]?.trim().split(/\s+/);
      players.push({ teamId: team.id, name: p[1].trim(), played: Boolean(p[2]), rebounds: values ? num(values[8]) : null, line: line.trim() });
    }
  }
  if (encountered.size !== 2 || !players.length) return;
  return { page: 1, players };
}
function ruleDate(text: string) {
  const iso = /\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))\b/i.exec(text);
  if (iso) return sportsTimestamp(iso[1]);
  const m = /([A-Za-z]+ \d{1,2}, 20\d\d),?\s+(?:at\s+)?(\d{1,2}):(\d\d)\s*(AM|PM)\s*ET\b/i.exec(text);
  if (!m) return null;
  const parsed = Date.parse(m[1] + ' UTC');
  return Number.isFinite(parsed) ? easternTime(new Date(parsed).toISOString().slice(0, 10),
    Number(m[2]) % 12 + (m[4].toUpperCase() === 'PM' ? 12 : 0), Number(m[3])) : null;
}

export function nbaMarketRule(market: SportsMarket): ReboundRule | WinnerRule | undefined {
  const quotes = market.rules.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!market.resolutionSource || !/^https:\/\/(?:www\.)?nba\.com(?:\/|$)/i.test(market.resolutionSource) ||
      !quotes.some(q => /(?:including (?:all |any )?overtime|all overtime periods)/i.test(q))) return;
  const noResultRule = quotes.find(q => /resolve 50-50/i.test(q));
  const noResultAt = noResultRule ? ruleDate(noResultRule) : null;
  const yes = /resolve to "Yes" if (.+?) records more than (\d+(?:\.\d+)?) total rebounds during the game/i.exec(market.rules);
  if (!yes) {
    if (market.outcomeTokens.length === 2 && market.outcomeTokens.every(t =>
      /\bif the .+? win\b/i.test(market.rules) && market.rules.includes(`will resolve to "${t.label}"`)) &&
      /determined based on the final score/i.test(market.rules))
      return { kind: 'winner', overtime: true, noResultAt, noResultRule, quotes };
    return;
  }
  const no = /resolve to "No" if .+? records (\d+(?:\.\d+)?) rebounds or fewer/i.exec(market.rules);
  const sources = quotes.find(q => /^The resolution source/i.test(q));
  const live = /(?:recording more than|records more than) (\d+(?:\.\d+)?) rebounds during the game, based on the official NBA\.com box score/i.exec(sources ?? '');
  const firstGameBook = /first official game book released by the NBA/i.test(sources ?? '');
  const line = Number(yes[2]);
  if (line !== Number(no?.[1]) || market.outcomeTokens.length !== 2 || !market.outcomeTokens.some(t => t.label === 'Yes') ||
    !market.outcomeTokens.some(t => t.label === 'No') || !firstGameBook ||
    /earlier of/i.test(sources ?? '') && !live || live && (Number(live[1]) < line || !/earlier of/i.test(sources ?? ''))) return;
  const cutoffText = quotes.find(q => /(?:stat(?:istical)? corrections?|adjustments?).*(?:before|after|cutoff|deadline)/i.test(q) && ruleDate(q));
  return { kind: 'rebounds', playerName: yes[1], line, liveLine: live ? Number(live[1]) : null, overtime: true,
    firstGameBook, dnpOutcome: /does not take the court at any point, the market will resolve "No"/i.test(market.rules) ? 'No' : null,
    noResultAt, noResultRule, freezeOnTrigger: /stat corrections after resolution is triggered will not count/i.test(market.rules),
    correctionCutoff: cutoffText ? ruleDate(cutoffText) : null, quotes };
}

function checkMarket(market: SportsMarket, event: NbaEvent, box: Box | null, espn: Box | null, book: Book | null, asOf: string): Check {
  const slug = /^nba-([a-z]+)-([a-z]+)-(20\d\d-\d\d-\d\d)$/.exec(market.eventSlug ?? market.slug);
  const teams = slug && slug.slice(1, 3).map(x => teamFor(x.toUpperCase())?.code);
  const firstParagraph = market.rules.split('\n')[0];
  if (!teams || !market.scheduledAt || (market.eventDate && market.eventDate !== slug?.[3]) || !event.scheduledAt)
    return { status: 'pending', binding: 'unverified', reason: '规则或事件缺少可核对的 NBA 队伍和开赛时间。' };
  if (slug?.[3] !== event.date || !event.participants.every(t => teams.some(code => code === t.code) &&
      normalize(firstParagraph).includes(normalize(teamFor(t.code)?.name ?? t.name))) ||
      Math.abs(Date.parse(event.scheduledAt) - Date.parse(market.scheduledAt)) > 120_000)
    return { status: 'event_mismatch', binding: 'mismatch', reason: '盘口的球队、比赛日期或原计划开赛时间不一致。' };
  const rule = nbaMarketRule(market);
  if (!rule) return { status: 'unsupported', binding: 'verified', reason: '当前规则或来源段落无法解释，见合约原文。' };
  const result: Check = { status: 'pending', binding: 'verified', rule, evidenceIds: [market.evidenceId] };
  const qualifiedBox = box?.freshness === 'covered' ? box : null;
  if (qualifiedBox) result.evidenceIds?.push(qualifiedBox.source.evidenceId);
  if (rule.kind === 'winner' && qualifiedBox?.state === 'final') {
    const [away, home] = qualifiedBox.scores;
    const winner = away !== null && home !== null && away !== home ? event.participants[Number(home > away)] : undefined;
    const option = winner && market.outcomeTokens.find(t => normalize(t.label) === normalize(teamFor(winner.code)?.name ?? winner.name) ||
      normalize(t.label) === normalize(winner.name));
    if (option) return { ...result, status: 'official_confirmed', officialOutcome: option.label };
  }
  if (rule.kind === 'rebounds') {
    const players = box?.players.filter(p => normalize(p.name) === normalize(rule.playerName)) ?? [];
    const player = players.length === 1 ? players[0] : undefined;
    const unofficial = espn?.freshness === 'covered' ? espn.players.filter(p => normalize(p.name) === normalize(rule.playerName)) : [];
    const value = qualifiedBox && player?.played === true ? player.rebounds : null;
    const progress = value ?? (unofficial.length === 1 ? unofficial[0].rebounds : null);
    if (progress !== null && progress > rule.line) result.progress = value !== null ? 'official_box_above_market_line' : 'espn_above_market_line';
    if (player) result.player = player;
    const inTime = !rule.correctionCutoff || Boolean(box && box.source.retrievedAt <= rule.correctionCutoff);
    if (qualifiedBox?.state === 'live' && inTime && value !== null && rule.liveLine !== null && value > rule.liveLine)
      return { ...result, status: 'official_confirmed', officialOutcome: 'Yes',
        trigger: { at: qualifiedBox.source.retrievedAt, basis: 'official_live_box', value, source: qualifiedBox.source } };
    if (qualifiedBox?.state === 'final') {
      const matchingRows = book?.players.filter(p => normalize(p.name) === normalize(rule.playerName) && p.teamId === player?.teamId) ?? [];
      const bookPlayer = matchingRows.length === 1 ? matchingRows[0] : undefined;
      if (book) result.evidenceIds?.push(book.source.evidenceId);
      if (bookPlayer) result.currentBookPlayer = bookPlayer;
      result.candidateOutcome = bookPlayer?.played && bookPlayer.rebounds !== null ? bookPlayer.rebounds > rule.line ? 'Yes' : 'No'
        : player?.played === false && rule.dnpOutcome ? rule.dnpOutcome
        : value !== null ? value > rule.line ? 'Yes' : 'No' : undefined;
      result.freezeStatus = 'first_release_or_prior_live_trigger_unverified';
      result.reason = '当前官方终场资料已读取。需比对首发 Game Book 版本和可能更早的赛中确认。';
      if (rule.correctionCutoff && !inTime) result.freezeStatus = 'no_pre_cutoff_version';
    }
  }
  if (!qualifiedBox) result.reason ??= '缺少该场合格的 NBA 官方比赛记录。';
  if (qualifiedBox && rule.noResultRule &&
    (/cancel/.test(qualifiedBox.state) || rule.noResultAt && asOf >= rule.noResultAt &&
      (/abandon/.test(qualifiedBox.state) || /postpon/.test(qualifiedBox.state) && !qualifiedBox.startedAt))) {
    return { ...result, status: 'pending', candidateOutcome: '50-50', reason: '已观察到规则列出的无结果状态。需要核对弃赛前是否已有决定性统计。' };
  }
  return result;
}

export function createNbaSports(host: SportsHost): SportsAdapter<NbaSnapshot, Baseline> {
  async function source(url: string, signal: AbortSignal, read: () => Promise<unknown>) {
    try {
      return host.saveEvidence(url, await read());
    } catch (error) {
      signal.throwIfAborted();
      return host.saveEvidence(url, { kind: 'nba_source_failure', reason: String(error) });
    }
  }
  async function scoreboard(signal: AbortSignal) {
    const path = '/runtime/sports/nba?limit=20';
    return source(polymonitorUrl + path, signal, async () => (await readMarketData(path, AbortSignal.any([signal, AbortSignal.timeout(6000)]))).data);
  }
  async function day(date: string, signal: AbortSignal) {
    const url = nba + '/games?date=' + date;
    return source(url, signal, async () => {
      const { props } = await nbaPage(url, signal);
      if (props.selectedDate !== date) throw Error('NBA 赛程日期不一致。');
      const cards = rows(props.gameCardFeed?.modules).flatMap(module => rows(module.cards)).map(c => obj(c.cardData))
        .filter(c => c.leagueId === '00')
        .map(({ gameId, gameTimeUtc, gameStatus, gameStatusText, seasonType, seasonYear, gameSubtype, actualStartTimeUTC,
          actualEndTimeUTC, homeTeam, awayTeam, shareUrl }) => ({ gameId, gameTimeUtc, gameStatus, gameStatusText, seasonType, seasonYear,
          gameSubtype, actualStartTimeUTC, actualEndTimeUTC, homeTeam, awayTeam, shareUrl }));
      return { kind: 'nba_schedule', provider: 'nba', date, cards };
    });
  }
  async function nbaBox(id: string, signal: AbortSignal, url = gameUrl(id) + '/box-score') {
    return source(url, signal, async () => {
      const { props, modified, etag } = await nbaPage(url, signal);
      const g = obj(props.game);
      if (g.gameId !== id) throw Error('NBA Box Score 的比赛 ID 不一致。');
      const actions = rows(props.playByPlay?.actions);
      const reduceTeam = (x: Json) => ({ teamId: x.teamId, teamName: x.teamName, teamCity: x.teamCity, teamTricode: x.teamTricode,
        score: x.score, players: rows(x.players).map(({ personId, name, firstName, familyName, position, starter, played, comment, statistics }) =>
          ({ personId, name, firstName, familyName, position, starter, played, comment, statistics: {
            minutes: statistics?.minutes, reboundsTotal: statistics?.reboundsTotal, points: statistics?.points, assists: statistics?.assists,
          } })), inactives: x.inactives });
      return { kind: 'nba_box_raw', provider: 'nba', game: {
        gameId: g.gameId, gameTimeUTC: g.gameTimeUTC, gameStatus: g.gameStatus, gameStatusText: g.gameStatusText, gameCode: g.gameCode,
        gameLabel: g.gameLabel, gameSubtype: g.gameSubtype, period: g.period, gameClock: g.gameClock, arena: g.arena,
        actualStartTimeUTC: g.actualStartTimeUTC, awayTeam: reduceTeam(obj(g.awayTeam)), homeTeam: reduceTeam(obj(g.homeTeam)),
      }, firstPlay: actions[0] ?? null, lastPlay: actions.at(-1) ?? null, modified: httpTime(modified), etag };
    });
  }
  async function teamPage(t: typeof teams[number], signal: AbortSignal) {
    const url = `${nba}/team/${t.id}/${t.slug}`;
    return source(url, signal, async () => {
      const { props } = await nbaPage(url, signal);
      const info = obj(props.team);
      if (String(info.id) !== t.id) throw Error('NBA 球队页面 ID 不一致。');
      const roster = rows(info.roster).filter(p => String(p.TeamID) === t.id && p.PLAYER_ID && typeof p.PLAYER === 'string')
        .map(p => ({ id: String(p.PLAYER_ID), name: p.PLAYER, teamId: t.id }));
      const cards = rows(info.schedule).map(({ gameId, gameDateTimeUTC, gameStatus, gameStatusText, gameSubtype, gameLabel, homeTeam, awayTeam }) =>
        ({ gameId, gameDateTimeUTC, gameStatus, gameStatusText, gameSubtype, gameLabel, homeTeam, awayTeam }));
      return { kind: 'nba_team', teamId: t.id, season: info.scheduleSeason, roster, cards };
    });
  }
  async function espnDay(date: string, signal: AbortSignal) {
    const url = espn + '/scoreboard?dates=' + compactDate(date);
    return source(url, signal, async () => {
      const { body } = await fetchBody(url, signal);
      const events = rows(JSON.parse(body.toString()).events).map(espnSchedule).filter(Boolean);
      return { kind: 'nba_espn_schedule', date, events };
    });
  }
  async function detail(id: string, signal: AbortSignal) {
    const path = '/runtime/sports/nba?gameId=' + id;
    const local = await source(polymonitorUrl + path, signal, async () => {
      const r = await readMarketData(path, AbortSignal.any([signal, AbortSignal.timeout(6000)]));
      const d = obj(r.data), summary = obj(d.summary), plays = rows(summary.plays);
      return { eventId: d.eventId, source: d.source, status: d.status, summaryFetchedAt: d.summaryFetchedAt,
        kind: 'nba_espn_detail', summary: { header: summary.header, boxscore: summary.boxscore, plays: plays.length ? [plays[0], plays.at(-1)] : [] } };
    });
    const d = obj(local.data);
    if (String(rows(d.summary?.header?.competitions)[0]?.id) === id && d.status === 'ok') return [local];
    const url = espn + '/summary?event=' + id;
    const direct = await source(url, signal, async () => {
      const { body, responseDate } = await fetchBody(url, signal);
      const summary = obj(JSON.parse(body.toString())), plays = rows(summary.plays);
      return { kind: 'nba_espn_detail', eventId: id, summaryFetchedAt: httpTime(responseDate), status: 'ok',
        summary: { header: summary.header, boxscore: summary.boxscore, plays: plays.length ? [plays[0], plays.at(-1)] : [] } };
    });
    return [local, direct];
  }
  const rawEvents = (item: SportsEvidence) => {
    const data = obj(item.data);
    if (data.kind === 'nba_espn_schedule') return rows(data.events) as NbaEvent[];
    if (data.kind === 'nba_schedule' || data.kind === 'nba_team') return rows(data.cards)
      .map(card => officialEvent(card, data.date)).filter((e): e is NbaEvent => Boolean(e));
    if (data.kind === 'nba_box_raw') {
      const game = officialEvent(obj(data.game));
      return game ? [game] : [];
    }
    return rows(data.items).map(espnSchedule).filter((e): e is NbaEvent => Boolean(e));
  };

  async function find(input: SportsFindInput, signal: AbortSignal) {
    const query = input.query ?? '';
    const key = input.eventKey?.split(':');
    const match = /^nba-([a-z]+)-([a-z]+)-(20\d\d-\d\d-\d\d)$/.exec(input.market?.eventSlug ?? input.market?.slug ?? '');
    const explicitDate = query.match(/\b20\d\d-\d\d-\d\d\b/)?.[0];
    const dateFromQuery = explicitDate && ymd(explicitDate) ? explicitDate : undefined;
    const date = dateFromQuery ?? (match && ymd(match[3]) ? match[3] : undefined);
    let namedTeams = teamMatch(query);
    const marketTeams = match?.slice(1, 3).map(t => teamFor(t.toUpperCase())).filter((t): t is typeof teams[number] => Boolean(t));
    let evidence = input.sourceEvidence ?? [];
    if (input.mode === 'live') {
      const today = dayIn(input.asOf);
      const primary = [scoreboard(signal)];
      if (key?.[1] === 'nba' && /^\d{10}$/.test(key[2])) primary.push(nbaBox(key[2], signal));
      if (key?.[1] === 'espn' && /^\d{9,12}$/.test(key[2])) primary.push(...(await detail(key[2], signal)).map(e => Promise.resolve(e)));
      if (date) primary.push(day(date, signal), espnDay(date, signal));
      let lookup = marketTeams?.length ? marketTeams : namedTeams;
      if (!lookup.length && query && !date && !key) {
        if (hasPlayerName(query, 'Shai Gilgeous-Alexander')) lookup = [teamFor('OKC')!];
        else if (hasPlayerName(query, 'Giannis Antetokounmpo')) {
          // Current team comes from an official roster match, including after a trade.
          lookup = [teamFor('MIA')!, teamFor('MIL')!];
        } else lookup = teams;
      }
      if (!date && !key && !lookup.length) primary.push(day(today, signal));
      async function readTeams(lookup: typeof teams) {
        const result: SportsEvidence[] = [];
        for (let i = 0; i < lookup.length; i += 6) {
          result.push(...await Promise.all(lookup.slice(i, i + 6).map(t => teamPage(t, signal))));
        }
        return result;
      }
      const [initial, teamSources] = await Promise.all([Promise.all(primary), readTeams(lookup)]);
      evidence = [...initial, ...teamSources];
      if (!namedTeams.length && !date && !key && lookup.length && lookup.length < teams.length &&
          !teamSources.some(e => rows(obj(e.data).roster).some(p => hasPlayerName(query, str(p.name))))) {
        evidence.push(...await readTeams(teams.filter(t => !lookup.includes(t))));
      }
    }

    let events = evidence.flatMap(rawEvents);
    const details = evidence.filter(e => obj(e.data).summary?.header).flatMap(e => {
      const c = rows(obj(e.data).summary?.header?.competitions)[0];
      const found = c && espnSchedule({ id: c.id, date: c.date, competitions: [c] });
      return found ? [found] : [];
    });
    events.push(...details);
    const rosterEvidence = evidence.filter(e => obj(e.data).kind === 'nba_team');
    const roster = rosterEvidence.flatMap(e => rows(obj(e.data).roster) as RosterPlayer[]);
    const named = roster.filter(player => hasPlayerName(query, player.name));
    const distinctPlayers = [...new Map(named.map(p => [p.id, p])).values()];
    if (!namedTeams.length && distinctPlayers.length) namedTeams = teams.filter(t => distinctPlayers.some(p => p.teamId === t.id));
    const latest = new Map<string, NbaEvent>();
    for (const e of events) {
      const prev = latest.get(e.eventKey);
      latest.set(e.eventKey, prev ? { ...e, ...prev, startedAt: prev.startedAt ?? e.startedAt, endedAt: prev.endedAt ?? e.endedAt } : e);
    }
    events = [...latest.values()];
    if (key?.[1] === 'nba' && input.mode === 'live' && !date) {
      const e = latest.get(input.eventKey!);
      if (e) {
        const extra = await Promise.all([day(e.date, signal), espnDay(e.date, signal)]);
        evidence.push(...extra);
        const card = extra.flatMap(rawEvents).find(x => x.eventKey === e.eventKey);
        if (card) Object.assign(e, { startedAt: card.startedAt ?? e.startedAt, endedAt: card.endedAt ?? e.endedAt });
        events.push(...extra.flatMap(rawEvents).filter(x => x.espnId));
      }
    }
    if (key?.[1] === 'espn' && input.mode === 'live' && !date) {
      const e = latest.get(input.eventKey!);
      if (e) { const extra = await day(e.date, signal); evidence.push(extra); events.push(...rawEvents(extra)); }
    }
    const official = events.filter(e => e.nbaId);
    const secondary = events.filter(e => e.espnId);
    const enrich = (event: NbaEvent): NbaEvent => {
      const matched = (event.nbaId ? secondary : official).filter(e => sameGame(e, event));
      const correlated = [...new Map(matched.map(e => [e.eventKey, e])).values()];
      if (correlated.length === 1) event = event.nbaId ? { ...event, espnId: correlated[0].espnId }
        : { ...event, ...correlated[0], eventKey: event.eventKey, espnId: event.espnId };
      const codes = event.participants.map(t => t.code);
      const rosterPlayers = roster.filter(p => event.participants.some(t => t.id === p.teamId));
      return { ...event, scheduledBeijing: localTime(event.scheduledAt, 'Asia/Shanghai'),
        scheduledBeijingWeekday: event.scheduledAt && new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
          weekday: 'long' }).format(new Date(event.scheduledAt)),
        roster: rosterPlayers, rosterEvidence: rosterEvidence.filter(e => codes.some(c => teamFor(c)?.id === obj(e.data).teamId))
        .map(e => e.evidenceId), player: distinctPlayers.length === 1 && rosterPlayers.some(p => p.id === distinctPlayers[0].id) ? distinctPlayers[0] : undefined };
    };
    let candidates = key ? events.filter(e => e.eventKey === input.eventKey).map(enrich) : [
      ...official.map(enrich), ...secondary.filter(e => !official.some(o => sameGame(o, e))).map(enrich),
    ];
    if (!key) {
      const targetTeams = marketTeams?.length ? marketTeams : namedTeams;
      if (targetTeams.length) candidates = candidates.filter(e => targetTeams.every(t => e.participants.some(p => p.code === t.code)));
      if (date) candidates = candidates.filter(e => e.date === date);
      else if (targetTeams.length) {
        const earliest = candidates.filter(e => e.scheduledState === 'scheduled' && e.scheduledAt! >= input.asOf)
          .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];
        if (earliest) candidates = candidates.filter(e => e.scheduledAt === earliest.scheduledAt);
        else candidates = candidates.filter(e => e.scheduledState === 'live');
      }
      if (!date && query && !targetTeams.length && !/nba|篮球/i.test(query)) candidates = [];
      if (marketTeams?.length && namedTeams.some(t => !marketTeams.includes(t))) candidates = [];
      if (query && distinctPlayers.length > 1) candidates = candidates.map(e => ({ ...e, playerCandidates: distinctPlayers }));
    }
    if (input.mode === 'live' && candidates.length === 1 && candidates[0].nbaId && !candidates[0].espnId && !date) {
      const extra = await espnDay(candidates[0].date, signal);
      evidence.push(extra);
      const related = rawEvents(extra).filter(e => sameGame(e, candidates[0]));
      if (related.length === 1) candidates[0] = { ...candidates[0], espnId: related[0].espnId };
    }
    return { candidates: [...new Map(candidates.map(e => [e.eventKey, e])).values()].slice(0, 20),
      coverage: { schedule: candidates.length ? 'covered' : 'pending', officialSchedule: official.length ? 'covered' : 'unavailable',
        playerIdentity: distinctPlayers.length > 1 ? 'partial' : distinctPlayers.length ? 'covered' : 'pending' } as SportsCoverage,
      inputEvidenceIds: evidence.map(e => e.evidenceId) };
  }

  async function reports(event: NbaEvent, asOf: string, historical: boolean, signal: AbortSignal) {
    const index = await source(injuryIndex, signal, async () => {
      const { props } = await nbaPage(injuryIndex, signal);
      const urls = rows(props.injuryReports?.reports).map(r => str(r.url)).filter(url => reportTime(url));
      if (!urls.length) throw Error('NBA 伤病索引未列出可验证版本。');
      return { kind: 'nba_injury_index', urls, latest: sportsTimestamp(props.injuryReports?.lastUpdated) };
    });
    const target = event.date;
    const prior = new Date(Date.parse(target) - 86_400_000).toISOString().slice(0, 10);
    const urls = (obj(index.data).urls ?? []) as string[];
    const eligible = urls.filter(url => url.includes('_' + target + '_') || url.includes('_' + prior + '_'))
      .map(url => ({ url, at: reportTime(url)! })).filter(r => r.at <= asOf)
      .sort((a, b) => b.at.localeCompare(a.at));
    const chosen = eligible.slice(0, historical ? 3 : 1);
    // A historical inquiry also checks the published edition just before tipoff when indexed.
    if (historical && event.scheduledAt) {
      const tipoff = Date.parse(event.scheduledAt);
      for (const hours of [0, 2, 4, 6]) {
        const pre = eligible.find(r => Date.parse(r.at) <= tipoff - hours * 3600_000);
        if (pre && !chosen.some(r => r.url === pre.url)) chosen.push(pre);
      }
    }
    const values = await Promise.all(chosen.map(r => source(r.url, signal, async () => {
      const pdf = await fetchBody(r.url, signal);
      const text = await readPdf(pdf.body, signal);
      const header = /^\s*Injury Report: (\d\d)\/(\d\d)\/(\d\d) (\d\d):(\d\d) (AM|PM)/m.exec(text);
      const publishedAt = header && easternTime(`20${header[3]}-${header[1]}-${header[2]}`,
        Number(header[4]) % 12 + (header[6] === 'PM' ? 12 : 0), Number(header[5]));
      if (!publishedAt || publishedAt !== r.at) throw Error('PDF 页首时刻与官方索引版本不一致。');
      return { kind: 'nba_injury_report', eventKey: event.eventKey, nbaId: event.nbaId, publishedAt,
        modified: httpTime(pdf.modified), etag: pdf.etag, version: sportsVersion(pdf.body.toString('base64')), ...injuryRows(text, event) };
    })));
    return [index, ...values];
  }
  async function gameBook(event: NbaEvent, endedAt: string | null, signal: AbortSignal) {
    const id = compactDate(event.date);
    const url = `${sourceSetting('PM_NBA_STATS_URL')}/pdfs/${id}/${id}_${event.participants.map(t => t.code).join('')}_book.pdf`;
    return source(url, signal, async () => {
      const pdf = await fetchBody(url, signal);
      const parsed = parseBook(await readPdf(pdf.body, signal), event);
      if (!parsed) throw Error('Game Book 的球队或正式技术统计无法核对。');
      const modified = httpTime(pdf.modified);
      return { kind: 'nba_game_book', nbaId: event.nbaId, version: sportsVersion(pdf.body.toString('base64')), modified, etag: pdf.etag,
        releaseStatus: modified && endedAt && modified >= endedAt && Date.parse(modified) - Date.parse(endedAt) <= 15 * 60_000
          ? 'observed_postgame_version' : 'first_release_unverified', ...parsed };
    });
  }

  async function inspect(input: SportsInspectInput, signal: AbortSignal): Promise<NbaSnapshot> {
    const event = input.event as NbaEvent;
    const historical = input.mode === 'live' && input.query !== undefined;
    let evidence = [...input.sourceEvidence ?? []];
    if (input.mode === 'live') {
      const [official, secondary, injuries, intel] = await Promise.all([
        event.nbaId ? nbaBox(event.nbaId, signal, event.sourceUrl + '/box-score') : undefined,
        event.espnId ? detail(event.espnId, signal) : [],
        reports(event, new Date().toISOString(), historical, signal),
        event.espnId && event.scheduledState === 'scheduled' ? source(polymonitorUrl + '/runtime/sports/nba-intel?limit=12', signal, async () => {
          const result = await readMarketData('/runtime/sports/nba-intel?limit=12', AbortSignal.any([signal, AbortSignal.timeout(6000)]));
          return { kind: 'nba_lineup_clues', item: rows(obj(result.data).lineups).find(l => String(l.gameId) === event.espnId) };
        }) : undefined,
      ]);
      evidence.push(...[official, intel].filter((v): v is SportsEvidence => Boolean(v)), ...secondary, ...injuries);
    }
    const freshAsOf = input.mode === 'live' ? new Date().toISOString() : input.asOf;
    const matching = (kind: string) => evidence.filter(e => obj(e.data).kind === kind);
    const officialRows = matching('nba_box_raw').sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt));
    const officialHistory = officialRows.map(e => officialBox(e, event, e.retrievedAt)).filter((v): v is Box => Boolean(v));
    const latestOfficial = officialHistory.at(-1);
    const official = latestOfficial ? officialBox(officialRows.find(e => e.evidenceId === latestOfficial.source.evidenceId)!, event, freshAsOf) : null;
    const espnBoxCandidates = evidence.filter(e => obj(e.data).summary?.header).map(e => espnBox(e, event, freshAsOf))
      .filter((v): v is Box => Boolean(v)).sort((a, b) => Number(b.freshness === 'covered') - Number(a.freshness === 'covered') ||
        (b.source.observedAt ?? '').localeCompare(a.source.observedAt ?? ''));
    const espnReading = espnBoxCandidates[0] ?? null;
    const status = official?.state === 'final' || espnReading?.state === 'final' ? 'final'
      : espnReading?.state === 'live' && official?.state === 'scheduled' ? 'live'
      : official?.state && official.state !== 'unknown' ? official.state : espnReading?.state ?? event.scheduledState;
    const endedAt = official?.endedAt ?? event.endedAt ?? espnReading?.endedAt ?? null;
    if (status === 'final' && event.nbaId && /^\d{10}$/.test(event.nbaId) && input.mode === 'live') evidence.push(await gameBook(event, endedAt, signal));
    const bookRow = matching('nba_game_book').filter(e => obj(e.data).nbaId === event.nbaId).at(-1);
    const bookData = obj(bookRow?.data);
    const book = bookRow ? { source: { ...reference(bookRow, 'nba', null, bookData.version), versionAt: bookData.modified },
      page: bookData.page, players: bookData.players, releaseStatus: bookData.releaseStatus } as Book : null;
    const injuryReports = matching('nba_injury_report').filter(e => {
      const d = obj(e.data);
      return (d.eventKey === event.eventKey || event.nbaId && d.nbaId === event.nbaId) && d.publishedAt <= freshAsOf;
    }).map(e => {
      const d = obj(e.data);
      return { source: { ...reference(e, 'nba', d.publishedAt, d.version, d.publishedAt), versionAt: d.modified }, rows: d.rows, teams: d.teams } as Report;
    }).sort((a, b) => (b.source.publishedAt ?? '').localeCompare(a.source.publishedAt ?? '') || b.source.retrievedAt.localeCompare(a.source.retrievedAt));
    const report = injuryReports[0] ?? null;
    const clueEvidence = matching('nba_lineup_clues').find(e => String(obj(e.data).item?.gameId) === event.espnId);
    const clue = obj(obj(clueEvidence?.data).item);
    const startedAt = official?.startedAt ?? event.startedAt ?? espnReading?.startedAt ?? null;
    const rosterPlayer = event.player ?? (input.market && (() => {
      const rule = nbaMarketRule(input.market);
      const matches = (official?.players ?? event.roster ?? []).filter(p => rule?.kind === 'rebounds' && normalize(rule.playerName) === normalize(p.name));
      return matches.length === 1 ? matches[0] : undefined;
    })());
    let recent: unknown = null;
    if (rosterPlayer && input.mode === 'live' && input.query !== undefined) {
      const cached = event.rosterEvidence?.map(host.loadEvidence).find(e => obj(e?.data).teamId === rosterPlayer.teamId);
      const team = teams.find(t => t.id === rosterPlayer.teamId);
      const schedule = cached ?? (team && await teamPage(team, signal));
      if (schedule) {
        evidence.push(schedule);
        const earlier = rawEvents(schedule).filter(e => e.nbaId && e.scheduledAt && e.scheduledAt < (event.scheduledAt ?? input.asOf) &&
          e.scheduledState === 'final').sort((a, b) => b.scheduledAt!.localeCompare(a.scheduledAt!)).slice(0, 5);
        const boxes = await Promise.all(earlier.map(e => nbaBox(e.nbaId!, signal, e.sourceUrl + '/box-score')));
        evidence.push(...boxes);
        const games = boxes.map((row, i) => {
          const box = officialBox(row, earlier[i], freshAsOf);
          return { eventKey: earlier[i].eventKey, scheduledAt: earlier[i].scheduledAt, participants: earlier[i].participants, sourceUrl: row.source,
            player: box?.players.find(p => p.id === rosterPlayer.id) ?? null, evidenceId: row.evidenceId };
        });
        recent = { player: rosterPlayer, requested: 5, covered: games.filter(g => g.player?.played !== null && g.player).length,
          appearances: games.filter(g => g.player?.played === true).length, games };
      }
    }
    let marketCheck = input.market ? checkMarket(input.market, event, official, espnReading, book, freshAsOf) : null;
    const versions: NbaFacts['versions'] = officialHistory.map((box, i) => {
      const before = officialHistory[i - 1];
      return { source: box.source, state: box.state, changes: !before || box.state !== 'final' || before.state !== 'final' ? []
        : box.players.flatMap(player => {
          const prior = before.players.find(p => p.id === player.id && p.teamId === player.teamId);
          return (['rebounds', 'points', 'assists'] as const).flatMap(metric => {
            const oldValue = prior?.[metric], value = player[metric];
            return oldValue != null && value != null && oldValue !== value
              ? [{ id: player.id, name: player.name, metric, before: oldValue, after: value }] : [];
          });
        }) };
    });
    if (input.market && marketCheck?.rule?.kind === 'rebounds' && marketCheck.binding === 'verified' && officialHistory.length > 1) {
      const market = input.market;
      const rule = marketCheck.rule;
      const triggering = rule.freezeOnTrigger && officialHistory.map(box => checkMarket(market, event, box, null, null, box.source.retrievedAt))
        .find(result => result.trigger && result.officialOutcome);
      if (triggering) marketCheck = { ...marketCheck, ...triggering, freezeStatus: 'captured_official_trigger' };
      else if (rule.correctionCutoff && freshAsOf >= rule.correctionCutoff) {
        const lastEligible = officialHistory.findLast(box => box.state === 'final' && box.source.retrievedAt <= rule.correctionCutoff!);
        if (lastEligible) {
          const frozen = checkMarket(market, event, lastEligible, null, null, rule.correctionCutoff);
          marketCheck = { ...marketCheck, candidateOutcome: frozen.candidateOutcome,
            freezeStatus: 'pre_cutoff_official_box_retained',
            evidenceIds: [...new Set([...marketCheck.evidenceIds ?? [], ...frozen.evidenceIds ?? []])] };
        }
      }
    }
    const timeZone = official?.zone ?? null;
    const injuryGap = matching('nba_injury_index').length === 0 ? 'unavailable' : !report || !Object.keys(report.teams).length ? 'pending'
      : event.participants.every(t => report.teams[t.id] === 'submitted') ? 'covered' : 'partial';
    const coverage: SportsCoverage = { schedule: 'covered', officialStats: official?.freshness ?? 'unavailable',
      espnStats: espnReading?.freshness ?? (event.espnId ? 'unavailable' : 'pending'), injury: injuryGap,
      lineups: official?.freshness === 'covered' && official.players.some(p => p.starter) ? 'covered' : 'pending',
      gameBook: status !== 'final' ? 'pending' : book ? 'covered' : 'unavailable' };
    if (input.market) coverage.marketRule = marketCheck?.status === 'official_confirmed' ? 'covered' : marketCheck?.status === 'unsupported' ? 'unsupported' : 'pending';
    if (recent) coverage.recent = obj(recent).covered === 5 ? 'covered' : 'partial';
    return { eventKey: event.eventKey, participants: event.participants, competition: event.competition, scheduledAt: event.scheduledAt,
      startedAt, state: status, sourceUrl: event.sourceUrl, inputEvidenceIds: [...new Set([...evidence.map(e => e.evidenceId), ...event.rosterEvidence ?? []])],
      facts: { ids: { nba: event.nbaId, espn: event.espnId }, event,
        times: { timeZone, leagueDate: event.date, scheduledLocal: timeZone && localTime(event.scheduledAt, timeZone),
          actualLocal: timeZone && localTime(startedAt, timeZone), scheduledBeijing: localTime(event.scheduledAt, 'Asia/Shanghai'),
          scheduledBeijingWeekday: event.scheduledAt && new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
            weekday: 'long' }).format(new Date(event.scheduledAt)),
          actualBeijing: localTime(startedAt, 'Asia/Shanghai'), endedAt },
        official, espn: espnReading, injury: report, historicalInjury: injuryReports.slice(1), gameBook: book, recent, marketCheck, versions,
        lineupClues: clueEvidence ? { sourceMode: str(clue.sourceMode), source: reference(clueEvidence, 'espn', null, sportsVersion(clue)), data: clue } : null },
      coverage, market: marketCheck };
  }
  return { sport: 'nba', find, inspect, prepareWatch, changes };
}

const kinds = ['injury_status_change', 'starting_lineup_confirmed', 'stat_threshold', 'official_stat_confirmed', 'stat_corrected'] as const;
type Kind = typeof kinds[number];
type Metric = 'rebounds' | 'points' | 'assists';
type NbaCondition = SportsCondition & {
  kind: Kind; playerId?: string; playerName?: string; teamId: string; teamName: string;
  metric?: Metric; threshold?: number; operator?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; requireOfficial?: boolean; outcomeToken?: string;
};
type Observation = { value: number | string | boolean; source: Source; label: string; phase?: string; trigger?: Check['trigger'];
  detail?: string; ids?: string[]; seen?: string[]; adopted?: { value: number; source: Source } };
type Baseline = Record<string, Observation>;
const statNames = { rebounds: '篮板', points: '得分', assists: '助攻' };
function prepareWatch(snapshot: NbaSnapshot, conditions: SportsCondition[]) {
  const acceptedConditions: NbaCondition[] = [];
  const blockedConditions: { condition: SportsCondition; reason: string }[] = [];
  const sources = new Set<string>();
  const { official, event, marketCheck } = snapshot.facts;
  const roster = official && (snapshot.state !== 'scheduled' || official.players.length)
    ? [...official.players, ...(event.roster ?? []).filter(p => !official.players.some(x => x.id === p.id))]
    : event.roster ?? [];
  for (const condition of conditions) {
    const { kind } = condition;
    const block = (reason: string) => blockedConditions.push({ condition, reason });
    if (!kinds.includes(kind as Kind)) { block('未支持该 NBA 条件。'); continue; }
    const target = str(condition.target_id ?? condition.targetId ?? condition.target ?? condition.player_id ?? condition.playerId ??
      condition.team_id ?? condition.teamId ?? condition.player ?? condition.team);
    const playerName = str(condition.player_name ?? condition.playerName ?? target);
    const rule = marketCheck?.rule;
    const playerMatches = roster.filter(p => p.id === target || hasPlayerName(playerName || (rule?.kind === 'rebounds' ? rule.playerName : ''), p.name));
    const player = playerMatches.length === 1 ? playerMatches[0] : !target && event.player ? event.player : !target ? marketCheck?.player : undefined;
    const selectedTeam = event.participants.filter(t => t.id === (player?.teamId ?? target) ||
      target && teamMatch(target).some(team => team.id === t.id));
    const team = selectedTeam.length === 1 ? selectedTeam[0] : undefined;
    if (!event.nbaId || !team || playerMatches.length > 1) { block('球队或球员未唯一绑定到该场 NBA 原生 ID。'); continue; }
    const metric = str(condition.metric) || 'rebounds';
    const stats = ['stat_threshold', 'official_stat_confirmed', 'stat_corrected'].includes(kind);
    if (stats && (!player || !(metric in statNames))) { block('统计条件需要该场球员 ID 和篮板、得分或助攻指标。'); continue; }
    const endedAt = sportsTimestamp(snapshot.facts.times.endedAt);
    const revisionWindow = endedAt && Date.now() - Date.parse(endedAt) < 86_400_000;
    if (snapshot.state === 'final' && (kind !== 'stat_corrected' || !revisionWindow) || /cancel|abandon/.test(snapshot.state)) {
      block('该场已结束，只能核对历史事实或订阅仍有效的统计修订。'); continue;
    }
    if (kind === 'stat_corrected' && snapshot.state === 'final' && !official?.players.some(p => p.id === player?.id && p.played === true)) {
      block('赛后订阅需要已有官方统计基线。'); continue;
    }
    if (kind !== 'injury_status_change' && !official && !(kind === 'stat_threshold' && snapshot.facts.espn)) {
      block('本场比赛统计来源未成功读取。'); continue;
    }
    if (kind === 'injury_status_change' && snapshot.coverage.injury === 'unavailable') {
      block('NBA 官方伤病报告索引或本场报告读取失败。'); continue;
    }
    const threshold = num(condition.threshold);
    const operator = str(condition.operator ?? condition.comparator).replace(/^>$/, 'gt').replace(/^>=$/, 'gte')
      .replace(/^<$/, 'lt').replace(/^<=$/, 'lte').replace(/^==?$/, 'eq');
    const requireOfficial = condition.require_official ?? condition.requires_official ?? condition.requireOfficial ?? false;
    if (kind === 'stat_threshold' && (threshold === null || threshold < 0 || !['gt', 'gte', 'lt', 'lte', 'eq'].includes(operator) ||
      typeof requireOfficial !== 'boolean')) { block('阈值条件需提供 threshold、operator 和是否要求官方。'); continue; }
    if (kind === 'official_stat_confirmed' && rule?.kind === 'rebounds' && (metric !== 'rebounds' ||
      normalize(rule.playerName) !== normalize(player?.name ?? ''))) {
      block('官方确认条件的球员和指标必须与已核对的篮板盘一致。'); continue;
    }
    const normalized: NbaCondition = { kind: kind as Kind, teamId: team.id, teamName: team.name, playerId: player?.id, playerName: player?.name,
      ...(kind === 'official_stat_confirmed' && marketCheck?.player && typeof condition.outcome_token === 'string'
        ? { outcomeToken: condition.outcome_token } : {}),
      ...(stats ? { metric: metric as Metric } : {}), ...(kind === 'stat_threshold' ? {
        threshold: threshold!, operator: operator as NbaCondition['operator'], requireOfficial: requireOfficial === true,
      } : {}) };
    if (!acceptedConditions.some(c => sportsVersion(c) === sportsVersion(normalized))) acceptedConditions.push(normalized);
    sources.add(kind === 'injury_status_change' ? injuryIndex : event.sourceUrl + '/box-score');
    if (kind === 'official_stat_confirmed' && marketCheck?.rule?.kind === 'rebounds') sources.add(sourceSetting('PM_NBA_STATS_URL') + '/');
    if (kind === 'stat_threshold' && !requireOfficial && event.espnId) sources.add(espnGame(event.espnId));
  }
  return { acceptedConditions, blockedConditions, minIntervalSeconds: 60, sources: [...sources] };
}
function compareMetric(value: number, condition: NbaCondition) {
  const limit = condition.threshold!;
  switch (condition.operator) {
    case 'gt': return value > limit;
    case 'gte': return value >= limit;
    case 'lt': return value < limit;
    case 'lte': return value <= limit;
    case 'eq': return value === limit;
  }
  return false;
}
function changes(previous: Baseline = {}, snapshot: NbaSnapshot, draft: { eventKey: string; conditions: SportsCondition[] }) {
  const baseline: Baseline = { ...previous };
  const events: SportsEventChange[] = [];
  const coverage: SportsCoverage = {};
  const { official, espn, injury, marketCheck } = snapshot.facts;
  const currentOfficial = official?.freshness === 'covered' ? official : null;
  const currentEspn = espn?.freshness === 'covered' ? espn : null;
  for (const c of draft.conditions as NbaCondition[]) {
    const key = `${c.kind}/${c.playerId ?? c.teamId}/${sportsVersion(c).slice(0, 16)}`;
    coverage[key] = c.kind === 'injury_status_change' ? snapshot.coverage.injury :
      c.kind === 'starting_lineup_confirmed' ? snapshot.coverage.lineups : snapshot.coverage.officialStats;
    function update(target: string, obs: Observation, emit: (before: Observation) => boolean, kind = String(c.kind)) {
      const id = key + '/' + target;
      const prior = previous[id];
      if (prior) {
        const laterPublication = Boolean(obs.source.publishedAt && prior.source.publishedAt &&
          obs.source.publishedAt > prior.source.publishedAt);
        if (obs.source.version === prior.source.version || prior.source.provider === 'nba' && obs.source.provider !== 'nba') return;
        if (!laterPublication && prior.source.retrievedAt >= obs.source.retrievedAt ||
            obs.source.observedAt && prior.source.observedAt && obs.source.observedAt < prior.source.observedAt ||
            obs.source.publishedAt && prior.source.publishedAt && obs.source.publishedAt < prior.source.publishedAt ||
            obs.source.versionAt && prior.source.versionAt && obs.source.versionAt < prior.source.versionAt ||
            prior.seen?.includes(obs.source.version)) {
          coverage[key] = { status: 'stale', reason: '来源读数早于已持久化版本', evidenceId: obs.source.evidenceId };
          return;
        }
        obs.seen = [...prior.seen ?? [], prior.source.version].slice(-64);
        if (emit(prior)) {
          events.push({ eventKey: sportsVersion([draft.eventKey, c, target, prior.value, obs.value, obs.source.version]), kind,
            occurredAt: obs.source.publishedAt ?? (c.kind === 'stat_corrected' ? obs.source.versionAt ?? null : obs.source.observedAt),
            summary: `${obs.label} ${prior.value} → ${obs.value}${obs.detail ? ' · ' + obs.detail : ''}`,
            sourceUrl: obs.source.url, outcomeToken: c.outcomeToken, inputEvidenceIds: [...new Set([prior.source.evidenceId, obs.source.evidenceId, ...obs.ids ?? []])] });
        }
      }
      baseline[id] = obs;
    }
    if (c.kind === 'injury_status_change') {
      if (!injury || injury.teams[c.teamId] !== 'submitted') {
        if (injury?.teams[c.teamId] === 'not_submitted') coverage[key] = { status: 'pending', reason: '球队未提交报告', evidenceId: injury.source.evidenceId };
        continue;
      }
      if (snapshot.state === 'scheduled' && Date.parse(injury.source.retrievedAt) - Date.parse(injury.source.publishedAt!) > 24 * 3600_000) {
        coverage[key] = { status: 'stale', reason: '报告超过 24 小时', evidenceId: injury.source.evidenceId };
        continue;
      }
      const marker = key + '/$report';
      const prevReport = previous[marker];
      if (prevReport && (injury.source.publishedAt! < prevReport.source.publishedAt! ||
          prevReport.seen?.includes(injury.source.version) || injury.source.publishedAt === prevReport.source.publishedAt &&
          injury.source.versionAt && prevReport.source.versionAt && injury.source.versionAt < prevReport.source.versionAt)) {
        coverage[key] = { status: 'stale', reason: '官方报告早于已持久化版本', evidenceId: injury.source.evidenceId };
        continue;
      }
      coverage[key] = { status: 'covered', evidenceId: injury.source.evidenceId };
      const teamRows = injury.rows.filter(p => p.teamId === c.teamId);
      const names = c.playerName ? [c.playerName] : [...new Set([
        ...teamRows.map(p => p.player), ...Object.entries(previous).filter(([k, v]) => k.startsWith(key + '/') && v.label).map(([, v]) => v.label),
      ])];
      for (const name of names) {
        const status = teamRows.find(p => normalize(p.player) === normalize(name));
        update(normalize(name), { label: name, value: status?.status ?? '本版报告未列出', source: injury.source,
          detail: status ? `第 ${status.page} 页 ${status.reason}` : '球队已提交报告' }, p => p.value !== (status?.status ?? '本版报告未列出'));
      }
      // A submitted team report establishes a baseline for newly listed players.
      if (!prevReport || injury.source.publishedAt! >= prevReport.source.publishedAt!) {
        if (!c.playerName && prevReport && injury.source.version !== prevReport.source.version &&
            injury.source.retrievedAt > prevReport.source.retrievedAt && !prevReport.seen?.includes(injury.source.version)) {
          for (const r of teamRows.filter(r => !previous[key + '/' + normalize(r.player)])) {
            events.push({ eventKey: sportsVersion([draft.eventKey, c, r.player, r.status, injury.source.version]),
              kind: c.kind, occurredAt: injury.source.publishedAt ?? null, summary: `${r.player} 新列入伤病报告 · ${r.status} · 第 ${r.page} 页 ${r.reason}`,
              sourceUrl: injury.source.url, inputEvidenceIds: [prevReport.source.evidenceId, injury.source.evidenceId] });
          }
        }
        if (injury.source.version !== prevReport?.source.version && !prevReport?.seen?.includes(injury.source.version)) {
          baseline[marker] = { value: true, source: injury.source, label: '', seen: prevReport ? [...prevReport.seen ?? [], prevReport.source.version].slice(-64) : [] };
        }
      }
      continue;
    }
    if (c.kind === 'starting_lineup_confirmed') {
      const selected = currentOfficial?.players.filter(p => p.teamId === c.teamId && p.starter === true) ?? [];
      if (selected.length !== 5) {
        const marker = key + '/lineup';
        if (!previous[marker] && snapshot.state === 'scheduled' && official?.state === 'scheduled' && official.source) {
          baseline[marker] = { value: '尚未确认', label: c.playerName ?? c.teamName, source: official.source };
        }
        continue;
      }
      const value = c.playerId ? selected.some(p => p.id === c.playerId) ? '确认首发' : '确认未首发'
        : selected.map(p => p.name).sort().join('、');
      coverage[key] = { status: 'covered', evidenceId: currentOfficial!.source.evidenceId };
      update('lineup', { value, label: c.playerName ?? c.teamName, source: currentOfficial!.source },
        before => before.value !== value && (value !== '确认未首发' || before.value === '确认首发'));
      continue;
    }
    const officialPlayer = currentOfficial?.players.find(p => p.id === c.playerId);
    const secondary = currentEspn?.players.filter(p => p.teamId === c.teamId && normalize(p.name) === normalize(c.playerName ?? '')) ?? [];
    const officialValue = officialPlayer?.[c.metric!];
    const useEspn = c.kind === 'stat_threshold' && !c.requireOfficial && officialValue == null && secondary.length === 1;
    const box = useEspn ? currentEspn : currentOfficial;
    const value = useEspn ? secondary[0][c.metric!] : officialValue;
    const label = `${c.playerName} ${statNames[c.metric!]}`;
    if (c.kind === 'official_stat_confirmed' && marketCheck) {
      coverage[key] = { status: 'pending', reason: marketCheck.reason };
      if (previous[key + '/confirmed']?.trigger) {
        coverage[key] = { status: 'covered', evidenceId: previous[key + '/confirmed'].source.evidenceId };
        continue;
      }
      if (marketCheck.trigger && marketCheck.officialOutcome) {
        const trigger = marketCheck.trigger;
        coverage[key] = { status: 'covered', evidenceId: trigger.source.evidenceId };
        update('confirmed', { value: marketCheck.officialOutcome, label: label + ' 官方确认', source: trigger.source,
          trigger, detail: `${trigger.value} 个，采用 ${trigger.basis}`, ids: marketCheck.evidenceIds }, p => p.value !== marketCheck.officialOutcome);
      } else if (official) {
        update('confirmed', { value: '待官方确认', label, source: official.source }, () => false);
      }
      continue;
    }
    if (value == null || !box) {
      if (!previous[key + '/stat'] && official?.state === 'scheduled' && c.kind !== 'stat_corrected')
        baseline[key + '/stat'] = { value: '等待上场统计', label, source: official.source, phase: 'scheduled' };
      else if (box) coverage[key] = { status: 'pending', reason: '球员统计尚未覆盖', evidenceId: box.source.evidenceId };
      continue;
    }
    const reboundRule = marketCheck?.rule?.kind === 'rebounds' && c.metric === 'rebounds' &&
      normalize(marketCheck.rule.playerName) === normalize(c.playerName ?? '') ? marketCheck.rule : undefined;
    const triggerKey = key + '/frozen_market';
    if (c.kind === 'stat_corrected' && reboundRule?.freezeOnTrigger && marketCheck?.trigger && !baseline[triggerKey]?.trigger) {
      const trigger = marketCheck.trigger;
      baseline[triggerKey] = { value: trigger.value, label, trigger, source: trigger.source };
    }
    if (c.kind === 'stat_corrected' && box.state !== 'final') {
      coverage[key] = { status: 'pending', reason: '等待官方终场统计', evidenceId: box.source.evidenceId };
      continue;
    }
    const reached = c.kind === 'stat_threshold' && compareMetric(value, c);
    const confirmed = c.kind === 'official_stat_confirmed' && box.state === 'final';
    coverage[key] = { status: c.kind === 'official_stat_confirmed' && !confirmed ? 'pending' : 'covered', evidenceId: box.source.evidenceId };
    const after = c.kind === 'official_stat_confirmed' ? confirmed ? `确认 ${value}` : '待官方确认' : value;
    const cutoff = c.kind === 'stat_corrected' ? reboundRule?.correctionCutoff : null;
    const adopted = cutoff ? box.source.retrievedAt <= cutoff ? { value, source: box.source } : previous[key + '/stat']?.adopted : undefined;
    const trigger = baseline[triggerKey]?.trigger;
    let detail = box.source.provider === 'espn' ? 'ESPN 比赛统计' : 'NBA 官方比赛统计';
    if (trigger) detail += ` · 市场已按赛中官方版本冻结在 ${trigger.value}`;
    else if (cutoff && box.source.retrievedAt > cutoff) detail += adopted
      ? ` · 市场截止前已核对值 ${adopted.value}` : ' · 本版本在更正截止后取得，缺少截止前读数';
    update('stat', { value: after, label, source: box.source, phase: box.state, detail, adopted,
      ids: [trigger?.source.evidenceId, adopted?.source.evidenceId].filter((id): id is string => Boolean(id)) },
    p => c.kind === 'stat_threshold' ? reached && !(typeof p.value === 'number' && compareMetric(p.value, c)) :
      c.kind === 'official_stat_confirmed' ? confirmed && p.phase !== 'final' : p.phase === 'final' && p.value !== after,
    c.kind === 'stat_threshold' ? 'stat_threshold_reached' : c.kind);
  }
  return { baseline, events, coverage };
}
