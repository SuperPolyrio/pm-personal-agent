"""Offline, receipt-time BTC/ETH quote replay. No Bot, scheduler, or order transport."""

from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict, deque
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import hashlib
from itertools import groupby
import json
import math
from multiprocessing import get_context
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
import pyarrow as pa
from scipy.signal import lfilter
from scipy.special import expit, logit
from sklearn.linear_model import LogisticRegression, Ridge

AGENT = Path(__file__).resolve().parents[1]
QUANT = AGENT.parent / "crypto-prediction-market"
for directory in (QUANT / "5minHypothesis", AGENT.parent / "backtest-lab" / "python"):
    sys.path.insert(0, str(directory))
from five_minute.math_core import official_up, quote_buy, twap_probability
from backtest.orderbook.l2_replay import (
    L2ReplayNotReady, _levels_from_json, apply_price_change_group_with_top_fence,
)

ASSETS = ("BTC", "ETH")
PRIMARY = "polymarket_market_ws_raw_a"
LATENCY = 0.250
FRESH_SECONDS = 3
Z80 = 1.281551565545


def archived_bars(db, directory, asset, dates, seconds):
    files = [str(directory / f"{asset}-{date}.parquet") for date in dates]
    rows = db.execute("""
        SELECT (bar_open_us // ?) * ? AS bucket, max(available_us), count(DISTINCT bar_open_us),
            first(open::DOUBLE ORDER BY bar_open_us), max(high::DOUBLE), min(low::DOUBLE),
            last(close::DOUBLE ORDER BY bar_open_us), sum(volume::DOUBLE), sum(quote_volume::DOUBLE),
            sum(taker_buy_volume::DOUBLE)
        FROM (
            SELECT * FROM read_parquet(?)
            QUALIFY row_number() OVER (PARTITION BY bar_open_us ORDER BY available_us)=1
        ) GROUP BY bucket ORDER BY bucket
        """, [seconds * 10**6, seconds * 10**6, files]).fetchall()
    return [dict(openTime=t // 1000, closeTime=t // 1000 + seconds * 1000 - 1,
                 availableAt=(received + 999) // 1000, open=o, high=h, low=l, close=c,
                 volume=v, quoteVolume=q, takerBuyVolume=b)
            for t, received, count, o, h, l, c, v, q, b in rows if count == seconds]


class Reference:
    def __init__(self, db, binance, xue, asset, dates):
        files = [str(binance / f"{asset}-{date}.parquet") for date in dates]
        obs, available, price = db.execute("""
            SELECT bar_end_us / 1e6, available_us / 1e6, close::DOUBLE
            FROM read_parquet(?) QUALIFY row_number() OVER (PARTITION BY bar_end_us ORDER BY available_us)=1
            ORDER BY bar_end_us
            """, [files]).fetchnumpy().values()
        self.obs, self.available, self.price = obs, np.maximum.accumulate(available), price
        dt = np.diff(obs, prepend=obs[0]-1)
        change = np.diff(price, prepend=price[0])
        self.sigma = np.sqrt(lfilter([0.06], [1, -0.94], change**2 / dt))
        self.integral = np.r_[0.0, np.cumsum(price[:-1] * np.diff(obs))]
        self.official = {}
        files = [str(xue / f"{date}.parquet") for date in dates]
        for observed, received, value in db.execute("""
            SELECT observed_ts, available_ts, value FROM read_parquet(?)
            WHERE asset=? AND window_seconds=60 AND availability_basis='observed_receipts'
                AND precision='exact_e18' AND observed_ts % 300 = 0
            QUALIFY count(DISTINCT value) OVER (PARTITION BY observed_ts)=1
            ORDER BY observed_ts, available_ts DESC
            """, [files, asset]).fetchall():
            self.official[observed] = (received, value)

    def price_at(self, time):
        i = self.obs.searchsorted(time, side="right") - 1
        if i >= 0 and time - self.obs[i] < 1:
            return float(self.price[i])
        return None

    def forecast(self, time, start):
        anchor = self.official.get(start)
        if anchor is None or anchor[0] > time:
            return None, "anchor_not_received"
        # Float arrays are ordered by candle end; cumulative arrival fence also excludes
        # a later candle during any gap in preceding delivery.
        i = int(np.searchsorted(self.available, time, side="right")) - 1
        if i < 60 or time - self.obs[i] > FRESH_SECONDS or self.obs[i] - self.obs[i-60] != 60:
            return None, "reference_gap"
        spot = self.price[i]
        sigma = self.sigma[i]
        remaining = start + 300 - time
        integral = None
        if remaining < 60:
            from_time = start + 240
            j = int(np.searchsorted(self.obs, from_time, side="right")) - 1
            if i < j or j < 0 or self.obs[i]-self.obs[j] != i-j or from_time-self.obs[j] > FRESH_SECONDS:
                return None, "closing_twap_gap"
            integral = (self.integral[i] - self.integral[j]
                        + spot * (time - self.obs[i]) - self.price[j] * (from_time - self.obs[j]))
        anchor_price = float(anchor[1])
        estimate = twap_probability(spot, anchor_price, remaining, 60, sigma, observed_integral=integral)
        return (estimate, anchor_price, spot, sigma, remaining, integral), None


