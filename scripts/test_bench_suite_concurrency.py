"""Tests for the safety guarantees in scripts/bench_suite_concurrency.py.

What is worth testing here is the pair of promises the script makes about
*other people's processes*, because both fail silently and both cost a live
session (mantahostels#463, the ticket that measured the suite cap on a loaded machine):

  1. The watchdog signals process **groups**. A reaped pid is free for the
     kernel to reuse, so signalling one after reaping would kill whatever now
     owns it.
  2. The metrics path walks /proc while processes are exiting under it. A torn
     read must not take the run down.

It also pins the judgements behind the bench's figures — session counting,
baseline stationarity, idle drift — and its quiet gate and suite launch, where
a wrong call misstates the suite-concurrency cap sessions run under. Every case
drives the module with an injected memory reader and killer, literal `/proc`
text or a stub `ps` at WFC_PS, so no case signals a real process or reads this
machine's load.
"""

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


@pytest.fixture
def killed(bench):
    victims = []
    wd = bench.Watchdog(
        floor_mb=1000.0, read_avail=lambda: 500.0, killer=victims.append
    )
    wd.arm([101, 102, 103])
    return wd, victims


class TestWatchdogNeverSignalsAReapedGroup:
    def test_trips_and_kills_every_live_group(self, killed):
        wd, victims = killed
        assert wd.check_once() is True
        assert sorted(victims) == [101, 102, 103]
        assert wd.tripped_at == 500.0

    def test_a_reaped_group_is_never_signalled(self, killed):
        wd, victims = killed
        wd.note_reaped(102)
        wd.check_once()
        assert 102 not in victims
        assert sorted(victims) == [101, 103]

    def test_all_reaped_means_nothing_is_signalled(self, killed):
        wd, victims = killed
        for pgid in (101, 102, 103):
            wd.note_reaped(pgid)
        assert wd.check_once() is True
        assert victims == []

    def test_a_group_is_never_signalled_twice(self, killed):
        wd, victims = killed
        wd.check_once()
        wd.check_once()
        assert sorted(victims) == [101, 102, 103]

    def test_disarm_clears_the_set(self, bench):
        victims = []
        wd = bench.Watchdog(1000.0, read_avail=lambda: 500.0, killer=victims.append)
        wd.arm([201])
        wd.disarm()
        wd.check_once()
        assert victims == []


class TestWatchdogThreshold:
    def test_above_the_floor_it_does_not_trip(self, bench):
        victims = []
        wd = bench.Watchdog(1000.0, read_avail=lambda: 1000.1, killer=victims.append)
        wd.arm([301])
        assert wd.check_once() is False
        assert victims == []
        assert wd.tripped_at is None

    def test_it_records_the_trough_it_sees(self, bench):
        readings = iter([2000.0, 1500.0, 1800.0])
        wd = bench.Watchdog(
            100.0, read_avail=lambda: next(readings), killer=lambda p: None
        )
        wd.arm([401])
        for _ in range(3):
            wd.check_once()
        assert wd.min_avail == 1500.0

    def test_arm_resets_state_between_configurations(self, bench):
        wd = bench.Watchdog(1000.0, read_avail=lambda: 500.0, killer=lambda p: None)
        wd.arm([501])
        wd.check_once()
        assert wd.tripped_at == 500.0
        wd.read_avail = lambda: 2000.0
        wd.arm([502])
        assert wd.tripped_at is None
        assert wd.min_avail is None


class TestTornProcReadsAreSurvivable:
    """A process exiting mid-read yields a short or empty /proc read."""

    def test_ppid_parses_a_normal_line(self, bench):
        assert bench.parse_ppid("42 (node) S 7 42 42 0 -1 4194304 100 0") == 7

    def test_ppid_handles_a_comm_containing_spaces_and_parens(self, bench):
        assert bench.parse_ppid("42 (a b (c)) S 9 42 42 0 -1 0 0 0") == 9

    @pytest.mark.parametrize("torn", ["", "42 (node", "42 (node) S", "garbage"])
    def test_ppid_returns_none_rather_than_raising(self, bench, torn):
        assert bench.parse_ppid(torn) is None

    def test_a_well_formed_stat_and_statm_pair_parses_with_rss_as_pages_times_page_size(
        self, bench
    ):
        stat = "1 (x) S 0 " + " ".join(str(i) for i in range(20))
        # fields 11 and 12 after the ppid slot are utime/stime
        got = bench.parse_cpu_ticks_and_rss(stat, "500 128 3 1 0 0 0")
        assert got is not None
        ticks, rss = got
        assert rss == 128 * bench.PAGE

    @pytest.mark.parametrize("torn", ["", "1 (x", "1 (x) S 0 1 2"])
    def test_cpu_and_rss_return_none_rather_than_raising(self, bench, torn):
        assert bench.parse_cpu_ticks_and_rss(torn, "500 128 3") is None

    def test_torn_statm_returns_none(self, bench):
        stat = "1 (x) S 0 " + " ".join(str(i) for i in range(20))
        assert bench.parse_cpu_ticks_and_rss(stat, "") is None


