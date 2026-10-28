"""Pins bench.py's per-call figures and deny count, and the paired gate a
guard port is read by (#2733, #2783, #3216), and that each dispatched tool's
payload carries what its cores read (#3176).

`one_call` runs real `/bin/sh` commands, since the parallel start and the
children's rusage are what it measures. The payload cases run `node`, since the
subject a core reads is the dispatcher's `subjectFor` on the core's own
`field`, and the Skill case runs the dispatcher itself.

full-sweep-only: the payload case loads every core `guard-cores.json` names.
"""

import json
import os
import random
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from bench import (
    one_call,
    payload,
    judge_pairs,
    run_paired,
    summarise,
)

HERE = Path(__file__).parent


def test_one_call_runs_every_hook_on_the_payload_and_counts_its_denies(tmp_path):
    body = payload(str(tmp_path), "t.jsonl", event="PreToolUse", tool="Bash", cmd="ls")
    cmds = [
        "cat >/dev/null",
        'grep -q \'"tool_name": "Bash"\' && echo \'{"permissionDecision":"deny"}\'',
        "cat >/dev/null; exit 2",
    ]
    call = one_call(cmds, body, dict(os.environ), str(tmp_path))
    assert call["denies"] == 2
    assert call["detached"] == 0
    assert call["wall"] > 0
    assert call["cpu"] >= call["sys"] >= 0


def test_a_post_call_payload_carries_the_answer_and_a_file_tool_its_path(tmp_path):
    pre = json.loads(
        payload(str(tmp_path), "t", event="PreToolUse", tool="Bash", cmd="ls")
    )
    assert pre["tool_input"]["command"] == "ls" and "tool_response" not in pre
    post = json.loads(
        payload(str(tmp_path), "t", event="PostToolUse", tool="Bash", cmd="ls")
    )
    assert post["tool_response"]["stdout"] == "bench"
    read = json.loads(
        payload(str(tmp_path), "t", event="PostToolUse", tool="Read", cmd="/f")
    )
    assert read["tool_input"] == {"file_path": "/f"}
    assert read["tool_response"]["file"]["filePath"] == "/f"
    write = json.loads(
        payload(str(tmp_path), "t", event="PostToolUse", tool="Write", cmd="/f")
    )
    assert write["tool_input"]["file_path"] == "/f" and write["tool_response"]


REPO = HERE.parent.parent

# Each (event, tool, core) triple's subject, read off its bench payload by the
# dispatcher's own subjectFor: a core finding none fails open unjudged (#3176).
UNREAD = """
const { corePath } = require("./scripts/lib/guard-cores.js");
const { subjectFor } = require("./scripts/lib/guard-entry.js");
const triples = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(triples
  .filter(([, , core, body]) => subjectFor(body, require(corePath(core))) === null)
  .map(([event, tool, core]) => `${event} ${tool} ${core}`)));
"""


