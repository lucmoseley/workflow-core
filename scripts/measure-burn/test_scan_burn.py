import json
import os
import sys
from collections import Counter
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scan_burn as sb  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)

pytestmark = pytest.mark.usefixtures("isolated_home")


def rec(
    rid,
    *,
    out=100,
    cr=1000,
    cw=0,
    fi=2,
    ts="2026-08-23T10:00:00.000Z",
    entrypoint="cli",
    skill="implement",
    model="claude-opus-5",
    session="s1",
    cw5m=None,
    cw1h=None,
):
    r = {
        "type": "assistant",
        "requestId": rid,
        "timestamp": ts,
        "entrypoint": entrypoint,
        "attributionSkill": skill,
        "sessionId": session,
        "message": {
            "id": "msg_" + rid,
            "model": model,
            "content": [{"type": "text", "text": "x"}],
            "usage": {
                "input_tokens": fi,
                "output_tokens": out,
                "cache_creation_input_tokens": cw,
                "cache_read_input_tokens": cr,
            },
        },
    }
    if cw5m is not None or cw1h is not None:
        r["message"]["usage"]["cache_creation"] = {
            "ephemeral_5m_input_tokens": cw5m or 0,
            "ephemeral_1h_input_tokens": cw1h or 0,
        }
    return r


def run_audit(capsys):
    reqs = list(sb.requests(Counter(), keep_records=True))
    ok = sb.audit(reqs)
    return ok, capsys.readouterr().out


def run_report(capsys):
    tally = Counter()
    sb.report(list(sb.requests(tally)), tally)
    return capsys.readouterr().out


def test_max_across_a_streamed_request_is_one_billable_unit(corpus):
    corpus(
        "a1",
        [
            rec("r1", out=3, cr=50_000, cw=1_000),
            rec("r1", out=3, cr=50_000, cw=1_000),
            rec("r1", out=288, cr=50_000, cw=1_000),
        ],
        subagent_of="parent",
    )
    (r,) = sb.requests(Counter())
    assert (r["out"], r["cr"], r["cw"]) == (288, 50_000, 1_000)


def test_max_takes_the_final_record_of_a_cumulative_request(corpus):
    corpus(
        "a2",
        [
            rec("r2", out=3, cr=52_521, cw=1_123, fi=2),
            rec("r2", out=372, cr=106_165, cw=2_460, fi=4),
        ],
        subagent_of="parent",
    )
    (r,) = sb.requests(Counter())
    assert (r["out"], r["cr"], r["cw"], r["fi"]) == (372, 106_165, 2_460, 4)


def test_audit_passes_a_cumulative_subagent_request(corpus, capsys):
    corpus(
        "a3",
        [
            rec("r3", out=3, cr=52_521, cw=1_123, fi=2),
            rec("r3", out=372, cr=106_165, cw=2_460, fi=4),
        ],
        subagent_of="parent",
    )
    ok, out = run_audit(capsys)
    assert ok, out
    assert "cumulative" in out
    assert "x1.000 against the correct rule" in out


def test_audit_fails_a_request_whose_usage_falls_saying_max_is_no_longer_the_rule(
    corpus, capsys
):
    corpus(
        "a4",
        [
            rec("r4", out=300, cr=90_000, cw=2_000),
            rec("r4", out=300, cr=40_000, cw=2_000),
        ],
        subagent_of="parent",
    )
    ok, out = run_audit(capsys)
    assert not ok
    assert "MAX is no longer the right rule" in out


def test_audit_fails_when_message_id_and_request_id_stop_being_1to1(corpus):
    a, b = rec("r5"), rec("r5")
    b["message"]["id"] = "msg_other"
    corpus("a5", [a, b])
    reqs = list(sb.requests(Counter(), keep_records=True))
    assert sb.audit(reqs) is False


def test_audit_reports_the_two_disagreement_shapes_separately(corpus, capsys):
    corpus(
        "a6",
        [
            rec("r6", out=3, cr=50_000, cw=1_000),
            rec("r6", out=288, cr=50_000, cw=1_000),
        ],
        subagent_of="parent",
    )
    corpus(
        "a7",
        [
            rec("r7", out=3, cr=52_521, cw=1_123, fi=2),
            rec("r7", out=372, cr=106_165, cw=2_460, fi=4),
        ],
        subagent_of="parent",
    )
    ok, out = run_audit(capsys)
    assert ok, out
    line = next(ln for ln in out.splitlines() if ln.strip().startswith("subagent"))
    assert "1 stream-shaped" in line
    assert "1 cumulative-shaped" in line


