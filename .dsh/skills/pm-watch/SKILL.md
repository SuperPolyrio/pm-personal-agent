---
name: pm-watch
description: 筛选 Polymarket 市场并订阅同一条件，执行已授权持续研究任务，核对变化、个人判断和来源覆盖。
---

## 动态市场筛选与订阅

- 用 `screen_markets` 查 Polymarket 跨主题市场。传目录 `topic`、可与主题同用的 `region`、字面 `keywords` 数组、`open_only`、`min_volume_24h_usd`、`min_abs_trade_move_30m_pp` 和 `max_matches`。关键词和各筛选条件均为 AND。24 小时成交额来自 Gamma 目录各自的观察时间。30 分钟价格按同一选项 token 比较已审计窗口首末成交，报带符号的百分点、成交时间及窗口。回放的 `as_of` 需带时区并有同截点、同范围的已保存目录证据。挂牌时间缺少来源时保持未知。
- 报实际查询范围、检查数、命中数、未判定原因、截断情况、市场链接和 evidence ID。`max_matches` 只控制展示。需要更多行时用 `read_evidence` 的 `offset` 翻页，用 `view=metadata` 查看完整覆盖。稀疏、未审计或过期的样本保持未判定。
- 用户说“按这个条件盯 24 小时，每 5 分钟扫一次，有新符合发 Telegram”时，将已执行的规范化 `screen` 原样传到 `create_watch_task`，`interval_seconds=300`，到期时间带时区。`notify_on_initial` 默认 false。回报任务 ID、版本、周期、到期、初始策略和原生调度状态。程序定时重新筛选并比较最后有效状态。首次观察到的范围和市场真实挂牌是不同事实。
- 通过 `get_personal_status`、`read_run`、`read_evidence` 查看检查、覆盖、历史基线和通知凭据。用 `update_watch_task` 暂停、恢复、取消，或在暂停后编辑 `screen`。同条件恢复沿用最后有效状态。条件变化后建立新基线。通知的 `pending` 是已入队，`sent` 是 Telegram API 已确认发送。

## 已授权的单市场研究任务

1. 使用程序提供的本次执行 ID、任务最新版本、来源和通知约定；你就是执行者，running 不是等待别的任务。用 read_records 读取相关个人判断；上次成功检查由 read_watch_sources 的 previousComplete 返回。
2. 调用 read_watch_sources 读取约定来源，保存证据及程序计算的覆盖状态。来源约定包括 REST 路径、真实来源时间字段、时效阈值和质量字段条件，不能用响应生成时间代替。需要原文时可补充 web_fetch，访问失败必须记录。
3. 将新证据与上次成功检查比较，说明影响哪个判断前提。未知变动原因保持未知。首次检查用于建立基线，不把此前全部事件当新变化。
4. 来源过期、失败或覆盖不足时，finish_watch_check 只能使用 partial 或 failed。记录中断和不能补查的范围；检查周期不代表持续实时覆盖。
5. 调用 finish_watch_check 时必须提供 status、summary 和本次 evidence_ids；status 使用 complete/partial/failed。用户要求不通知或无符合条件的变化时，省略 notification 和 event_key，不把检查摘要重复塞进 notification。
6. 满足 notify_when 时才提供 notification，说明变化、影响、证据和时间；event_key 使用来源事件的稳定标识，转载或重试复用该标识，实质更正用新标识。
7. 通知先保存为 pending，由 Telegram 宿主发送；只有 delivery_status=sent 才表示 Telegram API 已确认发送，不能据此声称用户已读。failed 或 unknown 需要查看投递状态，不能把调度投递回执当研究成功。

## 通用 Market 盯盘