def snapshot_at(series, at):
    times, rows = series
    index = bisect_right(times, at) - 1
    return rows[index] if index >= 0 else None


def train(ref, series, first, start):
    samples = []
    for market_start in range(first, start - 600, 300):
        opening, closing = (ref.official.get(t) for t in (market_start, market_start + 300))
        if not opening or not closing or closing[0] > start:
            continue
        outcome = official_up(closing[1], opening[1])
        for offset in (30, 90, 150, 210, 270):
            at = market_start + offset
            forecast, _ = ref.forecast(at, market_start)
            snap = snapshot_at(series, at)
            if forecast is not None and snap:
                estimate, _, spot, sigma, remaining, _ = forecast
                returns = []
                for horizon in (30, 60):
                    target = ref.price_at(at + horizon) if remaining >= horizon else None
                    returns.append((target - spot) / (sigma * math.sqrt(horizon))
                                   if target is not None and sigma > 0 else np.nan)
                samples.append((estimate.probability_up, snap["features"], outcome, returns))
    keys = sorted({key for _, fields, _, _ in samples for key in fields})
    raw = np.array([[fields.get(key, np.nan) for key in keys] for _, fields, _, _ in samples])
    count = np.isfinite(raw).sum(axis=0)
    with np.errstate(invalid="ignore"):
        centers = np.nansum(raw, axis=0) / np.maximum(1, count)
        spread = np.sqrt(np.nansum((raw - centers) ** 2, axis=0) / np.maximum(1, count))
    use = np.flatnonzero((count >= len(samples)/2) & (spread > 1e-10))
    selected = [keys[i] for i in use]
    mean, scale = centers[use], spread[use]
    technical = np.nan_to_num(np.clip((raw[:, use] - mean) / scale, -8, 8))
    structural = logit(np.clip([p for p, _, _, _ in samples], .001, .999))
    model = LogisticRegression(C=.01, solver="liblinear", max_iter=500).fit(
        np.column_stack([structural, technical]), [result for _, _, result, _ in samples])
    targets = np.array([returns for _, _, _, returns in samples])
    price_models = []
    for target in targets.T:
        valid = np.isfinite(target)
        price_models.append(Ridge(alpha=500).fit(technical[valid], np.clip(target[valid], -8, 8)))
    # The slow feature contribution is calculated once per closed-bar snapshot.
    for row in series[1]:
        vals = np.array([row["features"].get(k, np.nan) for k in selected])
        standardized = np.nan_to_num(np.clip((vals - mean) / scale, -8, 8))
        row["contribution"] = float(model.intercept_[0] + standardized @ model.coef_[0, 1:])
        row["forward"] = [float(np.clip(fit.intercept_ + standardized @ fit.coef_, -1.5, 1.5))
                          for fit in price_models]
    ids = sorted({key.split(".")[0].split("=")[0] for key in selected})
    return float(model.coef_[0, 0]), dict(samples=len(samples), fields=len(selected), ids=ids)


