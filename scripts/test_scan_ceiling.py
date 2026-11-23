import datetime as dt
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "measure-ceiling" / "scan_ceiling.py"
_spec = importlib.util.spec_from_file_location("scan_ceiling", SCRIPT)
sc = importlib.util.module_from_spec(_spec)
sys.modules["scan_ceiling"] = sc
_spec.loader.exec_module(sc)

pytestmark = pytest.mark.usefixtures("isolated_home")


def rec(text, ts="2026-08-13T03:01:39.291Z", error="rate_limit", **kw):
    r = {
        "type": "assistant",
        "timestamp": ts,
        "requestId": kw.pop("rid", "req_1"),
        "error": error,
        "isApiErrorMessage": True,
        "apiErrorStatus": 429,
        "sessionId": kw.pop("session", "s1"),
        "sessionKind": "bg",
        "entrypoint": "cli",
        "message": {
            "id": "m1",
            "model": "<synthetic>",
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    }
    r.update(kw)
    return r


def classify(r):
    return sc.classify(r, Counter())


def utc(s):
    return dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc)


def test_session_window_exhaustion_is_a_ceiling_event():
    ev = classify(rec("You've hit your session limit · resets 1pm (Asia/Singapore)"))
    assert ev is not None
    assert ev["kind"] == "window-exhausted"


def test_progress_saved_suffix_does_not_change_the_kind():
    ev = classify(
        rec(
            "You've hit your session limit · resets 6:30pm "
            "(Asia/Singapore) · progress saved"
        )
    )
    assert ev["kind"] == "window-exhausted"
    assert ev["reset"] is not None


def test_request_rejected_429_is_not_an_exhausted_allowance():
    ev = classify(
        rec(
            "API Error: Request rejected (429) · This request would "
            "exceed your account's rate limit. Please try again later.",
            error="rate_limit",
        )
    )
    assert ev["kind"] == "request-rejected"
    assert ev["reset"] is None


def test_a_server_error_is_not_a_ceiling_event():
    assert classify(rec("API Error: 529 Overloaded.", error="server_error")) is None


def test_an_ordinary_assistant_turn_is_not_a_ceiling_event():
    assert (
        classify(
            {
                "type": "assistant",
                "timestamp": "2026-08-13T03:00:00Z",
                "message": {
                    "content": [{"type": "text", "text": "hello"}],
                    "usage": {"output_tokens": 5},
                },
            }
        )
        is None
    )


def test_a_weekly_limit_message_is_recognised_as_its_own_kind():
    ev = classify(
        rec(
            "Claude usage limit reached. Your weekly limit will "
            "reset at 3pm (Asia/Singapore)."
        )
    )
    assert ev["kind"] == "weekly-exhausted"


def test_reset_time_resolves_to_the_next_occurrence_of_that_local_time():
    at = utc("2026-08-13T03:01:39")
    assert sc.reset_at("resets 1pm (Asia/Singapore)", at) == utc("2026-08-13T05:00:00")


def test_a_reset_time_with_minutes_resolves_to_that_minute():
    at = utc("2026-08-06T08:18:26")
    assert sc.reset_at("resets 6:40pm (Asia/Singapore)", at) == utc(
        "2026-08-06T10:40:00"
    )


def test_a_reset_past_local_midnight_rolls_to_the_next_day():
    at = utc("2026-08-07T13:57:08")
    assert sc.reset_at("resets 12:20am (Asia/Singapore)", at) == utc(
        "2026-08-07T16:20:00"
    )


def test_noon_and_midnight_are_not_confused():
    at = utc("2026-08-07T02:00:00")
    assert sc.reset_at("resets 12pm (Asia/Singapore)", at) == utc("2026-08-07T04:00:00")


def test_a_message_with_no_reset_time_yields_none():
    assert sc.reset_at("Please try again later.", utc("2026-08-07T02:00:00")) is None


def test_events_sharing_a_reset_instant_are_one_episode_across_sessions():
    evs = [
        classify(
            rec(
                "You've hit your session limit · resets 1pm (Asia/Singapore)",
                ts=t,
                session=s,
                rid=f"r{i}",
            )
        )
        for i, (t, s) in enumerate(
            [
                ("2026-08-13T03:01:39Z", "s1"),
                ("2026-08-13T03:02:33Z", "s2"),
                ("2026-08-13T03:06:12Z", "s1"),
            ]
        )
    ]
    eps = sc.episodes(evs)
    assert len(eps) == 1
    assert eps[0]["start"] == utc("2026-08-13T03:01:39")
    assert eps[0]["end"] == utc("2026-08-13T05:00:00")
    assert eps[0]["sessions"] == {"s1", "s2"}
    assert eps[0]["events"] == 3


