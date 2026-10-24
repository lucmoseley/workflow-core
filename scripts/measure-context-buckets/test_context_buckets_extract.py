"""Pins that the context-bucket extractor lists parent and subagent
transcripts from every seat root, not the first alone (#375).

The `seat_roots` fixture points `transcript_corpus`'s seats at temp config
dirs, so a second seat can be staged and nothing reads the real corpus.

CI's pytest step runs this file; the extractor
gates nothing and is run by hand. Breaking it lets mantahostels#1081's
cache-read bucket breakdown silently read a fraction of the corpus and report
it as the whole.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import extract  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def test_both_seat_roots_are_listed(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    parents, subs = extract.transcript_paths()
    assert [os.path.basename(p) for p in parents] == ["a.jsonl", "b.jsonl"]
    assert [os.path.basename(p) for p in subs] == ["agent-x.jsonl"]
