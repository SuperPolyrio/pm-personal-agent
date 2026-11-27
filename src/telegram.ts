import { sourceSetting } from './source-config.js';
import { Bot, HttpError, InputFile } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { DeepSeekHarness, HarnessSession, SdkUserQuestionRequest, SdkUserQuestionResult } from '@deepseek-ai/dsh-sdk-client';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { openStore, now, stateDir } from './store.js';
import { indicatorCatalog } from './crypto-indicator-catalog.js';
import type { compareSourceEvidence, NormalizedSourceEvidence } from './source-evidence.js';
import type { MarketWatchNotice } from './tasks.js';
import { queryTelegramXNews, xNewsCommands, type TelegramToolCall } from './telegram-x-news.js';
import { asksSettlement, confirmedPriceWindow, confirmedSettlement, finishTelegramFocus, initializeTelegramFocus,
  collectNewsSources, prepareTelegramResearch, reviewResearchTurn, streamVerifiedTelegramFacts, turnEvidenceIds } from './telegram-research.js';

type ResearchRun = Awaited<ReturnType<HarnessSession['run']>>;
type SourceComparison = ReturnType<typeof compareSourceEvidence>['data'];

const toolLabels: Record<string, string> = {
  sports_assistant: '核对体育赛事与盘口',
  skill: '加载研究方法', query_sql: '查询数据库', describe_data: '检查数据字段',
  resolve_market: '定位市场', read_market: '读取市场资料', read_evidence: '查看证据',
  search_market_sources: '搜索原始资料', read_official_market_data: '查询官方数据',
  web_fetch: '读取网页', read_market_source_copy: '通过备用渠道读取原文',
  locate_market_source_passages: '定位原文引文', build_rule_card: '整理市场规则',
  verify_market_source_fact: '核对来源与事实', assess_rule_evidence: '核对结算条款',
  read_x_posts: '读取 X 帖子', read_eqn_news: '读取方程式新闻', read_xtracker_count: '核对 XTracker 计数',
};

function currentSourceReceipts(result: ResearchRun) {
  const tools = new Map<string, string>();
  const receipts = new Map<string, string>();
  for (const event of result.events) {
    if (event.type === 'tool/call' && ['normalize_source_evidence', 'compare_source_evidence'].includes(event.data.name)) {
      tools.set(event.data.callId, event.data.name);
    } else if (event.type === 'tool/result' && !event.data.message.isError) {
      const name = tools.get(event.data.message.toolCallId);
      if (!name) continue;
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue;
        try {
          const { evidenceId } = JSON.parse(block.text);
          if (typeof evidenceId === 'string') receipts.set(evidenceId, name);
        } catch { /* Ignore text projections without a receipt. */ }
      }
    }
  }
  return receipts;
}