def test_audit_over_a_window_holding_no_request_says_nothing_matched_and_does_not_fail(
    corpus, capsys
):
    corpus("a6b", [rec("r6b")])
    out = run_main(capsys, "--audit")
    assert "Nothing to compare: no billable request matched." in out
    assert "Nothing to report: no billable request matched." in out
    assert "AUDIT FAILED" not in out


def placeholder(rid=None, *, mid=True):
    r = rec(rid or "unused", out=0, cr=0, cw=0, fi=0, model="<synthetic>")
    r["message"]["id"] = "3f1c9a2e-7b4d-4e0a-9c55-1d2e3f4a5b6c"
    r["isApiErrorMessage"] = True
    if rid is None:
        del r["requestId"]
    if not mid:
        del r["message"]["id"]
    return r


def test_a_placeholder_sharing_a_real_requests_id_leaves_it_untouched(corpus, capsys):
    real = rec("r8", out=16, cr=40_000, cw=1_000, fi=3)
    corpus("a8", [real, placeholder("r8")], subagent_of="parent")
    (r,) = sb.requests(Counter(), keep_records=True)
    assert (r["out"], r["cr"], r["cw"], r["fi"], r["records"]) == (
        16,
        40_000,
        1_000,
        3,
        1,
    )
    assert r["model"] == "claude-opus-5"
    ok, out = run_audit(capsys)
    assert ok, out


@pytest.mark.parametrize("rid,mid", [("r9", True), (None, True), (None, False)])
def test_a_lone_placeholder_is_no_request_and_not_unkeyed(corpus, rid, mid):
    tally = Counter()
    corpus("a9", [placeholder(rid, mid=mid)])
    assert list(sb.requests(tally)) == []
    assert tally["unkeyed"] == 0


def test_a_record_with_neither_id_is_counted_as_unkeyed(corpus, unkeyed):
    corpus("a10", [unkeyed(rec("u"), "u1"), unkeyed(rec("u"), "u2"), rec("r10")])
    tally = Counter()
    assert len(list(sb.requests(tally))) == 3
    assert tally["unkeyed"] == 2


def test_two_scans_in_one_process_do_not_share_their_counts(corpus, unkeyed, capsys):
    path = corpus("a11", [unkeyed(rec("u"), "u1"), rec("r11")])
    with open(path, "a") as fh:
        fh.write('{"type": "assistant", broken\n')
    for _ in range(2):
        out = run_main(capsys, "--all")
        assert "unparsed lines: 1)" in out
        assert "⚠ 1 record(s) carried neither requestId" in out


def test_fan_out_reports_the_class_split_within_subagent_spend(corpus, capsys):
    corpus("main", [rec("m1", out=1_000, cr=100_000, cw=5_000)])
    corpus("s1", [rec("s1a", out=200, cr=40_000, cw=50_000)], subagent_of="main")
    out = run_report(capsys)
    line = next(ln for ln in out.splitlines() if "subagent spend by class" in ln)
    assert "cache write 92.6%" in line
    assert "cache read 5.9%" in line


def test_class_split_shares_sum_to_100(corpus, capsys):
    corpus("main", [rec("m1", out=1_000, cr=100_000, cw=5_000)])
    corpus("s1", [rec("s1a", out=900, cr=70_000, cw=3_000)], subagent_of="main")
    line = next(
        ln for ln in run_report(capsys).splitlines() if "subagent spend by class" in ln
    )
    shares = [float(t[:-1]) for t in line.split() if t.endswith("%")]
    assert len(shares) == 4
    assert abs(sum(shares) - 100.0) < 0.15


def only_writes(rid, **kw):
    return rec(rid, out=0, cr=0, fi=0, **kw)


def test_a_1_hour_write_is_priced_at_2x_fresh_input(corpus):
    corpus("m", [only_writes("r", cw=1_000_000, cw1h=1_000_000)])
    (r,) = sb.requests(Counter())
    assert sb.usd(r) == pytest.approx(30)


