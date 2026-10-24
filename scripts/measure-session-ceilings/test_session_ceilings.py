"""measure.py's corpus spans every seat root, main and subagent transcripts both
(#379).

The `seat_roots` fixture points `transcript_corpus`'s seats at temp config
dirs, so a second seat can be staged and nothing reads the real corpus; the
module is loaded by file path because `measure-docmap-denials` has a
`measure.py` too.

CI's pytest step runs this file; the script gates
nothing and is run by hand. Breaking it lets the session-ceiling firing rates
(mantahostels#1546, https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-ceiling-firing-rates.md) be drawn
from one seat's sessions and read as the whole machine's.
"""

import importlib.util
from pathlib import Path

# A unique module name: measure-docmap-denials also has a `measure.py`. stats.py
# loads it the same way.
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
