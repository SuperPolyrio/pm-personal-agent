# pm-personal-agent

个人 Polymarket 研究助手。DSH 负责模型与工具循环、会话历史、Skill、MCP、上下文压缩和定时调度；本项目提供数据连接、个人业务记录和 Telegram 入口。

默认使用本机 `Qwen3.8-27B`，接口由 `PM_MODEL_URL` 配置，上下文 32768 tokens。配置见 `.env.example`。

## 运行

```bash
npm ci
cp -n .env.example .env
npm run check
npm run build
npm run research -- '你的问题'
npm start -- chat
npm run telegram
```

固定数据源入口、代理和本机连接选项集中在 `.env`。新闻发布源目录位于 `config/news-publishers.json`，可通过 `PM_NEWS_PUBLISHERS_FILE` 指定其他目录文件。`.env.example` 提供公开默认值与变量名。生产凭据和用户 ID 填入本机 `.env`。market-data 和 Paper 使用各自管理的本机凭据文件，由 `MARKET_DATA_QUERY_CONFIG` 和 `PM_PAPER_CREDENTIALS_FILE` 指定位置。Telegram 使用 `telegram-token` 和 `TELEGRAM_USER_ID`。用户服务配置在 `deploy/pm-personal-agent.service`；更新后构建并重启 `systemctl --user restart pm-personal-agent`。`/new` 新建会话，`/cancel` 停止当前研究，`/status` 查看状态，`/retry` 重发未确认送达的消息。

同一状态目录只运行一个宿主。独立本地研究可设置不同的 `PM_STATE_DIR`；运行中的服务可用以下命令直接检查工具，无需调用模型：

```bash
npm start -- tools
npm start -- call discover_data '{}'
npm start -- call describe_data '{"datasets":["core.markets","core.market_quote_current"]}'
npm start -- call query_sql '{"engine":"postgres","sql":"SELECT now() AS database_time"}'
npm start -- cancel
npm start -- export
```

## 开发分工

| 内容 | 位置 | 职责 |
| --- | --- | --- |
| 领域说明 | `.dsh/skills/` | 数据口径、合约研究、持续观察；由 DSH 按需加载 |
| 工具插件 | `src/plugin.ts` | 注册通用查询及个人记录/观察工具，记录证据和实际用量 |
| 数据连接 | `src/market-data.ts`、`src/data.ts` | 调用 market-data 的读取接口和 Polymonitor，不复制采集器 |
| 可选代码分析 | `src/analysis.ts` | 隔离 Python 处理已查询结果，支持跨库计算 |
| 宿主与渠道 | `src/main.ts`、`src/telegram.ts`、`src/reply.ts` | 配置 DSH SDK、恢复会话、展开证据表格并收发 Telegram 消息 |
| 个人状态 | `src/store.ts` | SQLite 保存个人记录、证据、观察约定及送达状态 |

新增问题通常由模型组合 SQL；新增来源由数据引擎提供目录、结构和只读授权；只有缺少实际操作能力时才增加工具。无需为每道问题写脚本或修改模型调用流程。

## 数据查询

默认流程是 **生成 SQL → 执行 → 回答**。目录统一从 market-data 查询，不重复开放 Polymonitor 的 search_markets；Polymonitor 保留外部研究视图。宿主启动时预载 `PM_QUERY_SCHEMAS` 的真实表结构及 market-data Skill，通过 DSH 原生 systemPrompt section 提供，避免每轮先花一次模型调用加载常用查询说明。来源或字段未知时再发现。

已知范围可直接查；主题范围不清时可以查询事件、标签和标题补充发现。区域检索需考虑成员国家；关键词命中不自动表示符合用户主题，也不构成查全保证。

预载的 market-data Skill 使用 DSH 原生 `disable-model-invocation: true`，不再出现在要求模型先调用 skill 的目录中；其他 Skill 继续按需加载，用户仍可显式使用 `/market-data`。

查询范围仍由模型根据公共定义与问题选择。验收需独立核对数据库并复跑；表格原文和行数正确，不代表 SQL 没有缩窄用户要求的范围。

| 工具 | 作用 |
| --- | --- |
| `discover_data` | 读取注册的数据契约；不连接数据库或推断存储状态 |
| `describe_data` | 批量读取真实字段、索引、关联键和当前存储状态 |
| `query_sql` | 通过独立只读账号执行 SELECT/CTE，保存来源、SQL 和结果证据 |
| `analyze_result` | 按需使用 Python 分析保存的结果，支持统计与跨库关联 |
| `read_evidence` | 分页读取已保存结果、原始 SQL、来源与时间信息 |

