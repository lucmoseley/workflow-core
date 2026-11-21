"""Pins that scan_ledger reads main transcripts from every seat root and
leaves subagent transcripts out (#375).

The `seat_roots` fixture points `transcript_corpus`'s seats at temp config
dirs, so a second seat can be staged and nothing reads the real corpus.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Breaking it lets the shed ledger's cost
(mantahostels#1407) be counted over one seat's sessions and understated without
a word.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scan_ledger as sl  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def test_main_transcripts_span_both_seat_roots(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    assert sl.tc.main_transcripts() == [
        str(roots[0] / "a.jsonl"),
        str(roots[1] / "b.jsonl"),
    ]


def test_a_day_whose_ledger_will_not_parse_is_dropped_and_reported(monkeypatch, capsys):
    def unparsable(rev=None):
        raise SystemExit("no §5 bullets at abcdef12")

    monkeypatch.setattr(
        sl, "window_days", lambda start, end: ["2026-08-20", "2026-08-21"]
    )
    monkeypatch.setattr(sl, "revision_on", lambda day, path: "abcdef1234")
    monkeypatch.setattr(sl, "ledger_bytes_at", unparsable)
    assert sl.sizes_by_date(None, None) == {}
    err = capsys.readouterr().err
    assert (
        "fail-open: 2026-08-20 (abcdef12) dropped from the series: "
        "SystemExit: no §5 bullets at abcdef12"
    ) in err