def test_a_write_with_no_split_is_priced_at_the_5_minute_rate(corpus):
    corpus("m", [only_writes("r", cw=1_000_000)])
    (r,) = sb.requests(Counter())
    assert sb.usd(r) == pytest.approx(18.75)


def test_write_tokens_the_split_does_not_cover_price_at_the_5_minute_rate(corpus):
    corpus("m", [only_writes("r", cw=3_000_000, cw5m=500_000, cw1h=2_000_000)])
    (r,) = sb.requests(Counter())
    assert sb.usd(r) == pytest.approx(18.75 + 60)


def test_one_requests_1_hour_write_counts_once_when_a_later_record_drops_the_split(
    corpus,
):
    corpus(
        "m",
        [
            only_writes("r", cw=1_000_000, cw1h=1_000_000),
            only_writes("r", cw=1_000_000),
        ],
    )
    (r,) = sb.requests(Counter())
    assert sb.usd(r) == pytest.approx(30)


def test_pricing_the_total_equals_summing_each_requests_price(corpus):
    corpus(
        "m",
        [only_writes("a", cw=100, cw5m=100, cw1h=100), only_writes("b", cw=1_000_000)],
    )
    reqs = list(sb.requests(Counter()))
    assert sb.usd(sb.totals(reqs)) == pytest.approx(sum(sb.usd(r) for r in reqs))


def test_the_class_split_prices_a_subagents_1_hour_write_at_its_own_rate(
    corpus, capsys
):
    corpus("main", [rec("m1")])
    corpus(
        "s1",
        [rec("s1a", out=0, cr=0, fi=1_000_000, cw=1_000_000, cw1h=1_000_000)],
        subagent_of="main",
    )
    line = next(
        ln for ln in run_report(capsys).splitlines() if "subagent spend by class" in ln
    )
    assert "cache write 66.7%" in line
    assert "fresh input 33.3%" in line


def test_the_corpus_shares_price_a_1_hour_write_at_its_own_rate(corpus, capsys):
    corpus("m", [rec("r", out=0, cr=0, fi=1_000_000, cw=1_000_000, cw1h=1_000_000)])
    line = next(
        ln
        for ln in run_report(capsys).splitlines()
        if ln.strip().startswith("Cache write") and "of cost" in ln
    )
    assert "66.7% of cost" in line


def test_a_top_level_split_field_wins_over_the_nested_one(corpus):
    r = only_writes("r", cw=1_000_000, cw1h=1_000_000)
    r["message"]["usage"]["ephemeral_1h_input_tokens"] = 0
    corpus("m", [r])
    (req,) = sb.requests(Counter())
    assert sb.usd(req) == pytest.approx(18.75)


def run_main(capsys, *argv):
    assert sb.main(list(argv)) == 0
    return capsys.readouterr().out


def refused(capsys, *argv):
    with pytest.raises(SystemExit) as e:
        sb.main(list(argv))
    assert e.value.code == 2
    return capsys.readouterr().err


def straddling(corpus):
    corpus(
        "main",
        [
            rec("d20", ts="2026-08-20T10:00:00.000Z"),
            rec("d21", ts="2026-08-21T23:59:59.999Z"),
            rec("edge", ts="2026-08-22T00:00:00.000Z"),
            rec("d22", ts="2026-08-22T12:00:00.000Z"),
            rec("d30", ts="2026-09-30T10:00:00.000Z"),
        ],
    )


def requests_reported(out):
    line = next(ln for ln in out.splitlines() if ln.startswith("requests:"))
    return int(line.split(":")[1].strip().replace(",", ""))


def test_since_keeps_only_requests_at_or_after_the_boundary(corpus, capsys):
    straddling(corpus)
    out = run_main(capsys, "--since", "2026-08-22")
    assert requests_reported(out) == 3


def test_a_bare_date_starts_at_midnight_not_at_the_end_of_its_day(corpus, capsys):
    straddling(corpus)
    out = run_main(capsys, "--since", "2026-08-22T00:00:00.000Z")
    assert requests_reported(out) == 3


def test_basic_format_and_week_dates_window_where_they_mean(corpus, capsys):
    straddling(corpus)
    basic = run_main(capsys, "--since", "20260822")
    assert requests_reported(basic) == 3
    week = run_main(capsys, "--since", "2026-W34-6")
    assert requests_reported(week) == 3


