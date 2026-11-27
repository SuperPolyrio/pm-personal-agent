import { sourceSetting } from './source-config.js';
import { createHash } from 'node:crypto';
import { readMarketData, polymonitorUrl } from './data.js';
import type { SportsAdapter, SportsEvidence, SportsFindResult, SportsSnapshot } from './sports.js';
import { formatCs2LiveRound } from './sports-cs2-live.js';
import { cs2MatchId, cs2RoundNumber, describeCs2MarketRound, marketEvidenceForRound,
  readCs2RoundJournal, type SavedCs2Round } from './sports-cs2-rounds.js';

const gridPath = '/runtime/panels/esports-intel';
const gridUrl = `${polymonitorUrl}${gridPath}`;
const publicGridUrl = `${sourceSetting('PM_POLYMONITOR_WEB_URL')}/wm-api${gridPath}`;
const maxLiveAge = 8 * 60_000;
const matchWindow = 60 * 60_000;
const watchKinds = ['series_started', 'lineup_changed', 'veto_published', 'map_started', 'map_completed',
  'map_awarded', 'series_rescheduled', 'series_finished'] as const;

type Status = 'covered' | 'partial' | 'pending' | 'stale' | 'unavailable' | 'unsupported';
type SeriesState = 'unknown' | 'upcoming' | 'live' | 'finished' | 'canceled' | 'postponed' | 'forfeit';
type MapState = 'scheduled' | 'live' | 'paused' | 'restarted' | 'played' | 'finished_unverified' | 'awarded' | 'canceled' | 'not_needed';
type Scores = Record<string, number>;
type Team = { id: string; name: string; aliases?: string[] };
type MapFact = {
  index: number; name: string | null; state: MapState; providerGameId?: string; startedAt?: string | null;
  changedAt?: string | null; version?: string; pickedBy?: string; score?: Scores; roundsPlayed?: Scores;
  winnerId?: string; overtimeRounds?: number; decision?: string; statsUrl?: string; restartOf?: string; playedToCompletion?: boolean;
};
type Veto = { order: number; action: 'ban' | 'pick' | 'decider'; name: string; teamId?: string };
type Lineup = {
  teamId: string; status: 'announced' | 'registered' | 'confirmed' | 'played' | 'historical'; players: string[];
  publishedAt?: string; substitutes?: Array<{ in: string; out?: string; state: 'announced' | 'played' | 'withdrawn'; reason?: string }>;
};
type Media = { kind: 'live' | 'replay'; url: string; spoilerFree?: boolean };
type MatchRecord = {
  game: 'CS2'; eventKey: string; participants: Team[]; competition: string; competitionAliases?: string[];
  stage?: string | null; stageAliases?: string[]; bestOf: number | null; scheduledAt: string | null;
  sourceUrl: string; endedAt?: string; startedAt?: string | null; updatedAt?: string | null; state: SeriesState;
  sourceStatus?: string; seriesScore?: Scores; winnerId?: string; maps?: MapFact[]; mapCoverage?: boolean;
  lineups?: Lineup[]; lineupTimeline?: Array<{ publishedAt?: string; sourceUrl: string; lineup: Lineup }>;
  veto?: Veto[]; vetoPublishedAt?: string; media?: Media[];
  originalScheduledAt?: string; rescheduledAt?: string; reschedulePublishedAt?: string;
  ids?: { hltvMatchId?: string; gridSeriesId?: string; providerGameId?: string; polymarketGameId?: string };
  authoritativeResult?: boolean; neverStarted?: boolean; noRescheduleByDeadline?: boolean;
};
type Evidence = { source?: string; data?: unknown; retrievedAt?: string; retrieved_at?: string };
type SourceRef = { sourceUrl: string; evidenceId: string; retrievedAt: string; observedAt: string | null; fields: string[] };
type CoverageItem = { status: Status; detail: string; reason?: string; evidenceId?: string; sourceUrl?: string; observedAt?: string | null };
type Coverage = Record<string, CoverageItem>;
type SourceDocument = {
  kind: 'cs2_source'; matches: MatchRecord[]; raw: unknown;
  // An authorized source reader can return official records or timestamped captures.
  historicalOnly?: boolean;
};
type SourceRead = { source: string; retrievedAt: string; data: SourceDocument };
type MaybePromise<T> = T | Promise<T>;
export type Cs2SportsHost = {
  saveEvidence(source: string, data: unknown, retrievedAt?: string): MaybePromise<string | { evidenceId: string }>;
  loadEvidence(id: string): MaybePromise<Evidence | null | undefined>;
  readMarketData?: typeof readMarketData;
  readCs2Sources?(input: Cs2Input, signal: AbortSignal): Promise<SourceRead[]>;
};
type Settlement = { conditionId: string; outcomeToken?: string; payout?: Record<string, number>; evidenceId?: string; asOf?: string };
type MarketContext = {
  conditionId?: string; condition_id?: string; outcomeToken?: string; outcome_token?: string;
  ruleVersion?: string; rules?: string; title?: string; candidates?: unknown[]; slug?: string; eventSlug?: string;
  scheduledAt?: string; evidenceId?: string; resolution?: unknown;
  event?: Row; market?: Row; quote?: unknown; settlement?: Settlement; inputEvidenceIds?: string[];
  // Use only a verified consensus window and a documented absence from the specified source.
  fallback?: { conclusionAt: string; checkedAt: string; absenceEvidenceId: string; evidenceIds: string[] };
};
type Cs2Input = {
  query?: string; eventKey?: string; event_key?: string; event?: { eventKey: string };
  asOf?: string; as_of?: string; mode?: 'live' | 'replay'; sourceEvidenceIds?: string[]; source_evidence_ids?: string[];
  market?: MarketContext; sourceEvidence?: SportsEvidence[]; noSpoilers?: boolean; no_spoilers?: boolean;
};
type Row = Record<string, unknown>;
type BoundRecord = { match: MatchRecord; ref: SourceRef; coverage: Coverage; historicalOnly: boolean };
type Condition = { kind: string; mapIndex?: number; map_index?: number; mapName?: string; map_name?: string;
  target?: string | number | { mapIndex?: number; mapName?: string; teamId?: string };
  teamId?: string; noSpoilers?: boolean; no_spoilers?: boolean; threshold?: number };
type Baseline = Record<string, { value: string; revision: string; at: string | null; state: string }>;
type Draft = { conditions?: Condition[]; acceptedConditions?: Condition[]; noSpoilers?: boolean; no_spoilers?: boolean };

const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const rows = (value: unknown) => list(value).map(object);
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown) => list(value).filter((x): x is string => typeof x === 'string');
const nativeId = (value: unknown) => typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
const instant = (value: unknown) => {
  const time = string(value).replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T').replace(/([+-]\d{2})$/, '$1:00');
  return /(?:Z|[+-]\d\d:\d\d)$/i.test(time) && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
};
const age = (asOf: string, time?: string | null) => time ? Date.parse(asOf) - Date.parse(time) : Infinity;
const norm = (value: unknown) => string(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const mapNameKey = (name: unknown) => norm(name).replace(/^de /, '').replaceAll(' ', '');
const names = (team: Team) => [team.name, ...team.aliases ?? []].map(norm);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (ids: string[]) => [...new Set(ids)];
const eventKey = (input: Cs2Input) => input.eventKey ?? input.event_key ?? input.event?.eventKey;
const noSpoilers = (input: { noSpoilers?: boolean; no_spoilers?: boolean; query?: string }) =>
  input.noSpoilers === true || input.no_spoilers === true || /无剧透|不要剧透|别剧透|spoiler.free|no spoilers/i.test(input.query ?? '');
const coverage = (status: Status, detail: string, ref?: SourceRef): CoverageItem => ({
  status, detail, reason: detail, ...(ref && { evidenceId: ref.evidenceId, sourceUrl: ref.sourceUrl, observedAt: ref.observedAt }),
});

function scores(value: unknown, participants: Team[]): Scores | undefined {
  const record = object(value);
  const values = participants.map(p => record[p.id]);
  return values.every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
    ? Object.fromEntries(participants.map((p, i) => [p.id, values[i] as number])) : undefined;
}

function gridMatch(row: Row): MatchRecord | undefined {
  if (row.gameTitle !== 'CS2' || typeof row.id !== 'string' || !/^\d+$/.test(row.id)) return;
  const ids = strings(row.teamIds), teamNames = [string(row.teamA), string(row.teamB)];
  if (ids.length !== 2 || ids[0] === ids[1] || teamNames.some(name => !name || name === 'TBD')) return;
  const participants = ids.map((id, i) => ({ id, name: teamNames[i] }));
  const metrics = rows(row.teamMetrics);
  const format = /^bo([135])$/i.exec(string(row.format));
  const competition = string(row.tournament);
  const maps: MapFact[] = rows(row.games).flatMap(game => {
    const index = game.number, id = string(game.id);
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > 5 || !id) return [];
    const teams = rows(game.teams);
    const score = scores(Object.fromEntries(teams.map(t => [nativeId(t.id), t.score])), participants);
    const winner = teams.filter(t => t.won === true && ids.includes(nativeId(t.id)));
    const startedAt = instant(game.startedAt);
    const rounds = score && ids.map(team => score[team]);
    const high = rounds && Math.max(...rounds), low = rounds && Math.min(...rounds);
    // GRID has no administrative disposition or round log. A legal MR12 score can corroborate a finish.
    const plausible = high !== undefined && low !== undefined && (high === 13 && low < 12
      || high >= 16 && high - low >= 2 && high - low <= 4 && (high - 16) % 3 === 0);
    const state = game.state === 'finished' ? 'finished_unverified' : game.state === 'live' ? 'live' : 'scheduled';
    return [{ index, name: string(game.map) || null, state, providerGameId: id, startedAt, score,
      winnerId: state === 'finished_unverified' && winner.length === 1 ? nativeId(winner[0].id) : undefined,
      ...(plausible && rounds && state === 'finished_unverified' && { overtimeRounds: Math.max(0, rounds[0] + rounds[1] - 24) }) }];
  });
  return { game: 'CS2', eventKey: `cs2:grid:${row.id}`, ids: { gridSeriesId: row.id }, participants,
    competition, stage: /\(([^)]+)\)$/.exec(competition)?.[1] ?? null, bestOf: format ? Number(format[1]) : null,
    scheduledAt: instant(row.startTime), sourceUrl: gridUrl, startedAt: instant(row.startedAt),
    updatedAt: instant(row.stateUpdatedAt), sourceStatus: string(row.sourceStatus),
    state: row.state === 'upcoming' || row.state === 'live' || row.state === 'finished' ? row.state : 'unknown',
    seriesScore: scores(Object.fromEntries(metrics.map(t => [nativeId(t.id), t.score])), participants),
    winnerId: metrics.filter(t => t.won === true && ids.includes(nativeId(t.id))).length === 1
      ? nativeId(metrics.find(t => t.won === true && ids.includes(nativeId(t.id)))?.id) : undefined, maps };
}

