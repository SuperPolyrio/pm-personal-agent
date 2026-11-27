---
name: market-data
description: 使用 market-data 公共数据定义和只读 SQL 查询市场、成交、历史及覆盖；可继续筛选已保存结果。
disable-model-invocation: true
---

Read local collected data. Respond in Chinese. This guide is already loaded.

Use the supplied schemas directly. describe_data loads unfamiliar datasets together; discover_data lists sources. No mandatory planning, todos or Python.

## Data interfaces

- PostgreSQL research.markets provides directory state, topic memberships, event-aware search_text, aligned yes_price and gamma_volume_24h_usd. Use FROM research.markets('macro') for indexed macro indicators/policy selection. economics is broader and includes businesses; other topics are politics/sports/crypto/weather; the plain view serves unrestricted catalog queries. Source topics overlap and are incomplete; combine entities, indicators and relevant geography when discovering a topic. Europe may include individual countries. Search title/event/tags, not a single tag alone. Rules and unstated statistical bases are in core.markets.description.
- ClickHouse research_activity(start='UTC datetime',end='UTC datetime') gives per-market source-fact notional, fact rows, unique log events and distinct participant wallets. research_trades with the same parameters exposes individual facts, decimal token_id and trade_time. Time and block pruning are implemented by these views. No preliminary block lookup is needed. Fact metrics are not Gamma volume or economically deduplicated trades.
- research_prices(start=:as_of-INTERVAL N DAY,end=:as_of) provides per-token first/last price and time, change, extremes and dispersion. Join catalog by BOTH market_id and verified yes_token_id for Yes; research.outcomes supplies other labels. Quant frontend history is another source; an empty one does not establish that all sources are empty.
- Settlement evidence is in oracle.oracle_events: event_status='settle', event_time is settlement event time, created_at is ingestion time. Distinct market IDs differ from event counts. core.market_status_snapshot is another source with its own freshness. Planned end_date is not settlement.
- Block/time boundaries and ingestion audit windows are available in block_timestamps and core.orderfilled_sync_windows. A populated time interval does not establish complete trade ingestion. Missing source facts and overlapping economic legs mean an amount is neither a proven lower nor upper bound on official volume.

## Saved results and follow-ups

query_sql engine=evidence queries saved rows using DuckDB SQL. evidence_ids bind to result_1,result_2,...; one input also has alias previous_result. This supports cross-database joins and filtering/sorting the previously displayed selection. It does not refresh source data. The host retains the evidence cited in the last answer and its schema. Reuse that mother set instead of recomputing a global ranking.

For cross-source research, query_sql.catalog_sql binds a PostgreSQL SELECT as ClickHouse table catalog in the SAME call, without a preview row cap. Filter the requested topic/region there, join the facts/prices, then rank. research.markets(topic,region) applies shared geographical definitions, including rules and region members. evidence_ids still bind saved result_1,...; an earlier displayed selection is preserved during follow-ups.

Use :as_of for the host's fixed UTC clock and SQL intervals for rolling windows. Future intervals need both bounds; past intervals end at as-of. For source/collection/read-time questions, read the saved inputEvidence/sourceRelations and original timestamps; cite those evidence IDs.

Aggregate the whole requested scope before ranking or joining rankings. Do not assume omitted/absent rows are zero. Use NULLS LAST for descending nullable values. Honor explicit counts and completeness requests. If no count is specified, a reasonable Top-N or sample is fine when its scope is stated. A short preview is not the saved result. A computation on truncated inputs describes that subset, not the full source population.

## Answer

After querying, answer directly in Chinese using the returned data. Choose prose, a table or both to address the user, and cite the actual evidence IDs. Explain the relevant measure, selection size and time scope in plain language; do not dump internal SQL metadata by default. Read additional saved rows with read_evidence when the answer needs more than the preview. Distinguish empty results, failed queries and unavailable data. A finite list is acceptable unless the user asks for all matches; never claim completeness from a preview or truncated input. Python analyze_result is optional for calculations SQL cannot express.
