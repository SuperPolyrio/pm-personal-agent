"""Collect one finished Wimbledon WTA singles match and its PMXT quotes into an isolated Agent store."""

import argparse
from bisect import bisect_left
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import re
import sqlite3
from uuid import uuid4

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import requests


from source_config import source_settings

SOURCES = source_settings("PM_WIMBLEDON_URL", "PM_WTA_API_URL", "PM_PMXT_DATA_URL")
WIMBLEDON = SOURCES["PM_WIMBLEDON_URL"] + "/graphql"
WTA = SOURCES["PM_WTA_API_URL"] + "/tennis/tournaments/904"
# This source identifier is also used by the Agent to find existing archived evidence.
PMXT = "https://archive.pmxt.dev/Polymarket/v2"
MAX_RANGE = 32 * 1024 * 1024


def response_json(url, **args):
    method = "POST" if args else "GET"
    with requests.request(method, url, timeout=20, stream=True, **args) as response:
        response.raise_for_status()
        payload = response.raw.read(8_000_001, decode_content=True)
    if len(payload) > 8_000_000:
        raise ValueError("Source payload exceeds the read limit.")
    return json.loads(payload)


def graph(query):
    result = response_json(WIMBLEDON, json={"query": query})
    if result.get("errors"):
        raise ValueError(result["errors"][0]["message"])
    return result["data"]


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def points_for(year, match_id, wta_id):
    history = graph(f'''{{ pointHistory(year:"{year}",matchId:"{match_id}"){{ matchId year history }}
        draw(year:{year},eventCode:"LS"){{ matches{{ matchId winner team1{{ idA }} team2{{ idA }} }} }} }}''')
    fixture = next(m for m in history["draw"]["matches"] if m["matchId"] == match_id)
    point_history = history["pointHistory"]
    if point_history["matchId"] != match_id or str(point_history["year"]) != year:
        raise ValueError("SlamTracker point-history identity mismatch.")
    source = f"{WTA}/{year}/matches/{wta_id}"
    with ThreadPoolExecutor(max_workers=2) as pool:
        score, totals = list(pool.map(response_json, (source + "/score", source + "/stats")))
    match = next(m for m in score if m["MatchID"] == wta_id and str(m["EventYear"]) == year)
    stats = next(m for m in totals if m["matchid"] == wta_id and str(m["eventyear"]) == year and m["setnum"] == 0)
    ids = [fixture[team][0]["idA"].removeprefix("wta") for team in ("team1", "team2")]
    sides_by_id = {match["PlayerIDA"]: "A", match["PlayerIDB"]: "B"}
    if len(set(ids)) != 2 or set(ids) != set(sides_by_id):
        raise ValueError("SlamTracker and WTA player IDs disagree.")
    order = [sides_by_id[id] for id in ids]
    if match["MatchState"] != "F" or match["DrawMatchType"] != "S" or re.search(r"retir|\bret\b|walkover", match["ResultString"], re.I):
        raise ValueError("The independent WTA source must confirm a completed singles match.")
    raw = json.loads(point_history["history"])
    points = [p for p in raw if re.fullmatch(r"[1-9]\d*", p["PointNumber"])]
    points.sort(key=lambda p: int(p["PointNumber"]))
    expected_won = [int(stats["totptswon" + side.lower()]) for side in order]
    expected_served = [int(stats["totservplayed" + side.lower()]) for side in order]
    final = [[int(match[f"ScoreSet{n}{side}"]) for side in order] for n in range(1, int(match["NumSets"])+1)]
    if len(points) != sum(expected_won) or len(points) != sum(expected_served):
        raise ValueError("The point sequence does not match the independent WTA totals.")
    played = []
    wins, serves = Counter(), Counter()
    games = [[0, 0]]
    before = ["0", "0"]
    in_game = 0
    prior_end = 0
    first_server = int(points[0]["PointServer"]) - 1
    for number, p in enumerate(points, 1):
        set_no, game_no = int(p["SetNo"]), int(p["GameNo"])
        winner, server = int(p["PointWinner"]) - 1, int(p["PointServer"]) - 1
        started, ended = int(p["EpochTimeStart"]), int(p["EpochTimeEnd"])
        game_winner = int(p["GameWinner"]) - 1
        set_winner = int(p["SetWinner"]) - 1
        tiebreak_turns = (in_game+1) // 2 if game_no == 13 else 0
        expected_server = (first_server + sum(map(sum, games)) + tiebreak_turns) % 2
        if (int(p["PointNumber"]) != number or p["MatchID"] != match_id or winner not in (0,1)
                or server != expected_server or set_no != len(games) or game_no != sum(games[-1])+1
                or not prior_end < ended or not 0 < started <= ended):
            raise ValueError(f"Point order, server rotation or event time is inconsistent at point {number}.")
        wins[winner] += 1
        serves[server] += 1
        if [int(p["P1PointsWon"]), int(p["P2PointsWon"])] != [wins[0],wins[1]]:
            raise ValueError(f"Cumulative points disagree at point {number}.")
        previous_games = games[-1].copy()
        after = [p["P1Score"], p["P2Score"]]
        if game_winner >= 0:
            if game_winner != winner:
                raise ValueError(f"Point and game winner disagree at point {number}.")
            games[-1][game_winner] += 1
        if games[-1] != [int(p["P1GamesWon"]), int(p["P2GamesWon"])]:
            raise ValueError(f"Game score disagrees at point {number}.")
        played.append({"number": number, "set": set_no, "game": game_no, "startedAt": iso(started), "endedAt": iso(ended),
                       "server": server, "winner": winner, "before": before, "after": after,
                       "gamesBefore": previous_games, "gamesAfter": games[-1].copy(), "gameEnded": game_winner >= 0})
        if set_winner >= 0 and p["MatchWinner"] == "0":
            games.append([0, 0])
        prior_end = ended
        before = after
        in_game = 0 if game_winner >= 0 else in_game+1
    wta_winner = "AB"[int(match["Winner"])-2]
    if (games != final or [wins[0],wins[1]] != expected_won or [serves[0],serves[1]] != expected_served
            or points[-1]["MatchWinner"] != fixture["winner"] or order[int(fixture["winner"])-1] != wta_winner):
        raise ValueError("The final score, winner or service totals do not match the independent WTA record.")
    return {"kind":"tennis_wimbledon_points", "eventKey":f"tennis:wta:{year}.904.{wta_id}", "wimbledonMatchId":match_id,
            "officialDate":match["MatchTimeStamp"][:10], "players":ids, "final":final, "total":sum(expected_won),
            "pointsWon":expected_won, "servicePoints":expected_served, "points":played, "rawPointHistory":points,
            "stats":stats, "scoreUrl":source+"/score", "statsUrl":source+"/stats", "feedUrl":WIMBLEDON}


class RangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.position = url, 0
        self.session = requests.Session()
        self.session.trust_env = False
        with self.session.head(url, timeout=15) as response:
            response.raise_for_status()
            self.length = int(response.headers["Content-Length"])

    def close(self):
        self.session.close()
        super().close()

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        self.position = (0, self.position, self.length)[whence]+offset
        return self.position

    def read(self, size=-1):
        start = self.position
        end = min(self.length, start+size if size >= 0 else self.length)-1
        if end < start:
            return b""
        if end-start >= MAX_RANGE:
            raise ValueError("PMXT range exceeds the download limit.")
        headers = {"Range": f"bytes={start}-{end}"}
        with self.session.get(self.url, headers=headers, timeout=20, stream=True) as r:
            if r.status_code != 206 or r.headers.get("Content-Range") != f"bytes {start}-{end}/{self.length}":
                raise ValueError(f"PMXT returned an invalid range: HTTP {r.status_code}.")
            data = r.raw.read(end-start+2)
            if len(data) != end-start+1:
                raise ValueError("PMXT range length mismatch.")
        self.position += len(data)
        return data


def hour_rows(hour, wanted):
    url = f"{SOURCES['PM_PMXT_DATA_URL']}/polymarket_orderbook_{hour:%Y-%m-%dT%H}.parquet"
    columns = ["market", "asset_id", "timestamp", "timestamp_received", "event_type", "best_bid", "best_ask", "bids", "asks"]
    found = defaultdict(list)
    with RangeFile(url) as remote:
        parquet = pq.ParquetFile(remote)
        market_col = parquet.schema.names.index("market")
        width = parquet.schema.column(market_col).length
        if width not in (32,66):
            raise ValueError(f"Unrecognized PMXT condition representation ({width} bytes).")
        keys = {(c.encode() if width == 66 else bytes.fromhex(c[2:])): c for c in wanted}
        for group in range(parquet.num_row_groups):
            stats = parquet.metadata.row_group(group).column(market_col).statistics
            relevant = [k for k in keys if not stats or stats.min <= k <= stats.max]
            if not relevant:
                continue
            batch = parquet.read_row_group(group, columns=columns, use_threads=False)
            mask = pc.is_in(batch["market"], value_set=pa.array(relevant, type=batch["market"].type))
            mask = pc.and_(mask, pc.is_in(batch["asset_id"], value_set=pa.array(list(wanted.values()))))
            for item in batch.filter(mask).to_pylist():
                condition, token = keys[item["market"]], item["asset_id"]
                if token != wanted[condition] or item["event_type"] not in ("book","price_change"):
                    continue
                bid, ask = item["best_bid"], item["best_ask"]
                if item["event_type"] == "book":
                    bids, asks = json.loads(item["bids"] or "[]"), json.loads(item["asks"] or "[]")
                    bid = max((float(p) for p,s in bids if float(s)>0), default=None)
                    ask = min((float(p) for p,s in asks if float(s)>0), default=None)
                found[condition].append((item["timestamp_received"], item["timestamp"], bid, ask, item["event_type"], url))
    return url, found


