---
name: pm-tennis
description: ATP／WTA 单打研究。查询红土、硬地、草地的发球接发、保发破发，用比分和发球率计算赢下一分后的局盘赛情景，复盘真实比分及盘口，核对退赛时的网球子盘。
---

## 赛前画像

用户给选手名即可。已有官方链接时直接调用 `tennis_research` 的 `profile`。否则用 `search_market_sources` 在 atptour.com、wtatennis.com 找官网选手页，核实全名和原生 ID。两位选手分别取相同赛季、场地、巡回赛的画像。

ATP 返回官网赛季场地汇总，包括发球局、接发局分母。分数的原始分母以工具覆盖为准。WTA 按同场地近期已完成主签单打，从逐场统计合并原始分子和分母，缺失某项统计时保留该项实际样本。WTA 默认 8 场，可指定 1–16 场。逐场回答时直接引用 tournament、result、opponent 和 scoreInPlayerOrder，比分按选手在前。出现 unmatchedHistory 时说明该场缺口，附 stats 原始 URL。先给发球分、接发分、保发和破发，再按提问给一发、二发和样本对手。比较历史百分比时交代赛季、场地与实际分母。当前读取的历史汇总用于资料研究，重建当时可见状态需要当时已取得的证据。

## 比分情景

用 `tennis_research.scenario` 做确定性计算。真实比赛先用 `sports_assistant.inspect` 核对唯一赛事，传 `snapshot_evidence_id` 采用源比分及下一分发球方。模型区分三盘两胜、五盘三胜、决胜盘 6–6 抢七、决胜盘 6–6 抢十、抢十替代决胜盘。按当届赛事规则或用户所述假设选择 `deciding_format`。拿不到实际分数、发球方或规则时，说明哪个字段缺失。

假设情景传双方顺序、已完成盘分、当前局分、当前网球分数和发球方。用用户给的双方发球分胜率，百分数应转为小数。如用户明确要求用两份历史画像作为假设，可按 A、B 顺序传两个 `profile_evidence_ids`。给出当前、A 赢下一分、B 赢下一分的概率，重点回答用户关心的局、盘或全场。下一分后的比分直接引用 `nextPoints`；`completedBy` 有值时直接说该球员拿下当前局或抢七。所有概率均假定按指定赛制打完，历史发球率未经对手校准。

用户问总盘数时再列 `totalSetsOfBothPlayers`，每项是双方合计打了几盘的概率，与胜者无关。用户没问总盘数时省略。只报工具给出的下一分结果和所问概率。

## 复盘、子盘与提醒

找真实赛事和精确市场统一走 `sports_assistant`，优先使用市场链接、赛事键、条件 ID 或结果 token。核对赛程、实际开球、停赛恢复、退赛和盘局分。只有明确要求持续提醒时才走 `watch_draft` 和原生任务。单独读取盘数合约条款，查已开始盘、完赛盘、退赛和期限，与平台实际结算分别回答。

用 `tennis_research.timeline` 按赛事键读取已存快照。当前分数、占先方和发球方按 tool 的 `pointsByPlayer` 引用。比分中的 A 表示 Advantage，归属以 `advantage` 标记为准。用户指定截止时传带时区的 `as_of`，只用当时已经取得的数据。比较盘口时应锁定同一 condition 和 token，列明比分源时间、盘口源时间和时间差。成交用现有公开交易工具按同一 token 和窗口另查。离散快照可以定位比分差异，逐分顺序、持续盘口和价格变动原因需要相应原始证据。用户需要过去时点的原始比分时，交给 `sports_assistant` 回放。

时间线照录 `participants[].name` 的原名。用户明确给出名字时可以沿用其叫法。比分源观察时间用 `scoreBeijingTime`，比分采集时间用 `scoreCaptureBeijingTime`，报价源时间用报价的 `beijingTime`。源时间为空时，按采集时间回答并注明源未给更新时间。保发和破发直接引用 `gameChanges` 的 winner 和 label。有缺口时只报告已观察到的盘、局、分。

用户用双方姓名和当地比赛日期问历史逐分或盘口时，直接调用 `tennis_research` 的 `point_market`，传 `player_names` 和 `match_date`。一次返回所有已归档的全场和单盘胜负选项，按市场与选项分别报告，明确缺失的选项或盘。只给姓名和日期时默认报完赛比分、逐分和发球方覆盖、全场和首盘报价覆盖，并列第 1 分的报价和时间差。用户指定分号时，第 N 分传 `offset=N−1` 和 `limit=1`。查连续若干分可分页，按 players 顺序读盘局分、发球方和得分方，示例引用 `pointSummary`。

按已有精确选项凭据复查时可传 `snapshot_evidence_id`，工具会查找同场、同 condition 和同一选项 token 的档案。也可指定 `point_archive_evidence_id` 和 `book_archive_evidence_id`。

有温网官方逐分和 PMXT 订单簿时，直接引用 `scoreSummary` 与 `coverageSummary`，按 `missingQuotePoints` 报告报价缺口。双边报价按已绑定 token，检查每分结束前 30 秒内收到的最后一条订单簿状态。存在 `incompleteBook` 的分缺少可交易的买一或卖一。分别给温网该分结束时间、交易所时间、档案接收时间及两种时间差。温网逐分时间精度为秒，毫秒时间差用于对齐档案。后续盘超出指定单盘范围。给原始比赛档案、市场和 PMXT 链接。

只有离散逐分样本时传 `point_archive_evidence_id`。空的 server 表示发球方未核实，仅把 `one_point` 行算作单分变化。报告有效逐分、跳分、全场分母和价格覆盖。CLOB 采样价最多领先比分采集 90 秒，明确该路径的逐分事件时间和买一卖一缺口。

## 可直接提问

- 比较辛纳和阿尔卡拉斯 2026 年红土的发球得分、接发、保发、破发，告诉我分母。
- 假设三盘两胜、决胜盘普通抢七。盘分 1 比 0，第二盘 4 比 4，A 在 30 比 40 发球。A、B 发球分胜率分别 65% 和 60%。下一分两种结果对 A 的胜局、胜盘、赢比赛各有多大影响？
- 复盘这场已经保存的盘局分和对应子盘报价。分别给比分源和盘口的时间，没采到的逐分直接标出来。
- Shymanovich 对 Golubic，2026 年 6 月 30 日。
