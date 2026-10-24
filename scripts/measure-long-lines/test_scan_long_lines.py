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