function gridDocument(data: unknown, exact?: string) {
  const { status, cacheMode, officialGeneratedAt, sources, items, events, window, summary } = object(data);
  const selected = rows(items).filter(row => row.gameTitle === 'CS2' && (!exact || row.id === exact));
  return { kind: 'cs2_grid', status, cacheMode, officialGeneratedAt, sources, window, summary,
    items: selected, events: rows(events).filter(event => selected.some(row => string(event.id).startsWith(`${row.id}:`))) };
}

function hltvVeto(raw: Row, participants: Team[]): Veto[] | undefined {
  const lines = strings(raw.vetoLines);
  const veto = lines.flatMap(line => {
    const pick = /^(\d+)\. (.+?) (removed|picked) ([\w -]+)$/.exec(line);
    const decider = /^(\d+)\. ([\w -]+) was left over$/.exec(line);
    if (decider) return [{ order: Number(decider[1]), action: 'decider' as const, name: decider[2] }] as Veto[];
    const team = pick && participants.find(candidate => names(candidate).includes(norm(pick[2])));
    return team && pick ? [{ order: Number(pick[1]), action: pick[3] === 'picked' ? 'pick' as const : 'ban' as const,
      name: pick[4], teamId: team.id }] : [];
  });
  return veto.length && veto.length === lines.length && veto.every((row, i) => row.order === i + 1) ? veto : undefined;
}

function sourceMatch(value: unknown, source: string, raw: unknown): MatchRecord | undefined {
  const row = object(value) as Partial<MatchRecord>;
  if (row.game !== 'CS2' || !/^cs2:[a-z0-9-]+:[\w-]+$/.test(row.eventKey ?? '') || !row.competition
    || !row.sourceUrl || !/^https:\/\//.test(row.sourceUrl) || !/^https:\/\//.test(source)
    || row.participants?.length !== 2 || row.participants.some(team => !team.id || !team.name)
    || row.participants[0].id === row.participants[1].id) return;
  if (row.eventKey?.startsWith('cs2:hltv:') && !new RegExp(`^https://(?:www\\.)?hltv\\.org/matches/${row.eventKey.split(':')[2]}(?:/|$)`).test(row.sourceUrl)) return;
  const participants = row.participants;
  const veto = row.veto ?? (row.eventKey?.startsWith('cs2:hltv:') ? hltvVeto(object(raw), participants) : undefined);
  const picks = veto?.filter(entry => entry.action !== 'ban') ?? [];
  const maps: MapFact[] = (row.maps ?? []).filter(map => Number.isInteger(map.index) && map.index > 0 && map.index <= 5).map(map => ({
    ...map, name: map.name ?? picks[map.index - 1]?.name ?? null,
    score: scores(map.score, participants), roundsPlayed: scores(map.roundsPlayed, participants),
    startedAt: instant(map.startedAt), changedAt: instant(map.changedAt),
    winnerId: participants.some(team => team.id === map.winnerId) ? map.winnerId : undefined,
  }));
  for (const [offset, pick] of picks.entries()) {
    const index = offset + 1;
    if (index <= (row.bestOf ?? 0) && !maps.some(map => map.index === index)) {
      maps.push({ index, name: pick.name, state: 'scheduled', pickedBy: pick.teamId });
    }
  }
  maps.sort((a, b) => a.index - b.index);
  return { ...row, participants, maps, veto, game: 'CS2', competition: row.competition, eventKey: row.eventKey!,
    sourceUrl: row.sourceUrl, state: row.state ?? 'unknown', scheduledAt: instant(row.scheduledAt),
    updatedAt: instant(row.updatedAt), startedAt: instant(row.startedAt), bestOf: row.bestOf ?? null,
    seriesScore: scores(row.seriesScore, participants) };
}

function candidate(match: MatchRecord) {
  const beijing = (time?: string | null) => time ? new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
  }).format(new Date(time)) : null;
  return { eventKey: match.eventKey, participants: match.participants, competition: match.competition,
    scheduledAt: match.scheduledAt, scheduledAtBeijing: beijing(match.scheduledAt), startedAtBeijing: beijing(match.startedAt),
    sourceUrl: match.sourceUrl, stage: match.stage ?? null, bestOf: match.bestOf };
}

function coverageFor(match: MatchRecord, ref: SourceRef, asOf: string, doc: Row, historicalOnly: boolean): Coverage {
  const grid = doc.kind === 'cs2_grid', sourceTime = instant(doc.officialGeneratedAt);
  const scheduleOk = Boolean(match.scheduledAt && (!grid || age(asOf, sourceTime) >= 0 && age(asOf, sourceTime) <= maxLiveAge
    && object(doc.sources).gridCentralData === 'ok'));
  const stateAge = age(asOf, match.updatedAt);
  const stale = match.sourceStatus === 'stale' || match.state === 'live' && !(stateAge >= 0 && stateAge <= maxLiveAge)
    || grid && match.state === 'live' && !(age(asOf, sourceTime) >= 0 && age(asOf, sourceTime) <= maxLiveAge);
  const current = !stale && (grid ? match.sourceStatus === 'ok' && stateAge >= 0
    : match.state !== 'unknown' && (!match.updatedAt || stateAge >= 0));
  const knownPrestart = scheduleOk && match.state === 'upcoming' && age(asOf, match.scheduledAt) < 0;
  const stateStatus = stale ? 'stale' : current || knownPrestart ? 'covered' : 'pending';
  const maps = match.maps ?? [];
  const mapState = stateStatus === 'covered' && !maps.length && !knownPrestart ? 'pending' : stateStatus;
  const mapRounds = Object.fromEntries(maps.map(map => [`map.${map.index}.rounds`,
    coverage(stale ? 'stale' : map.roundsPlayed ? 'covered' : map.score ? 'partial' : 'pending',
      map.roundsPlayed ? '实打回合' : map.score ? '来源比分，需分图赛果确认' : '暂无分图回合证据', ref)]));
  return {
    source: coverage(grid && doc.status !== 'ok' ? 'partial' : 'covered',
      grid ? `GRID ${string(doc.status)} / ${string(doc.cacheMode)} · Central Data ${string(object(doc.sources).gridCentralData)} · Series State ${string(object(doc.sources).gridSeriesState)}`
        : historicalOnly ? '历史来源记录' : '赛事来源记录', ref),
    schedule: coverage(scheduleOk ? 'covered' : match.scheduledAt && grid ? 'stale' : 'pending', '来源公布的计划时间', ref),
    series: coverage(stateStatus, '赛事状态', ref),
    seriesStart: coverage(stateStatus !== 'covered' ? stateStatus : match.startedAt || knownPrestart ? 'covered' : 'pending',
      match.startedAt ? '实际开赛时间' : '等待实际开赛时间', ref),
    lineups: coverage(match.lineups?.some(lineup => lineup.status !== 'historical') && !stale ? 'covered' : grid ? 'unsupported' : 'pending', '本赛事阵容与替补', ref),
    veto: coverage(Array.isArray(match.veto) && !stale ? 'covered' : grid ? 'unsupported' : 'pending',
      grid ? 'GRID 暂无禁选字段' : match.veto?.length ? '实际发布的禁选顺序' : '等待发布禁选', ref),
    maps: coverage(mapState, grid ? 'GRID 子局 ID、地图、开打时间与来源比分' : '来源地图状态', ref),
    awards: coverage(grid ? 'unsupported' : stale ? 'stale' : match.mapCoverage || maps.some(m => m.state === 'awarded') ? 'covered' : 'pending', '行政判图', ref),
    rounds: coverage(stale ? 'stale' : grid ? maps.length ? 'partial' : 'pending'
      : maps.some(m => m.roundsPlayed) ? 'covered' : 'pending', '实打回合；来源记分与行政比分分列', ref),
    media: coverage(match.media?.length ? 'covered' : 'pending', '正式来源明确关联本场的直播或回放', ref), ...mapRounds,
  };
}

