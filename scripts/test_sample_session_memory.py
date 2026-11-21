"""Tests for scripts/sample_session_memory.py — the judgements under #333's figures.

The /proc readers and the sampling loop are exercised by a live run, not here.
What is tested is what turns rows into the published figures — how a
command is named, which repo a session belongs to, the percentile, which
process instances count as spikes, which processes make a session's pair and
which its descendants (admission's unit, #2231) — and which `claude` binary the
oracle runs.

Each judgement is fed literal rows, or a temp CSV, rather than a live sample.
The sampler is run by hand; loosen a case and its per-repo figures misstate
what a session and the processes it starts cost, the figure #333 sizes
admission on.
"""

import gzip
import os
from collections import Counter

import pytest

import sample_session_memory as m


def test_command_key_names_the_script_not_the_interpreter_flags():
    assert (
        m.command_key(
            [
                "node",
                "--max-old-space-size=4096",
                "scripts/check-reachability.js",
                "--x",
            ]
        )
        == "node check-reachability.js"
    )
    assert (
        m.command_key(["/usr/bin/python3.12", "-m", "pytest", "-n", "2"])
        == "python3 -m pytest"
    )
    assert m.command_key(["node", "--test", "--test-coverage"]) == "node --test"
    assert m.command_key(["/bin/bash", "-c", "source x && npm run test"]) == "bash -c"


def test_command_key_keeps_the_subcommand_of_git_gh_and_npm():
    assert m.command_key(["git", "-C", "/x", "status"]) == "git status"
    assert m.command_key(["/usr/bin/gh", "issue", "view", "3"]) == "gh issue"
    assert m.command_key(["npm", "run", "test:changed"]) == "npm run test:changed"
    assert m.command_key(["gitleaks", "detect"]) == "gitleaks"
    assert m.command_key([]) == "?"


def test_repo_is_the_first_segment_under_home_so_worktrees_count_to_their_repo():
    home = os.path.expanduser("~")
    assert m.repo_of(f"{home}/fantasy-books") == "fantasy-books"
    assert m.repo_of(f"{home}/workflow-core/.claude/worktrees/w1") == "workflow-core"
    assert m.repo_of("/tmp/elsewhere") == "elsewhere"
    assert m.repo_of(None) == "?"


def test_percentile_is_nearest_rank_so_every_figure_is_a_real_sample():
    values = list(range(1, 11))
    assert m.percentile(values, 50) == 5
    assert m.percentile(values, 90) == 9
    assert m.percentile(values, 95) == 10
    assert m.percentile([7], 90) == 7
    assert m.percentile([], 90) is None


def session_row(repo, session, own_mb, desc_mb):
    return {
        "repo": repo,
        "session": session,
        "own_pss_kb": str(own_mb * 1024),
        "desc_pss_kb": str(desc_mb * 1024),
    }


def proc_row(repo, key, peak_mb, *, first, last):
    return {
        "repo": repo,
        "key": key,
        "peak_pss_kb": str(peak_mb * 1024),
        "first_ts": str(first),
        "last_ts": str(last),
    }


def test_analyse_splits_by_repo_and_prices_own_apart_from_descendants():
    rows = [
        session_row("fb", "a", 500, 0),
        session_row("fb", "a", 500, 1000),
        session_row("wc", "b", 400, 100),
    ]
    result = m.analyse_rows(rows, [], spike_mb=100)
    assert result["fb"]["sessions"] == 1
    assert result["fb"]["total"]["max"] == 1500
    assert result["fb"]["own"]["max"] == 500
    assert result["wc"]["total"]["median"] == 500


def test_analyse_counts_only_instances_at_or_over_the_spike_floor():
    procs = [
        proc_row("fb", "node check-reachability.js", 1250, first=100, last=120),
        proc_row("fb", "node check-reachability.js", 900, first=200, last=210),
        proc_row("fb", "git status", 99, first=300, last=300),
    ]
    result = m.analyse_rows([session_row("fb", "a", 500, 0)], procs, spike_mb=100)
    [spike] = result["fb"]["spikes"]
    assert spike["key"] == "node check-reachability.js"
    assert spike["count"] == 2
    assert spike["peak_max"] == 1250
    assert spike["duration_median"] == 15


