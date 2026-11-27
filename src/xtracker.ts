import { sourceSetting } from './source-config.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { EvidenceRow } from './source-evidence.js';

type Host = {
  saveEvidence: (source: string, data: unknown, retrievedAt: string) => EvidenceRow | Promise<EvidenceRow>;
  loadEvidence?: (id: string, signal: AbortSignal) => EvidenceRow | undefined | Promise<EvidenceRow | undefined>;
};
type Row = Record<string, unknown>;
const base = sourceSetting('PM_XTRACKER_URL') + '/api';
const timezone = 'America/New_York';
const eastern = new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});
const str = { type: 'string' } as const;
const object = (v: unknown): Row | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : undefined;
const text = (v: unknown) => typeof v === 'string' && v ? v : null;
const time = (v: unknown) => typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN;
const utc = (t: number) => Number.isFinite(t) ? new Date(t).toISOString() : null;
const postId = (v: unknown) => typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null;

function eventSlug(value: unknown) {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['polymarket.com', 'www.polymarket.com'].includes(url.hostname)) return null;
  return url.pathname.match(/^\/event\/([a-z0-9-]+)(?:\/[a-z0-9-]+)?\/?$/)?.[1] ?? null;
}

function tracking(value: unknown) {
  const row = object(value);
  return { id: text(row?.id), title: text(row?.title), startDate: text(row?.startDate), endDate: text(row?.endDate),
    marketLink: text(row?.marketLink), isActive: typeof row?.isActive === 'boolean' ? row.isActive : null };
}

class TrackerReadError extends Error {
  constructor(readonly status: string, readonly reason: string) { super(reason); }
}

async function readTracker(url: string, signal: AbortSignal) {
  const deadline = AbortSignal.timeout(12_000);
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, deadline]),
      headers: { accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TrackerReadError(response.status === 404 ? 'not_found' : 'upstream_error', `http_${response.status}`);
    }
    const payload = object(await response.json());
    if (payload?.success !== true || payload.data === undefined) throw new TrackerReadError('invalid_response', 'invalid_xtracker_envelope');
    return { data: payload.data, retrievedAt: new Date().toISOString() };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TrackerReadError) throw error;
    if (deadline.aborted) throw new TrackerReadError('timeout', 'xtracker_request_timeout');
    if (error instanceof SyntaxError) throw new TrackerReadError('invalid_response', 'invalid_json');
    const code = (error as { cause?: { code?: string } }).cause?.code;
    throw new TrackerReadError('upstream_error', code ?? 'network_failure');
  }
}

