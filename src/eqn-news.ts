import { sourceSetting } from './source-config.js';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { EvidenceRow } from './source-evidence.js';

type SaveEvidence = (source: string, data: unknown, retrievedAt: string) => EvidenceRow | Promise<EvidenceRow>;
type Row = Record<string, unknown>;
const base = sourceSetting('PM_EQN_URL') + '/public/v1';
const str = { type: 'string' } as const;
const asObject = (value: unknown): Row | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const date = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const iso = (value: number) => Number.isFinite(value) ? new Date(value).toISOString() : null;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const strValue = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
export const xEventTypes = ['original', 'reply', 'quote', 'repost', 'follow', 'unfollow', 'unknown'] as const;
type XEventType = typeof xEventTypes[number];
export const xChannels: Readonly<Record<string, string>> = { elonmusk: 'elon', cz_binance: 'cz', heyibinance: 'cz' };
export const xHandle = (value: unknown) => typeof value === 'string' && /^@?[a-z0-9_]{1,15}$/i.test(value)
  ? value.replace(/^@/, '').toLowerCase() : null;
const xId = (value: unknown) => typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
const boolean = (value: unknown) => typeof value === 'boolean' ? value : null;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function publicLink(value: unknown) {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  return url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
}

function postType(value: unknown): XEventType | null {
  switch (value) {
    case 'tweet': return 'original';
    case 'retweet': return 'repost';
    case 'reply': case 'quote': return value;
    default: return null;
  }
}

function xEvent(row: Row, sourceUrl: string | null) {
  const url = sourceUrl && URL.parse(sourceUrl);
  const path = url && /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(url.hostname) && !url.port ? url.pathname : '';
  const permalink = path.match(/^\/(i\/web|i|[a-z0-9_]{1,15})\/status\/(\d{1,20})(?:\/(?:photo|video)\/\d+)?\/?$/i);
  const urlActor = permalink && !['i', 'i/web'].includes(permalink[1]) ? xHandle(permalink[1]) : null;
  const profile = xHandle(path.match(/^\/([a-z0-9_]{1,15})\/?$/i)?.[1]);
  const source = strValue(row.source);
  const postLabel = source?.match(/^@?([a-z0-9_]{1,15}) \[(tweet|retweet|reply|quote)\]$/i);
  const relationshipLabel = source?.match(/^@?([a-z0-9_]{1,15}) X (Follow New|Unfollow)$/i);
  const detail = asObject(row.data);
  const change = detail?.change_type;
  const structuredRelationship = change === 'follow' || change === 'unfollow' ? change : null;
  const relationship = structuredRelationship ?? (relationshipLabel ?
    relationshipLabel[2].toLowerCase() === 'unfollow' ? 'unfollow' : 'follow' : null);
  const labelActor = xHandle(relationshipLabel?.[1] ?? postLabel?.[1]);
  const dataActor = xHandle(detail?.screen_name) ?? xHandle(detail?.user_screen_name);
  const dataPostId = xId(detail?.tweet_id);
  if (!relationship && !permalink && !dataPostId && !postLabel) return null;
  const actorHandle = dataActor ?? labelActor ?? urlActor;
  const conflictingIdentity = [dataActor, labelActor, urlActor].some(handle => handle && handle !== actorHandle) ||
    !!(dataPostId && permalink && dataPostId !== permalink[2]);
  const typedPost = postType(detail?.tweet_type);
  const eventType = conflictingIdentity ? 'unknown' : relationship ?? typedPost ??
    postType(postLabel?.[2].toLowerCase()) ?? 'unknown';
  const targetHandle = relationship ? xHandle(detail?.target_screen_name) ?? profile : null;
  const postId = relationship || conflictingIdentity ? null : dataPostId ?? permalink?.[2] ?? null;
  const changeCreatedAt = relationship ? null : iso(date(detail?.created_at));
  return {
    type: eventType,
    basis: conflictingIdentity ? 'identity_conflict' : structuredRelationship || typedPost ? 'eqn_detail' :
      relationshipLabel || postLabel ? 'eqn_source_label' : 'x_permalink',
    actor: { handle: conflictingIdentity ? null : actorHandle, userId: conflictingIdentity ? null : xId(detail?.user_id) },
    post: postId ? { id: postId, url: permalink ? sourceUrl : null, createdAt: changeCreatedAt,
      lang: strValue(detail?.tweet_lang), textTruncated: boolean(detail?.note_tweet_truncated),
      upstreamListId: xId(detail?.list_id), collectionMode: strValue(detail?.mode) } : null,
    target: relationship && !conflictingIdentity ? { handle: targetHandle, userId: xId(detail?.target_id),
      name: strValue(detail?.target_name), profileUrl: profile && profile === targetHandle ? sourceUrl : null } : null,
    relationship: relationship && !conflictingIdentity ? {
      followingBefore: boolean(asObject(detail?.before)?.following), followingAfter: boolean(asObject(detail?.after)?.following),
      actorFollowingCountBefore: integer(detail?.friends_before), actorFollowingCountAfter: integer(detail?.friends_after) } : null,
  };
}