export function splitReply(text: string) {
  const parts: string[] = [];
  while (text.length > 4000) {
    let end = text.lastIndexOf('\n', 4000);
    if (end < 1) end = 4000;
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

// Match URLs first: an identifier in a publisher's URL is part of its address.
const evidenceReference = /https?:\/\/[^\s<>\x60，。；、（）【】]+|(?:(内部证据|核对证据|原始证据|证据|核对记录|原始|evidence(?:[_ -]?ids?)?|review[_ -]?id)[ \t]*(?:ID|编号)?[ \t]*[:：=]?[ \t]*)?\b([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\b/gi;

function hideEvidenceReferences(text: string, db?: ReturnType<typeof openStore>) {
  if (!/[a-f\d]{8}-[a-f\d]{4}-/i.test(text)) return text;
  const lookup = db?.prepare('SELECT 1 FROM evidence WHERE id=?');
  return text.split('\n').flatMap(line => {
    const visible = line.replace(evidenceReference, (match, label, id) =>
      id && (label || lookup?.get(id.toLowerCase())) ? '' : match);
    if (visible === line) return [line];
    const cleaned = visible.replace(/[(（\[【][ \t]*[)）\]】]/g, '').trimEnd();
    return /[^\s,，、/;；:：.。-]/.test(cleaned) ? [cleaned] : [];
  }).join('\n');
}

export function plainTextReply(text: string, db?: ReturnType<typeof openStore>) {
  const plain = text
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\r\n]*$/gm, '')
    .replace(/^[ \t]*(?:#{1,6}(?:[ \t]+|$)|>+[ \t]*)/gm, '')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/^[ \t]*[-+*•][ \t]+/gm, '')
    .replace(/^[ \t]*\|[^\r\n]*\|[ \t]*$/gm, row => {
      const cells = row.trim().slice(1, -1).split('|').map(cell => cell.trim());
      return cells.every(cell => /^:?-{3,}:?$/.test(cell)) ? '' : cells.join('　');
    })
    .replace(/(https?:\/\/[^\s<>`*]+)|\*{2,}|`+|~{2,}|(?<!\w)__|__(?!\w)|(?<!\w)\*([^*\s](?:[^*\r\n]*[^*\s])?)\*|(?<!\w)_([^_\s](?:[^_\r\n]*[^_\s])?)_(?!\w)/gi,
      (_match, url, italic, underline) => url ?? italic ?? underline ?? '')
    .replace(/!?\[([^\]\r\n]*)\]\((https?:\/\/(?:[^\s()]|\([^()\s]*\))+)\)/gi, '$1 $2')
    .replace(/<(https?:\/\/[^\s<>]+)>/gi, '$1')
    .trim();
  return hideEvidenceReferences(plain, db).trim();
}

export function telegramHelp() {
  const intro = 'Polymarket 个人 Agent\n想看新闻，直接发一句“法国总统大选有哪些值得关注的新消息？”就可以。问具体盘口时，也可以贴市场链接。';
  const xNews = [
    'X 动态、方程式新闻与 XTracker',
    '给我马斯克、CZ、何一在 EQN 的最近一条动态，附原帖。',
    '查 EQN 第 17187 条，核对公告是什么。',
    '按这个市场的 XTracker 查已计条数和离 240 条的差距。[市场链接]',
    '订阅 EQN，未来 24 小时每 5 分钟查 CZ 和何一，有新关注或取消关注才发我。',
    '要管理订阅，直接说“查看我的 EQN 订阅”或“暂停 EQN 订阅 [任务 ID]”。',
    '直查命令 /x @账号，/eqn 快讯编号或@账号，/xcount 市场链接 [目标条数]，/eqnsub 查看订阅。',
    '订阅命令示例 /eqnsub @cz_binance,@heyibinance 5 24 follow,unfollow',
  ].join('\n');
  const crypto = [
    'Crypto 行情与指标盯盘',
    '查询 ' + indicatorCatalog.length + ' 项内置 Crypto 指标\n查 Binance 现货 BTC/USDT 的 1 小时和 4 小时布林带、MACD、RSI，给最新值、前值和收盘时间。',
    '按指标盯盘\n帮我每 5 分钟检查 Binance 现货 BTC/USDT 的 15 分钟 RSI(14)，已收盘 RSI 上穿 70 时提醒我，持续 24 小时。',
    'BTC、ETH 5 分钟模拟盘\n/crypto_paper 启动 24 小时任务，每 5 分钟汇总。/crypto_paper stop 停止。',
    '也可直接问“有哪些 Crypto 指标？”',
  ].join('\n\n');
  const commands = '快捷命令\n/help 功能清单\n/status 当前状态\n/new 开始新对话\n/cancel 停止当前研究\n/retry 重发未确认送达的回复或提醒';
  let guide: string;
  try {
    guide = readFileSync(new URL('../docs/Agent功能清单.md', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [intro, xNews, crypto, commands].join('\n\n');
  }

  const sections: { title: string; items: string[] }[] = [];
  for (const line of guide.split(/\r?\n/)) {
    if (line.startsWith('## ')) sections.push({ title: line.slice(3), items: [] });
    const example = /^\|\s*([^|]+?)\s*\|\s*“([^”]+)”/.exec(line);
    if (example) sections.at(-1)?.items.push(`${example[1]}\n${example[2]}`);
  }
  const groups = sections.filter(section => section.items.length)
    .map(section => [section.title, ...section.items].join('\n\n'));
  return [intro, xNews, ...groups, crypto, commands].join('\n\n');
}

export function createTelegram() {
  const token = process.env['telegram-token'] ?? process.env.TELEGRAM_BOT_TOKEN;
  const userId = Number(process.env.TELEGRAM_USER_ID);
  if (!token || !Number.isSafeInteger(userId) || userId <= 0) throw new Error('Telegram 需要配置 telegram-token 和 TELEGRAM_USER_ID。');
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  const bot = new Bot(token, { client: { apiRoot: sourceSetting('PM_TELEGRAM_API_URL'), baseFetchConfig: proxy ? { agent: new HttpsProxyAgent(proxy) } : {}, timeoutSeconds: 45 } });
  const db = openStore();
  initializeTelegramFocus(db);
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_updates (
    bot_id INTEGER NOT NULL, update_id INTEGER NOT NULL, session_id TEXT, request_text TEXT,
    status TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(bot_id,update_id)
  );
  CREATE TABLE IF NOT EXISTS telegram_outbox (
    id TEXT PRIMARY KEY, bot_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, body TEXT NOT NULL,
    sent_parts INTEGER NOT NULL DEFAULT 0, message_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending', error TEXT, updated_at TEXT NOT NULL
  );`);
  if (!db.prepare('PRAGMA table_info(telegram_updates)').all().some(column => column.name === 'request_text')) {
    db.exec('ALTER TABLE telegram_updates ADD COLUMN request_text TEXT');
  }
  let session: HarnessSession;
  let work: Promise<void> | undefined;
  let stopping = false;
  let delivery: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let question: { resolve: (text: string | null) => void } | undefined;
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll(token, '[redacted]');
  const send = async (text: string) => {
    for (const part of splitReply(plainTextReply(text, db))) await bot.api.sendMessage(userId, part);
  };
  const sportsNotice = db.prepare(`SELECT 1 FROM notices n JOIN watches w ON n.watch_id=w.id
    WHERE n.id=? AND json_extract(CASE WHEN json_valid(w.notify_when) THEN w.notify_when END,'$.kind')='sports_watch_draft'`);
  const noticeText = (id: string, body: string) => id.startsWith('notice:') && sportsNotice.get(id.slice(7))
    ? body : hideEvidenceReferences(body, db);
  const queue = (id: string, body: string) => db.prepare(
    'INSERT OR IGNORE INTO telegram_outbox(id,bot_id,chat_id,body,updated_at) VALUES (?,?,?,?,?)',
  ).run(id, bot.botInfo.id, userId, id.startsWith('reply:') ? plainTextReply(body, db) || '本次没有可显示的回复。' : noticeText(id, body), now());
  const marketPrefix = () => `market-watch:${bot.botInfo.id}:${userId}:`;
  function markNotices(id: string, status: string) {
    if (id.startsWith(marketPrefix())) {
      db.prepare(`UPDATE notices SET delivery_status=? WHERE length(id)=64 AND event_key=id AND
        json_extract(CASE WHEN json_valid(body) THEN body END,'$.kind')='market_watch_notice'
        AND json_extract(CASE WHEN json_valid(body) THEN body END,'$.deliveryKey')=?`)
        .run(status, id.slice(marketPrefix().length));
    } else if (id.startsWith('notice:')) {
      db.prepare('UPDATE notices SET delivery_status=? WHERE id=?').run(status, id.slice(7));
    }
  }

  async function flush() {
    const groups = new Map<string, Set<string>>();
    const at = now();
    for (const notice of db.prepare("SELECT id,body FROM notices WHERE delivery_status='pending' ORDER BY created_at,id").all()) {
      const body = String(notice.body);
      let market: MarketWatchNotice | undefined;
      if (String(notice.id).length === 64 && body.startsWith('{')) {
        try { market = JSON.parse(body) as MarketWatchNotice; } catch { /* Existing plain text notice. */ }
      }
      if (market?.kind !== 'market_watch_notice' || typeof market.text !== 'string' || !/^[a-f0-9]{64}$/.test(market.deliveryKey)) {
        queue(`notice:${notice.id}`, body);
        continue;
      }
      if (market.notBefore && market.notBefore > at) continue;
      const id = marketPrefix() + market.deliveryKey;
      const parts = groups.get(id) ?? new Set<string>();
      parts.add(market.text);
      groups.set(id, parts);
    }
    for (const [id, parts] of groups) {
      const body = [...parts].join('\n\n');
      queue(id, body);
      const row = db.prepare('SELECT status,sent_parts FROM telegram_outbox WHERE id=?').get(id)!;
      if (row.status === 'pending' && row.sent_parts === 0) {
        db.prepare('UPDATE telegram_outbox SET body=? WHERE id=?').run(hideEvidenceReferences(body, db), id);
      } else {
        markNotices(id, String(row.status));
      }
    }
    const rows = db.prepare("SELECT * FROM telegram_outbox WHERE bot_id=? AND chat_id=? AND status='pending' ORDER BY updated_at LIMIT 5").all(bot.botInfo.id, userId);
    for (const row of rows) {
      const messages = JSON.parse(String(row.message_ids)) as number[];
      const id = String(row.id);
      const body = noticeText(id, String(row.body));
      // For a retry, keep the part numbers already acknowledged by Telegram.
      const parts = Number(row.sent_parts) ? splitReply(String(row.body)).map(part => noticeText(id, part)) : splitReply(body);
      db.prepare("UPDATE telegram_outbox SET status='sending',updated_at=? WHERE id=?").run(now(), row.id);
      try {
        if (parts.length > 3 && Number(row.sent_parts) === 0) {
          const extension = String(row.id).startsWith('reply:') ? 'txt' : 'md';
          const message = await bot.api.sendDocument(userId, new InputFile(Buffer.from(body), `market-data-report.${extension}`),
            { caption: '结果较长，完整表格、指标口径、来源时间和限制说明已放在附件中。' });
          messages.push(message.message_id);
          db.prepare('UPDATE telegram_outbox SET sent_parts=?,message_ids=?,updated_at=? WHERE id=?').run(parts.length, JSON.stringify(messages), now(), row.id);
        } else for (let i = Number(row.sent_parts); i < parts.length; i++) {
          if (parts[i]?.trim()) {
            const message = await bot.api.sendMessage(userId, parts[i]!);
            messages.push(message.message_id);
          }
          db.prepare('UPDATE telegram_outbox SET sent_parts=?,message_ids=?,updated_at=? WHERE id=?').run(i + 1, JSON.stringify(messages), now(), row.id);
        }
        db.prepare("UPDATE telegram_outbox SET status='sent',error=NULL,updated_at=? WHERE id=?").run(now(), row.id);
        markNotices(String(row.id), 'sent');
        console.error(`Telegram delivered ${row.id}: ${messages.join(',')}`);
      } catch (error) {
        const status = error instanceof HttpError ? 'unknown' : 'failed';
        db.prepare('UPDATE telegram_outbox SET status=?,error=?,updated_at=? WHERE id=?').run(status, describe(error), now(), row.id);
        markNotices(String(row.id), status);
        console.error(`Telegram delivery ${status}: ${describe(error)}`);
      }
    }
  }
  function deliver() {
    delivery ??= flush().finally(() => { delivery = undefined; });
    return delivery;
  }
  async function deliverPending() {
    await bot.init();
    await deliver();
  }

  async function openReplyDraft(sessionId: string, updateId: number, showText: boolean, onEvidence?: (ids: string[]) => void) {
    const socket = createConnection(resolve(stateDir, 'control.sock'));
    const frames = createInterface({ input: socket, crlfDelay: Infinity });
    const ready = Promise.withResolvers<void>();
    let draft = '';
    let verified = '';
    let confirmedVerified = '';
    let sent = '';
    let nextSendAt = 0;
    let confirmed = 0;
    let firstText = false;
    let firstTool = false;
    const startedAt = Date.now();
    const tools = new Map<string, { label: string; mark: string }>();
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sending: Promise<void> | undefined;
    const handshake = setTimeout(closeDraft, 1000);
    const refresh = setInterval(scheduleDraft, 20_000);

    function closeDraft() {
      if (closed) return;
      closed = true;
      clearTimeout(handshake);
      clearTimeout(timer);
      clearInterval(refresh);
      frames.close();
      socket.destroy();
      ready.resolve();
    }
    function scheduleDraft() {
      if (closed || timer || sending) return;
      timer = setTimeout(() => {
        timer = undefined;
        void sendLatestDraft();
      }, Math.max(0, nextSendAt - Date.now()));
    }
    function sendLatestDraft() {
      if (closed) return;
      const elapsed = Math.floor((Date.now() - startedAt) / 20_000) * 20;
      const steps = [...tools.values()];
      const visible = [...steps.filter(step => step.mark === '…').slice(-3), ...steps.filter(step => step.mark !== '…').slice(-3)];
      const progress = [elapsed ? `正在处理 · 约 ${elapsed} 秒` : '正在处理',
        ...visible.map(({ mark, label }) => `${mark} ${label}`)].join('\n');
      const checked = verified;
      // A streamed token may end halfway through an evidence UUID.
      const content = checked ? `已核实 · 据当前已读来源\n${plainTextReply(checked, db)}`
        : plainTextReply(draft.replace(/(?<![\da-z-])[\da-f]{8}(?:-[\da-f]{0,12}){0,4}$/i, ''), db);
      const body = (content ? `${progress}\n\n${content}` : progress).slice(0, 4000).replace(/[\uD800-\uDBFF]$/, '');
      if (body === sent) return;
      sent = body;
      nextSendAt = Date.now() + 1000;
      // grammY observes the standard signal API at runtime, but types the Node shim.
      const signal = AbortSignal.timeout(2500) as unknown as Parameters<typeof bot.api.sendMessageDraft>[4];
      sending = bot.api.sendMessageDraft(userId, updateId, body, undefined, signal)
        .then(() => {
          if (++confirmed === 1) console.error(`Telegram first progress ${updateId}`);
          if (visible.length && !firstTool) {
            firstTool = true;
            console.error(`Telegram first tool progress ${updateId}`);
          }
          if (checked && checked !== confirmedVerified) {
            console.error(`Telegram ${confirmedVerified ? 'updated' : 'first'} verified draft ${updateId}`);
            confirmedVerified = checked;
          }
          if (!checked && content && !firstText) {
            firstText = true;
            console.error(`Telegram first draft ${updateId}`);
          }
        }).catch(error => {
          console.error(`Telegram draft ${updateId}: ${describe(error)}`);
          closeDraft();
        }).finally(() => {
          sending = undefined;
          scheduleDraft();
        });
      return sending;
    }

    socket.once('connect', () => socket.write(JSON.stringify({ action: 'reply-stream', sessionId, verifySources: !!onEvidence }) + '\n'));
    socket.once('error', closeDraft);
    frames.once('error', closeDraft);
    frames.once('close', closeDraft);
    frames.on('line', line => {
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'ready') { clearTimeout(handshake); ready.resolve(); }
        else if (frame.type === 'reset') draft = '';
        else if (frame.type === 'text' && typeof frame.text === 'string') {
          if (showText) draft = (draft + frame.text).slice(0, 4000);
        } else if (frame.type === 'tool-start') {
          tools.set(frame.id, { label: toolLabels[frame.name] ?? '调用研究工具', mark: '…' });
        } else if (frame.type === 'tool-end') {
          const tool = tools.get(frame.id);
          if (tool) tool.mark = frame.failed ? '×' : '✓';
          if (Array.isArray(frame.evidenceIds) && frame.evidenceIds.length) onEvidence?.(frame.evidenceIds);
        } else { closeDraft(); return; }
        scheduleDraft();
      } catch { closeDraft(); }
    });
    await ready.promise;
    return {
      showVerified(body: string) {
        verified = body;
        scheduleDraft();
      },
      async finish() {
        await sending;
        // Short answers can finish inside the progress update interval.
        if (!firstText && draft.trim()) {
          clearTimeout(timer);
          await sendLatestDraft();
        }
        closeDraft();
        if (confirmed) console.error(`Telegram draft finished ${updateId}: ${confirmed} updates`);
      },
    };
  }

  function sourceComparisonReply(result: ResearchRun, wantsRepeat: boolean) {
    const receipts = currentSourceReceipts(result);
    const readEvidence = db.prepare('SELECT source,data FROM evidence WHERE id=?');
    for (const [id, name] of [...receipts].reverse()) {
      if (name !== 'compare_source_evidence') continue;
      const compared = readEvidence.get(id);
      if (!compared) continue;
      const comparison = JSON.parse(String(compared.data)) as SourceComparison;
      const normalizedId = comparison.after.normalizedEvidenceId;
      if (comparison.kind !== 'source_evidence_comparison' || !normalizedId ||
          receipts.get(normalizedId) !== 'normalize_source_evidence' || (wantsRepeat && !comparison.before)) continue;
      const saved = readEvidence.get(normalizedId);
      if (!saved) continue;
      const normalized = JSON.parse(String(saved.data)) as NormalizedSourceEvidence['data'];
      if (normalized.kind !== 'normalized_source_evidence') continue;
      const facts = normalized.facts.filter(fact => fact.checked)
        .map(fact => `${fact.name} ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`);
      const period = normalized.scope.validTime;
      return [
        ...facts,
        typeof period === 'string' ? `适用时间 ${period}` : undefined,
        `状态 ${comparison.status}，${comparison.changes.length} 项变化`,
        ...comparison.reasons,
        typeof saved.source === 'string' && /^https?:\/\//i.test(saved.source) && saved.source,
      ].filter(Boolean).join('\n');
    }
  }

  async function ask(request: SdkUserQuestionRequest, { signal }: { signal: AbortSignal }): Promise<SdkUserQuestionResult> {
    if (request.sessionId !== session?.id || signal.aborted) return { cancelled: true };
    const answers = [];
    for (const q of request.questions) {
      let answer: string | null;
      for (;;) {
        const pending = Promise.withResolvers<string | null>();
        question = { resolve: pending.resolve };
        const abort = () => pending.resolve(null);
        signal.addEventListener('abort', abort, { once: true });
        try {
          await send([q.question, q.detail, ...(q.options ?? []).map((o, i) => `${i + 1}. ${o.label}${o.description ? `：${o.description}` : ''}`),
            q.multiSelect ? '可回复多个选项编号，用逗号分隔；也可直接输入回答。/cancel 取消当前研究。' : '直接回复文字或选项编号；/cancel 取消当前研究。'].filter(Boolean).join('\n'));
          answer = await pending.promise;
        } finally {
          signal.removeEventListener('abort', abort);
          question = undefined;
        }
        if (answer === null || signal.aborted) return { cancelled: true };
        const labels = (q.options ?? []).map(o => o.label);
        const choices = q.multiSelect ? answer.split(/[,，]/).map(v => v.trim()) : [answer.trim()];
        const selected = choices.map(value => labels.includes(value) ? value : /^\d+$/.test(value) ? labels[Number(value) - 1] : undefined);
        if (selected.every((value): value is string => value !== undefined)) {
          answers.push({ id: q.id, selected }); break;
        }
        if (q.intent?.kind === 'approval' || q.intent?.kind === 'plan-review') continue;
        answers.push({ id: q.id, selected: [], custom: answer }); break;
      }
    }
    return { answers };
  }

  async function run(harness: DeepSeekHarness, initialSession: HarnessSession, saveSession: (id: string) => void,
    cancel: (sessionId: string) => Promise<unknown>, callTool: TelegramToolCall) {
    session = initialSession;
    bot.botInfo = await bot.api.getMe();
    const webhook = await bot.api.getWebhookInfo();
    if (webhook.url) throw new Error('这个 Bot 已配置 webhook；请先明确现有接收端再切换。');
    const interrupted = db.prepare("UPDATE telegram_updates SET status='interrupted',request_text=NULL,updated_at=? WHERE bot_id=? AND status IN ('received','running') RETURNING update_id").all(now(), bot.botInfo.id);
    for (const row of interrupted) queue(`interrupted:${row.update_id}`, '上一次请求因服务重启中断，未自动重做。请重新发送问题，或用 /status 查看状态。');
    // Telegram 没有发送幂等键；发送中断留下 unknown，避免重启后自动重复提醒。
    const uncertain = db.prepare("UPDATE telegram_outbox SET status='unknown',error='发送时服务中断，送达情况未知',updated_at=? WHERE bot_id=? AND status='sending' RETURNING id").all(now(), bot.botInfo.id);
    for (const row of uncertain) markNotices(String(row.id), 'unknown');
    bot.use(async (ctx, next) => {
      if (ctx.chat?.type !== 'private' || ctx.from?.is_bot || ctx.from?.id !== userId || ctx.chat.id !== userId) return;
      const inserted = db.prepare("INSERT OR IGNORE INTO telegram_updates(bot_id,update_id,status,updated_at) VALUES (?,?,'received',?)").run(bot.botInfo.id, ctx.update.update_id, now());
      if (!inserted.changes) return;
      console.error(`Telegram received update ${ctx.update.update_id}`);
      try {
        await next();
        db.prepare("UPDATE telegram_updates SET status='handled',updated_at=? WHERE bot_id=? AND update_id=? AND status='received'").run(now(), bot.botInfo.id, ctx.update.update_id);
      } catch (error) {
        db.prepare("UPDATE telegram_updates SET status='failed',updated_at=? WHERE bot_id=? AND update_id=? AND status='received'").run(now(), bot.botInfo.id, ctx.update.update_id);
        throw error;
      }
    });
    const queuedCount = () => db.prepare("SELECT count(*) AS n FROM telegram_updates WHERE bot_id=? AND session_id=? AND status='queued'").get(bot.botInfo.id, session.id)!.n;
    let cancelling = false;
    function startQueued() {
      if (stopping || work || cancelling) return;
      const turnSession = session;
      const next = db.prepare(`UPDATE telegram_updates SET status='running',updated_at=?
        WHERE bot_id=? AND update_id=(SELECT update_id FROM telegram_updates WHERE bot_id=? AND session_id=? AND status='queued' ORDER BY update_id LIMIT 1)
        RETURNING update_id,request_text`).get(now(), bot.botInfo.id, bot.botInfo.id, turnSession.id);
      if (!next) return;
      const { update_id: updateId } = next;
      const finish = (status: string) => db.prepare('UPDATE telegram_updates SET status=?,request_text=NULL,updated_at=? WHERE bot_id=? AND update_id=?')
        .run(status, now(), bot.botInfo.id, updateId!);
      const typing = () => bot.api.sendChatAction(userId, 'typing').catch(error => console.error(`Telegram typing: ${describe(error)}`));
      const heartbeat = setInterval(() => { void typing(); }, 4000);
      void typing();
      work = (async () => {
        let scope: Awaited<ReturnType<typeof prepareTelegramResearch>> | undefined;
        let replyDraft: Awaited<ReturnType<typeof openReplyDraft>> | void = undefined;
        let verifiedPreview: ReturnType<typeof streamVerifiedTelegramFacts> | undefined;
        let receipts: string[] = [];
        try {
          const text = String(next.request_text);
          const checksSource = /(?:调用|\bcall)\s*`?normalize_source_evidence\b/i.test(text) && text.includes('compare_source_evidence');
          const wantsRepeat = /重新调用|重测|重复比较|\brepeat\b/i.test(text);
          const fresh = '本条必须在当前轮次实际调用 normalize_source_evidence 和 compare_source_evidence，使用本轮工具返回的新 evidenceId。不要复述历史回执。';
          if (!checksSource) scope = await prepareTelegramResearch(db, turnSession.id, text);
          if (scope?.clarification || scope?.markets.length === 1 && asksSettlement(text)) {
            queue(`reply:${bot.botInfo.id}:${updateId}`, scope.clarification ?? await confirmedSettlement(db, scope.markets[0]));
            finish('completed');
            return;
          }
          if (scope?.review && scope.markets.length === 1) {
            const prices = await confirmedPriceWindow(db, text, scope.markets[0]);
            if (prices) {
              receipts = [prices.evidenceId];
              if (!stopping && !cancelling) queue(`reply:${bot.botInfo.id}:${updateId}`, prices.body);
              finish(stopping || cancelling ? 'aborted' : 'completed');
              return;
            }
          }
          const previous = scope?.followUp ? db.prepare(`SELECT o.body FROM telegram_updates u
            JOIN telegram_outbox o ON o.id='reply:' || u.bot_id || ':' || u.update_id AND o.bot_id=u.bot_id
            WHERE u.session_id=? AND u.update_id<? AND u.status='completed' AND o.status='sent'
            ORDER BY u.update_id DESC LIMIT 1`).get(turnSession.id, updateId!) : undefined;
          const previousReply = typeof previous?.body === 'string' ? previous.body.slice(0, 4500) : undefined;
          replyDraft = await openReplyDraft(turnSession.id, Number(updateId), !checksSource && !scope?.review,
            scope?.review ? ids => {
              if (!stopping && !cancelling) verifiedPreview?.add(ids);
            } : undefined)
            .catch(error => { console.error(`Telegram draft ${updateId}: ${describe(error)}`); });
          if (scope?.review && replyDraft) {
            verifiedPreview = streamVerifiedTelegramFacts(db, text, scope.markets, previousReply, body => {
              if (!stopping && !cancelling) replyDraft?.showVerified(body);
            });
          }
          const prompt = checksSource ? `${text}\n\n${fresh}` : scope?.prompt ?? text;
          let result = await turnSession.run(previousReply ?
            `${prompt}\n\n上一轮 Telegram 实际送达的文字（只用于理解指代，关键事实仍按原文核对）：\n${previousReply}` : prompt);
          if (scope) receipts = turnEvidenceIds(result);
          if (scope?.review) ({ result, receipts } = await collectNewsSources(db, turnSession, text, scope, prompt, result,
            () => stopping || cancelling));
          let currentReply = checksSource ? sourceComparisonReply(result, wantsRepeat) : undefined;
          if (checksSource && result.finishReason === 'completed' && !currentReply && !stopping && !cancelling) {
            result = await turnSession.run(`${text}\n\n上次没有生成可核对的本轮工具回执，请实际重做。${fresh}`);
            currentReply = sourceComparisonReply(result, wantsRepeat);
          }
          verifiedPreview?.finishSources();
          if (result.finishReason !== 'aborted') {
            const end = result.events.findLast(event => event.type === 'turn/end');
            const failure = end?.type === 'turn/end' && end.data.reason.kind === 'error' ? end.data.reason.error : undefined;
            const detail = failure?.code === 'CONTEXT_WINDOW_EXCEEDED'
              ? '模型上下文超出容量，自动压缩恢复未成功；已有查询证据仍保存在本地。'
              : failure ? describe(failure.message) : result.finishReason ?? '未知状态';
            const needsReview = scope?.review && (result.finishReason === 'completed' || receipts.length > 0 || scope.priorSources.length > 0);
            const reviewed = scope && needsReview ? await reviewResearchTurn(db, turnSession, text, scope, result, receipts,
              previousReply, () => stopping || cancelling, `reply:${bot.botInfo.id}:${updateId}`) : undefined;
            if (needsReview && !reviewed) { finish('aborted'); return; }
            const body = checksSource ? currentReply ?? '本次核对未取得新鲜的规范化和比较回执。请以工具产生的证据为准。'
              : reviewed ? reviewed.body || reviewed.gaps.join('\n')
              : result.finishReason === 'completed' ? result.finalResponse || '本次研究已结束，但没有生成回答。'
              : `${result.finalResponse && !scope?.review ? `${result.finalResponse}\n\n` : ''}本次研究未完成：${detail}`;
            if (stopping || cancelling) {
              finish('aborted');
              return;
            }
            queue(`reply:${bot.botInfo.id}:${updateId}`, body);
          }
          finish(checksSource && result.finishReason === 'completed' && !currentReply ? 'incomplete' : result.finishReason ?? 'unknown');
        } catch (error) {
          finish('failed');
          queue(`reply:${bot.botInfo.id}:${updateId}`, `本次研究失败：${describe(error)}`);
          console.error(`Telegram research failed: ${describe(error)}`);
        } finally {
          clearInterval(heartbeat);
          verifiedPreview?.stop();
          await replyDraft?.finish();
          if (scope && !scope.clarification) finishTelegramFocus(db, turnSession.id, scope.markets, receipts, scope.priorSources);
          await deliver();
        }
      })().catch(error => console.error(`Telegram result delivery: ${describe(error)}`)).finally(() => {
        work = undefined;
        startQueued();
      });
    }
    bot.command(['start', 'help'], async ctx => {
      queue(`reply:${bot.botInfo.id}:${ctx.update.update_id}`, telegramHelp());
      await deliver();
    });
    bot.command([...xNewsCommands], async ctx => {
      const name = ctx.message?.text?.slice(1).split(/[@\s]/, 1)[0];
      const command = xNewsCommands.find(item => item === name);
      if (!command) return;
      const reply = await queryTelegramXNews(command, ctx.match, callTool).catch(error => '查询失败 ' + describe(error));
      queue(`reply:${bot.botInfo.id}:${ctx.update.update_id}`, reply);
      await deliver();
    });
    bot.command('crypto_paper', async ctx => {
      let reply: string | undefined;
      if (ctx.match.trim() === 'stop') {
        const status = await callTool('get_personal_status') as {
          tasks: { id: string; version: number; cryptoPaper?: boolean; status: string }[];
        };
        const task = status.tasks.find(item => item.cryptoPaper && item.status === 'active');
        if (task) {
          await callTool('update_watch_task', { id: task.id, expected_version: task.version, action: 'cancel' });
          reply = 'BTC、ETH 模拟盘已停止。';
        } else reply = '当前没有运行中的 BTC、ETH 模拟盘任务。';
      } else if (ctx.match.trim()) {
        reply = '用 /crypto_paper 启动，或用 /crypto_paper stop 停止。';
      } else {
        const result = await callTool('create_watch_task', { crypto_paper: true }) as { id: string; alreadyStarted?: boolean };
        if (result.alreadyStarted) reply = 'BTC、ETH 模拟盘已在运行。';
      }
      if (reply) queue(`reply:${bot.botInfo.id}:${ctx.update.update_id}`, reply);
      await deliver();
    });
    bot.command('status', () => {
      const tasks = db.prepare('SELECT status,COUNT(*) AS count FROM watches GROUP BY status').all();
      const pending = db.prepare("SELECT COUNT(*) AS count FROM telegram_outbox WHERE bot_id=? AND chat_id=? AND status!='sent'").get(bot.botInfo.id, userId)!;
      return send(`当前${question ? '等待你的回答' : work ? '正在研究' : '空闲'}\n排队消息：${queuedCount()}\n模型：${process.env.PM_MODEL ?? 'Qwen3.8-27B'}\n持续任务：${tasks.length ? tasks.map(t => `${t.status} ${t.count}`).join('，') : '无'}\n未确认送达：${pending.count}\n对话：${session.id}`);
    });
    bot.command('cancel', async () => {
      const current = work;
      if (!current) { await send('当前没有正在进行的对话研究。持续任务可用自然语言指定暂停。'); return; }
      cancelling = true;
      try {
        const result = await cancel(session.id) as { error?: string; status?: string };
        if (result.error || result.status !== 'stopped') throw new Error(result.error ?? '未确认停止结果');
        await current;
        await send('当前研究已停止。已排队的消息会继续处理。');
      } finally {
        cancelling = false;
        startQueued();
      }
    });
    bot.command('new', async () => {
      if (work || queuedCount()) { await send('当前还有研究或排队消息，请等队列处理完后再开始新对话。'); return; }
      const nextSession = harness.session();
      await nextSession.getWorkingDirectory();
      saveSession(nextSession.id);
      session = nextSession;
      await send('新对话已开始。个人记忆、记录和持续任务继续保留。');
    });
    bot.command('retry', async () => {
      const rows = db.prepare("UPDATE telegram_outbox SET status='pending',error=NULL,updated_at=? WHERE bot_id=? AND chat_id=? AND status IN ('failed','unknown') RETURNING id").all(now(), bot.botInfo.id, userId);
      for (const row of rows) markNotices(String(row.id), 'pending');
      await send(`已安排重发 ${rows.length} 条；之前送达情况未知的消息可能重复。`);
      await deliver();
    });
    bot.on('message:text', async ctx => {
      const text = ctx.message.text;
      if (text.startsWith('/')) { await send('用 /help 查看功能清单和快捷命令。'); return; }
      if (question) { const pending = question; question = undefined; pending.resolve(text); return; }
      const updateId = ctx.update.update_id;
      const busy = Boolean(work || cancelling);
      db.prepare("UPDATE telegram_updates SET session_id=?,status='queued',request_text=?,updated_at=? WHERE bot_id=? AND update_id=? AND status='received'")
        .run(session.id, text, now(), bot.botInfo.id, updateId);
      startQueued();
      if (busy) await send('这条消息已排队，当前研究结束后会在同一对话处理。')
        .catch(error => console.error(`Telegram queue receipt failed: ${describe(error)}`));
    });
    bot.on('message', () => send('目前支持文字和市场链接；请把问题以文字发送。'));
    bot.catch(async error => {
      console.error(`Telegram update failed: ${describe(error.error)}`);
      queue(`error:${bot.botInfo.id}:${error.ctx.update.update_id}`, `处理消息失败：${describe(error.error)}`);
      await deliver();
    });
    await bot.api.setMyCommands([
      { command: 'start', description: '查看功能和示例问法' }, { command: 'help', description: '功能清单和示例问法' },
      { command: 'crypto_paper', description: '启动 BTC、ETH 5 分钟模拟盘' },
      { command: 'status', description: '查看研究和持续任务状态' },
      { command: 'new', description: '开始新对话，保留记忆和任务' }, { command: 'cancel', description: '停止当前研究' },
      { command: 'retry', description: '重发未确认送达的回复或提醒' },
    ], { scope: { type: 'chat', chat_id: userId } });
    await deliver();
    timer = setInterval(() => { void deliver().catch(error => console.error(`Telegram outbox: ${describe(error)}`)); }, 3000);
    console.error('Telegram polling ready.');
    startQueued();
    await bot.start({ allowed_updates: ['message'], drop_pending_updates: false });
  }

  async function stop() {
    stopping = true;
    clearInterval(timer);
    question?.resolve(null);
    if (bot.isRunning()) await bot.stop();
  }
  async function close() {
    await stop();
    await work;
    await delivery;
    db.close();
  }
  return { run, ask, stop, close, deliverPending };
}