def test_analyse_prices_working_samples_apart_from_finished_resident_ones():
    rows = [
        {**session_row("fb", "a", 600, 400), "state": "working"},
        {**session_row("fb", "b", 230, 0), "state": "done"},
    ]
    result = m.analyse_rows(rows, [], spike_mb=100)
    assert result["fb"]["total"]["n"] == 2
    assert result["fb"]["working_total"]["n"] == 1
    assert result["fb"]["working_total"]["max"] == 1000
    assert result["fb"]["working_own"]["max"] == 600


def test_a_torn_last_line_is_dropped_and_counted_against_its_file_not_failing_the_read(
    tmp_path, capsys
):
    path = tmp_path / "sessions.csv"
    path.write_text("ts,own_pss_kb,desc_pss_kb\n1,100,200\n2,10")
    torn = Counter()
    rows = m.read_rows(str(path), ("ts", "own_pss_kb", "desc_pss_kb"), torn)
    assert [r["ts"] for r in rows] == ["1"]
    assert torn == {"sessions.csv": 1}
    assert "fail-open: row of sessions.csv dropped" in capsys.readouterr().err


def test_a_gzipped_csv_is_read_where_the_plain_one_is_absent(tmp_path):
    with gzip.open(tmp_path / "sessions.csv.gz", "wt") as f:
        f.write("ts,own_pss_kb,desc_pss_kb\n1,100,200\n")
    rows = m.read_rows(
        str(tmp_path / "sessions.csv"), ("ts", "own_pss_kb", "desc_pss_kb"), Counter()
    )
    assert [r["own_pss_kb"] for r in rows] == ["100"]


def test_sessions_are_listed_by_the_binary_wfc_claude_bin_names(stub_bin, monkeypatch):
    path, calls = stub_bin("claude", '[{"pid": 7}, {"pid": "x"}]')
    monkeypatch.setenv("WFC_CLAUDE_BIN", path)
    assert m.list_sessions() == [{"pid": 7}]
    assert calls() == ["agents --json"]


def test_an_unparsable_session_list_is_none_and_named(stub_bin, monkeypatch, capsys):
    path, _ = stub_bin("claude", "not json")
    monkeypatch.setenv("WFC_CLAUDE_BIN", path)
    assert m.list_sessions() is None
    assert (
        "fail-open: session list kept from the last sample" in capsys.readouterr().err
    )


# Above pid_max, so no live process owns it.
GONE = 99_999_999


def test_a_pid_gone_before_its_stat_reads_is_left_out_of_the_table(monkeypatch, capsys):
    # A pid exiting between /proc's listing and its stat read is a race no
    # fixture can time.
    monkeypatch.setattr(m.os, "listdir", lambda _: [str(GONE)])
    assert m.read_proc_table() == {}
    assert (
        f"fail-open: pid {GONE} left out of the proc table" in capsys.readouterr().err
    )


@pytest.mark.parametrize(
    "read, fallback, instead",
    [
        (lambda: m.pss_kb(GONE), None, f"pid {GONE} PSS read as gone"),
        (lambda: m.cmdline(GONE), [], f"pid {GONE} argv read as empty"),
        (
            lambda: m.environ_var(GONE, "CLAUDE_CONFIG_DIR"),
            None,
            f"pid {GONE} CLAUDE_CONFIG_DIR read as unset",
        ),
    ],
)
def test_a_gone_pids_read_falls_back_and_is_named(read, fallback, instead, capsys):
    assert read() == fallback
    assert f"fail-open: {instead}" in capsys.readouterr().err


@pytest.mark.parametrize("text", [None, "{torn"])
def test_an_unreadable_or_torn_marker_is_none_and_named(tmp_path, capsys, text):
    path = tmp_path / "marker.json"
    if text is not None:
        path.write_text(text)
    assert m.read_marker(str(path)) is None
    assert f"fail-open: {path} read as no marker" in capsys.readouterr().err