def price_forecasts(forecast, forecast_returns):
    structural, anchor, spot, sigma, remaining, integral = forecast
    def band(mid, deviation):
        return [round(float(mid + x * deviation), 4) for x in (-Z80, 0, Z80)]
    result = {}
    for horizon, change in zip((30, 60), forecast_returns):
        deviation = sigma * math.sqrt(horizon)
        result[f"price_{horizon}s"] = band(spot + change*deviation, deviation) if remaining >= horizon else None
    drift = forecast_returns[1] * sigma / math.sqrt(60)
    terminal = twap_probability(spot, anchor, remaining, 60, sigma, drift=drift, observed_integral=integral)
    return dict(**result, closing_twap=band(terminal.mean, math.sqrt(terminal.variance)),
                twap=structural.probability_up, anchor=anchor, spot=float(spot))


class Book:
    def __init__(self):
        self.identity = None
        self.exchange = 0
        self.seen = -math.inf
        self.ready = False
        self.bids, self.asks = {}, {}
        self.top = None
        self.liquidity = ()

    def apply(self, rows, at, token, quantity):
        row = rows[-1]
        identity = (row["raw_connection_id"], row["raw_connection_generation"])
        if identity != self.identity:
            self.identity, self.ready, self.exchange = identity, False, 0
        exchange = row["exchange_us"]
        if any(r["clock_invalid_reason"] or
               r["exchange_us"] != exchange for r in rows) or exchange is None:
            self.ready = False
            return "invalid_frame"
        if exchange < self.exchange:
            self.ready = False
            return "exchange_clock_regression"
        self.exchange = exchange
        try:
            if len(rows) == 1 and row["event_type"] == "book":
                self.bids, self.asks = _levels_from_json(row["bids"]), _levels_from_json(row["asks"])
                self.ready = True
            elif not self.ready:
                return "no_baseline"
            elif any(r["event_type"] != "price_change" for r in rows):
                self.ready = False
                return "mixed_frame"
            else:
                apply_price_change_group_with_top_fence(
                    self.bids, self.asks, rows, asset_id=token, require_complete_top_hints=True)
        except L2ReplayNotReady:
            self.ready = False
            return "top_fence_failed"
        bid = max(self.bids, default=None)
        ask = min(self.asks, default=None)
        if bid is not None and ask is not None and bid >= ask:
            self.ready = False
            return "crossed_book"
        self.seen = at
        self.top = (float(bid) if bid else None, float(self.bids[bid]) if bid else None,
                    float(ask) if ask else None, float(self.asks[ask]) if ask else None)
        if ask and self.asks[ask] >= quantity:
            self.liquidity = ((float(ask), quantity),)
        else:
            self.liquidity = tuple((float(p), float(self.asks[p])) for p in sorted(self.asks))
        return None


@lru_cache(maxsize=32768)
def fill_cost(levels, quantity, rate, worst):
    if not levels or worst is None:
        return None
    try:
        return quote_buy(levels, quantity, rate, limit_price=worst)
    except ValueError:
        return None


def midpoint(tops):
    if any(value is None for top in tops for value in (top[0], top[2])):
        return None
    a, b = ((top[0]+top[2])/2 for top in tops)
    return a/(a+b)


def stats_add(counter, name, probability, label):
    counter[name+"_n"] += 1
    counter[name+"_correct"] += ((probability >= 0.5) == label)
    counter[name+"_brier_sum"] += (probability - label) ** 2


def calibration_add(counter, probability, label):
    bucket = f"decile_{min(9, int(probability*10))}"
    counter[bucket+"_n"] += 1
    counter[bucket+"_p_sum"] += probability
    counter[bucket+"_up"] += label


