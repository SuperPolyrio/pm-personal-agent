import { setTimeout as sleep } from 'node:timers/promises';
import {
  DemoReader, EntityMode, HttpBroadcastReader, WinRoundReason, createDefaultFetcher,
  type BroadcastSyncDto, type Player,
} from 'cs2parser';

type Side = 0 | 1;
type Score = [number, number];
export type Cs2Play = { tick: number; player: string; side: Side } & (
  { kind: 'kill'; victim: string; weapon: string; headshot: boolean }
  | { kind: 'other_death' }
  | { kind: 'plant' | 'defuse' }
);
export type Cs2LiveMatch = {
  sourceUrl: string;
  relay: string;
  teams: [string, string];
  maps: string[];
  priorWinners: Side[];
  marketEventSlug?: string;
};
type RoundObservation = { tick: number; fragment: number; receivedAt: number };
export type Cs2LiveRound = {
  match: Cs2LiveMatch;
  mapIndex: number;
  score: Score;
  series: Score;
  winner: Side;
  reason?: WinRoundReason;
  mapOver: boolean;
  seriesOver: boolean;
  fullRound: boolean;
  plays: Cs2Play[];
  video?: { source: string; scoreChecked?: boolean; objectives: { kind: 'plant' | 'defuse'; side: Side; at: number }[] };
  start?: RoundObservation;
  aliveAtStart?: Score;
  missingRoundsBefore?: number;
  ticksPerSecond?: number;
  tick: number;
  fragment: number;
  receivedAt: number;
};

const teamKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/clan$/, '');
const mapKey = (name: string) => name.toLowerCase().replace(/^de_/, '').replace(/\s/g, '').replace(/^dustii$/, 'dust2');
const roundReasons = new Set<number>([WinRoundReason.TARGET_BOMBED, WinRoundReason.BOMB_DEFUSED,
  WinRoundReason.T_ELIMINATED, WinRoundReason.CT_ELIMINATED, WinRoundReason.TARGET_SAVED]);

function killsAndPlayers(round: Cs2LiveRound) {
  if (!round.fullRound || !round.aliveAtStart) return [];
  const alive = [...round.aliveAtStart] as Score;
  const dead = new Set<string>();
  const timeline = [];
  for (const play of round.plays) {
    if (play.kind !== 'kill' && play.kind !== 'other_death') continue;
    const victimSide = play.kind === 'kill' ? 1 - play.side : play.side;
    const victim = play.kind === 'kill' ? play.victim : play.player;
    if (dead.has(victim) || alive[victimSide] <= 0) return [];
    dead.add(victim);
    alive[victimSide]--;
    timeline.push({ play, alive: [...alive] as Score });
  }
  return timeline;
}

export function cs2MapWinner([first, second]: Score): Side | undefined {
  const leading = Math.max(first, second);
  const margin = Math.abs(first - second);
  if (margin < 2 || leading < 13 || (leading - 13) % 3 !== 0 || leading > 13 && margin > 4) return;
  return first > second ? 0 : 1;
}

const roundNumber = ({ score }: Cs2LiveRound) => score[0] + score[1];
const scoreText = (score: Score) => score.join('–');
const killsIn = (round: Cs2LiveRound) => round.plays.filter(play => play.kind === 'kill');
type Kill = ReturnType<typeof killsIn>[number];
type Death = ReturnType<typeof killsAndPlayers>[number];
const callKill = (kill: Kill) => `${kill.player} ${kill.headshot ? '爆头' : '击倒'} ${kill.victim}`;
const isElimination = (round: Cs2LiveRound) =>
  round.reason === WinRoundReason.T_ELIMINATED || round.reason === WinRoundReason.CT_ELIMINATED;

function recentRounds(round: Cs2LiveRound, history: readonly Cs2LiveRound[]) {
  const sameMap = history.filter(prior => prior.match.sourceUrl === round.match.sourceUrl
    && prior.mapIndex === round.mapIndex && prior.receivedAt < round.receivedAt);
  const recent = [];
  let next = round;
  for (let i = roundNumber(round) - 1; i > 0 && recent.length < 4; i--) {
    const prior = sameMap.find(row => roundNumber(row) === i
      && row.score[next.winner] + 1 === next.score[next.winner]
      && row.score[1 - next.winner] === next.score[1 - next.winner]);
    if (!prior) break;
    recent.push(prior);
    next = prior;
  }
  return recent;
}

function mapPoint(round: Cs2LiveRound, side = round.winner) {
  const score = round.score[side];
  return !round.mapOver && score >= 12 && (score - 12) % 3 === 0 && score > round.score[1 - side];
}

