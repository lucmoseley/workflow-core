import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "session_ceilings_measure", Path(__file__).parent / "measure.py"
)
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)


def test_the_corpus_spans_every_seat_root(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    assert m.corpus() == (
        [str(roots[0] / "a.jsonl"), str(roots[1] / "b.jsonl")],
        [str(roots[1] / "b" / "subagents" / "agent-x.jsonl")],
    )
