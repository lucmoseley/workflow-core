"""Pins report.py's daily blocked share on a synthetic transcript tree: which test calls count
as blocked (#2812's rules), what counts as active time (#2821's), and the UTC day each lands on.
Breaking it lets the verification figure drift from those rules unseen.

Each test writes its own projects dir, so nothing here reads the real corpus."""

import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import report  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)

START, END = "2026-10-10T00:00:00Z", "2026-10-12T00:00:00Z"


def daily(roots):
    return report.daily(roots, START, END, "wfc", tally=Counter())


def bash(t, tid, command, background=False):
    inp = {"command": command, "run_in_background": background}
    return {
        "type": "assistant",
        "timestamp": t,
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": tid, "name": "Bash", "input": inp}],
        },
    }


def result(t, tid, moved=False):
    r = {
        "type": "user",
        "timestamp": t,
        "message": {"content": [{"type": "tool_result", "tool_use_id": tid}]},
    }
    if moved:
        r["toolUseResult"] = {"backgroundTaskId": "b1"}
    return r


def assistant(t):
    return {
        "type": "assistant",
        "timestamp": t,
        "message": {"role": "assistant", "content": [{"type": "text"}]},
    }


def notice(t, tid):
    text = f"<task-notification><tool-use-id>{tid}</tool-use-id></task-notification>"
    return {"type": "user", "timestamp": t, "message": {"content": text}}


def prompt(t):
    return {"type": "user", "timestamp": t, "message": {"content": "carry on"}}


def tree(tmp_path, records, project="-home-x-workflow-core", name="s1.jsonl"):
    d = tmp_path / project
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(
        "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in records)
    )
    return [str(tmp_path)]


def test_foreground_test_call_is_blocked_for_its_duration(tmp_path):
    roots = tree(
        tmp_path,
        [
            assistant("2026-10-10T10:00:00Z"),
            bash("2026-10-10T10:01:00Z", "t1", "npm run test -- a.test.ts"),
            result("2026-10-10T10:02:00Z", "t1"),
        ],
    )
    blocked, active = daily(roots)
    assert blocked == {"2026-10-10": 60.0}
    assert active == {"2026-10-10": 120.0}


def test_non_test_command_and_the_other_repo_are_not_counted(tmp_path):
    tree(
        tmp_path,
        [
            bash("2026-10-10T10:01:00Z", "t1", "git status"),
            result("2026-10-10T10:02:00Z", "t1"),
        ],
    )
    roots = tree(
        tmp_path,
        [
            bash("2026-10-10T10:01:00Z", "t2", "npm test"),
            result("2026-10-10T10:03:00Z", "t2"),
        ],
        project="-home-x-mantahostels",
    )
    blocked, _ = daily(roots)
    assert sum(blocked.values()) == 0


def test_foreground_call_over_the_cap_is_left_out(tmp_path):
    roots = tree(
        tmp_path,
        [
            bash("2026-10-10T10:00:00Z", "t1", "npm run test"),
            result("2026-10-10T10:40:00Z", "t1"),
        ],
    )
    blocked, active = daily(roots)
    assert sum(blocked.values()) == 0
    assert active == {"2026-10-10": 1800.0}


def test_background_run_counts_the_idle_after_the_last_assistant_line(tmp_path):
    roots = tree(
        tmp_path,
        [
            bash("2026-10-10T10:00:00Z", "t1", "npm run test", background=True),
            assistant("2026-10-10T10:00:30Z"),
            notice("2026-10-10T10:05:30Z", "t1"),
        ],
    )
    blocked, _ = daily(roots)
    assert blocked == {"2026-10-10": 300.0}


def test_gap_ending_in_a_typed_prompt_is_not_active(tmp_path):
    roots = tree(
        tmp_path,
        [
            assistant("2026-10-10T10:00:00Z"),
            prompt("2026-10-10T10:20:00Z"),
            assistant("2026-10-10T10:21:00Z"),
        ],
    )
    _, active = daily(roots)
    assert active == {"2026-10-10": 60.0}


def test_subagent_transcripts_are_not_read(tmp_path):
    roots = tree(
        tmp_path,
        [
            bash("2026-10-10T10:01:00Z", "t1", "npm run test"),
            result("2026-10-10T10:02:00Z", "t1"),
        ],
        project="-home-x-workflow-core/s1/subagents",
        name="agent-a.jsonl",
    )
    blocked, active = daily(roots)
    assert blocked == {} and active == {}


def test_rows_land_on_the_utc_day_of_launch_and_outside_the_window_drop(tmp_path):
    roots = tree(
        tmp_path,
        [
            bash("2026-10-10T23:59:30Z", "t1", "npm run test"),
            result("2026-10-11T00:00:30Z", "t1"),
            bash("2026-10-12T10:00:00Z", "t2", "npm run test"),
            result("2026-10-12T10:01:00Z", "t2"),
        ],
    )
    blocked, active = daily(roots)
    assert blocked == {"2026-10-10": 60.0}
    assert active == {"2026-10-11": 60.0}


def test_foreground_run_moved_to_background_counts_its_idle_from_the_move(tmp_path):
    roots = tree(
        tmp_path,
        [
            bash("2026-10-10T10:00:00Z", "t1", "npm run test"),
            result("2026-10-10T10:10:00Z", "t1", moved=True),
            assistant("2026-10-10T10:10:10Z"),
            notice("2026-10-10T10:12:10Z", "t1"),
        ],
    )
    blocked, _ = daily(roots)
    assert blocked == {"2026-10-10": 600.0 + 120.0}