def test_a_space_separated_boundary_does_not_swallow_its_own_day(corpus, capsys):
    straddling(corpus)
    out = run_main(capsys, "--since", "2026-08-22 12:00:00")
    assert requests_reported(out) == 2


def test_the_label_names_the_normalised_boundary(corpus, capsys):
    straddling(corpus)
    out = run_main(capsys, "--since", "20260822")
    assert "window: 2026-08-22T00:00:00.000Z onward" in out


def test_since_leaves_audit_labelling_its_windowed_fact(corpus, capsys):
    straddling(corpus)
    out = run_main(capsys, "--since", "2026-08-22", "--audit")
    assert "(windowed)" in out


def test_a_non_utc_offset_is_refused_naming_the_offset_and_the_z_spelling(
    corpus, capsys
):
    straddling(corpus)
    err = refused(capsys, "--since", "2026-08-22T00:00:00+07:00")
    assert "--since must be UTC" in err and "+07:00" in err
    assert "Convert it to UTC and end it in Z" in err


def test_utc_marked_boundaries_are_accepted(corpus, capsys):
    straddling(corpus)
    for spelling in ("2026-08-22T00:00:00Z", "2026-08-22T00:00:00+00:00"):
        out = run_main(capsys, "--since", spelling)
        assert requests_reported(out) == 3


def test_since_and_all_together_are_refused_as_exclusive_offering_to_drop_all(
    corpus, capsys
):
    straddling(corpus)
    err = refused(capsys, "--since", "2026-08-22", "--all")
    assert "--since/--until and --all are mutually exclusive" in err
    assert "Drop --all to window" in err


def test_since_refuses_a_value_that_is_not_a_timestamp_quoting_it_and_an_example(
    corpus, capsys
):
    straddling(corpus)
    err = refused(capsys, "--since", "last week")
    assert "--since needs an ISO date or timestamp, not 'last week'" in err
    assert "2026-08-22T12:00:00Z" in err


def test_until_excludes_its_own_boundary(corpus, capsys):
    straddling(corpus)
    out = run_main(
        capsys, "--since", "2026-08-20", "--until", "2026-08-22T00:00:00.000Z"
    )
    assert requests_reported(out) == 2


def test_two_windows_meeting_at_one_bound_partition_the_corpus(corpus, capsys):
    straddling(corpus)
    lower = run_main(capsys, "--since", "2026-08-20", "--until", "2026-08-22")
    upper = run_main(capsys, "--since", "2026-08-22")
    assert requests_reported(lower) + requests_reported(upper) == 5


def test_the_window_label_names_both_bounds(corpus, capsys):
    straddling(corpus)
    out = run_main(capsys, "--since", "2026-08-20", "--until", "2026-08-22")
    assert "2026-08-20T00:00:00.000Z to 2026-08-22T00:00:00.000Z" in out


def test_a_non_utc_until_is_refused_like_since_naming_the_offset_and_the_z_spelling(
    corpus, capsys
):
    straddling(corpus)
    err = refused(
        capsys, "--since", "2026-08-20", "--until", "2026-08-22T00:00:00+07:00"
    )
    assert "--until must be UTC" in err and "+07:00" in err
    assert "Convert it to UTC and end it in Z" in err


def test_until_refuses_a_value_that_is_not_a_timestamp_quoting_it_and_an_example(
    corpus, capsys
):
    straddling(corpus)
    err = refused(capsys, "--since", "2026-08-20", "--until", "yesterday")
    assert "--until needs an ISO date or timestamp, not 'yesterday'" in err
    assert "2026-08-22T12:00:00Z" in err


def test_until_without_since_is_refused_offering_to_add_since_or_drop_until(
    corpus, capsys
):
    straddling(corpus)
    err = refused(capsys, "--until", "2026-08-22")
    assert "--until needs a --since" in err
    assert "Add a --since, or drop --until" in err


def test_until_and_all_together_are_refused_as_exclusive_offering_to_drop_the_window(
    corpus, capsys
):
    straddling(corpus)
    err = refused(capsys, "--until", "2026-08-22", "--all")
    assert "--since/--until and --all are mutually exclusive" in err
    assert "drop --since/--until to read the whole corpus" in err


