import datetime as dt

import pytest

import scan_rework as sr

CLOSED = "2026-08-01T00:00:00Z"
NOW = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)


def ts(days):
    d = dt.datetime(2026, 8, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=days)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def issue(number=1, closed=CLOSED, timeline=()):
    return {"number": number, "closedAt": closed, "timeline": list(timeline)}


def xref(src_number, created_days, is_pr=False, event_days=None):
    return {
        "event": "cross-referenced",
        "createdAt": ts(event_days if event_days is not None else created_days),
        "source": {
            "number": src_number,
            "createdAt": ts(created_days),
            "isPullRequest": is_pr,
        },
    }


def test_a_clean_issue_shows_no_rework():
    s = sr.signals(issue(), 21)
    assert s["rework"] is False
    assert s["followups"] == []


def test_a_reopen_inside_the_horizon_is_rework():
    s = sr.signals(issue(timeline=[{"event": "reopened", "createdAt": ts(3)}]), 21)
    assert s["reopened"] == 1 and s["rework"] is True


def test_a_reopen_past_the_horizon_is_not_counted():
    s = sr.signals(issue(timeline=[{"event": "reopened", "createdAt": ts(40)}]), 21)
    assert s["reopened"] == 0 and s["rework"] is False


def test_a_later_issue_citing_it_is_a_followup():
    s = sr.signals(issue(timeline=[xref(1200, 5)]), 21)
    assert s["followups"] == [1200] and s["rework"] is True


def test_an_issue_that_existed_before_the_close_is_a_link_not_rework():
    s = sr.signals(issue(timeline=[xref(900, created_days=-10, event_days=5)]), 21)
    assert s["followups"] == [] and s["rework"] is False


def test_pull_requests_are_excluded():
    s = sr.signals(issue(timeline=[xref(1201, 5, is_pr=True)]), 21)
    assert s["followups"] == []


def test_the_same_followup_referenced_twice_counts_once():
    s = sr.signals(issue(timeline=[xref(1200, 5), xref(1200, 5, event_days=9)]), 21)
    assert s["followups"] == [1200]


def test_an_open_issue_yields_no_signal_at_all():
    assert sr.signals(issue(closed=None), 21) is None


def test_an_issue_closed_inside_the_horizon_is_still_ripening():
    recent = (NOW - dt.timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    mature, immature = sr.cohort([issue(closed=recent)], 21, NOW)
    assert mature == [] and len(immature) == 1


def test_an_issue_past_the_horizon_is_mature():
    mature, immature = sr.cohort([issue()], 21, NOW)
    assert len(mature) == 1 and immature == []


def test_open_issues_land_in_neither_bucket():
    mature, immature = sr.cohort([issue(closed=None)], 21, NOW)
    assert mature == [] and immature == []


def test_rate_is_none_on_an_empty_cohort():
    assert sr.rate([]) is None


def test_rate_counts_issues_not_signals():
    mature = [
        {
            "rework": True,
            "reopened": 2,
            "followups": [1, 2],
            "number": 1,
            "closed": NOW,
        },
        {"rework": False, "reopened": 0, "followups": [], "number": 2, "closed": NOW},
    ]
    r = sr.rate(mature)
    assert r["k"] == 1 and r["n"] == 2 and r["rate"] == 0.5


def test_zero_of_six_has_a_band_reaching_well_past_break_even():
    mature = [
        {"rework": False, "reopened": 0, "followups": [], "number": i, "closed": NOW}
        for i in range(6)
    ]
    r = sr.rate(mature)
    assert r["rate"] == 0
    assert r["hi"] > 0.237


def test_clopper_pearson_matches_the_closed_form_at_k_zero():
    lo, hi = sr.clopper_pearson(0, 6)
    assert lo == 0.0
    assert hi == pytest.approx(1 - 0.025 ** (1 / 6), abs=1e-6)


def test_clopper_pearson_matches_the_closed_form_at_k_equals_n():
    lo, hi = sr.clopper_pearson(6, 6)
    assert hi == 1.0
    assert lo == pytest.approx(0.025 ** (1 / 6), abs=1e-6)


def test_sampling_returns_everything_when_the_cohort_is_small():
    assert sr.sample([3, 1, 2], 60) == [1, 2, 3]


def test_sampling_is_stable_across_runs():
    pool = list(range(1, 300))
    assert sr.sample(pool, 60) == sr.sample(pool, 60)
    assert len(sr.sample(pool, 60)) == 60


def test_sample_size_zero_means_all():
    assert sr.sample([5, 1], 0) == [1, 5]


def test_a_same_day_follow_up_is_not_rework_under_the_floor():
    s = sr.signals(issue(timeline=[xref(1200, 0.2)]), 5, min_lag_days=1.0)
    assert s["followups"] == []
    assert s["rework"] is False


def test_the_same_follow_up_counts_with_the_floor_at_zero():
    s = sr.signals(issue(timeline=[xref(1200, 0.2)]), 5, min_lag_days=0.0)
    assert s["followups"] == [1200]


def test_a_same_day_reopen_is_dropped_by_the_floor_too():
    tl = [{"event": "reopened", "createdAt": ts(0.5)}]
    assert sr.signals(issue(timeline=tl), 5, min_lag_days=1.0)["reopened"] == 0
    assert sr.signals(issue(timeline=tl), 5, min_lag_days=0.0)["reopened"] == 1


def test_rework_past_the_floor_still_counts():
    s = sr.signals(issue(timeline=[xref(1200, 3)]), 5, min_lag_days=1.0)
    assert s["rework"] is True


def test_the_floor_defaults_to_zero_so_existing_callers_are_unchanged():
    assert sr.signals(issue(timeline=[xref(1200, 0.2)]), 5)["rework"] is True


def test_cohort_passes_the_floor_through():
    issues = [issue(timeline=[xref(1200, 0.2)])]
    mature, _ = sr.cohort(issues, 5, NOW, 1.0)
    assert mature[0]["rework"] is False


def test_gh_runs_the_binary_wfc_gh_names(stub_bin, monkeypatch):
    path, calls = stub_bin("gh", '[{"number": 7}]')
    monkeypatch.setenv("WFC_GH", path)
    assert sr.gh(["api", "repos/o/r/issues/7"]) == [{"number": 7}]
    assert calls() == ["api repos/o/r/issues/7"]


@pytest.mark.parametrize("config", [None, "{}"])
def test_a_host_declaring_no_tracker_exits_naming_its_config(
    config, tmp_path, monkeypatch
):
    if config is not None:
        (tmp_path / ".claude").mkdir()
        (tmp_path / ".claude" / "workflow-core.json").write_text(config)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    with pytest.raises(SystemExit) as e:
        sr.config_tracker()
    assert 'workflow-core.json declares no "tracker"' in str(e.value.code)