def select_quotes(points, snapshots):
    events = [datetime.fromisoformat(p["endedAt"]) for p in points]
    first = (events[0] - timedelta(seconds=30)).replace(minute=0, second=0, microsecond=0)
    hours = [first + timedelta(hours=i) for i in range(1+int((events[-1]-first).total_seconds()//3600))]
    if len(hours) > 8:
        raise ValueError("Select a finished singles match spanning at most eight hourly files.")
    wanted = {s["market"]["contract"]["conditionId"]:s["market"]["contract"]["outcomeToken"] for s in snapshots}
    if len(wanted) != len(snapshots):
        raise ValueError("Select one outcome per condition in each collection run.")
    with ThreadPoolExecutor(max_workers=3) as pool:
        loaded = list(pool.map(lambda hour: hour_rows(hour, wanted), hours))
    for snapshot in snapshots:
        contract = snapshot["market"]["contract"]
        condition, token = contract["conditionId"], contract["outcomeToken"]
        events_for_market = sorted((item for _, f in loaded for item in f[condition]), key=lambda q:(q[0],q[1]))
        times = [r[0] for r in events_for_market]
        quotes = []
        one_sided = []
        for point, ended in zip(points, events, strict=True):
            i = bisect_left(times, ended)-1
            if i < 0:
                continue
            receipt, exchange, bid, ask, kind, url = events_for_market[i]
            if not (0 <= (ended-exchange).total_seconds() <= 30 and (ended-receipt).total_seconds() <= 30):
                continue
            row = {"number":point["number"], "receivedAt":receipt.isoformat(), "exchangeAt":exchange.isoformat(),
                   "bid":float(bid) if bid is not None else None, "ask":float(ask) if ask is not None else None,
                   "eventType":kind, "url":url}
            if row["bid"] is not None and row["ask"] is not None and 0 < row["bid"] <= row["ask"] < 1:
                quotes.append(row)
            elif row["bid"] in (None, 0) or row["ask"] in (None, 1):
                one_sided.append(row)
        yield {"kind":"tennis_pmxt_quotes", "eventKey":snapshot["eventKey"], "conditionId":condition, "tokenId":token,
               "hours":[url for url,_ in loaded], "eventCount":len(events_for_market), "quotes":quotes,
               "oneSidedQuotes":one_sided}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--year", required=True)
    parser.add_argument("--wimbledon-match-id", required=True)
    parser.add_argument("--wta-match-id", required=True)
    parser.add_argument("--snapshot-id", action="append", required=True)
    args = parser.parse_args()
    if (not re.fullmatch(r"20\d{2}",args.year) or not re.fullmatch(r"2\d{3}",args.wimbledon_match_id)
            or not re.fullmatch(r"LS\d{3,10}",args.wta_match_id) or len(args.snapshot_id)>4):
        parser.error("Expected a Wimbledon main-draw WTA match and up to four exact contract receipts.")
    db_path = args.state_dir / "personal.sqlite"
    with sqlite3.connect(f"{db_path.as_uri()}?mode=rw", uri=True, timeout=5) as db:
        snapshots = []
        for id in args.snapshot_id:
            row = db.execute("SELECT data FROM evidence WHERE id=? AND source='sports/snapshot'", (id,)).fetchone()
            if not row:
                parser.error(f"Missing sports snapshot {id}.")
            value = json.loads(row[0]); market = value.get("market") or {}
            contract = market.get("contract") or {}
            if (value["eventKey"] != f"tennis:wta:{args.year}.904.{args.wta_match_id}" or value["state"] != "final"
                    or (market.get("check") or {}).get("binding") != "verified"
                    or contract.get("outcomeToken") not in [t["tokenId"] for t in contract.get("outcomeTokens",[])]):
                parser.error("Use a final WTA event snapshot bound to the exact contract and outcome token.")
            snapshots.append(value)
        data = points_for(args.year, args.wimbledon_match_id, args.wta_match_id)
        book_records = list(select_quotes(data["points"], snapshots))
        at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
        point_id = str(uuid4())
        score_url = f"{SOURCES['PM_WIMBLEDON_URL']}/en_GB/scores/slamtracker/{args.wimbledon_match_id}"
        db.execute("INSERT INTO evidence VALUES (?,?,?,?)",(point_id,score_url,at,json.dumps(data)))
        receipts = []
        for record in book_records:
            id = str(uuid4()); record["pointArchiveId"] = point_id
            db.execute("INSERT INTO evidence VALUES (?,?,?,?)",(id,PMXT,at,json.dumps(record)))
            receipts.append({"evidenceId":id, "conditionId":record["conditionId"], "tokenId":record["tokenId"],
                             "bookEvents":record["eventCount"], "matchedPoints":len(record["quotes"])})
        db.commit()
        print(json.dumps({"pointsEvidenceId":point_id,"points":data["total"],"book":receipts}))


if __name__ == "__main__":
    main()
