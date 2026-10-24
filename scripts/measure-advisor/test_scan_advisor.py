"""Pins what the advisor-cost scanner counts as a fired advisor call -- a
nested `advisor_message` iteration, never `server_tool_use` or a configured
`advisorModel` -- and how it dedups, attributes and prices one (mantahostels#1185).

Each test writes synthetic transcripts under temp seat roots through the
`corpus` fixture, so nothing reads the real corpus, and `scan_burn` is
imported for real because the scanner reuses its walk and MAX-per-request rule.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Breaking it misprices the advisor behind
every Sonnet `/implement` launch, the figure `docs/effort-guide.md` quotes.
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
import scan_advisor as sa  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def rec(
    rid,
    *,
    ts="2026-08-23T10:00:00.000Z",
    session="s1",
    entrypoint="cli",
    advisor_configured=False,
    advisor_iterations=None,
    advisor_content_block=False,
    out=100,
    cr=1000,
    cw=0,
    fi=0,
):
    """A bare assistant record, with an optional advisor round nested in
    `usage.iterations` -- the real shape, not the `usage.server_tool_use`
    field (an unrelated always-present web-tool counter) and not merely
    `advisorModel` (which marks configuration, not a fired call)."""
    use = {
        "input_tokens": fi,
        "output_tokens": out,
        "cache_creation_input_tokens": cw,
        "cache_read_input_tokens": cr,
        "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
    }
    if advisor_iterations is not None:
        use["iterations"] = advisor_iterations
    content = []
    if advisor_content_block:
        # The `server_tool_use` *content block* named "advisor" (distinct from
        # the `usage.server_tool_use` field above) carries no token cost of
        # its own -- the cost lives only in usage.iterations.
        content.append(
            {
                "type": "server_tool_use",
                "id": "srvtoolu_" + rid,
                "name": "advisor",
                "input": {},
            }
        )
    m = {
        "type": "assistant",
        "requestId": rid,
        "timestamp": ts,
        "entrypoint": entrypoint,
        "sessionId": session,
        "message": {
            "id": "msg_" + rid,
            "model": "claude-sonnet-5",
            "content": content,
            "usage": use,
        },
    }
    if advisor_configured:
        m["advisorModel"] = "claude-opus-5"
    return m


def advisor_round(
    *, fi=50000, out=5000, cr=0, cw=0, model="claude-opus-5", cw5m=None, cw1h=None
):
    r = {
        "type": "advisor_message",
        "input_tokens": fi,
        "output_tokens": out,
        "cache_read_input_tokens": cr,
        "cache_creation_input_tokens": cw,
        "model": model,
    }
    if cw5m is not None or cw1h is not None:
        r["cache_creation"] = {
            "ephemeral_5m_input_tokens": cw5m or 0,
            "ephemeral_1h_input_tokens": cw1h or 0,
        }
    return r


def message_round(fi=0, out=0, cr=0, cw=0):
    # The parent turn's own reasoning/tool-call rounds, `type=="message"`.
    return {
        "type": "message",
        "input_tokens": fi,
        "output_tokens": out,
        "cache_read_input_tokens": cr,
        "cache_creation_input_tokens": cw,
    }


def test_server_tool_use_field_alone_is_not_an_advisor_call(corpus):
    corpus("sess", [rec("a")])
    reqs = list(sa.requests_with_advisor(Counter()))
    assert all(r["n"] == 0 for r in reqs)


def test_advisor_configured_without_a_fired_call_is_not_a_call(corpus):
    # mantahostels#1102's silent-off risk: advisorModel is written on every record of a
    # configured session whether or not the advisor ever actually ran.
    corpus(
        "sess", [rec("a", advisor_configured=True), rec("b", advisor_configured=True)]
    )
    reqs = list(sa.requests_with_advisor(Counter()))
    assert all(r["n"] == 0 for r in reqs)
    assert all(r["configured"] for r in reqs)


def test_a_fired_call_is_counted_from_its_nested_iteration(corpus):
    corpus(
        "sess",
        [
            rec(
                "a",
                advisor_configured=True,
                advisor_iterations=[advisor_round(fi=54510, out=5143)],
            )
        ],
    )
    (r,) = list(sa.requests_with_advisor(Counter()))
    assert r["n"] == 1
    assert r["fi"] == 54510
    assert r["out"] == 5143
    assert r["model"] == "claude-opus-5"


def test_only_advisor_message_iterations_are_counted_not_every_iteration(corpus):
    corpus(
        "sess",
        [
            rec(
                "a",
                advisor_iterations=[
                    message_round(fi=200000, out=20000),
                    advisor_round(fi=54510, out=5143),
                    message_round(fi=90000, out=9000),
                ],
            )
        ],
    )
    (r,) = list(sa.requests_with_advisor(Counter()))
    assert r["n"] == 1
    assert r["fi"] == 54510
    assert r["out"] == 5143


def test_advisor_tokens_are_excluded_from_the_parent_requests_own_totals(corpus):
    # The nested iteration is not summed into the parent turn's top-level
    # usage fields: scan_burn.py's own extraction (top-level input/output
    # tokens) and scan_advisor.py's (iteration tokens) read disjoint keys of
    # the same record.
    corpus(
        "sess",
        [
            rec(
                "a",
                out=502,
                cr=96903,
                advisor_iterations=[advisor_round(fi=54510, out=5143)],
            )
        ],
    )
    parent = next(r for r in sb.requests(Counter()) if r["session"] == "s1")
    assert (parent["out"], parent["cr"]) == (502, 96903)
    (advisor,) = [r for r in sa.requests_with_advisor(Counter()) if r["n"] > 0]
    assert (advisor["fi"], advisor["out"]) == (54510, 5143)


def test_a_server_tool_use_content_block_named_advisor_carries_no_cost_alone(corpus):
    corpus("sess", [rec("a", advisor_content_block=True)])
    reqs = list(sa.requests_with_advisor(Counter()))
    assert all(r["n"] == 0 for r in reqs)


def test_streamed_duplicate_records_are_maxed_not_summed(corpus):
    # A subagent transcript repeats one request with rising output; an
    # advisor round inside it must follow the same MAX rule scan_burn uses.
    corpus("parent", [rec("p0")])
    corpus(
        "sub",
        [
            rec("shared", advisor_iterations=[advisor_round(fi=20000, out=2000)]),
            rec("shared", advisor_iterations=[advisor_round(fi=54510, out=5143)]),
        ],
        subagent_of="parent",
    )
    calls = [r for r in sa.requests_with_advisor(Counter()) if r["n"] > 0]
    assert len(calls) == 1
    assert calls[0]["fi"] == 54510
    assert calls[0]["out"] == 5143


def test_subagent_advisor_call_attributes_to_the_owning_session(corpus):
    corpus("parent", [rec("p0")])
    corpus(
        "sub",
        [rec("sub-call", advisor_iterations=[advisor_round()])],
        subagent_of="parent",
    )
    calls = [r for r in sa.requests_with_advisor(Counter()) if r["n"] > 0]
    assert calls[0]["owner"] == "parent"
    assert calls[0]["sub"] is True


def test_window_filters_on_the_requests_earliest_record(corpus):
    corpus(
        "old",
        [
            rec(
                "o0",
                ts="2026-08-01T10:00:00.000Z",
                advisor_iterations=[advisor_round()],
            )
        ],
    )
    corpus(
        "new",
        [
            rec(
                "n0",
                ts="2026-08-24T10:00:00.000Z",
                advisor_iterations=[advisor_round()],
            )
        ],
    )
    calls = [
        r
        for r in sa.requests_with_advisor(Counter(), ("2026-08-23", "9999"))
        if r["n"] > 0
    ]
    assert {r["owner"] for r in calls} == {"new"}


def test_one_transcript_under_two_seat_roots_is_counted_once(seat_roots):
    # scan_burn merges a session found on two seats (#374); counting it per
    # file here would double its advisor spend against scan_burn's total.
    for r in seat_roots(2):
        (r / "s.jsonl").write_text(
            json.dumps(rec("a", advisor_iterations=[advisor_round()])) + "\n"
        )
    assert sum(r["n"] > 0 for r in sa.requests_with_advisor(Counter())) == 1


# --- pricing each cache write at its own TTL (#1209) --------------------------


def write_only(cw, **split):
    return advisor_round(fi=0, out=0, cw=cw, **split)


def test_an_advisor_1_hour_write_is_priced_at_2x_fresh_input(corpus):
    corpus(
        "sess", [rec("a", advisor_iterations=[write_only(1_000_000, cw1h=1_000_000)])]
    )
    (r,) = [r for r in sa.requests_with_advisor(Counter()) if r["n"] > 0]
    assert sb.usd(r) == pytest.approx(30.0)


def test_an_advisor_write_with_no_split_is_priced_at_the_5_minute_rate(corpus):
    corpus("sess", [rec("a", advisor_iterations=[write_only(1_000_000)])])
    (r,) = [r for r in sa.requests_with_advisor(Counter()) if r["n"] > 0]
    assert sb.usd(r) == pytest.approx(18.75)


def test_one_rounds_oversized_split_does_not_absorb_anothers_unsplit_write(corpus):
    corpus(
        "sess",
        [
            rec(
                "a",
                advisor_iterations=[
                    write_only(1_000_000, cw5m=1_000_000, cw1h=1_000_000),
                    write_only(1_000_000),
                ],
            )
        ],
    )
    (r,) = [r for r in sa.requests_with_advisor(Counter()) if r["n"] > 0]
    assert sb.usd(r) == pytest.approx(18.75 * 2 + 30)


def test_the_reported_total_prices_each_ttl_at_its_own_rate(corpus, capsys):
    corpus(
        "sess",
        [
            rec("a", advisor_iterations=[write_only(1_000_000, cw1h=1_000_000)]),
            rec("b", advisor_iterations=[write_only(1_000_000)]),
        ],
    )
    tally = Counter()
    sa.report(sa.requests_with_advisor(tally), "whole corpus", tally)
    assert "cost-equivalent total: $48.75" in capsys.readouterr().out


def test_one_rounds_1_hour_write_counts_once_when_a_later_record_drops_the_split(
    corpus,
):
    corpus(
        "sess",
        [
            rec("a", advisor_iterations=[write_only(1_000_000, cw1h=1_000_000)]),
            rec("a", advisor_iterations=[write_only(1_000_000)]),
        ],
    )
    (r,) = [r for r in sa.requests_with_advisor(Counter()) if r["n"] > 0]
    assert sb.usd(r) == pytest.approx(30.0)
