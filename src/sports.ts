import { sourceSetting } from './source-config.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { getWatch, now, saveWatchVersion, type Watch } from './store.js';
import { resolveMarket } from './data.js';
import type { createPolymarketPublicReader } from './polymarket-public.js';

export type Sport = 'nba' | 'tennis' | 'cs2';
export type SportsMode = 'live' | 'replay';
export type SportsCoverageStatus = 'covered' | 'partial' | 'pending' | 'stale' | 'unavailable' | 'unsupported';
export type SportsCoverage = Record<string, SportsCoverageStatus | { status: SportsCoverageStatus; reason?: string; evidenceId?: string }>;
export type SportsEvidence = { evidenceId: string; source: string; retrievedAt: string; data: unknown };
export type SportsHost = {
  saveEvidence(source: string, data: unknown, retrievedAt?: string): SportsEvidence;
  loadEvidence(id: string): SportsEvidence | undefined;
};
export type SportsParticipant = { id: string; name: string; [key: string]: unknown };
export type SportsEvent<Participant extends SportsParticipant = SportsParticipant> = {
  eventKey: string; participants: Participant[]; competition: string; scheduledAt: string | null; sourceUrl: string;
  [key: string]: unknown;
};
export type SportsMarket = {
  slug: string; eventSlug?: string; title: string; url: string; gammaMarketId: string; conditionId: string;
  outcomeTokens: { label: string; tokenId: string }[]; outcomeToken?: string;
  rules: string; resolutionSource?: string; ruleVersion: string; evidenceId: string;
  scheduledAt?: string; eventDate?: string; resolution?: unknown; quote?: unknown;
  inputEvidenceIds: string[];
};
export type SportsCondition = { kind: string; [key: string]: unknown };
export type SportsFindInput = {
  query?: string; eventKey?: string; asOf: string; mode: SportsMode; market?: SportsMarket; sourceEvidence?: SportsEvidence[]; noSpoilers?: boolean;
};
export type SportsInspectInput = SportsFindInput & { event: SportsEvent };
export type SportsFindResult = { candidates: SportsEvent[]; coverage: SportsCoverage; inputEvidenceIds: string[] };
export type SportsSnapshot<Facts = Record<string, unknown>> = Omit<SportsEvent, 'sourceUrl'> & {
  eventKey: string; participants: SportsParticipant[]; competition: string; scheduledAt: string | null;
  startedAt: string | null; state: string; sourceUrl?: string; facts: Facts; coverage: SportsCoverage;
  inputEvidenceIds: string[]; market?: unknown;
};
export type SportsEventChange = {
  eventKey: string; kind: string; occurredAt: string | null; summary: string; inputEvidenceIds: string[]; sourceUrl?: string; outcomeToken?: string;
};
export type SportsWatchPreparation = {
  acceptedConditions: SportsCondition[]; blockedConditions: { condition: SportsCondition; reason: string }[];
  minIntervalSeconds: number; sources?: string[];
};
export type SportsWatchDraft = {
  kind: 'sports_watch_draft'; sport: Sport; eventKey: string; event: SportsEvent; conditions: SportsCondition[];
  minIntervalSeconds: number; sources: string[]; sessionId: string; createdAt: string; snapshotEvidenceId: string;
  inputEvidenceIds: string[]; market?: SportsMarket;
  preset?: { name: 'cs2_commentary'; intervalSeconds: number; expiresAt: string };
};
export type SportsChanges<Baseline = unknown> = { baseline: Baseline; events: SportsEventChange[]; coverage: SportsCoverage; finished?: boolean };
export type SportsAdapter<Snapshot extends SportsSnapshot = SportsSnapshot, Baseline = unknown> = {
  sport: Sport;
  find(input: SportsFindInput, signal: AbortSignal): Promise<SportsFindResult>;
  inspect(input: SportsInspectInput, signal: AbortSignal): Promise<Snapshot>;
  watchDefaults?(snapshot: Snapshot): { conditions: SportsCondition[]; expiresAt: string };
  prepareWatch(snapshot: Snapshot, conditions: SportsCondition[]): SportsWatchPreparation;
  changes(previous: Baseline | undefined, current: Snapshot, draft: SportsWatchDraft): SportsChanges<Baseline>;
};