function roundContext(round: Cs2LiveRound, recent: Cs2LiveRound[]) {
  const prior = recent[0];
  if (!prior || prior.winner === round.winner || !prior.fullRound || (!mapPoint(round) && !round.mapOver)) return '';
  const team = prior.match.teams[prior.winner];
  if (prior.score[prior.winner] >= prior.score[1 - prior.winner]) return '';
  const counts = new Map<string, number>();
  for (const kill of killsIn(prior)) if (kill.side === prior.winner) counts.set(kill.player, (counts.get(kill.player) ?? 0) + 1);
  const star = [...counts].find(([, count]) => count >= 3);
  return star ? `上一分，${star[0]} ${star[1]} 杀帮 ${team} 追到 ${prior.score[prior.winner]}–${prior.score[1 - prior.winner]}。` : '';
}

function decisiveFight(timeline: Death[], round: Cs2LiveRound) {
  const groups: { start: number; end: number }[] = [];
  const rate = round.ticksPerSecond || 64;
  for (const [i, { play }] of timeline.entries()) {
    if (play.kind !== 'kill' || play.side !== round.winner) continue;
    const previous = groups.at(-1);
    if (previous && previous.end === i - 1 && play.tick - timeline[i - 1].play.tick <= 5 * rate)
      previous.end = i;
    else groups.push({ start: i, end: i });
  }
  const winner = round.winner, other = 1 - winner;
  return groups.filter(({ start, end }) => {
    const before = timeline[start - 1]?.alive ?? round.aliveAtStart!;
    const after = timeline[end].alive;
    return end > start && (before[winner] <= before[other] || (before[winner] - before[other] === 1 && after[other] <= 1));
  }).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
}

function describeFight(round: Cs2LiveRound) {
  const { winner, reason, plays } = round;
  const team = round.match.teams[winner], other = 1 - winner;
  const kills = killsIn(round);
  if (round.video) {
    const plays = [
      ...kills.map(kill => ({ at: kill.tick, text: callKill(kill) + '。' })),
      ...round.video.objectives.map(event => ({ at: event.at,
        text: `${round.match.teams[event.side]} ${event.kind === 'plant' ? '下包' : '完成拆包'}。` })),
    ].sort((a, b) => a.at - b.at);
    return plays.map(play => play.text).join('') + `${team} 拿下这一分。`;
  }
  const timeline = killsAndPlayers(round);
  const final = kills.at(-1);
  const finisher = isElimination(round) && final?.side === winner && Math.abs(final.tick - round.tick) <= 4 ? final : undefined;
  const defuse = plays.find(play => play.kind === 'defuse');
  const plant = plays.find(play => play.kind === 'plant');
  const ending = reason === WinRoundReason.BOMB_DEFUSED ? `${defuse?.player ?? team} 完成拆包。`
    : reason === WinRoundReason.TARGET_BOMBED ? 'C4 引爆。'
    : reason === WinRoundReason.TARGET_SAVED ? `${team} 守到时间耗尽。`
    : finisher ? `${finisher.player} 收掉最后的 ${finisher.victim}。` : '';
  const clutch = timeline.find(({ alive }) => alive[winner] === 1 && alive[other] >= 2);
  if (clutch && finisher) return `${finisher.player} 在 1 打 ${clutch.alive[other]} 的残局里收掉了最后的 ${finisher.victim}。`;
  const fight = decisiveFight(timeline, round);
  if (fight) {
    const { start, end } = fight;
    const sequence = timeline.slice(start, end + 1).map(row => row.play as Kill);
    const before = timeline[start - 1]?.alive ?? round.aliveAtStart!;
    const after = timeline[end].alive;
    const first = sequence[0];
    const last = sequence.at(-1)!;
    const opener = timeline[start - 2]?.play;
    const trade = timeline[start - 1]?.play;
    const rate = round.ticksPerSecond || 64;
    const setup = opener?.kind === 'kill' && trade?.kind === 'kill' && trade.victim === opener.player && before[winner] === before[other]
      && trade.tick - opener.tick <= 4 * rate
      ? `${callKill(opener)}，${trade.player} 马上补枪，拉回 ${before[winner]} 打 ${before[other]}。`
      : '';
    const elapsed = Math.max(1, Math.round((last.tick - first.tick) / rate));
    const samePlayer = sequence.every(kill => kill.player === first.player);
    const rest = sequence.slice(1);
    const key = samePlayer
      ? `${callKill(first)}，${rest.length > 1 && rest.every(kill => kill.headshot) ? '接着连爆' : '接着击倒'} ${rest.map(kill => kill.victim).join('、')}`
      : `${[...new Set(sequence.map(kill => kill.player))].join('、')} 连拿 ${sequence.length} 杀`;
    const reply = after[other] === 1 && finisher && kills.find(kill => kill.side === other && kill.tick > last.tick);
    return setup + `${key}，约 ${elapsed} 秒把 ${before[winner]} 打 ${before[other]} 变成 ${after[winner]} 打 ${after[other]}。`
      + (reply ? `${reply.player} 还带走了 ${reply.victim}，${finisher.player} 收掉残局。` : finisher === last ? '' : ending);
  }
  const behind = timeline.findIndex(({ alive }) => alive[other] - alive[winner] >= 2);
  const recovery = behind >= 0 && timeline.slice(behind + 1)
    .find(({ play, alive }) => play.kind === 'kill' && play.side === winner && alive[winner] === alive[other]);
  if (recovery && recovery.play.kind === 'kill') {
    const { alive } = timeline[behind];
    return `${team} 一度 ${alive[winner]} 打 ${alive[other]}，${callKill(recovery.play)}把人数拉回 ${recovery.alive[winner]} 打 ${recovery.alive[other]}。`
      + (recovery.play === finisher ? '' : ending);
  }
  if (reason === WinRoundReason.TARGET_BOMBED && plant) return `${plant.player} 下包，C4 引爆。`;
  if (reason === WinRoundReason.BOMB_DEFUSED && plant && defuse) return `${plant.player} 下包，${defuse.player} 完成拆包。`;
  if (ending) return ending;
  if (round.fullRound && kills[0]?.side === winner) return `${callKill(kills[0])}拿到首杀，${team} 收下这一分。`;
  return `${team} 拿下这一分。`;
}

