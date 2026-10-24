"""Pins how the effort-arm scanner assigns a session to an `--effort` arm or
to mixed, which sessions it filters out, and the per-turn cost and break-even
it reports (mantahostels#1108).

Each test builds a synthetic transcript tree and points the extractor at it,
so nothing here reads the real corpus.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Breaking it skews the `low`-versus-`medium`
comparison in https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/effort-low-arm-measurement.md, and with it
mantahostels#1084's call on running checkable work at `low` first.
"""

import json
import os
import sys
from collections import Counter

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "measure-burn"))

import scan_burn as sb  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)
import scan_effort_arms as sea  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def rec(
    rid,
    *,
    effort="medium",
    think=0,
    tools=1,
    out=100,
    cr=1000,
    cw=0,
    ts="2026-08-23T10:00:00.000Z",
    entrypoint="cli",
    skill="implement",
    model="claude-opus-5-20260101",
    session="s1",
):
    return {
        "type": "assistant",
        "requestId": rid,
        "timestamp": ts,
        "effort": effort,
        "entrypoint": entrypoint,
        "attributionSkill": skill,
        "sessionId": session,
        "version": "2.1.241",
        "message": {
            "id": "msg_" + rid,
            "model": model,
            "content": [
                {"type": "tool_use", "id": f"t{i}", "name": "Bash", "input": {}}
                for i in range(tools)
            ],
            "usage": {
                "input_tokens": 0,
                "output_tokens": out,
                "cache_creation_input_tokens": cw,
                "cache_read_input_tokens": cr,
                "output_tokens_details": {"thinking_tokens": think},
            },
        },
    }


def test_arm_is_the_effort_every_parent_turn_ran_at(corpus):
    corpus("sess-low", [rec(f"r{i}", effort="low") for i in range(6)])
    corpus("sess-med", [rec(f"m{i}", effort="medium") for i in range(6)])
    rows = {r["id"]: r for r in sea.sessions(Counter())}
    assert rows["sess-low"]["arm"] == "low"
    assert rows["sess-med"]["arm"] == "medium"


def test_a_session_whose_effort_changed_is_mixed_not_an_arm(corpus):
    # `/effort` mid-session rewrites the global setting, so the turns before and
    # after are not one observation. It must not land in either arm.
    corpus(
        "sess-x",
        [
            rec("a", effort="low"),
            rec("b", effort="low"),
            rec("c", effort="medium"),
            rec("d", effort="medium"),
            rec("e", effort="medium"),
        ],
    )
    (row,) = sea.sessions(Counter())
    assert row["arm"] == "mixed"
    assert row["efforts"] == {"low": 2, "medium": 3}


def test_sdk_py_hook_sessions_are_excluded(corpus):
    # Over half the session count for ~4% of spend; including them makes every
    # per-session median an artefact of hook traffic.
    corpus("hooky", [rec(f"h{i}", entrypoint="sdk-py") for i in range(6)])
    assert sea.sessions(Counter()) == []


def test_streaming_records_are_maxed_not_summed(corpus):
    # A subagent transcript repeats one request with rising output; thinking
    # and tool_use rise with it. Summing would multiply a single turn.
    corpus("parent", [rec(f"p{i}") for i in range(5)])
    corpus(
        "sub",
        [
            rec("shared", think=10, tools=1, out=50),
            rec("shared", think=40, tools=2, out=120),
            rec("shared", think=90, tools=3, out=300),
        ],
        subagent_of="parent",
    )
    (row,) = sea.sessions(Counter())
    # Parent turns only: the subagent's thinking is not the parent's arm.
    assert row["turns"] == 5
    assert row["think"] == 0
    # ...but its spend is folded into cost_all and left out of cost_own.
    assert row["cost_all"] > row["cost_own"]
    assert row["subagents"] == 1
    subs = [r for r in sb.requests(Counter()) if r["sub"]]
    assert [(r["think"], r["tools"], r["out"]) for r in subs] == [(90, 3, 300)]


def test_thinking_and_tool_counts_reach_the_session_row(corpus):
    corpus(
        "sess",
        [rec(f"r{i}", effort="low", think=300, tools=2) for i in range(4)]
        + [rec("last", effort="low", think=0, tools=0)],
    )
    (row,) = sea.sessions(Counter(), min_turns=1)
    assert row["turns"] == 5
    assert row["tools"] == 8  # the final text-only turn calls nothing
    assert row["think"] == 1200


def test_skill_and_model_filters_match_the_work_class(corpus):
    corpus("impl", [rec(f"a{i}", skill="implement") for i in range(6)])
    corpus("way", [rec(f"b{i}", skill="wayfinder") for i in range(6)])
    corpus(
        "son",
        [rec(f"c{i}", skill="implement", model="claude-sonnet-5-x") for i in range(6)],
    )
    assert {r["id"] for r in sea.sessions(Counter(), skill="implement")} == {
        "impl",
        "son",
    }
    assert {
        r["id"] for r in sea.sessions(Counter(), skill="implement", model="opus")
    } == {"impl"}