export function createXTrackerTool({ saveEvidence, loadEvidence }: Host) {
  return defineTool({
    name: 'read_xtracker_count',
    description: '按规则账号和 UTC/带偏移量的窗口读取 XTracker Post Counter。posts 读取匹配窗口内已观测记录，可按帖子 ID 核对。附 market_url 或 market_evidence_id 以核对事件身份和最后可计秒。',
    parameters: {
      action: { ...str, enum: ['count', 'posts'] },
      handle: { ...str, required: true }, start: { ...str, required: true }, end: { ...str, required: true },
      market_url: str, market_evidence_id: str, post_id: str,
    },
    output: { schema: str, render: (_args, value) => [{ type: 'text', text: value }] }, timeoutMs: 40_000,
    async execute({ action = 'count', handle: handleArg, start, end, market_url, market_evidence_id, post_id }, { signal }) {
      signal.throwIfAborted();
      const handle = handleArg.trim().replace(/^@/, '').toLowerCase();
      if (!/^[\w]{1,15}$/.test(handle)) throw Error('handle 须为有效的 X 账号。');
      const begin = time(start), finish = time(end);
      if (!Number.isFinite(begin) || !Number.isFinite(finish) || begin >= finish) {
        throw Error('start 和 end 须为包含时区的 ISO 8601，且 start 早于 end。');
      }
      if (post_id !== undefined && (action !== 'posts' || !postId(post_id))) throw Error('post_id 仅用于 posts，须为字符串帖子 ID。');
      let marketEvent = eventSlug(market_url);
      if (market_url !== undefined && !marketEvent) throw Error('market_url 须为 Polymarket 事件或档位链接。');
      if (market_evidence_id) {
        const row = await loadEvidence?.(market_evidence_id, signal);
        const evidence = object(row?.data);
        const slug = text(evidence?.eventSlug);
        if (row?.source !== 'market-data/research/resolve' || evidence?.status !== 'found' || !slug || !/^[a-z0-9-]+$/.test(slug)) {
          throw Error('market_evidence_id 须指向可回读且含 eventSlug 的单市场解析证据。');
        }
        if (marketEvent && marketEvent !== slug) throw Error('market_url 和 market_evidence_id 所属事件不同。');
        marketEvent = slug;
      }

      const input = { action, handle, platform: 'X', ruleWindow: { start, end, startUtc: utc(begin), endUtc: utc(finish),
        timezone, startEastern: eastern.format(begin), endEastern: eastern.format(finish) },
      marketEvent, marketEvidenceId: market_evidence_id ?? null, requestedPostId: post_id ?? null };
      const userPath = `${base}/users/${handle}`;
      const listUrl = `${userPath}/trackings?platform=X&activeOnly=false`;
      let source = listUrl;
      const reads: { source: string; retrievedAt: string }[] = [];
      async function read(url: string) {
        source = url;
        const receipt = await readTracker(url, signal);
        reads.push({ source: url, retrievedAt: receipt.retrievedAt });
        return receipt;
      }
      async function result(status: string, fields: object = {}) {
        signal.throwIfAborted();
        return JSON.stringify(await saveEvidence(source, { kind: 'xtracker_observation', status, ...input, reads, ...fields },
          new Date().toISOString()));
      }

      let countSnapshot: object | undefined;
      try {
        const { data: list } = await read(listUrl);
        if (!Array.isArray(list)) return result('invalid_response', { reason: 'tracking_list_missing' });
        const candidates = list.map(tracking);
        const sameEvent = (t: ReturnType<typeof tracking>) => !!marketEvent && eventSlug(t.marketLink) === marketEvent;
        const sameWindow = (t: ReturnType<typeof tracking>) =>
          time(t.startDate) === begin && [finish, finish - 1_000].includes(time(t.endDate));
        const aligned = candidates.filter(sameWindow);
        const matching = aligned.filter(t => (!marketEvent || !t.marketLink || sameEvent(t)) &&
          (time(t.endDate) === finish || sameEvent(t)));
        if (matching.length > 1) return result('ambiguous_tracking', { candidates: matching });
        const chosen = matching[0];
        if (!chosen) {
          const relevant = candidates.filter(t => sameWindow(t) || sameEvent(t) || time(t.startDate) === begin);
          const reason = aligned.some(t => marketEvent && t.marketLink && !sameEvent(t)) ? 'market_mismatch' :
            aligned.length ? 'one_second_boundary_requires_matching_market_link' :
            relevant.some(t => !Number.isFinite(time(t.startDate)) || !Number.isFinite(time(t.endDate))) ? 'tracking_window_fields_missing' :
            'no_exact_window';
          return result('no_match', { reason, candidates: relevant, trackingCount: candidates.length });
        }
        if (!chosen.id || !/^[a-zA-Z0-9_-]{1,100}$/.test(chosen.id)) return result('invalid_response', { reason: 'tracking_id_missing', tracking: chosen });

        const detailUrl = `${base}/trackings/${chosen.id}?includeStats=true`;
        const detailRead = await read(detailUrl);
        const detail = object(detailRead.data);
        const profile = object(detail?.user);
        const confirmed = tracking(detail);
        if (!profile || !text(profile.handle) || !text(profile.platform)) {
          return result('invalid_response', { reason: 'tracking_account_fields_missing', tracking: confirmed });
        }
        if (confirmed.id !== chosen.id || text(profile.handle)?.toLowerCase() !== handle || profile.platform !== 'X') {
          return result('no_match', { reason: 'tracking_identity_mismatch', tracking: confirmed });
        }
        if (!sameWindow(confirmed) || time(confirmed.endDate) !== time(chosen.endDate) ||
            (marketEvent && confirmed.marketLink && !sameEvent(confirmed)) ||
            (time(confirmed.endDate) !== finish && !sameEvent(confirmed))) {
          return result('no_match', { reason: 'tracking_detail_window_or_event_mismatch', tracking: confirmed });
        }
        const stats = object(detail?.stats);
        const count = stats?.total;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
          return result('invalid_response', { reason: 'stats_total_missing', tracking: confirmed });
        }
        const trackerEnd = time(confirmed.endDate);
        countSnapshot = {
          tracking: confirmed, trackingId: chosen.id, count, stats,
          countSource: detailUrl, countRetrievedAt: detailRead.retrievedAt,
          account: { handle: text(profile.handle), platform: 'X', userId: postId(profile.platformId),
            avatarUrl: text(profile.avatarUrl), trackerLastSyncAt: text(profile.lastSync) },
          normalizedTrackingWindow: { startUtc: utc(begin), endUtc: utc(trackerEnd),
            endMinusRuleEndMs: trackerEnd - finish,
            boundary: trackerEnd === finish ? 'equal_as_reported' : 'last_inclusive_second_for_same_event' },
          marketLinkCheck: sameEvent(confirmed) ? 'matched' : marketEvent ? 'link_missing' : 'event_not_supplied',
        };
        if (action === 'count') return result('observed', countSnapshot);

        const query = new URLSearchParams({ platform: 'X', startDate: utc(begin)!, endDate: utc(trackerEnd)! });
        const postsRead = await read(`${userPath}/posts?${query}`);
        if (!Array.isArray(postsRead.data)) return result('partial', { ...countSnapshot, reason: 'post_records_missing' });
        const trackerUserId = text(detail?.userId) ?? text(profile.id);
        const rows = new Map<string, { postId: string; url: string; createdAt: string; importedAt: string | null; content: string | null }>();
        let discarded = 0;
        for (const value of postsRead.data) {
          const row = object(value);
          const id = postId(row?.platformId);
          const issued = time(row?.createdAt);
          if (!trackerUserId || row?.userId !== trackerUserId || !id || !Number.isFinite(issued) || issued < begin || issued > trackerEnd) {
            discarded++;
            continue;
          }
          rows.set(id, { postId: id, url: `${sourceSetting('PM_X_WEB_URL')}/${handle}/status/${id}`, createdAt: utc(issued)!,
            importedAt: text(row?.importedAt), content: text(row?.content) });
        }
        const postObservations = [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return result(discarded ? 'partial' : 'observed', {
          ...countSnapshot, posts: postObservations.filter(p => !post_id || p.postId === post_id),
          records: { retrievedAt: postsRead.retrievedAt, rawCount: postsRead.data.length, observedUniqueCount: rows.size,
            discarded, recordCountMinusCounter: rows.size - count, scope: 'account_records_in_tracking_window',
            targetObservation: post_id ? rows.has(post_id) ? 'observed_in_tracker_records' : 'not_observed_in_response' : null },
        });
      } catch (error) {
        if (!(error instanceof TrackerReadError)) throw error;
        const status = countSnapshot ? 'partial' : error.status === 'not_found' && source === listUrl ? 'no_match' : error.status;
        return result(status, { ...countSnapshot, reason: error.status === 'not_found' && source === listUrl ?
          'account_not_found' : error.reason, failedSource: source });
      }
    },
  });
}