def test_an_episode_records_each_session_s_last_retry():
    evs = [
        classify(
            rec(
                "You've hit your session limit · resets 1pm (Asia/Singapore)",
                ts=t,
                session=s,
                rid=f"r{i}",
            )
        )
        for i, (t, s) in enumerate(
            [
                ("2026-08-13T03:01:39Z", "s1"),
                ("2026-08-13T03:02:33Z", "s2"),
                ("2026-08-13T03:06:12Z", "s1"),
            ]
        )
    ]
    ep = sc.episodes(evs)[0]
    assert ep["last"] == {
        "s1": utc("2026-08-13T03:06:12"),
        "s2": utc("2026-08-13T03:02:33"),
    }


def test_two_different_windows_are_two_episodes():
    evs = [
        classify(
            rec(
                "You've hit your session limit · resets 1pm (Asia/Singapore)",
                ts="2026-08-13T03:01:39Z",
                rid="r1",
            )
        ),
        classify(
            rec(
                "You've hit your session limit · resets 6pm (Asia/Singapore)",
                ts="2026-08-13T08:21:31Z",
                rid="r2",
            )
        ),
    ]
    assert len(sc.episodes(evs)) == 2


def test_an_event_with_no_reset_time_starts_no_episode():
    evs = [
        classify(
            rec(
                "API Error: Request rejected (429) · This request would "
                "exceed your account's rate limit. Please try again later."
            )
        )
    ]
    assert sc.episodes(evs) == []


def test_duplicate_records_of_one_request_are_counted_once():
    dup = rec(
        "You've hit your session limit · resets 1pm (Asia/Singapore)", rid="req_x"
    )
    evs = sc.dedupe([classify(dup), classify(dup)])
    assert len(evs) == 1


def test_overlapping_episodes_are_not_double_counted():
    a = (utc("2026-08-13T03:00:00"), utc("2026-08-13T05:00:00"))
    b = (utc("2026-08-13T04:00:00"), utc("2026-08-13T06:00:00"))
    assert sc.union_minutes([a, b]) == 180


def test_disjoint_episodes_add_up():
    a = (utc("2026-08-13T03:00:00"), utc("2026-08-13T04:00:00"))
    b = (utc("2026-08-13T08:00:00"), utc("2026-08-13T09:30:00"))
    assert sc.union_minutes([a, b]) == 150


def test_union_splits_an_interval_across_the_day_boundary():
    per_day = sc.blocked_by_day(
        [(utc("2026-08-13T14:00:00"), utc("2026-08-13T17:30:00"))]
    )
    assert per_day == {"2026-08-13": 120.0, "2026-08-14": 90.0}


def test_events_are_read_out_of_a_transcript_file(tmp_path):
    p = tmp_path / "sess.jsonl"
    p.write_text(
        "\n".join(
            [
                json.dumps(
                    {"type": "user", "message": {"role": "user", "content": "go"}}
                ),
                json.dumps(
                    rec("You've hit your session limit · resets 1pm (Asia/Singapore)")
                ),
                '{"error": "rate_limit", broken',
            ]
        )
    )
    tally = Counter()
    evs = list(sc.scan_file(str(p), tally))
    assert len(evs) == 1
    assert evs[0]["session"] == "s1"
    assert tally["unparsed lines"] == 1


def test_blocked_time_outside_the_working_day_is_not_counted_as_lost():
    spans = {"2026-08-13": (utc("2026-08-13T01:00:00"), utc("2026-08-13T09:00:00"))}
    overnight = [(utc("2026-08-12T19:00:00"), utc("2026-08-13T00:30:00"))]
    assert sc.overlap_minutes(overnight, spans) == 0
    straddling = [(utc("2026-08-13T00:00:00"), utc("2026-08-13T02:00:00"))]
    assert sc.overlap_minutes(straddling, spans) == 60