def test_an_empty_window_is_refused_naming_both_bounds_and_asking_for_a_later_until_not_a_zero(
    corpus, capsys
):
    straddling(corpus)
    for upper in ("2026-08-20", "2026-08-19"):
        err = refused(capsys, "--since", "2026-08-20", "--until", upper)
        assert f"--until '{upper}' is at or before --since '2026-08-20'" in err
        assert "Move --until later than --since" in err


def test_since_alone_still_runs_to_the_end_of_the_corpus(corpus, capsys):
    straddling(corpus)
    out = run_main(capsys, "--since", "2026-08-22")
    assert requests_reported(out) == 3
    assert "onward" in out


def test_the_default_and_all_windows_are_untouched_by_the_new_flag(corpus, capsys):
    straddling(corpus)
    default = run_main(capsys)
    assert f"window: {' to '.join(sb.WINDOW)}" in default
    whole = run_main(capsys, "--all")
    assert "window: whole corpus" in whole
    assert requests_reported(whole) == 5


@pytest.fixture
def seats(seat_roots):
    home = seat_roots()[0].parents[2]

    def write(root, session_ids, email=None):
        d = home / root
        d.mkdir(parents=True, exist_ok=True)
        (d / "history.jsonl").write_text(
            "".join(
                json.dumps(
                    {"display": "x", "project": "/p", "timestamp": 1, "sessionId": s}
                )
                + "\n"
                for s in session_ids
            )
        )
        if email:
            (d / ".claude.json").write_text(
                json.dumps({"oauthAccount": {"emailAddress": email}})
            )

    return write


def seat_block(out):
    lines = out.splitlines()
    start = lines.index("== By seat ==")
    return "\n".join(lines[start:])


def test_a_session_books_to_the_root_whose_history_names_it(corpus, seats, capsys):
    corpus("s1", [rec("r1", session="s1", ts="2026-08-23T10:00:00.000Z")])
    corpus("s2", [rec("r2", session="s2", ts="2026-08-23T10:00:00.000Z")])
    seats(".claude2", ["s1"], email="one@example.com")
    seats(".claude3", ["s2"], email="two@example.com")
    out = run_main(capsys, "--all", "--by-seat")
    block = seat_block(out)
    assert "plan B one@example.com" in block
    assert "plan C two@example.com" in block
    assert block.count("    1 sessions") == 2
    assert sb.UNATTRIBUTED not in block


def test_a_session_no_root_names_is_unattributed_rather_than_guessed(
    corpus, seats, capsys
):
    corpus("s1", [rec("r1", session="s1")])
    corpus("ghost", [rec("r2", session="ghost")])
    seats(".claude2", ["s1"])
    block = seat_block(run_main(capsys, "--all", "--by-seat"))
    assert [ln for ln in block.splitlines() if "plan B" in ln and "1 sessions" in ln]
    assert [
        ln for ln in block.splitlines() if sb.UNATTRIBUTED in ln and "1 sessions" in ln
    ]


def test_a_session_under_two_roots_is_dropped_not_assigned(corpus, seats, capsys):
    corpus("s1", [rec("r1", session="s1")])
    seats(".claude2", ["s1"])
    seats(".claude3", ["s1"])
    out = run_main(capsys, "--all", "--by-seat")
    assert "resolve to more than one root" in out
    block = seat_block(out)
    assert sb.UNATTRIBUTED in block
    assert not [
        ln for ln in block.splitlines() if ln.strip().startswith(("plan B", "plan C"))
    ]


def test_a_subagent_books_to_the_seat_of_the_session_that_dispatched_it(
    corpus, seats, capsys
):
    corpus("parent", [rec("r1", session="parent", out=1, cr=1_000)])
    corpus(
        "a1",
        [rec("r2", session="agent-x", out=1_000, cr=500_000)],
        subagent_of="parent",
    )
    seats(".claude2", ["parent"])
    out = run_main(capsys, "--all", "--by-seat")
    seat_line = [
        ln for ln in seat_block(out).splitlines() if ln.strip().startswith("plan B")
    ][0]
    assert "100.0%" in seat_line
    assert sb.UNATTRIBUTED not in seat_block(out)


def test_the_peak_five_hour_window_is_rolling_not_per_calendar_block():
    h = 3600
    peak, at = sb.peak_window([(0, 10.0), (3 * h, 40.0), (6 * h, 40.0), (9 * h, 10.0)])
    assert peak == 80.0
    assert at == 3 * h


