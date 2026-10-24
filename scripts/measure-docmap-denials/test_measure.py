"""Pins the episode cut mantahostels#2430 added to measure.py's per-class breakdown.

An episode is one (session, class) pair, so one session's serial retries must
inflate its event share without moving its episode share. Route and
escalation are carried per class too so a class's route mix doesn't need a
separate pass over the events.

`class_breakdown` is fed hand-built event dicts in-process, so each case
stages exactly the retries or classes it is about, with no transcript to parse.

CI's pytest step runs this file; the script gates
nothing and is run by hand. Breaking the cut lets one session hammering a held
file pass for many sessions blocked, inflating the doc-map claim-denial rate
mantahostels#1761 measures.
"""

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from measure import class_breakdown, subject_class


def ev(sess, subj, route="hook", escalation=False):
    return {"sess": sess, "subj": subj, "route": route, "escalation": escalation}


def test_one_sessions_serial_retries_are_one_episode():
    rs = [
        ev("s1", "docs/doc-map.md"),
        ev("s1", "docs/doc-map.md"),
        ev("s1", "docs/doc-map.md"),
    ]
    by_events, by_episodes, by_route, by_escalation = class_breakdown(rs)
    assert by_events["whole-file"] == 3
    assert by_episodes["whole-file"] == 1


def test_distinct_sessions_on_the_same_class_are_distinct_episodes():
    rs = [ev("s1", "docs/doc-map.md"), ev("s2", "docs/doc-map.md")]
    by_events, by_episodes, by_route, by_escalation = class_breakdown(rs)
    assert by_events["whole-file"] == 2
    assert by_episodes["whole-file"] == 2


def test_classes_are_kept_apart_by_subject_not_just_session():
    rs = [
        ev("s1", "docs/doc-map.md"),
        ev("s1", "docs/doc-map.md#B7"),
        ev("s1", "docs/doc-map.md#capture-and-placement-shed-l"),
    ]
    by_events, by_episodes, by_route, by_escalation = class_breakdown(rs)
    assert by_events == {
        "whole-file": 1,
        "B-entry": 1,
        subject_class("docs/doc-map.md#capture-and-placement-shed-l"): 1,
    }
    assert sum(by_episodes.values()) == 3
    assert all(v == 1 for v in by_episodes.values())


def test_route_and_escalation_are_tallied_per_class():
    rs = [
        ev("s1", "docs/doc-map.md", route="cli", escalation=False),
        ev("s2", "docs/doc-map.md", route="hook", escalation=True),
        ev("s1", "docs/doc-map.md#B7", route="hook", escalation=False),
    ]
    by_events, by_episodes, by_route, by_escalation = class_breakdown(rs)
    assert by_route["whole-file"] == {"cli": 1, "hook": 1}
    assert by_escalation["whole-file"] == 1
    assert by_route["B-entry"] == {"hook": 1}
    assert by_escalation["B-entry"] == 0


def test_denials_are_read_from_every_seat_root(seat_roots):
    import json

    import measure

    roots = seat_roots(2)
    for i, r in enumerate(roots):
        rec = {
            "timestamp": f"2026-09-0{i + 1}T10:00:00Z",
            "sessionId": f"s{i}",
            "toolUseResult": "session-arbiter: docs/doc-map.md is held by session x",
        }
        (r / f"s{i}.jsonl").write_text(json.dumps(rec, separators=(",", ":")) + "\n")
    events, spans = measure.scan(measure.main_files(), None, Counter())
    assert [e["sess"] for e in events] == ["s0", "s1"]
    assert len(spans) == 2
