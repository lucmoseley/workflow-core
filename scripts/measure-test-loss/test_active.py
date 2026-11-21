"""Pins that active.py reports a malformed timestamp it skips (#5487)."""

import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import active  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def test_a_malformed_timestamp_is_skipped_and_reported(tmp_path, capsys):
    p = tmp_path / "s1.jsonl"
    p.write_text(json.dumps({"type": "assistant", "timestamp": "not a time"}) + "\n")
    tally = Counter()
    rows = active.scan_file(
        str(p), "wfc", "2026-10-10T00:00:00Z", "2026-10-12T00:00:00Z", tally=tally
    )
    assert rows == []
    assert tally[active.BAD_TIMESTAMP] == 1
    err = capsys.readouterr().err
    assert f"fail-open: timestamp in {p} skipped: ValueError" in err