`src/market-data.ts` 只调用相邻仓库的 `python -m market_data.research`，共用 discover/describe/query/resolve 四个操作。该仓库的 `src/common/research_catalog.py` 定义数据契约，`research.py` 负责授权和查询，`src/market/read_api.py` 仅保留合约引用解析及 Yes/No 身份核对。早期 search/taxonomy、独立 CLI 和连接配置已删除。

公共数据定义由 market-data 的 `scripts/research_views.sql` 与 `scripts/research_trades.sql` 创建：`research.markets` 对齐目录状态、Yes 身份、空值及 Gamma 24h 金额；`research_trades(start,end)` 统一 UTC 交易窗口和十进制 token；`research_activity(start,end)` 在事实粒度分别计算金额与地址并集。当前开放选集使用 `is_open`，复用现有开放市场部分索引；原始 active/closed 的 NULL 保留为未知。这些是跨问题复用的定义，源事实金额仍不等于完成经济去重的成交额。宏观指标与政策使用 `research.markets('macro')`；`economics` 为包含公司/商业的更广经济主题，另有 politics/sports/crypto/weather，原生 SQL 函数展开到现有分类/标签索引；直接对计算后的 topics 数组过滤会扫全历史目录。

`query_sql` 的 `engine=evidence` 用 DuckDB SQL 读取 `evidence_ids` 对应的完整保存结果（`result_1`、`result_2`，单输入还提供 `previous_result`）。连续筛选保留原母集、数值类型与来源时间；截断输入可继续分析，但保留 inputTruncated 与输入来源，不代表全范围。DSH 原生会话事件将上次回答引用的证据、时间基准和字段记入已有 runs 表，没有新增会话系统。

`query_sql.catalog_sql` 可在一次调用中绑定完整 PostgreSQL 目录关系为 ClickHouse 的 `catalog`。目录关系允许 SQL 自身的 LIMIT，模型须区分已有选集与完整排名范围；内部使用游标和 external tables，容量与展示行数分开。没有被 SQL 引用的 catalog_sql 不执行。对能够证明等值关联或正向 IN 半连接的时间窗口，先取得窗口内**全部**市场 ID 再下推目录筛选，不取 Top-N；之后才聚合、排序。多个分支和外关联不盲目下推。`research_prices` 按 market_id/token_id 提供首尾、极值和标准差，首尾取交易顺序；Yes 必须关联公共目录中经标签和 token 验证的 yes_token_id。

地域由 `research.markets(topic,region)` 使用 CLDR 地区成员及公开机构别名匹配目录、事件和规则；匹配表示相关性，不保证语义分类或召回完整。`:as_of` 绑定本轮固定 UTC 时刻，DSH 原生时间上下文也用 UTC。模型可用 read_evidence 读取保存的来源链及原始时间，解释本次读取和沿用快照。

PostgreSQL 和 ClickHouse 都可接收 `evidence_ids`：前者用参数绑定的原生 JSON 记录集 CTE，后者用原生 external tables。数组字段保留数组类型，ClickHouse 外关联使用原生 NULL 语义，避免未匹配 ID 变成 0。两者都不创建临时数据库对象，既支持先取市场范围再查成交，也支持先取成交排名再关联目录。在完整主题范围内关联后排名。引擎使用 ClickHouse 原生分块、外部聚合、排序和 grace_hash 关联溢写，在保留 512 MiB 内存限制下处理宽关联；可按输入 ID 下推筛选进一步提速。输入快照不会因此刷新。

所有数据读取，包括身份解析，都使用 `~/.config/polydata/research-readonly.json` 的独立只读凭据；首次由运维执行引擎的 `python -m market_data.research setup`，新增数据集后用同一命令更新授权。Agent 不开放 setup，也不再读取采集器的 polydata.env。路径可由 `MARKET_DATA_QUERY_CONFIG` 覆盖。

普通查询由 DSH 原生工具循环执行，模型查完数据后直接组织最终回答，CLI 和 Telegram 使用 SDK 的 finalResponse。没有 present_results 终止工具、固定表格模板或必须逐字引用问题的未完成项校验。模型按用户要求决定表格、摘要、Top N或样例；未要求全量时不默认要求列出所有匹配记录，有限列表须说明范围。来源、SQL、原始结果、指标定义、采集与读取时间继续保存在 evidence 中，供模型引用和独立核对。

推理设置由启动配置和 DSH 原生会话模型选择负责；不会因查询失败、筛选条件或聚合自动切到 low，也不注入强制范围复核步骤。同轮完全相同的 SQL 复用结果或错误，避免重复执行；错误反馈区分首次执行与缓存，下一轮自动重新读取。模型可自由修正 SQL，连续重复调用仍由 DSH 原生 repeat-tool-reminder 提醒。模型与工具预算不变。