def test_min_turns_drops_a_session_that_died_at_launch(corpus):
    corpus("stub", [rec("only")])
    corpus("real", [rec(f"r{i}") for i in range(6)])
    assert {r["id"] for r in sea.sessions(Counter(), min_turns=5)} == {"real"}
    assert {r["id"] for r in sea.sessions(Counter(), min_turns=1)} == {"stub", "real"}


def test_window_filters_on_the_requests_earliest_record(corpus):
    corpus("old", [rec(f"o{i}", ts="2026-08-01T10:00:00.000Z") for i in range(6)])
    corpus("new", [rec(f"n{i}", ts="2026-08-23T10:00:00.000Z") for i in range(6)])
    ids = {r["id"] for r in sea.sessions(Counter(), ("2026-08-20", "2026-08-25"))}
    assert ids == {"new"}


def test_band_reports_none_on_an_empty_sample():
    assert sea.band([]) is None
    assert sea.band([None, None]) is None
    b = sea.band([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert (b["n"], b["median"]) == (10, 5.5)


def test_break_even_is_reported_as_absent_when_low_costs_more(corpus, capsys):
    corpus("lo", [rec(f"l{i}", effort="low", out=1000) for i in range(6)])
    corpus("me", [rec(f"m{i}", effort="medium", out=100) for i in range(6)])
    sea.report(sea.sessions(Counter()))
    out = capsys.readouterr().out
    assert "Break-even does not exist" in out


def test_break_even_is_one_minus_the_cost_ratio(corpus, capsys):
    # low at a quarter of medium's cost => break-even at 75%.
    corpus("lo", [rec(f"l{i}", effort="low", out=0, cr=1000) for i in range(6)])
    corpus("me", [rec(f"m{i}", effort="medium", out=0, cr=4000) for i in range(6)])
    sea.report(sea.sessions(Counter()))
    out = capsys.readouterr().out
    assert "L/H on median cost (+subagents) = 0.2" in out
    assert "Break-even failure rate = 1 - L/H = 7" in out


def test_unlabelled_turns_do_not_send_a_plain_session_to_mixed(corpus):
    # A handful of records carry no `effort` field at all. Treating that as a
    # second arm would have excluded 27 of 256 medium sessions from the
    # baseline for nothing (mantahostels#1108, measured 23 Aug 2026).
    turns = [rec(f"r{i}", effort="medium") for i in range(20)]
    for r in turns[:3]:
        del r["effort"]
    corpus("sess", turns)
    (row,) = sea.sessions(Counter())
    assert row["arm"] == "medium"
    assert row["unlabelled"] == 3


def test_two_real_efforts_are_still_mixed(corpus):
    turns = [rec(f"a{i}", effort="low") for i in range(3)] + [
        rec(f"b{i}", effort="medium") for i in range(3)
    ]
    del turns[0]["effort"]
    corpus("sess", turns)
    (row,) = sea.sessions(Counter())
    assert row["arm"] == "mixed"


def test_per_turn_cost_is_a_ratio_per_session_and_includes_subagents(corpus):
    """A median of ratios, not a ratio of medians, and the numerator is the
    session's whole spend.

    Turn count tracks ticket size, so an arm drawn from smaller tickets reads
    cheaper per session whatever effort did. Cost per turn is the metric that
    survives that. The subagent spend has to be in the numerator or the figure
    understates a session that delegated.
    """
    corpus("parent", [rec(f"p{i}", think=60) for i in range(5)])
    corpus("sub", [rec("s1", out=5000, cr=200000)], subagent_of="parent")
    (row,) = sea.sessions(Counter())
    assert row["cost_all"] > row["cost_own"]
    assert row["cost_per_turn"] == pytest.approx(row["cost_all"] / row["turns"])
    assert row["think_per_turn"] == pytest.approx(row["think"] / row["turns"])


@pytest.mark.parametrize("warned", [True, False])
def test_the_report_warns_of_unkeyed_records_and_only_then(
    corpus, unkeyed, capsys, warned
):
    # Each is booked as its own request, inflating turns and cost (#1293).
    records = [rec(f"r{i}") for i in range(6)]
    if warned:
        records[0] = unkeyed(rec("unused"), "u1")
    corpus("sess", records)
    assert sea.main([]) == 0
    out = capsys.readouterr().out
    if warned:
        assert "⚠ 1 record(s) carried neither requestId nor message.id" in out
    else:
        assert "carried neither requestId nor message.id" not in out


def test_the_json_output_carries_every_skip_count(corpus, unkeyed, capsys):
    # A --json consumer sees what the corpus dropped, as the report does (#1297).
    path = corpus(
        "sess", [unkeyed(rec("unused"), "u1")] + [rec(f"r{i}") for i in range(5)]
    )
    with open(path, "a") as fh:
        fh.write('{"type": "assistant", broken\n')
    assert sea.main(["--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["skipped"] == {"unreadable files": 0, "unparsed lines": 1, "unkeyed": 1}
    assert [r["id"] for r in out["sessions"]] == ["sess"]
