import { xEventTypes, xHandle, type EqnNewsItem } from './eqn-news.js';

export type TelegramToolCall = (name: string, args?: object) => Promise<unknown>;
export const xNewsCommands = ['x', 'eqn', 'xcount', 'eqnsub'] as const;
type Command = typeof xNewsCommands[number];
type Receipt<T> = { evidenceId: string; data: T };
const beijing = (at: string) => new Date(at).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' 北京时间';

function eqnLine(item: EqnNewsItem) {
  return [beijing(item.publishedAt), item.title?.slice(0, 600), item.eqnUrl, item.originalUrl].filter(Boolean).join('\n');
}

function xCountWindow(rules: string) {
  const handle = rules.match(/\(@([\w]{1,15})\)/)?.[1];
  if (!handle || !/https?:\/\/xtracker\.polymarket\.com\b/i.test(rules)) return;
  const date = '(\\w+ \\d{1,2})(?:,? (20\\d{2}))? (\\d{1,2}):(\\d{2}) (AM|PM) ET';
  const match = new RegExp('\\bfrom ' + date + ' to ' + date, 'i').exec(rules);
  if (!match || !match[7]) return;
  const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium' });
  const day = (value: string) => Date.parse(value + ' 2000 UTC');
  const endYear = Number(match[7]);
  const startYear = match[2] ? Number(match[2]) : endYear - Number(day(match[1]) > day(match[6]));
  function utc(day: string, year: number, hour: string, minute: string, period: string) {
    const midnight = Date.parse(day + ' ' + year + ' UTC');
    if (!Number.isFinite(midnight) || +hour < 1 || +hour > 12 || +minute > 59) return;
    const wall = midnight + ((+hour % 12 + (period.toUpperCase() === 'PM' ? 12 : 0)) * 60 + +minute) * 60_000;
    const expected = new Date(wall).toISOString().slice(0, 19).replace('T', ' ');
    const matches = [4, 5].map(offset => new Date(wall + offset * 3_600_000)).filter(value => clock.format(value) === expected);
    return matches.length === 1 ? matches[0].toISOString() : undefined;
  }
  const start = utc(match[1], startYear, match[3], match[4], match[5]);
  const end = utc(match[6], endYear, match[8], match[9], match[10]);
  return start && end && start < end ? { handle, start, end } : undefined;
}