const sports = ['nba', 'tennis', 'cs2'] as const;
const labels = { nba: 'NBA', tennis: '网球', cs2: 'CS2' };
const sessionKey = (sessionId?: string) => sessionId ?? 'local-control';
export const sportsWatchPrompt = '执行当前原生唤醒的体育赛事检查。';
export const sportsWatchSource = 'sports/watch';
export const sportsEventKey = (sport: Sport, provider: string, eventId: string) => `${sport}:${provider}:${eventId}`;
export const sportsVersion = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sportsTimestamp = (s: unknown): string | null => typeof s === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(s)
  && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
const validEventKey = (sport: Sport, key: string) => key.startsWith(sport + ':') && /^[a-z0-9]+:[a-z0-9_-]+:[a-z0-9_.-]{1,128}$/i.test(key);

export function sportsWatch(watch: Watch): SportsWatchDraft | undefined {
  if (watch.market_id !== null || !watch.notify_when.startsWith('{')) return;
  const value = JSON.parse(watch.notify_when) as SportsWatchDraft;
  return value?.kind === 'sports_watch_draft' ? value : undefined;
}

type PublicRead = ReturnType<typeof createPolymarketPublicReader>['read'];
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9\p{L}.]+/gu, ' ').trim();
const unique = (ids: string[]) => [...new Set(ids)];

