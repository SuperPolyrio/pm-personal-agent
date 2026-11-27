# Polymarket Personal Agent

一个在 **Telegram 私聊和终端里使用的 Polymarket 研究与盯盘助手**。你可以用中文找市场、查盘口和历史成交、核对结算条款和现实事件、对账公开钱包，也可以把同一套条件保存成持续任务。覆盖 NBA、网球、CS2、天气、Crypto、X 和 EQN，按各自的数据来源做专题查询、复盘和提醒。

可以直接发“找开放的美国通胀市场，24 小时成交额超过 5 万美元的列出来”，也可以贴一个市场链接，问“实际结算用什么来源”“买入 Yes 500 份要花多少”“这个条件以后满足了告诉我”。

[市场、规则与证据](#市场规则与证据) · [盯盘与提醒](#盯盘与提醒) · [体育与赔率](#体育与赔率) · [天气](#天气) · [Crypto](#crypto) · [X、XTracker 与 EQN](#xxtracker-与-eqn) · [钱包与个人研究](#钱包与个人研究) · [从零启动](#从零启动)

## 市场、规则与证据

| 功能 | 可以直接这样问 | 会得到什么 |
| --- | --- | --- |
| 找市场和事件子盘 | “找开放的美国通胀市场。这个事件页有哪些子盘和选项？” | 按主题、地区、关键词和开放状态查目录，定位事件、市场和选项。链接有多种候选时列出对应关系。 |
| 多条件筛选 | “找开放的美联储相关市场，近 24 小时成交额至少 5 万美元，且近 30 分钟某个选项的成交参考价变化至少 5 个百分点。” | 按组合条件筛选。区分 Gamma 的滚动成交额和同一选项的已审计成交价窗口，列出命中、未判定及数据覆盖。 |
| 查官方盘口和估算成本 | “查 [市场链接] 的 Yes 买卖各五档，再估算按现价买到 500 份的成本。” | 按精确选项读取买一、卖一、点差、深度与报价时间，逐档计算可见份数、均价和费前金额。盘口过旧、仅单侧或深度不够时显示可确认的部分。 |
| 查成交、价格历史与异动 | “过去 24 小时这个选项是怎么变的？最近半小时还有哪些同主题市场波动较大？” | 按实际窗口查询价格历史、首末成交参考价、成交明细、活跃度和异动候选。长窗口或逐笔研究可查已有历史库，分别说明采样、成交和采集覆盖。 |
| 结算规则卡与实际结算 | “这个市场在什么情况下算 Yes？采用哪个来源、哪个时区？现在实际结算到哪一步了？” | 从规则原文抽取对象、统计口径、窗口、阈值、例外和备用来源。另查已有 Oracle 或官方记录，区分交易状态、提议、挑战及实际结算。 |
| 对照多个合约或规则版本 | “这两个标题差不多的市场，哪些情况会给出不同结果？它的规则和上次相比改了什么？” | 对照同一情景下的条款和选项，标出可改变结果的差异。对已保存的前后快照比较规则文本、澄清和依据。 |
| 查现实进展和一手资料 | “查这场选举最近有什么变化，找两份独立原文，说清各自证实了什么。” | 可以从主题直接查，也可以从市场链接展开。检索并阅读官方、媒体等原文，合并重复报道，附链接、时间及还待确认的事实。 |
| 查宏观公布与政府文件 | “查美国这期 PCE 的发布时间和 BEA 原文，和上期相比怎么变了？” | 有适用来源时定向查 BEA 发布及日历、FOMC 会议或利率页面、选举公报等。按文件的实际期次、统计单位、发布时间和修订口径回答。 |
| 核对指定来源和规则事实 | “这份公告能证明这个市场的哪个条件？它是初稿还是最终版？” | 核对原文中的主体、时点、单位、版本和适用条款。已接入的官方直查包括 GovInfo 法案记录、航空气象观测、Binance 现货 K 线，以及符合条款的已结束 BTC 五分钟 Chainlink TWAP 市场公开起止参考价。 |
| 复查和继续分析证据 | “打开 [证据 ID]，给我原文，再在刚才筛出来的那批市场里按成交额重新排序。” | 回读已保存的原始资料、规则、行情、查询和比较结果。续问可以只重算上一次选集；长窗口或跨市场分析使用只读 SQL 和隔离 Python。 |

## 盯盘与提醒

可以盯**一个市场、同一事件的指定子盘，或一组持续变化的筛选结果**。下列问法可以直接发送。

| 想监控什么 | 可以直接这样问 | 触发依据 |
| --- | --- | --- |
| 新命中筛选条件 | “每天都盯开放的美国通胀市场，每 5 分钟查一次，未来 24 小时有新市场符合这组筛选条件才发我。” | 首次有效筛选默认建立基线，后续对比新进入条件的市场。 |
| 成交和盘口变化 | “盯 [市场链接] 的 Yes 两小时，查成交价异动、点差拉宽和买盘深度变化。” | 已核对的成交窗口或合格盘口。可按任务设置即时提醒、记入摘要或只记录。 |
| 大额成交 | “盯 [市场链接] 的大额成交，有单笔至少 500 美元的成交就提醒我，并核对之后价格有没有跳动。” | 官方成交按价格乘份数计算，价格变化使用同选项、已核对的前后成交样本。 |
| 规则、事实和阶段变化 | “查这条官方公告，能按稳定来源监控的话，有更新或结算状态变化时告诉我。” | 支持市场交易阶段、已绑定的规则与事实来源，以及来源覆盖变化。按已确认的对象、字段和口径重复检查。 |
| 专题条件 | “SGA 首发确认后告诉我”“这个气象站最高温跨档时提醒”“BTC 15 分钟 RSI 上穿 70 再提醒”“这个 X 账号发新帖时通知我”。 | 各领域用已核对的选项、来源时间和该类型实际支持的条件。体育、天气、Crypto、X/XTracker 和 EQN 各有对应处理。 |
| 异常和每日待处理摘要 | “看我关注市场最近 24 小时的异动、失效判断和来源缺口。每天北京时间晚上 8 点生成摘要。” | 按任务及证据回读成交、盘口或事实变化，关联已登记的判断与持仓。摘要可按日期查看。 |

任务创建回执给出**任务编号、状态、下次检查和到期时间**。可以问“列出我的任务和上次结果”“暂停任务 [编号]”“恢复任务 [编号]”“现在检查一次”或“读一下这条异常的依据”。引用一条可识别的 Telegram 推送，也可以按实际任务支持的设置修改周期、延长、暂停、恢复或立即检查，合并推送可按任务名或编号指定。

检查只在收到合格的新数据时评估对应条件。运行回执区分首次基线、未命中、数据过期、缺样本和读取故障。通知回执另列已入队、已发送、失败或送达未知。定时检查的频率由任务约定和数据源能力共同决定。

## 体育与赔率

赛事助手覆盖 **NBA、ATP/WTA 网球和 CS2**。可以按队名、球员名、日期、赛事或 Polymarket 链接查。Polymarket 正在进行的体育和电竞比赛列表、盘口，以及可匹配的外部书商赔率还有独立查询入口。

| 功能 | 可以直接这样问 | 当前覆盖 |
| --- | --- | --- |
| Polymarket 在赛列表 | “现在有哪些 Polymarket 网球比赛在打？给我各场胜负盘和有报价的子盘。” | 按平台的比赛分类或赛事筛选，给对阵、官方参考价、接单状态和已覆盖的让分、让图或总数。 |
| NBA 赛程、伤病及球员数据 | “雷霆下一场对谁？给我北京时间、SGA 的官方伤病状态、首发确认和最近五场数据。” | 官方伤病报告、预计首发或确认首发、实际上场、节次、比分、分钟和统计。NBA 官方与 ESPN 赛况各自标注来源。 |
| NBA 胜负、篮板盘及提醒 | “核对这个篮板 4.5 子盘。篮板过线、官方确认或者统计更正时告诉我。” | 按已支持的全场胜负和球员篮板合约核对加时、盘中确认、Game Book 和更正。可跟踪伤病、首发及有证据的统计变化。 |
| 网球赛程、比分及退赛 | “查这场是延期还是退赛，发球方和停赛比分是多少？这个总盘数合约怎么处理？” | 单打赛程与实际开打，盘、局、分、发球方、停复赛、退赛及赛前弃权。按子盘规则核对全场、单盘、完赛与总盘。逐分数据按实际赛事覆盖。 |
| 网球同场地画像与比分情景 | “比较辛纳和阿尔卡拉斯的红土保发、破发和样本量。现在赢下一分对赢局、赢盘和赢比赛有多大影响？” | 场地、赛季、发接发和样本分母。按给定赛制、比分及发球率计算下一分后的条件概率。 |
| 网球逐分与盘口复盘 | “复盘 [球员 A] 和 [球员 B] 在 [比赛日期] 的逐分比分、发球方和盘口，列出缺报价的分。” | 对齐已存真实比分和精确子盘。档案可用时，按分给出盘口时间、比分时间和时间差，区分温网官方逐分、订单簿档案和离散快照。 |
| CS2 对阵、阵容、地图与回放 | “这场 CS2 谁替补？地图顺序是什么？图二开打告诉我，回放别剧透。” | 查赛事阶段、BO、阵容、替补、禁选、分图、赛果和赛程变化。支持系列赛、单图、总图数、让图及单图回合子盘的规则核对。 |
| CS2 逐回合解说与行情复盘 | “解说图三第五回合，给我这个回合前后同一选项的盘口和代表性成交。” | 在 GOTV/CSTV、HLTV 或赛事方记录可用时查击杀序列、关键回合和当时已采到的行情。可绑定同一个 Polymarket 选项，按盘口、成交与赛事各自时间复盘。已接入的直播按当前数据和 Telegram 回执展示。 |
| 同场书商赔率与胜率参考 | “给我这场比赛的书商赔率、Polymarket 五档和去水后的胜率参考，和昨天那次比。” | 逐一核对赛事、盘口、选项、线和时效。合格输入可给去水赔率、PM 盘口和正常完赛条件下的融合参考，支持已保存快照复算和比较。胜率估计按工具回执标明未校准、数据缺口和适用条件。 |

NBA、网球和 CS2 是赛事助手的专项覆盖。书商赔率查询也可用于已有来源的 NFL、足球等赛事，按同场同盘的匹配结果返回。CS2 连续逐回合解说取决于已接入的直播源。只需要开赛、图开始或结束提醒时，直接订阅对应比赛节点。

## 天气

| 功能 | 可以直接这样问 | 会得到什么 |
| --- | --- | --- |
| 天气盘发现和规则对照 | “今天 Polymarket 还有哪些城市的最高温盘可看？比较这两个伦敦市场认的站和日界线。” | 按城市、当地日期、最高或最低温、市场状态查找。对比指定站点、统计窗口、精度、来源和档位。 |
| 观测、修订与结算 | “这个温度市场认哪个测站？合格的最高读数到哪一档？官方更正和最终结算分别是什么？” | 按市场规则查 AWC METAR、NOAA 站表或香港天文台日报等来源，核对当地日、单位换算、版本和冻结。其他已支持合约可核对降雪、累计降水及 NHC 飓风公告，以实际报告或历史档案为准。 |
| 站点预报、盘口和跨档提醒 | “对比实测、逐小时预测和各档买卖价。今天峰值预计几点，跨下一档时告诉我。” | 给出实测极值、可能峰值窗口、合格集合成员的档位频率和实时取得的盘口。支持比较前后预报和观察变化。集合频率单独标明校准状态。 |
| 机场影响因素 | “看仁川机场这个温度市场，风向、上风向温差、云量或雷达有没有变化？” | 对已接入的机场和区域给温度轨迹、风、卫星或雷达等实际证据，按现场覆盖支持跨档预警。 |
| 个人天气和官方警报 | “明早 7 到 9 点西雅图哪里雨小？降雨超过 2 毫米或有官方警报再提醒我。” | 按地点、坐标或路线查降水与活动窗口、风浪、气温、湿度、空气质量和花粉等。支持已覆盖的 NWS 官方警报和用户指定条件。 |

## Crypto

- **查 139 项内置指标。** 覆盖均线、趋势、动量、波动、成交量、跨资产、衍生品和 BTC 链上指标。可同时查多个币种和周期，自定义参数或指定历史截点。现货技术指标以 Binance 已收盘 K 线为主，Binance USD-M 永续和链上指标使用对应来源与频率。显示数值、前值、数据时间和覆盖。
- **按指标创建提醒。** 例如“每 5 分钟查 Binance 现货 BTC/USDT 的 15 分钟 RSI(14)，已收盘 RSI 上穿 70 时提醒我，持续 24 小时”。按具体交易对、来源、周期、指标字段和条件判定。
- **对照市场规则和参考价格。** 可查合约要求的现货 K 线，以及符合规则的已结束 BTC 五分钟 Chainlink TWAP 市场公开参考价。合约认定的价格、普通现货价格和 Yes/No 报价各自有来源。
- **跑 BTC、ETH 五分钟 Paper 模拟盘。** 已配置模拟账户和行情服务后，用 `/crypto_paper` 启动首轮 24 小时任务，每五分钟汇总策略、指标、TWAP、观望或模拟执行的依据。用 `/crypto_paper stop` 停止。模拟成交由配置的 Paper 服务处理。

## X、XTracker 与 EQN

| 功能 | 可以直接这样问 | 会得到什么 |
| --- | --- | --- |
| 查 X 公开原帖和近期动态 | “查 @elonmusk 最近的帖子，给原文和时间。这个链接是一条原创、回复还是引用？” | 可按账号、帖子链接或已支持的搜索方式读取。显示实际获得的原帖、作者正文、引用关系、来源和时间覆盖。 |
| 核对 X 合约与计数 | “按这个 Polymarket 市场指定窗口，本周算了多少条？刚发的这条回复是否符合条款，XTracker 有没有计入？” | 核对账号、原始窗口、时区、发帖类型、例外和指定 tracking。分别报告符合条款、来源是否已计入、距离目标条数和平台实际结算。 |
| 查 EQN 加密快讯 | “查过去六小时 SOL 的 EQN 快讯，区分现货上币、交易所活动和合约异动，带原始公告。” | 按频道、币种、关键词、账号或编号查。可读项目与交易所公告、价格或持仓量异动，以及原创、回复、引用、转发和关注变化。 |
| 持续订阅 | “盯 CZ 新帖”“这个合约的 XTracker 计数变动时告诉我”“未来 24 小时只推 CZ 和何一的关注或取消关注”。 | X 原帖、XTracker 计数和 EQN 可分别订阅。按实际来源去重，按事件类型和条件推送。绑定子盘且盘口依据足够时，可在 XTracker 通知里附 Yes 参考概率及变动。 |

## 钱包与个人研究

| 功能 | 可以直接这样问 | 会得到什么 |
| --- | --- | --- |
| 公开钱包查询 | “查这个公开钱包现在有哪些持仓，过去一周有哪些成交和活动？” | 官方公开地址的持仓、活动、成交和获取时间，可按市场与时间范围查询。 |
| 成交、结算和到账对账 | “按这个公开钱包核对上周的成交、部分成交、实扣费用、盈亏和兑付，给我交易链接。” | 逐笔成交、可核对的订单原始量和部分成交、实际费用、期初数量和 FIFO 盈亏。分别检查已结算、可兑付、已观察兑付和到账。订单、费用或到账细项可以结合脱敏的结构化记录与链上凭据核对，缺失时逐项标出。 |
| 保存和修改个人判断 | “保存我对 [市场链接] 的判断、参考证据和失效条件。把上一次的版本也列出来。” | 分市场保存研究、判断、决定或手工持仓，回读更新前后的版本，也可以删除指定记录。 |
| 记忆与状态导出 | “记住我查宏观数据时优先看官方原文。列出我现在关注的事项。” | 按请求保存、回读或删除个人偏好；可在本机导出记录、证据、任务、运行和记忆。 |

## Telegram 命令

命令可以直接手输。复杂查询、创建订阅和管理任务也可用普通中文。

| 命令 | 用途 |
| --- | --- |
| `/start`、`/help` | 查看 Bot 提供的功能介绍和示例问法。 |
| `/status` | 查看当前研究、排队消息、持续任务和发送状态。 |
| `/cancel` | 停止当前对话研究。长期订阅可以按任务名或编号暂停、取消。 |
| `/new` | 开始新对话，保留个人记忆、记录和任务。 |
| `/retry` | 重试失败或送达未知的消息。 |
| `/x @账号`、`/x X原帖链接` | 查该账号最近一条可返回的公开动态，或查指定帖子。需要更多条时用自然语言指定数量和时间段。 |
| `/xcount 市场链接 [目标条数]` | 按市场条款核对 XTracker 计数和离目标的差距。也支持手填账号及带时区的起止时间。 |
| `/eqn [频道、快讯编号或 @账号]` | 查看最新快讯、指定频道或单条快讯、某账号最近动态。 |
| `/eqnsub`、`/eqnsub @账号 [分钟] [小时] [事件类型]` | 查看或创建 EQN 订阅。账号可用逗号分隔，例如 `/eqnsub @cz_binance,@heyibinance 5 24 follow,unfollow`。 |
| `/eqnsub pause 任务ID`、`/eqnsub resume 任务ID` | 暂停或恢复一条 EQN 订阅。 |
| `/crypto_paper`、`/crypto_paper stop` | 启动或停止 BTC、ETH 五分钟 Paper 模拟盘。 |

## 从零启动

准备 **Node.js 24.9+** 和支持工具调用的 OpenAI 兼容模型服务。用 Telegram 时再准备自己的 Bot。

```bash
git clone https://github.com/SuperPolyrio/pm-personal-agent.git
cd pm-personal-agent
npm ci
cp -n .env.example .env
```

1. 在本机 `.env` 设置 `PM_MODEL_URL`（模型 API 根地址，通常以 `/v1` 结尾）、`PM_MODEL` 和 `PM_MODEL_API_KEY`。模板中的 `127.0.0.1` 指运行 Agent 的机器。没有鉴权的本机模型可用 `PM_MODEL_API_KEY=local`。按模型实际支持的长度设置 `PM_MODEL_CONTEXT`。
2. 在 Telegram 向 `@BotFather` 发送 `/newbot`。在本机 `.env` 填 `telegram-token` 和自己的数字 `TELEGRAM_USER_ID`。可在启动前给新 Bot 发 `/start`，再从 `getUpdates` 的 `message.from.id` 取 ID。Bot 接收配置用户的私聊。 [Bot 创建说明](https://core.telegram.org/bots/tutorial#obtain-your-bot-token) · [getUpdates](https://core.telegram.org/bots/api#getupdates)
3. 运行 `npm run build`、`npm run telegram`。在私聊发送 `/status` 再问一个简单问题，分别检查 Bot 与模型。终端可在未运行同状态目录宿主时用 `npm start -- chat`，或用 `npm run research -- '你的问题'` 发起一次查询。

个人状态在 `PM_STATE_DIR`，默认 `var/`。同一目录运行一个宿主。给其他人部署时使用独立的状态目录和 Bot Token。新状态目录中的订阅由用户按需创建。

### 按需要接数据来源

| 功能 | 配置 |
| --- | --- |
| 完整市场目录、历史成交和跨市场统计 | 初始化 market-data 的只读查询配置，设置 `MARKET_DATA_ROOT`、`MARKET_DATA_PYTHON` 和 `MARKET_DATA_QUERY_CONFIG`。隔离 Python 分析还依赖宿主的 `bwrap` 及对应 Python 环境。 |
| 市场工作区、流动性、Oracle、数据质量和外部赔率 | 设置 `POLYMONITOR_URL`，需要时设置 `POLYMONITOR_MCP_TOKEN`。不同面板和报价的时效按实际响应判断。 |
| Polymarket 公共快照、天气和 Crypto 数据 | 公共源地址在 [环境示例](.env.example) 中提供。按宿主网络和可用接口配置，PDF 原文提取依赖 `pdftotext`。 |
| 扩展公开新闻检索 | 默认启用 Exa，并有[新闻来源目录](config/news-publishers.json)。可配置支持 JSON 的 `PM_SEARXNG_URL` 或 `LANGSEARCH_API_KEY`。付费搜索按模板设置总开关及调用额度。 |
| X、XTracker 和 EQN | X 原帖使用可用的 `PM_X_READER_PATH` 或已连接浏览器的 OpenCLI。XTracker 和 EQN 使用各自的公开入口。 |
| 网球逐分回放、CS2 连续解说 | 历史复盘依赖已导入或已存的真实档案。逐回合直播需要可用的比赛源，独立 `cs2:live` 采集器和 Agent 使用同一 `PM_STATE_DIR`。 |
| BTC、ETH 模拟盘 | 配置自己的 Paper 服务、模拟账户和行情快照，使用 `PM_PAPER_URL`、`PM_PAPER_CREDENTIALS_FILE` 和 `PM_CRYPTO_SNAPSHOT_URL`。 |
| Telegram 网络代理 | 需要时设置 `PM_HTTPS_PROXY`。同机模型和本机服务的直连例外按 `PM_NO_PROXY` 配置。 |

完整变量与默认值见 [`.env.example`](.env.example)。密钥和 Token 保存在本机 `.env` 或相应的凭据文件。

## 工具与 Skills

面向用户的入口是中文问题。内部工具名供调试和二次集成使用。运行中的宿主可用 `npm run tools` 查询实际注册的名称、参数、DSH 内置工具和接入的 MCP 工具。

<details>
<summary>查看项目工具清单</summary>

| 用途 | 工具 |
| --- | --- |
| 市场、官方数据与筛选 | `resolve_market`、`read_market`、`read_panel`、`read_polymarket_public`、`screen_markets`、`discover_price_moves`、`estimate_visible_execution` |
| 规则和结算证据 | `build_rule_card`、`compare_rule_cards`、`compare_rule_versions`、`assess_rule_evidence` |
| 现实检索、原文与核对 | `list_news_publishers`、`search_market_sources`、`read_market_source_copy`、`read_official_market_data`、`locate_market_source_passages`、`verify_market_source_fact`、`normalize_source_evidence`、`compare_source_evidence` |
| SQL、分析与证据回读 | `discover_data`、`describe_data`、`query_sql`、`analyze_result`、`read_evidence` |
| 体育赛事、网球、CS2 和赔率 | `sports_assistant`、`tennis_research`、`cs2_live_commentary`、`lookup_market_odds`、`forecast_market_odds`、`compare_odds_forecasts` |
| 天气、Crypto 和社媒 | `inspect_weather_market`、`crypto_indicators`、`read_x_posts`、`read_xtracker_count`、`read_eqn_news` |
| 钱包对账与个人记录 | `reconcile_polymarket_portfolio`、`save_record`、`read_records`、`delete_record` |
| 监控计划与定时执行 | `prepare_market_watch`、`check_market_watch`、`create_watch_task`、`update_watch_task`、`read_watch_sources`、`finish_watch_check` |
| 状态、异常和摘要 | `get_personal_status`、`read_run`、`read_watch_history`、`read_watch_anomalies`、`read_anomaly_detail`、`configure_watch_digest`、`read_watch_digest` |

</details>

<details>
<summary>查看内置 Skills</summary>

| Skill | 用途 |
| --- | --- |
| [`market-data`](.dsh/skills/market-data/SKILL.md) | 市场目录、历史成交和覆盖的只读查询 |
| [`pm-public-data`](.dsh/skills/pm-public-data/SKILL.md) | 官方盘口、公开活动、钱包费用、盈亏及兑付核对 |
| [`pm-research`](.dsh/skills/pm-research/SKILL.md) | 结算规则、合约对照、证据与个人判断 |
| [`pm-world-search`](.dsh/skills/pm-world-search/SKILL.md) | 现实事件、报道与原始来源核对 |
| [`pm-watch`](.dsh/skills/pm-watch/SKILL.md) | 筛选、定时检查、异常和提醒 |
| [`pm-sports`](.dsh/skills/pm-sports/SKILL.md) | NBA、网球和 CS2 赛事、子盘、赛况及提醒 |
| [`pm-tennis`](.dsh/skills/pm-tennis/SKILL.md) | 网球场地画像、比分情景、逐分与盘口复盘 |
| [`pm-cs2`](.dsh/skills/pm-cs2/SKILL.md) | CS2 阵容、地图、逐回合与无剧透回放 |
| [`pm-forecast`](.dsh/skills/pm-forecast/SKILL.md) | 同盘口赔率、五档、融合估计及历史复算 |
| [`pm-weather-market`](.dsh/skills/pm-weather-market/SKILL.md) | 测站观测、温度盘口、预报、地点天气及警报 |
| [`pm-x-market`](.dsh/skills/pm-x-market/SKILL.md) | X 原帖、XTracker 计数、EQN 快讯与规则 |
| [`pm-crypto-trading`](.dsh/skills/pm-crypto-trading/SKILL.md) | BTC、ETH 五分钟模拟盘的指标与入场依据 |
| [`pm-output`](.dsh/skills/pm-output/SKILL.md) | 回复格式、来源链接与覆盖说明 |

</details>

### 本地运行与维护

| 命令 | 用途 |
| --- | --- |
| `npm start -- chat`、`npm start -- new` | 终端继续当前对话或开始新对话。 |
| `npm run research -- '问题'` | 发起一次终端研究。 |
| `npm start -- serve`、`npm run telegram` | 启动本地宿主或 Telegram Bot。 |
| `npm run tools`、`npm start -- call 工具名 'JSON'` | 查询已运行宿主的工具清单，或直接调用指定工具。 |
| `npm start -- doctor` | 检查模型、Polymonitor 和 market-data。 |
| `npm start -- market '市场链接'` | 直接解析市场。 |
| `npm start -- cancel [会话ID]` | 向已运行宿主取消当前研究。 |
| `npm start -- export` | 把本机记录、证据、任务、运行和记忆导出为 JSON。 |
| `npm start -- audit-news Telegram消息编号` | 用本机运行和消息回执核对已送达的新闻研究。 |
| `npm run check`、`npm run build` | 检查 TypeScript 类型并编译。 |

仓库也有 [CS2 独立直播入口](tools/cs2-live.mjs)、[网球逐分样本导入](tools/tennis-public-points.py)、[温网与订单簿档案导入](tools/tennis-wimbledon-archive.py) 和 [Crypto 报价离线回放](tools/crypto_quote_replay.py)。这些工具按现有数据或比赛源运行，和日常 Telegram 对话共用所需的证据与数据口径。
