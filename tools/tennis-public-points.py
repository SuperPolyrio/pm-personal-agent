"""Import one match from the pinned public research sample into an isolated Agent database."""

import argparse
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
from pathlib import Path
import sqlite3
from urllib.request import urlopen
from uuid import uuid4


from source_config import source_settings

ZENODO = source_settings("PM_ZENODO_URL")["PM_ZENODO_URL"]
RECORD = f"{ZENODO}/api/records/23718893"
FILES = ("matches.csv.gz", "players.csv.gz", "points_sample_2026-06.csv.gz")


def read_url(url: str, limit: int) -> bytes:
    with urlopen(url, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"response too large: {url}")
    return data


def csv_rows(data: bytes):
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        with io.TextIOWrapper(compressed, encoding="utf-8") as text:
            yield from csv.DictReader(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True, help="Existing isolated PM_STATE_DIR")
    parser.add_argument("--match-id", required=True, help="Live Tennis API public sample match_id")
    parser.add_argument("--dataset-dir", type=Path, help="Optional directory containing the original Zenodo files")
    args = parser.parse_args()
    db_path = args.state_dir / "personal.sqlite"
    if not db_path.is_file() or not args.match_id.isdigit():
        parser.error("Start an isolated Agent before importing an exact numeric match ID.")
    metadata = json.loads(read_url(RECORD, 512_000))
    assets = {item["key"]: item for item in metadata["files"]}
    digests = {}

    def source(name):
        asset = assets[name]
        path = args.dataset_dir / name if args.dataset_dir else None
        url = f"{RECORD}/files/{name}/content"
        data = path.read_bytes() if path else read_url(url, min(20_000_000, asset["size"]))
        algo, expected = asset["checksum"].split(":", 1)
        if len(data) != asset["size"] or hashlib.new(algo, data).hexdigest() != expected:
            raise ValueError(f"{name} does not match the pinned Zenodo version.")
        digests[name] = {"url": url, "checksum": asset["checksum"]}
        return csv_rows(data)

    match = next((m for m in source(FILES[0]) if m["match_id"] == args.match_id), None)
    if not match or match["tier_key"] not in ("265", "266"):
        parser.error("This importer expects an ATP or WTA singles fixture in the public sample.")
    ids = [match["player1_id"], match["player2_id"]]
    players = {p["player_id"]: p["name"] for p in source(FILES[1]) if p["player_id"] in ids}
    rows = []
    for point in source(FILES[2]):
        if point["match_id"] != args.match_id:
            continue
        timestamp = datetime.fromisoformat(point["timestamp_utc"]).replace(tzinfo=timezone.utc)
        rows.append({
            "at": timestamp.isoformat(), "games": list(zip(json.loads(point["games_p1"]), json.loads(point["games_p2"]), strict=True)),
            "points": [point["points_p1"], point["points_p2"]],
            "server": int(point["server"])-1 if point["server"] in ("1", "2") else None,
            "tiebreak": point["is_tiebreak"].lower() == "true",
        })
    if not rows:
        parser.error("No live-observed point states for this match in the pinned sample.")
    evidence_id = str(uuid4())
    data = {"kind": "tennis_observed_archive", "sourceMatchId": args.match_id, "players": [players[i] for i in ids],
            "competition": match["tournament"], "date": match["scheduled_time_utc"][:10],
            "tour": "ATP" if match["tier_key"] == "265" else "WTA", "match": match, "rows": rows,
            "sampleVersion": metadata["metadata"]["version"], "license": metadata["metadata"]["license"]["id"], "assets": digests}
    with sqlite3.connect(db_path, timeout=5) as db:
        db.execute("INSERT INTO evidence VALUES (?,?,?,?)", (evidence_id, f"{ZENODO}/records/{metadata['id']}",
                   datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), json.dumps(data)))
    print(json.dumps({"evidenceId": evidence_id, "matchId": args.match_id, "players": data["players"], "rows": len(rows)}))


if __name__ == "__main__":
    main()
