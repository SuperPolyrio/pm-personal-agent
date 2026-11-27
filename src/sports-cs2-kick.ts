import { sourceSetting } from './source-config.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Cs2LiveMatch, Cs2LiveRound, Cs2Play } from './sports-cs2-live.js';

type Side = 0 | 1;
type Score = [number, number];
type Objectives = NonNullable<Cs2LiveRound['video']>['objectives'];
export type KickFrame = { at: number; fields: string[]; banner: string; kills: string[][]; attackLeft: boolean; bomb: boolean };

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const hudTeams: Record<string, string[]> = {
  imperial: ['imp', 'mp', 'imperialesports'], liquid: ['tl', 'teamliquid'],
  wildcard: ['wc'], chinggiswarriors: ['cw', 'chinggis'],
  '100thieves': ['100t', 't00t'], '9z': ['9zg', '9zglobant', 'globant', '926', '976', '92zg'],
  lynnvision: ['lvg', 'lynnvisiongaming'], parivision: ['pv', 'pvision'],
  faze: ['fazeclan'], ninjasinpyjamas: ['nip'], eternalfire: ['ef'],
  bcgame: ['bcg'], flyquest: ['fq'], dendele: ['den'],
};

function namesFor(name: string) {
  const raw = key(name);
  const aliases = Object.entries(hudTeams).find(([main, aliases]) => raw === main || aliases.includes(raw));
  return aliases ? [aliases[0], ...aliases[1]] : [raw];
}

export function kickChannel(match: Cs2LiveMatch) {
  const relay = URL.parse(match.relay);
  if (relay?.origin !== sourceSetting('PM_CS2_RELAY_URL')) return;
  if (relay.pathname.replace(/\/$/, '') === '/a') return 'pgl';
  if (relay.pathname.replace(/\/$/, '') === '/b') return 'pglcs2';
}

const sum = (score: Score) => score[0] + score[1];
const same = (a: Score, b: Score) => a[0] === b[0] && a[1] === b[1];
const other = (side: Side): Side => side === 0 ? 1 : 0;
function stepped(from: Score, to: Score): Side | undefined {
  if (sum(to) === sum(from) + 1 && to[0] >= from[0] && to[1] >= from[1]) return to[0] > from[0] ? 0 : 1;
}

function oneEdit(first: string, second: string) {
  if (Math.abs(first.length - second.length) > 1) return false;
  const offset = [...first].findIndex((letter, i) => letter !== second[i]);
  if (offset === -1) return second.length >= first.length;
  if (first.length === second.length) return first.slice(offset + 1) === second.slice(offset + 1);
  return first.length > second.length ? first.slice(offset + 1) === second.slice(offset) : first.slice(offset) === second.slice(offset + 1);
}