SQL执行器保留独立只读账号、SELECT/CTE与安全函数/数据集边界，以及行数、字节、超时和内存限制；不再以业务语义规则拒绝候选LIMIT、对已有选集的关联、价格聚合或截断结果分析。是否匹配用户范围、正确处理选项和缺失值，由模型结合公共数据定义回答并在回放中核对，不把程序允许执行当作答案正确。

查询默认预览20行，可请求至多100行但仍受6000字符限制；完整受限结果另存，read_evidence按offset/rows分页。SQL实际范围、结果截断和输入截断分别保留。模型预览用一份列名加值数组，避免逐行重复字段名；保存的完整结果仍是对象行。read_evidence 的 metadata 视图包含完整 SQL 和来源链，区分结果生成、源库读取和源观察时间。

SQLGlot 从实际 SQL 记录最外层 LIMIT/OFFSET，并保留到后续输入的证据中；不再要求模型填写 `limit_reason`，也不把模型理由当成用户要求。执行器自身的行数、字节和超时限制继续生效，截断单独标记。SQL 是否完整落实请求范围仍需核对，内部 Top-N 也可能缩小后续聚合母集。

Agent 通用查询固定保存至多 10000 行，8 MiB，PostgreSQL 执行上限 15 秒、ClickHouse 30 秒。分析采用 Linux bubblewrap 隔离，仅挂载 Python/pandas/numpy 与指定结果，不开放网络和宿主凭据；限制为输入 32 MiB、执行 15 秒、内存 2 GiB、输出 64 KiB。Python 不属于普通查询的必经步骤。

数据集契约可声明 `coverageColumns`；显式 `describe_data` 会读取这些时间字段的全表边界，历史报价分别返回价格时间与采集时间。时间边界不代表区间连续性；结构预载不缓存这些业务状态。模型可直接使用数据描述结果回答，无需重新统计。

指标窗口、采集时间、时效和覆盖由引擎返回。读取成功不代表来源完整；历史快照不能冒充当前数据。目录发现不逐表探测，describe 仅读取请求的数据集，不自动扩展依赖表；查询不附带额外分类计数，需要统计时在 SQL 中表达。可执行定义与字段口径由 market-data 的视图和 catalog 负责，Skill 仅说明接口用法。

## DSH 原生运行

使用 SDK 的 `session.run()` 驱动完整调用循环。普通查询没有独立规划模型、强制待办、自动催办或独立最终答复请求，也没有重写 llm/stream 的消息历史。需要时可由模型使用 DSH 原生待办工具。

上下文使用原生 token-meter、tool-result-pruner 和 BasicCompactionEngine。32K 窗口配置 0.75 压缩阈值、4096 余量、保留最近 4096 tokens，以及一次额外压缩和一次溢出恢复；历史原文由 DSH 归档。`src/compaction.ts` 使用原生 summarize 扩展点生成有界摘录，保留用户请求、证据 ID 和近期工具内容，不再额外调用模型写摘要。摘录可能不完整，原始结果可按证据 ID 回读；历史选择、裁剪、压缩有效性检查和恢复仍由 DSH 负责。旧自建上下文流程和 direct/planned 对比流程已删除，`PM_QUERY_MODE` 不再使用。

推理强度通过 SDK 的 reasoningEffort 设置，默认 `PM_QUERY_REASONING=off`，可显式设为 `low`；查询过程中保持该配置，恢复旧会话时使用原生 `agent.model.select` 应用配置值。默认采样为 temperature=0.7、top_p=0.8、presence_penalty=1.5、top_k=20；`PM_QUERY_TEMPERATURE` 可显式覆盖。DSH 0.2.2-rc.1 的 pi-ai 适配器未暴露底层已有的 samplingParams 配置；`patches/` 中四行兼容补丁仅透传该配置，`npm ci` 的 postinstall 自动应用，没有新增模型循环或 HTTP 网关。升级 DSH 后优先删除上游已支持的补丁。历史压缩不再发起模型请求；查询输出上限为4096。

保留用户配置的每轮 24 次模型、80 次工具上限；所有实际模型请求仍计数。用量钩子计数和限制；接近模型上限时通过 DSH 原生工具限制留出最终回答；不指定终止工具或输出模板，模型说明已有结果和缺口。

长期记忆通过现成 memory MCP，外部市场能力通过 Polymonitor MCP。持续观察使用 DSH Schedule 唤醒独立会话，业务层仅保存约定、检查覆盖、去重和通知。Telegram 送达以 outbox 的实际状态为准。

长答复超过三个 Telegram 文本分段时，以完整 Markdown 文档投递，保留原表、口径和限制；短答复仍直接发送。已发送部分的旧文本任务保持原分段续传。