def test_points_arriving_out_of_time_order_are_sorted_first():
    h = 3600
    assert sb.peak_window([(9 * h, 10.0), (3 * h, 40.0), (0, 10.0), (6 * h, 40.0)]) == (
        80.0,
        3 * h,
    )


def test_a_request_exactly_five_hours_old_has_left_the_window():
    peak, _ = sb.peak_window([(0, 10.0), (5 * 3600, 1.0)])
    assert peak == 10.0


def test_peak_window_of_nothing_is_zero():
    assert sb.peak_window([]) == (0.0, None)


def test_the_peak_window_line_carries_the_seats_own_requests(corpus, seats, capsys):
    corpus(
        "s1",
        [
            rec("r1", ts="2026-08-23T10:00:00.000Z"),
            rec("r2", ts="2026-08-23T13:00:00.000Z"),
        ],
    )
    seats(".claude2", ["s1"])
    out = run_main(capsys, "--all", "--by-seat")
    peak = [ln for ln in out.splitlines() if "window opens" in ln][0]
    assert "window opens 2026-08-23T10:00Z" in peak
    assert "$0  " not in peak


def test_an_unparsable_timestamp_is_counted_and_printed(corpus, seats, capsys):
    corpus("s1", [rec("r1", ts="not-a-timestamp")])
    seats(".claude2", ["s1"])
    out = run_main(capsys, "--all", "--by-seat")
    assert "1 request(s) carried no parsable timestamp" in out


def test_the_report_says_which_roots_it_read(corpus, seats, capsys):
    corpus("s1", [rec("r1")])
    seats(".claude2", ["s1"])
    out = run_main(capsys, "--all", "--by-seat")
    assert "Roots read: plan B" in out


def test_the_seat_block_is_off_unless_asked_for(corpus, seats, capsys):
    corpus("s1", [rec("r1", session="s1")])
    seats(".claude2", ["s1"])
    out = run_main(capsys, "--all")
    assert "== By seat ==" not in out


@pytest.fixture
def two_roots(seat_roots, corpus):
    roots = seat_roots(2)

    def write(i, name, records, subagent_of=None):
        corpus(name, records, subagent_of, seat=i)

    return roots, write


def test_a_request_under_the_second_root_only_is_counted(two_roots, capsys):
    _, write = two_roots
    write(0, "s-a", [rec("a")])
    write(1, "s-b", [rec("b", session="s-b")])
    write(1, "one", [rec("sub", cw=500)], subagent_of="s-b")
    reqs = {r["owner"]: r for r in sb.requests(Counter())}
    assert set(reqs) == {"s-a", "s-b"}
    assert sum(r["sub"] for r in sb.requests(Counter())) == 1
    out = run_main(capsys, "--all")
    assert requests_reported(out) == 3


def test_one_transcript_under_two_roots_is_one_set_of_requests(two_roots):
    _, write = two_roots
    write(0, "s", [rec("r1", out=100), rec("r2")])
    write(1, "s", [rec("r1", out=300), rec("r3")])
    write(0, "d", [rec("x", out=10)], subagent_of="s")
    write(1, "d", [rec("x", out=40), rec("y", out=5)], subagent_of="s")
    reqs = list(sb.requests(Counter()))
    main = {r.get("path") for r in reqs if not r["sub"]}
    subs = [r for r in reqs if r["sub"]]
    assert sorted(r["out"] for r in reqs if not r["sub"]) == [100, 100, 300]
    assert len(main) == 1
    assert {r["path"] for r in subs} == {subs[0]["path"]}
    assert max(r["out"] for r in subs) == 40


def test_a_transcript_symlinked_into_another_root_is_read_once(two_roots):
    roots, write = two_roots
    write(0, "s", [rec("r1")])
    (roots[1] / "s.jsonl").symlink_to(roots[0] / "s.jsonl")
    assert len(sb.tc.transcript_files()) == 1
    assert len(list(sb.requests(Counter()))) == 1


def test_the_report_counts_transcripts_per_root(two_roots, capsys):
    roots, write = two_roots
    write(1, "s", [rec("r1")])
    out = run_main(capsys, "--all")
    line = next(
        ln for ln in out.splitlines() if ln.startswith("transcript files per root")
    )
    assert f"{roots[0]} 0" in line and f"{roots[1]} 1" in line


