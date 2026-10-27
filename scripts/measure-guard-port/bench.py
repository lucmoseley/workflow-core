#!/usr/bin/env python3
"""bench.py — run a set of hook commands in parallel as the harness does, N
times, and report per-call CPU, sys, minor faults and wall: the second half of
#2711's hook harness, and the latency gate every always-on guard port is read
by (#2733, #2783).

  python3 scripts/measure-guard-port/hookset.py PreToolUse Bash 'ls -la' > hooks.txt
  python3 scripts/measure-guard-port/bench.py hooks.txt PreToolUse Bash 'ls -la' 15

Each call starts every command under `/bin/sh -c` at once, writes one hook
payload to each stdin, and waits for all; CPU and faults are the children's
rusage across the call. The payload's session is a fake one (`bench-2783-0000`)
whose transcript sits under `.claude/tmp/`, so no guard reads a live session.

Prints one JSON line, the machine state before and after beside the figures.
Read the gate quiet: a figure taken at a high load1 measures the neighbours too.
"""

from __future__ import annotations

import json
import os
import resource
import statistics
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_root import host_root
from machine import machine_state

SESSION = "bench-2783-0000"


def tool_call(event: str, tool: str, cmd: str) -> dict:
    """The call's input, and on PostToolUse the answer a recorder hashes:
    without one the echo recorder stops before its work (#2787). For a file
    tool, `cmd` is the file's path."""
    if tool == "Bash":
        call = {"tool_input": {"command": cmd, "description": "bench"}}
        answer = {
            "stdout": "bench",
            "stderr": "",
            "interrupted": False,
            "isImage": False,
        }
    elif tool == "Read":
        call = {"tool_input": {"file_path": cmd}}
        answer = {"type": "text", "file": {"filePath": cmd, "content": "bench\n"}}
    else:
        call = {"tool_input": {"file_path": cmd, "content": "bench\n"}}
        answer = {"type": "create", "filePath": cmd, "content": "bench\n"}
    if event == "PostToolUse":
        call["tool_response"] = answer
    return call


def payload(root: str, transcript: str, *, event: str, tool: str, cmd: str) -> bytes:
    return json.dumps(
        {
            "session_id": SESSION,
            "transcript_path": transcript,
            "cwd": root,
            "permission_mode": "auto",
            "hook_event_name": event,
            "tool_name": tool,
            **tool_call(event, tool, cmd),
            "tool_use_id": "toolu_bench",
        }
    ).encode()


def one_call(cmds: list[str], body: bytes, env: dict, root: str) -> dict:
    r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.monotonic()
    ps = [
        subprocess.Popen(
            ["/bin/sh", "-c", c],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=root,
        )
        for c in cmds
    ]
    for p in ps:
        try:
            p.stdin.write(body)
            p.stdin.close()
        except BrokenPipeError:
            # A hook that exits without reading its stdin is still a hook run;
            # its exit and output are read below like any other (#2783).
            pass
        # Closed already: communicate() would flush it again.
        p.stdin = None
    denies = 0
    for p in ps:
        o, _ = p.communicate()
        if p.returncode == 2 or b'"deny"' in o:
            denies += 1
    t1 = time.monotonic()
    r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "wall": (t1 - t0) * 1000,
        "cpu": (r1.ru_utime - r0.ru_utime + r1.ru_stime - r0.ru_stime) * 1000,
        "sys": (r1.ru_stime - r0.ru_stime) * 1000,
        "minflt": r1.ru_minflt - r0.ru_minflt,
        "denies": denies,
    }


def summarise(calls: list[dict], hooks: int) -> dict:
    med = statistics.median

    def col(k):
        return [c[k] for c in calls]

    return {
        "hooks": hooks,
        "n": len(calls),
        "wall_ms_med": round(med(col("wall"))),
        "wall_ms_range": [round(min(col("wall"))), round(max(col("wall")))],
        "cpu_ms_med": round(med(col("cpu"))),
        "cpu_ms_range": [round(min(col("cpu"))), round(max(col("cpu")))],
        "sys_ms_med": round(med(col("sys"))),
        "minflt_med": med(col("minflt")),
        "denies": sum(col("denies")),
    }


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 5 or not args[4].isdigit() or int(args[4]) < 1:
        print(__doc__, file=sys.stderr)
        return 1
    cmdfile, event, tool, cmd, n = args[0], args[1], args[2], args[3], int(args[4])
    with open(cmdfile) as fh:
        cmds = [line for line in fh.read().splitlines() if line.strip()]
    root = host_root()
    tdir = Path(root, ".claude", "tmp", SESSION)
    tdir.mkdir(parents=True, exist_ok=True)
    transcript = tdir / "t.jsonl"
    transcript.touch()
    env = dict(
        os.environ,
        CLAUDE_PROJECT_DIR=root,
        CLAUDE_PLUGIN_ROOT=os.environ.get("CLAUDE_PLUGIN_ROOT")
        or os.path.join(root, "self-plugin"),
    )
    body = payload(root, str(transcript), event=event, tool=tool, cmd=cmd)
    before = machine_state()
    calls = [one_call(cmds, body, env, root) for _ in range(n)]
    after = machine_state()
    print(json.dumps({**summarise(calls, len(cmds)), "before": before, "after": after}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
