"""Tests for scripts/lib/transcript_corpus.py's seat set, which must match
scripts/lib/arbiter-core.js's `sessionDirs()` (#379), or a scanner silently drops
the sessions of every seat it does not read — and for its shared reader, whose
counts every scanner prints, so a miscount here misreports all of them (#1297) —
and for `jlen`, whose byte count sizes every bucket the scanners report.

Every case points CLAUDE_CONFIG_DIR and the seat variables at a temp home, or
reads a temp transcript, so no case reads this machine's real seats.
"""

import os
import sys
from collections import Counter

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import transcript_corpus as tc

KNOBS = ("WFC_CLAUDE_CONFIG_A", "WFC_CLAUDE_CONFIG_B", "WFC_CLAUDE_CONFIG_C")


@pytest.fixture
def home(tmp_path, monkeypatch):
    for var in KNOBS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    return tmp_path


def test_the_default_set_is_the_three_sibling_plans(home):
    assert tc.seats() == {
        str(home / ".claude"): "plan A",
        str(home / ".claude2"): "plan B",
        str(home / ".claude3"): "plan C",
    }


def test_the_session_config_dir_comes_first_and_is_not_repeated(home, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home / ".claude2"))
    assert list(tc.seats().items()) == [
        (str(home / ".claude2"), "plan B"),
        (str(home / ".claude"), "plan A"),
        (str(home / ".claude3"), "plan C"),
    ]


def test_each_knob_replaces_its_own_default_only(home, monkeypatch):
    elsewhere = home / "other" / "seat"
    monkeypatch.setenv("WFC_CLAUDE_CONFIG_B", str(elsewhere))
    assert tc.seats() == {
        str(home / ".claude"): "plan A",
        str(elsewhere): "plan B",
        str(home / ".claude3"): "plan C",
    }


def test_a_seat_symlinked_to_another_is_read_once(home):
    (home / ".claude").mkdir()
    (home / ".claude3").symlink_to(home / ".claude")
    assert tc.seats() == {
        str(home / ".claude"): "plan A",
        str(home / ".claude2"): "plan B",
    }


def test_a_transcript_is_attributed_to_the_seat_whose_root_holds_it(home, seat_roots):
    roots = seat_roots(2)
    assert tc.seat_of(str(roots[1] / "s.jsonl")) == "plan B"
    assert tc.seat_of(str(roots[0] / "s" / "subagents" / "agent-x.jsonl")) == "plan A"
    assert tc.seat_of(str(home / "elsewhere" / "s.jsonl")) is None


def test_files_reads_one_root_when_named_and_every_seat_otherwise(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    sub = str(roots[1] / "b" / "subagents" / "agent-x.jsonl")
    assert tc.files() == [(str(roots[0] / "a.jsonl"), False), (sub, True)]
    assert tc.files(subagents=False) == [(str(roots[0] / "a.jsonl"), False)]
    assert tc.files(str(roots[1])) == [(sub, True)]


def test_the_reader_yields_objects_and_counts_every_line_it_skips(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text('{"a": 1}\nnot json\n\n[1, 2]\n{"b": 2}\n')
    tally = Counter()
    assert list(tc.records(str(p), tally)) == [{"a": 1}, {"b": 2}]
    # A blank line is no record, so no skip; a JSON array is not an object.
    assert tally == {"unparsed lines": 2}


def test_a_line_holding_no_needle_is_never_parsed_or_counted(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text('{"x": "keep"}\n{"x": "drop"}\nbroken keep\n{"y": "also"}\n')
    tally = Counter()
    assert list(tc.records(str(p), tally, needle=("keep", "also"))) == [
        {"x": "keep"},
        {"y": "also"},
    ]
    assert tally == {"unparsed lines": 1}


def test_a_file_that_will_not_open_is_counted_not_raised(tmp_path):
    tally = Counter()
    assert list(tc.records(str(tmp_path / "gone.jsonl"), tally)) == []
    assert tally == {"unreadable files": 1}


def test_the_counts_line_prints_zeros_and_named_keys_in_order():
    tally = Counter({"unparsed lines": 3, "undated": 1})
    assert tc.counts_line(tally) == "(unreadable files: 0, unparsed lines: 3)"
    assert (
        tc.counts_line(tally, "undated", tc.UNREADABLE)
        == "(undated: 1, unreadable files: 0)"
    )


def test_jlen_measures_utf8_bytes_and_zero_for_what_will_not_dump():
    assert tc.jlen(None) == 0
    assert tc.jlen("é") == 2
    assert tc.jlen({"a": "é"}) == len('{"a": "é"}'.encode())
    assert tc.jlen({1, 2}) == 0