export function formatCs2LiveRound(round: Cs2LiveRound, history: readonly Cs2LiveRound[] = []): string {
  const { match, mapIndex, score, winner, mapOver, seriesOver, series, fullRound } = round;
  const [first, second] = match.teams;
  const map = match.maps[mapIndex];
  const team = match.teams[winner], other = winner === 0 ? 1 : 0;
  const number = roundNumber(round);
  const recent = recentRounds(round, history);
  const winsNeeded = Math.floor(match.maps.length / 2) + 1;
  let result = '';
  if (mapOver) result = `${team} 拿下 ${map}${seriesOver ? '，赢下系列赛' : ''}。大比分 ${first} ${series[0]}–${series[1]} ${second}。`;
  else if (mapPoint(round)) {
    const seriesPoint = series[winner] + 1 === winsNeeded;
    const remaining = score[winner] - score[other];
    result = `${team} 拿到${seriesPoint ? '系列赛赛点，再拿一分就赢下比赛' : '图点'}。`
      + (remaining > 1 ? `${match.teams[other]} 需连救 ${remaining} 个${seriesPoint ? '赛点' : '图点'}才能打进${score[winner] === 12 ? '加时' : '下一轮加时'}。` : '');
  } else if (mapPoint(round, other)) result = `${team} 救下一个${series[other] + 1 === winsNeeded ? '赛点' : '图点'}。`;
  else if (number === 12) result = score[0] === score[1] ? '半场战平。' : '半场结束。';
  else if (score[0] === score[1]) {
    result = score[winner] >= 12 ? (score[winner] === 12 ? '双方打进加时。' : '双方进入下一轮加时。') : `${team} 扳平比分。`;
  } else if (recent.length >= 2 && recent[0].winner === winner && recent[1].winner === winner && recent[2]?.winner !== winner)
    result = `${team} 连拿 3 分。`;
  else if (score[winner] - score[other] === 1 && score[other] > 0) result = `${team} 取得领先。`;
  const coverage = [round.video?.scoreChecked ? 'CSTV 已核对比分，画面过程仍待完整核对。'
    : round.video ? 'PGL 官方直播画面速报，待 CSTV 核对。' : !fullRound && '本回合仅取得部分事件。', round.missingRoundsBefore &&
    `此前有 ${round.missingRoundsBefore} 个回合缺少过程记录。`].filter(Boolean).join('');
  return `${map} · 第 ${number} 回合｜${first} ${scoreText(score)} ${second}\n${roundContext(round, recent)}${describeFight(round)}${result}${coverage ? '\n' + coverage : ''}`;
}

