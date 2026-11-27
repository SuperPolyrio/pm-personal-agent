import { sourceSetting } from './source-config.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { EvidenceRow } from './source-evidence.js';

type SaveEvidence = (source: string, data: unknown, retrievedAt: string) => EvidenceRow | Promise<EvidenceRow>;
type Source = 'x_reader' | 'opencli';
type PostKind = 'original' | 'reply' | 'quote' | 'repost' | 'unknown';
type Row = Record<string, unknown>;
const reader = sourceSetting('PM_X_READER_PATH') || join(homedir(), 'develop/x2api/tools/x_reader.py');
const runFile = promisify(execFile);
const str = { type: 'string' } as const;
const output = { schema: str, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const object = (v: unknown): Row | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : undefined;
const id = (v: unknown) => typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null;
const handleOf = (v: unknown) => typeof v === 'string' && /^[\w]{1,15}$/.test(v) && v !== 'unknown' ? v : null;
const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const link = (postId: string, handle: string | null) => `${sourceSetting('PM_X_WEB_URL')}/${handle ?? 'i/web'}/status/${postId}`;

function postTarget(value: string | undefined) {
  const direct = id(value);
  if (direct) return { postId: direct, linkHandle: null };
  const url = value && URL.parse(value);
  const parts = url && !url.username && !url.password && !url.port && url.protocol === 'https:' &&
    /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/.test(url.hostname) &&
    url.pathname.match(/^\/(i\/web|[\w]{1,15})\/status\/(\d{1,20})(?:\/(?:photo|video)\/\d+)?\/?$/);
  if (!parts) throw Error('post 需要 X 帖子 ID 或 HTTPS 原帖链接。');
  return { postId: parts[2], linkHandle: handleOf(parts[1] === 'i' || parts[1] === 'i/web' ? null : parts[1]) };
}

function timeArg(value: string | undefined) {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !iso(value)) {
    throw Error('时间需使用含 UTC 或偏移量的 ISO 8601。');
  }
  return iso(value);
}

function normalize(value: unknown, source: Source) {
  const row = object(value);
  const postId = id(row?.id);
  if (!row || !postId) return null;
  const handle = handleOf(row.author);
  const replyToPostId = id(row.in_reply_to);
  const quote = object(row.quoted_tweet);
  const quoteId = id(quote?.id);
  const quoteAuthor = handleOf(quote?.author);
  const kind: PostKind = row.is_retweet === true || row.type === 'repost' ? 'repost' :
    replyToPostId || row.type === 'reply' ? 'reply' : quoteId || row.type === 'quote' ? 'quote' :
    row.type === 'original' ? 'original' : 'unknown';
  const body = typeof row.text === 'string' ? row.text : null;
  const unattributed = kind === 'repost' || (kind === 'unknown' && /^RT @[\w]+:/.test(body ?? ''));
  return {
    source, postId, url: link(postId, handle),
    author: { handle, userId: id(row.author_id), displayName: typeof row.name === 'string' ? row.name : null,
      avatarUrl: typeof row.author_avatar === 'string' ? row.author_avatar : null,
      identityBasis: source === 'x_reader' ? 'timeline_account_lookup' : 'post_author' },
    createdAt: iso(row.created_at), createdAtRaw: typeof row.created_at === 'string' ? row.created_at : null,
    kind, replyToPostId,
    authorText: unattributed ? null : body,
    authorTextBasis: body === null || unattributed ? 'missing' :
      kind === 'unknown' || source === 'x_reader' ? 'source_text_authorship_unconfirmed' : 'post_body',
    ...(unattributed ? { sourceText: body } : {}),
    quote: quoteId ? { postId: quoteId, url: link(quoteId, quoteAuthor), author: quoteAuthor, createdAt: iso(quote?.created_at),
      text: typeof quote?.text === 'string' ? quote.text : null,
      textCoverage: typeof quote?.text !== 'string' ? 'missing' : source === 'x_reader' ? 'excerpt' : 'as_provided' } : null,
  };
}

function diagnosis(log: string) {
  const http = log.match(/\bHTTP[ _-]*(\d{3})\b/i)?.[1];
  if (http) return `upstream_http_${http}`;
  if (/Browser Bridge|extension not connected|no browser profile/i.test(log)) return 'browser_bridge_unavailable';
  if (/auth_token\/ct0 not found|not logged|AuthRequired|login wall/i.test(log)) return 'x_authorization_unavailable';
  if (/lookup failed/i.test(log)) return 'account_lookup_failed';
  if (/FileNotFoundError/i.test(log)) return 'reader_configuration_missing';
  if (/timed out|timeout/i.test(log)) return 'timeout';
  if (/connection reset/i.test(log)) return 'network_connection_reset';
  if (/failed after retries|URLError/i.test(log)) return 'upstream_network_failure';
  if (/no recent tweets/i.test(log)) return 'no_recent_tweets_reported';
  return null;
}

