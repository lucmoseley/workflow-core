"""Pins that scan_long_lines reads main transcripts from every seat root and
leaves subagent transcripts out (#375).

The `seat_roots` fixture points `transcript_corpus`'s seats at temp config
dirs, so a second seat can be staged and nothing reads the real corpus.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Breaking it lets the cost of a long physical
line (mantahostels#1431) be counted over one seat's sessions and understated
without a word.
"""

import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scan_long_lines as sll  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def test_main_transcripts_span_both_seat_roots(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    assert sll.tc.main_transcripts() == [
        str(roots[0] / "a.jsonl"),
        str(roots[1] / "b.jsonl"),
    ]


def test_unopenable_file_is_skipped_and_reported(tmp_path, capsys):
    gone = str(tmp_path / "gone.md")
    tally = Counter()
    assert sll.readable_text(gone, tally) is False
    assert tally["unreadable repo files"] == 1
    assert f"fail-open: {gone} skipped: FileNotFoundError" in capsys.readouterr().err


def test_candidate_that_will_not_read_is_skipped_and_reported(
    tmp_path, monkeypatch, stub_bin, capsys
):
    a = tmp_path / "a.md"
    a.write_text("x\n")
    git, _ = stub_bin("git", f"{a}\n")
    monkeypatch.setenv("WFC_GIT", git)
    real_open = open

    def refuse(path, *args, **kw):
        if args[:1] == ("rb",):
            return real_open(path, *args, **kw)
        raise PermissionError("denied")

    # The file turning unreadable between readable_text's open and this read
    # is a race no fixture can time: any real denial fails the first open.
    monkeypatch.setattr(sll, "open", refuse, raising=False)
    tally = Counter()
    assert sll.candidates(10, tally)[0] == []
    assert tally["unreadable repo files"] == 1
    assert f"fail-open: {a} skipped: PermissionError: denied" in (
        capsys.readouterr().err
    )


def test_unshown_revision_prices_at_todays_size_and_is_reported(
    tmp_path, monkeypatch, capsys
):
    # A git that names a revision but will not show it.
    git = tmp_path / "git"
    git.write_text(
        '#!/bin/sh\ncase "$*" in *rev-list*) echo abc ;; *) exit 128 ;; esac\n'
    )
    git.chmod(0o755)
    monkeypatch.setenv("WFC_GIT", str(git))
    tally = Counter()
    cands = [{"path": "a.md", "lineno": 1, "needle": "n"}]
    assert sll.sizes_by_date(cands, "2026-01-01", "2026-01-01", tally) == {}
    assert tally["unshown revisions"] == 1
    err = capsys.readouterr().err
    assert "fail-open: a.md on 2026-01-01 priced at today's size" in err
