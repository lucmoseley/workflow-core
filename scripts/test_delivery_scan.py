"""Tests for scripts/lib/delivery_scan.py, the reader, tool-result walk and Bash
read classifier both delivery-cost scanners share (#1322, #1351, #947): a skip
miscounted, a result dropped or a read misfiled here misreports both. In
process; the reader's cases run over transcripts written to conftest's temp
seat roots rather than the real corpus, so a count is exact, and the unreadable
case is #1274's counted-not-fatal rule."""

import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import delivery_scan as ds
import transcript_corpus as tc


def test_only_transcripts_find_answers_are_parsed_and_skips_are_counted(seat_roots):
    root = seat_roots()[0]
    (root / "a.jsonl").write_text('{"type":"user","x":"needle"}\nnot json\n')
    (root / "b.jsonl").write_text('{"type":"user"}\n')
    tally = Counter()
    got = list(ds.parent_transcripts(tally, lambda raw: "needle" in raw))
    assert [(os.path.basename(fp), hit, recs) for fp, hit, recs in got] == [
        ("a.jsonl", True, [{"type": "user", "x": "needle"}])
    ]
    assert tally == {tc.UNPARSED: 1}


def test_an_unreadable_transcript_is_counted_not_fatal(seat_roots):
    root = seat_roots()[0]
    (root / "a.jsonl").mkdir()
    tally = Counter()
    assert list(ds.parent_transcripts(tally, bool)) == []
    assert tally == {tc.UNREADABLE: 1}


def test_tool_results_yield_in_window_results_with_their_call():
    def rec(ts, *content):
        return {"timestamp": ts, "message": {"content": list(content)}}

    recs = [
        rec(
            "2026-09-01T00:00:00Z",
            {
                "type": "tool_use",
                "id": "b",
                "name": "Bash",
                "input": {"command": "grep  -n\n x"},
            },
            {
                "type": "tool_use",
                "id": "r",
                "name": "Read",
                "input": {"file_path": "f"},
            },
        ),
        rec(
            "2026-08-31T23:59:59Z",
            {"type": "tool_result", "tool_use_id": "b", "content": "early"},
        ),
        rec(
            "2026-09-01T00:00:01Z",
            {"type": "tool_result", "tool_use_id": "b", "content": "hit"},
        ),
        rec(
            "2026-09-02T00:00:00Z",
            {
                "type": "tool_result",
                "tool_use_id": "r",
                "content": [{"text": "a"}, {"text": "b"}],
            },
            {"type": "tool_result", "tool_use_id": "r", "content": ""},
            {"type": "tool_result", "tool_use_id": "gone", "content": "orphan"},
        ),
        rec(
            "2026-09-03T00:00:00Z",
            {"type": "tool_result", "tool_use_id": "b", "content": "late"},
        ),
    ]
    assert list(ds.tool_results(recs, "2026-09-01", "2026-09-02")) == [
        (
            2,
            "2026-09-01T00:00:01Z",
            "hit",
            "Bash",
            {"command": "grep  -n\n x"},
            "grep -n x",
        ),
        (3, "2026-09-02T00:00:00Z", "a\nb", "Read", {"file_path": "f"}, ""),
        (3, "2026-09-02T00:00:00Z", "orphan", "?", {}, ""),
    ]


def test_landed_bytes_count_only_the_kept_lines_in_utf8():
    assert ds.landed_bytes("needle é\nother\nneedle", lambda s: "needle" in s) == 9 + 6


def test_bash_read_kind_takes_the_first_matching_read_form():
    assert ds.bash_read_kind("git show HEAD | grep x") == "git diff/show"
    assert ds.bash_read_kind("grep -n x f | head") == "Bash grep"
    assert ds.bash_read_kind("sed -n 1,9p f") == "Bash range/cat"
    assert ds.bash_read_kind("wc -l f") == "Bash other"


def test_intent_text_lowercases_command_and_unescaped_input():
    res = ds.ToolResult(0, "", "", "Bash", {"command": "Grep É"}, "Grep É")
    assert ds.intent_text(res) == 'grep é{"command": "grep é"}'


def test_turns_after_count_one_request_once():
    recs = [
        {"type": "user"},
        {"type": "assistant", "message": {"id": "m1"}},
        {"type": "assistant", "message": {"id": "m1"}},
        {"type": "assistant", "message": {"id": "m2"}},
    ]
    assert ds.suffix_distinct_turns(recs) == [2, 2, 2, 1, 0]


def test_growth_is_the_least_squares_slope_per_day():
    assert (
        ds.growth_per_day({"2026-08-21": 300, "2026-08-20": 100, "2026-08-22": 500})
        == 200.0
    )
    assert ds.growth_per_day({"2026-08-20": 100}) == 0.0