def test_active_spans_are_the_days_first_and_last_turn():
    turns = {
        "s1": [
            (utc("2026-08-13T01:00:00"), "claude-opus-5"),
            (utc("2026-08-13T05:00:00"), "claude-opus-5"),
        ],
        "s2": [(utc("2026-08-13T03:00:00"), "claude-opus-5")],
    }
    spans = sc.active_spans(turns)
    assert spans["2026-08-13"] == (
        utc("2026-08-13T01:00:00"),
        utc("2026-08-13T05:00:00"),
    )


def test_the_five_hour_burst_is_summed_over_the_window_ending_at_the_event():
    series = [
        (utc("2026-08-13T00:00:00"), 100.0),
        (utc("2026-08-13T02:00:00"), 10.0),
        (utc("2026-08-13T06:30:00"), 1.0),
    ]
    assert sc.window_cost(series, utc("2026-08-13T06:00:00"), hours=5) == 10.0


def test_the_daily_peak_burst_is_the_worst_five_hours_of_that_day():
    series = [
        (utc("2026-08-13T01:00:00"), 5.0),
        (utc("2026-08-13T02:00:00"), 7.0),
        (utc("2026-08-13T14:00:00"), 3.0),
    ]
    peaks = sc.peak_burst_by_day(series, hours=5)
    assert peaks["2026-08-13"] == 12.0


def test_transcripts_span_both_seat_roots(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    assert sorted(sc.transcripts()) == [
        str(roots[0] / "a.jsonl"),
        str(roots[1] / "b" / "subagents" / "agent-x.jsonl"),
    ]


def test_a_session_is_owned_by_the_seat_holding_it_unless_it_is_on_two(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "solo.jsonl").write_text("")
    (roots[0] / "both.jsonl").write_text("")
    (roots[1] / "both.jsonl").write_text("")
    owner = sc.account_owner()
    assert sc.owner_of("solo", owner) == "plan A"
    assert sc.owner_of("both", owner) is None


def write_rec(rid, cw, split=None, top=None):
    use = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 1,
        "cache_creation_input_tokens": cw,
        **(top or {}),
    }
    if split:
        use["cache_creation"] = split
    return {
        "type": "assistant",
        "timestamp": "2026-08-13T03:00:00.000Z",
        "requestId": rid,
        "sessionId": "s1",
        "message": {"model": "claude-opus-5", "usage": use},
    }


def test_the_daily_cost_prices_each_cache_write_at_its_ttl_rate(seat_roots):
    (root,) = seat_roots()
    (root / "s1.jsonl").write_text(
        "".join(
            json.dumps(r) + "\n"
            for r in [
                write_rec(
                    "a",
                    1_000_000,
                    split={
                        "ephemeral_5m_input_tokens": 0,
                        "ephemeral_1h_input_tokens": 1_000_000,
                    },
                ),
                write_rec("b", 1_000_000),
                write_rec(
                    "c",
                    2_000_000,
                    top={"ephemeral_1h_input_tokens": 0},
                    split={
                        "ephemeral_5m_input_tokens": 0,
                        "ephemeral_1h_input_tokens": 2_000_000,
                    },
                ),
            ]
        )
    )
    reads = 3 * 1.50 / 1e6
    assert sc.activity(Counter()).cost_by_day["2026-08-13"] == pytest.approx(
        30 + 18.75 * 3 + reads
    )


def test_an_overflow_session_costs_the_plan_nothing_but_still_counts_as_working(
    seat_roots, mark_overflow
):
    (root,) = seat_roots()
    overflow = "aaaaaaaa-0000-4000-8000-000000000000"
    mark_overflow(overflow)
    (root / "s1.jsonl").write_text(json.dumps(write_rec("a", 1_000_000)))
    (root / f"{overflow}.jsonl").write_text(
        json.dumps({**write_rec("b", 2_000_000), "sessionId": overflow})
    )
    act = sc.activity(Counter())
    assert act.cost_by_day["2026-08-13"] == pytest.approx(18.75 + 1.50 / 1e6)
    assert len(act.series) == 1
    assert overflow in act.turns


@pytest.mark.parametrize("value", ["not-a-date", None])
def test_an_unparsable_timestamp_reads_as_none_and_is_counted(value, capsys):
    tally = Counter()
    assert sc.parse_ts(value, tally, "undated turns") is None
    assert tally == {"undated turns": 1}
    assert capsys.readouterr().err == ""