class TestSessionCountingUnit:
    """The unit itself is test_claude_sessions.py's; this pins the bench's wiring."""

    SPARE = "/tmp/cc-daemon-1000/d/spare"
    PS = "\n".join(
        [
            f"10 1 claude bg-pty-host --bg-pty-host {SPARE}/a.pty.sock 200 50",
            f"11 10 claude bg-spare --bg-spare {SPARE}/a.claim.sock",
            f"20 1 claude bg-pty-host --bg-pty-host {SPARE}/b.pty.sock 200 50",
            f"21 20 claude bg-spare --bg-spare {SPARE}/b.claim.sock",
            "30 1 claude agents --json",
        ]
    )

    def test_the_daemons_unclaimed_spare_is_not_counted(self, bench):
        cwds = {11: "/home/l/repo", 21: self.SPARE}
        assert bench.count_sessions(self.PS, cwds.get) == 1

    def test_the_live_count_runs_the_ps_wfc_ps_names(
        self, bench, stub_bin, monkeypatch
    ):
        path, calls = stub_bin("ps", self.PS)
        monkeypatch.setenv("WFC_PS", path)
        assert bench.session_count() == 2
        assert calls() == ["-eo pid=,ppid=,args="]


class TestBaselineStationarity:
    """A dip is only a suite's cost if the baseline under it held still (mantahostels#954)."""

    def classify(self, bench, **kw):
        base = dict(
            rest_mb=5000.0,
            avail_end_mb=5000.0,
            dip_mb=1000.0,
            sessions_start=8,
            sessions_end=8,
        )
        base.update(kw)
        return bench.classify_baseline(**base)

    def test_a_row_whose_memory_came_back_is_stationary(self, bench):
        r = self.classify(bench)
        assert r["baseline_stationary"] is True
        assert r["baseline_shift_mb"] == 0.0
        assert r["dip_attributable_mb"] == 1000.0

    def test_memory_that_never_returned_is_subtracted_from_the_dip(self, bench):
        r = self.classify(bench, avail_end_mb=3000.0, dip_mb=3800.0)
        assert r["baseline_shift_mb"] == 2000.0
        assert r["dip_attributable_mb"] == 1800.0
        assert r["baseline_stationary"] is False

    def test_a_shift_inside_the_tolerance_still_counts_as_stationary(self, bench):
        # Kernel reclaim lags the last sample by design.
        r = self.classify(bench, avail_end_mb=4900.0)
        assert r["baseline_shift_mb"] == 100.0
        assert r["baseline_stationary"] is True

    def test_sessions_arriving_mid_row_disqualify_it_however_the_memory_read(
        self, bench
    ):
        r = self.classify(bench, sessions_end=13)
        assert r["baseline_stationary"] is False
        assert r["sessions_delta"] == 5

    def test_a_row_that_ended_richer_than_it_started_attributes_the_whole_dip(
        self, bench
    ):
        """The clamp: a shift cannot go negative and credit the suites.

        The dip itself is still wrong here — a neighbour freeing mid-row
        shallows the trough, so the raw dip UNDERSTATES what the suites cost.
        Nothing in the check catches that.
        """
        r = self.classify(bench, avail_end_mb=5600.0)
        assert r["baseline_shift_mb"] == 0.0
        assert r["dip_attributable_mb"] == 1000.0

    def test_the_attributable_dip_never_goes_negative(self, bench):
        r = self.classify(bench, avail_end_mb=1000.0, dip_mb=1000.0)
        assert r["dip_attributable_mb"] == 0.0

    def test_the_tolerance_is_absolute_not_a_share_of_the_dip(self, bench):
        big = self.classify(bench, avail_end_mb=4700.0, dip_mb=4000.0)
        small = self.classify(bench, avail_end_mb=4700.0, dip_mb=400.0)
        assert big["baseline_stationary"] == small["baseline_stationary"] is False

    def test_a_shift_at_the_tolerance_is_stationary_and_one_mb_past_it_is_not(
        self, bench
    ):
        tol = bench.BASELINE_SHIFT_TOLERANCE_MB
        assert self.classify(bench, avail_end_mb=5000.0 - tol)["baseline_stationary"]
        assert not self.classify(bench, avail_end_mb=5000.0 - tol - 1)[
            "baseline_stationary"
        ]

    def test_the_rss_corroborator_is_reported_and_gates_nothing(self, bench):
        """A dip far above the suite tree's own sampled peak went elsewhere."""
        r = self.classify(bench, dip_mb=3814.5, rss_peak_mb=2775.0)
        assert r["dip_over_rss_peak"] == 1.37
        clean = self.classify(bench, rss_peak_mb=100.0)
        assert clean["baseline_stationary"] is True

    def test_no_rss_peak_reports_none_rather_than_dividing_by_zero(self, bench):
        assert self.classify(bench, rss_peak_mb=0.0)["dip_over_rss_peak"] is None

    def test_the_three_954_rows_are_all_reported_contaminated(self, bench):
        """Verbatim from mantahostels#954's `results.json`.

        The aborted 2-suite row is omitted: it has no usable dip. No row here
        turns on where the tolerance sits.
        """
        rows = [
            dict(
                rest_mb=3112.7,
                avail_end_mb=2378.0,
                dip_mb=1095.1,
                sessions_start=13,
                sessions_end=13,
            ),
            dict(
                rest_mb=5432.8,
                avail_end_mb=4996.9,
                dip_mb=1544.1,
                sessions_start=8,
                sessions_end=8,
            ),
            dict(
                rest_mb=5058.0,
                avail_end_mb=3042.6,
                dip_mb=3814.5,
                sessions_start=8,
                sessions_end=13,
            ),
        ]
        assert [self.classify(bench, **r)["baseline_stationary"] for r in rows] == [
            False,
            False,
            False,
        ]


