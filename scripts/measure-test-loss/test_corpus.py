"""Pins that corpus.transcripts reports a root or file it cannot read (#5487)."""

import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import corpus  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def test_a_root_that_will_not_list_is_skipped_and_reported(tmp_path, capsys):
    gone = str(tmp_path / "gone")
    tally = Counter()
    assert list(corpus.transcripts([gone], 0, tally)) == []
    assert tally[corpus.tc.UNREADABLE] == 1
    assert f"fail-open: {gone} skipped: FileNotFoundError" in capsys.readouterr().err


def test_a_file_that_will_not_stat_is_skipped_and_reported(
    tmp_path, monkeypatch, capsys
):
    proj = tmp_path / "-home-x-workflow-core"
    proj.mkdir()
    (proj / "s1.jsonl").write_text("")

    def refuse(path):
        raise FileNotFoundError(path)

    monkeypatch.setattr(corpus.os.path, "getmtime", refuse)
    tally = Counter()
    assert list(corpus.transcripts([str(tmp_path)], 0, tally)) == []
    assert tally[corpus.tc.UNREADABLE] == 1
    err = capsys.readouterr().err
    assert f"fail-open: {proj / 's1.jsonl'} skipped: FileNotFoundError" in err
