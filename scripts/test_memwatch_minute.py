"""Tests for scripts/lib/memwatch_minute.py — the user timers' reader of
memwatch's minute log (#4791). Loosen one and a timer acts on a torn line, a
null Windows reading or a line whose time it cannot read.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import memwatch_minute as m


def test_the_newest_whole_line_stands_over_a_torn_one(tmp_path):
    log = tmp_path / "minute.jsonl"
    log.write_text(
        json.dumps({"ts": "2026-11-09T20:00:02+0800", "win_avail_mb": 900}) + "\n"
        '{"ts": "2026-11-09T20:0'
    )
    assert m.newest_line(log)["win_avail_mb"] == 900


def test_a_missing_log_raises(tmp_path):
    with pytest.raises(OSError):
        m.newest_line(tmp_path / "none")


def test_a_sample_is_dated_by_its_age():
    line = {"ts": "2026-11-09T20:00:02+0800", "win_avail_mb": 900, "win_age_s": 62}
    sample = m.win_sample(line)
    assert sample.avail_mb == 900
    assert sample.taken_at == m.parse_ts("2026-11-09T19:59:00+0800")


def test_a_null_reading_is_no_sample():
    line = {"ts": "2026-11-09T20:00:02+0800", "win_avail_mb": None, "win_age_s": None}
    assert m.win_sample(line) is None


def test_an_unreadable_ts_is_no_sample_and_says_so(capsys):
    line = {"ts": "yesterday", "win_avail_mb": 900, "win_age_s": 5}
    assert m.win_sample(line) is None
    assert "unreadable minute-line ts" in capsys.readouterr().err


def test_format_ts_reads_back():
    assert m.parse_ts(m.format_ts(1_800_000_000)) == 1_800_000_000