export function createKickRounds(match: Cs2LiveMatch, source: string,
  mapWinner: (score: Score) => Side | undefined, onRound: (round: Cs2LiveRound) => void) {
  const aliases = match.teams.map(namesFor);
  let mapIndex = -1, baseline: Score, series: Score, roster: { name: string; side: Side; label: string }[] = [];
  let board: Score | undefined, pending: Score | undefined, lastBoardAt = 0, attack: Side = 0;
  let start: Cs2LiveRound['start'];
  let plays: Cs2Play[] = [], objectives: Objectives = [];
  let waitingForBoard = false;
  let previousAt = -1;
  function beginMap(index: number, score: Score, standing: Score, players: [string[], string[]]) {
    if (index < mapIndex) return;
    if (index !== mapIndex) {
      mapIndex = index;
      board = pending = undefined;
      plays = []; objectives = [];
      start = undefined;
      waitingForBoard = false;
    }
    baseline = score;
    series = standing;
    roster = players.flatMap((names, side) => names.map(name => ({ name, side: side as Side, label: key(name) })));
  }
  function findPlayer(word: string) {
    const term = key(word.replace(/\|/g, 'I'));
    const exact = roster.find(player => player.label === term || player.label === 'naffly' && term === 'naf');
    if (exact || term.length < 5) return exact;
    const matches = roster.filter(player => oneEdit(term, player.label));
    return matches.length === 1 ? matches[0] : undefined;
  }
  function publish(winner: Side, score: Score, at: number) {
    if (!board || score.some((value, i) => value < baseline[i]) || sum(score) <= sum(baseline)) return;
    const mapOver = mapWinner(score) === winner;
    const projected: Score = [...series];
    if (mapOver) projected[winner]++;
    onRound({ match, mapIndex, score, winner, series: projected, mapOver,
      seriesOver: Math.max(...projected) > match.maps.length / 2, fullRound: false, plays,
      video: { source, objectives }, start, tick: at, fragment: -1, receivedAt: at });
  }
  function ingest(frame: KickFrame) {
    if (mapIndex < 0 || frame.at <= previousAt) return;
    previousAt = frame.at;
    const [leftTag, left, right, rightTag] = frame.fields.map(key);
    const leftSide = aliases.findIndex(names => names.includes(leftTag));
    const rightSide = aliases.findIndex(names => names.includes(rightTag));
    const valid = leftSide >= 0 && rightSide >= 0 && leftSide !== rightSide && /^\d{1,2}$/.test(left) && /^\d{1,2}$/.test(right);
    if (valid) {
      const score: Score = leftSide === 0 ? [Number(left), Number(right)] : [Number(right), Number(left)];
      if (score.some((value, i) => value < baseline[i]) || sum(score) - sum(baseline) > 9) return;
      if (!board || !same(board, score)) {
        if (!pending || !same(pending, score)) {
          pending = score;
          return;
        }
        const winner = board && stepped(board, score);
        if (winner !== undefined && !waitingForBoard) publish(winner, score, frame.at);
        if (board && sum(score) <= sum(board)) return;
        board = score;
        pending = undefined;
        start = { tick: frame.at, fragment: -1, receivedAt: frame.at };
        plays = []; objectives = [];
        waitingForBoard = false;
      } else {
        pending = undefined;
      }
      lastBoardAt = frame.at;
      attack = (frame.attackLeft ? leftSide : rightSide) as Side;
      if (waitingForBoard || mapWinner(board) !== undefined) return;
      // The previous kill feed can remain on screen as the scoreboard advances.
      if (start && frame.at - start.receivedAt < 6000) return;
      if (frame.bomb && !objectives.some(event => event.kind === 'plant'))
        objectives.push({ kind: 'plant', side: attack, at: frame.at });
      for (const words of frame.kills) {
        const labels = words.filter(word => findPlayer(word) || key(word).length > 2);
        const killer = findPlayer(labels[0] ?? '') ?? findPlayer(labels.slice(0, 2).join(''));
        const victim = findPlayer(labels.at(-1) ?? '') ?? findPlayer(labels.slice(-2).join(''));
        if (!killer || !victim || killer.side === victim.side ||
            plays.some(play => play.kind === 'kill' && play.victim === victim.name)) continue;
        plays.push({ kind: 'kill', tick: frame.at, player: killer.name, victim: victim.name,
          side: killer.side, weapon: '', headshot: false });
      }
      return;
    }
    if (!board || waitingForBoard || mapWinner(board) !== undefined || frame.at - lastBoardAt > 7000) return;
    const banner = frame.banner.toLowerCase();
    const plant = /\bplants\b|\bthe bomb\b/.test(banner);
    const defuse = /\bdefus(?:es|ed)\b/.test(banner);
    const named = aliases.map((names, i) => names.some(name => name.length >= 3 && key(banner).includes(name)) ? i : -1)
      .filter(i => i >= 0);
    if (plant || defuse) {
      const kind = plant ? 'plant' : 'defuse';
      const side = named.length === 1 ? named[0] as Side : plant ? attack : other(attack);
      if (!objectives.some(event => event.kind === kind)) objectives.push({ kind, side, at: frame.at });
    }
    if (/\bwins\b/.test(banner) && named.length === 1) {
      const winner = named[0] as Side;
      const score: Score = [...board];
      score[winner]++;
      publish(winner, score, frame.at);
      waitingForBoard = true;
    }
  }
  return { beginMap, ingest };
}

export async function followCs2Kick(channel: string, signal: AbortSignal, onFrame: (frame: KickFrame) => void,
  status: (state: string, detail: unknown) => void) {
  const run = promisify(execFile);
  const direct = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(http|https|all|wss)_proxy$/i.test(name)));
  const script = fileURLToPath(new URL('../tools/cs2-kick-hud.py', import.meta.url));
  while (!signal.aborted) {
    try {
      const { stdout } = await run('curl', ['--noproxy', '*', '-fsS', '--max-time', '12',
        sourceSetting('PM_KICK_URL') + '/api/v2/channels/' + channel], { signal, maxBuffer: 256 * 1024 });
      const response = JSON.parse(stdout);
      const url = URL.parse(response.playback_url ?? response.livestream?.playback_url ?? '');
      if (!response.livestream?.is_live || url?.protocol !== 'https:' || !url.hostname.endsWith('.playback.live-video.net'))
        throw Error('missing official playback URL');
      const video = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000',
        '-live_start_index', '-1', '-i', url.href, '-an', '-sn', '-vf', 'fps=1,scale=1280:720',
        '-c:v', 'ppm', '-f', 'image2pipe', 'pipe:1'], { signal, env: direct, stdio: ['ignore', 'pipe', 'ignore'] });
      const ocr = spawn('python3', [script], { signal, stdio: ['pipe', 'pipe', 'ignore'] });
      const done = (child: ChildProcess) => new Promise<void>(resolve => {
        child.once('close', () => resolve());
        child.once('error', () => resolve());
      });
      const closed = Promise.race([done(video), done(ocr)]);
      ocr.stdin?.on('error', () => video.kill());
      video.stdout!.pipe(ocr.stdin!);
      let active = false;
      let lastFrame = Date.now();
      const watchdog = setInterval(() => { if (Date.now() - lastFrame > 30_000) video.kill(); }, 5000);
      const lines = createInterface({ input: ocr.stdout! });
      lines.on('line', line => {
        try {
          const frame: KickFrame = JSON.parse(line);
          lastFrame = Date.now();
          if (!active) status('kick_frames', { source: sourceSetting('PM_KICK_URL') + '/' + channel });
          active = true;
          onFrame(frame);
        } catch { /* OCR emits one JSON record per frame. */ }
      });
      await closed;
      clearInterval(watchdog);
      lines.close();
      video.kill(); ocr.kill();
      if (!signal.aborted) status('kick_gap', { channel });
    } catch {
      if (!signal.aborted) status('kick_unavailable', { channel });
    }
    if (!signal.aborted) await sleep(4000, undefined, { signal }).catch(() => {});
  }
}