class TestQuietGate:
    def test_a_loaded_machine_is_refused_when_quiet_is_required(self, bench):
        assert bench.quiet_enough(sessions=12, required=3) is False

    def test_at_the_limit_it_runs(self, bench):
        assert bench.quiet_enough(sessions=3, required=3) is True

    def test_no_requirement_never_refuses(self, bench):
        assert bench.quiet_enough(sessions=99, required=None) is True

    def sessions_ps(self, n):
        return "\n".join(
            f"{p} 1 claude bg-pty-host --bg-pty-host /tmp/s{p}.pty.sock 200 50\n"
            f"{p + 1} {p} claude --bg-session s{p}"
            for p in range(1000, 1000 + 10 * n, 10)
        )

    @pytest.fixture
    def run_main(self, bench, stub_bin, monkeypatch, tmp_path):
        """`run_main(sessions, argv)`: `bench.main(argv)` with `sessions` live."""

        def run(sessions, argv):
            path, _ = stub_bin("ps", self.sessions_ps(sessions))
            monkeypatch.setenv("WFC_PS", path)
            monkeypatch.setenv("OUTDIR", str(tmp_path))
            # A real `true` in place of a whole suite; `settle` would sleep 20 s
            # before the first row, so it ends the run there.
            monkeypatch.setattr(bench, "suite_command", lambda workers: ["true"])

            def stop(*a):
                raise RuntimeError("past the warm-up")

            monkeypatch.setattr(bench, "settle", stop)
            bench.main(argv)

        return run

    def test_a_loaded_machine_is_refused_before_the_warm_up_runs(
        self, run_main, tmp_path
    ):
        with pytest.raises(SystemExit, match="12 sessions live.*no warm-up run"):
            run_main(12, ["1", "--require-quiet=3"])
        assert not (tmp_path / "warmup.log").exists()

    def test_a_quiet_machine_runs_the_warm_up(self, run_main, tmp_path):
        with pytest.raises(RuntimeError, match="past the warm-up"):
            run_main(3, ["1", "--require-quiet=3"])
        assert (tmp_path / "warmup.log").exists()

    def test_a_loaded_machine_measures_no_idle_drift(self, run_main, tmp_path):
        with pytest.raises(SystemExit):
            run_main(
                12,
                ["1", "--require-quiet=3", "--measure-drift=2"],
            )
        assert not (tmp_path / "drift.json").exists()

    def test_the_separated_spelling_is_refused_naming_the_flag_not_dropped(self, bench):
        """`--require-quiet 3` once meant "three suites, no gate" — the reverse."""
        with pytest.raises(ValueError, match="--require-quiet"):
            bench.parse_flags(["--require-quiet"], 900.0)

    def test_a_flag_with_a_value_is_read(self, bench):
        assert bench.parse_flags(["--require-quiet=3", "--no-warmup"], 900.0) == (
            900.0,
            3,
            None,
            3,
        )
        assert bench.parse_flags(["--floor-mb=1200"], 900.0) == (
            1200.0,
            None,
            None,
            3,
        )


