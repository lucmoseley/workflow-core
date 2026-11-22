import gzip
import json
import os
import subprocess
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
    assert capsys.readouterr().err == ""


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


GONE = 99_999_999


def test_a_pid_gone_before_its_stat_reads_is_left_out_of_the_table(monkeypatch, capsys):
    monkeypatch.setattr(m.os, "listdir", lambda _: [str(GONE)])
    assert m.read_proc_table() == {}
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize(
    "read, fallback",
    [
        (lambda: m.pss_kb(GONE), None),
        (lambda: m.cmdline(GONE), []),
        (lambda: m.environ_var(GONE, "CLAUDE_CONFIG_DIR"), None),
    ],
)
def test_a_gone_pids_read_falls_back_silently(read, fallback, capsys):
    assert read() == fallback
    assert capsys.readouterr().err == ""


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads every environ")
def test_another_users_environ_reads_as_unset_silently(capsys):
    assert m.environ_var(1, "CLAUDE_CONFIG_DIR") is None
    assert capsys.readouterr().err == ""


def test_a_removed_marker_is_none_silently(tmp_path, capsys):
    assert m.read_marker(str(tmp_path / "marker.json")) is None
    assert capsys.readouterr().err == ""


def test_a_torn_marker_is_none_and_named(tmp_path, capsys):
    path = tmp_path / "marker.json"
    path.write_text("{torn")
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
    assert seats({"pid": 99}) == set()
    assert seats({"pid": 3, "start": 31}) == set()
    assert seats(None) == set()


def test_a_pid_not_ours_to_read_is_left_out_of_the_table(monkeypatch, capsys):
    real_open = open

    def opener(path, *a, **kw):
        if path == f"/proc/{GONE}/stat":
            raise PermissionError(13, "Permission denied", path)
        return real_open(path, *a, **kw)

    monkeypatch.setattr(m.os, "listdir", lambda _: [str(GONE)])
    monkeypatch.setattr("builtins.open", opener)
    assert m.read_proc_table() == {}
    assert capsys.readouterr().err == ""


LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")

JS_PARITY = """
const lib = process.argv[1];
const req = (name) => require(`${lib}/${name}`);
const { kind, cases } = JSON.parse(process.argv[2]);
const run = {
  constants: () => ({
    GATE_ENV: req("gate-seat.js").GATE_ENV,
    DRAW_Z: req("admission-figures.js").DRAW_Z,
  }),
  ancestors: ({ pid, procs }) =>
    req("proc-stat.js").readAncestorsOf(pid, {
      parentOf: (p) => procs[p]?.[0] ?? 0,
    }),
  held: ({ pid, procs, file }) => {
    const ports = {
      alive: (p) => Object.hasOwn(procs, String(p)),
      startTime: (p) => procs[p]?.[1] ?? 0,
    };
    const suiteQueue = req("suite-queue.js");
    const held = suiteQueue.heldMarker("SEAT", {
      env: { SEAT: file },
      pid,
      parentOf: (p) => procs[p]?.[0] ?? 0,
      ...ports,
    });
    let record = null;
    try {
      record = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    } catch {}
    const isRecord = record && typeof record === "object" && !Array.isArray(record);
    return {
      stale: isRecord ? suiteQueue.isMarkerStale(record, ports) : null,
      held: held ? held.record.pid : null,
    };
  },
  descendants: ({ root, children, stops }) => {
    const reached = [];
    req("descendants-pss-kb.js").descendantsPssKb(
      String(root),
      {
        children: new Map(Object.entries(children).map(([k, v]) => [k, v.map(String)])),
        stopPids: new Set(stops.map(String)),
        pssKbOf: () => 0,
      },
      reached,
    );
    return reached.map(Number).sort((a, b) => a - b);
  },
}[kind];
process.stdout.write(JSON.stringify(kind === "constants" ? run() : cases.map(run)));
"""


def js_side(kind, cases=()):
    out = subprocess.run(
        [
            "node",
            "-e",
            JS_PARITY,
            LIB,
            json.dumps({"kind": kind, "cases": list(cases)}),
        ],
        capture_output=True,
        text=True,
        check=True,
        env={"PATH": os.environ["PATH"]},
    )
    return json.loads(out.stdout)


def chain(length):
    return {pid: (pid - 1, pid * 10) for pid in range(1, length + 1)}


def test_the_gate_env_name_and_draw_z_are_the_js_libs_own():
    assert js_side("constants") == {"GATE_ENV": m.GATE_ENV, "DRAW_Z": m.DRAW_Z}


ANCESTOR_CASES = [
    (5, chain(5)),
    (100, chain(100)),
    (3, {1: (3, 10), 2: (1, 20), 3: (2, 30)}),
    (4, {4: (4, 40)}),
    (7, {7: (6, 70)}),
    (9, {}),
]


def test_the_ancestor_walk_is_read_ancestors_of_hop_cap_and_cycle_stop_included():
    py = [m.ancestors(pid, procs) for pid, procs in ANCESTOR_CASES]
    js = js_side(
        "ancestors",
        [{"pid": pid, "procs": procs} for pid, procs in ANCESTOR_CASES],
    )
    assert py == js
    assert len(py[1]) == m.ANCESTOR_MAX_HOPS


HELD_PROCS = {1: (0, 10), 3: (1, 30), 4: (3, 40), 6: (1, 60)}
HELD_MARKERS = [
    {"pid": 3, "start": 30},
    {"pid": 3},
    {"pid": 3, "start": 0},
    {"pid": 3, "start": 31},
    {"pid": 99},
    {"pid": 99, "start": 990},
    {"pid": 6, "start": 60},
]


@pytest.mark.parametrize("candidate", [4, 6])
def test_marker_staleness_and_the_held_seat_are_is_marker_stale_and_held_markers(
    candidate, tmp_path
):
    files = []
    for n, body in enumerate(
        [json.dumps(r) for r in HELD_MARKERS] + ["{torn", "[3]", "null"]
    ):
        files.append(tmp_path / f"gate-{n}.json")
        files[-1].write_text(body)
    py = []
    for file in files:
        record = m.read_marker(str(file))
        seats = m.gate_seat_pids(
            [candidate],
            HELD_PROCS,
            var_of=lambda _pid, _name, file=file: str(file),
        )
        py.append(
            {
                "stale": None
                if record is None
                else m.live_holder(record, HELD_PROCS) is None,
                "held": next(iter(seats), None),
            }
        )
    js = js_side(
        "held",
        [{"pid": candidate, "procs": HELD_PROCS, "file": str(f)} for f in files],
    )
    assert py == js


DESCENDANT_CASES = [
    (1, {1: [2, 3], 2: [4], 3: [5]}, {1, 3}),
    (1, {1: [2, 6], 2: [3], 3: [4], 4: [5]}, {1}),
    (1, {1: [2, 6], 2: [3], 3: [4], 4: [5]}, {1, 3}),
    (1, {1: [2], 2: [3]}, {2}),
    (1, {}, set()),
]


def test_the_descendant_stop_is_descendants_pss_kbs():
    py = [sorted(m.descendants(r, c, s)) for r, c, s in DESCENDANT_CASES]
    js = js_side(
        "descendants",
        [
            {"root": r, "children": c, "stops": sorted(s)}
            for r, c, s in DESCENDANT_CASES
        ],
    )
    assert py == js
