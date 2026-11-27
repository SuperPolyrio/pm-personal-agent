import { sourceSetting } from '../dist/source-config.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';
import { cs2MapWinner, followCs2Playcast, formatCs2LiveRound } from '../dist/sports-cs2-live.js';
import { kickChannel, createKickRounds, followCs2Kick } from '../dist/sports-cs2-kick.js';
import { bindCs2Markets, cs2QuoteTimeline, cs2RoundMarkets, followCs2MarketQuotes } from '../dist/sports-cs2-market.js';
import { cs2RoundNumber, describeCs2MarketRound, marketEvidenceForRound, openCs2RoundJournal,
  readCs2RoundJournal } from '../dist/sports-cs2-rounds.js';
import { researchEngine } from '../dist/market-data.js';

const [matchUrl, relayUrl, first, second, mapList, priorList = '-', ...options] = process.argv.slice(2);
const usage = 'npm run cs2:live -- <HLTV match URL> <GOTV URL> <team1> <team2> <map1,map2,map3> <prior winners as 1,2 or -> [--telegram] [--pm-event=slug]';
if (![matchUrl, relayUrl, first, second, mapList].every(Boolean) || first === second) throw new Error(usage);
const matchPage = new URL(matchUrl);
const relay = new URL(relayUrl);
const matchId = /^\/matches\/(\d+)\//.exec(matchPage.pathname)?.[1];
const maps = mapList.split(',').map(name => name.trim());
const prior = priorList === '-' ? [] : priorList.split(',');
const pm = options.find(option => option.startsWith('--pm-event='))?.slice('--pm-event='.length);
if (matchPage.origin !== sourceSetting('PM_HLTV_URL') || !matchId || relay.protocol !== 'https:'
  || relay.username || relay.password || ![1, 3, 5].includes(maps.length) || maps.some(name => !/^[\w ]+$/.test(name))
  || prior.length >= maps.length || prior.some(value => !['1', '2'].includes(value))
  || options.some(option => option !== '--telegram' && !/^--pm-event=cs2-[a-z0-9-]{1,160}$/.test(option))) throw new Error(usage);

const match = { sourceUrl: matchPage.href, relay: relay.href, teams: [first, second], maps,
  priorWinners: prior.map(value => Number(value) - 1), marketEventSlug: pm };
const log = (state, detail) => console.log(JSON.stringify({ state, at: new Date().toISOString(), detail }));
const markets = pm && await bindCs2Markets(pm, match.teams, maps.length, researchEngine);
if (pm && !markets?.[0]) throw new Error('未核对该场 Polymarket 系列赛胜负盘。');
const quotes = markets ? cs2QuoteTimeline(markets) : undefined;
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(3 * 60 * 60 * 1000)]);
const channel = kickChannel(match);

let delivery = Promise.resolve();
let telegram;
let chat;

if (options.includes('--telegram')) {
  const token = process.env['telegram-token'] ?? process.env.TELEGRAM_BOT_TOKEN;
  chat = Number(process.env.TELEGRAM_USER_ID);
  if (!token || !Number.isSafeInteger(chat) || chat <= 0)
    throw new Error('Telegram 需要配置 telegram-token 和 TELEGRAM_USER_ID。');
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  telegram = new Bot(token, { client: { apiRoot: sourceSetting('PM_TELEGRAM_API_URL'), baseFetchConfig: proxy ? { agent: new HttpsProxyAgent(proxy) } : {}, timeoutSeconds: 12 } });
}

process.umask(0o077);
const journal = openCs2RoundJournal();
const previous = readCs2RoundJournal(matchId);
let recent = previous.slice(0, 4).map(({ round }) => round);
const marketProxy = sourceSetting('PM_POLYMARKET_READ_PROXY');
const marketAgent = !marketProxy ? undefined : marketProxy.startsWith('socks')
  ? new SocksProxyAgent(marketProxy) : new HttpsProxyAgent(marketProxy);
