---
name: pm-x-market
description: 核对 X 计数、发帖、标签、头像等合约，读取公开 X 帖子、XTracker 观测及 EQN 加密快讯。
---

用户只问 X 或加密消息的现实进展时，直接核对事实。用户问合约口径时，用 resolve_market 定位单市场，保存规则证据。事件页有多个档位时选用户指定档位。复杂条款可用 build_rule_card 梳理，用 normalize_source_evidence 对齐原文、事实和时间，必要时走现有规则事实核对入口。引用规则原文确定账号或稳定 ID、来源与替换条件、起止和时区、边界包含性、帖子类型、正文要求及例外。区分规则规定的观察窗口与市场创建、关闭和结算时间。纽约本地时间按 America/New_York 换算，提交带实际偏移量或 UTC 的 ISO 8601。

## 观察 X 帖子

- read_x_posts(action=timeline, handle, start?, end?, limit?) 默认通过本地 x_reader.py 读一个账号的近期样本。标明实际采样首尾、上限和失败原因。置顶帖按原始发帖时间进入过滤。观察到旧置顶帖不能建立期间连续覆盖。
- read_x_posts(action=post, post) 优先走 OpenCLI thread，以字符串 ID 精确匹配目标。目标链接有账号时可补近帖采样，按来源和覆盖解释取得的是帖子详情还是时间线中的同一条。回复关系、稳定用户 ID、完整引用正文以来源实际字段为准。
- read_x_posts(action=search, query, handle?, start?, end?, limit?) 用 OpenCLI Latest 搜索，按实际作者和时间再次过滤。只有现成可用的 Grok2api 才用于发现 x_post 候选，将候选链接按 ID 回查。搜索空样本、桥接断开、授权缺失或时间窗仅部分覆盖时，说明实际状态。只有可用的 X 官方配置才可补读，并标明实际来源。
- 判断指定帖时分别写资格和实际计入。资格用 qualifies、does_not_qualify 或 insufficient_evidence，引用条款和具体作者、时间、正文和关系。实际计入用指定来源返回的帖子 ID 记录。未知类型、时间线账号归属或截断正文可能需要再查。authorTextBasis 标记归属未确认时，继续核对作者正文。作者自己的文字与被引用帖分开。只在引用对象中出现的标签不能满足作者自己标签的条款。必要时再读被引用帖 ID 核查全文。
- 头像或简介核对记录规则基线链接、当前资料来源和时间。XTracker account.avatarUrl 是 tracker 资料快照，标注 trackerLastSyncAt。X 原帖中的 author.avatarUrl 只代表本次页面返回的作者资料。判断期间变化需要窗口内历史观察。仅能取到当前资料时保留期间变化未知。

## XTracker 计数

规则指定 XTracker 时，调用 read_xtracker_count(handle, start, end, market_evidence_id 或 market_url)。核对平台 X、账号、事件市场链接和原始起止。数值档位共用同事件 tracking。市场规则截止于纽约中午且同事件 tracking 在前一秒结束时，可按工具返回的边界依据理解为最后可计秒。其他差异、多个候选或缺少必要字段时保留回执中的状态并核实。按 count 和 countRetrievedAt 报告 Post Counter 观测，距离目标下限按 max(0, 目标下限 - count) 计算。需要最终结算时读取官方结算证据。

核对指定帖时传 action=posts 和 post_id，记录匹配的 tracking、时间窗、帖子 ID 与 records.targetObservation。未在响应看到目标仍需结合数据范围和 tracker 时效。可以用同一窗口的页面 Post Counter 或 Export Data 对账，记录各自观察时间和差异。马斯克计数例的普通回复、主时间线回复、已被抓到的删帖和社区转发以该市场条款分别处理。黄仁勋的发帖例明确把回复列入资格范围。后续规则和补充说明以实际市场为准。仅当条款给定的切换条件有证据时使用备用来源。

## EQN 快讯

用 read_eqn_news(action=channels) 查实际频道。用 action=list 按 channel、coin、query 和 ISO 时间窗口筛选，查 start（含）至 end（不含）的快讯，按 nextCursor 和相同过滤条件续读。coin 依赖 EQN 的币种标签。需要补查缺标的异动时，按频道和时间读，并检查正文里的交易对。查看实际扫描起止、页数、截断、关键词近 30 天索引限制与失败状态。按编号用 action=get 读正文和原始结构化信息。

### X 人物动态

- 用 read_eqn_news(action=list, x_handle, x_event?, x_target_handle?, x_post_id?) 查询已发布的 X 动态。x_handle 指动作发起者，x_target_handle 指关注关系的目标。已核对账号为马斯克 @elonmusk（elon 频道）、CZ 或赵长鹏 @cz_binance（cz 频道）、何一 @heyibinance（cz 频道）。例如查何一最近一条，用 action=list、channel=cz、x_handle=heyibinance、limit=1。main 和 tradfi 里的 X 原帖也可以按原帖账号或 ID 查。时间过滤用 EQN 发布时间。人物频道用 REST，公开 WebSocket 的推送范围是主频道。
- 按 xEvent 区分原创、回复、引用、转发、新关注和取消关注。get 优先用 EQN 单条结构化数据，保留稳定账号 ID、实际发帖时间及关注前后状态和计数。列表可根据来源标签识别类型；仅见 X 链接时类型保留 unknown，例如一些旧的 Elon Tweet 标签。需要确认时按 no 查详情。有 eventTypeGaps 的检索保留类型覆盖缺口。
- 查询某帖时可用 x_post_id 对齐 EQN、X 原帖与 XTracker。EQN 的转发或回复标签是 EQN 的观测，引用对象和回复目标仍按各源实际字段核对。关注事件中的 X 资料页是目标账号入口，关系变更依据是 EQN 事件回执。关注数量是发起账号主动关注数。公开频道只覆盖 EQN 已发布的动态。合约计入按该市场的指定来源验证。

用户明确要求持续推送时，用 create_watch_task 的 eqn 参数订阅，可填 handles（多个账号）、event_types、target_handle、channel、coin 或 query。query 匹配 EQN 中英文快讯文字。EQN 订阅默认每 5 分钟检查、持续 24 小时，按用户指定的 interval_seconds、带时区的 expires_at 覆盖。从订阅创建时间起读取，后续按新条目或原帖 ID 去重，遇分页积压继续处理；没有符合的新记录时保持安静。回报实际任务 ID、下次检查和到期时间。通过 get_personal_status 查看调度与最近结果，用 update_watch_task 管理订阅。Telegram API 的送达以通知状态为准。

按发布时刻、频道、币种、来源声明、原始入口、核验状态和证据 ID 回答。用 web_fetch 核验 originalUrl、存档和发布方正文，并保留各自的证据编号。AI 摘要只供定位。人物频道用原帖关系核对原帖、转发与引用。交易所公告区分现货、Alpha、充提、费率和活动，标题分类只供核验。异动消息说明交易场所、交易对、指标、回看周期和原文缺失。快讯与 X 转述指向同一公告时沿原始链接合并。现货开盘需正式现货公告、同一项目与资产标识、交易对和实际开放时间。RIVER 17187 所指公告存档对应 Binance Alpha 竞赛，用其活动正文支持竞赛结论。

按 pm-output 的纯文本规范呈现，给出可打开的原文链接。内部存证用 read_evidence 回查。
