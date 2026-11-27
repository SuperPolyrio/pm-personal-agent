import { sourceSetting } from './source-config.js';
import { createHash } from 'node:crypto';
import type {
  SportsAdapter, SportsChanges, SportsCondition, SportsCoverage, SportsEvidence,
  SportsEventChange, SportsFindInput, SportsHost, SportsInspectInput, SportsMarket, SportsParticipant,
  SportsSnapshot, SportsWatchDraft,
} from './sports.js';

const wta = sourceSetting('PM_WTA_API_URL') + '/tennis/';
const tennis = sourceSetting('PM_TENNIS_COM_URL') + '/';
const espn = sourceSetting('PM_ESPN_API_URL') + '/apis/site/v2/sports/tennis/';
const bonn = sourceSetting('PM_BONN_OPEN_URL') + '/en/tournament/order-of-play/';
const dayPattern = /\b20\d\d-\d\d-\d\d\b/;
const slugPattern = /^[a-z\d-]{1,90}$/i;
const zonePattern = /(?:Z|[+-]\d\d:\d\d)$/i;
const sourceKind = 'tennis_source';
const conditionKinds = ['schedule_changed', 'match_started', 'match_suspended', 'match_resumed',
  'break_of_serve', 'set_completed', 'retirement'] as const;
type ConditionKind = typeof conditionKinds[number];
type Tour = 'ATP' | 'WTA' | 'Challenger' | 'WTA 125';
type State = 'scheduled' | 'warmup' | 'live' | 'suspended' | 'postponed' | 'final' | 'retired' |
  'walkover' | 'defaulted' | 'cancelled' | 'withdrawn_before_play' | 'abandoned' | 'unknown';
type Row = Record<string, unknown>;
type Pair<T> = [T, T];
type Player = SportsParticipant & { aliases: string[] };
type SetScore = { number: number; games: Pair<number>; tiebreak: Pair<number | null>;
  started: boolean; winnerId: string | null; format: 'ordinary' | 'match_tiebreak' | 'unknown' };
type Game = { points: Pair<string>; serverId: string | null; tiebreak: boolean | null };
type Schedule = {
  kind: 'fixed' | 'not_before' | 'followed_by' | 'listed' | 'estimated' | 'unknown';
  localDate: string | null; localTime: string | null; timezone: string | null; court: string | null;
  scheduledAt: string | null; earliestAt: string | null; beijingTime: string | null; text: string | null;
  previous: { matchId: string; matchup: string } | null;
};
type TennisEvent = {
  eventKey: string; participants: Pair<Player>; competition: string; scheduledAt: string | null; sourceUrl: string;
  tour: Tour; round: string | null; localDate: string | null; [key: string]: unknown;
};
type TennisFacts = {
  tour: Tour; round: string | null; schedule: Schedule | null; sourceState: string | null;
  sourceResult: string | null; eventTime: string | null; stateObservedAt: string | null;
  started: boolean | null; startTimeBasis: string | null; startedBeijingTime: string | null; winnerId: string | null;
  bestOf: 3 | 5 | null; sets: SetScore[]; game: Game | null; activeSet: number | null;
  totalServePoints?: number;
  suspensionReason: string | null; pointHistory: 'unavailable'; observedAt: string | null;
  sources: { url: string; retrievedAt: string; observedAt: string | null; evidenceId: string; fields: string[] }[];
};
type Snapshot = TennisEvent & SportsSnapshot<TennisFacts> & { state: State };
type Capture = { kind: typeof sourceKind; read: 'wta-score' | 'wta-oop' | 'espn' | 'tennis-channel' | 'bonn';
  event: TennisEvent; raw: Row; responseDate: string | null; cacheAge: number | null };
type Data = { event: TennisEvent; state: State; facts: Omit<TennisFacts, 'sources' | 'observedAt' | 'pointHistory'>; startedAt: string | null };
type Baseline = Partial<Record<ConditionKind, {
  value: string; version: string | null; retrievedAt: string; evidenceId: string; state: State;
  activeSet: number | null; sets: SetScore[]; game: Game | null; schedule: Schedule | null;
}>>;

const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];
const str = (value: unknown): string => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const integer = (value: unknown): number | null => /^\d+$/.test(str(value)) ? Number(value) : null;
const iso = (value: unknown) => {
  const input = str(value).replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  return zonePattern.test(input) && Number.isFinite(Date.parse(input)) ? new Date(input).toISOString() : null;
};
const norm = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const phrase = (text: string, name: string) => Boolean(name) &&
  (/[\p{Script=Han}]/u.test(name) ? text.includes(name) : ` ${text} `.includes(` ${name} `));
const slug = (value: string) => norm(value).replace(/ /g, '-');
const unique = <T,>(values: T[]) => [...new Set(values)];
const finished = (state: State) => ['final', 'retired', 'walkover', 'defaulted', 'cancelled',
  'withdrawn_before_play', 'abandoned'].includes(state);
const played = (state: State) => ['final', 'retired', 'live', 'suspended', 'abandoned'].includes(state);
const coverage = (status: 'partial' | 'pending' | 'unavailable' | 'unsupported' | 'stale', reason: string, evidenceId?: string) =>
  ({ status, reason, evidenceId });
const fingerprint = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const chinese: Record<string, string[]> = {
  'qinwen zheng': ['郑钦文'], 'jannik sinner': ['辛纳', '辛拿'], 'carlos alcaraz': ['阿尔卡拉斯', '阿卡'],
  'iga swiatek': ['斯瓦泰克'], 'aryna sabalenka': ['萨巴伦卡'], 'elena rybakina': ['莱巴金娜'],
  'coco gauff': ['高芙'], 'novak djokovic': ['德约科维奇', '德约'], 'alexander zverev': ['兹维列夫'],
  'mirra andreeva': ['米拉·安德烈耶娃', '米拉安德烈耶娃'], 'emma raducanu': ['拉杜卡努'],
  'yibing wu': ['吴易昺'], 'zhizhen zhang': ['张之臻'], 'juncheng shang': ['商竣程'],
  'laura samson': ['劳拉·萨姆松'], 'nadia podoroska': ['波多罗斯卡'],
};
const competitionAliases: Record<string, string[]> = {
  'cincinnati open': ['cincinnati', '辛辛那提'],
  'saint tropez open': ['st tropez', 'saint tropez', '圣特罗佩'],
  'bonn open': ['bonn', '波恩'],
  'boss open': ['stuttgart open', 'stuttgart', '斯图加特'],
  'wimbledon wta': ['wimbledon'],
  'ieb argentina open buenos aires arg': ['buenos aires', 'argentina open', '布宜诺斯艾利斯'],
};
const timezones: Record<string, string> = {
  'buenos aires': 'America/Argentina/Buenos_Aires', cincinnati: 'America/New_York',
  'saint tropez': 'Europe/Paris', bonn: 'Europe/Berlin', tokyo: 'Asia/Tokyo',
  yokohama: 'Asia/Tokyo', 'playford city': 'Australia/Adelaide', madrid: 'Europe/Madrid',
};

function player(id: unknown, name: string, aliases: string[] = []): Player | null {
  if (!str(id) || !name.trim()) return null;
  const normalized = norm(name);
  const reversed = normalized.split(' ').toReversed().join(' ');
  return { id: str(id), name: name.trim(), aliases: unique([normalized, ...aliases.map(norm),
    ...(chinese[normalized] ?? chinese[reversed] ?? []).map(norm)].filter(Boolean)) };
}

function matchState(input: string): State {
  const state = norm(input).replace(/^status /, '');
  if (/\b(?:walk ?over|w o)\b/.test(state)) return 'walkover';
  if (/\bret(ired|irement)?\b/.test(state)) return 'retired';
  if (/\b(default|defaulted|disqualified)\b/.test(state)) return 'defaulted';
  if (/\b(withdrawn|withdrawal)\b/.test(state)) return 'withdrawn_before_play';
  if (/\babandoned\b/.test(state)) return 'abandoned';
  if (/\b(cancelled|canceled|unplayed)\b/.test(state)) return 'cancelled';
  if (/\b(postponed|rescheduled)\b/.test(state)) return 'postponed';
  if (/\b(suspended|interrupted|delayed|rain delay)\b/.test(state)) return 'suspended';
  if (/\b(warm up|warmup|on court)\b/.test(state)) return 'warmup';
  if (/^(final|completed|ended|finished|full time)$/.test(state)) return 'final';
  if (/^(live|in progress|playing|resumed|restarted)$/.test(state)) return 'live';
  if (/^(scheduled|upcoming|pre|not started)$/.test(state)) return 'scheduled';
  return 'unknown';
}

function setScore(players: Pair<Player>, number: number, games: Pair<number>, tiebreak: Pair<number | null>,
  playedPoint: boolean, format: SetScore['format'], sourceWinner?: string) {
  const high = Math.max(...games);
  const low = Math.min(...games);
  const standardEnd = high === 6 && low <= 4 || high === 7 && (low === 5 || low === 6);
  const matchTiebreakEnd = high >= 10 && high - low >= 2;
  const completed = format === 'ordinary' && standardEnd || format === 'match_tiebreak' && matchTiebreakEnd;
  return { number, games, tiebreak, format, started: high > 0 || tiebreak.some(value => (value ?? 0) > 0) || playedPoint,
    winnerId: sourceWinner || (completed ? players[games[0] > games[1] ? 0 : 1].id : null) } satisfies SetScore;
}

export const beijingTime = (at: string | null) => at ? new Intl.DateTimeFormat('sv-SE', {
  dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai',
}).format(new Date(at)) : null;

const knownPoint = (p: string) => /^(?:\d{1,3}|A|AD|ADV)$/i.test(p);
function currentGame(points: Pair<string>, serverId: string | null, tiebreak: boolean | null): Game | null {
  return points.every(knownPoint) ? { points, serverId, tiebreak } : null;
}

type ServiceGameSnapshot = { state: string; activeSet: number | null; game: Game | null; sets: Pick<SetScore, 'number' | 'games'>[] };
export function completedServiceGame(before: ServiceGameSnapshot, after: ServiceGameSnapshot, participants: readonly SportsParticipant[]) {
  if (before.state !== 'live' || after.state !== 'live' || before.activeSet === null || before.activeSet !== after.activeSet ||
      !before.game?.serverId || !after.game?.serverId || before.game.tiebreak !== false || after.game.tiebreak !== false ||
      before.game.serverId === after.game.serverId) return;
  const previousSet = before.sets.find(s => s.number === before.activeSet);
  const currentSet = after.sets.find(s => s.number === after.activeSet);
  if (!previousSet || !currentSet) return;
  const winner = currentSet.games.findIndex((n, i) => n - previousSet.games[i] === 1 &&
    currentSet.games[1 - i] === previousSet.games[1 - i]);
  const player = participants[winner];
  if (!player) return;
  return { kind: player.id === before.game.serverId ? 'hold' as const : 'break' as const, winnerId: player.id,
    winner: player.name, previouslyServingId: before.game.serverId, setNumber: currentSet.number, score: currentSet.games };
}