function sourceKind(channels: string[], title: string, event: ReturnType<typeof xEvent>) {
  if (event?.target) return 'social_relationship';
  if (channels.some(channel => ['oi', 'pricechange', 'major', 'tfmoves'].includes(channel))) return 'market_signal';
  if (channels.some(channel => ['binance', 'korea', 'tier2', 'tier3', 'alpha', 'earn'].includes(channel))) {
    if (/\b(?:alpha|wallet)\b|币安\s*Alpha/i.test(title) && /\b(?:competition|campaign|rewards)\b|竞赛|瓜分/i.test(title)) return 'alpha_campaign';
    if (/\b(?:deposit|withdrawal)s?\b|充值|提现|充提/i.test(title)) return 'deposit_or_withdrawal_notice';
    if (/\bfunding rate\b|资金费率/i.test(title)) return 'funding_rate_notice';
    if (/\bspot\b|现货/i.test(title)) return 'spot_notice';
    if (/\balpha\b/i.test(title)) return 'alpha_notice';
    if (/\b(?:competition|campaign|promotion)\b|竞赛|瓜分|活动/i.test(title)) return 'campaign';
    return 'exchange_notice';
  }
  if (event || channels.some(channel => channel === 'elon' || channel === 'cz')) return 'social_post';
  return 'news';
}

function news(value: unknown) {
  const row = asObject(value);
  if (!row || typeof row.no !== 'number' || !Number.isSafeInteger(row.no) || row.no < 1 || !iso(date(row.time))) return null;
  const channels = strings(row.channels);
  const originalUrl = publicLink(row.source_url);
  const title = strValue(row.zh) ?? strValue(row.en);
  const titleEn = strValue(row.en);
  const archive = originalUrl?.startsWith(sourceSetting('PM_EQN_URL') + '/public/archive/') ?? false;
  const event = xEvent(row, originalUrl);
  const kind = sourceKind(channels, [title, titleEn].join(' '), event);
  return { no: row.no, publishedAt: iso(date(row.time))!, channels, coins: strings(row.coins),
    title, titleEn, sourceClaim: strValue(row.source), sourceKind: kind,
    sourceKindBasis: kind === 'social_relationship' || kind === 'social_post' ? event?.basis ?? 'eqn_channel' : 'eqn_channel_and_headline',
    eqnUrl: publicLink(row.url), originalUrl, originalUrlRole: archive ? 'eqn_archive' :
      originalUrl ? event?.target?.profileUrl ? 'x_event_target' : 'reported_source' : 'missing',
    verification: originalUrl ? 'source_link_unverified' : 'source_link_missing',
    ...(event ? { xEvent: event } : {}), ai: row.ai ?? null };
}

export type EqnNewsItem = NonNullable<ReturnType<typeof news>>;

function bound(value: string | undefined) {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !iso(date(value))) {
    throw Error('时间需使用含 UTC 或偏移量的 ISO 8601。');
  }
  return date(value);
}

