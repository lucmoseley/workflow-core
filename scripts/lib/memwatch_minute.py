"""memwatch_minute.py — the user timers' one reader of memwatch's minute log,
`~/memwatch-minute.jsonl` (docs/environment.md §4), shared so the timers parse
it alike (#4791).
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

MINUTE_LOG = Path.home() / "memwatch-minute.jsonl"
# Read from the log's end: a line is ~800 bytes, so this holds several whole
# lines, a torn last one included.
TAIL_BYTES = 16384


class WinSample(NamedTuple):
    taken_at: float
    avail_mb: int


def parse_ts(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z").timestamp()


def format_ts(t):
    """memwatch's own timestamp shape, so parse_ts reads it back."""
    return datetime.fromtimestamp(t).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def json_lines(raw_lines):
    for raw in raw_lines:
        try:
            yield json.loads(raw)
        except ValueError:
            # A line still being written, or torn by a killed run; the rest stand (#4791).
            continue


def newest_line(path):
    """The newest whole JSON line of `path`, or None. Raises OSError where the
    log cannot be read."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - TAIL_BYTES))
        lines = f.read().splitlines()
    return next(json_lines(reversed(lines)), None)


def win_sample(line):
    """Windows' free memory off a minute line and when it was sampled, or None
    where the line carries no reading: memwatch writes null once its sample is
    over 120 s old."""
    if not line:
        return None
    avail, age, ts = line.get("win_avail_mb"), line.get("win_age_s"), line.get("ts")
    if not isinstance(avail, int) or not isinstance(age, int) or not ts:
        return None
    try:
        return WinSample(parse_ts(ts) - age, avail)
    except ValueError:
        # No reading; said, so a malformed memwatch line shows in the journal (#4791).
        print(f"unreadable minute-line ts: {ts!r}", file=sys.stderr)
        return None