function listedSchedule(at: string | null, localDate: string | null, court: string | null,
  timezone: string | null, text: string | null = null, kind: Schedule['kind'] = 'listed'): Schedule {
  const localTime = at && timezone ? new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone,
  }).format(new Date(at)) : null;
  return { kind: at ? kind : 'unknown', localDate, localTime, timezone, court, scheduledAt: at,
    earliestAt: null, beijingTime: beijingTime(at), text, previous: null };
}

function localDay(at: string | null, timezone: string | null) {
  return at && timezone ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(at))
    : at?.slice(0, 10) ?? null;
}

export async function readTennisSource(url: string, signal: AbortSignal) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(9_000)]),
    headers: { 'cache-control': 'no-cache', accept: 'application/json,text/html;q=0.9' } });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error('HTTP_' + response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 5_000_000) throw Error('response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const serverDate = Date.parse(response.headers.get('date') ?? '');
  return { body: Buffer.concat(chunks).toString('utf8'), retrievedAt: new Date().toISOString(),
    responseDate: Number.isFinite(serverDate) ? new Date(serverDate).toISOString() : null,
    cacheAge: integer(response.headers.get('age')) };
}

function flightRows(html: string, accept: (r: Row) => boolean) {
  const output: Row[] = [];
  const chunks = Array.from(html.matchAll(/<script>self\.__next_f\.push\((\[1,.*?)\)<\/script>/gs), m => JSON.parse(m[1])[1]);
  if (!chunks.length) throw Error('missing_structured_page_data');
  function visit(node: unknown) {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const object = row(node);
    if (accept(object)) output.push(object);
    else Object.values(object).forEach(visit);
  }
  for (const line of chunks.join('').split('\n')) {
    const payload = line.slice(line.indexOf(':') + 1);
    if (!/^[{[]/.test(payload)) continue;
    let data: unknown;
    try { data = JSON.parse(payload); } catch { continue; }
    visit(data);
  }
  return output;
}

function wtaEvent(match: Row, tournament: Row): TennisEvent | null {
  const id = str(match.EventID), year = str(match.EventYear), matchId = str(match.MatchID);
  if (match.DrawMatchType !== 'S' || !/^\d{2,5}$/.test(id) || !/^20\d\d$/.test(year) || !/^[LR]S\d{3,10}$/i.test(matchId)) return null;
  const makePlayer = (side: 'A' | 'B') => player(match['PlayerID' + side],
    [str(match['PlayerNameFirst' + side]), str(match['PlayerNameLast' + side])].filter(Boolean).join(' '),
    [str(match['PlayerNameLast' + side])]);
  const a = makePlayer('A'), b = makePlayer('B');
  const competition = str(tournament.title) || str(row(tournament.tournamentGroup).name);
  if (!a || !b || !competition) return null;
  const venueZone = timezones[norm(str(tournament.city))] ?? null;
  const listedAt = match.MatchState === 'U' && !match.Unscheduled ? iso(match.MatchTimeStamp) : null;
  return { eventKey: `tennis:wta:${year}.${id}.${matchId}`, participants: [a, b],
    tour: tournament.level === 'WTA 125' || row(tournament.tournamentGroup).level === 'WTA 125' ? 'WTA 125' : 'WTA',
    competition, scheduledAt: /before/i.test(str(match.NotBefore)) ? null : listedAt,
    localDate: venueZone ? localDay(iso(match.MatchTimeStamp), venueZone)
      : iso(match.MatchTimeStamp) ? str(match.MatchTimeStamp).slice(0, 10) : null, round: wtaRound(match),
    sourceUrl: `${wta}tournaments/${id}/${year}/matches/${matchId}/score`,
    tournamentId: id, season: year, surface: str(tournament.surface).toLowerCase() || null,
    tournamentCity: str(tournament.city), timezone: venueZone };
}

function wtaRound(match: Row) {
  const round = str(match.RoundID);
  const num = Number(str(match.MatchID).slice(2));
  if (match.DrawLevelType === 'Q') return `Qualifying ${round}`.trim();
  if (round === 'G') return 'Group stage';
  if (str(match.MatchID).length > 5) return /^[1-9]\d?$/.test(round) ? `Round ${round}` : null;
  if (num === 1) return 'Final';
  if (num <= 3) return 'Semifinal';
  if (num <= 7) return 'Quarterfinal';
  if (num <= 15) return 'Round of 16';
  if (num <= 31) return 'Round of 32';
  if (num <= 63) return 'Round of 64';
  return num <= 127 ? 'Round of 128' : null;
}

function wtaSchedule(outer: Row, id: string) {
  const found: { schedule: Schedule; raw: Row }[] = [];
  for (const encoded of items(outer.orderOfPlay)) {
    if (typeof encoded !== 'string') continue;
    const root = row(row(JSON.parse(encoded)).OOP);
    for (const dayValue of items(row(root.Schedule).Day)) {
      const day = row(dayValue);
      for (const value of items(day.Court)) {
        const court = row(value), matches = items(row(court.Matches).Match).map(row);
        const matchIndex = matches.findIndex(m => str(m.MatchId) === id);
        if (matchIndex < 0) continue;
        const match = matches[matchIndex];
        const localDate = str(day.ISODate);
        const localTime = str(match.NotBeforeISOTime);
        const label = str(match.NotBefore) || str(match.NotBeforeText) || str(match.FreeText);
        const timestamp = localTime ? iso(`${localDate}T${localTime}`) : null;
        const before = /not before|\bnb\b/i.test(label);
        const previous = matches[matchIndex - 1];
        const conditional = /followed by|after/i.test(label);
        const schedule: Schedule = { kind: before ? 'not_before' : conditional ? 'followed_by'
          : /starting at/i.test(label) && timestamp ? 'fixed' : timestamp ? 'listed' : 'unknown', localDate,
          localTime: localTime.slice(0, 5) || null, timezone: /[+-]\d{4}$/.exec(localTime)?.[0] ?? null,
          court: str(court.CourtName) || null, text: label || null,
          scheduledAt: before || conditional ? null : timestamp, earliestAt: before ? timestamp : null,
          beijingTime: beijingTime(timestamp),
          previous: previous ? { matchId: str(previous.MatchId), matchup: str(previous.MatchupDisplayLine) } : null };
        found.push({ schedule, raw: { date: localDate, court: court.CourtName, match, previous: previous ?
          { matchId: previous.MatchId, matchup: previous.MatchupDisplayLine } : null } });
      }
    }
  }
  return found.toSorted((a, b) => (b.schedule.localDate ?? '').localeCompare(a.schedule.localDate ?? ''))[0];
}

function emptyFacts(event: TennisEvent): Data['facts'] {
  return { tour: event.tour, round: event.round, schedule: null, sourceState: null, sourceResult: null,
    eventTime: null, stateObservedAt: null, started: null, startTimeBasis: null, startedBeijingTime: null, winnerId: null,
    bestOf: null, sets: [], game: null, activeSet: null, suspensionReason: null };
}

function wtaData(event: TennisEvent, raw: Row): Data {
  const s = str(raw.MatchState);
  const result = str(raw.ResultString);
  const classification = matchState(result);
  const state: State = classification !== 'unknown' && ['walkover', 'retired', 'defaulted', 'cancelled', 'abandoned'].includes(classification)
    ? classification : ({ U: 'scheduled', T: 'scheduled', C: 'warmup', W: 'warmup', w: 'suspended',
      g: 'warmup', P: 'live', p: 'live', R: 'live', D: 'live', M: 'live', E: 'unknown', S: 'suspended',
      F: 'final', L: 'cancelled' } as Record<string, State>)[s] ?? 'unknown';
  const participants = event.participants;
  const activeSet = state === 'live' || state === 'suspended' ? integer(raw.NumSets) : null;
  const serverId = raw.Serve === 'A' ? participants[0].id : raw.Serve === 'B' ? participants[1].id : null;
  const ordinary = str(raw.ScoreSys) === '1';
  const sets: SetScore[] = [];
  for (let number = 1; number <= 5; number++) {
    const a = integer(raw[`ScoreSet${number}A`]), b = integer(raw[`ScoreSet${number}B`]);
    if (a === null || b === null) continue;
    const tie = integer(raw[`ScoreTbSet${number}`]);
    const tiebreak: Pair<number | null> = tie === null ? [null, null] : a > b ? [null, tie] : [tie, null];
    const points = [str(raw.PointA), str(raw.PointB)];
    const pointPlayed = activeSet === number && points.some(p => knownPoint(p) && p !== '0');
    const format = number === 3 && ['5', '9'].includes(str(raw.ScoreSys)) ? 'match_tiebreak'
      : ordinary || (number < 3 && ['5', '9'].includes(str(raw.ScoreSys))) ? 'ordinary' : 'unknown';
    sets.push(setScore(participants, number, [a, b], tiebreak, pointPlayed, format));
  }
  const currentSet = sets.find(set => set.number === activeSet);
  const game = state === 'live' || state === 'suspended'
    ? currentGame([str(raw.PointA), str(raw.PointB)], serverId, currentSet?.format === 'match_tiebreak' ||
      (currentSet?.format === 'ordinary' ? currentSet.games.every(score => score === 6) : null)) : null;
  const started = state === 'walkover' || state === 'withdrawn_before_play' ? false
    : played(state) || sets.some(set => set.started) ? true
    : ['scheduled', 'warmup'].includes(state) || state === 'cancelled' && /unplayed|not played/i.test(result) ? false : null;
  const sourceTime = iso(raw.MatchTimeStamp);
  const startedAt = started ? sourceTime : null;
  const winnerId = ['2', '4', '6'].includes(str(raw.Winner)) ? participants[0].id
    : ['3', '5', '7'].includes(str(raw.Winner)) ? participants[1].id : null;
  const schedule = state === 'scheduled' && !raw.Unscheduled ?
    listedSchedule(sourceTime, event.localDate, str(raw.CourtName) || null, str(event.timezone) || null,
      str(raw.NotBefore) || null, raw.isEstimatedStartTime ? 'estimated' : 'listed') : null;
  if (schedule && /not before/i.test(schedule.text ?? '')) {
    schedule.kind = 'not_before';
    schedule.earliestAt = schedule.scheduledAt;
    schedule.scheduledAt = null;
  }
  return { event, state, startedAt, facts: { ...emptyFacts(event), schedule, sourceState: s,
    sourceResult: result || str(raw.Message) || null, started, startTimeBasis: startedAt ? 'WTA MatchTimeStamp in played score record' : null,
    stateObservedAt: iso(raw.LastUpdated), startedBeijingTime: beijingTime(startedAt), winnerId: finished(state) ? winnerId : null, bestOf: ordinary || ['5', '9'].includes(str(raw.ScoreSys)) || state === 'scheduled' ? 3 : null,
    sets, game, activeSet } };
}

function channelEvent(raw: Row, pageTournament?: string): TennisEvent | null {
  if (!/^(Men|Women)'s Singles$/i.test(str(raw.eventCategory)) || raw.homeTeam || raw.awayTeam) return null;
  const tournament = row(raw.tournament);
  const tournamentSlug = str(raw.tournamentSlug ?? tournament.slug ?? pageTournament), matchSlug = str(raw.slug);
  if (!slugPattern.test(tournamentSlug) || !slugPattern.test(matchSlug) || tournamentSlug.length + matchSlug.length > 127) return null;
  const makePlayer = (side: 'home' | 'away') => {
    const item = row(raw[side + 'Competitor']);
    const parts = str(item.name).split(',').map(s => s.trim());
    return player(item.id, parts.toReversed().join(' '), [parts[0], str(item.shortName)]);
  };
  const a = makePlayer('home'), b = makePlayer('away');
  const competition = str(raw.tournamentOfficialName ?? tournament.officialName) ||
    str(raw.tournamentName ?? tournament.name);
  const level = str(raw.tournamentLevel ?? raw.level) || str(raw.competitionCategory);
  if (!a || !b || !competition || !level ||
      /\b(?:itf|utr)\b|junior|exhibition|universal tennis/i.test(`${level} ${competition} ${tournamentSlug}`)) return null;
  const tour: Tour = /wta\s*125/i.test(level) ? 'WTA 125' : /challenger/i.test(level) && /^Men/.test(str(raw.eventCategory))
    ? 'Challenger' : /^Men/.test(str(raw.eventCategory)) ? 'ATP' : 'WTA';
  const scheduledAt = iso(raw.startTime);
  let timezone = str(raw.tournamentTimezone) || timezones[norm(str(raw.tournamentCity))] || '';
  if (!timezone) {
    timezone = Object.entries(timezones).find(([city]) => phrase(norm(competition), city))?.[1] ?? '';
  }
  return { eventKey: `tennis:tc:${tournamentSlug}.${matchSlug}`, participants: [a, b], competition,
    tour, round: str(raw.round) || null, scheduledAt, localDate: dayPattern.exec(matchSlug)?.[0] ?? localDay(scheduledAt, timezone || null),
    sourceUrl: `${tennis}tournaments/${tournamentSlug}/matches/${matchSlug}`, timezone: timezone || null, level,
    providerMatchId: str(raw.matchScoreKey) || str(raw.id) };
}

function channelData(event: TennisEvent, raw: Row): Data {
  const status = str(raw.status), label = str(raw.statusLabel);
  const annotated = matchState(label);
  const state = annotated !== 'unknown' && (finished(annotated) || annotated === 'suspended' || annotated === 'postponed')
    ? annotated : matchState(status);
  const score = row(raw.score), g = row(score.currentGame);
  const activeSet = integer(score.currentSetNumber);
  const serverId = g.servingSide === 'home' ? event.participants[0].id : g.servingSide === 'away' ? event.participants[1].id : null;
  const game = state === 'live' || state === 'suspended' ? currentGame([str(g.homePointDisplay), str(g.awayPointDisplay)],
    serverId, typeof g.inTiebreak === 'boolean' ? g.inTiebreak : null) : null;
  const sets = items(score.sets).map(row).flatMap(set => {
    const n = integer(set.setNumber), a = integer(set.homeGames), b = integer(set.awayGames);
    if (n === null || a === null || b === null) return [];
    const format = set.isMatchTiebreak === true || set.matchTiebreak === true ? 'match_tiebreak'
      : n < 3 || Math.max(a, b) <= 7 ? 'ordinary' : 'unknown';
    return [setScore(event.participants, n, [a, b], [integer(set.homeTiebreakPoints), integer(set.awayTiebreakPoints)],
      Boolean(activeSet === n && game?.points.some(p => p !== '0')), format)];
  });
  const winnerId = event.participants.some(p => p.id === raw.winnerId) ? str(raw.winnerId) : null;
  const major = /grand slam|major|wimbledon|roland garros|australian open|\bus open\b/i.test(`${str(event.level)} ${event.competition}`);
  const bestOf = event.tour === 'ATP' && major ? 5 : event.tour !== 'ATP' || /[125]\d\d|challenger|tour|finals/i.test(str(event.level)) ? 3 : null;
  const actual = iso(raw.actualStartTime);
  const servicePoints = items(raw.firstServePercent).map(v => integer(/\(\d+\/(\d+)\)$/.exec(str(v))?.[1]));
  const totalServePoints = state === 'final' && servicePoints.length === 2 && servicePoints.every(n => n !== null && n > 0)
    ? servicePoints.reduce<number>((a,b) => a + b!, 0) : undefined;
  return { event, state, startedAt: played(state) ? actual : null, facts: { ...emptyFacts(event),
    schedule: listedSchedule(event.scheduledAt, event.localDate, str(row(raw.venue).name) || null, str(event.timezone) || null,
      null, raw.startTimeConfirmed === false ? 'estimated' : 'listed'),
    sourceState: status, sourceResult: label || null, bestOf,
    started: state === 'walkover' || state === 'withdrawn_before_play' ? false : played(state) || sets.some(set => set.started)
      ? true : state === 'scheduled' || state === 'warmup' ? false : null,
    startTimeBasis: actual ? 'Tennis Channel actualStartTime' : null, startedBeijingTime: beijingTime(actual),
    winnerId, activeSet, sets, game, totalServePoints,
    eventTime: finished(state) ? iso(raw.endTime) : null, stateObservedAt: iso(raw.updatedAt) } };
}

function espnEvent(tour: 'atp' | 'wta', tournament: Row, match: Row, sourceUrl: string): TennisEvent | null {
  if (str(row(match.type).id) !== (tour === 'atp' ? '1' : '2')) return null;
  const id = str(match.id), tournamentId = str(tournament.id);
  if (!/^\d+$/.test(id) || !/^\d+-20\d\d$/.test(tournamentId)) return null;
  const sides = items(match.competitors).map(row).sort((a, b) => Number(a.order) - Number(b.order));
  const participants = sides.map(side => {
    const a = row(side.athlete);
    const name = str(a.displayName ?? a.fullName);
    return player(side.id, name, [str(a.shortName), name.split(' ').at(-1) ?? '']);
  });
  if (participants.length !== 2 || !participants[0] || !participants[1] || !str(tournament.name)) return null;
  const competition = str(tournament.name);
  const timezone = Object.entries(timezones).find(([city]) => phrase(norm(competition), city))?.[1] ?? null;
  const scheduledAt = match.timeValid === true ? iso(match.startDate ?? match.date) : null;
  const localDate = localDay(iso(match.date), timezone);
  if (!localDate) return null;
  return { eventKey: `tennis:espn:${tour}.${tournamentId}.${localDate}.${id}`, tour: tour === 'atp' ? 'ATP' : 'WTA',
    participants: [participants[0], participants[1]], competition, scheduledAt,
    localDate, round: str(row(match.round).displayName) || null,
    sourceUrl, timezone, tournamentId, providerMatchId: id };
}

function espnData(event: TennisEvent, raw: Row): Data {
  const status = row(row(raw.status).type);
  const state = matchState(str(status.name));
  const sides = items(raw.competitors).map(row).sort((a, b) => Number(a.order) - Number(b.order));
  const scores = sides.map(side => items(side.linescores).map(row));
  const sets = (scores[0] ?? []).flatMap((left, i) => {
    const right = scores[1]?.[i];
    const a = integer(left.value), b = integer(right?.value);
    if (a === null || b === null) return [];
    const winner = left.winner === true ? event.participants[0].id : right?.winner === true ? event.participants[1].id : undefined;
    return [setScore(event.participants, i + 1, [a, b], [integer(left.tiebreak), integer(right?.tiebreak)],
      false, 'unknown', winner)];
  });
  const venue = row(raw.venue);
  const notes = items(raw.notes).map(note => str(row(note).text)).filter(Boolean).join(' · ');
  const winnerId = finished(state) ? str(sides.find(side => side.winner === true)?.id) || null : null;
  const bestOf = event.tour === 'WTA' ? 3 : /wimbledon|roland garros|australian open|\bus open\b|french open/i.test(event.competition) ? 5
    : /cincinnati|masters|open|finals/i.test(event.competition) ? 3 : null;
  return { event, state, startedAt: null, facts: { ...emptyFacts(event), sets, winnerId, bestOf,
    sourceState: str(status.name) || null, sourceResult: notes || str(status.detail) || null,
    started: state === 'walkover' ? false : played(state) || sets.some(set => set.started) ? true : state === 'scheduled' ? false : null,
    schedule: listedSchedule(event.scheduledAt, event.localDate, str(venue.court) || null, str(event.timezone) || null),
    activeSet: state === 'live' ? integer(row(raw.status).period) : null } };
}

function contractIdentity(market: SportsMarket) {
  const intro = market.rules.split('\n')[0];
  const pair = /\bbetween\s+([^\n]+?)\s+and\s+([^\n]+?)\s+in\s+(?:the\s+)?([^,.\n]+(?:\.\s+[A-Z][\w-]+)?)(?=,|\s+(?:originally )?scheduled|\.(?:\s|$))/i.exec(intro)
    ?? /\bbetween\s+([^\n]+?)\s+and\s+([^\n]+?)\s+in\s+(?:the\s+)?([^,\n]+),/i.exec(intro);
  if (!pair) return null;
  const competition = str(pair[3]).replace(/^20\d\d\s+(?:(?:ATP|WTA)\s+)?/i, '')
    .replace(/\s+(?:men|women)[’']s singles tournament$/i, '');
  const date = dayPattern.exec(market.eventDate ?? market.eventSlug ?? market.slug)?.[0]
    ?? englishDate(/\bscheduled (?:for|on)\s+([A-Z][a-z]+\s+\d{1,2},?\s+20\d\d)/i.exec(intro)?.[1] ?? '');
  if (!competition || !date) return null;
  return { names: [norm(pair[1]), norm(pair[2])] as Pair<string>, competition, date };
}

function englishDate(value: string) {
  const date = Date.parse(value + ' UTC');
  return Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10) : null;
}

function sameName(full: string, participant: Player) {
  const name = norm(participant.name);
  return full === name || full === 'diego dedura palomero' && name === 'diego dedura' ||
    full === 'diego dedura' && name === 'diego dedura palomero';
}

function competitionNames(value: string) {
  const n = norm(value);
  return [n, ...competitionAliases[n] ?? []];
}

export function sameCompetition(a: string, b: string) {
  return competitionNames(a).some(x => competitionNames(b).some(y => x.length >= 4 && y.length >= 4 &&
    (phrase(x, y) || phrase(y, x))));
}

function sameMatch(event: TennisEvent, identity: NonNullable<ReturnType<typeof contractIdentity>>) {
  const [a, b] = event.participants;
  return sameCompetition(event.competition, identity.competition) && (event.localDate === identity.date ||
    event.contractDate === identity.date) && (sameName(identity.names[0], a) && sameName(identity.names[1], b) ||
    sameName(identity.names[0], b) && sameName(identity.names[1], a));
}

function bonnWithdrawals(html: string, season: string) {
  const announcements = flightRows(html, r => typeof r.time === 'string' && Array.isArray(r.lines));
  const matches = flightRows(html, r => r.kind === 'match' && typeof r.key === 'string' && typeof r.round === 'string' &&
    /singles/i.test(r.round));
  const rows: { event: TennisEvent; raw: Row }[] = [];
  for (const entry of announcements) {
    for (const line of items(entry.lines)) {
      const change = /^Singles main draw: (.+?) \(Lucky loser\) replaces (.+)$/i.exec(str(line));
      const date = englishDate(`${str(entry.time).replace(/\s+\d\d:\d\d$/, '')} ${season}`);
      if (!change || !date) continue;
      const n = norm(change[1]), outgoing = norm(change[2]);
      const replacement = matches.filter(m => str(m.key).slice(0, 10) >= date && /round of 32/i.test(str(m.round)))
        .flatMap(match => {
          const sides = [row(items(row(match.a).people)[0]), row(items(row(match.b).people)[0])];
          const index = sides.findIndex(p => norm(str(p.name)) === n);
          return index < 0 ? [] : [{ match, opponent: sides[1 - index] }];
        });
      if (replacement.length !== 1) continue;
      const { match, opponent } = replacement[0];
      const a = player(slug(outgoing), str(change[2]));
      const b = player(opponent.id, str(opponent.name));
      if (!a || !b || !slugPattern.test(a.id) || !slugPattern.test(b.id)) continue;
      const event: TennisEvent = { eventKey: `tennis:bonn:${date}.${a.id}.${b.id}`, participants: [a, b],
        competition: 'Bonn Open', scheduledAt: null, localDate: date, round: 'Round of 32', tour: 'Challenger',
        sourceUrl: bonn + season, identityBasis: 'Organizer main-draw replacement and first-round opponent' };
      rows.push({ event, raw: { announcement: line, announcementTime: entry.time, replacementMatchKey: match.key,
        replacement: change[1], opponent: { id: b.id, name: b.name } } });
    }
  }
  return rows;
}

function marketDeadline(rules: string, scheduledDay: string) {
  const specific = /\b(?:by|beyond)\s+([A-Z][a-z]+\s+\d{1,2},\s+20\d\d)(?:,?\s+(\d{1,2}):(\d\d)\s*([AP]M)\s*(ET|UTC|GMT))?/i.exec(rules);
  const relative = /\b(?:beyond|within)\s+(\d+)\s+days\s+(?:from|after)\s+the scheduled (?:start|date)/i.exec(rules);
  let date = specific ? englishDate(specific[1]) : null;
  if (!date && relative) {
    const ms = Date.parse(scheduledDay + 'T00:00:00Z') + Number(relative[1]) * 86_400_000;
    if (Number.isFinite(ms)) date = new Date(ms).toISOString().slice(0, 10);
  }
  if (!date) return null;
  let timestamp: string | null = null;
  if (specific?.[2]) {
    const hh = Number(specific[2]) % 12 + (specific[4].toUpperCase() === 'PM' ? 12 : 0);
    const timezone = specific[5].toUpperCase() === 'ET' ? 'America/New_York' : 'UTC';
    const label = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(date + 'T12:00:00Z')).find(p => p.type === 'timeZoneName')?.value;
    const offset = label?.slice(3) || 'Z';
    timestamp = iso(`${date}T${String(hh).padStart(2, '0')}:${specific[3]}:59${offset}`);
  }
  return { date, timestamp, text: specific?.[0] ?? relative?.[0] ?? null, unit: timestamp ? 'time' : 'date' };
}

function ruleClauses(rules: string) {
  return rules.replace(/[“”]/g, '"').split(/\n+|(?<=[.!?])\s+(?=(?:If|This market|Otherwise|A super|An outcome|Resolution|The primary|However)\b)/)
    .map(s => s.trim()).filter(Boolean);
}

function marketCheck(market: SportsMarket, snapshot: Snapshot, asOf: string, marketRow: Row) {
  const event: TennisEvent = snapshot;
  const identity = contractIdentity(market);
  const binding = identity ? sameMatch(event, identity) ? 'verified' : 'mismatch' : 'unverified';
  const labels = market.outcomeTokens.map(token => token.label.trim());
  const rule = market.rules.replace(/[“”‘’]/g, '"');
  const clauses = ruleClauses(market.rules);
  const settled = row(market.resolution);
  const gammaResolved = settled.gammaResolutionStatus ?? marketRow.umaResolutionStatus;
  const gammaClosed = settled.gammaClosed ?? marketRow.closed;
  const rawPrices = settled.gammaOutcomePrices ?? marketRow.outcomePrices;
  let prices = items(rawPrices);
  if (typeof rawPrices === 'string') {
    try { prices = items(JSON.parse(rawPrices)); } catch { prices = []; }
  }
  const payouts = prices.map(Number);
  const actualSettlement = gammaResolved === 'resolved' && gammaClosed === true && labels.length === 2 && payouts.length === 2 &&
    (payouts.includes(1) && payouts.includes(0) || payouts.every(p => p === 0.5)) ?
    { basis: 'Polymarket Gamma resolved outcome prices', outcomes: labels.map((label, i) => ({ label, payout: payouts[i] })),
      evidenceId: market.evidenceId } : null;
  const base = { binding, ruleVersion: market.ruleVersion, conditionId: market.conditionId, url: market.url,
    rules: market.rules, ruleEvidenceId: market.evidenceId, clauses, actualSettlement,
    marketTrading: { active: marketRow.active ?? null, closed: marketRow.closed ?? null,
      acceptingOrders: marketRow.acceptingOrders ?? null, evidenceId: market.evidenceId },
    quote: market.quote ?? null, resolutionSource: market.resolutionSource ?? null, outcomeToken: market.outcomeToken ?? null };
  if (binding !== 'verified' || !identity) return { ...base, status: 'pending', reason: '规则所指的双方、赛事和比赛日期需要唯一核对。' };
  if (coverageStatus(snapshot.coverage.state) !== 'covered')
    return { ...base, status: 'pending', reason: '赛事状态不可用或已过期，等待新的比分来源。' };

  const { facts, state } = snapshot;
  const totals = /\b(?:total number of )?sets (played|completed) equals or exceeds (\d+)\b/i.exec(rule);
  const completedCount = facts.sets.filter(set => set.winnerId).length;
  const startedCount = facts.sets.filter(set => set.started).length;
  const completedWinners = facts.sets.filter(set => set.winnerId).map(set => set.winnerId);
  const durationScope = marketDeadline(rule, identity.date);
  const latestFactAt = facts.eventTime ?? facts.stateObservedAt;
  const deadlineReached = Boolean(durationScope?.timestamp && asOf > durationScope.timestamp);
  const rulesRequirePlayByDeadline = /play has not begun by/i.test(rule);
  const timingUnknown = Boolean(durationScope && (deadlineReached || asOf.slice(0, 10) > durationScope.date) &&
    (latestFactAt ? latestFactAt.slice(0, 10) >= durationScope.date : (event.localDate ?? '') >= durationScope.date));
  const half = /50\s*[-–—]\s*50/;
  const relevant = (pattern: RegExp) => clauses.filter(clause => pattern.test(clause));
  const byPlayer = (id: string | null) => {
    const p = event.participants.find(p => p.id === id);
    const other = event.participants.find(x => x.id !== id);
    if (!p || !other) return null;
    const matching = labels.filter(label => (p.aliases.includes(norm(label)) || sameName(norm(label), p)) &&
      !other.aliases.includes(norm(label)) && !sameName(norm(label), other));
    return matching.length === 1 ? matching[0] : null;
  };
  const terminal = finished(state);
  const noPlay = ['walkover', 'cancelled', 'withdrawn_before_play'].includes(state) && facts.started === false;
  const explicitNoPlay = relevant(/cancell?ed|not played at all|walkover/).some(c => half.test(c));
  const settlingFacts = { state, winnerId: facts.winnerId, started: facts.started, completedCount, startedCount,
    completedWinners, sets: facts.sets, bestOf: facts.bestOf, eventTime: facts.eventTime, stateObservedAt: facts.stateObservedAt,
    inputEvidenceIds: snapshot.inputEvidenceIds };
  let kind: string;
  let payout: string | null = null;
  let reason = '当前赛事事实尚未满足条款。';
  let parameters: Row = {};
  if (/\btotal sets\b/i.test(market.title) && totals) {
    kind = 'total_sets';
    const basis = totals[1].toLowerCase();
    const threshold = Number(totals[2]);
    const usesStarted = basis === 'played' && /counts as played once it has begun/i.test(rule);
    const directivesConflict = relevant(/sets (?:played|completed) equals or exceeds/i).some(c =>
      !c.toLowerCase().includes(`sets ${basis} equals or exceeds ${threshold}`)) ||
      basis === 'completed' && /counts as played once it has begun/i.test(rule);
    const irrevocable = /(?:unequivocally|unconditionally) determined/i.test(rule);
    const unconditionalSplit = relevant(/match begins but is not completed/i).some(c =>
      half.test(c) && !/already|unless|unequivocally|unconditionally/i.test(c));
    const enough = labels.find(l => /^over\b/i.test(l)), under = labels.find(l => /^under\b/i.test(l));
    const line = /\bO\/U\s+(\d+(?:\.\d+)?)\b/i.exec(market.title);
    const unsupported = !enough || !under || threshold < 1 || threshold > 5 || directivesConflict ||
      !line || Math.floor(Number(line[1])) + 1 !== threshold || basis === 'played' && !usesStarted || irrevocable && unconditionalSplit;
    const wins = event.participants.map(p => completedWinners.filter(w => w === p.id).length);
    const minimumByFormat = facts.bestOf && wins.length === 2
      ? completedCount + Math.max(0, (facts.bestOf + 1) / 2 - Math.max(...wins)) : null;
    const minimum = minimumByFormat === null ? null : Math.max(usesStarted ? startedCount : completedCount, minimumByFormat);
    const count = usesStarted ? startedCount : completedCount;
    parameters = { countBasis: usesStarted ? 'started' : 'completed', threshold, irrevocable, count,
      minimumIfCompleted: minimum, maximumIfCompleted: facts.bestOf, matchTiebreakCountsAsSet: /super tie breaker.*one/i.test(rule) };
    if (unsupported) return { ...base, status: 'unsupported', kind, parameters, reason: '总盘数条款、选项或盘口之间存在未支持的口径或冲突。' };
    const formatConfirmed = facts.bestOf !== null && completedCount >= (facts.bestOf + 1) / 2 &&
      Math.max(...wins) === (facts.bestOf + 1) / 2 && facts.sets.every(s => !s.started || s.winnerId);
    if (state === 'final' && formatConfirmed) {
      payout = count >= threshold ? enough : under;
      reason = '按该合约的盘计数比较完赛比分。';
    } else if (noPlay && explicitNoPlay) {
      payout = '50-50';
      reason = '原合约双方未开打，按赛前取消条款。';
    } else if ((terminal && facts.started === true || deadlineReached && !terminal) && irrevocable) {
      payout = (count >= threshold || minimum !== null && minimum >= threshold) ? enough
        : facts.bestOf !== null && facts.bestOf < threshold ? under : half.test(rule) ? '50-50' : null;
      reason = '根据停止时已打完的盘和赛制，检查所有可能完赛的结果。';
    } else if (terminal && facts.started === true && unconditionalSplit || deadlineReached && !terminal && half.test(rule)) {
      payout = '50-50';
      reason = '按该子盘的未完赛或到期条款。';
    }
  } else if (/\bcompleted match\b/i.test(market.title) && /all games and sets required.*played to completion through normal play/i.test(rule)) {
    kind = 'completed_match';
    if (/resolve to ["']?yes\b/i.test(rule) && /resolve (?:to )?["']?no\b/i.test(rule)) {
      const contrary = relevant(/(?:forfeit|walkover|retirement|cancell?ed)/i).some(c => /resolve (?:to )?["']?yes\b/i.test(c) &&
        !/all games and sets required/i.test(c));
      if (contrary) return { ...base, kind, status: 'pending', reason: '完赛与弃权条款需要复核。' };
      const won = completedWinners.filter(id => id === facts.winnerId).length;
      if (state === 'final' && facts.bestOf !== null && won === (facts.bestOf + 1) / 2 &&
          facts.sets.every(s => !s.started || s.winnerId)) {
        payout = labels.find(l => /^yes$/i.test(l)) ?? null;
        reason = '比分达到该轮赛制的完赛要求。';
      } else if (terminal && state !== 'final' || deadlineReached && !terminal) {
        payout = labels.find(l => /^no$/i.test(l)) ?? null;
        reason = '官方状态表明未通过正常比赛完成。';
      }
    }
  } else if (/\bset\s+\d+\s+winner\b/i.test(market.title)) {
    kind = 'set_winner';
    const n = Number(/\bset\s+(\d+)\s+winner\b/i.exec(market.title)?.[1]);
    parameters = { set: n };
    const names = (['first', 'second', 'third', 'fourth', 'fifth'][n - 1] ?? '');
    const scope = new RegExp(`wins (?:the (?:${names || '$^'} )?set(?: ${n})?|set ${n})\\b`, 'i');
    const exact = new RegExp(`wins (?:the ${names || '$^'} set|(?:the )?set ${n})\\b`, 'i');
    const conflicting = relevant(/wins (?:the )?(?:first |second |third |fourth |fifth )?set\b/i)
      .some(c => !scope.test(c) || !exact.test(c));
    if (!names || !exact.test(rule) || conflicting) return { ...base, kind, parameters, status: 'pending', reason: '指定单盘条款需要复核。' };
    const winnerId = facts.sets.find(set => set.number === n)?.winnerId ?? null;
    payout = byPlayer(winnerId);
    if (payout) reason = '按该子盘指定的已经打完的一盘。';
    else if ((terminal || deadlineReached && (!rulesRequirePlayByDeadline || facts.started === false)) &&
        relevant(/not completed|not played|before set|play has not begun/i).some(c => half.test(c))) {
      payout = '50-50';
      reason = '该盘未完成，按明文 50–50。';
    }
  } else if (/\badvances against\b/i.test(rule) && labels.length === 2 &&
      event.participants.every(p => byPlayer(p.id))) {
    kind = 'match_winner';
    const walkover = relevant(/ends in a walkover/i);
    const retirement = relevant(/opponent['’]s retirement|due to retirement/i);
    if (walkover.some(c => half.test(c)) && walkover.some(c => /player who (?:officially )?advances/i.test(c)) ||
      retirement.some(c => half.test(c)) && retirement.some(c => /player who (?:officially )?advances/i.test(c)))
      return { ...base, status: 'pending', kind, reason: '行政晋级和退款条款冲突。' };
    if (state === 'walkover') {
      payout = walkover.some(c => half.test(c)) ? '50-50'
        : walkover.some(c => /player who (?:officially )?advances/i.test(c)) ? byPlayer(facts.winnerId) : null;
      reason = '按该子盘的赛前 walkover 条款。';
    } else if (state === 'retired' || state === 'defaulted' || state === 'final') {
      payout = state !== 'final' && retirement.some(c => half.test(c)) ? '50-50' : byPlayer(facts.winnerId);
      reason = '按该子盘核对官方胜者或晋级者。';
    } else if (noPlay && explicitNoPlay || deadlineReached && !terminal && half.test(rule)) {
      payout = '50-50';
      reason = '按该子盘的取消或到期条款。';
    }
  } else {
    return { ...base, status: 'unsupported', reason: '该子盘没有已支持并可确定的条款口径。' };
  }
  if (payout && timingUnknown && !noPlay) {
    payout = null;
    reason = '当前来源无法确定关键赛事结果是否在条款截止时已成立。';
  }
  return { ...base, kind, parameters, deadline: durationScope, status: payout ? 'determined' : 'pending',
    derivation: { payout, reason, facts: settlingFacts }, mayStillChange: !terminal && !deadlineReached };
}

function channelRows(html: string) {
  return flightRows(html, r => typeof r.slug === 'string' && typeof r.status === 'string' &&
    (r.homeCompetitor != null || r.awayCompetitor != null) && typeof r.eventCategory === 'string');
}

function channelRaw(raw: Row) {
  const publicFacts = ['slug', 'matchScoreKey', 'id', 'status', 'statusLabel', 'round', 'startTime', 'startTimeConfirmed',
    'actualStartTime', 'endTime', 'updatedAt', 'venue', 'tournament', 'tournamentSlug', 'tournamentName',
    'tournamentOfficialName', 'tournamentTimezone', 'tournamentCity', 'tournamentLevel', 'level', 'competitionCategory',
    'eventCategory', 'homeTeam', 'awayTeam', 'winnerId', 'score', 'liveDataPending'];
  const participants = Object.fromEntries(['homeCompetitor', 'awayCompetitor'].map(side => {
    const p = row(raw[side]);
    return [side, { id: p.id, name: p.name, shortName: p.shortName, countryCode: p.countryCode }];
  }));
  const overall = items(row(raw.statistics).sections).map(row).find(section => section.key === 'overall');
  const serve = items(overall?.entries).map(row).find(entry => entry.key === 'first_serve_pct');
  return { ...Object.fromEntries(publicFacts.filter(key => key in raw).map(key => [key, raw[key]])), ...participants,
    firstServePercent: serve && [str(row(serve.home).display), str(row(serve.away).display)] };
}

function espnRows(body: string, tour: 'atp' | 'wta', url: string) {
  const tournaments = JSON.parse(body).events;
  if (!Array.isArray(tournaments)) throw Error('invalid_scoreboard');
  return tournaments.flatMap((t: Row) => items(t.groupings).flatMap(group =>
    items(row(group).competitions).flatMap(value => {
      const match = row(value);
      const event = espnEvent(tour, t, match, url);
      if (!event) return [];
      const raw = { ...match, competitors: items(match.competitors).map(side => {
        const p = row(side);
        return { id: p.id, order: p.order, winner: p.winner, linescores: p.linescores, athlete: p.athlete };
      }) };
      return [{ event, raw }];
    }))) as { event: TennisEvent; raw: Row }[];
}

function wtaRows(body: string, meta?: string) {
  const parsed = JSON.parse(body);
  const tournament = meta ? row(JSON.parse(meta)) : {};
  const matches = Array.isArray(parsed) ? parsed : parsed.matches;
  if (!Array.isArray(matches)) throw Error('invalid_wta_score');
  return matches.flatMap((raw: Row) => {
    const event = wtaEvent(raw, raw.Tournament ? row(raw.Tournament) : tournament);
    return event ? [{ event, raw }] : [];
  });
}

function capture(rowValue: SportsEvidence) {
  const stored = rowValue.data as Partial<Capture> | null;
  if (stored?.kind !== sourceKind || !stored.event?.eventKey || !stored.raw || !stored.read) return null;
  if (stored.read === 'wta-oop' && (!rowValue.source.startsWith(wta) || !rowValue.source.endsWith('/oop'))) return null;
  if (stored.read !== 'wta-oop' && (stored.read === 'wta-score' ? !rowValue.source.startsWith(wta) :
    stored.read === 'tennis-channel' ? !rowValue.source.startsWith(tennis) :
      stored.read === 'espn' ? !rowValue.source.startsWith(espn) :
        stored.read === 'bonn' ? !rowValue.source.startsWith(bonn) : true)) return null;
  return stored as Capture;
}

function fromCapture(stored: Capture): Data | null {
  const { event, raw } = stored;
  if (stored.read === 'wta-score') return wtaData(event, raw);
  if (stored.read === 'tennis-channel') return channelData(event, raw);
  if (stored.read === 'espn') return espnData(event, raw);
  if (stored.read === 'bonn') return { event, state: 'withdrawn_before_play', startedAt: null,
    facts: { ...emptyFacts(event), started: false, sourceState: 'main draw replacement', sourceResult: str(raw.announcement),
      bestOf: 3 } };
  return null;
}

function replaySources(input: SportsFindInput) {
  return (input.sourceEvidence ?? []).flatMap(evidence => {
    const stored = capture(evidence);
    return stored && evidence.retrievedAt <= input.asOf ? [{ evidence, stored }] : [];
  });
}

function namedPair(query: string) {
  const both = query.split(/\s+(?:vs?\.?|versus)\s+|\s*(?:对阵|对战)\s*/i);
  return both.length === 2 ? both.map(norm) : null;
}

function queryMatches(event: TennisEvent, query: string) {
  const text = norm(query), pair = namedPair(query);
  const matching = (p: Player, q: string) => p.aliases.some(n => (n.length >= 2 || /\p{Script=Han}/u.test(n)) && phrase(q, n));
  if (pair) {
    const [a, b] = event.participants;
    return matching(a, pair[0]) && matching(b, pair[1]) || matching(b, pair[0]) && matching(a, pair[1]);
  }
  if (event.participants.some(p => matching(p, text))) return true;
  const requestedCompetition = norm(query.replace(dayPattern, '').replace(/\b(?:atp|wta|singles|schedule)\b/gi, '')
    .replace(/(?:赛程|单打|赛事|今天)/g, ''));
  return competitionNames(event.competition).includes(requestedCompetition);
}

function endpointKey(value: string) {
  const w = /^tennis:wta:(20\d\d)\.(\d{2,5})\.([LR]S\d{3,10})$/.exec(value);
  if (w) return { type: 'wta' as const, year: w[1], eventId: w[2], matchId: w[3],
    url: `${wta}tournaments/${w[2]}/${w[1]}/matches/${w[3]}/score` };
  const t = /^tennis:tc:([a-z\d-]{1,90})\.([a-z\d-]{1,90})$/.exec(value);
  if (t && t[1].length + t[2].length < 128) return { type: 'tc' as const, tournament: t[1], match: t[2],
    url: `${tennis}tournaments/${t[1]}/matches/${t[2]}` };
  const e = /^tennis:espn:(atp|wta)\.(\d+-20\d\d)\.(20\d\d-\d\d-\d\d)\.(\d+)$/.exec(value);
  if (e) return { type: 'espn' as const, tour: e[1] as 'atp' | 'wta',
    url: `${espn}${e[1]}/scoreboard?dates=${e[3].replaceAll('-', '')}` };
  const b = /^tennis:bonn:(20\d\d)-\d\d-\d\d\.[a-z\d-]+\.[a-z\d-]+$/.exec(value);
  if (b) return { type: 'bonn' as const, url: bonn + b[1] };
  return null;
}

function tennisLink(query: string) {
  const matched = /https:\/\/www\.tennis\.com\/tournaments\/([a-z\d-]{1,90})(?:\/matches\/([a-z\d-]{1,90}))?/i.exec(query);
  return matched && { tournament: matched[1], match: matched[2] };
}

function wtaLink(query: string) {
  const api = /https:\/\/api\.wtatennis\.com\/tennis\/tournaments\/(\d{2,5})\/(20\d\d)(?:\/matches\/([LR]S\d{3,10})\/score)?/i.exec(query);
  if (api) return { tournament: api[1], year: api[2], match: api[3]?.toUpperCase() };
  const site = /https:\/\/www\.wtatennis\.com\/tournaments\/(\d{2,5})\/[a-z\d-]+\/(20\d\d)(?:\/scores\/([LR]S\d{3,10}))?/i.exec(query);
  if (site) return { tournament: site[1], year: site[2], match: site[3]?.toUpperCase() };
  const explicit = /\bWTA(?:\s+125)?\s+(\d{2,5})\s+(20\d\d)\b/i.exec(query);
  return explicit ? { tournament: explicit[1], year: explicit[2], match: undefined } : null;
}

function stateCoverage(data: Data, score: SportsEvidence, stored: Capture, purpose: 'live' | 'replay'): SportsCoverage {
  const { facts, state } = data;
  const observed = facts.stateObservedAt;
  const retrieved = Date.parse(score.retrievedAt);
  const isLive = state === 'live' || state === 'suspended';
  const serverAge = stored.responseDate ? (retrieved - Date.parse(stored.responseDate)) / 1000 : null;
  const activeAge = observed ? (retrieved - Date.parse(observed)) / 1000 : null;
  const stale = !finished(state) && ((stored.cacheAge ?? 0) > 120 || serverAge !== null && serverAge > 180 ||
    isLive && activeAge !== null && (activeAge < -30 || activeAge > (state === 'suspended' ? 1800 : 420)));
  const badState = stale ? coverage('stale', '源时间或缓存超出该状态的时效窗口。', score.evidenceId)
    : state === 'unknown' ? coverage('pending', '源状态码尚不能确认。', score.evidenceId) : 'covered';
  const target = (available: boolean, reason: string) => stale ? badState : available ? 'covered' : coverage('unavailable', reason, score.evidenceId);
  return {
    identity: 'covered', state: badState,
    feedFreshness: isLive && !observed && !stale
      ? coverage('partial', '抓取有效，但源未给本场比分更新时间。', score.evidenceId) : badState,
    score: target(facts.sets.some(set => set.started), '这一场尚无可核查的已打盘局分。'),
    currentPoints: target(Boolean(facts.game), '本次快照没有正在打的一局的分数。'),
    server: target(Boolean(facts.game?.serverId), '本次快照没有可确认发球方。'),
    tiebreak: target(facts.game?.tiebreak != null || facts.sets.some(s => s.tiebreak.some(v => v !== null)),
      '本次快照没有明确抢七计分。'),
    pointHistory: coverage('unavailable', '源提供有限快照，缺少连续且带事件时间的全量逐分。', score.evidenceId),
    actualStart: !stale && data.startedAt && stored.read === 'wta-score'
      ? coverage('partial', '有 WTA 赛况记录的 MatchTimeStamp，来源未明确它是否等于第一分。', score.evidenceId)
      : target(Boolean(data.startedAt) && facts.started === true, '源未单列第一分时刻。开打状态可独立于时间核查。'),
    transitionTime: target(Boolean(facts.eventTime), '没有明确的状态变化事件时间，只有抓取或源更新时间。'),
    suspensionReason: target(Boolean(facts.suspensionReason), '源未说明停赛原因。'),
    settlementSource: stored.read === 'espn' || stored.read === 'tennis-channel' ?
      coverage('partial', '比分来源是公开比分转报。需要赛事官网、签表或组委会独立确认。', score.evidenceId) : 'covered',
    liveReminders: purpose === 'replay' ? coverage('unsupported', '历史回放只验证变化，不建立实时提醒。', score.evidenceId)
      : finished(state) ? coverage('unsupported', '比赛已结束。', score.evidenceId) : badState,
  };
}

function coverageStatus(value: SportsCoverage[string]) {
  return typeof value === 'string' ? value : value?.status;
}

function samePlayers(a: TennisEvent, b: TennisEvent) {
  return a.participants.every(p => b.participants.some(q => norm(p.name) === norm(q.name)));
}

export function createTennisSports(host: SportsHost): SportsAdapter<Snapshot, Baseline> {
  const save = (url: string, read: Capture['read'], event: TennisEvent, raw: Row,
    captured: Awaited<ReturnType<typeof readSource>>) => host.saveEvidence(url,
      { kind: sourceKind, read, event, raw, responseDate: captured.responseDate, cacheAge: captured.cacheAge } satisfies Capture,
      captured.retrievedAt);
  const readSource = readTennisSource;

  async function attempt<T>(url: string, signal: AbortSignal, operation: () => Promise<T>, failures: SportsEvidence[]) {
    try { return await operation(); }
    catch (error) {
      signal.throwIfAborted();
      const e = error as Error & { cause?: { code?: string } };
      failures.push(host.saveEvidence(url, { kind: 'tennis_source_gap', reason: e.cause?.code ?? e.message }));
      return null;
    }
  }

  async function sourceFor(key: string, failures: SportsEvidence[], signal: AbortSignal, event?: TennisEvent) {
    const endpoint = endpointKey(key);
    if (!endpoint) return null;
    return attempt(endpoint.url, signal, async () => {
      if (endpoint.type === 'wta') {
        const captured = await readSource(endpoint.url, signal);
        const parsed = JSON.parse(captured.body);
        if (!Array.isArray(parsed)) throw Error('invalid_wta_match');
        const raw = parsed.map(row).filter(r => str(r.MatchID) === endpoint.matchId &&
          str(r.EventID) === endpoint.eventId && str(r.EventYear) === endpoint.year && r.DrawMatchType === 'S')
          .toSorted((a, b) => (iso(b.LastUpdated) ?? '').localeCompare(iso(a.LastUpdated) ?? ''))[0];
        if (!raw) throw Error('match_identity_missing');
        const meta = raw.Tournament || !event
          ? raw.Tournament ?? JSON.parse((await readSource(`${wta}tournaments/${endpoint.eventId}/${endpoint.year}`, signal)).body)
          : { title: event.competition, city: event.tournamentCity, level: event.tour, surface: event.surface };
        const selected = wtaEvent(raw, row(meta));
        if (!selected || selected.eventKey !== key) throw Error('match_identity_missing');
        return save(endpoint.url, 'wta-score', selected, raw, captured);
      }
      if (endpoint.type === 'tc') {
        const captured = await readSource(endpoint.url + '?_snapshot=' + Math.floor(Date.now() / 60_000), signal);
        const matches = channelRows(captured.body);
        const raw = matches.find(r => str(r.slug) === endpoint.match &&
          str(r.tournamentSlug ?? row(r.tournament).slug) === endpoint.tournament);
        const selected = raw && channelEvent(raw);
        if (!raw || !selected || selected.eventKey !== key) throw Error('match_identity_missing');
        if (!selected.timezone && event?.timezone) selected.timezone = event.timezone;
        return save(endpoint.url, 'tennis-channel', selected, channelRaw(raw), captured);
      }
      if (endpoint.type === 'bonn') {
        const captured = await readSource(endpoint.url, signal);
        const selected = bonnWithdrawals(captured.body, key.slice('tennis:bonn:'.length, 'tennis:bonn:'.length + 4))
          .find(r => r.event.eventKey === key);
        if (!selected) throw Error('organizer_replacement_not_verified');
        return save(endpoint.url, 'bonn', selected.event, selected.raw, captured);
      }
      const url = endpoint.url;
      const captured = await readSource(url, signal);
      const selected = espnRows(captured.body, endpoint.tour, url).find(r => r.event.eventKey === key);
      if (!selected) throw Error('match_identity_missing');
      return save(url, 'espn', selected.event, selected.raw, captured);
    }, failures);
  }

  async function find(input: SportsFindInput, signal: AbortSignal) {
    const query = input.query?.trim() ?? '';
    const market = input.market && contractIdentity(input.market);
    const exactWta = wtaLink(query);
    const exactTennis = tennisLink(query);
    const extractedKey = exactWta?.match ? `tennis:wta:${exactWta.year}.${exactWta.tournament}.${exactWta.match}`
      : exactTennis?.match ? `tennis:tc:${exactTennis.tournament}.${exactTennis.match}` : null;
    const key = input.eventKey ?? extractedKey;
    const failures: SportsEvidence[] = [];
    if (input.mode === 'replay') {
      const saved = replaySources(input).filter(({ stored }) => stored.read !== 'wta-oop' &&
        (key ? stored.event.eventKey === key : market ? sameMatch(stored.event, market) : queryMatches(stored.event, query)));
      const events = [...new Map(saved.map(({ stored }) => [stored.event.eventKey, stored.event])).values()];
      return { candidates: events, coverage: { discovery: events.length ? 'covered' : coverage('unavailable', '回放证据没有匹配的赛事。') } satisfies SportsCoverage,
        inputEvidenceIds: saved.map(({ evidence }) => evidence.evidenceId) };
    }
    if (key) {
      const proof = await sourceFor(key, failures, signal);
      const event = proof && capture(proof)?.event;
      return { candidates: event ? [event] : [], coverage: { discovery: event ? 'covered' :
        coverage('unavailable', '指定赛事的身份源暂未返回可核对记录。', failures.at(-1)?.evidenceId) } satisfies SportsCoverage,
        inputEvidenceIds: proof ? [proof.evidenceId] : failures.map(e => e.evidenceId) };
    }

    const date = market?.date ?? dayPattern.exec(query)?.[0];
    const searchTour = input.market?.eventSlug?.startsWith('atp-') || /\batp\b/i.test(query) ? 'atp'
      : input.market?.eventSlug?.startsWith('wta-') || /\bwta\b/i.test(query) ? 'wta' : null;
    const accepts = (event: TennisEvent) => {
      const isWta = event.tour.startsWith('WTA');
      if (searchTour && (searchTour === 'wta') !== isWta) return false;
      if (market) return sameMatch(event, market);
      if (input.market && !query) return false;
      if (date && event.localDate !== date) return false;
      return exactWta || exactTennis ? query.replace(/https:\/\/\S+/g, '').replace(/\bWTA(?:\s+125)?\s+\d{2,5}\s+20\d\d\b/i, '').replace(dayPattern, '').trim()
        ? queryMatches(event, query) : true : queryMatches(event, query);
    };
    const discovered: { event: TennisEvent; raw: Row; url: string; type: Capture['read'];
      captured: Awaited<ReturnType<typeof readSource>> }[] = [];
    const requests: Promise<unknown>[] = [];
    if (searchTour !== 'atp' && !exactTennis) {
      const path = exactWta ? `tournaments/${exactWta.tournament}/${exactWta.year}` : null;
      const url = path ? wta + path + '/matches' : wta + 'matches/global';
      requests.push(attempt(url, signal, async () => {
        const [captured, meta] = await Promise.all([readSource(url, signal), path ? readSource(wta + path, signal) : null]);
        for (const r of wtaRows(captured.body, meta?.body).filter(r => accepts(r.event))) {
          discovered.push({ ...r, type: 'wta-score', url, captured });
        }
      }, failures));
    }
    if (!exactWta) {
      const historicalSlug = market ? ({ 'st tropez': 'saint-tropez-open', 'saint tropez': 'saint-tropez-open',
        cincinnati: 'cincinnati-open', bonn: 'bonn-open' } as Record<string, string>)[norm(market.competition)] : null;
      const competitionPath = exactTennis?.tournament ?? historicalSlug;
      const url = competitionPath ? `${tennis}tournaments/${competitionPath}${date ? '?date=' + date : ''}` : tennis;
      requests.push(attempt(url, signal, async () => {
        const captured = await readSource(url, signal);
        for (const raw of channelRows(captured.body)) {
          const event = channelEvent(raw, competitionPath ?? undefined);
          if (event && accepts(event)) discovered.push({ event, raw: channelRaw(raw), url, type: 'tennis-channel', captured });
        }
      }, failures));
      if (date && (market ? norm(market.competition) === 'bonn' : /\bbonn\b|波恩/i.test(query))) {
        const url = bonn + date.slice(0, 4);
        requests.push(attempt(url, signal, async () => {
          const captured = await readSource(url, signal);
          for (const value of bonnWithdrawals(captured.body, date.slice(0, 4)).filter(r => accepts(r.event))) {
            discovered.push({ ...value, type: 'bonn', url, captured });
          }
        }, failures));
      }
      if (date && !exactTennis) {
        for (const tour of searchTour ? [searchTour] as const : ['atp', 'wta'] as const) {
          const url = `${espn}${tour}/scoreboard?dates=${date.replaceAll('-', '')}`;
          requests.push(attempt(url, signal, async () => {
            const captured = await readSource(url, signal);
            for (const r of espnRows(captured.body, tour, url).filter(r => accepts(r.event))) {
              discovered.push({ ...r, type: 'espn', url, captured });
            }
          }, failures));
        }
      }
    }
    await Promise.all(requests);
    const preference = { 'wta-score': 0, 'bonn': 0, 'tennis-channel': 1, espn: 2, 'wta-oop': 3 };
    let selected = discovered.toSorted((a, b) => preference[a.type] - preference[b.type]);
    selected = selected.filter((a, i) => !selected.slice(0, i).some(b => a.event.eventKey === b.event.eventKey ||
      a.type !== b.type && a.event.localDate === b.event.localDate && sameCompetition(a.event.competition, b.event.competition) &&
      a.event.round === b.event.round && samePlayers(a.event, b.event)));
    if (!market && /下场|下一场|next match|何时开赛/i.test(query)) {
      selected = selected.filter(a => !finished(fromCapture({ kind: sourceKind, read: a.type, event: a.event,
        raw: a.raw, responseDate: a.captured.responseDate, cacheAge: a.captured.cacheAge })?.state ?? 'unknown'));
      const targets = unique(selected.flatMap(a => a.event.participants
        .filter(p => p.aliases.some(n => phrase(norm(query), n))).map(p => norm(p.name))));
      const earliest = selected.map(a => a.event.localDate).filter((d): d is string => Boolean(d)).sort()[0];
      if (targets.length === 1 && earliest) selected = selected.filter(a => !a.event.localDate || a.event.localDate === earliest);
    }
    const short = selected.slice(0, 16);
    const evidence = short.map(r => save(r.url, r.type, r.event, r.raw, r.captured));
    const status = short.length ? failures.length ? coverage('partial', '部分比分源未返回。', failures[0].evidenceId) : 'covered'
      : coverage('unavailable', market ? '未在可读赛程或组委会记录中唯一绑定规则双方。'
        : '查询窗口未找到可绑定的单打。旧赛请补日期或官方赛事中心链接。', failures[0]?.evidenceId);
    return { candidates: short.map(r => r.event), coverage: { discovery: status } satisfies SportsCoverage,
      inputEvidenceIds: [...evidence, ...failures].map(e => e.evidenceId) };
  }

  async function inspect(input: SportsInspectInput, signal: AbortSignal): Promise<Snapshot> {
    const event = input.event as TennisEvent;
    const key = endpointKey(event.eventKey);
    const failures: SportsEvidence[] = [];
    let score: SportsEvidence | null = null;
    let schedule: { schedule: Schedule; raw: Row } | undefined;
    let scheduleProof: SportsEvidence | undefined;
    if (input.mode === 'replay') {
      const candidates = replaySources(input).filter(r => r.stored.event.eventKey === event.eventKey)
        .toSorted((a, b) => b.evidence.retrievedAt.localeCompare(a.evidence.retrievedAt));
      score = candidates.find(r => r.stored.read !== 'wta-oop')?.evidence ?? null;
      const oop = candidates.find(r => r.stored.read === 'wta-oop');
      if (oop?.stored.raw.schedule && typeof oop.stored.raw.schedule === 'object') {
        scheduleProof = oop.evidence;
        schedule = { schedule: oop.stored.raw.schedule as Schedule, raw: oop.stored.raw };
      }
    } else {
      const scorePromise = sourceFor(event.eventKey, failures, signal, event);
      if (key?.type === 'wta') {
        const url = `${wta}tournaments/${key.eventId}/${key.year}/oop`;
        const oop = await attempt(url, signal, async () => {
          const captured = await readSource(url, signal);
          const selected = wtaSchedule(row(JSON.parse(captured.body)), key.matchId);
          if (!selected) throw Error('match_not_in_order_of_play');
          return { selected, captured };
        }, failures);
        if (oop) {
          schedule = oop.selected;
          if (str(event.timezone)) schedule.schedule.timezone = str(event.timezone);
          scheduleProof = save(url, 'wta-oop', event, { ...schedule.raw, schedule: schedule.schedule }, oop.captured);
        }
      }
      score = await scorePromise;
    }
    const stored = score && capture(score);
    const data = stored && samePlayers(event, stored.event) ? fromCapture(stored) : null;
    const result = data?.facts ?? emptyFacts(event);
    const sources: TennisFacts['sources'] = [];
    const c: SportsCoverage = score && stored && data ? stateCoverage(data, score, stored, input.mode)
      : { identity: 'covered', state: coverage('unavailable', '比分源暂未核对到同一场比赛。', failures.at(-1)?.evidenceId),
          score: 'unavailable', currentPoints: 'unavailable', server: 'unavailable', pointHistory: 'unavailable',
          actualStart: 'unavailable', liveReminders: 'unavailable' };
    if (score && data) sources.push({ url: score.source, retrievedAt: score.retrievedAt, observedAt: result.stateObservedAt,
      evidenceId: score.evidenceId, fields: ['identity', 'state', 'score', 'currentPoints', 'server', 'actualStart', 'winner'] });
    if (schedule && scheduleProof) {
      result.schedule = schedule.schedule;
      sources.push({ url: scheduleProof.source, retrievedAt: scheduleProof.retrievedAt, observedAt: null,
        evidenceId: scheduleProof.evidenceId, fields: ['schedule', 'order_of_play', 'court', 'previous_match'] });
    }
    c.schedule = scheduleProof ? 'covered' : result.schedule?.scheduledAt || result.schedule?.earliestAt
      ? coverage('partial', '只有比分源排程，缺正式 Order of Play 时间口径或前序场。', score?.evidenceId)
      : coverage('unavailable', '未读取到本场排程。', failures.find(e => e.source.endsWith('/oop'))?.evidenceId);
    const snapshot: Snapshot = { ...data?.event ?? event,
      localDate: result.schedule?.localDate ?? data?.event.localDate ?? event.localDate, scheduledAt: result.schedule?.scheduledAt ?? null,
      startedAt: data?.startedAt ?? null, state: data?.state ?? 'unknown',
      facts: { ...result, pointHistory: 'unavailable', observedAt: score?.retrievedAt ?? null, sources },
      coverage: c, inputEvidenceIds: [...(score ? [score.evidenceId] : []), ...(scheduleProof ? [scheduleProof.evidenceId] : []),
        ...failures.map(e => e.evidenceId)] };
    if (input.market) {
      const raw = row(row(host.loadEvidence(input.market.evidenceId)?.data).response);
      snapshot.market = marketCheck(input.market, snapshot, input.asOf, raw);
      c.marketRules = row(snapshot.market).status === 'determined' ? 'covered'
        : coverage('pending', str(row(row(snapshot.market).derivation).reason ?? row(snapshot.market).reason) || '等待规则所需事实。', input.market.evidenceId);
    }
    return snapshot;
  }

  return { sport: 'tennis', find, inspect, prepareWatch, changes };
}

function conditionSupport(snapshot: Snapshot, condition: SportsCondition, preparing: boolean): SportsCoverage[string] {
  const key = condition.kind as ConditionKind;
  if (!conditionKinds.includes(key)) return coverage('unsupported', '该网球提醒条件未实现。');
  if (condition.set !== undefined && (key !== 'set_completed' && key !== 'break_of_serve' ||
      typeof condition.set !== 'number' || !Number.isInteger(condition.set) || condition.set < 1 ||
      condition.set > (snapshot.facts.bestOf ?? 5))) return coverage('unsupported', 'set 只适用于盘结束或破发，须是该轮赛制内的整数。');
  if (condition.player_id !== undefined && (key !== 'set_completed' && key !== 'break_of_serve' ||
      !snapshot.participants.some(p => p.id === condition.player_id))) return coverage('unsupported', 'player_id 必须是本场参赛者 ID。');
  if (Object.keys(condition).some(name => !['kind', 'set', 'player_id'].includes(name)))
    return coverage('unsupported', '当前支持 kind、set 和 player_id。');
  if (key === 'schedule_changed') return snapshot.facts.schedule && (snapshot.facts.schedule.kind !== 'unknown' ||
    snapshot.facts.schedule.court || snapshot.facts.schedule.localDate) ? snapshot.coverage.schedule
    : coverage('unavailable', '本场暂缺可作比较的排程。');
  if (coverageStatus(snapshot.coverage.state) !== 'covered') return snapshot.coverage.state;
  if (preparing && finished(snapshot.state)) return coverage('unsupported', '比赛已结束，历史快照可用于复查。');
  if (key === 'match_started' && preparing && snapshot.facts.started === true)
    return coverage('unsupported', '本场已有开打证据，无法订阅过去的开打。');
  if (key === 'break_of_serve' && (!snapshot.facts.game?.serverId || snapshot.facts.game.tiebreak !== false ||
      coverageStatus(snapshot.coverage.score) !== 'covered'))
    return coverage('unavailable', '需要当前盘局分、正常发球局及可核对发球方。', snapshot.facts.sources[0]?.evidenceId);
  if (key === 'set_completed') {
    if (preparing && typeof condition.set === 'number' && snapshot.facts.sets.some(s => s.number === condition.set && s.winnerId))
      return coverage('unsupported', '指定的盘已经打完。');
    if (snapshot.facts.bestOf === null && !snapshot.facts.sets.some(s => s.winnerId))
      return coverage('pending', '缺少该轮赛制或源明确确认的盘胜者。', snapshot.facts.sources[0]?.evidenceId);
  }
  return 'covered';
}

function prepareWatch(snapshot: Snapshot, conditions: SportsCondition[]) {
  const acceptedConditions: SportsCondition[] = [];
  const blockedConditions: { condition: SportsCondition; reason: string }[] = [];
  for (const condition of conditions) {
    const value = conditionSupport(snapshot, condition, true);
    const usable = value === 'covered' || coverageStatus(value) === 'partial' && condition.kind === 'schedule_changed';
    if (usable && coverageStatus(snapshot.coverage.liveReminders) !== 'unsupported' && !finished(snapshot.state)) {
      acceptedConditions.push(condition);
    } else {
      blockedConditions.push({ condition, reason: (typeof value === 'object' ? value.reason : null) ??
        '本次快照无法建立实时提醒。' });
    }
  }
  return { acceptedConditions, blockedConditions, minIntervalSeconds: 60,
    sources: unique(snapshot.facts.sources.map(source => source.url)) };
}

function changes(previous: Baseline | undefined, current: Snapshot, draft: SportsWatchDraft): SportsChanges<Baseline> {
  const baseline: Baseline = { ...previous };
  const events: SportsEventChange[] = [];
  const covered: SportsCoverage = {};
  if (current.eventKey !== draft.eventKey) return { baseline, events, coverage: { identity: 'unavailable' } };
  const { facts, state } = current;
  const matchup = current.participants.map(p => p.name).join(' vs ');
  const describe = (id: string) => current.participants.find(p => p.id === id)?.name ?? id;
  const stillFits = (conditions: SportsCondition[], set?: number, playerId?: string) => conditions.some(c =>
    (c.set === undefined || c.set === set) && (c.player_id === undefined || c.player_id === playerId));

  for (const kind of conditionKinds) {
    const conditions = draft.conditions.filter(c => c.kind === kind);
    if (!conditions.length) continue;
    const cover = conditionSupport(current, conditions[0], false);
    covered[kind] = cover;
    const status = coverageStatus(cover);
    if (status !== 'covered' && !(status === 'partial' && kind === 'schedule_changed')) continue;

    const source = kind === 'schedule_changed'
      ? facts.sources.find(s => s.fields.includes('order_of_play')) ?? facts.sources.find(s => s.fields.includes('state'))
      : facts.sources.find(s => s.fields.includes('state'));
    if (!source || !current.inputEvidenceIds.includes(source.evidenceId)) continue;
    const old = previous?.[kind];
    const value = kind === 'schedule_changed' ? fingerprint(facts.schedule) : kind === 'set_completed'
      ? fingerprint(facts.sets.filter(set => set.winnerId).map(set => [set.number, set.winnerId])) : kind === 'break_of_serve'
        ? fingerprint([facts.activeSet, facts.sets, facts.game]) : fingerprint([state, facts.started]);
    const version = source.observedAt;
    if (old && (source.retrievedAt < old.retrievedAt ||
      version && old.version && version < old.version ||
      version && old.version && version === old.version && value !== old.value)) {
      covered[kind] = coverage('stale', '比分状态版本早于或冲突于最近有效基线。', source.evidenceId);
      continue;
    }
    if (old && value === old.value) {
      baseline[kind] = { ...old, version, retrievedAt: source.retrievedAt, evidenceId: source.evidenceId };
      continue;
    }
    if (old && !version && kind === 'set_completed' && old.sets.some(before => before.winnerId &&
      !facts.sets.some(after => after.number === before.number && after.winnerId === before.winnerId))) {
      covered[kind] = coverage('pending', '已完赛盘发生回滚且比分源未提供修订时间。', source.evidenceId);
      continue;
    }
    if (old && !version && finished(old.state) && !finished(state)) continue;

    baseline[kind] = { value, version, retrievedAt: source.retrievedAt, evidenceId: source.evidenceId, state,
      activeSet: facts.activeSet, sets: facts.sets, game: facts.game, schedule: facts.schedule };
    if (!old) continue;
    const add = (id: unknown, summary: string, occurredAt: string | null = null) => events.push({
      kind, eventKey: fingerprint([current.eventKey, kind, id]), occurredAt, summary: `${matchup} · ${summary}`,
      sourceUrl: source.url, inputEvidenceIds: unique([old.evidenceId, source.evidenceId]),
    });
    if (kind === 'schedule_changed' && facts.schedule && old.schedule && !finished(state)) {
      if (old.schedule.kind !== facts.schedule.kind && status === 'partial') continue;
      const scheduleLabel = (item: Schedule) => [item.localDate, item.localTime, item.timezone,
        item.text ?? item.kind, item.court, item.previous?.matchup].filter(Boolean).join(' · ');
      add([old.value, value], `赛程变更，原 ${scheduleLabel(old.schedule)}，现 ${scheduleLabel(facts.schedule)}。`);
    } else if (kind === 'match_started' && ['scheduled', 'warmup', 'postponed'].includes(old.state) &&
        facts.started === true && played(state)) {
      add('first_play', '赛事来源已确认开打。', facts.startTimeBasis === 'Tennis Channel actualStartTime' ? current.startedAt : null);
    } else if (kind === 'match_suspended' && old.state === 'live' && state === 'suspended') {
      add(version ?? old.value + ':' + value, facts.suspensionReason ? `赛事暂停，${facts.suspensionReason}。` : '赛事暂停，来源未说明原因。', facts.eventTime);
    } else if (kind === 'match_resumed' && old.state === 'suspended' && state === 'live') {
      add(version ?? old.value + ':' + value, '赛事恢复比赛。', facts.eventTime);
    } else if (kind === 'retirement' && old.state !== 'retired' && state === 'retired') {
      const retired = current.participants.find(p => facts.winnerId && p.id !== facts.winnerId);
      const score = facts.sets.map(s => s.games.join('–')).join('、');
      add(['retired', facts.winnerId], `${retired?.name ?? '一名选手'}赛中退赛${score ? `，停赛比分 ${score}` : ''}。`, facts.eventTime);
    } else if (kind === 'set_completed') {
      for (const set of facts.sets) {
        if (!set.winnerId || old.sets.some(s => s.number === set.number && s.winnerId === set.winnerId) ||
            !stillFits(conditions, set.number, set.winnerId)) continue;
        add([set.number, set.winnerId], `第 ${set.number} 盘结束，${describe(set.winnerId)}胜出，盘比分 ${set.games.join('–')}。`);
      }
    } else if (kind === 'break_of_serve') {
      const game = completedServiceGame(old, { state, ...facts }, current.participants);
      if (game?.kind === 'break' && stillFits(conditions, game.setNumber, game.winnerId))
        add([game.setNumber, game.score, game.winnerId], `第 ${game.setNumber} 盘，${describe(game.winnerId)}破发，局分 ${game.score.join('–')}。`);
    }
  }
  return { baseline, events, coverage: covered };
}
