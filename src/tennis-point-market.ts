import type { createPolymarketPublicReader } from './polymarket-public.js';
import type { SportsHost, SportsMarket } from './sports.js';
import { beijingTime, sameCompetition } from './sports-tennis.js';

type Read = ReturnType<typeof createPolymarketPublicReader>['read'];
type Pair<T> = [T, T];
type Index = 0 | 1;
type State = { at: string; games: Pair<number>[]; points: Pair<string>; server: Index | null; tiebreak: boolean };
export type PointMarketSnapshot = {
  eventKey: string; competition: string; localDate?: unknown; state: string; sourceUrl?: string;
  participants: { id: string; name: string }[];
  facts: { bestOf: 3 | 5 | null; totalServePoints?: number; tour: string; winnerId?: string | null;
    sets: { games: Pair<number>; winnerId: string | null }[] };
  market?: unknown;
};
type PointArchive = { kind: 'tennis_observed_archive'; date: string; players: Pair<string>;
  competition: string; tour: string; sourceMatchId: string; rows: State[] };
type OfficialPoint = { number: number; set: number; game: number; startedAt: string; endedAt: string; server: Index;
  winner: Index; before: Pair<string>; after: Pair<string>; gamesBefore: Pair<number>; gamesAfter: Pair<number>; gameEnded: boolean };
type OfficialArchive = { kind: 'tennis_wimbledon_points'; eventKey: string; officialDate: string; wimbledonMatchId: string;
  players: Pair<string>; final: Pair<number>[]; points: OfficialPoint[]; total: number; pointsWon: Pair<number>;
  servicePoints: Pair<number>; scoreUrl: string; statsUrl: string; feedUrl: string };
type ArchivedQuote = { number: number; receivedAt: string; exchangeAt: string; bid: number; ask: number;
  eventType: 'book' | 'price_change'; url: string };
type BookArchive = { kind: 'tennis_pmxt_quotes'; eventKey: string; pointArchiveId: string; conditionId: string; tokenId: string;
  hours: string[]; eventCount: number; quotes: ArchivedQuote[];
  oneSidedQuotes?: (Omit<ArchivedQuote, 'bid' | 'ask'> & { bid: number | null; ask: number | null })[] };
