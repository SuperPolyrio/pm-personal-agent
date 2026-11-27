import { xChannels, xEventTypes, xHandle, type EqnNewsItem } from './eqn-news.js';
import type { Watch } from './store.js';

export const eqnWatchSource = 'eqn_news';
export const eqnWatchPrompt = '执行当前原生唤醒的 EQN 增量订阅检查。';
export const eqnWatchSchema = {
  type: 'object', additionalProperties: false,
  description: '订阅 EQN 已发布的 X 动态或新闻。至少指定频道、账号、币种、关键词或事件类型。首次从创建时刻开始，有新记录才通知。',
  properties: {
    channel: { type: 'string', description: 'EQN 频道 key。未给定时按已知账号选频道，否则查 all。' },
    handles: { type: 'array', items: { type: 'string' }, description: 'X 动作发起账号列表，可带 @。' },
    event_types: { type: 'array', items: { type: 'string', enum: xEventTypes } },
    target_handle: { type: 'string', description: '关注或取消关注的目标账号。' },
    coin: { type: 'string' }, query: { type: 'string', description: '匹配 EQN 快讯的中英文标题/正文摘要。' },
  },
} as const;

type EventType = typeof xEventTypes[number];
type Condition = {
  channel?: string; handles?: string[]; event_types?: EventType[]; target_handle?: string; coin?: string; query?: string;
};
const channels = new Set(['all', 'main', 'tradfi', 'binance', 'korea', 'pricechange', 'oi', 'major', 'tier2', 'tier3',
  'alpha', 'cz', 'elon', 'earn', 'hl', 'tfmoves']);

export function prepareEqnWatch(input: Condition) {
  const handles = [...new Set((input.handles ?? []).map(value => {
    const handle = xHandle(value.trim());
    if (!handle) throw Error('EQN 订阅账号格式无效。');
    return handle;
  }))].sort();
  if (handles.length > 10) throw Error('一个 EQN 订阅最多支持 10 个 X 账号。');
  const eventTypes = [...new Set(input.event_types ?? [])].sort();
  const targetHandle = xHandle(input.target_handle?.trim());
  if (input.target_handle !== undefined && !targetHandle) throw Error('关注目标账号格式无效。');
  if (targetHandle && eventTypes.some(type => type !== 'follow' && type !== 'unfollow')) {
    throw Error('关注目标只适用于新关注或取消关注。');
  }
  const coin = input.coin?.trim().toUpperCase() || undefined;
  const query = input.query?.trim() || undefined;
  const requestedChannel = input.channel?.trim().toLowerCase();
  if ((coin?.length ?? 0) > 32 || (query?.length ?? 0) > 300) throw Error('币种或关键词过长。');
  if (!requestedChannel && !handles.length && !eventTypes.length && !targetHandle && !coin && !query) {
    throw Error('EQN 订阅至少需要频道、账号、事件类型、关注目标、币种或关键词。');
  }
  const specific = handles.length && handles.every(handle => Object.hasOwn(xChannels, handle) && xChannels[handle] === xChannels[handles[0]]);
  const channel = requestedChannel || (specific ? xChannels[handles[0]] : 'all');
  if (!channels.has(channel)) throw Error('未知 EQN 频道，先用 read_eqn_news 查看频道。');
  return { kind: 'eqn' as const, channel, handles, eventTypes, targetHandle, coin, query };
}

export type EqnWatch = ReturnType<typeof prepareEqnWatch> & { since: string };

export function eqnWatchPlan(watch: Watch) {
  if (watch.market_id !== null) return;
  const config = JSON.parse(watch.notify_when);
  return config?.kind === 'eqn' ? config as EqnWatch : undefined;
}

export type EqnWatchState = { through: string; end?: string; before?: string };
export type EqnWatchPage = { evidenceId: string; data: {
  items?: EqnNewsItem[]; stop?: string; nextCursor?: string | null; invalidRows?: number; failure?: { reason: string } | null;
  coverage?: { outOfOrder?: boolean };
} };

export async function scanEqnWatch(config: EqnWatch, previous: EqnWatchState, checkedAt: string,
  read: (params: { channel: string; coin?: string; start: string; end: string; before?: string }) => Promise<EqnWatchPage>) {
  const end = previous.end ?? checkedAt;
  // Recheck a short overlap for late visibility. The original subscription time remains the lower bound.
  const start = new Date(Math.max(Date.parse(config.since), Date.parse(previous.through) - 120_000)).toISOString();
  const state: EqnWatchState = { ...previous, end };
  const matches: { item: EqnNewsItem; evidenceId: string }[] = [];
  const evidenceIds: string[] = [];
  let reason: string | undefined, unclassified = 0;
  const complete = () => ({ state: { through: end }, matches, evidenceIds, unclassified,
    status: unclassified ? 'partial' as const : 'complete' as const, reason: unclassified ? 'eqn_event_type_unknown' : undefined });
  if (start >= end) return complete();
  for (let page = 0; page < 5; page++) {
    const response = await read({ channel: config.channel, coin: config.coin, start, end, before: state.before });
    const receipt = response.data;
    evidenceIds.push(response.evidenceId);
    if (receipt.failure || !receipt.items || receipt.invalidRows || receipt.coverage?.outOfOrder || receipt.stop === 'cursor_invalid') {
      reason = receipt.failure?.reason ?? 'eqn_invalid_page_or_cursor';
      break;
    }
    const ended = receipt.stop === 'feed_exhausted' || receipt.stop === 'start_reached';
    if (!ended && (!receipt.nextCursor || receipt.nextCursor === state.before)) {
      reason = 'eqn_cursor_missing_or_repeated';
      break;
    }
    for (const item of receipt.items) {
      const event = item.xEvent;
      if (config.handles.length && (!event?.actor.handle || !config.handles.includes(event.actor.handle))) continue;
      if (config.targetHandle && config.targetHandle !== event?.target?.handle) continue;
      if (config.query && ![item.title, item.titleEn].some(title => title?.toLowerCase().includes(config.query!.toLowerCase()))) continue;
      if (config.eventTypes.length) {
        const type = event?.type;
        if (!type || !config.eventTypes.includes(type)) {
          if (type === 'unknown') unclassified++;
          continue;
        }
      }
      matches.push({ item, evidenceId: response.evidenceId });
    }
    if (ended) return complete();
    state.before = receipt.nextCursor!;
  }
  return { state, matches, evidenceIds, unclassified,
    status: reason && !matches.length && state.before === previous.before ? 'failed' as const : 'partial' as const,
    reason: reason ?? 'eqn_page_budget' };
}

const eventLabels: Record<EventType, string> = {
  original: '原创', reply: '回复', quote: '引用', repost: '转发', follow: '新关注', unfollow: '取消关注', unknown: '动态',
};

export function eqnWatchNotice(watch: Watch, item: EqnNewsItem, evidenceId: string) {
  const event = item.xEvent;
  const actor = event?.actor.handle ? `@${event.actor.handle}` : item.sourceClaim;
  const at = new Date(item.publishedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const title = item.title?.slice(0, 600).replace(/[\uD800-\uDBFF]$/, '');
  return [`EQN 新动态 · ${watch.goal}`, [actor, event && eventLabels[event.type]].filter(Boolean).join(' '), title,
    `EQN 发布时间 ${at}（北京时间）`, item.eqnUrl && `快讯 #${item.no} ${item.eqnUrl}`,
    event?.target?.profileUrl ? `目标账号 ${event.target.profileUrl}` : item.originalUrl && `来源 ${item.originalUrl}`,
    `证据 ${evidenceId}`].filter(Boolean).join('\n');
}