const quoteFollow = quotes && followCs2MarketQuotes(quotes, signal, log, url => {
  const socket = new WebSocket(url, { agent: marketAgent, handshakeTimeout: 5000 });
  socket.on('error', () => {}); // Close carries the reconnect status.
  return socket;
}).catch(error => log('pm_failed', String(error)));
const roundId = round => `hltv:${matchId}:${round.mapIndex + 1}:${cs2RoundNumber(round)}`;
const sendRound = round => {
  const id = roundId(round);
  if (!journal.claim(id, round)) return;
  log('round_observed', { id, source: round.video ? 'kick' : 'cstv', at: round.receivedAt, score: round.score });
  const backfill = !round.video && recent.some(prior => prior.mapIndex === round.mapIndex &&
    cs2RoundNumber(prior) > cs2RoundNumber(round));
  const commentary = (backfill ? 'CSTV 补录\n' : '') + formatCs2LiveRound(round, recent);
  recent = [round, ...recent].slice(0, 4);
  const pending = markets ? cs2RoundMarkets(markets, round, researchEngine, quotes).catch(() => []) : undefined;
  delivery = delivery.then(async () => {
    const evidence = pending && marketEvidenceForRound(round, await pending);
    const marketLines = evidence?.length ? describeCs2MarketRound(round, evidence) : pm ? ['PM 行情暂不可用。'] : [];
    const message = [commentary, ...marketLines].join('\n');
    journal.save(id, round, message, evidence);
    if (!telegram) return log('round', { id, text: message });
    if (Date.now() - round.receivedAt > 25_000) {
      journal.failed(id, 'stale');
      return log('stale', { id });
    }
    try {
      const send = () => telegram.api.sendMessage(chat, message, { link_preview_options: { is_disabled: true } });
      const result = await send().catch(async error => {
        // Only retry rejections that could not have accepted the original message.
        const code = error.error?.code ?? error.cause?.code;
        const delay = error.error_code === 429 ? Number(error.parameters?.retry_after ?? 3) * 1000
          : ['ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code) ? 500 : NaN;
        if (!Number.isFinite(delay) || Date.now() + delay - round.receivedAt > 25_000) throw error;
        await sleep(delay);
        return send();
      });
      const ack = Date.now();
      journal.sent(id, { ok: true, result }, ack);
      log('delivered', { id, messageId: result.message_id, source: round.video ? 'kick' : 'cstv',
        relayToAckMs: ack - round.receivedAt });
    } catch (error) {
      const failure = error.error_code ? `Telegram ${error.error_code}` : 'Telegram delivery unconfirmed';
      journal.failed(id, failure);
      log('delivery_failed', { id, failure, code: error.error?.code ?? error.cause?.code ?? error.error?.type });
    }
  });
};
function eventKeys(round) {
  return new Set([
    ...round.plays.flatMap(play => play.kind === 'kill' ? [`kill:${play.player}:${play.victim}`]
      : play.kind === 'plant' || play.kind === 'defuse' ? [`${play.kind}:${play.side}`] : []),
    ...(round.video?.objectives ?? []).map(event => `${event.kind}:${event.side}`),
  ]);
}
const confirmRound = round => {
  const id = roundId(round);
  const original = journal.get(id);
  if (!original) return sendRound(round);
  if (!original.round.video || original.round.verification) return;
  delivery = delivery.then(async () => {
    // The first message and its market evidence may still be completing.
    const stored = journal.get(id);
    if (!stored || stored.round.verification) return;
    const early = stored.round;
    const predicted = eventKeys(early), truth = eventKeys(round);
    const correct = [...predicted].filter(event => truth.has(event));
    const unconfirmed = [...predicted].filter(event => !truth.has(event));
    const missing = [...truth].filter(event => !predicted.has(event));
    const marketLines = early.polymarket?.length ? describeCs2MarketRound(early, early.polymarket)
      : pm ? ['PM 行情暂不可用。'] : [];
    const commentary = formatCs2LiveRound(round, recent);
    const bombDetails = round.plays.flatMap(play => {
      if (play.kind !== 'plant' && play.kind !== 'defuse') return [];
      const fact = `${play.player} ${play.kind === 'plant' ? '下包' : '完成拆包'}`;
      return commentary.includes(fact) ? [] : [`${play.kind === 'plant' ? '下包人' : '拆包人'} ${play.player}。`];
    });
    const recap = round.fullRound ? [commentary, ...bombDetails, '已用官方 CSTV 核对。']
      : [`CSTV 已核对第 ${cs2RoundNumber(round)} 回合比分 ${round.score.join('–')}，过程仅取得部分片段。`,
        formatCs2LiveRound({ ...early, score: round.score, winner: round.winner, series: round.series,
          mapOver: round.mapOver, seriesOver: round.seriesOver, video: { ...early.video, scoreChecked: true } }, recent),
        'CSTV 片段', commentary.split('\n')[1], ...bombDetails];
    const message = [...recap, ...marketLines].join('\n');
    journal.verify(id, round, message);
    log('round_verified', { id, kickAt: early.receivedAt, cstvAt: round.receivedAt,
      leadMs: round.receivedAt - early.receivedAt, draftLeadMs: early.savedAt && round.receivedAt - early.savedAt,
      complete: round.fullRound,
      scoreCorrect: early.score.every((value, i) => value === round.score[i]), correct,
      ...(round.fullRound ? { extra: unconfirmed } : { unconfirmed }), missing, text: message });
    if (telegram && stored.messageId) {
      try {
        const result = await telegram.api.editMessageText(chat, stored.messageId, message, { link_preview_options: { is_disabled: true } });
        journal.edited(id, result);
        log('round_updated', { id, messageId: stored.messageId });
      } catch (error) { log('round_update_failed', { id, errorCode: error.error_code }); }
    }
  });
};
const known = new Map();
const video = channel && createKickRounds(match, sourceSetting('PM_KICK_URL') + '/' + channel, cs2MapWinner, sendRound);
const kickFollow = video && followCs2Kick(channel, signal, video.ingest, log);
log('following', { match, telegram: Boolean(telegram), polymarket: markets,
  ...(channel && { kick: sourceSetting('PM_KICK_URL') + '/' + channel }) });
try {
  const finished = previous.find(({ round }) => round.seriesOver && !round.video)?.round;
  const outcome = finished ? { status: 'finished', series: finished.series }
    : await followCs2Playcast(match, signal, round => {
      const context = known.get(round.mapIndex);
      if (context) video?.beginMap(round.mapIndex, round.score, context.series, context.roster);
      confirmRound(round);
    }, log, undefined, mapIndex =>
      previous.find(({ round }) => round.mapIndex === mapIndex && !round.video)?.round.score,
    (mapIndex, score, series, roster) => {
      known.set(mapIndex, { series, roster });
      video?.beginMap(mapIndex, score, series, roster);
    });
  log('done', outcome);
} finally {
  stop.abort();
  await Promise.all([quoteFollow, kickFollow]);
  try { await delivery; } finally { journal.close(); }
}
