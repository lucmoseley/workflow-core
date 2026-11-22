import json
import os
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

from fail_open import expected, fail_open

MINUTE_LOG = Path.home() / "memwatch-minute.jsonl"
# guess, #4791
TAIL_BYTES = 16384


class WinSample(NamedTuple):
    taken_at: float
    avail_mb: int


def parse_ts(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z").timestamp()


def format_ts(t):
    return datetime.fromtimestamp(t).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def newest_line(path):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        start = max(0, f.tell() - TAIL_BYTES)
        f.seek(start)
        lines = f.read().splitlines()
    for i, raw in enumerate(reversed(lines)):
        if i == 0 or (i == len(lines) - 1 and start > 0):
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                expected(error, "the line in flight, or the one the tail's seek cut")
                continue
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            fail_open(error, "torn minute line skipped")
    return None


def win_sample(line):
    if not line:
        return None
    avail, age, ts = line.get("win_avail_mb"), line.get("win_age_s"), line.get("ts")
    if not isinstance(avail, int) or not isinstance(age, int) or not ts:
        return None
    try:
        return WinSample(parse_ts(ts) - age, avail)
    except ValueError as error:
        fail_open(error, f"minute line with ts {ts!r} read as no sample")
        return None
