---
name: pm-public-data
description: Route Polymarket public data and wallet reconciliation questions, including fills, actual fees, partial orders, FIFO PnL, resolution, redemption, and credited payouts.
---

# Polymarket 自助查询

按用户问题选择接口。市场和选项不明确时先用 `resolve_market` 确认；事件有多个市场时列候选或按用户给出的子市场查。Local ID 用 `local:ID` 解析到 Gamma ID、condition ID 和 token。选项按明确标签对应 token，标题和数组顺序都不能代替身份核对。

| 想知道 | 查询方式 |
|---|---|
| 官方市场、规则或事件子市场 | `read_polymarket_public` 的 `market` / `event`，ID 用官方 slug 或 Gamma ID。 |
| 现在有哪些体育或电竞比赛正在进行，盘口如何 | 直接用 `read_polymarket_public` 的 `live_sports`，`id` 传分类标签，指定联赛或杯赛传 `competition`。问盘口传 `include_lines: true`，逐场报告官方参考价、接单状态和合约标题中的让分、让图或总数。沿 `pagination.next_cursor` 核对覆盖。按需补查同场的外部赛况。 |
| 现在买一、卖一、档位或点差 | `book`，给精确选项 token；知道 condition ID 时一并传入核对。用户问现在时直接查官方。若本地盘口过旧或不可用，也可单次直查官方。 |
| 明确只要一个市场与选项的官方盘口和书商原始赔率 | `lookup_market_odds`，传 Polymarket 链接与精确选项标签。日常问一场比赛的赔率时，按 `pm-forecast` 给出完整预测。事件或选项不明确时先确认，别用同队胜负盘替代让分，也别用其他线。 |
| 官方短窗口价格历史、近期成交 | `price_history` 用 token，`interval` 选 1h、6h、1d、1w，`fidelity` 用分钟；`trades` 用 condition ID 或公开钱包。按回执中的时间与粒度解释。 |
| 结算、公开钱包信息 | `resolution` 用 condition ID；`positions` / `activity` 用用户指定的公开钱包；`freshness` 查看 Data API 的数据时效。 |
| 我的成交、部分成交、实扣费用、期初及盈亏、结算后可兑付或已到账 | 直接调用 `reconcile_polymarket_portfolio`。使用用户明确指定的一个公开交易钱包、带时区的 `from`/`to`，可加市场链接、slug 或 condition ID。 |
| 长窗口、全量、榜单、跨市场统计、盘口历史或连续性 | 使用已加载 `market-data` 的 SQL 和既有 LOB 工具。复用对应历史数据定义，并报告覆盖缺口。 |

- 官方 `book` 返回一次 REST 快照。报告 `sourceTime`、`retrievedAt`、档位和时效；`continuousCoverage=unverified` 表示连续性未验证。盘口仅单侧、交叉、时间未知或过旧时如实说明。成交、目录参考价和买卖盘分别描述。
- 官方分页沿 `pagination.next_cursor`，仅按用户范围读取。预览截断与来源空结果分开说明。官方接口原始响应可用 `evidenceId` 和 `read_evidence` 复查。
- 用户明确只要原始报价时，列同盘口各书商及数据渠道的赔率，以及官方买卖各最多五档。
- 同一选项映射到多个书商结果时并列列出。没有同盘同线时，说明在 Polymonitor 保留的报价中未找到，并保留已经读取的官方数据。融合预测另用 `pm-forecast` 判定输入资格。

## 钱包对账

- 按用户时区把自然语言时间转换为带时区的区间。工具将时间统一为 UTC 的左闭右开 `[from,to)`。当前持仓是另外一次观察。钱包地址不明确时先确认。
- 已观察成交只能报告份数、价格、时间和交易引用。比例需要官方订单记录中的同一订单标识、原始量和累计成交量。部分成交可以与取消状态并存。实际费用使用逐笔回执。界面合计费用和现行费率不能充当逐笔实扣。
- 报告活动金额、FIFO 毛盈亏与可核对的同币种净盈亏。期初、转换分配、费用或历史标记缺失时，给出受影响的数量、金额和覆盖状态。分别回答最终结算、待兑付、已观察兑付、可核对到账。
- 用户可从本地传 `supporting_records`，或给明确的 `supporting_evidence_ids`。仅接受脱敏的结构化字段。每行给 `kind`、`source`、`wallet`、`conditionId`、`tokenId`、带时区的 `timestamp`。`fill` 加 `transactionHash`、`fillId` 或 `logIndex`、`side`、`shares`、`price`、`currency`，可加 `orderId`、`cashAmount` 和 `cashBasis`（`gross` 或 `net`）、`feeAmount` 和 `feeCurrency`。`order` 给 `orderId`、`originalShares`、`filledShares`（订单累计）、可选 `orderStatus`，若来源是有订单原始量与累计成交量的 `polygon_receipt`，再给交易哈希和日志索引。`redemption` 用 `polygon_receipt`，给 `transactionHash`、钱包到账或明确分配的 `logIndex`、`currency`、`creditedAmount`，可加有来源的兑付份数 `shares`。金额尽量传十进制字符串。来源字段是用户提供的文档声明。不要传凭据或任意文件路径。
- 首次回答给代表性明细、交易链接和报告 `evidenceId`。追问原始依据时先 `read_evidence({id: "报告 ID"})`，再按 `evidencePreview`、明细或来源覆盖里的证据 ID 读取原始页，使用 `rowIndex` 定位。上下文预览截断时，本地 `call read_evidence` 可回读完整报告和原始页。
