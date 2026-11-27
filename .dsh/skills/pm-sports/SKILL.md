---
name: pm-sports
description: 用同一个体育工具查赛事、场上事实、对应的 Polymarket 子盘和持续提醒。覆盖 NBA、网球和 CS2。
---

使用 sports_assistant。sport 填 nba、tennis 或 cs2。先用 find 找唯一赛事，再使用 inspect 与 event_key；用户给市场链接时可在一次 inspect 中定位。查询下一场时用球队、球员全名或已知别名。找同日赛事时加日期；有多个候选时给出对阵和时间并请用户选定。事件页含多个子盘，按用户提供的选项、阈值、condition_id 或确切子盘核对。

NBA 查询示例

- 雷霆下一场对谁？给我当地时间、北京时间和官方伤病状态。
- 查 SGA 最近五场首发、出场和贡献。这场现在第几节，他几个篮板？
- 核对这个 SGA 篮板 4.5 子盘，分别给胜负阈值、赛中确认要求和平台状态。[子盘链接]
- 订阅 SGA 下一场的官方伤病更新和首发确认，每五分钟检查，到北京时间 [截止时间]。

注明队伍和球员原生 ID、数据来源、观察时间、版本和证据 ID。预计首发、已确认首发、实际上场分别回答。缺失、未出场和零统计分别回答。ESPN 数据可补充赛况，NBA 官方规则只用合格的 NBA 证据。记录过线进度、官方确认、首份 Game Book 及更正冻结所用凭据。当前终场版本可以用于历史核对；首发 Game Book 或此前赛中版本无法证明时保留待核实。按精确 condition 和 token 分开报告盘口、规则采用值和平台实际结算。

网球查询示例

- 查辛辛那提辛纳对阿尔卡拉斯何时开打、退赛比分和该市场的实际结算。[子盘链接]
- 查 [选手] 下一场，给赛事、轮次、场地和赛程原文。区分固定时间、Not Before 和前序赛结束后开打。

ATP 和 WTA 按来源核对日程、开打、盘局比分和退赛。当前分数、发球方、历史逐分分别报告覆盖。可用条件含 schedule_changed、match_started、match_suspended、match_resumed、break_of_serve、set_completed、retirement，是否可订阅取决于该场来源和条件回执。

CS2 查询示例

- 查 Elusive 对 Villainous 的 CS2 对阵、BO 和各图进度。有原始禁选记录也给我。
- 查这场的回放，别剧透。[赛事键]。调用时设 no_spoilers=true。

GRID 转报用于对阵、赛程及可用分图。只有实际取得适用原始记录时才报告确认禁选、替补或依据 HLTV 规则判定的结果。可用条件含 series_started、map_started、map_completed 及已覆盖的赛程和阵容变化，使用草案回执确认实际生效范围。

只有明确持续订阅请求才调用 watch_draft。NBA 条件如下，每项 target 可填已核对的 NBA 球员 ID、球队 ID 或唯一名称。

- injury_status_change · 球员或球队
- starting_lineup_confirmed · 球员或球队
- stat_threshold · 球员，metric 为 rebounds、points 或 assists，threshold 为数字，operator 为 gt、gte、lt、lte 或 eq，require_official 为布尔值
- official_stat_confirmed · 球员与指标，绑定篮板盘时按该子盘的来源条款判定
- stat_corrected · 球员与指标，比较官方终场版本

确认 acceptedConditions、blockedConditions、minIntervalSeconds 和来源。按用户实际授权的条件将 sports_watch_evidence_id、interval_seconds、带时区的 expires_at 交给 create_watch_task。任务绑定当前已选赛事。首次有效观察建立基线，之后仅有有效新版本和变化才提醒。回执给任务 ID、调度、下次运行和到期；用 get_personal_status、update_watch_task、read_run、read_evidence 管理和回查。

mode=replay 只使用 source_evidence_ids 和带时区的 as_of。用已经保存的相应时点原始证据；回放不能创建实时任务。
