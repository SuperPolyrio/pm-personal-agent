export const decidingFormats = ['tiebreak7', 'tiebreak10_at_6_all', 'match_tiebreak10'] as const;
export type DecidingFormat = typeof decidingFormats[number];
export type Pair<T> = [T, T];
export type Side = 0 | 1;
export type ScoreScenario = {
  serve: Pair<number>;
  server: Side;
  bestOf: 3 | 5;
  deciding: DecidingFormat;
  sets: Pair<number>;
  games: Pair<number>;
  points: Pair<string>;
};

const other = (side: Side): Side => side === 0 ? 1 : 0;
const add = (score: Pair<number>, side: Side): Pair<number> =>
  side === 0 ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
const normalPoints = new Map([['0', 0], ['15', 1], ['30', 2], ['40', 3], ['A', 4], ['AD', 4], ['ADV', 4]]);
const displayPoints = ['0', '15', '30', '40', 'A'];
const won = ([a, b]: Pair<number>, target: number) => Math.max(a, b) >= target && Math.abs(a-b) >= 2;
const tieServer = (first: Side, pointsPlayed: number) => Math.floor((pointsPlayed + 1) / 2) % 2 ? other(first) : first;

type Value = { setA: number; matchA: number; totals: number[] };

function blend(p: number, a: Value, b: Value): Value {
  return {
    setA: p * a.setA + (1-p) * b.setA,
    matchA: p * a.matchA + (1-p) * b.matchA,
    totals: a.totals.map((v, i) => p * v + (1-p) * b.totals[i]),
  };
}

export function tennisScoreScenario(input: ScoreScenario) {
  const { serve, server, bestOf, deciding, sets, games } = input;
  const needed = (bestOf + 1) / 2;
  if (serve.some(p => !Number.isFinite(p) || p <= 0 || p >= 1)) throw Error('双方发球分胜率须在 0 和 1 之间。');
  if (sets.some(n => !Number.isInteger(n) || n < 0 || n >= needed) ||
      games.some(n => !Number.isInteger(n) || n < 0 || n > 6) || won(games, 6))
    throw Error('盘局比分须是一场尚未结束的比赛及其当前盘。');
  const isDeciding = (score: Pair<number>) => score.every(n => n === needed - 1);
  const matchTie = isDeciding(sets) && deciding === 'match_tiebreak10';
  if (matchTie && games.some(n => n !== 0)) throw Error('以抢十替代决胜盘时局分应为 0–0，抢十分放在 points。');
  const tieTarget = (s: Pair<number>, g: Pair<number>) => isDeciding(s) && deciding === 'match_tiebreak10' ? 10
    : g.every(n => n === 6) ? isDeciding(s) && deciding === 'tiebreak10_at_6_all' ? 10 : 7 : null;
  const target = tieTarget(sets, games);
  const points = input.points.map(raw => target ? /^\d{1,6}$/.test(raw) ? Number(raw) : NaN
    : normalPoints.get(raw.toUpperCase()) ?? NaN) as Pair<number>;
  if (points.some(p => !Number.isInteger(p)) || won(points, target ?? 4) ||
      !target && points[0] === 4 && points[1] === 4) throw Error('当前分数格式或状态无效，抢七、抢十使用实际数字。');
  const pointA = (s: Side) => s === 0 ? serve[0] : 1 - serve[1];
  const deuce = (p: number) => p ** 2 / (p ** 2 + (1-p) ** 2);
  const memo = new Map<string, Value>();
  function ordinary(p: number, [a, b]: Pair<number>): number {
    if (won([a,b], 4)) return Number(a > b);
    if (a >= 3 && b >= 3) return a === b ? deuce(p) : a > b ? p + (1-p) * deuce(p) : p * deuce(p);
    return p * ordinary(p, [a+1,b]) + (1-p) * ordinary(p, [a,b+1]);
  }
  const holds = [ordinary(pointA(0), [0,0]), ordinary(pointA(1), [0,0])];
  const tieWin = pointA(0) * pointA(1);
  const tieLoss = (1-pointA(0)) * (1-pointA(1));
  const tieDeuce = tieWin / (tieWin + tieLoss);
  const tiebreaks = new Map<string, number>();
  function tiebreak(first: Side, goal: number, [a, b]: Pair<number>): number {
    if (won([a,b], goal)) return Number(a > b);
    const p = pointA(tieServer(first, a+b));
    if (a >= goal-1 && b >= goal-1) return a === b ? tieDeuce : a > b ? p + (1-p) * tieDeuce : p * tieDeuce;
    const key = [first, goal, a, b].join(',');
    const known = tiebreaks.get(key);
    if (known !== undefined) return known;
    const value = p * tiebreak(first, goal, [a+1,b]) + (1-p) * tiebreak(first, goal, [a,b+1]);
    tiebreaks.set(key, value);
    return value;
  }
  function setDone(s: Pair<number>, side: Side, next: Side): Value {
    const updated = add(s, side);
    const setA = Number(side === 0);
    if (updated[side] < needed) return { ...fresh(updated, [0,0], next), setA };
    return { setA, matchA: setA, totals: Array.from({ length: bestOf+1 }, (_, n) => Number(n === updated[0]+updated[1])) };
  }
  function gameDone(s: Pair<number>, g: Pair<number>, first: Side, side: Side): Value {
    const next = other(first);
    const updated = add(g, side);
    return tieTarget(s,g) || won(updated, 6) ? setDone(s, side, next) : fresh(s, updated, next);
  }
  function fresh(s: Pair<number>, g: Pair<number>, next: Side): Value {
    const key = [...s, ...g, next].join(',');
    const known = memo.get(key);
    if (known) return known;
    const goal = tieTarget(s, g);
    const p = goal ? tiebreak(next, goal, [0,0]) : holds[next];
    const value = blend(p, gameDone(s,g,next,0), gameDone(s,g,next,1));
    memo.set(key, value);
    return value;
  }
  const first = target ? tieServer(server, points[0]+points[1]) : server;
  const winsGameA = (at: Pair<number>) => target ? tiebreak(first, target, at) : ordinary(pointA(server), at);
  const afterGameA = gameDone(sets,games,first,0);
  const afterGameB = gameDone(sets,games,first,1);
  function report(p: number) {
    const { setA, matchA, totals } = blend(p, afterGameA, afterGameB);
    return { currentGameOrTiebreakWinA: p, currentSetWinA: setA, matchWinA: matchA,
      totalSetsOfBothPlayers: totals.slice(needed).map((probability, i) => ({ totalSets: i+needed, probability })) };
  }
  function afterPoint(side: Side) {
    const score = add(points,side);
    const completedBy = won(score, target ?? 4) ? (side === 0 ? 'A' : 'B') : null;
    const nextPoints = completedBy ? null : target ? score.map(String)
      : score[0] === 4 && score[1] === 4 ? ['40','40'] : score.map(p => displayPoints[p]);
    return { completedBy, nextPoints, ...report(winsGameA(score)) };
  }
  return {
    currentUnit: matchTie ? 'match_tiebreak' : target ? 'set_tiebreak' : 'game',
    tiebreakTarget: target, nextPointWonByA: pointA(server),
    current: report(winsGameA(points)),
    ifAWinsNextPoint: afterPoint(0),
    ifBWinsNextPoint: afterPoint(1),
  };
}
