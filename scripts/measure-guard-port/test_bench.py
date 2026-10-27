"""Pins bench.py's per-call figures and deny count, the latency gate an
always-on guard port must not worsen (#2733, #2783).

`one_call` runs real `/bin/sh` commands, since the parallel start and the
children's rusage are what it measures.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from bench import one_call, payload, summarise

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


def test_summarise_takes_medians_and_ranges():
    calls = [
        {"wall": w, "cpu": c, "sys": s, "minflt": f, "denies": 0}
        for w, c, s, f in [
            (10, 100, 30, 1000),
            (30, 300, 50, 3000),
            (20, 200, 40, 2000),
        ]
    ]
    out = summarise(calls, 16)
    assert out["hooks"] == 16
    assert out["n"] == 3
    assert out["wall_ms_med"] == 20
    assert out["wall_ms_range"] == [10, 30]
    assert out["cpu_ms_med"] == 200
    assert out["sys_ms_med"] == 40
    assert out["minflt_med"] == 2000


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


def test_the_program_refuses_a_bad_invocation():
    done = subprocess.run(
        [sys.executable, str(HERE / "bench.py"), "x"], capture_output=True
    )
    assert done.returncode == 1
