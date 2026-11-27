import { sourceSetting } from './source-config.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DemoReader, EntityMode, HttpBroadcastReader, createDefaultFetcher, type BroadcastSyncDto } from 'cs2parser';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { cs2TeamKey } from './sports-cs2-market.js';
import type { createPolymarketPublicReader } from './polymarket-public.js';
import type { EvidenceRow } from './source-evidence.js';

const feeds = [sourceSetting('PM_CS2_RELAY_URL') + '/a', sourceSetting('PM_CS2_RELAY_URL') + '/b'];
const marketSlug = /^cs2-[a-z0-9-]{1,160}$/;
const mapKey = (name: string) => name.toLowerCase().replace(/^de_/, '').replace(/\s/g, '').replace(/^dustii$/, 'dust2');
type PublicRead = ReturnType<typeof createPolymarketPublicReader>['read'];
type GammaMarket = { slug: string; conditionId?: string; outcomes: string; outcomePrices: string; sportsMarketType: string; closed?: boolean };
type GammaEvent = { slug: string; live?: boolean; ended?: boolean; closed?: boolean; score?: string; period?: string;
  title?: string; tags?: { slug: string }[]; markets?: GammaMarket[] };

async function checkFeed(relay: string, map: string, teams: string[], signal: AbortSignal) {
  const request = AbortSignal.any([signal, AbortSignal.timeout(7000)]);
  const source = createDefaultFetcher(relay);
  const sync = await source.json<BroadcastSyncDto>('sync', request);
  if (!sync.map || mapKey(sync.map) !== mapKey(map) || sync.rcvage > 20 || sync.rtdelay > 25) return;
  const parser = new DemoReader();
  const reader = new HttpBroadcastReader(parser, relay, { signal: request, entities: EntityMode.ALL });
  try {
    const start = await reader.start();
    if (start.status !== 'ready') return;
    const tags = parser.teams.filter(team => [2, 3].includes(team.teamNumber));
    const matched = teams.map(team => tags.find(tag => cs2TeamKey(tag.clanName) === cs2TeamKey(team)));
    if (matched[0] && matched[1] && matched[0] !== matched[1])
      return { relay, teams: [matched[0].clanName, matched[1].clanName] as const };
  } finally { reader.stop(); }
}

