---
name: pm-crypto-trading
description: 为 BTC、ETH 五分钟 Polymarket 模拟盘评估技术指标、选定入场条件，并说明观望与模拟成交的依据。
---

面向 BTC、ETH 的五分钟 Up/Down，先用 crypto_indicators 查看目录和可用数据。需要解释概率或市场规则时使用 pm-forecast 或 pm-research，需要查陌生的方法时用公开原始资料验证定义。139 项是候选池和观测目录。优先考虑可持续取得、参数含义明确、适合短周期且能相互补充的少量指标。用现有 TA20 双收盘 RSI/MACD、单指标方向和趋势过滤作为候选思路，通过对比选一套。选择后冻结规则到本轮结束。

TradingView 的 Technical Ratings 说明如何组合趋势及动量指标。MACD 文档解释柱值与信号线关系。Sullivan、Timmermann、White 的原始研究说明大量筛选技术规则会带来数据窥探偏差。官方描述可作定义和设计依据。五分钟盘的模拟成交、结算、费用和实测胜率以本地回执为准。

- https://www.tradingview.com/support/solutions/43000614331-technical-ratings/
- https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/
- https://doi.org/10.1111/0022-1082.00163

每个方向的条件必须同时满足，且真实 Chainlink 60 秒 TWAP 相对当场精确开盘值确认同一方向。冲突、数据延迟、规则字段缺失、报价不合格时观望。指标使用最近已收盘五分钟 K 线，两个收盘确认时同时检查最新值和前值。盘中重新核对实时 TWAP 和盘口。未校准概率仅展示。

启动程序只接受 JSON。字段为 name、reason、sources、up、down。up 和 down 各填写一至三项。每项使用 id、comparison（above、below、crosses_above 或 crosses_below）、threshold、confirmations（1 或 2），多值指标附 field。使用目录默认参数，从程序传入的字段白名单中选。sources 至少引用两项上面的原始资料。无法形成可靠规则时返回 {"abstain":true,"reason":"具体缺口"}。

执行器使用同一市场最多一个方向、最小份数的 Paper FOK。模型负责选规则和解释。订单归专用 PaperVirtualWallet，成交、未成交和未知分别按 Paper 回执显示。五分钟汇总按 Up 和 Down 展示各项策略阈值、实际数值、达标结果、观望原因和模拟盘回执。提交前用同一判定口径复核，保存这一刻的指标观测和 TWAP。内部任务和运行标识只保留在审计记录。
