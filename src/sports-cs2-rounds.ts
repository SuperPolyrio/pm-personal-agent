import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Cs2LiveRound } from './sports-cs2-live.js';
import type { Cs2MarketRound } from './sports-cs2-market.js';

const slug = /^cs2-[a-z0-9-]+$/;
const cents = (value: string | number) => `${Number((Number(value) * 100).toFixed(2))}¢`;
const pp = (value: number) => `${value > 0 ? '+' : ''}${Number((value * 100).toFixed(2))} 个百分点`;
const timestamp = (value: string) => Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
const time = (value: number | string) => new Date(typeof value === 'number' ? value : timestamp(value))
  .toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai' });
const hex = (value: string) => /^0x/i.test(value) ? value : `0x${value}`;
const tradeHash = (value?: string) => value && /^(?:0x)?[a-f0-9]{64}$/i.test(value) ? hex(value) : undefined;
const dbPath = () => resolve(process.env.PM_STATE_DIR ?? 'var', 'cs2-live.sqlite');
export const cs2RoundNumber = (round: Cs2LiveRound) => round.score[0] + round.score[1];

export type SavedCs2Round = {
  id: string; round: Cs2LiveRound; markets?: Cs2MarketRound[]; availableAt: number; message: string;
};
type JournalEvidence = Cs2LiveRound & { polymarket?: Cs2MarketRound[]; savedAt?: number;
  verification?: { round: Cs2LiveRound; message: string; availableAt: number } };
type JournalRow = { id: string; evidence: string; message: string; acknowledged_at?: number; receipt?: string };

export function cs2MatchId(sourceUrl: string) {
  return /^https:\/\/www\.hltv\.org\/matches\/(\d+)\//.exec(sourceUrl)?.[1];
}

export function marketEvidenceForRound(round: Cs2LiveRound, markets: Cs2MarketRound[], contract?: {
  conditionId?: string; tokenId?: string;
}) {
  return markets.filter(({ market, as_of }) => {
    const expected = market.mapIndex === undefined
      ? (/-game([1-5])$/.exec(market.slug)?.[1] ?? null) : market.mapIndex === null ? null : String(market.mapIndex + 1);
    const family = market.slug?.replace(/-game[1-5]$/, '');
    return (expected === null || expected === String(round.mapIndex + 1)) && Boolean(family && slug.test(family))
      && (!round.match.marketEventSlug || round.match.marketEventSlug === family)
      && (!contract?.conditionId || market.conditionId === contract.conditionId.toLowerCase())
      && (!contract?.tokenId || market.tokenId === contract.tokenId) && Date.parse(as_of) <= round.receivedAt;
  });
}

export function describeCs2MarketRound(round: Cs2LiveRound, markets: Cs2MarketRound[], requireMap = true) {
  const lines = [];
  const trends = [];
  const commonTeam = markets.every(row => row.market.team === markets[0]?.market.team) ? markets[0]?.market.team : undefined;
  for (const { market, price, trades, quotes } of markets) {
    const label = `PM ${market.label} · ${market.team}`;
    const mid = (quote: NonNullable<NonNullable<Cs2MarketRound['quotes']>['end']>) => (quote.bid + quote.ask) / 2;
    if (quotes?.before && quotes.end) {
      lines.push(`${label}，${round.video ? '画面回合切换与结束观测时' : '开打与结束收包时'}的盘口中价 ${cents(mid(quotes.before))} → ${cents(mid(quotes.end))}（${pp(mid(quotes.end) - mid(quotes.before))}，报价 ${time(quotes.before.time)} / ${time(quotes.end.time)}）。`);
    } else if (quotes?.end) {
      lines.push(`${label}，回合结束收包时的盘口中价 ${cents(mid(quotes.end))}（报价 ${time(quotes.end.time)}，本回合缺开打时报价）。`);
    }
    if (price) {
      const age = Math.round((round.receivedAt - timestamp(price.last_time)) / 1000);
      const selection = commonTeam ? market.label : `${market.label} · ${market.team}`;
      trends.push(`${selection} ${cents(price.first_price)} → ${cents(price.last_price)}（${pp(Number(price.last_price) - Number(price.first_price))}，末笔 ${time(price.last_time)}，距收包 ${age} 秒）`);
    } else if (!quotes?.end) {
      lines.push(`${label}，${trades === undefined ? '链上历史成交暂不可查' : '近3分钟缺可核对的链上成交价'}。`);
    }
  }
  if (trends.length) lines.push(`PM${commonTeam ? ' · ' + commonTeam : ''}｜收包前 3 分钟已入库首末成交`, ...trends);
  const isMap = ({ market }: Cs2MarketRound) => market.mapIndex === round.mapIndex
    || market.mapIndex === undefined && market.slug.endsWith(`-game${round.mapIndex + 1}`);
  const preferred = [...markets.filter(isMap), ...markets.filter(row => !isMap(row))];
  const chain = preferred.flatMap(({ market, trades }) => (trades ?? []).map(row => ({ market, row, hash: tradeHash(row.tx_hash) })));
  const sample = chain.find(row => row.hash);
  if (sample) {
    const { market, row, hash } = sample;
    lines.push(`代表性链上成交 · ${market.label} / ${market.team}｜${time(row.trade_time)}（北京时间）｜原价 ${row.price} × ${row.size} 份｜日志 ${row.log_index}`,
      `交易哈希 ${hash}`);
  } else {
    const live = preferred.flatMap(({ market, liveTrades }) =>
      (liveTrades ?? []).map(row => ({ market, row, hash: tradeHash(row.transactionHash) })));
    const trade = live.find(row => row.hash) ?? live[0];
    if (trade) lines.push(`代表性即时成交 · ${trade.market.label} / ${trade.market.team}｜${time(trade.row.time)}（北京时间）｜原价 ${trade.row.price} × ${trade.row.size} 份`,
      trade.hash ? `交易哈希 ${trade.hash}` : '交易哈希待确认。');
  }
  if (requireMap && !markets.some(isMap)) lines.push('本图胜负盘尚未核验。');
  return lines;
}

