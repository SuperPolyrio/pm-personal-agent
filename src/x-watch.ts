import { xHandle } from './eqn-news.js';
import type { Watch } from './store.js';

export const xWatchPrompt = '执行当前原生唤醒的 X 新帖或 XTracker 计数检查。';
const text = { type: 'string' } as const;
export const xWatchSchema = {
  type: 'object', additionalProperties: false,
  description: '订阅 X 公开账号新帖 timeline，或指定合约的 XTracker 计数变化 count。',
  properties: {
    mode: { ...text, required: true, enum: ['timeline', 'count'] },
    handle: { ...text, required: true },
    start: text, end: text, market_url: text, target: { type: 'integer' },
  },
} as const;

type Input = { mode: 'timeline' | 'count'; handle: string; start?: string; end?: string; market_url?: string; target?: number };
const explicitTime = (value?: string) => value && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));

export function prepareXWatch(input: Input) {
  const handle = xHandle(input.handle.trim());
  if (!handle) throw Error('需要有效 X 账号。');
  if (input.mode === 'timeline') {
    if (input.start || input.end || input.market_url || input.target !== undefined) throw Error('X 新帖只需账号。');
    return { kind: 'x_timeline' as const, handle };
  }
  const market = URL.parse(input.market_url ?? '');
  if (market?.protocol !== 'https:' || !['polymarket.com', 'www.polymarket.com'].includes(market.hostname) ||
      market.username || market.password || market.port || !/^\/event\/[a-z\d-]+(?:\/[a-z\d-]+)?\/?$/.test(market.pathname)) {
    throw Error('XTracker 订阅需要明确的 Polymarket 事件或市场链接。');
  }
  if (!explicitTime(input.start) || !explicitTime(input.end) || Date.parse(input.start!) >= Date.parse(input.end!)) {
    throw Error('XTracker 订阅需要规则指定的开始与截止时间，使用带时区的 ISO 8601。');
  }
  if (input.target !== undefined && (!Number.isSafeInteger(input.target) || input.target < 0)) throw Error('目标条数须为非负整数。');
  return { kind: 'x_tracker' as const, handle, start: new Date(input.start!).toISOString(),
    end: new Date(input.end!).toISOString(), marketUrl: market.origin + market.pathname.replace(/\/$/, ''), target: input.target };
}

export type XWatch = ReturnType<typeof prepareXWatch> & { since: string };
export function xWatchPlan(watch: Watch): XWatch | undefined {
  if (watch.market_id !== null) return;
  const config = JSON.parse(watch.notify_when);
  if (config?.kind === 'x_timeline' || config?.kind === 'x_tracker') return config;
}
export function xWatchTool(config: XWatch) {
  return config.kind === 'x_timeline' ? 'read_x_posts' : 'read_xtracker_count';
}
export function xWatchArguments(config: XWatch) {
  return config.kind === 'x_timeline' ? { action: 'timeline', handle: config.handle, limit: 20 } :
    { action: 'count', handle: config.handle, start: config.start, end: config.end, market_url: config.marketUrl };
}

type Post = { postId: string; createdAt: string | null; url: string; authorText: string | null; sourceText?: string | null; author: { handle: string | null } };
export type XWatchReceipt = { evidenceId: string; data: {
  status: string; reason?: string; posts?: Post[]; count?: number; trackingId?: string; countRetrievedAt?: string;
  marketLinkCheck?: string;
  coverage?: { limitReached?: boolean };
} };
export type XWatchState = { trackingId?: string; count?: number; observedAt?: string; recentIds?: string[]; latestPost?: { postId: string; createdAt: string; url: string }; sampleSize?: number };
const beijing = (time: string) => new Date(time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
type Change = { key: string; body: string };
type Observation = { status: 'complete' | 'partial' | 'failed'; state?: XWatchState; changes: Change[]; reason?: string };

export function observeXWatch(config: XWatch, previous: XWatchState | undefined, receipt: XWatchReceipt, label: string): Observation {
  const data = receipt.data;
  if (data.status !== 'observed') {
    return { status: data.status === 'empty_sample' ? 'partial' : 'failed',
      reason: data.reason ?? data.status, changes: [] };
  }
  if (config.kind === 'x_tracker') {
    const { count, trackingId, countRetrievedAt: observedAt } = data;
    if (data.marketLinkCheck !== 'matched') return { status: 'partial', reason: 'xtracker_market_link_unconfirmed', changes: [] };
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || !trackingId || !observedAt || !Number.isFinite(Date.parse(observedAt))) {
      return { status: 'failed', reason: 'xtracker_count_receipt_incomplete', changes: [] };
    }
    if (previous?.trackingId && previous.trackingId !== trackingId) {
      return { status: 'partial', reason: 'xtracker_tracking_identity_changed', changes: [] };
    }
    const prior = previous?.count;
    const delta = prior === undefined ? 0 : count - prior;
    const changes = delta ? [{ key: `xtracker:${trackingId}:${observedAt}:${count}`, body: [
      `XTracker 计数变化 · ${label}`, `${prior} → ${count} 条（${delta > 0 ? '+' : ''}${delta}）`,
      config.target === undefined ? null : `距 ${config.target} 条还差 ${Math.max(0, config.target - count)} 条`,
      `观测时间 ${beijing(observedAt)}（北京时间）`, config.marketUrl,
    ].filter(Boolean).join('\n') }] : [];
    return { status: 'complete', state: { trackingId, count, observedAt }, changes };
  }
  const posts = (data.posts ?? []).filter((post): post is Post & { createdAt: string } =>
    !!post.createdAt && Number.isFinite(Date.parse(post.createdAt)) && post.author.handle?.toLowerCase() === config.handle && /^\d{1,20}$/.test(post.postId));
  if (!posts.length) return { status: 'partial', reason: 'x_timeline_missing_dated_posts', changes: [] };
  const latest = posts[0];
  const recentIds = posts.slice(0, 5).map(post => post.postId);
  const state = { recentIds, latestPost: { postId: latest.postId, createdAt: latest.createdAt, url: latest.url }, sampleSize: posts.length };
  const overlap = previous?.recentIds?.some(id => posts.some(post => post.postId === id));
  const gap = data.coverage?.limitReached && (previous?.recentIds?.length ? !overlap : posts.at(-1)!.createdAt > config.since);
  const changes = posts.slice().reverse().filter(post => post.createdAt >= config.since && !previous?.recentIds?.includes(post.postId))
    .map(post => ({ key: `x-post:${post.postId}`, body: [
      `X 新动态 · @${config.handle}`, (post.authorText ?? post.sourceText)?.slice(0, 600).replace(/[\uD800-\uDBFF]$/, ''),
      `发帖时间 ${beijing(post.createdAt)}（北京时间）`, post.url,
    ].filter(Boolean).join('\n') }));
  return { status: gap ? 'partial' : 'complete', reason: gap ? 'x_timeline_bounded_sample_gap' : undefined, state, changes };
}
