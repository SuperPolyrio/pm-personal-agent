import type { DatabaseSync } from 'node:sqlite';
import type { SportsParticipant } from './sports.js';

const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/(?<=\p{Script=Latin})(?=\p{Script=Han})|(?<=\p{Script=Han})(?=\p{Script=Latin})/gu, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliases = (p: SportsParticipant) => [p.name, ...(Array.isArray(p.aliases) ? p.aliases.filter(a => typeof a === 'string') : [])]
  .map(normalize).filter(Boolean);

export function tennisReplayDate(input: string) {
  const fields = /\b(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/u.exec(input);
  if (!fields) return;
  const [year, month, day] = fields[1] ? fields.slice(1, 4) : fields.slice(4, 7);
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const time = new Date(iso + 'T00:00:00Z');
  if (Number.isFinite(time.valueOf()) && time.toISOString().startsWith(iso + 'T')) return iso;
}

export function archivedTennisMatches(db: DatabaseSync, date: string, names?: string[]) {
  const rows = db.prepare(`SELECT event_key, data FROM (
    SELECT json_extract(s.data,'$.eventKey') AS event_key, s.data,
      ROW_NUMBER() OVER (PARTITION BY json_extract(s.data,'$.eventKey') ORDER BY s.retrieved_at DESC, s.id) AS newest
    FROM evidence s WHERE s.source='sports/snapshot' AND json_extract(s.data,'$.sport')='tennis'
      AND json_extract(s.data,'$.localDate')=? AND json_extract(s.data,'$.state')='final'
      AND EXISTS (SELECT 1 FROM evidence p WHERE json_extract(p.data,'$.kind')='tennis_wimbledon_points'
        AND json_extract(p.data,'$.officialDate')=? AND json_extract(p.data,'$.eventKey')=json_extract(s.data,'$.eventKey'))
  ) WHERE newest=1`).all(date, date);
  return rows.map(({ event_key, data }) => {
    const { competition, participants } = JSON.parse(String(data)) as { competition: string; participants: SportsParticipant[] };
    return { eventKey: String(event_key), competition, participants };
  }).filter(({ participants: [a, b] }) => {
    if (!a || !b) return false;
    if (!names) return true;
    const [left, right] = names.map(normalize);
    if (!left || !right || left === right) return false;
    const as = aliases(a), bs = aliases(b);
    return as.includes(left) && bs.includes(right) || bs.includes(left) && as.includes(right);
  });
}

export function tennisReplayPrompt(db: DatabaseSync, input: string): string | undefined {
  const archiveRequest = /逐分|每一?分|发球方|谁发球|买一卖一|买一[和与、/ ]*卖一|point.by.point/i.test(input);
  if (/新闻|报道|采访|战报|伤病|伤停|退赛|弃权|结算|最新|直播|订阅|提醒|\bnews\b/i.test(input)) return;
  const date = tennisReplayDate(input);
  const query = ' ' + normalize(input) + ' ';
  const matches = date ? archivedTennisMatches(db, date).filter(({ participants: [a,b] }) => {
    const mentioned = (name: string) => /\p{Script=Han}/u.test(name) ? query.includes(name) : query.includes(' ' + name + ' ');
    return aliases(a).some(left => mentioned(left) && aliases(b).some(right => right !== left && mentioned(right)));
  }) : [];
  if (!matches.length && !(archiveRequest && /网球|温网|澳网|法网|美网|\b(?:ATP|WTA|tennis|Wimbledon)\b/i.test(input))) return;
  const match = matches.length === 1 ? matches[0] : undefined;
  const points = [...new Set([...input.matchAll(/第\s*([1-9]\d{0,3})\s*分/g)].map(m => Number(m[1])))];
  const args = match ? JSON.stringify({ action: 'point_market', match_date: date, player_names: match.participants.map(p => p.name),
    ...(points.length === 1 ? { offset: points[0] - 1, limit: 1 } : {}) }) : null;
  return [
    input,
    '本轮使用体育历史档案。调用 tennis_research 的 point_market 查逐分与订单簿，按双方选手名和当地比赛日期定位。无需用户提供内部编号，也无需搜索新闻。档案缺失时按工具回执说明。',
    args ? '工具参数为 ' + args + '。如用户指定某分，按该分编号设置 offset（第 N 分为 N−1）和 limit。'
      : '从请求读取双方选手名和当地比赛日期。缺少其中一项时请用户补充。',
    '用户只给对阵和日期时，默认汇报完赛盘分、逐分及发球方覆盖、全场和首盘真实买一卖一覆盖和缺口，注明每个盘口已归档的选项。默认示例为首分，用户指定分号时展示所问分号。给出发球方、得分方、局内分、各盘口的买一卖一、交易所和档案接收时间及相对该分结束的时间差。附原始比赛、订单簿及每个盘口各自的链接。用户指定盘口或选项时按所问范围回答，缺档案时保留缺口。',
    '盘口是单边时只报可交易的一侧。订单簿原始买方字段 0 或卖方字段 1 计为该侧缺价。',
  ].join('\n');
}