def test_a_seat_with_no_directory_for_this_repo_reads_zero(two_roots, capsys):
    roots, write = two_roots
    write(0, "s", [rec("r1")])
    roots[1].rmdir()
    out = run_main(capsys, "--all")
    line = next(
        ln for ln in out.splitlines() if ln.startswith("transcript files per root")
    )
    assert f"{roots[1]} 0" in line


def test_one_copy_each_keeps_the_larger_copy_of_a_session_on_two_seats(two_roots):
    roots, write = two_roots
    write(0, "s", [rec("r1")])
    write(1, "s", [rec("r1"), rec("r2")])
    write(1, "t", [rec("r3")])
    copies = {os.path.basename(p): p for p, _, _ in sb.tc.one_copy_each()}
    assert copies == {
        "s.jsonl": str(roots[1] / "s.jsonl"),
        "t.jsonl": str(roots[1] / "t.jsonl"),
    }


def test_an_overflow_session_counts_in_no_figure(corpus, seats, capsys, mark_overflow):
    overflow = "aaaaaaaa-0000-4000-8000-000000000000"
    mark_overflow(overflow)
    corpus("plan", [rec("r1", session="plan")])
    corpus(overflow, [rec("r2", session=overflow)])
    seats(".claude2", ["plan", overflow])
    out = run_main(capsys, "--all", "--by-seat")
    assert "overflow sessions left out: 1" in out
    assert seat_block(out).count("    1 sessions") == 1


def test_no_overflow_launch_recorded_leaves_every_session_counted(
    corpus, seats, capsys
):
    corpus("s1", [rec("r1", session="s1")])
    corpus("s2", [rec("r2", session="s2")])
    seats(".claude2", ["s1", "s2"])
    out = run_main(capsys, "--all", "--by-seat")
    assert "overflow sessions left out" not in out
    assert seat_block(out).count("    2 sessions") == 1


def test_an_unread_launch_record_refuses_rather_than_counting_overflow_as_plan(
    corpus, seats, unreadable_launch_record
):
    corpus("s1", [rec("r1", session="s1")])
    seats(".claude2", ["s1"])
    with pytest.raises(SystemExit) as e:
        sb.main(["--all"])
    assert str(unreadable_launch_record) in str(e.value.code)
    assert "fix that read and re-run" in str(e.value.code)


def test_an_unparsable_session_end_leaves_its_duration_out_and_counts_it(
    corpus, capsys
):
    corpus("s1", [rec("r1", ts="not-a-date")])
    tally = Counter()
    sb.report(list(sb.requests(tally)), tally)
    out, err = capsys.readouterr()
    assert "(undated sessions: 1)" in out
    assert err == ""


def test_an_unopenable_seat_history_is_left_out_of_roots_read(seats, capsys):
    tally = Counter()
    owner, _, read = sb.seat_map(tally)
    assert (owner, read) == ({}, [])
    assert capsys.readouterr().err == ""


def test_an_unparsable_history_line_is_counted_silently(seats, capsys):
    seats(".claude", ["s1"])
    home = Path(next(iter(sb.tc.seats())))
    with open(home / "history.jsonl", "a") as fh:
        fh.write("{not json\n")
    tally = Counter()
    owner, _, _ = sb.seat_map(tally)
    assert owner == {"s1": sb.tc.seats()[str(home)]}
    assert tally["unparsed history lines"] == 1
    assert "history line" not in capsys.readouterr().err


def test_an_unreadable_account_leaves_the_seat_unnamed(seats, capsys):
    seats(".claude", ["s1"])
    home = Path(next(iter(sb.tc.seats())))
    (home / ".claude.json").write_text("{not json")
    assert sb.seat_accounts() == {}
    err = capsys.readouterr().err
    assert "account read as unknown: JSONDecodeError" in err


def test_an_undated_request_is_left_out_of_its_seats_window(corpus, seats, capsys):
    corpus("s1", [rec("r1", session="s1", ts="not-a-date")])
    seats(".claude", ["s1"])
    tally = Counter()
    sb.seat_report(list(sb.requests(tally)), tally)
    out, err = capsys.readouterr()
    assert "1 request(s) carried no parsable timestamp" in out
    assert "peak window" not in err