export async function queryTelegramXNews(command: Command, input: string, call: TelegramToolCall) {
  const [first, ...args] = input.trim().split(/\s+/);
  const read = async <T>(name: string, args: object) => await call(name, args) as Receipt<T>;
  if (command === 'x') {
    if (!first) return '用法 /x @账号 或 /x X原帖链接';
    const handle = xHandle(first);
    const receipt = await read<{ posts: { createdAt: string | null; url: string; authorText: string | null; sourceText?: string | null }[];
      status: string; attempts: { source: string; reason?: string }[] }>('read_x_posts', handle && !/^\d+$/.test(handle) ?
        { action: 'timeline', handle, limit: 5 } : { action: 'post', post: first });
    const post = receipt.data.posts[0];
    return (post ? [post.createdAt && beijing(post.createdAt), post.authorText ?? post.sourceText, post.url].filter(Boolean).join('\n')
      : 'X 读取状态 ' + [receipt.data.status, ...receipt.data.attempts.flatMap(a => a.reason ? [a.source + ' ' + a.reason] : [])].join('，')) +
      '\n证据 ' + receipt.evidenceId;
  }
  if (command === 'eqn') {
    const target = !first ? { action: 'list', limit: 5 } :
      /^\d+$/.test(first) ? { action: 'get', no: Number(first) } : first.startsWith('@') ? { action: 'list', x_handle: first, limit: 1 } :
      { action: 'list', channel: first, limit: 5 };
    const receipt = await read<{ item?: EqnNewsItem; items?: EqnNewsItem[]; status: string; reason?: string }>('read_eqn_news', target);
    const items = receipt.data.item ? [receipt.data.item] : receipt.data.items ?? [];
    return (items.length ? items.map(eqnLine).join('\n\n') :
      [receipt.data.status === 'unavailable' ? 'EQN 暂不可读' : '本次样本无匹配快讯', receipt.data.reason].filter(Boolean).join('，'))
      + '\n证据 ' + receipt.evidenceId;
  }
  if (command === 'xcount') {
    const [start, end, marketUrl, target] = args;
    const usage = '用法 /xcount Polymarket市场链接 [目标条数]\n也可用 /xcount @账号 开始ISO时间 截止ISO时间 [市场链接] [目标条数]。时间须带 UTC 或偏移量。';
    let input: object, threshold = target;
    if (first.startsWith('https://') && args.length <= 1) {
      const market = await read<{ status: string; rules?: string }>('resolve_market', { input: first });
      const window = market.data.status === 'found' && xCountWindow(market.data.rules ?? '');
      if (!window) return '这条规则未解析出明确的 XTracker 账号和时间窗。\n' + usage;
      input = { ...window, market_evidence_id: market.evidenceId };
      threshold = start;
    } else {
      if (!first || !start || !end) return usage;
      input = { handle: first, start, end, market_url: marketUrl };
    }
    const receipt = await read<{ count?: number; countRetrievedAt?: string; trackingId?: string; status: string; reason?: string }>(
      'read_xtracker_count', input);
    const d = receipt.data;
    return [d.count === undefined ? [d.status, d.reason].filter(Boolean).join('，') : `XTracker 已计 ${d.count} 条`,
      d.count !== undefined && /^\d+$/.test(threshold ?? '') && `距离 ${threshold} 条还差 ${Math.max(0, Number(threshold) - d.count)} 条`,
      d.countRetrievedAt && beijing(d.countRetrievedAt), d.trackingId && 'Tracking ' + d.trackingId, '证据 ' + receipt.evidenceId].filter(Boolean).join('\n');
  }
  if (!first || first === 'pause' || first === 'resume') {
    type Task = { id: string; version: number; goal: string; status: string; nextCheck?: string; eqnWatch?: object };
    const status = await call('get_personal_status') as { tasks: Task[] };
    const watches = status.tasks.filter(w => w.eqnWatch);
    if (!first) return watches.map(w => [w.goal + ' · ' + w.status, w.id, w.nextCheck && '下次 ' + beijing(w.nextCheck)].filter(Boolean).join('\n')).join('\n\n')
      || '当前没有 EQN 订阅。用法 /eqnsub @账号[,另一个账号] [分钟] [小时] [follow,unfollow]';
    const watch = watches.find(w => w.id === args[0]);
    if (!watch) return '找不到该 EQN 订阅。用 /eqnsub 查任务 ID。';
    const changed = await call('update_watch_task', { id: watch.id, expected_version: watch.version, action: first }) as { task: Task };
    return watch.goal + ' · ' + changed.task.status;
  }
  const [minutes = '5', hours = '24', kinds] = args;
  if (!/^\d+$/.test(minutes) || !/^\d+$/.test(hours) || +minutes < 1 || +hours < 1 || +hours > 720) {
    return '用法 /eqnsub @账号[,另一个账号] [检查间隔分钟] [订阅小时] [follow,unfollow]。间隔至少 1 分钟，时长 1 至 720 小时。';
  }
  const eventTypes = kinds?.split(',');
  if (eventTypes?.some(kind => !xEventTypes.some(type => type === kind))) return '可用类型 ' + xEventTypes.join('、');
  const scope = first.startsWith('@') ? { handles: first.split(',') } : { channel: first };
  const watch = await call('create_watch_task', { eqn: { ...scope, event_types: eventTypes }, interval_seconds: Number(minutes) * 60,
    expires_at: new Date(Date.now() + Number(hours) * 3_600_000).toISOString() }) as { id: string; status: string; nextCheck?: string; expires_at: string };
  return [watch.status === 'active' ? 'EQN 订阅已生效，有新动态才推送。' : 'EQN 订阅状态 ' + watch.status,
    '任务 ' + watch.id, watch.nextCheck && '下次检查 ' + beijing(watch.nextCheck), '到期 ' + beijing(watch.expires_at)].filter(Boolean).join('\n');
}
