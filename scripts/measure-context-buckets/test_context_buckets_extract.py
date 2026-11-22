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