def test_every_dispatched_tools_payload_carries_the_subject_its_cores_read(tmp_path):
    manifest = json.loads((REPO / "scripts/lib/guard-cores.json").read_text())
    triples = [
        [
            event,
            tool,
            row["core"],
            json.loads(
                payload(str(tmp_path), "t", event=event, tool=tool, cmd="bench")
            ),
        ]
        for event, rows in manifest.items()
        if isinstance(rows, list)
        for row in rows
        for tool in row["tools"].split("|")
    ]
    assert any(t[:3] == ["PreToolUse", "Skill", "last30days.js"] for t in triples)
    planted = [
        "PreToolUse",
        "Skill",
        "last30days.js",
        {"tool_input": {"file_path": "bench"}},
    ]
    done = subprocess.run(
        ["node", "-e", UNREAD],
        input=json.dumps([*triples, planted]),
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == ["PreToolUse Skill last30days.js"]


def test_dispatch_edit_and_fetch_payloads_carry_what_their_cores_read_beyond_the_subject(
    tmp_path,
):
    def given(event, tool):
        return json.loads(payload(str(tmp_path), "t", event=event, tool=tool, cmd="s"))

    agent = given("PreToolUse", "Agent")["tool_input"]
    assert agent["description"] and agent["subagent_type"]
    edit = given("PreToolUse", "Edit")["tool_input"]
    assert {"old_string", "new_string"} <= edit.keys()
    assert given("PostToolUse", "WebFetch")["tool_response"]["result"]
    assert given("PostToolUse", "WebSearch")["tool_response"]["results"]


def test_a_skill_call_is_denied_by_the_last30days_core_naming_the_subagent_route(
    tmp_path,
):
    body = payload(
        str(tmp_path), "t", event="PreToolUse", tool="Skill", cmd="last30days"
    )
    done = subprocess.run(
        ["node", str(REPO / "scripts/guard-dispatch.js")],
        input=body,
        capture_output=True,
        env=dict(
            os.environ,
            CLAUDE_PROJECT_DIR=str(tmp_path),
            CLAUDE_CONFIG_DIR=str(tmp_path / "config"),
        ),
    )
    assert done.stdout, "allowed with no decision: the cores found no skill (#3176)"
    out = json.loads(done.stdout)["hookSpecificOutput"]
    assert out["permissionDecision"] == "deny"
    assert "last30days must run in a subagent" in out["permissionDecisionReason"]


def test_a_detached_child_is_counted_once_it_exits_and_refused_while_it_runs(tmp_path):
    # Run in a child, so the pytest worker never becomes a subreaper.
    probe = f"""
import os, subprocess, sys
sys.path.insert(0, {str(HERE)!r})
from bench import become_subreaper, one_call
become_subreaper()
env, cwd = dict(os.environ), {str(tmp_path)!r}
# The detached loop costs some 300-500 ms of CPU; 50 ms is far under it.
burn = "i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done"
quick = one_call([f"({{burn}}) & exit 0"], b"", env, cwd)
assert quick["detached"] == 0 and quick["cpu"] > 50, quick
# Long enough to outlive the call.
held = one_call(["sleep 5 >/dev/null 2>&1 & exit 0"], b"", env, cwd)
assert held["detached"] == 1, held
subprocess.run(["pkill", "-P", str(os.getpid()), "sleep"])
"""
    done = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def call(cpu, wall, denies=0, detached=0):
    return {
        "cpu": cpu,
        "wall": wall,
        "sys": 0,
        "minflt": 0,
        "denies": denies,
        "detached": detached,
    }


def test_the_gate_passes_fails_or_holds_on_the_ratio_interval_against_1_03():
    rng = random.Random(1)
    flat = [(call(100, 100), call(100, 100))] * 30
    assert judge_pairs(flat, False, rng)["verdict"] == "PASS"
    worse = [(call(100, 100), call(110, 110))] * 30
    assert judge_pairs(worse, False, rng)["verdict"] == "FAIL"
    wide = [(call(100, 100), call(90 + 3 * (i % 10), 100)) for i in range(30)]
    read = judge_pairs(wide, False, rng)
    assert read["cpu"]["ci95"][0] <= 1.03 < read["cpu"]["ci95"][1]
    assert read["cpu"]["verdict"] == read["verdict"] == "INCONCLUSIVE"


def test_a_narrowed_guard_passes_on_wall_with_cpu_recorded_beside_it():
    rng = random.Random(1)
    pairs = [(call(100, 100), call(150, 100))] * 30
    assert judge_pairs(pairs, False, rng)["verdict"] == "FAIL"
    read = judge_pairs(pairs, True, rng)
    assert read["verdict"] == "PASS" and read["cpu"]["verdict"] == "FAIL"


def run_with(values, narrowed=False):
    """run_paired over calls whose new/old ratio cycles through `values`,
    recording the order each pair ran in."""
    order, i = [], [0]

    def old():
        order.append("old")
        return call(100, 100)

    def new():
        order.append("new")
        r = values[i[0] % len(values)]
        i[0] += 1
        return call(100 * r, 100 * r)

    return run_paired(old, new, narrowed, random.Random(7)), order


def test_pairs_run_in_a_coin_flip_order_and_stop_at_the_first_verdict():
    out, order = run_with([1.0])
    assert out["verdict"] == "PASS" and out["pairs"] == 30
    assert set(order[::2]) == {"old", "new"}
    assert all(a != b for a, b in zip(order[::2], order[1::2], strict=True))
    assert out["old"]["n"] == out["new"]["n"] == 30


def test_an_open_interval_adds_30_pairs_up_to_90_and_stays_inconclusive():
    out, _ = run_with([0.9, 0.93, 0.96, 0.99, 1.02, 1.05, 1.08, 1.11, 1.14, 1.17])
    assert out["verdict"] == "INCONCLUSIVE" and out["pairs"] == 90


def test_a_pair_whose_deny_counts_differ_or_that_detaches_is_refused():
    deny = run_paired(
        lambda: call(1, 1), lambda: call(1, 1, denies=1), False, random.Random(0)
    )
    assert deny == {
        "verdict": "REFUSED",
        "reason": "deny counts differ: old 0, new 1",
        "pairs": 1,
    }
    held = run_paired(
        lambda: call(1, 1, detached=1), lambda: call(1, 1), False, random.Random(0)
    )
    assert held["verdict"] == "REFUSED" and "detached" in held["reason"]


def test_summarise_takes_medians_and_ranges():
    calls = [
        {"wall": w, "cpu": c, "sys": s, "minflt": f, "denies": 0}
        for w, c, s, f in [
            (10, 100, 30, 1000),
            (30, 300, 50, 3000),
            (20, 200, 40, 2000),
        ]
    ]
    out = summarise(calls)
    assert out["n"] == 3
    assert out["wall_ms_med"] == 20
    assert out["wall_ms_range"] == [10, 30]
    assert out["cpu_ms_med"] == 200
    assert out["sys_ms_med"] == 40
    assert out["minflt_med"] == 2000
    assert out["wall_ms"] == [10, 30, 20] and out["cpu_ms"] == [100, 300, 200]


def test_the_program_reports_the_figures_with_the_machine_state_beside_them(tmp_path):
    hooks = tmp_path / "hooks.txt"
    hooks.write_text("cat >/dev/null\n")
    (tmp_path / ".claude").mkdir()
    done = subprocess.run(
        [
            sys.executable,
            str(HERE / "bench.py"),
            str(hooks),
            "PreToolUse",
            "Bash",
            "ls",
            "2",
        ],
        capture_output=True,
        text=True,
        env=dict(os.environ, CLAUDE_PROJECT_DIR=str(tmp_path)),
    )
    assert done.returncode == 0
    out = json.loads(done.stdout)
    assert (out["hooks"], out["n"], out["denies"]) == (1, 2, 0)
    assert out["before"]["load1"] and out["after"]["free_m"][0].split()[0] == "total"


def test_the_paired_program_reads_two_sets_with_the_machine_state_beside_them(tmp_path):
    old = tmp_path / "old.txt"
    old.write_text("cat >/dev/null\ncat >/dev/null\n")
    new = tmp_path / "new.txt"
    new.write_text("cat >/dev/null\n")
    (tmp_path / ".claude").mkdir()
    done = subprocess.run(
        [
            sys.executable,
            str(HERE / "bench.py"),
            "--paired",
            "--narrowed",
            str(old),
            str(new),
            "PreToolUse",
            "Bash",
            "ls",
        ],
        capture_output=True,
        text=True,
        env=dict(os.environ, CLAUDE_PROJECT_DIR=str(tmp_path)),
    )
    assert done.returncode == 0, done.stderr
    out = json.loads(done.stdout)
    assert out["hooks"] == [2, 1]
    assert out["verdict"] in {"PASS", "FAIL", "INCONCLUSIVE"}
    assert out["pairs"] in {30, 60, 90} and out["new"]["n"] == out["pairs"]
    assert out["before"]["load1"] and out["after"]["load1"]


def test_each_paired_side_runs_from_its_own_root(tmp_path):
    sets, roots = [], []
    for name in ("before", "after"):
        root = tmp_path / name
        (root / ".claude").mkdir(parents=True)
        (root / "who.sh").write_text(f"cat >/dev/null; [ $PWD = {root} ] || exit 2\n")
        hooks = tmp_path / f"{name}.txt"
        hooks.write_text('sh "$CLAUDE_PROJECT_DIR"/who.sh\n')
        sets.append(str(hooks))
        roots.append(str(root))
    done = subprocess.run(
        [
            sys.executable,
            str(HERE / "bench.py"),
            "--paired",
            "--old-root",
            roots[0],
            "--new-root",
            roots[1],
            *sets,
            "PreToolUse",
            "Bash",
            "ls",
        ],
        capture_output=True,
        text=True,
        env=dict(os.environ, CLAUDE_PROJECT_DIR=str(tmp_path)),
    )
    assert done.returncode == 0, done.stderr
    out = json.loads(done.stdout)
    assert out["verdict"] != "REFUSED" and out["old"]["denies"] == 0


def test_the_program_refuses_a_bad_invocation():
    for args in (["x"], ["--paired", "a", "b"], ["--paired", "--old-root"]):
        done = subprocess.run(
            [sys.executable, str(HERE / "bench.py"), *args], capture_output=True
        )
        assert done.returncode == 1
        assert b"--paired" in done.stderr