async function timeline(handle: string, limit: number, signal: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), 'pm-x-posts-'));
  try {
    const outputPath = join(dir, 'timeline.json');
    const { stdout, stderr } = await runFile('python3', [reader, handle, '--limit', String(limit), '--json', outputPath],
      { signal, timeout: 70_000, maxBuffer: 2_000_000 });
    const reason = diagnosis(stderr) ?? (/lookup failed/.test(stdout) ? 'account_lookup_failed' : null);
    if (reason) throw Error(reason);
    const file = await readFile(outputPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw Error('requested_account_missing_from_reader_output');
      throw error;
    });
    const data = object(JSON.parse(file));
    if (!Array.isArray(data?.[handle])) throw Error('requested_account_missing_from_reader_output');
    return data[handle] as unknown[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function opencli(command: 'thread' | 'search' | 'tweets', target: string, limit: number, signal: AbortSignal) {
  const { stdout } = await runFile('opencli', ['twitter', command, '--format', 'json', '--limit', String(limit),
    ...(command === 'search' ? ['--product', 'live'] : []), '--', target],
  { signal, timeout: 35_000, maxBuffer: 4_000_000,
    env: { ...process.env, OPENCLI_BROWSER_CONNECT_TIMEOUT: process.env.OPENCLI_BROWSER_CONNECT_TIMEOUT ?? '8' } });
  const result: unknown = JSON.parse(stdout);
  if (Array.isArray(result)) return result;
  const envelope = object(result);
  if (envelope?.ok === true && Array.isArray(envelope.data)) return envelope.data as unknown[];
  throw Error(diagnosis(JSON.stringify(envelope?.error ?? '')) ?? 'invalid_opencli_response');
}

const reasons = new Set(['requested_account_missing_from_reader_output', 'invalid_opencli_response', 'account_lookup_failed',
  'browser_bridge_unavailable', 'x_authorization_unavailable', 'reader_configuration_missing',
  'upstream_network_failure', 'network_connection_reset', 'timeout', 'no_recent_tweets_reported']);

export function createXPostsTool(saveEvidence: SaveEvidence) {
  return defineTool({
    name: 'read_x_posts',
    description: '只读 X 公开账号近期时间线、指定帖及关键词检索。返回来源、实际样本和覆盖缺口。Grok 引用请用原帖 ID 回查。',
    parameters: {
      action: { ...str, enum: ['timeline', 'post', 'search'], required: true },
      handle: { ...str, description: '公开账号，可带 @。post 中仅用于近期时间线补查。' },
      post: { ...str, description: '帖子字符串 ID 或 HTTPS 原帖链接。' },
      query: str, start: str, end: str, limit: { type: 'integer', description: '1 至 50。' },
    },
    output, timeoutMs: 115_000, isConcurrencySafe: () => false,
    async execute({ action, handle: handleArg, post, query, start, end, limit: limitArg }, exec) {
      const signal = exec.signal;
      signal.throwIfAborted();
      const handle = handleArg === undefined ? null : handleOf(handleArg.trim().replace(/^@/, ''));
      if (handleArg !== undefined && !handle) throw Error('handle 须为有效的 X 账号。');
      const from = timeArg(start);
      const to = timeArg(end);
      if (from && to && from >= to) throw Error('start 必须早于 end。');
      if (action === 'timeline' && !handle) throw Error('timeline 需要 handle。');
      const target = action === 'post' ? postTarget(post) : null;
      if (action === 'search' && (!query?.trim() || query.length > 500)) throw Error('search 需要 1 至 500 字符的 query。');
      const limit = limitArg ?? (target ? 50 : 15);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('limit 须为 1 至 50 的整数。');
      const readerLimit = Math.min(limit, 20);
      // Date operators are whole days on X. Query a wider day range and then apply exact UTC bounds below.
      const upstreamQuery = action === 'search' ? [
        query!.trim(), handle && `from:${handle}`,
        from && `since:${new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10)}`,
        to && `until:${new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10)}`,
      ].filter(Boolean).join(' ') : null;
      const attempts: { source: Source; operation: string; limit: number; status: string; returned?: number; reason?: string }[] = [];
      async function read(source: Source, operation: string, cap: number, run: () => Promise<unknown[]>) {
        try {
          const rows = await run();
          signal.throwIfAborted();
          attempts.push({ source, operation, limit: cap, status: rows.length ? 'ok' : 'empty', returned: rows.length });
          return rows;
        } catch (error) {
          signal.throwIfAborted();
          const e = error as { code?: string; killed?: boolean; message?: string; stderr?: string; stdout?: string };
          const reason = diagnosis(e.stderr ?? '') ?? (/^\s*\{/.test(e.stdout ?? '') ? diagnosis(e.stdout!) : null) ??
            (e.killed ? 'timeout' : e.code === 'ENOENT' ? (source === 'opencli' ? 'opencli_not_installed' : 'python3_not_installed') :
              e instanceof SyntaxError ? 'invalid_json' : e.message && reasons.has(e.message) ? e.message : diagnosis(e.message ?? '') ?? 'command_failed');
          attempts.push({ source, operation, limit: cap, status: 'failed', reason });
          return null;
        }
      }

      let source: Source = action === 'timeline' ? 'x_reader' : 'opencli';
      let rows: unknown[] | null;
      if (action === 'timeline') {
        rows = await read('x_reader', 'timeline', readerLimit, () => timeline(handle!, readerLimit, signal));
        if (!rows || readerLimit < limit) {
          const extra = await read('opencli', 'tweets', limit, () => opencli('tweets', handle!, limit, signal));
          if (extra?.length || (!rows && extra)) { rows = extra; source = 'opencli'; }
        }
      } else if (target) {
        rows = await read('opencli', 'thread', limit, () => opencli('thread', target.postId, limit, signal));
        const knownHandle = handle ?? target.linkHandle;
        if (!rows?.some(row => object(row)?.id === target.postId) && knownHandle) {
          const extra = await read('x_reader', 'timeline', readerLimit, () => timeline(knownHandle, readerLimit, signal));
          if (extra?.some(row => object(row)?.id === target.postId) || (!rows && extra)) { rows = extra; source = 'x_reader'; }
        }
      } else {
        rows = await read('opencli', 'search', limit, () => opencli('search', upstreamQuery!, limit, signal));
      }
      const sample = [...new Map((rows ?? []).map(row => normalize(row, source)).filter(p => p !== null)
        .map(p => [p.postId, p])).values()];
      const dates = sample.flatMap(p => p.createdAt ? [p.createdAt] : []).sort();
      const posts = sample.filter(p => target ? p.postId === target.postId :
        (!handle || p.author.handle?.toLowerCase() === handle.toLowerCase()) &&
        (!from || p.createdAt && p.createdAt >= from) && (!to || p.createdAt && p.createdAt < to))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, limit);
      const retrievedAt = new Date().toISOString();
      const status = posts.length ? 'observed' : !rows ? 'unavailable' : target ? 'target_not_observed' :
        !rows.length ? 'empty_sample' : !sample.length ? 'unusable_sample' : 'no_matches_in_sample';
      const sourceUrl = target ? link(target.postId, posts[0]?.author.handle ?? target.linkHandle) :
        action === 'timeline' ? `${sourceSetting('PM_X_WEB_URL')}/${handle}` : `${sourceSetting('PM_X_WEB_URL')}/search?q=${encodeURIComponent(upstreamQuery!)}&f=live`;
      signal.throwIfAborted();
      return JSON.stringify(await saveEvidence(sourceUrl, {
        kind: 'x_posts', action, status, source: rows ? source : null, posts, attempts,
        requested: { handle, postId: target?.postId ?? null, query: query ?? null, upstreamQuery, start: from, endExclusive: to, limit },
        coverage: { scope: !rows ? 'unavailable' : target && posts.length && source === 'opencli' ? 'target_detail' :
          source === 'x_reader' || action === 'timeline' ? 'recent_timeline_sample' : action === 'search' ? 'search_sample' : 'thread_sample',
        completeWindow: false, oldestObservedAt: dates[0] ?? null, newestObservedAt: dates.at(-1) ?? null,
        rawRows: rows?.length ?? 0, usableRows: sample.length,
        limitReached: !!rows && rows.length >= (source === 'x_reader' ? readerLimit : limit),
        timelineApiCount: source === 'x_reader' && rows ? 20 : null },
      }, retrievedAt));
    },
  });
}