- 用真实市场解析结果确认市场及选项 token。事件页有多个候选时保留成员依据，只纳入用户指定或已授权的对象。读取用户关注理由及原判断版本。影响因素、规则判定事实、正式结果、市场结算和资金到账分别核对。规则有歧义时保留条款及未知项。
- 按交易、判定事实、影响因素、规则与阶段、监控质量组织监控项。为每项写清对象、原因、来源、口径、节奏、时效、触发与停止条件。成交使用同口径完整窗口和已按成交身份去重的指标，深度明确盘口侧、档位或价格距离。没有历史基线时展示预热或缺口。绝对差、相对百分比和百分比分数的百分点变化分别约定。
- 如果工具目录提供 `prepare_market_watch`，提交 `goal`、`items`、带时区的 `expiresAt`、`budget`（`maxRuns`、`maxModelCalls`、`maxToolCalls`）、`notify` 和可选 `quiet`。每个 item 至少需要 `id`、`kind`（`trading`、`fact`、`factor`、`lifecycle`、`quality`）、`marketId`、`sourceId`、`scope`、`reason`、`intervalSeconds`。交易数值另填 `tokenId`、`metric`、`maxAgeSeconds` 和可选 `trigger`。规则/判断用 `clauseId`、`recordRefs`，消费宿主已核对的授权和来源能力。通知 `mode` 为 `immediate`、`summary` 或 `record`，未确认线索默认继续核实；可按用户明确偏好指定质量提醒、低重要性分流及免打扰例外。草案结果只证明安排已经核对；计划创建、更新、暂停、在途取消和恢复以实际原生工具回执为准。
- 若本次原生任务明确采用通用流程且工具目录提供 `check_market_watch`，直接调用一次。它从宿主读取本次触发和已授权计划，按到期监控项读取、比较、提交。读取旧有效基线只作历史比较。分开说明未到期、来源阻断、预热、失败、中断恢复和本轮有效覆盖。阶段与改期附前后时间及证据，合约截止和事件安排分别保留。由单个明确的 `trackPhase` 监控项提供阶段来源，其他项可用 `phases` 配置按阶段的频率或停止。下一次应检查时间与 Schedule 实际唤醒时间分别展示。
- `market_catalog` 支持 `trading_status`（`kind=lifecycle`，阶段可为 `trading`、`orders_paused`、`closed`、`inactive`）和无历史窗口的 `catalog_quote`（`kind=trading`，`metric.kind=quote`、`priceType=catalog`、`unit=fraction`）。用户明确委托时，把同一会话的 `planEvidenceId` 作为 `plan_evidence_id` 交给 `create_watch_task`。暂停后的修改使用新草案凭据。普通摘要意图可在检查记录查看，免打扰延期按已指定的时间进入现有 outbox。
- 历史成交用 `sourceId=research_trades`、`scope=trade_window`、`kind=trading`，指定已解析的市场选项和 `metric`（`kind=trades`、`key=unique_log_events`、`measure=count`、`unit=logs`、`windowSeconds`）。滚动窗口以 T-A 已审计水位为结束边界。可用带时区的历史整秒 `tradeWindowEndAt` 固定结束时间，旧固定窗口可继续使用已登记的 `tradeProjectionEvidenceId`。窗口用 UTC 左闭右开。区块时间索引、原始日志审计和选项投影均通过核对才推进基线和评估阈值，同一水位重查不会增加有效样本次数。用 `read_run` 找覆盖记录，再用 `read_evidence` 回读窗口、投影缺失与未归属及其凭据。日志数按 `(tx_hash, log_index)` 去重。金额和份数窗口需另有 T-A 口径及覆盖凭据。
- `external_evidence` 支持已有可重读 HTTPS 原文的 `fact` 和 `factor`。先用 `web_fetch` 和 `normalize_source_evidence` 保存带实际源时间的规范化证据。在监控项的 `external` 填 `normalizedEvidenceId`、`factKey`、`sourceTimeKey`。规则项再用 `build_rule_card` 和 `assess_rule_evidence` 核对同一来源版本，填写 `clauseId` 及 `external.ruleAssessmentEvidenceId`。每轮重读来源并核对市场规则。原文变更或自然语言判断所依赖的正文变化时，保留原基线并标出待复核。时间点的字面谓词在经核实覆盖且同口径的新观测上可重新判定。规则核对状态与市场结算分开记录。
- 关注列表异动用 `read_watch_anomalies`。给已解析选项添加自动检查时，用 `kind=trading`、`scope=market_anomaly` 及 `sourceId=trade_anomalies` 或 `book_anomalies`，分别检查已审计五分钟窗的成交活跃度、前后半窗价格，以及当前可用盘口的点差与深度。成交价须复核窗口事件键，两半窗各至少五条；活跃度要有至少六个不重叠的完整样本。弱线索可设 `low=summary`，明显变化用用户授权的通知策略。`read_anomaly_detail` 打开证据与相关判断或持仓。`estimate_visible_execution` 按指定方向和份数估算可见盘口成本；盘口过期时说明缺口。`discover_price_moves` 扫描指定主题的研究候选并保留初筛口径。
- 用 `read_watch_digest` 查看每日待处理摘要，显示异常、来源缺口和到期判断。经用户委托用 `configure_watch_digest` 管理原生定时生成。引用实际证据和时间，摘要由宿主保存，供用户主动查看。
- 只提醒成交价波动时，用 `kind=trading`、`sourceId=trade_anomalies`、`scope=price_volatility` 和已解析选项。同一完整五分钟窗口比较前后半窗成交价中位数，也比较去掉两端各一成后的最高与最低成交价。任一差值达到 3 个百分点，或差值至少 0.2 个百分点且较高值至少为较低正值的 1.5 倍，即进入价格异动判断。每半窗至少五条核对过的价格，同一波动持续时去重。
- 大额成交用 `kind=trading`、`sourceId=polymarket_trades`、`scope=large_trade`、`intervalSeconds=300`、`maxAgeSeconds=600`，覆盖该市场的已核对选项。按官方主动方每笔成交的价格乘份数，至少 500 美元才提醒。等待成交后五分钟，使用前后各五分钟内同选项、不同链上交易的最近成交价核对价格跳动。参考价缺失或顺序有歧义时只提醒成交；价格比较沿用纯价格异动阈值。
- 通用检查的提交回执与基线、提醒意图绑定。用户未选中、仍待核实、重复与静默的变化保留相应决策。价格异动满足条件时可明确说明原因未知。连续次数只计新且有效的源记录。冷却期内的进入只记录抑制原因，条件持续成立时保持安静，后续按退出再进入或加重条件判断。提醒注明涉及对象、证据、真实源时间、取得和检测时间，以及关联条款、判断版本和后续待核实项。同源转载保留共同事件关联，确认升级、更正和撤回保留前次关系。
- 若通用工具尚未接线，沿用本页首段现有流程，明确它实际覆盖的项目。一次检查采用一条流程，使用实际存储和 outbox 回执区分已决策、已入队、发送失败、送达未知与 Telegram 已确认发送。