def test_summarise_gives_the_mean_and_sd_the_aggregate_draw_is_declared_from():
    s = m.summarise([400 * 1024, 600 * 1024])
    assert s["mean"] == 500
    assert round(s["sd"], 3) == 141.421
    assert m.summarise([400 * 1024])["sd"] is None


def test_aggregate_sums_each_instant_live_sessions_and_leaves_out_ended_ones():
    rows = [
        {**session_row("wc", "a", 300, 100), "ts": "1", "state": "working"},
        {**session_row("wc", "b", 300, 0), "ts": "1", "state": "blocked"},
        {**session_row("wc", "c", 900, 0), "ts": "1", "state": "done"},
        {**session_row("wc", "a", 300, 300), "ts": "2", "state": "working"},
        {**session_row("wc", "b", 300, 0), "ts": "2", "state": "working"},
    ]
    [two] = m.aggregate_rows(rows, mean_mb=400, sd_mb=100)
    assert two["sessions"] == 2
    assert two["ticks"] == 2
    assert two["p95"] == 900
    assert round(two["model"], 1) == round(800 + 1.645 * 100 * 2**0.5, 1)


def test_a_nested_session_and_its_subtree_are_left_to_its_own_row():
    children = {1: [2, 3], 2: [4], 3: [5]}
    assert sorted(m.descendants(1, children, {1, 3})) == [2, 4]


def test_a_pair_reads_unknown_where_a_half_is_gone_reused_or_unreadable():
    procs = {10: (1, 500), 11: (10, 501)}
    pss = {10: 300, 11: 100}.get
    assert m.pair_pss_kb([(10, 500), (11, 501)], procs, pss) == 400
    assert m.pair_pss_kb([(10, 500), (12, 502)], procs, pss) is None
    assert m.pair_pss_kb([(10, 500), (11, 999)], procs, pss) is None
    assert m.pair_pss_kb([(10, 500), (11, 501)], procs, {10: 300}.get) is None


def test_a_live_gate_seat_and_its_subtree_are_left_out_of_the_session():
    # session 1 → hook 2 → gate holder 3 → sh 4 → runner 5; 6 is a sibling
    children = {1: [2, 6], 2: [3], 3: [4], 4: [5]}
    procs = {1: (0, 10), 2: (1, 20), 3: (2, 30), 4: (3, 40), 5: (4, 50), 6: (1, 60)}
    env = {4: "/q/gate.json", 5: "/q/gate.json"}
    seats = m.gate_seat_pids(
        m.descendants(1, children, {1}),
        procs,
        var_of=lambda pid, _name: env.get(pid),
        marker_of={"/q/gate.json": {"pid": 3, "start": 30}}.get,
    )
    assert seats == {3}
    assert sorted(m.descendants(1, children, {1} | seats)) == [2, 6]


def test_a_process_carrying_the_seat_outside_the_holders_tree_still_counts():
    # 6 inherited the variable but is no descendant of holder 3
    procs = {1: (0, 10), 2: (1, 20), 3: (2, 30), 6: (1, 60)}
    seats = m.gate_seat_pids(
        [2, 3, 6],
        procs,
        var_of=lambda pid, _name: "/q/gate.json" if pid == 6 else None,
        marker_of={"/q/gate.json": {"pid": 3}}.get,
    )
    assert seats == set()


def test_a_dead_reused_or_unreadable_seat_marker_leaves_nothing_out():
    procs = {1: (0, 10), 3: (1, 30), 4: (3, 40)}

    def seats(marker):
        return m.gate_seat_pids(
            [3, 4],
            procs,
            var_of=lambda pid, _name: "/q/gate.json" if pid == 4 else None,
            marker_of=lambda _path: marker,
        )

    assert seats({"pid": 3, "start": 30}) == {3}
    assert seats({"pid": 99}) == set()  # holder gone
    assert seats({"pid": 3, "start": 31}) == set()  # pid reused
    assert seats(None) == set()  # marker unread or torn
