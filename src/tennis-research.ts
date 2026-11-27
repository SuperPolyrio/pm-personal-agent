import { sourceSetting } from './source-config.js';
import type { DatabaseSync } from 'node:sqlite';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { sportsTimestamp, type SportsHost, type SportsSnapshot } from './sports.js';
import { beijingTime, completedServiceGame } from './sports-tennis.js';
import { decidingFormats, tennisScoreScenario, type Pair, type DecidingFormat, type Side } from './tennis-score-model.js';
import { surfaces, tennisPlayer, tennisProfile } from './tennis-profile.js';
import { readPointMarket } from './tennis-point-market.js';
import { archivedTennisMatches, tennisReplayDate } from './tennis-replay-intent.js';

const formatSources = [
  sourceSetting('PM_ITF_URL') + '/media/7221/2026-rules-of-tennis-english.pdf',
  sourceSetting('PM_ITF_URL') + '/media/5986/grand-slam-rulebook-2026-f2.pdf',
];
const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const eventPattern = /^tennis:[a-z]+:[a-z0-9._-]{1,160}$/i;
type Snapshot = SportsSnapshot<{
  bestOf: 3 | 5 | null; tour: string; observedAt: string | null; stateObservedAt: string | null; activeSet: number | null;
  sets: { number: number; games: Pair<number>; winnerId: string | null; format: string }[];
  game: { points: Pair<string>; serverId: string | null; tiebreak: boolean | null } | null;
  pointHistory: string; sources: { url: string; evidenceId: string; observedAt: string | null; retrievedAt: string }[];
}> & { kind: 'sports_snapshot'; sport: 'tennis'; mode: 'live' | 'replay'; asOf: string; surface?: string };
type ObjectValue = Record<string, unknown>;
const row = (x: unknown): ObjectValue => x && typeof x === 'object' && !Array.isArray(x) ? x as ObjectValue : {};
const status = (x: unknown) => typeof x === 'string' ? x : row(x).status;
function pair<T>(x: T[] | undefined, label: string) {
  if (!x || x.length !== 2) throw Error(label + '须按 A、B 顺序提供两个值。');
  return x as Pair<T>;
}

