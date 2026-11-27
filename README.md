# pm-personal-agent

在 Telegram 私聊里研究 Polymarket。贴一个市场链接，就可以问结算规则、盘口、历史成交或事件进展。也可以查体育、天气、X 和加密指标，或设置条件提醒。

## 从零启动

准备 Node.js 24.9 或更高版本，以及自己的模型服务和 Telegram Bot。

```bash
git clone https://github.com/SuperPolyrio/pm-personal-agent.git
cd pm-personal-agent
npm ci
cp -n .env.example .env
```

1. **接模型。** 在 `.env` 填 `PM_MODEL_URL`（支持工具调用的 OpenAI 兼容 API 根地址，通常以 `/v1` 结尾）、`PM_MODEL`（模型 ID）和 `PM_MODEL_API_KEY`。模板示例是本机的 `Qwen3.8-27B`，地址为 `http://127.0.0.1:18800/v1`。在自己的电脑启动时，这个地址指向自己的电脑。本机服务无需鉴权时可沿用 `PM_MODEL_API_KEY=local`。模板的 `PM_MODEL_CONTEXT=131072`，换模型时按服务支持的上下文调整。
2. **接 Telegram。** 在 Telegram 向 `@BotFather` 发 `/newbot`，把 Token 填到 `telegram-token`，把自己的数字用户 ID 填到 `TELEGRAM_USER_ID`。查 ID 时，可在启动程序前私聊新 Bot 发 `/start`，再从 `getUpdates` 返回的 `message.from.id` 读取。这个 Bot 只服务配置的用户私聊。[创建 Bot](https://core.telegram.org/bots/tutorial#obtain-your-bot-token) · [getUpdates](https://core.telegram.org/bots/api#getupdates)
3. **启动。** 执行下面的命令。私聊 Bot 发 `/status`，再发“2 + 3 等于几？”分别检查 Telegram 收发和模型回答。

   ```bash
   npm run build
   npm run telegram
   ```

**只配置模型和 Telegram 就能普通对话。使用全新状态目录时，没有默认盯盘市场，也不会自动推送。** 个人记录和任务保存在 `PM_STATE_DIR`（默认 `var/`）。运行第二个实例或给他人部署时，用各自的状态目录和 Bot Token。首次连接遇到 Telegram 网络错误时，按下表配置代理。

### 按需要配置数据源

| 想用的功能 | 怎么设置 |
| --- | --- |
| 通过代理访问 Telegram | 在 `PM_HTTPS_PROXY` 填自己的 HTTP 代理 URL。同机模型可沿用模板的 `PM_NO_PROXY`。 |
| 查完整市场目录、筛选市场或查询历史成交库 | 接入已初始化的 market-data。用 `MARKET_DATA_ROOT` 指向仓库，`MARKET_DATA_PYTHON` 指定该环境的 Python 可执行文件，`MARKET_DATA_QUERY_CONFIG` 指向该服务生成的只读配置。 |
| 查 Polymonitor 的市场面板、流动性、Oracle 或外部赔率 | 用 `POLYMONITOR_URL` 指向自己的服务。MCP 需要鉴权时填 `POLYMONITOR_MCP_TOKEN`。 |
| 扩展公开新闻检索 | 内置[新闻目录](config/news-publishers.json)和默认启用的 Exa 可直接使用。自建 SearXNG 可填启用 JSON 的 `PM_SEARXNG_URL`，LangSearch 可填 `LANGSEARCH_API_KEY`。付费搜索默认关闭，启用条件和额度见模板。 |
| 查 X 公开帖子 | 在 `PM_X_READER_PATH` 指向可用的 x_reader，或使用已连浏览器的 OpenCLI。EQN 快讯和 XTracker 计数走各自的公开接口。 |
| 运行 BTC、ETH 五分钟模拟盘 | 需要自己的 Paper 服务、模拟账户和行情快照服务。配置 `PM_PAPER_URL`、`PM_PAPER_CREDENTIALS_FILE` 和 `PM_CRYPTO_SNAPSHOT_URL` 后，在 Telegram 发 `/crypto_paper`。 |

完整变量见 [`.env.example`](.env.example)。将自己的密钥、Token 和 ID 填在本机 `.env`。想用终端聊天时可运行 `npm start -- chat`，或用 `npm run research -- '你的问题'` 问一次。同一状态目录只运行一个宿主。

## 可以直接这样问

在私聊里用自然语言即可。市场问题贴链接，盘口问题写明选项，历史查询写清日期或时间范围。

| 想做什么 | 可以这样问 | 能看到什么 |
| --- | --- | --- |
| 找市场和看行情 | “找现在开放的美国通胀市场，按 24 小时成交额列前十。再看其中这个市场的 Yes 买卖五档。” | 市场链接、选项、报价时间和盘口。也可按当前可见挂单估算买卖指定份数的费前成本。 |
| 查成交和异动 | “这个市场的 Yes 过去 24 小时价格和成交怎么变了？最近半小时有没有大幅变动？” | 时间窗、成交、价格变化和数据覆盖。 |
| 看规则和结算 | “这个市场什么情况下算 Yes？截止时间和官方来源是什么？现在结算了吗？” | 规则原文、条件、例外和已取得的结算记录。也可以贴两个市场链接对照规则。 |
| 查现实事件和新闻 | “查这个事件最近的变化，优先找两份独立的一手资料，说清各自证实了什么，附原文。” | 有日期和来源链接的摘要。只关心现实进展时，可以直接问事件或主题。 |
| 查体育和外部赔率 | “雷霆下一场对谁？给我北京时间、官方伤病和已确认首发。” “对照这场比赛的书商赔率和 Polymarket 买卖盘。” | 支持 NBA、网球与 CS2 的赛事查询。可比较同盘口报价，满足来源和时效条件时给出胜率估计。 |
| 深入看网球或 CS2 | “用两位球员的姓名和比赛日期复盘逐分比分和盘口。” “这场 CS2 打到哪张图？给我无剧透回放。” | 网球支持场地数据、比分情景和已有逐分档案。CS2 支持地图、赛况和有来源的逐回合内容。 |
| 查天气 | “这个最高温市场认哪个测站，目前实测到哪一档？” “查明早 7 到 9 点西雅图会不会下雨。” | 合约气象来源、站点观测和预报，或地点天气、降雨及官方警报。 |
| 查加密指标和社媒 | “给我 BTC/USDT 最近已收盘的 15 分钟 RSI 和 MACD，附数据时间。” “查这个市场规则对应的 XTracker 发帖数。” | 指标和数据时间，或 X 原帖、计数及 EQN 快讯。 |
| 查公开钱包 | “核对这个公开钱包本周的成交、费用和已到账结算。” | 按地址和时间段查询公开持仓、成交、手续费、盈亏和兑付，缺项按实际覆盖说明。 |
| 保存个人研究 | “保存我对这个市场的判断，依据是……如果……就失效。” | 保存并回读市场笔记、判断、研究偏好和手工记录。 |

回放、实时行情和外部赔率以当次源数据为准。涉及交易的功能提供只读研究、成本估算或 Paper 模拟。

### 设置盯盘和提醒

发送一条带目标、条件、检查频率和截止时间的消息。

> 帮我盯 [市场链接] 的 Yes，每 5 分钟检查，持续两小时。成交参考价变化达到 5 个百分点时提醒我。

看到任务编号、状态和下次检查时间后，即可用“列出我的盯盘和最近一次结果”“暂停任务 [编号]”“恢复任务 [编号]”管理任务。也可以订阅支持的天气、体育、X 或 EQN 变化，或安排每日待处理摘要。提醒会按你指定的条件触发。

### Telegram 命令

| 命令 | 用途 |
| --- | --- |
| `/start`、`/help` | 查看功能和示例问法 |
| `/status` | 查看当前研究、排队消息、持续任务和送达状态 |
| `/cancel` | 停止当前对话里的研究 |
| `/new` | 开始新对话，保留个人记录和任务 |
| `/retry` | 重试失败或送达情况未知的消息 |
| `/x @账号`、`/x 原帖链接` | 查看公开账号近期帖子或指定原帖 |
| `/xcount 市场链接 [目标条数]` | 按市场规则核对 XTracker 计数 |
| `/eqn [频道、快讯编号或 @账号]` | 查看 EQN 快讯 |
| `/eqnsub`、`/eqnsub @账号 [分钟] [小时]` | 查看或创建 EQN 订阅，使用 `/eqnsub pause 任务编号` 暂停 |
| `/crypto_paper`、`/crypto_paper stop` | 启动或停止 BTC、ETH 五分钟模拟盘 |

## 内置工具

日常提问时 Agent 会选用工具。运行中的实例可用 `npm start -- tools` 查看本机实际可用清单，连接 Polymonitor 后还会显示它提供的 MCP 工具。

| 用途 | 项目提供的工具 |
| --- | --- |
| 市场和公开数据 | `resolve_market`、`read_market`、`read_panel`、`read_polymarket_public`、`screen_markets`、`discover_price_moves`、`estimate_visible_execution`、`reconcile_polymarket_portfolio` |
| 数据查询和证据回读 | `discover_data`、`describe_data`、`query_sql`、`analyze_result`、`read_evidence` |
| 规则和结算证据 | `build_rule_card`、`compare_rule_cards`、`compare_rule_versions`、`assess_rule_evidence` |
| 搜索和原文核对 | `list_news_publishers`、`search_market_sources`、`read_market_source_copy`、`read_official_market_data`、`locate_market_source_passages`、`verify_market_source_fact`、`normalize_source_evidence`、`compare_source_evidence` |
| 体育和赔率 | `sports_assistant`、`tennis_research`、`cs2_live_commentary`、`lookup_market_odds`、`forecast_market_odds`、`compare_odds_forecasts` |
| 天气、加密与社媒 | `inspect_weather_market`、`crypto_indicators`、`read_x_posts`、`read_xtracker_count`、`read_eqn_news` |
| 盯盘任务 | `prepare_market_watch`、`check_market_watch`、`create_watch_task`、`update_watch_task`、`read_watch_sources`、`finish_watch_check` |
| 状态、异常和摘要 | `get_personal_status`、`read_run`、`read_watch_history`、`read_watch_anomalies`、`read_anomaly_detail`、`configure_watch_digest`、`read_watch_digest` |
| 个人记录 | `save_record`、`read_records`、`delete_record` |

## Skills

Skills 告诉 Agent 在特定问题上该查什么、如何核对来源和回答。直接说需求即可，Agent 会按问题使用相关说明。

| Skill | 用途 |
| --- | --- |
| [`market-data`](.dsh/skills/market-data/SKILL.md) | 市场、成交、历史和覆盖的只读查询 |
| [`pm-research`](.dsh/skills/pm-research/SKILL.md) | Polymarket 结算条件、规则对照和证据核对 |
| [`pm-public-data`](.dsh/skills/pm-public-data/SKILL.md) | 公共行情、公开钱包、费用、盈亏和兑付 |
| [`pm-world-search`](.dsh/skills/pm-world-search/SKILL.md) | 找现实事件进展，交叉核对报道和一手来源 |
| [`pm-watch`](.dsh/skills/pm-watch/SKILL.md) | 筛选市场、设定盯盘条件和管理提醒 |
| [`pm-sports`](.dsh/skills/pm-sports/SKILL.md) | 查 NBA、网球和 CS2 赛事、子盘及赛况提醒 |
| [`pm-tennis`](.dsh/skills/pm-tennis/SKILL.md) | 网球场地表现、比分情景、逐分回放和退赛规则 |
| [`pm-cs2`](.dsh/skills/pm-cs2/SKILL.md) | CS2 阵容、地图、逐回合、盘口和无剧透回放 |
| [`pm-forecast`](.dsh/skills/pm-forecast/SKILL.md) | 书商赔率、Polymarket 盘口和有条件的胜率估计 |
| [`pm-weather-market`](.dsh/skills/pm-weather-market/SKILL.md) | 天气合约、站点实测、地点预报、警报和天气提醒 |
| [`pm-x-market`](.dsh/skills/pm-x-market/SKILL.md) | X 原帖、XTracker 计数和 EQN 快讯 |
| [`pm-crypto-trading`](.dsh/skills/pm-crypto-trading/SKILL.md) | BTC、ETH 五分钟模拟盘的指标和入场依据 |
| [`pm-output`](.dsh/skills/pm-output/SKILL.md) | 统一回复格式、来源链接和覆盖说明 |