class Market:
    def __init__(self, definition, ref, snaps, weight, source):
        self.m = definition
        self.ref, self.snaps, self.weight = ref, snaps, weight
        self.start, self.end = definition["start_ts"], definition["end_ts"]
        self.tokens = (definition["up_token"], definition["down_token"])
        self.books = {token: Book() for token in self.tokens}
        gamma = definition["gamma_snapshot"]["raw"]
        fee_schedule = definition["fee_config"].get("feeSchedule", {})
        self.rate = fee_schedule.get("rate") if fee_schedule.get("exponent") == 1 else None
        self.quantity = float(gamma["orderMinSize"])
        resolution = definition["resolution"]
        opening, closing = (ref.official.get(t) for t in (self.start, self.end))
        self.label = resolution.get("up_won") if resolution["final"] else None
        self.anchor = None if opening is None else opening[1]
        self.close = None if closing is None else closing[1]
        self.oracle_agrees = (
            official_up(self.close, self.anchor) == self.label
            if self.anchor is not None and self.close is not None and self.label is not None else None)
        self.summary = dict(asset=definition["asset"], slug=definition["slug"], start=self.start,
                            source=source, winner=None if self.label is None else ("Up" if self.label else "Down"),
                            settlement_available=resolution["received_ts"], oracle_agrees=self.oracle_agrees,
                            opening_twap=self.anchor, closing_twap=self.close, order_shares=self.quantity,
                            fee_rate=self.rate, fee_observed_at=definition["fee_observed_at"])
        self.pending = deque()
        self.counts = Counter()
        self.phases = defaultdict(Counter)
        self.calibration = Counter()
        self.seconds = set()
        self.last_quote = None
        self.representative = None
        self.last_horizons = None

    def settle_arrivals(self, at):
        while self.pending and self.pending[0][0] < at:
            arrival, limits, source_quote = self.pending.popleft()
            fills = {}
            for side, token, limit in zip(("up", "down"), self.tokens, limits):
                stats = self.counts
                stats[side+"_attempts"] += 1
                book = self.books[token]
                if arrival >= self.end:
                    status = "market_ended"
                elif self.rate is None:
                    status = "fee_unknown"
                elif limit is None:
                    status = "no_decision_ask"
                elif not book.ready or arrival - book.seen > FRESH_SECONDS:
                    status = "book_unavailable"
                else:
                    fill = fill_cost(book.liquidity, self.quantity, self.rate, limit)
                    status = "fill" if fill else "no_fill_within_limit"
                stats[side+"_"+status] += 1
                fills[side] = {"status": status}
                if status != "fill":
                    continue
                stats[side+"_fees"] += fill.fees
                fills[side].update(cost=fill.total, fee=fill.fees)
                if self.label is None:
                    continue
                won = (side == "up") == self.label
                stats[side+"_settled_fills"] += 1
                stats[side+"_wins"] += won
                stats[side+"_pnl"] += (self.quantity if won else 0) - fill.total
            if source_quote:
                source_quote["fills"] = fills

    def frame(self, at, events):
        self.settle_arrivals(at)
        self.counts["frames"] += 1
        groups = {row["group_id"] for row in events if row["is_last_in_group"]}
        complete = any(row["raw_frame_complete"] for row in events)
        for token, rows in groupby(sorted(events, key=lambda row: row["asset_id"]), key=lambda row: row["asset_id"]):
            rows = list(rows)
            if complete and all(row["group_id"] and row["group_id"] in groups for row in rows):
                status = self.books[token].apply(rows, at, token, self.quantity)
            else:
                self.books[token].ready = False
                status = "invalid_frame"
            if status:
                self.counts[status] += 1
        if not self.start <= at < self.end:
            return
        self.summary.setdefault("first_frame", at)
        self.summary["last_frame"] = at
        books = [self.books[token] for token in self.tokens]
        missing_top = (None, None, None, None)
        tops = tuple(b.top if b.ready and at - b.seen <= FRESH_SECONDS else missing_top for b in books)
        if not any(b.ready and b.seen == at for b in books):
            return
        if all(top == missing_top for top in tops):
            self.last_quote = None
            self.counts["unavailable_book_frames"] += 1
            return
        if missing_top in tops:
            self.counts["one_sided_book_frames"] += 1
        if tops == self.last_quote:
            return
        self.last_quote = tops
        self.seconds.add(int(at-self.start))
        self.counts["quotes"] += 1
        self.summary.setdefault("first_quote", at)
        self.summary["last_quote"] = at
        # Policy uses a separate limit equal to each side's observed best ask.
        # Matching requires the full market minimum at that price or better after latency.
        quote = None
        forecast, missing = self.ref.forecast(at, self.start)
        snap = snapshot_at(self.snaps, at)
        market_p = midpoint(tops)
        phase = str(min(4, int((at-self.start)//60)))
        if forecast is None or snap is None:
            self.counts[missing or "indicators_unavailable"] += 1
        else:
            prices = price_forecasts(forecast, snap["forward"])
            twap = prices["twap"]
            model = float(expit(self.weight * logit(min(.999, max(.001, twap))) + snap["contribution"]))
            self.counts["predictions"] += 1
            if self.label is not None and self.oracle_agrees is not False:
                calibration_add(self.calibration, model, self.label)
                for counter in (self.counts, self.phases[phase]):
                    stats_add(counter, "model", model, self.label)
                    stats_add(counter, "twap", twap, self.label)
                    if market_p is not None:
                        stats_add(counter, "paired_model", model, self.label)
                        stats_add(counter, "paired_twap", twap, self.label)
                        stats_add(counter, "market", market_p, self.label)
            for horizon in (30, 60):
                key = f"price_{horizon}s"
                predicted = prices[key]
                actual = self.ref.price_at(at + horizon) if predicted else None
                if actual is not None:
                    self.counts[key+"_n"] += 1
                    self.counts[key+"_absolute_error"] += abs(predicted[1] - actual)
                    self.counts[key+"_flat_absolute_error"] += abs(prices["spot"] - actual)
                    self.counts[key+"_interval_hits"] += predicted[0] <= actual <= predicted[2]
            quote = dict(at=at, p_up=model, p_down=1-model, market_p_up=market_p, tops=tops,
                         indicator_status=snap["status"], **prices)
            self.representative = quote
            if prices["price_60s"] is not None:
                self.last_horizons = {key: quote[key] for key in ("at", "spot", "price_30s", "price_60s")}
        # Keep a small presentation sample in memory. Aggregate all quote attempts.
        self.pending.append((at + LATENCY, [top[2] for top in tops], quote))

    def finish(self):
        # At the end of captured input, prices after the last observed frame are unknown.
        while self.pending:
            arrival, _, quote = self.pending.popleft()
            status = "market_ended" if arrival >= self.end else "arrival_beyond_capture"
            for side in ("up", "down"):
                self.counts[side+"_attempts"] += 1
                self.counts[side+"_"+status] += 1
            if quote:
                quote["fills"] = {side: {"status": status} for side in ("up", "down")}
        return dict(**self.summary, quote_seconds=len(self.seconds), counts=dict(self.counts),
                    phase_counts=dict(self.phases), calibration=dict(self.calibration),
                    last_prediction=self.representative, last_horizons=self.last_horizons)


def quote_frames(db, path, tokens):
    rel = db.from_parquet(str(path))
    exchange = "exchange_us" if "exchange_us" in rel.columns else "epoch_us(timestamp)"
    rel.create_view("capture", replace=True)
    db.register("replay_tokens", pa.table({"asset_id": list(tokens)}))
    cursor = db.execute(f"""
        SELECT raw_received_wall_ns, market, c.asset_id, raw_connection_id,
            raw_connection_generation, raw_frame_seq, message_index, change_index,
            event_type, bids, asks, price, size, side, best_bid, best_ask,
            raw_frame_complete, is_last_in_group, group_id, clock_invalid_reason, {exchange} AS exchange_us
        FROM capture c INNER JOIN replay_tokens t ON c.asset_id=t.asset_id
        WHERE source=? AND raw_received_wall_ns IS NOT NULL AND raw_connection_id IS NOT NULL
            AND raw_connection_generation IS NOT NULL AND raw_frame_seq IS NOT NULL
            AND event_type IN ('book','price_change')
        ORDER BY raw_received_wall_ns, raw_connection_id, raw_connection_generation,
            raw_frame_seq, market, message_index, change_index
        """, [PRIMARY])
    def rows():
        names = [column[0] for column in cursor.description]
        while batch := cursor.fetchmany(8192):
            yield from (dict(zip(names, row)) for row in batch)
    key = ("raw_received_wall_ns", "raw_connection_id", "raw_connection_generation", "raw_frame_seq", "market")
    for identity, events in groupby(rows(), key=lambda row: tuple(row[k] for k in key)):
        yield identity[0] / 1e9, identity[-1], list(events)


def aggregate(rows):
    results = {}
    for asset in ASSETS:
        cohort = [row for row in rows if row["asset"] == asset]
        total = Counter()
        calibration = Counter()
        phases = defaultdict(Counter)
        window_briers = defaultdict(list)
        for row in cohort:
            counts = row["counts"]
            total.update(counts)
            calibration.update(row["calibration"])
            for phase, values in row["phase_counts"].items():
                phases[phase].update(values)
            for field in ("model", "twap", "paired_model", "paired_twap", "market"):
                if counts.get(field+"_n", 0):
                    window_briers[field].append(counts[field+"_brier_sum"] / counts[field+"_n"])
        results[asset] = dict(
            totals=dict(total), phase_counts=dict(phases), windows=len(cohort),
            source_modes=dict(Counter(row["source"] for row in cohort)),
            quote_windows=sum(bool(row["counts"].get("quotes")) for row in cohort),
            forecast_windows=sum(bool(row["counts"].get("predictions")) for row in cohort),
            last_minute_windows=sum(bool(row["phase_counts"].get("4")) for row in cohort),
            quote_seconds=sum(row["quote_seconds"] for row in cohort),
            oracle_matches=sum(row["oracle_agrees"] is True for row in cohort),
            oracle_mismatches=sum(row["oracle_agrees"] is False for row in cohort),
            window_weighted_brier={k: sum(v) / len(v) for k, v in window_briers.items()},
            calibration=dict(calibration),
        )
    return results


def telegram_digest(start, rows):
    until = start + 300
    zone = ZoneInfo("Asia/Shanghai")
    def time(ts, pattern="%H:%M:%S"):
        return datetime.fromtimestamp(ts, zone).strftime(pattern)
    def top(values):
        return "/".join(f"{v:.3f}" if v is not None else "—" for v in (values[0], values[2]))
    def price(values):
        return "—" if values is None else f"{values[1]:,.2f} [{values[0]:,.2f}, {values[2]:,.2f}]"
    lines = [f"BTC / ETH 5 分钟回放｜{time(start, '%m-%d %H:%M')}–{time(until, '%H:%M')} 北京时间"]
    for row in rows:
        n = row["counts"]
        lines += ["", row["asset"] + "｜" + {"raw": "原始盘口", "checkpoint": "前段归档", "missing": "盘口缺档"}[row["source"]]]
        sample = row["last_prediction"]
        if sample:
            active = sum(value == "ok" for value in sample["indicator_status"].values())
            lines.extend((
                f"{time(sample['at'])} 预测 Up {sample['p_up']:.1%} / Down {sample['p_down']:.1%}｜指标 {active}/{len(sample['indicator_status'])}",
                f"Binance 现货 {sample['spot']:,.2f} USDT｜结算 TWAP {price(sample['closing_twap'])} USD",
                f"开盘 TWAP {sample['anchor']:,.2f} USD",
                f"买一/卖一 Up {top(sample['tops'][0])}｜Down {top(sample['tops'][1])}",
            ))
            horizons = row["last_horizons"]
            if horizons:
                lines.append(f"{time(horizons['at'])} 短线预测（USDT）｜30 秒 {price(horizons['price_30s'])}｜60 秒 {price(horizons['price_60s'])}")
        lines += [
            f"报价 {n.get('quotes', 0):,}｜预测 {n.get('predictions', 0):,}｜有效报价秒 {row['quote_seconds']}/300",
            f"模拟成交 Up {n.get('up_fill', 0):,}/{n.get('up_attempts', 0):,}｜Down {n.get('down_fill', 0):,}/{n.get('down_attempts', 0):,}",
            f"结算 {row['winner'] if row['settlement_available'] <= until else '待官方入档'}",
            f"https://polymarket.com/event/{row['slug']}",
        ]
    lines.extend(("", "历史回放样例｜区间为模型 80% 预测区间"))
    return "\n".join(lines)


def replay_hour(hour):
    args, start, raw_symbols, refs, series, weights = REPLAY
    db = duckdb.connect(config={"threads": 2})
    markets = {condition: m for condition, m in raw_symbols.items() if hour <= m["start_ts"] < hour + 3600}
    selected = {}
    runs = []
    for directory in args.raw_dir:
        raw = directory / f"{(hour-start)//3600:02d}.parquet"
        if not raw.is_file():
            continue
        conditions = {r[0] for r in db.execute("""
            SELECT market FROM read_parquet(?) WHERE source=? AND raw_received_wall_ns IS NOT NULL
            GROUP BY market HAVING count(DISTINCT asset_id)=2
            """, [str(raw), PRIMARY]).fetchall()} & markets.keys() - selected.keys()
        if conditions:
            selected.update(dict.fromkeys(conditions, "raw"))
            runs.append(("raw", raw, conditions))
    fallback = args.checkpoint_dir / "hours" / str(hour) / "source.parquet"
    remaining = markets.keys() - selected.keys()
    selected.update(dict.fromkeys(remaining, "checkpoint" if fallback.is_file() else "missing"))
    if remaining and fallback.is_file():
        runs.append(("checkpoint", fallback, remaining))
    states = {condition: Market(m, refs[m["asset"]], series[m["asset"]], weights[m["asset"]], selected[condition])
              for condition, m in markets.items()}
    files = []
    for mode, path, conditions in runs:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        provenance = dict(path=str(path), mode=mode, sha256=digest.hexdigest())
        if mode == "raw":
            provenance["archive_paths"] = [r[0] for r in db.execute(
                "SELECT DISTINCT filename FROM read_parquet(?) ORDER BY filename", [str(path)]).fetchall()]
        files.append(provenance)
        tokens = [token for condition in conditions for token in states[condition].tokens]
        for at, condition, events in quote_frames(db, path, tokens):
            if condition in conditions:
                market = states[condition]
                if at <= (market.end if mode == "raw" else market.start + args.checkpoint_seconds + LATENCY):
                    market.frame(at, events)
    db.close()
    rows = [m.finish() for m in states.values()]
    print(f"{(hour-start)//3600:02d} UTC: {sum(m['counts'].get('quotes',0) for m in rows):,} quote changes",
          file=sys.stderr, flush=True)
    return rows, files


def main():
    global REPLAY
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--day", required=True, type=lambda value: datetime.fromisoformat(value).replace(tzinfo=timezone.utc))
    parser.add_argument("--normalized", required=True, type=Path)
    parser.add_argument("--checkpoint-dir", required=True, type=Path)
    parser.add_argument("--raw-dir", action="append", type=Path, default=[])
    parser.add_argument("--indicator-js", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--checkpoint-seconds", type=int, default=60)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)
    day = args.day
    start = int(day.timestamp())
    end = start + 86400
    source_root = args.checkpoint_dir
    definitions = [m for m in json.loads((source_root / "markets.json").read_text())
                   if start <= m["start_ts"] < end and m["asset"] in ASSETS]
    if len(definitions) != 576 or {(m["asset"], m["start_ts"]) for m in definitions} != {
        (asset, at) for asset in ASSETS for at in range(start, end, 300)
    }:
        raise ValueError("market universe must bind both assets for every five-minute window")
    if any(m["gamma_snapshot"]["raw"]["cryptoMarketConfig"].get("twapLookbackSeconds") != 60 for m in definitions):
        raise ValueError("market universe contains a non-60-second settlement")
    dates = [(day + timedelta(days=i)).date().isoformat() for i in range(-20, 1)]
    binance = args.normalized / "binance" / "normalized"
    xue = args.normalized / "official-xue"
    db = duckdb.connect(config={"threads": 3})
    by_asset = defaultdict(list)
    with TemporaryDirectory(dir=args.scratch) as work:
        bars_path = Path(work) / "indicator-bars.json"
        bars = {asset: {name: archived_bars(db, binance, asset, dates, duration)
                        for name, duration in (("minute", 60), ("five", 300), ("daily", 86400))}
                for asset in ASSETS}
        bars_path.write_text(json.dumps(bars))
        del bars
        print("Closed-bar inputs ready. Computing current indicator catalog.", file=sys.stderr, flush=True)
        command = ["node", str(args.indicator_js), str(bars_path), str((start - 3 * 86400) * 1000)]
        with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as indicator_runner:
            for line in indicator_runner.stdout:
                row = json.loads(line)
                by_asset[row["asset"]].append(row)
            if indicator_runner.wait():
                raise RuntimeError("offline catalog calculation failed")
    series = {asset: ([row["availableAt"]/1000 for row in rows], rows) for asset, rows in by_asset.items()}
    refs = {asset: Reference(db, binance, xue, asset,
                              dates[-5:] + [(day + timedelta(days=1)).date().isoformat()])
            for asset in ASSETS}
    trained = {asset: train(refs[asset], series[asset], start - 3 * 86400, start) for asset in ASSETS}
    indicator_coverage = {}
    for asset, rows in by_asset.items():
        status = defaultdict(Counter)
        for row in rows:
            if start <= row["availableAt"]/1000 < end:
                for ident, value in row["status"].items():
                    status[ident][value] += 1
        indicator_coverage[asset] = {ident: dict(values) for ident, values in status.items()}
    db.close()
    print("Indicator model frozen before evaluation. Starting quote replay.", file=sys.stderr, flush=True)
    REPLAY = (args, start, {row["condition_id"]: row for row in definitions}, refs, series,
              {asset: trained[asset][0] for asset in ASSETS})
    report_rows = []
    input_files = []
    with ProcessPoolExecutor(max_workers=args.workers, mp_context=get_context("fork")) as pool:
        for rows, files in pool.map(replay_hour, range(start, end, 3600)):
            report_rows.extend(rows)
            input_files.extend(files)
    report_rows.sort(key=lambda row: (row["start"], row["asset"]))
    digests = [telegram_digest(at, list(rows)) for at, rows in groupby(report_rows, key=lambda row: row["start"])]
    args.output.write_text(json.dumps(dict(start=start, end=end, windows=report_rows, digests=digests,
        summary=aggregate(report_rows), input_files=input_files,
        indicator_coverage=indicator_coverage, models={asset: trained[asset][1] for asset in ASSETS},
        assumptions=dict(binance_availability="archive modeled bar-end receipt where original receipt is absent",
                         quote_source=PRIMARY, latency_ms=250, max_book_age_seconds=FRESH_SECONDS,
                         economics="fee metadata archived after the evaluated windows, independent orders, no fees rounded",
                         checkpoint_cutoff_seconds=args.checkpoint_seconds,
                         oracle="Polymarket relayed exact Chainlink TWAP and CTF token payouts")), ensure_ascii=False))


if __name__ == "__main__":
    main()