export function createTennisResearchTool(host: SportsHost & { db: DatabaseSync; read: Parameters<typeof readPointMarket>[0]['read'] }) {
  function snapshot(id: string) {
    const proof = host.loadEvidence(id);
    const data = proof?.data as Snapshot | undefined;
    if (!proof || data?.kind !== 'sports_snapshot' || data.sport !== 'tennis') throw Error('找不到网球赛况快照 ' + id);
    return { data, proof };
  }
  function save(action: string, data: ObjectValue) {
    const saved = host.saveEvidence('tennis/' + action, { ...data, kind: 'tennis_' + action });
    return JSON.stringify({ ...data, evidenceId: saved.evidenceId, retrievedAt: saved.retrievedAt });
  }
  return defineTool({
    name: 'tennis_research',
    description: '网球研究工具。profile 查官方分场地画像，scenario 算比分情景，timeline 回看离散快照。point_market 按双方选手名和比赛日期读取官方逐分、发球方和各已归档选项的历史买一卖一。赛事现况和单独合约核对用 sports_assistant。',
    parameters: {
      action: { ...str, required: true, enum: ['profile', 'scenario', 'timeline', 'point_market'] },
      player_url: { ...str, description: 'profile 使用 ATP 或 WTA 官网个人页面，路径含选手原生 ID。' },
      surface: { ...str, enum: [...surfaces] }, season: int,
      sample_size: { ...int, description: '只用于 WTA，近期已完成主签单打场次，默认 8，上限 16。ATP 读取官网赛季汇总。' },
      match_date: { ...str, description: 'point_market 自然查询使用当地比赛日期 YYYY-MM-DD，另传 player_names。' },
      player_names: { type: 'array', items: str, description: 'point_market 自然查询使用双方姓名，各一个字符串，顺序任意。' },
      snapshot_evidence_id: { ...str, description: 'scenario 或 point_market 的单选项凭据模式。自然查询逐分和盘口时用 match_date 和 player_names。' },
      point_archive_evidence_id: { ...str, description: 'point_market 的逐分凭据。省略时按锁定赛事、condition 和 token 查找已导入的温网逐分和订单簿。' },
      book_archive_evidence_id: { ...str, description: 'point_market 可指定同一逐分档案及精确合约选项的 PMXT 订单簿凭据。' },
      offset: { ...int, description: 'point_market 结果从零开始的展示偏移。' },
      limit: { ...int, description: 'point_market 返回 1–24 行，姓名和日期查询默认 1 行，其余默认 12。' },
      serve_win_rates: { type: 'array', items: { type: 'number' }, description: '双方发球分胜率假设，A/B 顺序，0 到 1 之间。' },
      profile_evidence_ids: { type: 'array', items: str, description: '仅用户同意用历史发球率作假设时用，两个同巡回赛同场地 profile 证据，按 A/B 排列。与 serve_win_rates 二选一。' },
      players: { type: 'array', items: str, description: '手工情景中 A、B 的显示名。' },
      best_of: { ...int, enum: [3,5] },
      deciding_format: { ...str, enum: [...decidingFormats], description: '决胜盘普通抢七、6–6 抢十、或从 0–0 直接抢十。采用已核对规则或用户指定的假设。' },
      sets: { type: 'array', items: int }, games: { type: 'array', items: int },
      points: { type: 'array', items: str, description: '普通局例如 ["40","A"]；抢七、抢十例如 ["5","4"]。' },
      server: { ...str, enum: ['A','B'], description: '下一分发球方。真实快照情景从比分源取。' },
      event_key: { ...str, description: 'timeline 使用由 sports_assistant 验证的赛事键。point_market 有多个同日同名候选时可按已确认赛事键限定。' },
      snapshot_evidence_ids: { type: 'array', items: str, description: 'timeline 可指定同一场的 1–12 个快照。省略则根据 event_key 查最新已采集快照。' },
      as_of: { ...str, description: 'timeline 可见时间上限，须带时区；只使用该时间以前取得的真实快照。' },
    },
    output: { schema: str, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, { signal }) {
      const { action, player_url, surface, season, sample_size } = args;
      if (action === 'point_market') {
        const offset = args.offset ?? 0, limit = args.limit ?? (args.snapshot_evidence_id ? 12 : 1);
        if (offset < 0 || limit < 1 || limit > 24) throw Error('逐分预览需有效 offset 和 1–24 的 limit。');
        if (!args.snapshot_evidence_id) {
          const date = tennisReplayDate(args.match_date ?? '');
          if (!date || args.player_names?.length !== 2) throw Error('请提供双方选手名和当地比赛日期。');
          const candidates = archivedTennisMatches(host.db, date, args.player_names)
            .filter(match => !args.event_key || match.eventKey === args.event_key);
          if (candidates.length !== 1) return JSON.stringify({ status: candidates.length ? 'ambiguous_event' : 'unavailable',
            matchDate: date, players: args.player_names, candidates: candidates.map(({ eventKey, competition }) => ({ eventKey, competition })),
            reason: candidates.length ? '双方同日有多场归档，请补赛事以确认场次。' : '双方在这一天的比赛暂无已导入的逐分档案。' });
          const match = candidates[0];
          const contracts = host.db.prepare(`SELECT snapshot_id, points_id, book_id FROM (
            SELECT s.id AS snapshot_id, p.id AS points_id, q.id AS book_id,
              COALESCE(json_extract(s.data,'$.market.check.parameters.set'), 0) AS market_set,
              ROW_NUMBER() OVER (PARTITION BY json_extract(q.data,'$.conditionId'), json_extract(q.data,'$.tokenId')
                ORDER BY q.retrieved_at DESC, s.retrieved_at DESC, q.id, s.id) AS newest
            FROM evidence q
            JOIN evidence p ON p.id=json_extract(q.data,'$.pointArchiveId')
            JOIN evidence s ON s.source='sports/snapshot'
              AND json_extract(s.data,'$.eventKey')=json_extract(q.data,'$.eventKey')
              AND json_extract(s.data,'$.market.contract.conditionId')=json_extract(q.data,'$.conditionId')
              AND json_extract(s.data,'$.market.contract.outcomeToken')=json_extract(q.data,'$.tokenId')
            WHERE q.source='https://archive.pmxt.dev/Polymarket/v2' AND json_extract(q.data,'$.kind')='tennis_pmxt_quotes'
              AND json_extract(q.data,'$.eventKey')=? AND json_extract(p.data,'$.eventKey')=?
              AND json_extract(p.data,'$.officialDate')=? AND json_extract(s.data,'$.localDate')=?
              AND json_extract(s.data,'$.state')='final' AND json_extract(s.data,'$.market.check.binding')='verified'
              AND json_extract(s.data,'$.market.check.kind') IN ('match_winner','set_winner')
          ) WHERE newest=1 ORDER BY market_set, snapshot_id`).all(match.eventKey, match.eventKey, date, date);
          if (!contracts.length) return JSON.stringify({ status: 'unavailable', eventKey: match.eventKey, matchDate: date,
            reason: '已找到该场逐分归档，暂缺与全场或单盘胜负选项绑定的盘口档案。' });
          const markets = await Promise.all(contracts.map(({ snapshot_id, points_id, book_id }) => {
            const cap = snapshot(String(snapshot_id));
            return readPointMarket(host, cap.proof.evidenceId, cap.data, String(points_id), offset, limit, signal, String(book_id));
          }));
          const marketSets = markets.map(m => 'set' in m.market ? m.market.set : undefined);
          const missingMarketScopes = [null, 1].filter(set => !marketSets.includes(set))
            .map(set => set === null ? '全场胜负' : '第一盘胜负');
          return save('point_market_replay', { status: missingMarketScopes.length || markets.some(m => m.status !== 'ok') ? 'partial' : 'ok',
            eventKey: match.eventKey, competition: match.competition, matchDate: date, missingMarketScopes, markets,
            inputEvidenceIds: markets.map(m => m.evidenceId) });
        }
        const cap = snapshot(args.snapshot_evidence_id);
        let archive = args.point_archive_evidence_id, book = args.book_archive_evidence_id;
        if (!book) {
          const contract = row(row(cap.data.market).contract);
          if (typeof contract.conditionId === 'string' && typeof contract.outcomeToken === 'string') {
            const matching = host.db.prepare(`SELECT q.id, p.id AS points_id
              FROM evidence q JOIN evidence p ON p.id=json_extract(q.data,'$.pointArchiveId')
              WHERE q.source='https://archive.pmxt.dev/Polymarket/v2' AND json_extract(q.data,'$.kind')='tennis_pmxt_quotes'
                AND json_extract(q.data,'$.eventKey')=? AND json_extract(q.data,'$.conditionId')=?
                AND json_extract(q.data,'$.tokenId')=? AND (? IS NULL OR p.id=?)
              ORDER BY q.retrieved_at DESC LIMIT 1`).get(cap.data.eventKey, contract.conditionId, contract.outcomeToken,
                archive ?? null, archive ?? null);
            if (matching) { archive = String(matching.points_id); book = String(matching.id); }
          }
        }
        if (!archive) throw Error('该合约选项尚无配套逐分及订单簿凭据。也可提供已导入的同场逐分样本证据 ID。');
        return JSON.stringify(await readPointMarket(host, cap.proof.evidenceId, cap.data, archive, offset, limit, signal, book));
      }
      if (action === 'profile') {
        if (!player_url || !surface) throw Error('需要 ATP/WTA 官网选手链接和硬地、红土或草地。');
        const data = await tennisProfile(host, tennisPlayer(player_url), surface as typeof surfaces[number],
          season ?? new Date().getUTCFullYear(), sample_size, signal);
        return save(action, { ...data, inputEvidenceIds: [...data.proofs.map(p => p.evidenceId), ...data.gaps.map(p => p.evidenceId)] });
      }
      if (action === 'timeline') {
        const asOf = args.as_of === undefined ? new Date().toISOString() : sportsTimestamp(args.as_of);
        if (!asOf || Date.parse(asOf) > Date.now()) throw Error('回看截止时间须带时区，且不能晚于当前时间。');
        if (args.event_key && !eventPattern.test(args.event_key)) throw Error('赛事键格式无效。');
        if (!args.snapshot_evidence_ids?.length && !args.event_key) throw Error('请提供赛事键或已经取得的网球快照证据。');
        const ids = args.snapshot_evidence_ids?.length ? [...new Set(args.snapshot_evidence_ids)]
          : host.db.prepare(`SELECT id FROM evidence WHERE source='sports/snapshot' AND retrieved_at<=?
              AND json_extract(data,'$.eventKey')=? AND json_extract(data,'$.mode')='live'
              ORDER BY retrieved_at DESC LIMIT 12`).all(asOf, args.event_key!).map(r => String(r.id));
        if (ids.length > 12) throw Error('一次最多回看 12 份快照。');
        const captures = ids.map(snapshot).sort((a,b) => a.proof.retrievedAt.localeCompare(b.proof.retrievedAt));
        const eventKey = args.event_key ?? captures[0]?.data.eventKey;
        if (captures.some(c => c.data.eventKey !== eventKey || c.proof.retrievedAt > asOf))
          throw Error('快照必须属于同一赛事且在截止时点已取得。更早的原始比分凭据请用 sports_assistant 回放。');
        const series = captures.map(({ data, proof }) => {
          const { facts, market } = data;
          const { contract, check } = row(market);
          const { outcomeToken, conditionId, url, quote } = row(contract);
          const result = row(row(quote).result);
          const bookId = row(quote).evidenceId;
          const book = typeof bookId === 'string' ? host.loadEvidence(bookId) : undefined;
          const qualified = book && book.retrievedAt <= asOf && row(check).binding === 'verified' &&
            row(quote).status === 'ok' && result.conditionId === conditionId && result.tokenId === outcomeToken &&
            typeof outcomeToken === 'string' && result.timestampStatus === 'within_30s' && result.bookShape === 'two_sided';
          const observation = sportsTimestamp(facts.stateObservedAt);
          const scoreCapture = sportsTimestamp(facts.observedAt);
          const quoteTime = sportsTimestamp(result.sourceTime);
          const game = facts.game;
          const pointsByPlayer = game && data.participants.map(({ id, name }, i) => ({
            playerId: id, player: name, pointDisplay: game.points[i],
            advantage: game.tiebreak === false && /^(?:A|AD|ADV)$/i.test(game.points[i]),
            serving: game.serverId === null ? null : game.serverId === id,
          }));
          return { evidenceId: proof.evidenceId, snapshotSavedAt: proof.retrievedAt, state: data.state, mode: data.mode,
            scoreObservedAt: observation, scoreBeijingTime: beijingTime(observation),
            scoreCapturedAt: scoreCapture, scoreCaptureBeijingTime: beijingTime(scoreCapture),
            activeSet: facts.activeSet, sets: facts.sets, game, pointsByPlayer, coverage: data.coverage,
            sources: facts.sources, market: !contract ? null : { conditionId, outcomeToken, url,
              quoteStatus: qualified ? 'covered' : 'unavailable', upstreamQuoteStatus: row(quote).status ?? null,
              quoteTimestampStatus: result.timestampStatus ?? null, quoteShape: result.bookShape ?? null,
              quote: qualified ? { evidenceId: book.evidenceId, source: book.source, retrievedAt: book.retrievedAt,
                sourceTime: quoteTime, beijingTime: beijingTime(quoteTime), bestBid: result.bestBid, bestAsk: result.bestAsk,
                scoreToBookSeconds: observation && quoteTime ? (Date.parse(quoteTime) - Date.parse(observation)) / 1000 : null } : null } };
        });
        const distinct = [...new Map(series.map(item => [JSON.stringify([item.scoreObservedAt ?? item.scoreCapturedAt ?? item.evidenceId,
          item.state, item.activeSet, item.sets, item.game, item.market]), item])).values()];
        const participants = captures[0]?.data.participants ?? [];
        const gameChanges = distinct.slice(1).flatMap((current, i) => {
          const before = distinct[i];
          const sourceTimed = Boolean(before.scoreObservedAt && current.scoreObservedAt);
          const earlier = sourceTimed ? before.scoreObservedAt : before.scoreCapturedAt;
          const later = sourceTimed ? current.scoreObservedAt : current.scoreCapturedAt;
          if (!earlier || !later || earlier >= later ||
              [before, current].some(item => ['score', 'server'].some(field => status(item.coverage[field]) !== 'covered'))) return [];
          const game = completedServiceGame(before, current, participants);
          return game ? [{ ...game, label: game.kind === 'break' ? '破发' : '保发',
            timeBasis: sourceTimed ? 'source_observation' : 'score_capture',
            beforeEvidenceId: before.evidenceId, afterEvidenceId: current.evidenceId }] : [];
        });
        return save(action, { status: series.length ? 'partial' : 'unavailable', eventKey, asOf,
          availableSnapshots: distinct.length, storedReceipts: series.length,
          participants, series: distinct, gameChanges, inputEvidenceIds: ids,
          pointHistory: 'unavailable', continuousBook: 'unverified',
          meaning: '只展示本次取到的离散快照。跨快照比盘口必须使用同一 conditionId、outcomeToken，核对两条源时间；无报价或逐分时保留缺口。' });
      }
      const dataId = args.snapshot_evidence_id;
      const cap = dataId ? snapshot(dataId) : undefined;
      const data = cap?.data;
      const deciding = args.deciding_format as DecidingFormat | undefined;
      const bestOf = args.best_of ?? data?.facts.bestOf;
      if (!deciding || bestOf !== 3 && bestOf !== 5) throw Error('需要明确三盘两胜或五盘三胜，并核对决胜盘采用普通抢七、6–6 抢十或整盘替代抢十。');
      if (data?.facts.bestOf && args.best_of && args.best_of !== data.facts.bestOf) throw Error('输入赛制与快照的 bestOf 不一致。');
      if (data && (args.sets || args.games || args.points || args.server || args.players))
        throw Error('真实比分与手工情景请分开计算。');
      let sets: Pair<number>, games: Pair<number>, points: Pair<string>, server: Side;
      if (data) {
        const facts = data.facts;
        if (data.state !== 'live' || ['state','currentPoints','server'].some(k => status(data.coverage[k]) !== 'covered'))
          throw Error('此快照须明确覆盖进行中状态、当前分数和发球方。');
        const active = facts.sets.find(s => s.number === facts.activeSet && !s.winnerId);
        const sides = data.participants.map(p => p.id);
        const serving = sides.indexOf(facts.game?.serverId ?? '');
        const previous = facts.sets.filter(s => active && s.number < active.number && s.winnerId && sides.includes(s.winnerId));
        if (!active || !facts.game || (serving !== 0 && serving !== 1) || previous.length !== active.number-1)
          throw Error('快照缺少当前盘次、明确的发球方或此前完赛盘。');
        const replacement = deciding === 'match_tiebreak10' && previous.length === bestOf-1;
        if (replacement !== (active.format === 'match_tiebreak') ||
            facts.game.tiebreak !== null && facts.game.tiebreak !== (replacement || active.games.every(s => s === 6)))
          throw Error('快照的抢七／抢十状态与输入赛制不一致。');
        sets = pair(sides.map(id => previous.filter(s => s.winnerId === id).length), '已完成盘数');
        games = replacement ? [0,0] : active.games;
        points = facts.game.points;
        server = serving;
      } else {
        sets = pair(args.sets, '已完成盘数');
        games = pair(args.games, '当前局数');
        points = pair(args.points, '当前分数');
        if (!args.server) throw Error('还需要知道下一分由 A 或 B 发球。');
        server = args.server === 'A' ? 0 : 1;
      }
      if (args.profile_evidence_ids && args.serve_win_rates) throw Error('历史样本发球率与手工发球率须二选一。');
      const profileIds = args.profile_evidence_ids ? pair(args.profile_evidence_ids, '画像证据') : undefined;
      const profiles = profileIds?.map(id => {
        const proof = host.loadEvidence(id);
        const profile = row(proof?.data);
        if (!proof || profile.kind !== 'tennis_profile' || !['ok','partial'].includes(String(profile.status)))
          throw Error('画像证据不可用 ' + id);
        if (data && (data.mode === 'replay' || data.facts.observedAt) &&
            proof.retrievedAt > (data.mode === 'replay' ? data.asOf : data.facts.observedAt!))
          throw Error('画像晚于比分时点取得。历史情景可用明确给定的发球率假设。');
        const player = row(profile.player), metrics = row(profile.metrics);
        const sampled = row(metrics.servePointsWon);
        const value = player.tour === 'ATP' ? Number(metrics.serviceGames) >= 30 ? metrics.servePointsWon : null
          : Number(sampled.matches) >= 3 && Number(sampled.total) >= 150 ? sampled.rate : null;
        if (typeof value !== 'number') throw Error('画像的发球分样本不足。');
        return { player, value, surface: profile.surface, season: profile.season };
      });
      if (profiles && (profiles[0].player.tour !== profiles[1].player.tour || profiles[0].surface !== profiles[1].surface ||
          profiles[0].season !== profiles[1].season || profiles[0].player.id === profiles[1].player.id))
        throw Error('画像须是相同巡回赛、场地和赛季下的两位不同选手。');
      if (profiles && data && (!data.surface || data.surface !== profiles[0].surface || profiles.some(({ player }, i) =>
        player.id !== data.participants[i].id || player.tour !== data.facts.tour)))
        throw Error('画像与快照的原生选手 ID、巡回赛或场地无法匹配。');
      const serve = pair(profiles?.map(p => p.value) ?? args.serve_win_rates, '发球分胜率');
      const result = tennisScoreScenario({ serve, server, bestOf, deciding, sets, games, points });
      return save(action, { status: 'ok', eventKey: data?.eventKey, snapshotCapturedAt: cap?.proof.retrievedAt,
        scoreObservedAt: data?.facts.stateObservedAt, scoreCapturedAt: data?.facts.observedAt,
        scoreBasis: data ? data.mode === 'replay' ? 'saved_replay' : 'saved_score' : 'user_scenario',
        players: data?.participants ?? (args.players ? pair(args.players, '选手名') : profiles?.map(p => p.player) ?? ['A','B']),
        input: { serve, server: server === 0 ? 'A' : 'B', bestOf, deciding, sets, games, points,
          serveBasis: profiles ? 'historical_serve_rates_as_assumptions' : 'user_assumptions' },
        result, sources: data?.facts.sources, formatSources, inputEvidenceIds: [...(dataId ? [dataId] : []), ...profileIds ?? []],
        meaning: '固定发球分胜率的条件计算，假定后续继续按此赛制打完。退赛概率、市场结算、盘口可成交性未进入模型。' });
    },
  });
}
