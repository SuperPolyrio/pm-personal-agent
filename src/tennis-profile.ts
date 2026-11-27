import { sourceSetting } from './source-config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readTennisSource } from './sports-tennis.js';
import type { SportsHost } from './sports.js';

const atp = sourceSetting('PM_ATP_URL');
const wta = sourceSetting('PM_WTA_API_URL') + '/tennis';
const execute = promisify(execFile);
export const surfaces = ['hard', 'clay', 'grass'] as const;
type Surface = typeof surfaces[number];
type Player = { id: string; tour: 'ATP' | 'WTA'; url: string };
type Data = Record<string, unknown>;
const object = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const rows = (v: unknown): Data[] => Array.isArray(v) ? v.map(object) : [];
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const rate = (v: unknown) => {
  const n = number(v);
  return n !== null && n <= 100 ? n / 100 : null;
};
const stop = /^\d{4}-\d\d-\d\d$/;
const yearNow = () => new Date().getUTCFullYear();
const failure = (e: unknown) => e instanceof Error ? (e.cause as { code?: string } | undefined)?.code ?? e.message : String(e);

export function tennisPlayer(url: string): Player {
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password)
    throw Error('请提供 ATP 或 WTA 官网选手链接。');
  const path = parsed.pathname;
  const a = /^\/en\/players\/[a-z0-9-]+\/([a-z0-9]{4,6})(?:\/[a-z-]+)?\/?$/i.exec(path);
  const w = /^\/players\/(\d{5,8})\/[a-z0-9-]+(?:\/[a-z-]+)?\/?$/i.exec(path);
  if (parsed.hostname === 'www.atptour.com' && a) return { id: a[1].toUpperCase(), tour: 'ATP', url: atp+path };
  if (parsed.hostname === 'www.wtatennis.com' && w) return { id: w[1], tour: 'WTA', url: sourceSetting('PM_WTA_WEB_URL')+path };
  throw Error('选手链接应来自 ATP 或 WTA 官网，并含原生选手 ID。');
}