class EqnError extends Error {
  constructor(readonly reason: string, readonly httpStatus?: number, readonly retryAfter?: string | null) { super(reason); }
}
type Receipt = { source: string; retrievedAt: string; httpStatus: number; etag: string | null };
const cursorPattern = /^\d{1,16}-\d{1,16}$/;

export function createEqnNewsTool(saveEvidence: SaveEvidence) {
  const cache = new Map<string, { etag: string; data: unknown }>();
  async function read(source: string, signal: AbortSignal) {
    const cached = cache.get(source);
    const deadline = AbortSignal.timeout(9_000);
    const requestSignal = AbortSignal.any([signal, deadline]);
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(source, { signal: requestSignal, redirect: 'error',
          headers: { Accept: 'application/json', ...(cached ? { 'If-None-Match': cached.etag } : {}) } });
        const receipt: Receipt = { source, retrievedAt: new Date().toISOString(), httpStatus: response.status, etag: response.headers.get('etag') };
        if (response.status === 304 && cached) return { data: cached.data, receipt: { ...receipt, etag: cached.etag } };
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after');
          await response.body?.cancel();
          if (response.status === 429) {
            const wait = retryAfter && (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Math.max(0, date(retryAfter) - Date.now()));
            if (attempt === 0 && typeof wait === 'number' && wait <= 4_000) {
              await delay(wait, undefined, { signal: requestSignal });
              continue;
            }
          }
          throw new EqnError(response.status === 429 ? 'rate_limited' : response.status === 404 ? 'not_found' : 'http_error',
            response.status, retryAfter);
        }
        const data: unknown = await response.json();
        if (receipt.etag) {
          cache.delete(source);
          if (cache.size >= 16) cache.delete(cache.keys().next().value!);
          cache.set(source, { etag: receipt.etag, data });
        }
        return { data, receipt };
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof EqnError) throw error;
      if (deadline.aborted) throw new EqnError('timeout');
      if (error instanceof SyntaxError) throw new EqnError('invalid_json');
      throw new EqnError((error as { cause?: { code?: string } }).cause?.code ?? 'network_failure');
    }
  }

  return defineTool({
    name: 'read_eqn_news',
    description: '读取 EquationNews 频道和快讯。list 可按币种、时间或 X 动态发起人、类型、目标账号和帖子 ID 筛选；get 按编号读详情、原帖时间及关注状态变化。返回公开快讯覆盖和游标。',
    parameters: {
      action: { ...str, enum: ['channels', 'list', 'get'], required: true },
      channel: str, coin: str, query: str, before: str, start: str, end: str,
      x_handle: { ...str, description: '做出动作或发帖的 X 账号，可带 @。' },
      x_event: { ...str, enum: xEventTypes },
      x_target_handle: { ...str, description: '关注或取消关注的目标账号，可带 @。' },
      x_post_id: { ...str, description: '字符串 X 帖子 ID。' },
      limit: { type: 'integer', description: '最多返回 1 至 50 条。' },
      page_limit: { type: 'integer', description: '单次最多读取 1 至 5 页。' },
      no: { type: 'integer' },
    },
    output: { schema: str, render: (_args, value) => [{ type: 'text', text: value }] }, timeoutMs: 52_000,
    async execute({ action, channel, coin, query, before, start, end, limit = 20, page_limit, no,
      x_handle, x_event, x_target_handle, x_post_id }, { signal }) {
      signal.throwIfAborted();
      if (action === 'get' && (no === undefined || !Number.isSafeInteger(no) || no < 1)) throw Error('get 需要正整数快讯编号。');
      if (limit < 1 || limit > 50 || page_limit !== undefined && (page_limit < 1 || page_limit > 5)) {
        throw Error('limit 支持 1 至 50，page_limit 支持 1 至 5。');
      }
      const startAt = bound(start), endAt = bound(end);
      if (startAt !== null && endAt !== null && startAt >= endAt) throw Error('start 必须早于 end。');
      if (before !== undefined && !cursorPattern.test(before)) throw Error('before 需要上次返回的 nextCursor。');
      const topic = query?.trim();
      if (query !== undefined && (!topic || topic.length > 300)) throw Error('query 需要 1 至 300 字符。');
      const actor = xHandle(x_handle?.trim());
      const target = xHandle(x_target_handle?.trim());
      const postId = xId(x_post_id);
      if ((x_handle !== undefined && !actor) || (x_target_handle !== undefined && !target) ||
          (x_post_id !== undefined && !postId)) throw Error('X 账号或字符串帖子 ID 格式无效。');
      const xFilter = !!(actor || target || postId || x_event);
      if (xFilter && action !== 'list') throw Error('X 动态筛选用于 list；get 按 EQN 编号读单条详情。');
      const filters = new URLSearchParams();
      const selectedChannel = channel?.trim().toLowerCase() || (actor && Object.hasOwn(xChannels, actor) ? xChannels[actor] : null);
      if (selectedChannel) filters.set('channel', selectedChannel);
      if (coin?.trim()) filters.set('coin', coin.trim().toUpperCase());
      if (topic) filters.set('query', topic);
      const reads: Receipt[] = [];
      let source = `${base}/${action === 'channels' ? 'channels' : action === 'get' ? `news/${no}` : 'news'}`;
      async function capture(url: string) {
        const { data, receipt } = await read(url, signal);
        reads.push(receipt);
        const result = asObject(data);
        if (!result) throw new EqnError('invalid_response');
        return result;
      }
      async function result(status: string, fields: object, retrievedAt = new Date().toISOString()) {
        signal.throwIfAborted();
        return JSON.stringify(await saveEvidence(source, { kind: 'eqn_news', action, status, reads, ...fields }, retrievedAt));
      }

      if (action !== 'list') {
        try {
          const row = await capture(source);
          const observedAt = reads[0].retrievedAt;
          if (action === 'channels') {
            if (!Array.isArray(row.channels) || !row.channels.every(item => strValue(asObject(item)?.key))) {
              throw new EqnError('channels_missing');
            }
            const channels = row.channels.map(item => {
              const entry = asObject(item)!;
              const monitoredXAccounts = Object.keys(xChannels).filter(handle => xChannels[handle] === entry.key);
              return monitoredXAccounts.length ? { ...entry, monitoredXAccounts } : entry;
            });
            return result(channels.length ? 'observed' : 'empty', { channels }, observedAt);
          }
          const item = news(row);
          if (!item || item.no !== no) throw new EqnError('news_identity_or_time_missing');
          return result('observed', { item, detail: row }, observedAt);
        } catch (error) {
          if (!(error instanceof EqnError)) throw error;
          return result('unavailable', { reason: error.reason, httpStatus: error.httpStatus ?? null, retryAfter: error.retryAfter ?? null });
        }
      }

      const budget = page_limit ?? (xFilter || startAt !== null || endAt !== null ? 3 : 1);
      const items = new Map<number, NonNullable<ReturnType<typeof news>>>();
      const seen = new Set<number>();
      const cursors = new Set(before ? [before] : []);
      let cursor = before ?? null;
      let oldest = Infinity, newest = -Infinity, pages = 0, invalidRows = 0, rawRows = 0;
      let unclassifiedXRows = 0;
      let outOfOrder = false;
      let stop: 'page_limit' | 'feed_exhausted' | 'start_reached' | 'result_limit' | 'upstream_failure' | 'cursor_invalid' = 'page_limit';
      let failure: { source: string; reason: string; httpStatus: number | null; retryAfter: string | null } | null = null;

      for (let i = 0; i < budget; i++) {
        const params = new URLSearchParams(filters);
        params.set('limit', String(xFilter ? 50 : limit - items.size));
        if (cursor) params.set('before', cursor);
        const url = `${base}/news?${params}`;
        if (i === 0) source = url;
        try {
          const page = await capture(url);
          if (!Array.isArray(page.items)) throw new EqnError('items_missing');
          pages++;
          rawRows += page.items.length;
          let pastWindow = false;
          let next = page.next_cursor;
          for (const [index, value] of page.items.entries()) {
            const row = news(value);
            if (!row) { invalidRows++; continue; }
            const timestamp = date(row.publishedAt);
            if (seen.has(row.no)) continue;
            seen.add(row.no);
            if (timestamp > oldest) outOfOrder = true;
            oldest = Math.min(oldest, timestamp);
            newest = Math.max(newest, timestamp);
            if (startAt !== null && timestamp < startAt) pastWindow = true;
            if (startAt !== null && timestamp < startAt || endAt !== null && timestamp >= endAt) continue;
            if (xFilter) {
              const event = row.xEvent;
              if (!event || actor && event.actor.handle !== actor || target && event.target?.handle !== target ||
                  postId && event.post?.id !== postId) continue;
              if (event.type === 'unknown') unclassifiedXRows++;
              if (x_event && event.type !== x_event) continue;
            }
            items.set(row.no, row);
            if (items.size === limit && index < page.items.length - 1) {
              // EQN cursors use the publication timestamp in milliseconds and the EQN number.
              next = `${timestamp}-${row.no}`;
              break;
            }
          }
          if (next !== null && (typeof next !== 'string' || !cursorPattern.test(next) || cursors.has(next))) {
            cursor = null;
            stop = 'cursor_invalid';
            break;
          }
          cursor = next;
          if (!cursor) { stop = 'feed_exhausted'; break; }
          cursors.add(cursor);
          if (pastWindow && !outOfOrder) { stop = 'start_reached'; break; }
          if (items.size >= limit) { stop = 'result_limit'; break; }
        } catch (error) {
          if (!(error instanceof EqnError)) throw error;
          failure = { source: url, reason: error.reason, httpStatus: error.httpStatus ?? null, retryAfter: error.retryAfter ?? null };
          stop = 'upstream_failure';
          break;
        }
      }
      const ended = stop === 'feed_exhausted' || stop === 'start_reached';
      const requestedWindow = startAt !== null || endAt !== null;
      const now = Date.now();
      const beforeCutsWindow = !!before && (endAt === null || Number(before.split('-')[0]) < endAt);
      const future = endAt !== null && endAt > now;
      const keywordIndexCutsWindow = !!topic && (startAt === null || startAt < now - 30 * 86_400_000);
      const eventTypeGaps = !!x_event && x_event !== 'unknown' && unclassifiedXRows > 0;
      const completeWindow = requestedWindow && ended && !beforeCutsWindow && !future && !invalidRows && !outOfOrder &&
        !keywordIndexCutsWindow && !eventTypeGaps;
      const status = !pages && failure ? 'unavailable' : !ended || invalidRows || outOfOrder || eventTypeGaps || requestedWindow && !completeWindow ? 'partial'
        : items.size ? 'observed' : requestedWindow ? 'empty_window' : 'empty_feed';
      return result(status, {
        filters: { channel: filters.get('channel'), coin: filters.get('coin'), query: topic ?? null,
          xHandle: actor, xEvent: x_event ?? null, xTargetHandle: target, xPostId: postId,
          start: startAt === null ? null : iso(startAt), endExclusive: endAt === null ? null : iso(endAt), before: before ?? null, limit, pageLimit: budget },
        items: [...items.values()], pages, rawRows, invalidRows, stop, count: items.size,
        nextCursor: cursor, truncated: !ended, failure,
        coverage: { oldestScannedAt: iso(oldest), newestScannedAt: iso(newest), completeWindow, beforeCutsWindow, future, outOfOrder,
          coinFilterScope: filters.has('coin') ? 'eqn_tagged_coins' : null,
          keywordIndexDays: topic ? 30 : null, keywordIndexCutsWindow, unclassifiedXRows, eventTypeGaps,
          scope: 'eqn_filtered_feed' },
      });
    },
  });
}