export function createCs2CommentaryTool(host: { read: PublicRead; loadEvidence(id: string): EvidenceRow | undefined }) {
  type Stream = { status: 'starting' | 'streaming' | 'stopped' | 'finished' | 'failed'; child?: ChildProcess;
    matchUrl?: string; relay?: string; kick?: string; kickActive?: boolean; currentMap?: string;
    telegram?: boolean; lastMessageId?: number; reason?: string };
  const streams = new Map<string, Stream>();
  const tool = defineTool({
    name: 'cs2_live_commentary',
    description: '明确要求持续解说、逐回合播报时用此工具，复用已核对的 Polymarket 赛事、HLTV 原生比赛和地图顺序。PGL Singapore Major 用官方 Kick 画面速报，再用 CSTV 核对和补漏。在已配置的 Telegram 会话启动即向当前私聊推送。status 查询运行和 Bot API 消息 ID，stop 停止同场解说。',
    parameters: {
      action: { type: 'string', enum: ['start', 'status', 'stop'], required: true },
      event_slug: { type: 'string', required: true, description: 'Polymarket 的 CS2 赛事 slug。' },
      match_url: { type: 'string', description: '启动时用已核对的同场 HLTV 比赛链接。' },
      maps: { type: 'array', items: { type: 'string' }, description: '启动时用已核对的地图顺序，包含决胜图。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, { signal }) {
      const slug = args.event_slug.trim();
      if (!marketSlug.test(slug)) throw Error('请提供精确的 Polymarket CS2 赛事 slug。');
      const current = streams.get(slug);
      const reply = ({ child, ...stream }: Stream) => JSON.stringify({ eventSlug: slug, ...stream,
        delivery: stream.telegram === true ? 'telegram_private_chat' : stream.telegram === false ? 'journal_only' : undefined });
      if (args.action === 'stop') {
        if (current && ['starting', 'streaming'].includes(current.status)) {
          current.status = 'stopped';
          current.child?.kill();
        }
        return current ? reply(current) : JSON.stringify({ status: 'not_running', eventSlug: slug });
      }
      if (args.action === 'status') return current ? reply(current) : JSON.stringify({ status: 'not_running', eventSlug: slug });
      if (current && ['starting', 'streaming'].includes(current.status)) return reply(current);
      const page = args.match_url && URL.parse(args.match_url);
      const path = page && /^\/matches\/\d+\/(.+)-pgl-major-singapore-2026-stage-\d\/?$/.exec(page.pathname);
      if (!page || page.origin !== sourceSetting('PM_HLTV_URL') || page.username || page.password || !path)
        throw Error('需要对应的 PGL Singapore Major HLTV 比赛链接。');
      page.search = '';
      page.hash = '';
      const maps = args.maps?.map(map => map.trim());
      if (!maps || ![1, 3, 5].includes(maps.length) || maps.some(name => !/^[\w ]{1,30}$/.test(name)) ||
          new Set(maps.map(mapKey)).size !== maps.length) throw Error('需要已核对的完整地图顺序。');
      const state: Stream = { status: 'starting', matchUrl: page.href };
      streams.set(slug, state);
      try {
        const official = await host.read({ view: 'event', id: slug }, signal);
        const raw = (host.loadEvidence(official.evidenceId)?.data as { response?: GammaEvent } | undefined)?.response;
        if (official.status !== 'ok' || !raw) throw Error('Polymarket 官方赛事暂不可读取。');
        if (raw.slug !== slug || !raw.tags?.some(tag => tag.slug === 'pgl-major-singapore-2026'))
          throw Error('当前没有该赛事的已登记 CSTV 入口。');
        if (raw.ended || raw.closed) throw Error('Polymarket 已标记这场结束。');
        const series = raw.markets?.find(m => m.sportsMarketType === 'moneyline' && m.slug === slug && /^0x[\da-f]{64}$/i.test(m.conditionId ?? ''));
        const sides = series && JSON.parse(series.outcomes) as string[];
        const pageSides = path[1]!.split('-vs-').map(cs2TeamKey);
        if (!sides || sides.length !== 2 || pageSides.length !== 2 || !sides.every(team => pageSides.includes(cs2TeamKey(team))))
          throw Error('HLTV 对阵与 Polymarket 系列赛胜负盘无法对齐。');
        const phase = /^(\d+)\/(\d+)$/.exec(raw.period ?? '');
        const index = Number(phase?.[1]) - 1;
        if (raw.live !== true || !phase || Number(phase[2]) !== maps.length || !maps[index])
          throw Error('Polymarket 暂无可核对的当前图序。');
        const prior = maps.slice(0, index).map((_, i) => {
          const map = raw.markets?.find(m => m.slug === slug + '-game' + (i + 1) && m.sportsMarketType === 'child_moneyline');
          if (!map?.closed) throw Error('此前地图的 Polymarket 赛果尚未确认。');
          const prices = JSON.parse(map.outcomePrices) as string[];
          const labels = JSON.parse(map.outcomes) as string[];
          const winner = prices.length === 2 && labels.length === 2 && prices.map(Number).sort().join(',') === '0,1'
            ? sides.findIndex(team => cs2TeamKey(team) === cs2TeamKey(labels[prices.findIndex(value => Number(value) === 1)]!)) : -1;
          if (winner < 0) throw Error('此前地图没有可核对的胜方。');
          return winner + 1;
        });
        const results = await Promise.allSettled(feeds.map(relay => checkFeed(relay, maps[index]!, sides, signal)));
        signal.throwIfAborted();
        if (state.status === 'stopped') return reply(state);
        const matched = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
        if (matched.length !== 1) throw Error('官方 CSTV 当前没有唯一同时匹配双方队名和地图的流。');
        const { relay, teams } = matched[0]!;
        const telegram = process.env.PM_TELEGRAM_ENABLED === 'true';
        if (telegram && (!(process.env['telegram-token'] ?? process.env.TELEGRAM_BOT_TOKEN)
          || !(Number(process.env.TELEGRAM_USER_ID) > 0))) throw Error('Telegram 私聊还未配置。');
        const runner = fileURLToPath(new URL('../tools/cs2-live.mjs', import.meta.url));
        const child = spawn(process.execPath, [runner, page.href, relay, ...teams, maps.join(','), prior.join(',') || '-',
          '--pm-event=' + slug, ...(telegram ? ['--telegram'] : [])], { stdio: ['ignore', 'pipe', 'ignore'] });
        Object.assign(state, { child, relay, telegram });
        const lines = createInterface({ input: child.stdout! });
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => {
            state.reason = '逐回合进程未在启动窗口确认地图与双方比分。';
            state.status = 'failed';
            child.kill();
            resolve();
          }, 12000);
          const ready = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            resolve();
          };
          const abort = () => { child.kill(); ready(); };
          signal.addEventListener('abort', abort, { once: true });
          lines.on('line', line => {
            try {
              const event = JSON.parse(line);
              if (event.state === 'following' && event.detail?.polymarket?.[0]?.conditionId !== series?.conditionId?.toLowerCase()) {
                state.status = 'failed'; state.reason = '直播进程与 Polymarket 官方系列赛合约身份不一致。';
                child.kill();
                ready();
              }
              if (event.state === 'map_stream' && Array.isArray(event.detail?.score)) {
                state.currentMap = maps[event.detail.mapIndex];
                if (state.status === 'starting') {
                  state.status = 'streaming';
                  ready();
                }
              }
              if (event.state === 'following') state.kick = event.detail?.kick;
              if (event.state === 'round_observed' && event.detail?.source === 'kick') state.kickActive = true;
              if (['kick_gap', 'kick_unavailable'].includes(event.state)) state.kickActive = false;
              if (event.state === 'delivered' && Number.isSafeInteger(event.detail?.messageId)) state.lastMessageId = event.detail.messageId;
              if (event.state === 'done' && event.detail?.status === 'finished') state.status = 'finished';
            } catch { /* The runner writes JSON status records. */ }
          });
          child.once('error', error => { state.status = 'failed'; state.reason = error.message; ready(); });
          child.once('exit', code => {
            if (state.status === 'starting' || state.status === 'streaming') {
              state.status = code === 0 ? 'stopped' : 'failed';
              if (code !== 0) state.reason = '逐回合进程已退出。';
            }
            ready();
          });
        });
        signal.throwIfAborted();
        return reply(state);
      } catch (error) {
        if (state.status !== 'stopped') {
          state.status = 'failed';
          state.reason = error instanceof Error ? error.message : String(error);
        }
        signal.throwIfAborted();
        return reply(state);
      }
    },
  });
  return { tool, close: () => { for (const stream of streams.values()) stream.child?.kill(); } };
}