export async function tennisProfile(host: SportsHost, player: Player, surface: Surface, year: number, limit: number | undefined, signal: AbortSignal) {
  if (!Number.isInteger(year) || year < 2000 || year > yearNow()) throw Error('赛季须处于 2000 年和当前年份之间。');
  const proofs: { url: string; evidenceId: string; retrievedAt: string }[] = [];
  const gaps: { url: string; reason: string; evidenceId: string }[] = [];
  function capture(url: string, raw: unknown, retrievedAt?: string) {
    const saved = host.saveEvidence(url, { kind: 'tennis_profile_source', raw }, retrievedAt);
    proofs.push({ url, evidenceId: saved.evidenceId, retrievedAt: saved.retrievedAt });
    return saved.evidenceId;
  }
  async function read(url: string, transport?: () => Promise<unknown>) {
    try {
      if (transport) return { raw: await transport(), retrievedAt: new Date().toISOString() };
      const response = await readTennisSource(url, signal);
      return { raw: JSON.parse(response.body) as unknown, retrievedAt: response.retrievedAt };
    } catch (error) {
      signal.throwIfAborted();
      const reason = failure(error);
      gaps.push({ url, reason, evidenceId: host.saveEvidence(url, { kind: 'tennis_profile_source_gap', reason }).evidenceId });
      return null;
    }
  }
  const base = { player, surface, season: year, historyAsAvailableNow: true, proofs, gaps };
  if (player.tour === 'ATP') {
    if (limit !== undefined) throw Error('ATP 官网是赛季场地汇总。查询 ATP 时省略 sample_size。');
    const url = `${atp}/en/-/www/stats/${player.id.toLowerCase()}/${year}/${surface}?v=1`;
    const res = await read(url, async () => {
      try { return JSON.parse((await readTennisSource(url, signal)).body); }
      catch (error) {
        signal.throwIfAborted();
        // This official endpoint can reject the Node transport while normal HTTPS reads remain available.
        const { stdout } = await execute('python3', ['-c', [
          'import sys, requests',
          'r = requests.get(sys.argv[1], timeout=6, allow_redirects=False, stream=True)',
          'if r.status_code != 200: sys.exit("HTTP_" + str(r.status_code))',
          'body = r.raw.read(128001, decode_content=True)',
          'if len(body) > 128000: sys.exit("response_too_large")',
          'sys.stdout.buffer.write(body)',
        ].join('\n'), url], { signal, timeout: 8_000, maxBuffer: 128_000 }).catch(e => {
          throw Error(String(e.stderr ?? '').trim().split('\n').at(-1) || failure(error));
        });
        return JSON.parse(stdout);
      }
    });
    if (!res) return { ...base, status: 'unavailable', sampleBasis: 'official_season_surface_totals' };
    capture(url, res.raw, res.retrievedAt);
    const stats = object(object(res.raw).Stats);
    if (stats.PlayerId !== player.id || stats.EventYear !== year || String(stats.Surface ?? '').toLowerCase() !== surface)
      return { ...base, status: 'unavailable', sampleBasis: 'official_season_surface_totals', reason: 'ATP 返回的选手、赛季或场地不符，或没有统计。' };
    const serve = object(stats.ServiceRecordStats), ret = object(stats.ReturnRecordStats);
    const metrics = {
      servePointsWon: rate(serve.ServicePointsWonPercentage), returnPointsWon: rate(ret.ReturnPointsWonPercentage),
      holdGamesWon: rate(serve.ServiceGamesWonPercentage), breakGamesWon: rate(ret.ReturnGamesWonPercentage),
      firstServeIn: rate(serve.FirstServePercentage), firstServePointsWon: rate(serve.FirstServePointsWonPercentage),
      secondServePointsWon: rate(serve.SecondServePointsWonPercentage),
      serviceGames: number(serve.ServiceGamesPlayed), returnGames: number(ret.ReturnGamesPlayed),
      servicePoints: null, returnPoints: null, matches: null, asReportedRankDate: stats.RankDate ?? null,
    };
    return { ...base, status: Object.values(metrics).slice(0,9).every(v => v !== null) ? 'ok' : 'partial',
      sampleBasis: 'official_season_surface_totals', metrics };
  }

  const size = limit ?? 8;
  if (!Number.isInteger(size) || size < 1 || size > 16) throw Error('WTA 样本数须为 1–16。');
  const historyUrl = `${wta}/players/${player.id}/matches?year=${year}&pageSize=200`;
  const history = await read(historyUrl);
  const data = object(history?.raw);
  const name = object(data.player).fullName;
  if (!history || String(object(data.player).id) !== player.id)
    return { ...base, status: 'unavailable', reason: 'WTA 未返回匹配的选手和赛季记录。' };
  const eligible = rows(data.matches).filter(m => String(m.tourn_year) === String(year) && m.s_d_flag === 'S' &&
    m.qpm_flag === 'M' && String(m.Surface).toLowerCase() === surface &&
    /^(?:WTA ?(?:250|500|1000)?|GS|PM|CH|P[1-5]?|[1-5])$/i.test(String(m.TournamentLevel)) &&
    /^\s*\d+-\d+(?:\(\d+\))?(?:\s+\d+-\d+(?:\(\d+\))?){1,2}\s*$/.test(String(m.scores)) &&
    /^\d{1,5}$/.test(String(m.tourn_nbr).trim()) && m.player_1 === player.id && /^\d+$/.test(String(m.player_2)) &&
    stop.test(String(object(m.tournament).startDate)) && stop.test(String(object(m.tournament).endDate)));
  const events = [...new Map(eligible.map(m => [String(m.tourn_nbr).trim(), String(object(m.tournament).endDate)])).entries()]
    .sort((a,b) => b[1].localeCompare(a[1]));
  capture(historyUrl, { player: data.player, returnedRows: rows(data.matches).length, eligible }, history.retrievedAt);
  const considered = events.slice(0,6);
  const matchesHistory = (m: Data, h: Data) => Number(m.EventID) === Number(h.tourn_nbr) &&
    (m.PlayerIDA === player.id && m.PlayerIDB === h.player_2 || m.PlayerIDB === player.id && m.PlayerIDA === h.player_2);
  const draws = await Promise.all(considered.map(async ([id]) => {
    const url = `${wta}/tournaments/${id}/${year}/matches`;
    const res = await read(url);
    if (!res) return [];
    const entries = rows(object(res.raw).matches).filter(m => String(m.EventYear) === String(year) &&
      /^\d{1,5}$/.test(String(m.EventID)) && Number(m.EventID) === Number(id) &&
      m.MatchState === 'F' && m.DrawMatchType === 'S' && m.DrawLevelType === 'M' &&
      /^LS\d{3,10}$/.test(String(m.MatchID)) && !/retir|w.?o\b|walk.?over|default|\bRET\b/i.test(String(m.ResultString)) &&
      Number.isFinite(Date.parse(String(m.MatchTimeStamp))) &&
      (m.PlayerIDA === player.id || m.PlayerIDB === player.id));
    const matches = entries.filter(m => eligible.some(h => matchesHistory(m,h)));
    const evidenceId = capture(url, { lastUpdated: object(res.raw).lastUpdated, matches,
      unmatchedScores: entries.filter(m => !matches.includes(m)) }, res.retrievedAt);
    return matches.map(match => ({ match, evidenceId }));
  }));
  const known = draws.flat().sort((a,b) => Date.parse(String(b.match.MatchTimeStamp))-Date.parse(String(a.match.MatchTimeStamp)));
  const selected = known.slice(0,size);
  const oldest = Date.parse(String(selected.at(-1)?.match.MatchTimeStamp)) || 0;
  const consideredRecent = considered.filter(([, end]) => Date.parse(end + 'T23:59:59Z') >= oldest);
  const unmatched = eligible.filter(h => consideredRecent.some(([id]) => id === String(h.tourn_nbr).trim()) &&
    !known.some(({ match }) => matchesHistory(match,h)) && !/retir|\bret\b|walk.?over/i.test(String(h.reason_code)));
  const sample = await Promise.all(selected.map(async ({ match, evidenceId: scoreEvidenceId }) => {
    const url = `${wta}/tournaments/${match.EventID}/${year}/matches/${match.MatchID}/stats`;
    const res = await read(url);
    if (!res) return null;
    const total = rows(res.raw).find(m => m.setnum === 0 && Number(m.eventid) === Number(match.EventID) &&
      String(m.eventyear) === String(year) && m.matchid === match.MatchID);
    const evidenceId = capture(url, total ?? res.raw, res.retrievedAt);
    const side = match.PlayerIDA === player.id ? 'a' : 'b';
    const opp = side === 'a' ? 'b' : 'a';
    const v = (key: string, s = side) => number(total?.[key+s]);
    const ratio = (numerator: number | null, denominator: number | null) =>
      numerator !== null && denominator !== null && denominator > 0 && numerator <= denominator ? [numerator, denominator] as const : null;
    const diff = (a: number | null, b: number | null) => a === null || b === null ? null : a-b;
    const service = v('totservplayed'), own = v('ptstotwonserv'), firstWon = v('ptswon1stserv'), first = v('ptsplayed1stserv');
    const returnPoints = v('totservplayed',opp);
    const suffix = side.toUpperCase(), other = opp.toUpperCase();
    const setScores = [1,2,3].slice(0, Number(match.NumSets)).map(n =>
      [match[`ScoreSet${n}${suffix}`], match[`ScoreSet${n}${other}`]]);
    const setGames = setScores.map(scores => scores.map(value => /^[0-7]$/.test(String(value)) ? Number(value) : NaN));
    const legal = match.ScoreSys === '1' && [2,3].includes(setGames.length) && setGames.every(([a,b]) => {
      const high = Math.max(a,b), low = Math.min(a,b);
      return high === 6 && low <= 4 || high === 7 && low >= 5 && low <= 6;
    });
    const wonSets = setGames.filter(([a,b]) => a > b).length;
    const gameTotals = legal && (wonSets === 2 || setGames.length-wonSets === 2) ? setGames.reduce(([left,right],[a,b]) =>
      // A tiebreak counts toward the set score, but it adds no ordinary service game.
      [left + (a === 7 && b === 6 ? 6 : a), right + (b === 7 && a === 6 ? 6 : b)], [0,0]) : null;
    const breaks = v('breakptsconv'), conceded = v('breakptsconv',opp);
    const held = gameTotals && diff(gameTotals[0], breaks);
    const opposingHolds = gameTotals && diff(gameTotals[1], conceded);
    const reconciled = held !== null && opposingHolds !== null && breaks !== null && conceded !== null && held >= 0 && opposingHolds >= 0;
    const counts = {
      servePointsWon: ratio(own,service),
      returnPointsWon: ratio(diff(returnPoints,v('ptstotwonserv',opp)),returnPoints),
      holdGamesWon: reconciled ? ratio(held,held+conceded) : null,
      breakGamesWon: reconciled ? ratio(breaks,opposingHolds+breaks) : null,
      firstServeIn: ratio(first,service), firstServePointsWon: ratio(firstWon,first),
      secondServePointsWon: ratio(diff(own,firstWon),diff(service,first)),
    };
    const historyMatch = eligible.find(h => matchesHistory(match,h));
    return { eventKey: `tennis:wta:${year}.${match.EventID}.${match.MatchID}`,
      tournament: object(historyMatch?.tournament).title ?? historyMatch?.TournamentName ?? null,
      scoreInPlayerOrder: setScores.map(set => set.join('–')).join(', '),
      result: wonSets === 2 ? 'win' : setGames.length-wonSets === 2 ? 'loss' : null,
      opponentId: match['PlayerID'+other], opponent: [match['PlayerNameFirst'+other],match['PlayerNameLast'+other]].join(' '),
      matchSourceTime: match.MatchTimeStamp, scoreEvidenceId,
      counts, url, evidenceId };
  }));
  const matchRows = sample.filter(s => s !== null);
  const metrics = Object.fromEntries(Object.keys(matchRows[0]?.counts ?? {}).map(k => {
    const values = matchRows.map(m => m.counts[k as keyof typeof m.counts]).filter(v => v !== null);
    const totals = values.reduce(([wins, points], v) => [wins+v[0],points+v[1]], [0,0]);
    return [k, { won: totals[0], total: totals[1], rate: totals[1] ? totals[0]/totals[1] : null, matches: values.length }];
  }));
  return { ...base, player: { ...player, name }, sampleBasis: 'recent_completed_main_draw_matches_in_season',
    status: !matchRows.some(m => m.counts.servePointsWon) ? 'unavailable'
      : gaps.length || unmatched.length || matchRows.length < size || Object.values(metrics).some(m => m.matches < size) ? 'partial' : 'ok',
    requestedMatches: size, matchingHistoryRows: eligible.length, matchingEvents: events.length, queriedEvents: considered.length,
    selectedMatches: selected.length, metrics, sample: matchRows,
    unmatchedHistory: unmatched.map(h => ({ tournament: h.TournamentName, opponent: object(h.opponent).fullName,
      reason: '选手战绩与签表比分未对上相同原生对手 ID 或完整比分。' })),
    reason: selected.length ? undefined : '指定赛季和场地未核对到可用的完整单打样本。' };
}