export async function followCs2Playcast(
  match: Cs2LiveMatch,
  signal: AbortSignal,
  onRound: (round: Cs2LiveRound) => void,
  status: (state: string, detail: unknown) => void,
  source = createDefaultFetcher(match.relay),
  previousScore?: (mapIndex: number) => Score | undefined,
  onMap?: (mapIndex: number, score: Score, series: Score, roster: [string[], string[]]) => void,
) {
  const series: Score = [0, 0];
  for (const winner of match.priorWinners) series[winner]++;
  const winsNeeded = Math.floor(match.maps.length / 2) + 1;
  let mapIndex = match.priorWinners.length;
  let lastStatus = '';
  let lastScore: Score | undefined;
  let lastMap = -1;
  let lastFragment: { tick: number; number: number } | undefined;
  const report = (state: string, detail: unknown, key = state) => {
    if (lastStatus !== key) status(state, detail);
    lastStatus = key;
  };
  while (!signal.aborted && mapIndex < match.maps.length && Math.max(...series) < winsNeeded) {
    const expectedMap = mapKey(match.maps[mapIndex]);
    try {
      const sync = await source.json<BroadcastSyncDto>('sync', AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      if (!sync.map || mapKey(sync.map) !== expectedMap || sync.rcvage > 20 || sync.rtdelay > 25) {
        report('waiting_for_live_map', { expectedMap, sync }, `waiting:${expectedMap}:${sync.map}`);
      } else {
        report('connecting', sync);
        if (lastMap !== mapIndex) {
          lastScore = previousScore?.(mapIndex);
          lastFragment = undefined;
          lastMap = mapIndex;
        }
        const resume = lastFragment && sync.fragment > lastFragment.number && sync.fragment - lastFragment.number <= 12
          && sync.tick > lastFragment.tick ? Math.max(sync.signup_fragment, lastFragment.number - 2) : undefined;
        const winner = await followMap(match, mapIndex, series, winsNeeded, { ...sync, fragment: resume ?? sync.fragment },
          source, signal, round => {
            const latest = round.score[0] + round.score[1];
            const previous = lastScore && lastScore[0] + lastScore[1];
            if (previous !== undefined && latest <= previous) return;
            const gap = previous === undefined ? 0 : latest - previous - 1;
            lastScore = round.score;
            onRound({ ...round, ...(gap > 0 && { missingRoundsBefore: gap }) });
          }, status, fragment => { lastFragment = fragment; }, onMap);
        if (winner !== undefined) {
          series[winner]++;
          mapIndex++;
          continue;
        }
      }
    } catch (error) {
      if (!signal.aborted) report('relay_error', error instanceof Error ? error.message : String(error));
    }
    if (!signal.aborted) await sleep(1800, undefined, { signal }).catch(() => {});
  }
  return { status: Math.max(...series) >= winsNeeded ? 'finished' : 'stopped', series };
}

async function followMap(
  match: Cs2LiveMatch, mapIndex: number, series: Score, winsNeeded: number, sync: BroadcastSyncDto,
  source: ReturnType<typeof createDefaultFetcher>, signal: AbortSignal,
  onRound: (round: Cs2LiveRound) => void, status: (state: string, detail: unknown) => void,
  progress: (fragment: { tick: number; number: number }) => void,
  onMap?: (mapIndex: number, score: Score, series: Score, roster: [string[], string[]]) => void,
): Promise<Side | undefined> {
  const parser = new DemoReader();
  let receivedAt = 0;
  const reader = new HttpBroadcastReader(parser, match.relay, {
    signal, entities: EntityMode.ALL, deltaThrottle: 450, deltaRetryInterval: 600, maxDeltaRetries: 12,
    fetcher: {
      async json<T>() { return sync as T; },
      async bytes(path, requestSignal = signal) {
        const get = () => source.bytes(path, AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]));
        const result = await get().catch(error => {
          if (requestSignal.aborted || !(error instanceof Error && ['TimeoutError', 'TypeError'].includes(error.name))) throw error;
          return get();
        });
        if (result.ok) receivedAt = Date.now();
        return result;
      },
    },
  });
  const keys = match.teams.map(teamKey);
  const scopedTeams = () => keys.map(key => parser.teams.find(team =>
    (team.teamNumber === 2 || team.teamNumber === 3) && teamKey(team.clanName) === key));
  const playerSide = (player?: Player | null) => {
    const index = player?.team ? keys.indexOf(teamKey(player.team.clanName)) : -1;
    return index === 0 || index === 1 ? index : undefined;
  };
  const readScore = (): Score | undefined => {
    const [first, second] = scopedTeams();
    if (first && second && first.teamNumber !== second.teamNumber) return [first.score, second.score];
  };
  const recorded = () => ({ tick: parser.currentTick, fragment: reader.fragment, receivedAt });
  let score: Score | undefined;
  let pending: { reason: WinRoundReason; winner: Side; fullRound: boolean } & ReturnType<typeof recorded> | undefined;
  let plays: Cs2Play[] = [];
  let startOfRound: RoundObservation | undefined;
  let aliveAtStart: Score | undefined;
  let fullRound = false;
  let live = false;
  let finished: Side | undefined;
  parser.gameEvents.on('round_freeze_end', () => {
    plays = [];
    fullRound = live && parser.gameRules?.isWarmup === false;
    startOfRound = fullRound ? recorded() : undefined;
    const [first, second] = scopedTeams();
    const counts = [first, second].map(team => team?.members.filter(player => player.isAlive).length);
    aliveAtStart = fullRound && counts[0] === 5 && counts[1] === 5 ? [5, 5] : undefined;
  });
  parser.gameEvents.on('player_death', ({ player, attackerPlayer, weapon, headshot }) => {
    if (!live || parser.gameRules?.isWarmup !== false) return;
    const side = playerSide(attackerPlayer);
    const victimSide = playerSide(player);
    if (!player || victimSide === undefined) {
      aliveAtStart = undefined;
      fullRound = false;
      return;
    }
    if (!attackerPlayer || side === undefined || side === victimSide) {
      plays.push({ kind: 'other_death', player: player.name, side: victimSide, tick: parser.currentTick });
      return;
    }
    plays.push({ kind: 'kill', player: attackerPlayer.name, side, victim: player.name, weapon, headshot, tick: parser.currentTick });
  });
  const bomb = (kind: 'plant' | 'defuse', player?: Player | null) => {
    const side = playerSide(player);
    if (live && parser.gameRules?.isWarmup === false && player && side !== undefined)
      plays.push({ kind, player: player.name, side, tick: parser.currentTick });
  };
  parser.gameEvents.on('bomb_planted', ({ player }) => bomb('plant', player));
  parser.gameEvents.on('bomb_defused', ({ player }) => bomb('defuse', player));
  parser.gameEvents.on('round_end', ({ winner, reason }) => {
    if (!live || parser.gameRules?.isWarmup !== false || !roundReasons.has(reason)) return;
    const side = scopedTeams().findIndex(team => team?.teamNumber === winner);
    if (side === 0 || side === 1) pending = { reason, winner: side, fullRound, ...recorded() };
  });
  parser.on('tickend', () => {
    if (!live) return;
    if (reader.fragment >= 0) progress({ tick: parser.currentTick, number: reader.fragment });
    const next = readScore();
    if (!next) return;
    score ??= next;
    // The final kill or defuse can arrive on the tick after the round result.
    if (!pending || parser.currentTick < pending.tick + 4) return;
    if (next[0] === score[0] && next[1] === score[1]) return;
    const event = pending;
    pending = undefined;
    const roundPlays = plays.filter(play => play.tick <= event.tick + 4);
    const roundState = { start: startOfRound, aliveAtStart };
    startOfRound = undefined;
    aliveAtStart = undefined;
    fullRound = false;
    plays = [];
    const changed = next[event.winner] === score[event.winner] + 1 && next[1 - event.winner] === score[1 - event.winner];
    score = next;
    if (!changed) return;
    finished = cs2MapWinner(score);
    const projected: Score = [...series];
    if (finished !== undefined) projected[finished]++;
    onRound({ ...event, ...roundState, plays: roundPlays, match, mapIndex, score, series: projected, mapOver: finished !== undefined,
      ticksPerSecond: sync.tps,
      seriesOver: Math.max(...projected) >= winsNeeded });
    if (finished !== undefined) reader.stop();
  });
  const start = await reader.start();
  score = readScore();
  live = true;
  const [a, b] = scopedTeams();
  if (score && a && b) onMap?.(mapIndex, score, [...series], [a.members.map(p => p.name), b.members.map(p => p.name)]);
  status('map_stream', { mapIndex, fragment: sync.fragment, score, rcvage: sync.rcvage, rtdelay: sync.rtdelay });
  if (start.status !== 'ready') return score && cs2MapWinner(score);
  if (score && cs2MapWinner(score) !== undefined) {
    reader.stop();
    return cs2MapWinner(score);
  }
  const outcome = await reader.run();
  status('map_stream_end', { mapIndex, outcome, fragment: reader.fragment });
  return finished ?? (outcome.status === 'complete' && score ? cs2MapWinner(readScore() ?? score) : undefined);
}