export function createSportsAssistant(host: SportsHost & { db: DatabaseSync; read: PublicRead },
  // Each vertical owns its snapshot facts and persisted baseline.
  adapters: SportsAdapter<any, any>[]) {
  const registry = new Map(adapters.map(adapter => [adapter.sport, adapter]));
  const db = host.db;
  function adapterFor(sport: Sport) {
    const adapter = registry.get(sport);
    if (!adapter) throw Error(`${labels[sport]} 适配器尚未注册。`);
    return adapter;
  }

  async function readMarket(input: string, query: string | undefined, conditionId: string | undefined,
    token: string | undefined, signal: AbortSignal) {
    const request = input.trim();
    const local = await resolveMarket(request, signal).catch(error => {
      signal.throwIfAborted();
      return { source: 'market-data/resolve', retrievedAt: now(), data: { status: 'unavailable', error: String(error) } };
    });
    const match = record(local.data);
    const resolvedId = host.saveEvidence(local.source, local.data, local.retrievedAt).evidenceId;
    const ids = [resolvedId];
    const eventLink = /^https:\/\/(?:www\.)?polymarket\.com\/event\/([\w-]+)(?:\/([\w-]+))?\/?(?:[?#].*)?$/i.exec(request);
    const eventSlug = typeof match.eventSlug === 'string' ? match.eventSlug : eventLink?.[1];
    const eventInput = Boolean(eventLink && !eventLink[2] || match.slug && match.slug === match.eventSlug &&
      request === match.eventSlug);
    const exact = typeof match.slug === 'string' ? match.slug : eventLink?.[2] ?? (/^gamma:\d+$/.test(request) ? request.slice(6) : undefined);
    let selected = eventInput ? undefined : exact;
    if (!selected && (eventSlug || /^[a-z0-9-]+$/i.test(request))) {
      const response = await host.read({ view: 'event', id: eventSlug ?? request }, signal);
      ids.push(response.evidenceId);
      const stored = record(host.loadEvidence(response.evidenceId)?.data);
      let event = record(stored.response);
      // Large events exceed the shared public reader's response cap. Save only the child identities.
      if (!Array.isArray(event.markets) && /^[a-z0-9][a-z0-9-]{0,199}$/.test(eventSlug ?? request) && response.status !== 'not_found') {
        const slug = eventSlug ?? request;
        const url = `${sourceSetting('PM_POLYMARKET_GAMMA_URL')}/events/slug/${encodeURIComponent(slug)}`;
        try {
          const page = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
          if (!page.ok || !page.body) throw Error(`HTTP ${page.status}`);
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of page.body) {
            size += chunk.length;
            if (size > 8_000_000) throw Error('赛事市场目录超过读取上限。');
            chunks.push(chunk);
          }
          const raw = record(JSON.parse(Buffer.concat(chunks).toString()));
          if (raw.slug !== slug || !Array.isArray(raw.markets)) throw Error('官方赛事目录身份不一致。');
          event = { slug: raw.slug, markets: raw.markets.map(m => {
            const { slug, question, conditionId, clobTokenIds } = record(m);
            return { slug, question, conditionId, clobTokenIds };
          }) };
          ids.push(host.saveEvidence(url, { kind: 'sports_market_catalog', ...event }).evidenceId);
        } catch (error) {
          signal.throwIfAborted();
          ids.push(host.saveEvidence(url, { kind: 'sports_market_catalog', status: 'unavailable', reason: String(error) }).evidenceId);
        }
      }
      const markets = (Array.isArray(event.markets) ? event.markets : []).map(record);
      let matches = markets.filter(row => typeof row.slug === 'string');
      if (conditionId || token) matches = matches.filter(row => (!conditionId || row.conditionId === conditionId) &&
        (!token || String(row.clobTokenIds).includes(token)));
      let unmatchedThreshold = false;
      if (matches.length > 1 && query) {
        const q = norm(query);
        const exactTitles = matches.filter(row => {
          const title = norm(String(row.question ?? ''));
          return title && q.includes(title) || /全场胜负|胜负盘|moneyline/i.test(query) && row.slug === event.slug;
        });
        if (exactTitles.length) matches = exactTitles;
        else if (/篮板|\brebounds?\b/i.test(query)) {
          const props = matches.flatMap(row => {
            const line = /^(.*?): Rebounds O\/U (\d+(?:\.\d+)?)$/i.exec(String(row.question ?? ''));
            return line ? [{ row, name: norm(line[1]), line: line[2] }] : [];
          });
          const named = props.filter(p => q.includes(p.name) || p.name === 'shai gilgeous alexander' && /\bsga\b/i.test(query));
          const family = named.length ? named : props;
          if (family.length) {
            const threshold = query.match(/(?:^|[^\d.])(\d+\.\d+)(?=$|[^\d.])/)?.[1];
            const sameLine = threshold ? family.filter(p => Number(p.line) === Number(threshold)) : family;
            unmatchedThreshold = Boolean(threshold && !sameLine.length);
            matches = (unmatchedThreshold ? family : sameLine).map(p => p.row);
          }
        }
      }
      if (!matches.length && response.status !== 'ok' && eventSlug && exact === eventSlug &&
          query && /全场胜负|胜负盘|moneyline/i.test(query)) selected = exact;
      if (!selected && (matches.length !== 1 || unmatchedThreshold)) return { ids,
        status: unmatchedThreshold ? 'market_threshold_unmatched' : matches.length ? 'ambiguous_market' : 'market_unavailable',
        candidates: matches.slice(0, 25).map(({ slug, question, conditionId }) => ({ slug, title: question, conditionId })),
        candidateCount: matches.length } as const;
      selected ??= String(matches[0].slug);
    }
    if (!selected) return { ids, status: 'market_unavailable' } as const;
    const response = await host.read({ view: 'market', id: selected }, signal);
    ids.push(response.evidenceId);
    const row = record(response.result);
    const raw = record(record(host.loadEvidence(response.evidenceId)?.data).response);
    const meta = record(Array.isArray(raw.events) ? raw.events[0] : undefined);
    const tokens = (Array.isArray(row.outcomeTokens) ? row.outcomeTokens : []).map(record)
      .filter(t => typeof t.label === 'string' && typeof t.tokenId === 'string')
      .map(t => ({ label: String(t.label), tokenId: String(t.tokenId) }));
    if (response.status !== 'ok' || typeof row.rules !== 'string' || !/^0x[0-9a-f]{64}$/i.test(String(row.conditionId)) ||
        !eventInput && match.conditionId && match.conditionId !== row.conditionId || conditionId && conditionId !== row.conditionId ||
        token && !tokens.some(t => t.tokenId === token) || tokens.length < 2) return { ids, status: 'market_identity_unverified' } as const;
    const canonicalEvent = typeof meta.slug === 'string' ? meta.slug : eventSlug;
    if (eventLink && canonicalEvent !== eventLink[1]) return { ids, status: 'market_identity_unverified' } as const;
    const source = typeof row.resolutionSource === 'string' ? row.resolutionSource : undefined;
    const market: SportsMarket = { slug: String(row.slug), eventSlug: canonicalEvent, title: String(row.title),
      url: canonicalEvent ? `${sourceSetting('PM_POLYMARKET_WEB_URL')}/event/${canonicalEvent}/${row.slug}` : String(match.url ?? response.source),
      gammaMarketId: String(row.gammaMarketId), conditionId: String(row.conditionId), outcomeTokens: tokens, outcomeToken: token,
      rules: row.rules, resolutionSource: source, ruleVersion: sportsVersion([row.rules, source ?? null, tokens]),
      scheduledAt: sportsTimestamp(String(raw.gameStartTime ?? meta.startTime ?? '').replace(' ', 'T').replace(/\+00$/, '+00:00')) ?? undefined,
      eventDate: typeof meta.eventDate === 'string' ? meta.eventDate : undefined,
      evidenceId: response.evidenceId, inputEvidenceIds: ids };
    return { market, ids, status: 'ok' } as const;
  }

  async function marketObservations(market: SportsMarket, signal: AbortSignal) {
    const [resolution, book] = await Promise.all([
      host.read({ view: 'resolution', id: market.conditionId }, signal),
      market.outcomeToken && host.read({ view: 'book', id: market.outcomeToken, condition_id: market.conditionId }, signal),
    ]);
    const raw = record(record(host.loadEvidence(market.evidenceId)?.data).response);
    const gammaResolutionStatus = typeof raw.umaResolutionStatus === 'string' ? raw.umaResolutionStatus : null;
    const resolved = Array.isArray(resolution.result) ? resolution.result.map(record).filter(r => r.status === 'resolved') : [];
    const payouts = resolved.length === 1 && Array.isArray(resolved[0].payouts) &&
      resolved[0].payouts.length === market.outcomeTokens.length ? resolved[0].payouts : undefined;
    const settlement = payouts?.every(p => typeof p === 'number' && p >= 0) && payouts.some(p => p > 0) ?
      market.outcomeTokens.map((option, i) => ({ ...option, payoutNumerator: payouts[i] })) : undefined;
    return { ...market, resolution: { source: resolution.source, status: resolution.status, evidenceId: resolution.evidenceId,
      records: resolution.result, settlement, gammaResolutionStatus, gammaClosed: raw.closed ?? null,
      gammaOutcomePrices: raw.outcomePrices ?? null, gammaEvidenceId: market.evidenceId },
    quote: book ? { status: book.status, source: book.source, evidenceId: book.evidenceId, result: book.result } : undefined,
    inputEvidenceIds: unique([...market.inputEvidenceIds, resolution.evidenceId, ...(book ? [book.evidenceId] : [])]) };
  }

  function snapshotReceipt(sport: Sport, snapshot: SportsSnapshot, asOf: string, mode: SportsMode, contract?: SportsMarket) {
    const inputEvidenceIds = unique([...snapshot.inputEvidenceIds, ...contract?.inputEvidenceIds ?? []]);
    const result = { ...snapshot, sport, asOf, mode, inputEvidenceIds,
      market: contract && { contract, check: snapshot.market } };
    const saved = host.saveEvidence('sports/snapshot', { ...result, kind: 'sports_snapshot' });
    return { ...result, evidenceId: saved.evidenceId };
  }

  const tool = defineTool({
    name: 'sports_assistant',
    description: '查体育赛程、实况和 Polymarket 精确子盘。先用 find 找赛事，再用 inspect 核对。用户明确订阅地图等进度提醒时用 watch_draft，CS2 可用 watch_preset=cs2_commentary 填默认事件。逐回合直播用 cs2_live_commentary。适配器包括 ' + adapters.map(a => labels[a.sport]).join('、'),
    parameters: {
      action: { type: 'string', required: true, enum: ['find', 'inspect', 'watch_draft'] },
      sport: { type: 'string', required: true, enum: sports },
      query: { type: 'string' }, event_key: { type: 'string' }, market: { type: 'string' },
      condition_id: { type: 'string' }, outcome_token: { type: 'string' },
      mode: { type: 'string', enum: ['live', 'replay'] }, as_of: { type: 'string' },
      no_spoilers: { type: 'boolean', description: 'CS2 无剧透回放，只显示无剧透入口与覆盖。' },
      source_evidence_ids: { type: 'array', items: { type: 'string' } },
      watch_preset: { type: 'string', enum: ['cs2_commentary'], description: '仅 CS2 的 watch_draft。默认事件与周期、到期由程序填写，显式 conditions 覆盖默认事件。CS2 草案省略 conditions 时自动选用。' },
      conditions: { type: 'array', items: { type: 'json' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const sport = args.sport as Sport;
      const adapter = adapterFor(sport);
      if (args.watch_preset && (sport !== 'cs2' || args.action !== 'watch_draft')) throw Error('cs2_commentary 仅用于 CS2 订阅草案。');
      const mode = (args.mode ?? 'live') as SportsMode;
      if (args.event_key && !validEventKey(sport, args.event_key)) throw Error('赛事键应为 sport:provider:eventId。');
      if (!args.query?.trim() && !args.event_key && !args.market) throw Error('请提供赛事查询、赛事键或市场。');
      if (args.condition_id && !/^0x[0-9a-f]{64}$/i.test(args.condition_id) || args.outcome_token && !/^\d{1,78}$/.test(args.outcome_token))
        throw Error('请提供完整的 condition ID 或选项 token。');
      const asOf = mode === 'replay' ? sportsTimestamp(args.as_of) : now();
      if (!asOf || mode === 'replay' && (!args.source_evidence_ids?.length || asOf > now()) ||
          mode === 'live' && (args.as_of || args.source_evidence_ids?.length)) throw Error('回放需要带时区的 as_of 和当时已取得的原始证据 ID。');
      if (mode === 'replay' && args.action === 'watch_draft') throw Error('回放不能创建实时订阅。');
      if ((args.source_evidence_ids?.length ?? 0) > 30) throw Error('一次最多加载 30 项回放证据。');
      const sourceEvidence = args.source_evidence_ids?.map(id => {
        const evidence = host.loadEvidence(id);
        if (!evidence || evidence.retrievedAt > asOf) throw Error('证据在回放时点尚不可见：' + id);
        return evidence;
      });
      let market: SportsMarket | undefined;
      if (args.market) {
        if (mode === 'live') {
          const result = await readMarket(args.market, args.query, args.condition_id?.toLowerCase(), args.outcome_token, exec.signal);
          if (!result.market) {
            const data = { sport, mode, asOf, status: result.status, candidates: result.candidates, candidateCount: result.candidateCount,
              facts: {}, coverage: { market: 'pending' }, inputEvidenceIds: result.ids };
            return JSON.stringify({ ...data, evidenceId: host.saveEvidence('sports/market_selection', data).evidenceId });
          }
          market = result.market;
        } else {
          const prior = sourceEvidence?.map(row => record(record(record(row.data).market).contract))
            .find(contract => [contract.slug, contract.url, contract.conditionId].includes(args.market) &&
              (!args.condition_id || contract.conditionId === args.condition_id) && (!args.outcome_token || contract.outcomeToken === args.outcome_token));
          if (!prior) throw Error('回放市场需要当时已取得的精确合约凭据。');
          market = prior as SportsMarket;
        }
      }
      if (args.no_spoilers && (sport !== 'cs2' || args.action === 'watch_draft'))
        throw Error('no_spoilers 适用于 CS2 赛事和回放查询。');
      const input = { query: args.query?.trim(), eventKey: args.event_key, asOf: mode === 'live' ? now() : asOf,
        mode, market, sourceEvidence, noSpoilers: args.no_spoilers };
      const found = await adapter.find(input, exec.signal);
      const candidates = found.candidates.filter(c => validEventKey(sport, c.eventKey) && (!args.event_key || c.eventKey === args.event_key));
      const inputEvidenceIds = unique([...found.inputEvidenceIds, ...market?.inputEvidenceIds ?? []]);
      const status = candidates.length === 1 ? 'ok' : candidates.length ? 'ambiguous_event' : 'event_unverified';
      if (args.action === 'find' || candidates.length !== 1) {
        const result = { status, sport, mode, asOf, candidates, facts: {}, coverage: found.coverage, market: args.no_spoilers ? undefined : market, inputEvidenceIds };
        return JSON.stringify({ ...result, evidenceId: host.saveEvidence('sports/find', result).evidenceId });
      }
      const event = candidates[0];
      const snapshot = await adapter.inspect({ ...input, asOf: mode === 'live' ? now() : asOf, event }, exec.signal);
      if (snapshot.eventKey !== event.eventKey) throw Error('快照赛事与已选赛事不符。');
      if (market && mode === 'live' && args.action === 'inspect' && !args.no_spoilers) market = await marketObservations(market, exec.signal);
      const receipt = snapshotReceipt(sport, { ...snapshot, inputEvidenceIds: unique([...inputEvidenceIds, ...snapshot.inputEvidenceIds]) },
        mode === 'live' ? now() : asOf, mode, args.no_spoilers ? undefined : market);
      if (args.action !== 'watch_draft') return JSON.stringify({ status, ...receipt, event });
      const defaults = sport === 'cs2' && (args.watch_preset || args.conditions === undefined) ? adapter.watchDefaults?.(snapshot) : undefined;
      const conditions = (args.conditions as SportsCondition[] | undefined) ?? defaults?.conditions;
      if (!conditions?.length || conditions.length > 12 || conditions.some(c => !c || typeof c.kind !== 'string' || !c.kind.trim()))
        throw Error('请提供 1–12 项体育条件，每项含 kind 和明确目标。');
      const prepared = adapter.prepareWatch(snapshot, conditions);
      const minIntervalSeconds = Math.max(60, prepared.minIntervalSeconds);
      const preset = defaults && { name: 'cs2_commentary' as const, intervalSeconds: minIntervalSeconds, expiresAt: defaults.expiresAt };
      const sources = prepared.sources ?? [event.sourceUrl];
      const blocked = prepared.blockedConditions;
      const binding = record(snapshot.market).binding;
      if (market && (binding === 'mismatch' || binding === 'unverified' || record(snapshot.market).status === 'unsupported'))
        throw Error('赛事与精确市场规则尚未通过核对。');
      if (!prepared.acceptedConditions.length) return JSON.stringify({ status: 'blocked', ...receipt, ...prepared, minIntervalSeconds, sources, preset });
      const draft: SportsWatchDraft = { kind: 'sports_watch_draft', sport, eventKey: event.eventKey, event,
        conditions: prepared.acceptedConditions, minIntervalSeconds, sources, sessionId: sessionKey(exec.agent?.session.id),
        createdAt: now(), snapshotEvidenceId: receipt.evidenceId, inputEvidenceIds: receipt.inputEvidenceIds, market, preset };
      return JSON.stringify({ status: blocked.length ? 'partial' : 'ok', ...receipt, ...prepared, sources, minIntervalSeconds, preset,
        sports_watch_evidence_id: host.saveEvidence('sports/watch_draft', draft).evidenceId });
    },
  });

  async function draft(id: string, sessionId: string | undefined, signal: AbortSignal) {
    const evidence = host.loadEvidence(id);
    const plan = evidence?.data as SportsWatchDraft | undefined;
    if (evidence?.source !== 'sports/watch_draft' || plan?.kind !== 'sports_watch_draft' || plan.sessionId !== sessionKey(sessionId) ||
        !validEventKey(plan.sport, plan.eventKey) || plan.eventKey !== plan.event.eventKey || !plan.conditions.length ||
        Date.now() - Date.parse(plan.createdAt) > 900_000) throw Error('体育订阅凭据无效、已过期或不属于当前会话，请重新核对。');
    const snapshot = host.loadEvidence(plan.snapshotEvidenceId)?.data as SportsSnapshot | undefined;
    if (snapshot?.eventKey !== plan.eventKey || !plan.inputEvidenceIds.every(id => host.loadEvidence(id)))
      throw Error('体育赛事或条件凭据缺失。');
    adapterFor(plan.sport);
    if (plan.market) {
      const checked = await readMarket(plan.market.url, undefined, plan.market.conditionId, plan.market.outcomeToken, signal);
      if (checked.market?.ruleVersion !== plan.market.ruleVersion) throw Error('市场规则或选项版本已变化，请重新核对订阅。');
    }
    return plan;
  }

  async function run(watch: Watch, plan: SportsWatchDraft, runId: string, occurrence: string, signal: AbortSignal) {
    const adapter = adapterFor(plan.sport);
    const conditionKey = sportsVersion([plan.eventKey, plan.conditions, plan.market?.ruleVersion, plan.market?.outcomeToken]);
    const last = db.prepare(`SELECT result FROM runs WHERE watch_id=? AND json_valid(result)
      AND json_extract(result,'$.conditionKey')=? ORDER BY rowid DESC LIMIT 1`).get(watch.id, conditionKey);
    const previous = last ? JSON.parse(String(last.result)).baseline : undefined;
    const asOf = now();
    const initial = previous === undefined && plan.preset ? host.loadEvidence(plan.snapshotEvidenceId)?.data as SportsSnapshot | undefined : undefined;
    let market = plan.market;
    const coverage: SportsCoverage = {};
    if (market) {
      const checked = await readMarket(market.url, undefined, market.conditionId, market.outcomeToken, signal);
      if (checked.market?.ruleVersion === market.ruleVersion) market = await marketObservations(checked.market, signal);
      else coverage.rules = { status: checked.market ? 'pending' : 'unavailable',
        reason: checked.market ? '市场规则版本已变化，需要重新核对。' : '市场规则读取失败。', evidenceId: checked.ids.at(-1) };
    }
    let receipt: ReturnType<typeof snapshotReceipt> | undefined;
    let change: SportsChanges = { baseline: previous, events: [], coverage };
    if (!coverage.rules) {
      const snapshot = await adapter.inspect({ event: plan.event, eventKey: plan.eventKey, mode: 'live', asOf, market }, signal);
      if (snapshot.eventKey !== plan.eventKey) throw Error('订阅快照赛事不一致。');
      receipt = snapshotReceipt(plan.sport, snapshot, now(), 'live', market);
      const baseline = initial?.eventKey === plan.eventKey ? adapter.changes(undefined, initial, plan).baseline : previous;
      change = adapter.changes(baseline, snapshot, plan);
    }
    signal.throwIfAborted();
    const at = now();
    let finished = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getWatch(db, watch.id);
      if (current.status !== 'active' || current.version !== watch.version || current.expires_at <= at) {
        db.prepare("UPDATE runs SET status='cancelled',finished_at=?,error=? WHERE id=? AND status='running'")
          .run(at, '提交前任务已变更、暂停或到期。', runId);
      } else {
        const inputEvidenceIds = unique([...receipt?.inputEvidenceIds ?? [], ...change.events.flatMap(e => e.inputEvidenceIds)]);
        const result = { kind: 'sports_watch_check', sport: plan.sport, eventKey: plan.eventKey, occurrence, scheduleId: watch.schedule_id,
          conditionKey, baseline: change.baseline, coverage: change.coverage, inputEvidenceIds, snapshotEvidenceId: receipt?.evidenceId,
          events: change.events, noticeIds: [] as string[] };
        const status = Object.values(change.coverage).length && Object.values(change.coverage).every(c =>
          (typeof c === 'string' ? c : c.status) === 'covered') ? 'complete' : 'partial';
        for (const event of change.events) {
          if (!event.inputEvidenceIds.length || !event.inputEvidenceIds.every(id => host.loadEvidence(id))) continue;
          const refs = unique([event.sourceUrl ?? '', ...event.inputEvidenceIds.map(id => host.loadEvidence(id)?.source ?? '')])
            .filter(url => url.startsWith('https://'));
          const book = record(market?.quote);
          const quote = record(book.result);
          const matchesToken = Boolean(plan.market?.outcomeToken && event.outcomeToken === plan.market.outcomeToken && quote.tokenId === plan.market.outcomeToken &&
            quote.conditionId === plan.market.conditionId && quote.timestampStatus === 'within_30s' && quote.bookShape === 'two_sided');
          const body = [watch.goal, event.summary, event.occurredAt ? `事件时间 ${event.occurredAt}` : `检查时间 ${at}`,
            ...(matchesToken ? [`盘口买 ${quote.bestBid} / 卖 ${quote.bestAsk} · ${quote.sourceTime}`, String(book.source)] : []),
            ...refs, `证据 ${unique([...(receipt ? [receipt.evidenceId] : []), ...event.inputEvidenceIds]).join(' · ')}`].join('\n');
          const id = randomUUID();
          if (db.prepare('INSERT OR IGNORE INTO notices(id,watch_id,run_id,event_key,body,created_at) VALUES (?,?,?,?,?,?)')
            .run(id, watch.id, runId, sportsVersion([plan.eventKey, event.eventKey]), body, at).changes) result.noticeIds.push(id);
        }
        const evidence = host.saveEvidence(sportsWatchSource, result, at);
        for (const [path, value] of Object.entries(change.coverage)) {
          const detail = typeof value === 'string' ? { status: value } : value;
          db.prepare('INSERT INTO coverage VALUES (?,?,?,?,?)').run(runId, `sports/${path}`, detail.evidenceId ?? evidence.evidenceId,
            detail.status, JSON.stringify(detail));
        }
        db.prepare("UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND status='running'")
          .run(status, at, JSON.stringify({ ...result, evidenceId: evidence.evidenceId }), runId);
        if (plan.preset && change.finished) {
          db.prepare("UPDATE watches SET status='ended',version=version+1 WHERE id=?").run(watch.id);
          saveWatchVersion(db, watch.id);
          finished = true;
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return finished;
  }
  return { tool, draft, run };
}