function jsonArray(value: unknown) {
  if (typeof value !== 'string') return list(value);
  try { return list(JSON.parse(value)); } catch { return []; }
}

function easternTime(date: string, clock: string, period: string) {
  const [hour, minute] = clock.split(':').map(Number);
  const utc = Date.parse(`${date} ${hour % 12 + (period.toUpperCase() === 'PM' ? 12 : 0)}:${String(minute).padStart(2, '0')} UTC`);
  if (!Number.isFinite(utc)) return null;
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
    .formatToParts(utc).find(part => part.type === 'timeZoneName')?.value.match(/GMT([+-])(\d\d):(\d\d)/);
  if (!offset) return null;
  const minutes = Number(offset[2]) * 60 + Number(offset[3]);
  return new Date(utc + (offset[1] === '-' ? 1 : -1) * minutes * 60_000).toISOString();
}

function marketIdentity(ctx: MarketContext) {
  const market = object(ctx.market), event = object(ctx.event);
  const rules = string(market.description) || ctx.rules || '';
  const title = string(market.question) || ctx.title || '';
  const eventTitle = string(event.title) || title;
  const game = /^cs2-/.test(string(event.slug) || string(market.slug)) && /^Counter.Strike:/i.test(eventTitle)
    && (!object(event.sport).sport || object(event.sport).sport === 'cs2');
  const parseHeadline = (text: string) => /^This market refers to the Counter-Strike(?: (.+?))? match between (.+?) and (.+?) in the (.+?), initially scheduled for (.+?) at (\d{1,2}:\d\d) (AM|PM) ET\./i.exec(text);
  const headline = parseHeadline(rules);
  const parentHeadline = parseHeadline(string(event.description));
  const parentStage = parentHeadline && headline && norm(parentHeadline[4]) === norm(headline[4])
    && [parentHeadline[2], parentHeadline[3]].map(norm).sort().join(':') === [headline[2], headline[3]].map(norm).sort().join(':')
    ? parentHeadline[1] : undefined;
  const competition = /^.*?\(BO([135])\)\s*-\s*(.+)$/i.exec(eventTitle);
  const format = competition ? Number(competition[1]) : null;
  const startsAt = instant(market.gameStartTime ?? event.startTime ?? ctx.scheduledAt);
  const initialAt = headline ? easternTime(headline[5], headline[6], headline[7]) : null;
  const pmTeams = rows(event.teams).map(team => ({ id: nativeId(team.id), providerId: nativeId(team.providerId), name: string(team.name) }));
  const metadata = object(event.eventMetadata);
  const labels = strings(jsonArray(market.outcomes));
  const tokenIds = strings(jsonArray(market.clobTokenIds));
  const conditionId = ctx.conditionId ?? ctx.condition_id ?? string(market.conditionId);
  const requestedToken = ctx.outcomeToken ?? ctx.outcome_token;
  const link = string(event.slug) || string(object(jsonArray(market.events)[0]).slug);
  const tokens = labels.map((label, index) => ({ label, tokenId: tokenIds[index] }));
  const valid = /^0x[a-f\d]{64}$/i.test(conditionId) && conditionId === market.conditionId &&
    tokens.length === 2 && tokenIds.length === 2 && new Set(tokenIds).size === 2 && tokenIds.every(id => /^\d{1,78}$/.test(id))
    && (!requestedToken || tokenIds.includes(requestedToken))
    && (!ctx.rules || ctx.rules === market.description)
    && (!ctx.eventSlug || ctx.eventSlug === link) && (!ctx.slug || ctx.slug === market.slug);
  return { market, event, rules, title, game, headline, format, startsAt, initialAt, valid, tokens, conditionId, requestedToken,
    teams: headline ? [headline[2], headline[3]] : [], pmTeams, season: headline?.[4] ?? '', stage: headline?.[1] ?? parentStage ?? '',
    eventSlug: link, polymarketGameId: nativeId(event.gameId), providerGameId: nativeId(metadata.pandascoreMatchId),
    gridSeriesId: nativeId(metadata.gridSeriesId), submarketGameId: nativeId(market.gameId) || null };
}
type MarketIdentity = ReturnType<typeof marketIdentity>;

function matchMarket(match: MatchRecord, pm: MarketIdentity) {
  if (!pm.game || pm.teams.length !== 2) return { binding: 'unverified', reason: '缺 CS2 赛事与规则身份。' };
  const resolveTeam = (name: string) => {
    const teams = match.participants.filter(team => names(team).includes(norm(name)));
    return teams.length === 1 ? teams[0].id : null;
  };
  const teamIds = pm.teams.map(resolveTeam);
  const eventTeams = pm.pmTeams.map(t => resolveTeam(t.name));
  const eventMismatch = eventTeams.length === 2 && (!eventTeams.every(id => id && teamIds.includes(id)) || eventTeams[0] === eventTeams[1]);
  if (teamIds.some(id => id === null) || teamIds[0] === teamIds[1] || eventMismatch)
    return { binding: 'mismatch', reason: '双方稳定身份或已核实别名无法一一对应。' };
  const league = [match.competition, ...match.competitionAliases ?? []].map(norm);
  const stage = [match.stage, ...match.stageAliases ?? []].map(norm).filter(Boolean);
  const times = [pm.startsAt, pm.initialAt].filter((t): t is string => Boolean(t));
  const sourceTimes = [match.scheduledAt, instant(match.originalScheduledAt), instant(match.rescheduledAt)].filter((t): t is string => Boolean(t));
  const inWindow = times.length === 2 && times.every(time => sourceTimes.some(t => Math.abs(Date.parse(t) - Date.parse(time)) <= matchWindow));
  const idsConflict = Boolean(pm.gridSeriesId && match.ids?.gridSeriesId && pm.gridSeriesId !== match.ids.gridSeriesId ||
    pm.providerGameId && match.ids?.providerGameId && pm.providerGameId !== match.ids.providerGameId);
  if (idsConflict || match.bestOf && pm.format && pm.format !== match.bestOf
    || times.length === 2 && sourceTimes.length > 0 && !inWindow)
    return { binding: 'mismatch', reason: '原生 ID、BO 格式或时间窗不符。' };
  if (!inWindow || !pm.format || !match.bestOf || !league.includes(norm(pm.season)) || !stage.includes(norm(pm.stage)))
    return { binding: 'unverified', reason: '需独立核实赛事、轮次、BO 格式与时间窗。' };
  return { binding: 'verified', reason: '游戏、双方、赛事、轮次、BO 和时间窗均有证据。', teamIds };
}

