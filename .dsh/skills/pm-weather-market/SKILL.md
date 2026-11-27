---
name: pm-weather-market
description: 核对天气合约、档位、盘口、站点预报和机场实况跨档预警。也用于按地名或路线查询降雨、活动时段、官方警报和个人天气条件，以及按用户要求订阅。
---

天气统一用 inspect_weather_market。答复用中文，给具体地点、时段、覆盖和可打开的原始链接。保留工具证据 ID 供回读。区分实际观测、预报、历史回放、平台结算和送达状态。

查询模式

- market 是默认模式。传原始市场链接、slug 或本地 ID。保留链接的 marketSlug 和 outcomeIndex。只有事件时按候选选精确子合约。AWC 观测按站点当地日，逐条优先用完整 T 备注，再按规则读正文。较早 NOAA Temp 站表是另一口径。输出原值、计算值、档位、当地和北京时间、冻结状态及实际平台结算。include_books=true 读取已核对档位的 Yes 买一、卖一、报价时间和来源。
- 香港高低温盘按规则读取香港天文台总部 HKO 的 Daily Extract。当地日内极值标注为官方暂定读数，可用 report 关注变化和正式日报发布，推荐 10 分钟检查。规则未说明整度标签的小数取整时保留无法唯一落档。按实际快照说明首版是否留存，并分列平台结算。
- 雪、累计降水和 NHC 公告按合约自动找报告。真实档案用 official_urls 或已有 replay_evidence_ids，按实际缺测和版本可见性报告。KXRAINNYCM 月降水传准确 Kalshi ticker。证据中可区分公开站表、官方原文、NWS 产品镜像与事后再分析。
- compare 传 markets，比较 2–4 个子合约的测站、时间窗、统计量、精度和来源。日高、日低、指定时点意义不同，无法解析的条款保留原文及证据。
- discover 省略 cities 即从 Polymarket 官方 Gamma 的 Daily Temperature 目录列出当前还有可下单档位的城市及市场链接，可以传 observation_dates 或 contract_types 缩小范围。城市以官网挂牌为准，目录覆盖和测站读数覆盖分别说明。指定城市时传 cities、observation_dates、可选 max_age_seconds、contract_types（temperature_max 或 temperature_min）和 market_status（open、closed 或 all），用于核对观测或准备订阅。日期按测站当地日。
- station_forecast 传市场，按核验机场坐标读取逐小时模型、峰值与集合档位频率。逐档频率使用合格集合成员，校准状态另列。forecast_history 传 forecast_runs 和带时区 as_of。仅有初始化时间时，不据此断言当时已公开。模型格点预报与测站原报文分开。
- temperature_desk 用于问最高温盘还能否跨档、何时达峰、各档报价或深度。传官网事件或子合约链接，默认读取 Yes 和 No 的实际盘口。用 desk.remaining 显示已观测下界、剩余小时数、合格集合样本和逐档频率。temperature_threshold 可统计达到用户给定物理温度的样本，单位从规则取。频率未经校准。香港整度档位映射不明确时给原始温度范围和明确阈值的频率。
- airport_factors 查釜山 RKPK、首尔仁川 RKSI、香港 HKO／VHHH、东京羽田 RJTT、慕尼黑 EDDM、马德里 LEMD。传真实最高温事件或精确子市场，多站用 markets 一次最多六个。汇报温度轨迹、风和上风向温差、卫星辐照度或日本气象厅红外云图、近站雷达，以及与模型和合约档位的关系。香港机场是区域参考，合约计算使用香港天文台总部。
- 问达到某温度与落在哪一档时，分别引用 threshold 和 bands。已有实测时用 nextBracket 回答跨入下一档或更高的频率。集合频率与盘口报价可以并列展示。凭这两者的差值无法核实交易优势。
- 宿主工具 schema 未列 temperature_desk 时，走 station_forecast 并设 include_books=true。
- 分开报实测、模型和盘口时间。观测窗口和阶段直接取 desk.observationWindow 的预计算字段，fromLocal 与 fromBeijing 对应不同钟面。desk.timing 是与原文匹配的 AWC 接收时间。desk.models 是预报峰值和天气条件。book 是 REST 快照，两边按各自 token、报价时间、读取时间和深度报告。问来源时引用 book.source、desk.ensemble.source.source 和合同主源。用户问“跟上一次比”时填 previous_snapshot_evidence_id，值取上一次同一市场的 supplementalEvidenceId。快照差异基于实际读取时间。原始来源和各档证据可通过 read_evidence 回读。
- personal 传 locations、start、end。locations 接受名称与可选 country_code，或一对坐标，路线用有序坐标点并加区段名。地点重复时核对候选。activity 可为 commute、laundry、run、hike、ski、sail。查看降雨时段、强度和雨量，条件筛窗使用用户给出的阈值。航海条件使用实际海浪、风和阵风。两份预报传 models 并对齐有效时刻。按 window 与 rain 里的 fromLocal、toLocal 显示当地时间，雨小时段使用 leastRainHours。15 分钟序列可能是小时模型插值。
- alerts 按坐标或已确认地点查 NWS 官方警报，可传 alert_events、alert_severities。NWS 原始 CAP 链接可用 alert_urls 或 replay_evidence_ids 回放。区分签发、更新、解除、过期和有效期，保留地点适用依据。
- conditions 传 conditions，每项含 metric、op、value，必要时加 hours。支持 forecast_rain_mm、observed_rain_mm、temperature_c、relative_humidity_pct、wind_kmh、gust_kmh、wave_m、snowfall_cm、us_aqi、european_aqi、grass_pollen。累计雨量按对应窗口，其他指标显示窗口最大值和单位。缺少必要数据时保留 unknown。浇水只判断用户给出的雨量条件并提醒。

订阅

用户明确要求才创建任务。市场回执有 sourceId、scope、marketId 和 contractEvidenceId 时，用 prepare_market_watch → create_watch_task(plan_evidence_id)。item.kind=fact，weather.conditions 取用户选项。温度支持 bracket、revision、coverage、freeze、settlement。气候日报或气旋可选 report、cumulative、trigger、coverage、settlement。用户点名 Yes/No 时用准确 tokenId。

温度订阅的 bracket 和 revision 跟踪合格实测档位和官方观测更正。预报变化可用 temperature_desk 比两次快照。六站有主动改档提醒要求时，按 airport_factors 回执单独创建 weather.conditions=[impact]，用 unconfirmed=immediate 和 quality=record，首轮建基线，分清预估跨档、近阈值提醒和正式结算。

地点、天气盘发现、以及有原生凭据的 Kalshi 任务从回执取 weather_location_evidence_id，传 create_watch_task 并填写明确到期、周期和预算。不要传旧市场的 market_id、sources、notify_when。滚动未来数小时用 conditions.hours，留空固定的 start 和 end。按回执使用有效周期。首次有效检查建立基线。用 get_personal_status、read_run、read_evidence 回查，按实际任务 ID 暂停、恢复或取消。通知区分队列、发送失败和实际送达。正式气象警报和用户自定义条件各自标明来源。