export function openCs2RoundJournal() {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 3000 });
  db.exec(`CREATE TABLE IF NOT EXISTS round_deliveries (
    id TEXT PRIMARY KEY, evidence TEXT NOT NULL, message TEXT NOT NULL, receipt TEXT, acknowledged_at INTEGER, failure TEXT
  )`);
  const insert = db.prepare("INSERT OR IGNORE INTO round_deliveries(id, evidence, message) VALUES (?, ?, '')");
  const update = db.prepare('UPDATE round_deliveries SET evidence = ?, message = ? WHERE id = ?');
  const sent = db.prepare('UPDATE round_deliveries SET receipt = ?, acknowledged_at = ? WHERE id = ?');
  const failed = db.prepare('UPDATE round_deliveries SET failure = ? WHERE id = ?');
  const get = db.prepare('SELECT evidence, message, receipt FROM round_deliveries WHERE id = ?');
  const verified = db.prepare("UPDATE round_deliveries SET evidence = json_set(evidence, '$.verification', json(?)) WHERE id = ?");
  const edited = db.prepare("UPDATE round_deliveries SET evidence = json_set(evidence, '$.verification.telegram', json(?)) WHERE id = ?");
  return {
    claim(id: string, round: Cs2LiveRound) { return Boolean(insert.run(id, JSON.stringify(round)).changes); },
    save(id: string, round: Cs2LiveRound, message: string, polymarket?: Cs2MarketRound[]) {
      update.run(JSON.stringify({ ...round, polymarket, savedAt: Date.now() }), message, id);
    },
    sent(id: string, receipt: unknown, at: number) { sent.run(JSON.stringify(receipt), at, id); },
    failed(id: string, reason: string) { failed.run(reason, id); },
    get(id: string) {
      const row = get.get(id) as JournalRow | undefined;
      if (row) return { round: JSON.parse(row.evidence) as JournalEvidence, message: row.message,
        messageId: row.receipt ? JSON.parse(row.receipt).result?.message_id as number | undefined : undefined };
    },
    verify(id: string, round: Cs2LiveRound, message: string) {
      verified.run(JSON.stringify({ round, message, availableAt: Date.now() }), id);
    },
    edited(id: string, result: unknown) { edited.run(JSON.stringify({ result, acknowledgedAt: Date.now() }), id); },
    close() { db.close(); },
  };
}

export function readCs2RoundJournal(matchId?: string, asOf = Infinity): SavedCs2Round[] {
  const path = dbPath();
  if (!existsSync(path) || matchId && !/^\d+$/.test(matchId)) return [];
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='round_deliveries'").get()) return [];
    const sql = 'SELECT id,evidence,message,acknowledged_at FROM round_deliveries';
    const rows = matchId
      ? db.prepare(`${sql} WHERE id >= ? AND id < ? ORDER BY rowid DESC`).all(`hltv:${matchId}:`, `hltv:${matchId};`)
      : db.prepare(`${sql} ORDER BY rowid DESC LIMIT 1200`).all();
    return (rows as unknown as JournalRow[]).flatMap(row => {
      const { polymarket, savedAt, verification, ...original } = JSON.parse(row.evidence) as JournalEvidence;
      const confirmed = verification && verification.availableAt <= asOf ? verification : undefined;
      const verifiedRound = confirmed?.round;
      const round = verifiedRound && !verifiedRound.fullRound && original.video
        ? { ...original, score: verifiedRound.score, winner: verifiedRound.winner, series: verifiedRound.series,
          mapOver: verifiedRound.mapOver, seriesOver: verifiedRound.seriesOver, video: { ...original.video, scoreChecked: true } }
        : verifiedRound ?? original;
      const sourceId = round.match?.sourceUrl && cs2MatchId(round.match.sourceUrl);
      if (!sourceId || !Array.isArray(round.score) || !Array.isArray(round.plays) || !Number.isFinite(round.receivedAt)
        || row.id !== `hltv:${sourceId}:${round.mapIndex + 1}:${cs2RoundNumber(round)}`) return [];
      const availableAt = confirmed?.availableAt ?? savedAt ?? row.acknowledged_at ?? round.receivedAt;
      return [{ id: row.id, round, markets: polymarket && marketEvidenceForRound(original, polymarket),
        message: confirmed?.message ?? row.message, availableAt }];
    }).sort((a, b) => matchId ? b.round.mapIndex - a.round.mapIndex || cs2RoundNumber(b.round) - cs2RoundNumber(a.round)
      : b.round.receivedAt - a.round.receivedAt);
  } finally {
    db.close();
  }
}