function ruleScope(pm: MarketIdentity) {
  const type = string(pm.market.sportsMarketType), text = pm.rules.replace(/[’]/g, "'").replace(/\s+/g, ' ');
  const lines = pm.rules.split(/\n\s*\n/).map(line => line.trim()).filter(Boolean);
  const maps = [...new Set([...text.matchAll(/\bMap (\d)\b/gi)].map(m => Number(m[1])).filter(n => n > 0))];
  const index = /^round_(?:handicap|over_under)_game_([1-5])$/.exec(type)?.[1]
    ?? (type === 'child_moneyline' ? /\bMap ([1-5]) Winner\b/i.exec(pm.title)?.[1] : undefined);
  const target = index ? Number(index) : null;
  const kind = type === 'moneyline' ? 'series_winner' : type === 'child_moneyline' ? 'map_winner'
    : type === 'totals' ? 'total_maps' : type === 'map_handicap' ? 'map_handicap'
    : type.startsWith('round_handicap_game_') ? 'round_handicap'
    : type.startsWith('round_over_under_game_') ? 'total_rounds' : 'unsupported';
  const round = kind === 'round_handicap' || kind === 'total_rounds';
  const mapTotal = kind === 'total_maps' || kind === 'map_handicap';
  const line = typeof pm.market.line === 'number' && Number.isFinite(pm.market.line) ? pm.market.line : null;
  const outcomes = pm.tokens.map(t => t.label);
  const clauses = lines.filter(l => /will resolve|must be played|are counted|count as a completed|resolution source/i.test(l));
  const deadlineClause = /rescheduled to a start time on or before (.+?) at (\d{1,2}:\d\d) (AM|PM) ET/i.exec(text);
  const deadline = deadlineClause ? easternTime(deadlineClause[1], deadlineClause[2], deadlineClause[3]) : null;
  const fallback = /has not published final results within (\d+) hours? after the event.s conclusion, a consensus of credible reporting may be used/i.exec(text);
  const source = /resolution source for this market will be official information from https:\/\/(?:www\.)?hltv\.org/i.test(text);
  const includesOvertime = /including any overtime/i.test(text);
  const requiresPlayed = /must be played to completion, with a final round score determined by rounds actually played/i.test(text);
  const countsAwarded = /maps won by forfeit, disqualification, walkover, or default are counted towards the (?:total|handicap), provided that the match is completed/i.test(text);
  const clinchingAward = /clinching map being forfeited this will count as a completed match/i.test(text);
  const incompleteMapVoid = target !== null && (round
    ? /is not played to completion, or is decided by forfeit, disqualification, walkover, or default rather than by rounds played to a conclusion/i.test(text)
    : new RegExp(`Map ${target} is not completed for any reason, this market will resolve 50-50`, 'i').test(text));
  const incompleteSeriesAward = /if the match begins but is not completed, and one team wins due to the opponent's forfeiture, disqualification, or walkover, this market will resolve to the team who wins/i.test(text);
  const incompleteSeriesVoid = /if the match begins but is not completed, and one team wins due to the opponent's match forfeiture, disqualification, or walkover, this market will resolve to 50-50/i.test(text);
  const noStartVoid = /team withdraws before the start and the other wins automatically\), this market will resolve to 50-50/i.test(text);
  const cancellationVoid = /if the match is canceled(?: \([^)]*\))?(?: or ends in a tie)?, this market will resolve (?:to )?50-50/i.test(text);
  const tieVoid = /ends in a tie, this market will resolve to 50-50/i.test(text);
  const teamWinnerClauses = /will resolve to "([^"]+)" if (.+?) win(?:s)? (?:the match|Map [1-5]) against (.+?)\./gi;
  const winners = [...text.matchAll(teamWinnerClauses)];
  const spread = /will resolve to "([^"]+)" if (.+?) wins? (?:Map [1-5] by )?(\d+) or more (?:rounds|maps than )[^"]*?\.\s*Otherwise, this market will resolve to "([^"]+)"/i.exec(text);
  const gameOver = /resolve to "Over" if .+? play (\d+) or more maps in this series\.\s*If fewer than (\d+) maps are played, this market will resolve to "Under"/i.exec(text);
  const roundOver = /including any overtime, is greater than ([\d.]+)\. This market will resolve to "Under" if the combined number of rounds played is less than (\d+(?:\.\d+)?)\./i.exec(text);
  const labelsMatch = winners.length === 2 && outcomes.every(label => winners.some(w => norm(w[1]) === norm(label)
    && norm(w[2]) === norm(label) && outcomes.some(other => other !== label && norm(other) === norm(w[3]))));
  const spreadMatches = line !== null && spread && Number(spread[3]) === Math.floor(-line) + 1
    && norm(spread[1]) === norm(spread[2]) && outcomes.includes(spread[1]) && outcomes.includes(spread[4])
    && spread[1] !== spread[4] && line % 1 !== 0;
  const totalLabels = outcomes.includes('Over') && outcomes.includes('Under');
  const semantic = kind === 'series_winner' ? labelsMatch && !maps.length && incompleteSeriesAward && noStartVoid && tieVoid
    : kind === 'map_winner' ? labelsMatch && incompleteMapVoid && /concluded with a winner determined/i.test(text)
    : kind === 'map_handicap' ? spreadMatches && !maps.length
    : kind === 'total_maps' ? totalLabels && gameOver && line !== null && line % 1 !== 0
      && Number(gameOver[1]) === Math.floor(line) + 1 && gameOver[1] === gameOver[2]
    : kind === 'round_handicap' ? spreadMatches
    : kind === 'total_rounds' ? totalLabels && roundOver && line !== null && Number(roundOver[1]) === line && Number(roundOver[2]) === line
      && new RegExp(`exactly ${String(line).replace('.', '\\.')}.*, this market will resolve 50-50`, 'i').test(text)
    : false;
  const titleMap = /\bMap ([1-5])\b/i.exec(pm.title)?.[1];
  const mapMatches = target === null || (!titleMap || Number(titleMap) === target) && maps.includes(target) && maps.every(n => n === target)
    && (!round || new RegExp(`Map ${target} must be played to completion`, 'i').test(text));
  const recognized = lines.every((line, i) => i === 0 || /^(?:This market will resolve to "|If the match (?:begins|is canceled|is postponed|ends)|If fewer than \d+ maps are played|If Map [1-5] is not|Map [1-5] must be played|Otherwise, this market will resolve|Maps won by forfeit|The resolution source for this market|In cases where a team.s listed name)/i.test(line));
  const valid = Boolean(recognized && semantic && source && deadline && cancellationVoid && mapMatches
    && (!round || target && includesOvertime && requiresPlayed && incompleteMapVoid)
    && (!mapTotal || countsAwarded && clinchingAward && incompleteSeriesVoid && tieVoid));
  return { valid, kind, mapIndex: target, line, clauses, deadline, fallbackHours: fallback ? Number(fallback[1]) : null,
    resolutionSource: source ? 'https://hltv.org' : null, requiresPlayed, includesOvertime, countsAwarded, clinchingAward,
    incompleteMapVoid, incompleteSeriesAward, incompleteSeriesVoid, noStartVoid, cancellationVoid, tieVoid, favored: spread?.[1] };
}

function derivedResult(match: MatchRecord, pm: MarketIdentity, rule: ReturnType<typeof ruleScope>, asOf: string) {
  const pending = (reason: string) => ({ status: 'pending', reason });
  const resolved = (outcome: string, facts: unknown) => ({ status: 'derived', outcome,
    tokenId: pm.tokens.find(t => t.label === outcome)?.tokenId, facts });
  const split = (reason: string, facts?: unknown) => ({ status: 'derived', outcome: '50-50', reason, facts });
  const labelFor = (id: string) => pm.tokens.find(t => match.participants.some(team => team.id === id && names(team).includes(norm(t.label))))?.label;
  const winner = (id?: string) => id && labelFor(id);
  const maps = match.maps ?? [];
  const map = maps.find(m => m.index === rule.mapIndex);
  const mapResult = (map: MapFact) => ({ index: map.index, state: map.state, roundsPlayed: map.roundsPlayed,
    score: map.score, overtimeRounds: map.overtimeRounds, winnerId: map.winnerId, decision: map.decision, statsUrl: map.statsUrl });
  const rescheduled = instant(match.rescheduledAt), announced = instant(match.reschedulePublishedAt);
  if (match.state === 'postponed' || rescheduled) {
    if (!rescheduled || !announced) {
      return match.noRescheduleByDeadline && rule.deadline && age(asOf, rule.deadline) >= 0
        ? split('指定来源确认期限内无有效改期。') : pending('需要改期公告和发布时间。');
    }
    if (rule.deadline && (age(rule.deadline, rescheduled) < 0 || age(rule.deadline, announced) < 0)) {
      return age(asOf, rule.deadline) < 0 ? pending('改期窗口仍可更新。')
        : split('改期公告或新赛程超过规则期限。', { rescheduled, announced, deadline: rule.deadline });
    }
  }
  if ((match.state === 'canceled' || match.neverStarted) && rule.cancellationVoid) return split('官方取消。');
  const final = match.state === 'finished' || match.state === 'forfeit';
  const series = match.seriesScore;
  const [a, b] = match.participants.map(t => t.id);
  const counted = maps.filter(m => m.state === 'played' || m.state === 'awarded' && rule.countsAwarded);
  const countA = counted.filter(m => m.winnerId === a).length, countB = counted.filter(m => m.winnerId === b).length;
  const finishByMapAward = match.state === 'forfeit' && rule.clinchingAward && counted.at(-1)?.state === 'awarded';
  const complete = (match.state === 'finished' || finishByMapAward) && match.mapCoverage === true
    && new Set(maps.map(m => m.index)).size === maps.length
    && counted.every((m, i) => m.index === i + 1) && Math.max(countA, countB) === (match.bestOf! + 1) / 2
    && countA + countB === counted.length && series?.[a] === countA && series[b] === countB;
  if (rule.mapIndex !== null) {
    if (map?.state === 'awarded' && rule.incompleteMapVoid) {
      return map.playedToCompletion ? pending('已实打完成的地图随后被改判，需核对合约采用哪个结果。')
        : split('该图以行政判给结束，实打未完成。', mapResult(map));
    }
    if (map?.state === 'canceled' || final && (map?.state === 'not_needed' || map?.state === 'scheduled'
      || !map && match.mapCoverage)) return split('该图未完成。', map && mapResult(map));
    if (map?.state !== 'played') return pending('等待本图实打完赛凭据。');
    if (rule.kind === 'map_winner') {
      const label = winner(map.winnerId);
      return label ? resolved(label, mapResult(map)) : pending('缺可映射的地图胜方。');
    }
    const rounds = map.roundsPlayed;
    if (!rounds) return pending('缺双方实际回合比分与加时口径。');
    if (rule.kind === 'total_rounds') {
      const total = rounds[a] + rounds[b];
      return total === rule.line ? split('实打回合恰等于盘口线。', mapResult(map))
        : resolved(total > rule.line! ? 'Over' : 'Under', { total, ...mapResult(map) });
    }
    const favorite = match.participants.find(team => names(team).includes(norm(rule.favored)))?.id;
    if (!favorite) return pending('让回合一方无法与队伍身份对应。');
    const other = favorite === a ? b : a;
    const label = winner(rounds[favorite] - rounds[other] + rule.line! > 0 ? favorite : other);
    return label ? resolved(label, mapResult(map)) : pending('让回合选项映射未确认。');
  }
  if (!final) return pending('赛事尚无最终赛果。');
  if (series && series[a] === series[b] && rule.tieVoid) return split('官方最终赛果为平局。', series);
  if (rule.kind === 'series_winner') {
    if (match.state === 'forfeit' && !match.startedAt && !maps.some(m => m.startedAt || m.roundsPlayed)) {
      return match.neverStarted && rule.noStartVoid ? split('开赛前退出。') : pending('需确认是否已实际开赛。');
    }
    const label = winner(match.winnerId ?? (series && series[a] !== series[b] ? series[a] > series[b] ? a : b : undefined));
    return label ? resolved(label, { state: match.state, seriesScore: series }) : pending('缺正式系列赛胜方。');
  }
  if (match.state === 'forfeit' && !complete && rule.incompleteSeriesVoid) return split('整场行政终止，未完成系列赛。', series);
  if (!complete) return pending('需要完整逐图处置与系列赛比分对齐。');
  const facts = { countedMaps: counted.map(mapResult), seriesScore: series };
  if (rule.kind === 'total_maps') return resolved(countA + countB > rule.line! ? 'Over' : 'Under', facts);
  const fav = match.participants.find(team => names(team).includes(norm(rule.favored)))?.id;
  const label = fav && winner(series[fav] - series[fav === a ? b : a] + rule.line! > 0 ? fav : fav === a ? b : a);
  return label ? resolved(label, facts) : pending('让图选项映射未确认。');
}

type Cs2Facts = {
  bestOf?: number | null; stage?: string | null; ids?: MatchRecord['ids']; matchesSource?: SourceRef;
  maps?: MapFact[]; lineups?: Lineup[]; veto?: Veto[]; vetoPublishedAt?: string | null; updatedAt?: string | null;
  seriesScore?: Scores; winnerId?: string; endedAt?: string | null;
  reschedulePublishedAt?: string | null; historicalOnly?: boolean; noSpoilers?: boolean;
  [key: string]: unknown;
};
type Cs2Snapshot = Pick<SportsSnapshot<Cs2Facts>, 'eventKey' | 'participants' | 'competition' | 'scheduledAt' | 'startedAt'
  | 'state' | 'sourceUrl' | 'facts' | 'inputEvidenceIds' | 'market'> & {
  coverage: Coverage; mode: 'live' | 'replay'; asOf: string; scheduledAtBeijing?: string | null;
};

export function createCs2Sports(host: Cs2SportsHost): SportsAdapter<Cs2Snapshot, Baseline> {
  const watchSnapshots = new WeakMap<Cs2Snapshot, Cs2Snapshot>();
  async function save(source: string, data: unknown, retrievedAt: string) {
    const row = await host.saveEvidence(source, data, retrievedAt);
    return typeof row === 'string' ? row : row.evidenceId;
  }

  async function commentaryRows(input: Cs2Input) {
    const query = input.query ?? '';
    const key = eventKey(input);
    if (noSpoilers(input) || key && !/^cs2:hltv:\d+$/.test(key)
      || !/回合|解说|\bround\b|\bcommentary\b/i.test(query)) return [];
    const matchId = key?.split(':')[2] ?? /hltv\.org\/matches\/(\d+)\//i.exec(query)?.[1];
    const asOf = Date.parse(input.asOf ?? input.as_of ?? new Date().toISOString());
    const source: SavedCs2Round[] = [];
    if (input.mode === 'replay') {
      const refs: Evidence[] = [...input.sourceEvidence ?? []];
      for (const id of unique(input.sourceEvidenceIds ?? input.source_evidence_ids ?? [])) {
        const ref = await host.loadEvidence(id);
        if (ref) refs.push(ref);
      }
      for (const ref of refs) {
        const doc = object(ref.data);
        if (doc.kind === 'cs2_round_record' && doc.record && age(input.asOf ?? input.as_of ?? '', instant(ref.retrievedAt ?? ref.retrieved_at)) >= 0)
          source.push(doc.record as SavedCs2Round);
      }
    } else source.push(...readCs2RoundJournal(matchId, asOf));
    const q = norm(query);
    const day = /\b\d{4}-\d{2}-\d{2}\b/.exec(query)?.[0];
    return source.filter(row => row.round?.match && row.availableAt <= asOf && (
      matchId ? cs2MatchId(row.round.match.sourceUrl) === matchId
        : row.round.match.teams.every(team => q.includes(norm(team)))
          && (!day || new Date(row.round.receivedAt + 8 * 3600_000).toISOString().startsWith(day))
    )).sort((a, b) => a.round.match.sourceUrl === b.round.match.sourceUrl
      ? b.round.mapIndex - a.round.mapIndex || cs2RoundNumber(b.round) - cs2RoundNumber(a.round)
      : b.round.receivedAt - a.round.receivedAt);
  }

  function commentaryEvent({ round }: SavedCs2Round) {
    const id = cs2MatchId(round.match.sourceUrl);
    return { eventKey: `cs2:hltv:${id}`, participants: round.match.teams.map(name => ({ id: norm(name), name })),
      competition: 'HLTV 已核对对阵', scheduledAt: null, sourceUrl: round.match.sourceUrl };
  }

  async function commentarySnapshot(input: Cs2Input, records: SavedCs2Round[]): Promise<Cs2Snapshot> {
    const latest = records[0];
    const history = records.map(({ round }) => round);
    const query = input.query ?? '';
    const mapNumber = /第?\s*([1-5])\s*图|图\s*([1-5])|\bmap\s*([1-5])/i.exec(query)?.slice(1).find(Boolean);
    const namedMap = latest.round.match.maps.find(name => norm(query).includes(norm(name)));
    const roundNumber = /第?\s*(\d{1,2})\s*回合|\bround\s*(\d{1,2})/i.exec(query)?.slice(1).find(Boolean);
    const selected = records.filter(({ round }) => (!mapNumber || round.mapIndex + 1 === Number(mapNumber))
      && (!namedMap || round.match.maps[round.mapIndex] === namedMap)
      && (!roundNumber || cs2RoundNumber(round) === Number(roundNumber))).slice(0, roundNumber ? 5 : 1);
    const contract = input.market ? { conditionId: input.market.conditionId ?? input.market.condition_id,
      tokenId: input.market.outcomeToken ?? input.market.outcome_token } : undefined;
    const rounds = await Promise.all(selected.map(async record => {
      const { round, id, availableAt } = record;
      const markets = marketEvidenceForRound(round, record.markets ?? [], contract);
      // A market-filtered reply has its own evidence and excludes observations of other tokens.
      const visible: SavedCs2Round = { id, round, availableAt, message: '', markets };
      const sourceUrl = round.video?.source ?? round.match.relay;
      const evidenceId = await save(sourceUrl,
        { kind: 'cs2_round_record', record: visible }, new Date(availableAt).toISOString());
      return { id, evidenceId, mapIndex: round.mapIndex + 1, round: cs2RoundNumber(round), coverage: round.fullRound ? 'covered' : 'partial',
        sourceUrl, observedAt: new Date(round.receivedAt).toISOString(), score: round.score, series: round.series,
        events: round.plays, videoObjectives: round.video?.objectives,
        sourceFragment: round.video ? undefined : round.fragment, sourceTick: round.video ? undefined : round.tick, markets,
        commentary: [formatCs2LiveRound(round, history), ...describeCs2MarketRound(round, markets, !contract)].join('\n') };
    }));
    const mode = input.mode ?? 'live', asOf = input.asOf ?? input.as_of ?? new Date().toISOString();
    const covered = rounds.length === 1 && rounds[0].coverage === 'covered';
    const markets = rounds.flatMap(row => row.markets);
    const aligned = markets.length > 0 && markets.every(m => m.quotes?.before && m.quotes.end);
    const someMarketData = markets.some(m => m.price || m.quotes?.end || m.liveTrades?.length || m.trades?.length);
    return { ...commentaryEvent(latest), startedAt: null, mode, asOf,
      state: latest.round.seriesOver ? 'finished' : Date.parse(asOf) - latest.round.receivedAt <= maxLiveAge ? 'live' : 'unknown',
      facts: { bestOf: latest.round.match.maps.length, rounds,
        ...(rounds.length > 1 && { roundSelection: '此回合号跨地图重复，请指定图序。' }) },
      coverage: { round: coverage(covered ? 'covered' : rounds.length ? 'partial' : 'pending',
        covered ? '保存了完整 CSTV 回合。' : rounds.length > 1 ? '回合号跨地图重复。'
          : latest.round.video?.scoreChecked ? 'CSTV 已核对比分，回合过程仅有部分 CSTV 片段。'
          : latest.round.video ? '已保存 Kick 速报，等待 CSTV 核对。'
          : rounds.length ? '已保存部分 CSTV 事件。' : '未取得请求回合的记录。'),
      roundMarket: coverage(aligned ? 'covered' : someMarketData ? 'partial' : 'pending',
        aligned ? '已取得已核验合约的开打与结束收包时盘口。' : someMarketData ? '有已保存的同合约观测，缺成对的开打和结束盘口。'
          : '缺少所选回合与合约的可用盘口或成交。') },
      inputEvidenceIds: rounds.map(row => row.evidenceId) };
  }

  async function readSources(input: Cs2Input, signal: AbortSignal) {
    const replay = input.mode === 'replay';
    const requestedAt = instant(input.asOf ?? input.as_of);
    if (replay && (!requestedAt || Date.parse(requestedAt) > Date.now())) throw Error('CS2 回放需要已到达的带时区 as_of。');
    const key = eventKey(input);
    const docs: Array<{ id: string; row: Evidence }> = [];
    if (replay) {
      for (const row of input.sourceEvidence ?? []) docs.push({ id: row.evidenceId, row });
      for (const id of unique(input.sourceEvidenceIds ?? input.source_evidence_ids ?? [])) {
        const row = await host.loadEvidence(id);
        if (row) docs.push({ id, row });
      }
    } else {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
      const grid = !key || key.startsWith('cs2:grid:');
      const reads = await Promise.allSettled([
        grid ? (host.readMarketData ?? readMarketData)(gridPath, timeout).then(row => [{
          ...row, data: gridDocument(row.data, key?.split(':')[2]),
        }]) : Promise.resolve([]),
        host.readCs2Sources?.(input, timeout) ?? Promise.resolve([]),
      ]);
      signal.throwIfAborted();
      for (const [index, result] of reads.entries()) {
        if (result.status === 'fulfilled') {
          for (const row of result.value) {
            const id = await save(row.source, row.data, row.retrievedAt);
            docs.push({ id, row });
          }
        } else {
          const retrievedAt = new Date().toISOString(), source = index === 0 ? gridUrl : 'cs2/official-source';
          const data = { kind: 'cs2_access', status: 'unavailable', detail: String(result.reason).slice(0, 250) };
          docs.push({ id: await save(source, data, retrievedAt), row: { source, retrievedAt, data } });
        }
      }
    }
    const asOf = replay ? requestedAt! : new Date().toISOString();
    const records: BoundRecord[] = [];
    const ids: string[] = [];
    let sourceCoverage: CoverageItem | undefined;
    for (const { id, row } of docs) {
      const retrievedAt = instant(row.retrievedAt ?? row.retrieved_at), source = row.source ?? '';
      const doc = object(row.data);
      if (!retrievedAt || age(asOf, retrievedAt) < 0 || !['cs2_source', 'cs2_grid', 'cs2_access'].includes(string(doc.kind))) continue;
      ids.push(id);
      if (doc.kind === 'cs2_access') {
        sourceCoverage = { status: 'unavailable', detail: string(doc.detail), evidenceId: id, sourceUrl: source };
        continue;
      }
      const isGrid = doc.kind === 'cs2_grid' && source === gridUrl;
      const historicalOnly = doc.historicalOnly === true;
      const matches = isGrid ? rows(doc.items).map(gridMatch)
        : doc.kind === 'cs2_source' && doc.raw != null ? list(doc.matches).map(item => sourceMatch(item, source, doc.raw)) : [];
      for (const match of matches) {
        if (!match || key && key !== match.eventKey) continue;
        const observations = [match.updatedAt, match.startedAt, match.endedAt, match.vetoPublishedAt, match.reschedulePublishedAt,
          ...(match.maps ?? []).flatMap(map => [map.startedAt, map.changedAt]),
          ...(match.lineups ?? []).map(lineup => lineup.publishedAt),
          ...(match.lineupTimeline ?? []).map(entry => entry.publishedAt)];
        if (observations.some(t => t && (!instant(t) || age(asOf, t) < 0))) continue;
        const ref = { sourceUrl: source, evidenceId: id, retrievedAt, observedAt: match.updatedAt ?? (isGrid ? instant(doc.officialGeneratedAt) : null),
          fields: ['identity', 'schedule', 'series', ...(match.maps?.length ? ['maps'] : []),
            ...(match.lineups?.length ? ['lineups'] : []), ...(match.veto?.length ? ['veto'] : []), ...(match.media?.length ? ['media'] : [])] };
        const values = coverageFor(match, ref, asOf, doc, historicalOnly);
        records.push({ match, ref, coverage: values, historicalOnly });
        sourceCoverage = values.source;
      }
    }
    records.sort((a, b) => Date.parse(b.ref.retrievedAt) - Date.parse(a.ref.retrievedAt));
    return { records, ids: unique(ids), sourceCoverage: sourceCoverage ?? coverage('unavailable',
      key?.startsWith('cs2:hltv:') ? '该 HLTV 比赛需要已授权读取或原始存证。' : '当前窗口未读取对应 CS2 来源记录。'), asOf };
  }

  async function readContract(input: Cs2Input, asOf: string) {
    const ctx = input.market;
    if (!ctx) return;
    const docs: Evidence[] = [...input.sourceEvidence ?? []];
    for (const id of unique([ctx.evidenceId ?? '', ...ctx.inputEvidenceIds ?? []]).filter(Boolean)) {
      const row = await host.loadEvidence(id);
      if (row) docs.push(row);
    }
    const raw = docs.filter(row => /^https:\/\/gamma-api\.polymarket\.com\/(?:events|markets)\//.test(row.source ?? '')
      && instant(row.retrievedAt ?? row.retrieved_at) && age(asOf, instant(row.retrievedAt ?? row.retrieved_at)) >= 0)
      .map(row => object(row.data)).map(row => row.kind === 'polymarket_public' ? object(row.response) : row);
    const market = raw.find(row => row.conditionId === (ctx.conditionId ?? ctx.condition_id) && row.slug === (ctx.slug ?? row.slug))
      ?? (input.mode !== 'replay' ? ctx.market : undefined);
    const parent = object(rows(market?.events)[0]);
    const event = raw.find(row => row.slug === (ctx.eventSlug ?? parent.slug) && Array.isArray(row.markets))
      ?? (input.mode !== 'replay' ? ctx.event : undefined) ?? parent;
    return marketIdentity({ ...ctx, market, event });
  }

  async function find(input: Cs2Input, signal: AbortSignal): Promise<SportsFindResult> {
    const saved = await commentaryRows(input);
    if (saved.length) {
      const candidates = [...new Map(saved.map(row => { const event = commentaryEvent(row); return [event.eventKey, event] as const; })).values()];
      return { candidates, coverage: { identity: coverage(candidates.length === 1 ? 'covered' : 'pending', '已保存的 GOTV 对阵。') }, inputEvidenceIds: [] };
    }
    const { records, ids, sourceCoverage, asOf } = await readSources(input, signal);
    const pm = await readContract(input, asOf);
    const key = eventKey(input), query = norm(input.query);
    const term = (target: string) => Boolean(target && new RegExp(`(?:^|[^a-z0-9])${target}(?:$|[^a-z0-9])`, 'u').test(query));
    const matchQuery = (match: MatchRecord) => match.participants.some(team => names(team).some(name => term(name) || term(name.replace(/ (?:clan|esports)$/, ''))))
      || term(norm(match.competition))
      || Boolean(query && query === norm(match.eventKey));
    const marketCandidates = pm && records.filter(row => matchMarket(row.match, pm).binding === 'verified');
    let matches = key ? records : marketCandidates?.length ? marketCandidates : records.filter(row => pm
      ? matchMarket(row.match, pm).binding !== 'mismatch' && pm.teams.length === 2 : query && matchQuery(row.match));
    if (!key && !pm && /下一场|next match/i.test(input.query ?? '')) {
      matches = matches.filter(row => row.match.state === 'upcoming' && age(asOf, row.match.scheduledAt) < 0);
      const first = matches.reduce<string | null>((a, b) => !a || b.match.scheduledAt! < a ? b.match.scheduledAt : a, null);
      matches = matches.filter(row => row.match.scheduledAt === first);
    }
    if (!key && !pm && /今天|今日|today/i.test(input.query ?? '')) {
      const beijingDate = (time: string) => new Date(Date.parse(time) + 8 * 3600_000).toISOString().slice(0, 10);
      matches = matches.filter(row => row.match.scheduledAt && beijingDate(row.match.scheduledAt) === beijingDate(asOf));
    }
    const candidates = [...new Map(matches.slice().reverse().map(({ match }) => {
      const identity = candidate(match);
      const event = noSpoilers(input) ? { eventKey: identity.eventKey, participants: identity.participants,
        competition: identity.competition, scheduledAt: identity.scheduledAt,
        sourceUrl: match.media?.find(item => item.spoilerFree === true)?.url ?? '' } : identity;
      return [match.eventKey, event] as const;
    })).values()]
      .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
    return { candidates, coverage: { source: sourceCoverage, identity: coverage(candidates.length === 1
      && (!pm || marketCandidates?.length) ? 'covered' : 'pending', candidates.length ? '赛事候选' : '未找到满足条件的来源赛事') }, inputEvidenceIds: ids };
  }

  async function inspect(input: Cs2Input, signal: AbortSignal): Promise<Cs2Snapshot> {
    const saved = await commentaryRows(input);
    if (saved.length) return commentarySnapshot(input, saved);
    const { records, ids, sourceCoverage, asOf } = await readSources(input, signal);
    const mode = input.mode ?? 'live';
    const hidden = noSpoilers(input);
    const pm = hidden ? undefined : await readContract(input, asOf);
    const chosen = records[0];
    if (!chosen) {
      return { eventKey: eventKey(input)!, participants: [], competition: '', scheduledAt: null, startedAt: null,
        state: 'unknown', mode, asOf, facts: { noSpoilers: hidden }, coverage: { source: sourceCoverage,
          ...(pm && { market: coverage('pending', '赛事来源缺失。') }) }, inputEvidenceIds: ids,
        ...(pm && { market: { binding: 'unverified', status: 'pending', reason: '赛事来源缺失。' } }) };
    }
    const { match, ref, coverage: availability, historicalOnly } = chosen;
    const identity = candidate(match);
    const media = (match.media ?? []).filter(item => /^https:\/\//.test(item.url) && (!hidden || item.spoilerFree === true))
      .map(item => ({ kind: item.kind, url: item.url, title: item.kind === 'live' ? '观看直播' : '观看回放' }));
    const { state, startedAt, maps = [], lineups, veto, ids: matchIds, updatedAt } = match;
    const facts: Cs2Facts = { bestOf: match.bestOf, stage: match.stage, ids: matchIds, matchesSource: ref,
      maps: maps.map(map => ({ ...map, pickedBy: map.pickedBy ?? veto?.find(entry => entry.action === 'pick' && mapNameKey(entry.name) === mapNameKey(map.name))?.teamId })),
      lineups, lineupTimeline: match.lineupTimeline, veto, vetoPublishedAt: instant(match.vetoPublishedAt),
      endedAt: instant(match.endedAt), sourceTime: updatedAt, updatedAt, media, historicalOnly,
      seriesScore: match.seriesScore, winnerId: match.winnerId, originalScheduledAt: instant(match.originalScheduledAt),
      rescheduledAt: instant(match.rescheduledAt), reschedulePublishedAt: instant(match.reschedulePublishedAt),
      vetoObservedAt: veto?.length ? ref.observedAt ?? ref.retrievedAt : null, sourceStatus: match.sourceStatus };
    let market;
    if (pm && input.market) {
      const binding = matchMarket(match, pm);
      const rule = ruleScope(pm);
      const sourceMatches = /^https:\/\/(?:www\.)?hltv\.org\/matches\//.test(ref.sourceUrl)
        && match.eventKey.startsWith('cs2:hltv:') && match.authoritativeResult === true;
      const fb = input.market.fallback;
      const conclusion = instant(fb?.conclusionAt), checked = instant(fb?.checkedAt);
      const absence = fb?.absenceEvidenceId ? await host.loadEvidence(fb.absenceEvidenceId) : undefined;
      const absenceData = object(absence?.data);
      const hltvUnpublished = absenceData.kind === 'cs2_source_check' && absenceData.status === 'unpublished'
        && absenceData.eventKey === match.eventKey && instant(absenceData.checkedAt) === checked
        && Boolean(checked && age(asOf, instant(absence?.retrievedAt ?? absence?.retrieved_at)) >= 0)
        && /^https:\/\/(?:www\.)?hltv\.org\/matches\//.test(absence?.source ?? '');
      const fingerprint = (m: MatchRecord) => hash([m.state, m.participants.map(team => [norm(team.name), m.seriesScore?.[team.id]]).sort(),
        (m.maps ?? []).map(map => [map.index, norm(map.name), map.state, m.participants.map(team =>
          [norm(team.name), map.roundsPlayed?.[team.id], map.winnerId === team.id]).sort()])]);
      const independent = new Set(records.filter(row => fb?.evidenceIds.includes(row.ref.evidenceId)
        && row.match.authoritativeResult && row.coverage.series.status === 'covered'
        && matchMarket(row.match, pm).binding === 'verified' && fingerprint(row.match) === fingerprint(match))
        .map(row => new URL(row.ref.sourceUrl).hostname.replace(/^www\./, '')));
      const fallbackAllowed = !records.some(row => /^https:\/\/(?:www\.)?hltv\.org\/matches\//.test(row.ref.sourceUrl)
        && row.match.authoritativeResult && row.match.state === 'finished' && matchMarket(row.match, pm).binding === 'verified')
        && hltvUnpublished && Boolean(conclusion && checked && rule.fallbackHours !== null
        && age(checked, conclusion) >= rule.fallbackHours * 3600_000 && age(asOf, checked) >= 0 && independent.size >= 2);
      const quoteReceipt = object(input.market.quote);
      const selectedQuote = object(quoteReceipt.result ?? quoteReceipt);
      const quote = pm.requestedToken && selectedQuote.conditionId === pm.conditionId && selectedQuote.tokenId === pm.requestedToken
        && selectedQuote.bookShape === 'two_sided' && age(asOf, instant(selectedQuote.sourceTime)) >= 0
        && age(asOf, instant(selectedQuote.sourceTime)) <= 30_000 ? quoteReceipt : undefined;
      const settlement = input.market.settlement?.conditionId === pm.conditionId ? input.market.settlement : input.market.resolution;
      const specifiedSource = string(pm.market.resolutionSource);
      const conflict = specifiedSource && norm(specifiedSource) !== norm('https://hltv.org') && norm(specifiedSource) !== norm(sourceSetting('PM_HLTV_URL'));
      const result = binding.binding !== 'verified' || !pm.valid
        ? { status: 'pending', reason: !pm.valid ? '精确子盘口、规则版本或选项身份缺失。' : binding.reason }
        : !rule.valid || conflict || rule.mapIndex !== null && rule.mapIndex > (match.bestOf ?? 0)
          ? { status: 'unsupported', reason: '子盘口条款或指定来源存在缺口或不一致。' }
          : availability.series.status !== 'covered' || !(sourceMatches || fallbackAllowed)
            ? { status: 'pending', reason: '等待合约指定的 HLTV 或符合时限要求的替代证据。' }
            : derivedResult(match, pm, rule, asOf);
      market = { ...binding, ...result, binding: pm.valid ? binding.binding : 'unverified',
        identity: { eventSlug: pm.eventSlug, gammaMarketId: nativeId(pm.market.id), conditionId: pm.conditionId,
          requestedToken: pm.requestedToken, tokens: pm.tokens, eventGameId: pm.polymarketGameId,
          submarketGameId: pm.submarketGameId, providerGameId: pm.providerGameId, gridSeriesId: pm.gridSeriesId,
          polymarketTeams: pm.pmTeams, competition: pm.season, stage: pm.stage, bestOf: pm.format, scheduledAt: pm.startsAt, initialScheduledAt: pm.initialAt },
        ruleVersion: input.market.ruleVersion ?? hash([pm.rules, specifiedSource, pm.tokens]), rules: pm.rules, rule, quote, settlement,
        source: sourceMatches ? 'HLTV' : fallbackAllowed ? 'consensus' : null,
        inputEvidenceIds: unique([ref.evidenceId, ...input.market.inputEvidenceIds ?? [],
          ...fallbackAllowed && fb ? [fb.absenceEvidenceId, ...fb.evidenceIds] : []]) };
    }
    const snapshot: Cs2Snapshot = { ...identity, startedAt: startedAt ?? null, state, mode, asOf, facts,
      coverage: { ...availability, ...(market && { market: coverage(market.status === 'derived' ? 'covered'
        : market.status === 'unsupported' ? 'unsupported' : 'pending', market.reason, ref) }) },
      inputEvidenceIds: unique([...ids, ...input.market?.inputEvidenceIds ?? [], ...market?.inputEvidenceIds ?? []]), market };
    if (hidden) {
      const view: Cs2Snapshot = { eventKey: identity.eventKey, participants: identity.participants, competition: identity.competition,
        scheduledAt: identity.scheduledAt, startedAt: null, state: 'unknown', sourceUrl: media[0]?.url,
        mode, asOf, facts: { noSpoilers: true, historicalOnly, media },
        coverage: { media: { ...coverage(media.length ? 'covered' : 'pending', '本场无剧透观看链接'), evidenceId: ref.evidenceId } },
        inputEvidenceIds: [ref.evidenceId] };
      watchSnapshots.set(view, snapshot);
      return view;
    }
    return snapshot;
  }

  return { sport: 'cs2', find, inspect, changes,
    watchDefaults(snapshot) {
      const maps = Array.from({ length: snapshot.facts.bestOf ?? 0 }, (_, index) => index + 1);
      return {
        conditions: [{ kind: 'series_started' }, ...maps.flatMap(mapIndex =>
          [{ kind: 'map_started', mapIndex }, { kind: 'map_completed', mapIndex }]), { kind: 'series_finished' }],
        expiresAt: new Date(Math.max(Date.parse(snapshot.asOf), Date.parse(snapshot.scheduledAt ?? '') || 0) + 6 * 3600_000).toISOString(),
      };
    },
    prepareWatch(snapshot, conditions) {
      const original = watchSnapshots.get(snapshot);
      return prepareWatch(original ?? snapshot, original ? conditions.map(condition => ({ ...condition, noSpoilers: true })) : conditions);
    },
  };
}

function normalizeCondition(condition: Condition, snapshot: Cs2Snapshot) {
  const target = object(condition.target);
  const index = condition.mapIndex ?? condition.map_index ?? target.mapIndex
    ?? (typeof condition.target === 'number' ? condition.target : undefined);
  const name = condition.mapName ?? condition.map_name ?? target.mapName;
  const teamId = condition.teamId ?? target.teamId ?? (condition.kind === 'lineup_changed' ? condition.target : undefined);
  const map = condition.kind.startsWith('map_');
  const reason = !watchKinds.some(kind => kind === condition.kind) ? '不支持该 CS2 条件。'
    : condition.threshold !== undefined ? '该条件不使用阈值。'
    : map && (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > (snapshot.facts.bestOf ?? 0))
      ? '地图条件需要在该场 BO 范围内指定图序。'
    : map && name !== undefined && (typeof name !== 'string' || !norm(name)) ? '地图名无效。'
    : !map && (index !== undefined || name !== undefined) ? '本条件无需地图参数。'
    : teamId !== undefined && (condition.kind !== 'lineup_changed' || !snapshot.participants.some(team => team.id === teamId))
      ? '阵容条件的目标必须是本场球队 ID。' : null;
  return { reason, condition: { kind: condition.kind, mapIndex: index as number | undefined, mapName: mapNameKey(name) || undefined,
    teamId: typeof teamId === 'string' ? teamId : undefined, noSpoilers: noSpoilers(condition) } };
}

function seriesFinished(snapshot: Cs2Snapshot) {
  if (snapshot.state === 'canceled' || snapshot.state === 'forfeit') return true;
  if (snapshot.state !== 'finished') return false;
  const { bestOf, seriesScore, winnerId, endedAt } = snapshot.facts;
  const [first, second] = snapshot.participants.map(team => seriesScore?.[team.id] ?? -1);
  const needed = bestOf && Math.ceil(bestOf / 2);
  return Boolean(endedAt && snapshot.participants.some(team => team.id === winnerId)
    || needed && first !== undefined && second !== undefined && Math.max(first, second) === needed
      && Math.min(first, second) >= 0 && Math.min(first, second) < needed);
}

function conditionCoverage(snapshot: Cs2Snapshot, condition: Condition) {
  const field = condition.kind === 'series_rescheduled' ? 'schedule' : condition.kind === 'lineup_changed' ? 'lineups'
    : condition.kind === 'veto_published' ? 'veto' : condition.kind === 'map_awarded' ? 'awards'
    : condition.kind.startsWith('map_') ? 'maps' : condition.kind === 'series_finished' ? 'series' : 'seriesStart';
  const status = snapshot.coverage[field] ?? coverage('unavailable', '当前来源缺少该字段。');
  const map = snapshot.facts.maps?.find(m => m.index === condition.mapIndex);
  if (status.status !== 'covered') return status;
  if (condition.kind === 'series_finished' && snapshot.state === 'finished' && !seriesFinished(snapshot))
    return { ...status, status: 'pending' as const, detail: '来源标记完赛，尚缺一致的系列比分或赛果。' };
  if (condition.mapName && map?.name && mapNameKey(map.name) !== condition.mapName)
    return { ...status, status: 'pending' as const, detail: '该图序目前对应另一张地图。' };
  if (condition.teamId && !snapshot.facts.lineups?.some(lineup => lineup.teamId === condition.teamId && lineup.status !== 'historical'))
    return { ...status, status: 'pending' as const, detail: '缺目标队的本赛事阵容。' };
  return status;
}

function scopedConditions(snapshot: Cs2Snapshot, conditions: Condition[]) {
  return conditions.flatMap(condition => condition.kind === 'lineup_changed' && !condition.teamId
    && condition.target === undefined && snapshot.participants.length === 2
    ? snapshot.participants.map(team => ({ ...condition, teamId: team.id })) : [condition]);
}

function prepareWatch(snapshot: Cs2Snapshot, conditions: Condition[]) {
  const acceptedConditions = [], blockedConditions = [];
  const keys = new Set<string>(), sources = new Set<string>();
  for (const input of scopedConditions(snapshot, conditions)) {
    const { reason, condition } = normalizeCondition(input, snapshot);
    const available = conditionCoverage(snapshot, condition);
    const blocked = snapshot.mode !== 'live' || snapshot.facts.historicalOnly ? '历史核对或回放不能创建实时订阅。'
      : reason ?? (available.status !== 'covered' ? `${available.status} · ${available.detail}` : null)
      ?? (['finished', 'canceled', 'forfeit'].includes(snapshot.state) ? '赛事已结束。' : null);
    if (blocked) {
      blockedConditions.push({ condition: input, reason: blocked });
      continue;
    }
    const key = hash(condition);
    if (keys.has(key)) continue;
    keys.add(key);
    if (available.sourceUrl) sources.add(available.sourceUrl);
    acceptedConditions.push(condition);
  }
  return { acceptedConditions, blockedConditions, minIntervalSeconds: snapshot.eventKey.startsWith('cs2:grid:') ? 120 : 60,
    sources: [...sources] };
}

function observe(snapshot: Cs2Snapshot, condition: Condition) {
  const { kind, teamId, mapIndex } = condition;
  const { facts } = snapshot;
  const ref = facts.matchesSource;
  const map = facts.maps?.find(m => m.index === mapIndex);
  const observation = (value: string, state: string, occurredAt: string | null, summary: string, identity: unknown = value) => ({
    value, state, at: ref?.observedAt ?? ref?.retrievedAt ?? occurredAt, occurredAt, summary, identity,
    revision: map?.version ?? facts.updatedAt ?? ref?.observedAt ?? ref?.retrievedAt ?? '',
  });
  if (kind === 'series_started') return observation(snapshot.startedAt ?? '', snapshot.startedAt ? 'triggered' : 'waiting',
    snapshot.startedAt, '已确认系列赛实际开打。');
  const byTeam = facts.seriesScore;
  const seriesScore = !noSpoilers(condition) && byTeam && snapshot.participants.length === 2
    ? ' 大比分 ' + snapshot.participants.map(team => `${team.name} ${byTeam[team.id]}`).join(' – ') + '。' : '';
  if (kind === 'series_finished') {
    const finished = seriesFinished(snapshot);
    const summary = noSpoilers(condition) ? '所订阅的系列赛已结束。' : snapshot.state === 'canceled' ? '系列赛已取消。'
      : snapshot.state === 'forfeit' ? '系列赛因弃权结束。' : '系列赛已结束。' + seriesScore;
    return observation(finished ? snapshot.state : '', finished ? 'triggered' : 'waiting', facts.endedAt ?? null, summary);
  }
  if (kind === 'series_rescheduled') return observation(snapshot.scheduledAt ?? '', snapshot.scheduledAt ? 'triggered' : 'waiting',
    instant(facts.reschedulePublishedAt), `赛程更新为 ${snapshot.scheduledAtBeijing ?? snapshot.scheduledAt}（北京时间）。`);
  if (kind === 'veto_published') return observation(facts.veto?.length ? hash(facts.veto) : '', facts.veto?.length ? 'triggered' : 'waiting',
    instant(facts.vetoPublishedAt), '本场禁选已发布或更新。');
  if (kind === 'lineup_changed') {
    const lineups = facts.lineups?.filter(row => row.status !== 'historical' && (!teamId || row.teamId === teamId)) ?? [];
    const byTeam = new Map<string, Lineup>();
    const ranks = { historical: 0, announced: 1, registered: 2, confirmed: 3, played: 4 };
    for (const lineup of lineups) {
      const prior = byTeam.get(lineup.teamId);
      if (!prior || ranks[lineup.status] >= ranks[prior.status]) byTeam.set(lineup.teamId, lineup);
    }
    const signature = [...byTeam.values()].map(row => [row.teamId, [...row.players].sort(),
      (row.substitutes ?? []).map(s => [s.in, s.out, s.state === 'withdrawn' ? 'withdrawn' : 'active']).sort()]).sort();
    const stamp = lineups.map(row => instant(row.publishedAt)).filter((s): s is string => Boolean(s)).sort().at(-1);
    return observation(byTeam.size ? hash(signature) : '', byTeam.size ? 'triggered' : 'waiting', instant(stamp), '本场阵容或临时替补已更新。');
  }
  const target = map?.providerGameId ?? `${mapIndex}:${map?.name ?? ''}`;
  const occurred = kind === 'map_started' ? map?.startedAt
    : kind === 'map_completed' ? map?.state === 'played' || map?.state === 'finished_unverified'
    : map?.state === 'awarded';
  // GRID exposes a terminal provider state without the official administrative disposition.
  const detail = kind === 'map_started' ? '已确认开打。' : kind === 'map_awarded' ? '已确认行政判图。'
    : map?.state === 'finished_unverified' ? 'GRID 已标记结束，实打或判图仍待赛果来源确认。' : '已确认实打完赛。';
  const summary = noSpoilers(condition) ? '所订阅的地图状态已更新。'
    : `第 ${mapIndex} 图${map?.name ? ` ${map.name}` : ''}，${detail}` + (kind === 'map_completed' ? seriesScore : '');
  const identity = [target, kind === 'map_started' ? map?.startedAt : map?.version ?? map?.state];
  return observation(occurred ? hash(identity) : '', occurred ? 'triggered' : map?.state ?? 'waiting',
    kind === 'map_started' ? map?.startedAt ?? null : instant(map?.changedAt), summary, identity);
}

function changes(previous: Baseline | undefined, current: Cs2Snapshot, draft: Draft & { eventKey?: string }) {
  const baseline = { ...previous }, events = [], fields: Coverage = {};
  for (const input of scopedConditions(current, draft.conditions ?? draft.acceptedConditions ?? [])) {
    const { reason, condition } = normalizeCondition(input, current);
    const key = [condition.kind, condition.mapIndex, condition.mapName, condition.teamId].join(':');
    const available = conditionCoverage(current, condition);
    fields[key] = draft.eventKey && draft.eventKey !== current.eventKey ? coverage('unavailable', '当前快照属于另一场。')
      : reason && current.facts.bestOf != null ? coverage('unsupported', reason) : available;
    if (fields[key].status !== 'covered' || reason || current.facts.historicalOnly) continue;
    const seen = observe(current, { ...condition, noSpoilers: noSpoilers(input) || noSpoilers(draft) });
    const earlier = baseline[key];
    if (earlier && ((earlier.at && seen.at && seen.at < earlier.at) || earlier.revision === seen.revision
      || earlier.value && !seen.value && !['canceled', 'restarted'].includes(seen.state))) continue;
    baseline[key] = { value: seen.value, state: seen.state, revision: seen.revision, at: seen.at };
    if (!earlier || !seen.value || earlier.value === seen.value || seen.state !== 'triggered') continue;
    const evidenceId = available.evidenceId;
    if (!evidenceId) continue;
    events.push({ eventKey: hash([current.eventKey, key, seen.identity]), kind: condition.kind,
      occurredAt: seen.occurredAt, summary: seen.occurredAt || !available.observedAt ? seen.summary
        : `${seen.summary}
来源观测时间 ${available.observedAt}`, inputEvidenceIds: [evidenceId],
      sourceUrl: available.sourceUrl === gridUrl ? publicGridUrl : available.sourceUrl ?? current.sourceUrl });
  }
  const finished = (!draft.eventKey || draft.eventKey === current.eventKey) && !current.facts.historicalOnly
    && current.coverage.series?.status === 'covered' && seriesFinished(current);
  return { baseline, events, coverage: fields, finished };
}