const record = (x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const norm = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const normal = new Map([['0', 0], ['15', 1], ['30', 2], ['40', 3], ['A', 4], ['AD', 4], ['ADV', 4]]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const zero = [0,0];
const gameIndex = (state: State) => state.games.reduce((n, [a,b]) => n+a+b, 0);
function pscore(row: State) {
  return row.points.map(p => row.tiebreak ? /^\d{1,4}$/.test(p) ? Number(p) : NaN : normal.get(p) ?? NaN);
}

function pointWinner(before: State, after: State): Index | null {
  const start = pscore(before), end = pscore(after);
  if ([...start,...end].some(x => !Number.isInteger(x))) return null;
  const current = before.games.at(-1);
  if (!current) return null;
  for (const side of [0,1] as const) {
    const next = start.slice();
    next[side]++;
    if (!before.tiebreak && same(next,[4,4])) next.splice(0,2,3,3);
    const sameGame = same(before.games, after.games);
    if (sameGame && before.tiebreak === after.tiebreak && same(next,end) &&
        (before.tiebreak || next[side] < 4 || next[side] - next[1-side] < 2)) return side;
    // The tiebreak target cannot be determined from a scoreboard row alone.
    if (sameGame || !same(end,zero) || before.tiebreak || next[side] < 4 || next[side]-next[1-side] < 2) continue;
    const games = current.slice();
    games[side]++;
    const complete = [...before.games.slice(0,-1),games];
    if (same(after.games,complete) || (games[side] === 6 && games[1-side] <= 4 || games[side] === 7 && games[1-side] === 5) &&
        same(after.games,[...complete,zero])) return side;
  }
  return null;
}

export async function readPointMarket(host: SportsHost & { read: Read }, snapshotId: string, snapshot: PointMarketSnapshot,
  archiveId: string, offset: number, limit: number, signal: AbortSignal, bookArchiveId?: string) {
  const proof = host.loadEvidence(archiveId);
  const archive = proof?.data as PointArchive | OfficialArchive | undefined;
  const { contract: input, check } = record(snapshot.market);
  const contract = input as SportsMarket | undefined;
  const token = contract?.outcomeTokens.find(t => t.tokenId === contract.outcomeToken);
  if (!contract || !token || record(check).binding !== 'verified')
    throw Error('先用 sports_assistant.inspect 绑定精确子盘和选项，再传赛况凭据。');
  if (proof && archive?.kind === 'tennis_wimbledon_points') {
    const book = bookArchiveId ? host.loadEvidence(bookArchiveId) : undefined;
    const orderBook = book?.data as BookArchive | undefined;
    if (!book || orderBook?.kind !== 'tennis_pmxt_quotes' || orderBook.pointArchiveId !== archiveId ||
      orderBook.eventKey !== snapshot.eventKey || orderBook.conditionId !== contract.conditionId || orderBook.tokenId !== token.tokenId)
      throw Error('需要与逐分凭据、赛事、condition 和结果 token 同时匹配的 PMXT 订单簿凭据。');
    const ordered = archive.players.map(id => snapshot.participants.find(p => p.id === id));
    const final = snapshot.facts.sets.filter(s => s.winnerId).map(s =>
      archive.players.map(id => s.games[snapshot.participants.findIndex(p => p.id === id)]));
    if (archive.eventKey !== snapshot.eventKey || snapshot.localDate !== archive.officialDate || snapshot.state !== 'final' ||
      archive.players[0] === archive.players[1] || ordered.some(p => !p) || !same(archive.final, final))
      throw Error('温网逐分存档与赛况的赛事、双方、日期或完赛盘分不匹配。');
    const players = ordered.map(p => p!.name);
    const matchWinner = snapshot.participants.find(p => p.id === snapshot.facts.winnerId)?.name ?? null;
    const scoreSummary = `按 ${players.join('、')} 顺序，完赛盘分 ${final.map(s => s.join('–')).join('、')}。` +
      (matchWinner ? `${matchWinner} 获胜。` : '');
    const terms = record(check);
    const targetSet = terms.kind === 'set_winner' ? record(terms.parameters).set : null;
    if (targetSet !== null && typeof targetSet !== 'number')
      throw Error('单盘盘口缺少指定盘号。');
    const quotes = new Map(orderBook.quotes.map(q => [q.number, q]));
    const oneSided = new Map(orderBook.oneSidedQuotes?.map(q => [q.number, q]));
    let eligiblePoints = 0;
    let pointsWithOrderBook = 0;
    let maxReceiptLead = 0;
    let maxExchangeLead = 0;
    const rows = archive.points.map((point) => {
      const inScope = targetSet === null || point.set === targetSet;
      if (inScope) eligiblePoints++;
      const q = inScope ? quotes.get(point.number) : undefined;
      const source = Date.parse(point.endedAt);
      const receiptLead = q ? (source - Date.parse(q.receivedAt)) / 1000 : NaN;
      const exchangeLead = q ? (source - Date.parse(q.exchangeAt)) / 1000 : NaN;
      const alignedOrderBook = q && receiptLead > 0 && receiptLead <= 30 && exchangeLead >= 0 && exchangeLead <= 30 &&
        q.bid > 0 && q.bid <= q.ask && q.ask < 1
        ? { ...q, receiptSecondsBeforePointEnd: receiptLead, exchangeSecondsBeforePointEnd: exchangeLead,
            exchangeBeijingTime: bookBeijingTime(q.exchangeAt), receiptBeijingTime: bookBeijingTime(q.receivedAt) } : null;
      if (alignedOrderBook) {
        pointsWithOrderBook++;
        maxReceiptLead = Math.max(maxReceiptLead, receiptLead);
        maxExchangeLead = Math.max(maxExchangeLead, exchangeLead);
      }
      const server = players[point.server], winner = players[point.winner];
      const endedBeijingTime = beijingTime(point.endedAt);
      const score = point.gameEnded ? `从 ${point.before.join('–')} 拿下本局，盘内局分 ${point.gamesAfter.join('–')}`
        : `局内分 ${point.before.join('–')} → ${point.after.join('–')}`;
      const incompleteBook = inScope && !alignedOrderBook ? oneSided.get(point.number) : undefined;
      const quoteSummary = alignedOrderBook ?
        `${token.label} 买一/卖一 ${alignedOrderBook.bid}/${alignedOrderBook.ask}，交易所 ${alignedOrderBook.exchangeBeijingTime}，` +
        `档案接收 ${alignedOrderBook.receiptBeijingTime}，分别早于该分结束 ${exchangeLead} 秒和 ${receiptLead} 秒。`
        : incompleteBook ? '最后一条档案盘口缺少可交易的买一或卖一。'
        : inScope ? '该分结束前 30 秒内无合格双边报价。' : '该分超出指定单盘范围。';
      const pointSummary = `第 ${point.number} 分，${endedBeijingTime} 结束（北京时间），发球方 ${server}，得分方 ${winner}，${score}。${quoteSummary}`;
      return { ...point, server, winner, endedBeijingTime, alignedOrderBook, incompleteBook, pointSummary,
        quoteScope: inScope ? 'in_scope' : 'outside_contract_scope' };
    });
    const complete = rows.length === archive.total && rows.every((p, i) => p.number === i+1 && p.server && p.winner);
    const bookCoverage = eligiblePoints > 0 && pointsWithOrderBook === eligiblePoints ? 'covered'
      : pointsWithOrderBook > 0 ? 'partial' : 'unavailable';
    const coverageSummary = `温网逐分 ${rows.length}/${archive.total}，发球方 ${rows.filter(p => p.server).length}/${archive.total}，` +
      `WTA 独立统计按同一球员顺序为 ${archive.servicePoints.join(' / ')} 个发球分、${archive.pointsWon.join(' / ')} 个赢分。` +
      `${targetSet === null ? '全场' : `第 ${targetSet} 盘`}的 ${token.label} 选项，合格双边买一卖一 ${pointsWithOrderBook}/${eligiblePoints}。`;
    const data = { status: complete && bookCoverage === 'covered' ? 'ok' : 'partial', eventKey: snapshot.eventKey,
      players, sourceMatchId: archive.wimbledonMatchId, finalScores: final, matchWinner, scoreSummary, matchSourceUrl: archive.scoreUrl,
      market: { title: contract.title, url: contract.url, conditionId: contract.conditionId,
        tokenId: token.tokenId, label: token.label, set: targetSet, ruleEvidenceId: contract.evidenceId },
      coverageSummary, coverage: { pointSequence: complete ? 'complete' : 'partial', expectedMatchPoints: archive.total,
        pointsWithServer: rows.filter(p => p.server).length, servicePoints: archive.servicePoints, pointsWon: archive.pointsWon,
        quoteEligiblePoints: eligiblePoints, pointsWithOrderBook, orderBook: bookCoverage, archiveBookEvents: orderBook.eventCount,
        missingQuotePoints: rows.filter(p => p.quoteScope === 'in_scope' && !p.alignedOrderBook).map(p => p.number),
        oneSidedPoints: rows.filter(p => p.incompleteBook).map(p => p.number),
        maxReceiptSecondsBeforePointEnd: pointsWithOrderBook ? maxReceiptLead : null,
        maxExchangeSecondsBeforePointEnd: pointsWithOrderBook ? maxExchangeLead : null,
        pointTimeBasis: 'wimbledon_epoch_time_end_1s', bookBasis: 'pmxt_polymarket_clob_websocket',
        join: 'latest_archive_receipt_strictly_before_point_end_within_30s' },
      sources: { points: proof.source, pointApi: archive.feedUrl, score: archive.scoreUrl, stats: archive.statsUrl,
        book: book.source, bookFiles: orderBook.hours },
      rows, inputEvidenceIds: [snapshotId, archiveId, book.evidenceId] };
    const saved = host.saveEvidence('tennis/point_market', { kind: 'tennis_point_market', ...data });
    return { ...data, rows: rows.slice(offset, offset+limit), offset, nextOffset: offset+limit < rows.length ? offset+limit : null,
      evidenceId: saved.evidenceId };
  }
  if (!proof || archive?.kind !== 'tennis_observed_archive' || !archive.rows.length || archive.rows.length > 10_000)
    throw Error('需要先导入该场的公开逐分样本凭据。');
  if (bookArchiveId) throw Error('实盘买一卖一目前须使用经核对的温网逐分档案。');
  const ordered = archive.players.map(name => snapshot.participants.find(p => norm(p.name) === norm(name)));
  if (ordered.some(p => !p) || ordered[0]?.id === ordered[1]?.id || snapshot.localDate !== archive.date ||
      snapshot.facts.tour !== archive.tour || !sameCompetition(snapshot.competition, archive.competition))
    throw Error('逐分样本与赛况的两位选手、赛事、日期或巡回赛不匹配。');
  const players = ordered.map(p => p!.name);
  const final = snapshot.facts.sets.filter(s => s.winnerId).map(s =>
    ordered.map(p => s.games[snapshot.participants.findIndex(q => p?.id === q.id)]));
  const start = Date.parse(archive.rows[0].at), end = Date.parse(archive.rows.at(-1)!.at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end-start > 12*3600000)
    throw Error('逐分样本的 UTC 时间范围无效。');
  const response = await host.read({ view: 'price_history', id: token.tokenId,
    start: Math.floor(start/1000)-120, end: Math.ceil(end/1000)+1, fidelity: 1 }, signal);
  const payload = record(record(host.loadEvidence(response.evidenceId)?.data).response);
  const prices = (response.status === 'ok' && Array.isArray(payload.history) ? payload.history : [])
    .map(record).filter(p => Number.isSafeInteger(p.t) && typeof p.p === 'number' && p.p >= 0 && p.p <= 1)
    .map(p => ({ ts: Number(p.t)*1000, price: Number(p.p) })).sort((a,b) => a.ts-b.ts);
  const gameVotes = new Map<number, Set<number>>();
  for (const state of archive.rows) {
    if (state.tiebreak || state.server === null || same(pscore(state),zero)) continue;
    const index = gameIndex(state);
    const votes = gameVotes.get(index) ?? new Set<number>();
    votes.add((state.server + index) % 2);
    gameVotes.set(index, votes);
  }
  const votes = [...gameVotes.values()].filter(v => v.size === 1).map(v => [...v][0]);
  const firstVotes = votes.filter(v => v === 0).length;
  const firstServer = votes.length >= 4 && Math.max(firstVotes, votes.length-firstVotes) / votes.length >= 0.75
    ? firstVotes > votes.length/2 ? 0 : 1 : null;
  let priceIndex = -1;
  let duplicates = 0, jumps = 0, changes = 0, pointsWithServer = 0, pricedPoints = 0;
  const rows = archive.rows.flatMap((after,i) => {
    const at = Date.parse(after.at);
    const before = archive.rows[i-1];
    const key = [after.games,pscore(after),after.tiebreak];
    if (before && at < Date.parse(before.at)) throw Error('逐分记录的采集时间逆序。');
    if (before && same([before.games,pscore(before),before.tiebreak],key)) { duplicates++; return []; }
    const winner = before ? pointWinner(before,after) : null;
    if (before && winner === null) jumps++;
    if (winner !== null) changes++;
    const sameGame = before && same(before.games,after.games);
    const server = winner !== null && before && !before.tiebreak && before.server !== null && firstServer !== null &&
      before.server === (firstServer + gameIndex(before)) % 2 &&
      (sameGame ? before.server === after.server : after.server !== null && before.server !== after.server) ? before.server : null;
    if (server !== null) pointsWithServer++;
    while (prices[priceIndex+1]?.ts <= at) priceIndex++;
    const price = prices[priceIndex];
    const lag = price ? Math.round(at-price.ts)/1000 : Infinity;
    const aligned = winner !== null && price && lag <= 90 ? { price: price.price, sampledAt: new Date(price.ts).toISOString(),
      sampledBeijingTime: beijingTime(new Date(price.ts).toISOString()), secondsBeforeScoreCapture: lag } : null;
    if (aligned) pricedPoints++;
    const capturedBeijingTime = beijingTime(after.at);
    const pointSummary = winner !== null && before
      ? `${capturedBeijingTime}（比分采集，北京时间），发球方 ${server === null ? '未核实' : players[server]}，` +
        `本分由 ${players[winner]} 赢得，局内分 ${before.points.join('–')} → ${after.points.join('–')}（选手顺序 ${players.join('、')}）。` +
        (aligned ? ` ${token.label} 子盘历史价 ${aligned.price}，采样时间 ${aligned.sampledBeijingTime}，领先比分采集 ${aligned.secondsBeforeScoreCapture} 秒。` : '')
      : undefined;
    return [{ capture: i+1, capturedAt: after.at, capturedBeijingTime, games: after.games,
      beforePoints: before?.points, afterPoints: after.points, server: server === null ? null : players[server],
      winner: winner === null ? null : players[winner], pointSummary,
      transition: !before ? 'initial_capture' : winner === null ? 'gap' : 'one_point', alignedPrice: aligned }];
  });
  const expected = snapshot.facts.totalServePoints ?? null;
  const complete = snapshot.state === 'final' && same(archive.rows.at(-1)!.games, final) &&
    same(archive.rows[0].games,[zero]) && same(pscore(archive.rows[0]),zero) && changes === expected && jumps === 0;
  const coverageSummary = `共 ${archive.rows.length} 条比分记录，含 1 条初始快照、${changes} 条单分变化、${jumps} 处跳分和 ${duplicates} 条重复状态。` +
    (expected === null ? '全场总分数缺少独立分母。' : `全场独立统计为 ${expected} 分。`) +
    `${pointsWithServer} 条单分的发球方通过轮转校验，${pricedPoints} 条匹配到先于比分采集的官方历史价格。历史买一卖一缺失。`;
  const data = { status: complete && pricedPoints === changes && pointsWithServer === changes ? 'ok' : 'partial', eventKey: snapshot.eventKey,
    players, sourceMatchId: archive.sourceMatchId, finalScores: final, matchSourceUrl: snapshot.sourceUrl,
    market: { slug: contract.slug, title: contract.title, url: contract.url, conditionId: contract.conditionId,
      tokenId: token.tokenId, label: token.label, rules: contract.rules },
    coverageSummary, coverage: { observedRows: archive.rows.length, duplicateStates: duplicates, pointTransitions: changes, expectedMatchPoints: expected,
      gapTransitions: jumps, pointSequence: complete ? 'complete' : 'partial', pointWithVerifiedServer: pointsWithServer,
      serverBasis: 'recorded_server_checked_against_rotation',
      priceSamples: prices.length, pointsWithPriceSample: pricedPoints, priceStatus: response.status, orderBook: 'unavailable',
      scoreTimeBasis: 'provider_capture_time', pointEventTime: 'unavailable', priceBasis: 'official_clob_price_history_1m',
      join: 'latest_sample_at_or_before_score_capture_max_90_seconds' }, sources: { score: proof.source, price: response.source },
    rows, inputEvidenceIds: [snapshotId, archiveId, response.evidenceId] };
  const saved = host.saveEvidence('tennis/point_market', { kind: 'tennis_point_market', ...data });
  return { ...data, rows: rows.slice(offset, offset+limit), offset, nextOffset: offset+limit < rows.length ? offset+limit : null,
    evidenceId: saved.evidenceId };
}

function bookBeijingTime(timestamp: string) {
  return beijingTime(timestamp) + '.' + String(new Date(timestamp).getUTCMilliseconds()).padStart(3, '0');
}