class TestSuiteLaunch:
    """#1132: a bare `npm run test` narrows to the diff (mantahostels#3208)."""

    def test_each_suite_runs_the_whole_suite_at_the_chosen_workers(self, bench):
        assert bench.suite_command(2) == [
            "npm",
            "run",
            "test",
            "--",
            "--full=other",
            "--maxWorkers=2",
        ]

    def test_the_stall_killer_is_off_and_the_rest_of_the_env_kept(self, bench):
        env = bench.suite_env({"PATH": "/bin"})
        assert env == {"PATH": "/bin", "WFC_TEST_STALL_MS": "0"}

    def test_workers_default_to_the_ladders_suite_workers(self, bench):
        suite_ladder = (REPO / "scripts/lib/suite-ladder.js").read_text()
        ladder = int(re.search(r"LADDER_SUITE_WORKERS = (\d+);", suite_ladder).group(1))
        assert bench.parse_flags([], 900.0)[3] == ladder

    def test_the_workers_flag_is_read(self, bench):
        assert bench.parse_flags(["--workers=2"], 900.0)[3] == 2

    def test_the_separated_workers_spelling_is_refused_naming_the_flag_not_dropped(
        self, bench
    ):
        """`--workers 2` would leave the 2 to be read as two suites."""
        with pytest.raises(ValueError, match="--workers"):
            bench.parse_flags(["--workers"], 900.0)


class TestIdleBaselineDrift:
    """mantahostels#1449: `BASELINE_SHIFT_TOLERANCE_MB` stands for how far
    `MemAvailable` wanders between two resting settles when nothing is running.

    That is measurable only on the same quiet machine the three-suite row needs,
    so it is captured by the same run.
    """

    def test_the_drift_is_the_gap_between_consecutive_settles(self, bench):
        assert bench.drift_from_settle_means([5000.0, 5050.0, 5020.0])[
            "drift_deltas_mb"
        ] == [50.0, 30.0]

    def test_a_fall_counts_as_much_as_a_rise(self, bench):
        """Signed drift would cancel a wander out to nothing across a long run."""
        rise = bench.drift_from_settle_means([5000.0, 5080.0])
        fall = bench.drift_from_settle_means([5080.0, 5000.0])
        assert rise["drift_max_mb"] == fall["drift_max_mb"] == 80.0

    def test_max_and_mean_are_over_the_gaps_not_the_settles(self, bench):
        d = bench.drift_from_settle_means([5000.0, 5100.0, 5100.0])
        assert d["drift_max_mb"] == 100.0
        assert d["drift_mean_mb"] == 50.0

    def test_one_settle_measures_no_drift_and_says_so(self, bench):
        """Returning 0.0 here would read as a perfectly stationary machine."""
        with pytest.raises(ValueError, match="two"):
            bench.drift_from_settle_means([5000.0])

    def test_every_settle_mean_is_kept_for_the_record(self, bench):
        d = bench.drift_from_settle_means([5000.0, 5100.0])
        assert d["settle_means_mb"] == [5000.0, 5100.0]
        assert d["settles"] == 2

    def test_the_driver_settles_the_number_it_was_asked_for(self, bench):
        calls = []
        d = bench.measure_baseline_drift(
            3, settle_fn=lambda: (calls.append(1), 5000.0 + len(calls))[1]
        )
        assert len(calls) == 3
        assert d["settle_means_mb"] == [5001.0, 5002.0, 5003.0]

    def test_the_drift_flag_is_read(self, bench):
        assert bench.parse_flags(["--measure-drift=4"], 900.0) == (900.0, None, 4, 3)

    def test_the_separated_drift_spelling_is_refused_naming_the_flag_not_dropped(
        self, bench
    ):
        """`--measure-drift 4` would leave the 4 to be read as four suites."""
        with pytest.raises(ValueError, match="--measure-drift"):
            bench.parse_flags(["--measure-drift"], 900.0)

    def test_the_tolerance_is_not_below_the_measured_idle_drift(self, bench):
        """A tolerance under the machine's own idle wander condemns clean rows.

        214.3 MB is the largest idle settle gap mantahostels#1449 read, with three
        sessions live.
        """
        assert bench.BASELINE_SHIFT_TOLERANCE_MB >= 214.3
