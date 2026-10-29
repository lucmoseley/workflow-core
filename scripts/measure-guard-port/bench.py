#!/usr/bin/env python3
"""bench.py — run a set of hook commands in parallel as the harness does, N
times, and report per-call CPU, sys, minor faults and wall: the second half of
#2711's hook harness. Its paired mode is the latency gate every guard port is
read by (#2733, #3216).

  python3 scripts/measure-guard-port/hookset.py PreToolUse Bash 'ls -la' > hooks.txt
  python3 scripts/measure-guard-port/bench.py hooks.txt PreToolUse Bash 'ls -la' 15
  python3 scripts/measure-guard-port/bench.py --paired [--narrowed] [--old-root DIR] [--new-root DIR] \
      old.txt new.txt PreToolUse Bash 'ls -la'

Each call starts every command under `/bin/sh -c` at once, writes one hook
payload to each stdin, and waits for all; CPU and faults are the children's
rusage across the call. The payload's session is a fake one (`bench-2783-0000`)
whose transcript sits under `.claude/tmp/`, so no guard reads a live session.

The paired mode runs one old call and one new call back to back, in an order
a coin flip sets per pair, and reads the median of the new/old ratios for CPU
and wall with a 95% percentile bootstrap interval: PASS when
the upper bound is at most 1.03, FAIL when the lower bound is above it, else
30 more pairs up to 90 and then INCONCLUSIVE, which is never a pass. An
always-on set passes on CPU and wall; `--narrowed` (an `if`-narrowed guard)
passes on wall, CPU recorded beside it. Pairing cancels the load both calls
share, so no load is refused (#3210). The read is REFUSED when a pair's deny
counts differ, or when a hook leaves a detached child running, whose CPU the
children's rusage cannot count. `--old-root` and `--new-root` run a side from
another work tree (its `CLAUDE_PROJECT_DIR` and payload `cwd`), for a
before/after read across commits; each defaults to the host root.

Prints one JSON line, the machine state before and after beside the figures.
Exits 0 on any finished read, its verdict included, so a harness branches on
`.verdict`; 1 on a bad invocation.
"""

from __future__ import annotations

import ctypes
import json
import os
import random
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
# Untraced (#3216): the non-inferiority margin, and the batch step and cap.
MARGIN = 1.03
# 30 to start is Kalibera & Jones's and Georges et al.'s count (#3210).
FIRST, STEP, CAP = 30, 30, 90
# Duet's replicate count; Kalibera & Jones's floor is 1,000 (#3210).
RESAMPLES = 10_000
PR_SET_CHILD_SUBREAPER = 36


def tool_call(event: str, tool: str, cmd: str) -> dict:
    """The call's input, in the shape the tool's cores read their subject from,
    and on PostToolUse the answer a recorder hashes: without one the echo
    recorder stops before its work (#2787). `cmd` is the subject: a file
    tool's path, a Skill's name, a dispatch's prompt, a fetch's URL, a search's
    query; ListAgents takes none (#3176). Skill, Agent, Task and ListAgents
    dispatch no PostToolUse hook, so their answer is empty."""
    if tool == "Bash":
        given = {"command": cmd, "description": "bench"}
        answer = {
            "stdout": "bench",
            "stderr": "",
            "interrupted": False,
            "isImage": False,
        }
    elif tool == "Read":
        given = {"file_path": cmd}
        answer = {"type": "text", "file": {"filePath": cmd, "content": "bench\n"}}
    elif tool == "Edit":
        given = {"file_path": cmd, "old_string": "bench\n", "new_string": "bench\n"}
        answer = {"filePath": cmd, "oldString": "bench\n", "newString": "bench\n"}
    elif tool == "NotebookEdit":
        given = {"notebook_path": cmd, "new_source": "bench\n"}
        answer = {"notebook_path": cmd, "new_source": "bench\n"}
    elif tool == "Skill":
        given, answer = {"skill": cmd}, {}
    elif tool in ("Agent", "Task"):
        given = {
            "prompt": cmd,
            "description": "bench",
            "subagent_type": "general-purpose",
        }
        answer = {}
    elif tool == "ListAgents":
        given, answer = {}, {}
    elif tool == "WebFetch":
        given = {"url": cmd, "prompt": "bench"}
        answer = {"url": cmd, "code": 200, "codeText": "OK", "result": "bench"}
    elif tool == "WebSearch":
        given = {"query": cmd}
        answer = {"query": cmd, "results": ["bench"]}
    else:
        given = {"file_path": cmd, "content": "bench\n"}
        answer = {"type": "create", "filePath": cmd, "content": "bench\n"}
    call = {"tool_input": given}
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
    detached = reap_orphans()
    r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "wall": (t1 - t0) * 1000,
        "cpu": (r1.ru_utime - r0.ru_utime + r1.ru_stime - r0.ru_stime) * 1000,
        "sys": (r1.ru_stime - r0.ru_stime) * 1000,
        "minflt": r1.ru_minflt - r0.ru_minflt,
        "denies": denies,
        "detached": detached,
    }


def become_subreaper() -> None:
    """Make a hook's orphaned grandchildren this process's children."""
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0):
        # Without it an orphan goes to init and its CPU is lost unreported.
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER) failed")


def reap_orphans() -> int:
    """Wait for every exited orphan, and count the ones still running."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            # No child at all, so none still running (#3216).
            return 0
        if pid == 0:
            break
    me = str(os.getpid())
    running = 0
    # The real /proc, never WFC_PROC's fake: these are the bench's own
    # children (#3608).
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            stat = (d / "stat").read_text()
        except OSError:
            # The process exited between the listing and the read (#3216).
            continue
        # The command name may hold spaces; the state and ppid are the first
        # two fields after its closing parenthesis. A zombie exited after the
        # reap above and is not running.
        state, ppid = stat[stat.rindex(")") + 2 :].split()[:2]
        if ppid == me and state != "Z":
            running += 1
    return running


def summarise(calls: list[dict]) -> dict:
    med = statistics.median

    def col(k):
        return [c[k] for c in calls]

    return {
        "n": len(calls),
        "wall_ms_med": round(med(col("wall"))),
        "wall_ms_range": [round(min(col("wall"))), round(max(col("wall")))],
        "cpu_ms_med": round(med(col("cpu"))),
        "cpu_ms_range": [round(min(col("cpu"))), round(max(col("cpu")))],
        "sys_ms_med": round(med(col("sys"))),
        "minflt_med": med(col("minflt")),
        "denies": sum(col("denies")),
        "wall_ms": [round(v) for v in col("wall")],
        "cpu_ms": [round(v) for v in col("cpu")],
    }


def ci_of_median(ratios: list[float], rng: random.Random) -> tuple[float, float]:
    """The 95% percentile bootstrap interval of the median ratio. The median,
    not Duet's geometric mean, so a load spike on one call of a pair does not
    move it (#3210)."""
    meds = sorted(
        statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(RESAMPLES)
    )
    return meds[int(0.025 * RESAMPLES)], meds[int(0.975 * RESAMPLES) - 1]


def metric_verdict(ratios: list[float], rng: random.Random) -> dict:
    lo, hi = ci_of_median(ratios, rng)
    verdict = "PASS" if hi <= MARGIN else "FAIL" if lo > MARGIN else "INCONCLUSIVE"
    return {
        "verdict": verdict,
        "median": round(statistics.median(ratios), 4),
        "ci95": [round(lo, 4), round(hi, 4)],
    }


def judge_pairs(
    pairs: list[tuple[dict, dict]], narrowed: bool, rng: random.Random
) -> dict:
    out = {
        m: metric_verdict([new[m] / old[m] for old, new in pairs], rng)
        for m in ("cpu", "wall")
    }
    # #2733 gates an `if`-narrowed guard on its matching call's wait alone.
    gating = ["wall"] if narrowed else ["cpu", "wall"]
    verdicts = {out[m]["verdict"] for m in gating}
    out["verdict"] = (
        "FAIL"
        if "FAIL" in verdicts
        else "PASS"
        if verdicts == {"PASS"}
        else "INCONCLUSIVE"
    )
    return out


def refusal(pair: tuple[dict, dict]) -> str | None:
    old, new = pair
    if old["denies"] != new["denies"]:
        return f"deny counts differ: old {old['denies']}, new {new['denies']}"
    if old["detached"] or new["detached"]:
        return "a hook left a detached child running, whose CPU is not counted"
    return None


def run_paired(call_old, call_new, narrowed: bool, rng: random.Random) -> dict:
    pairs: list[tuple[dict, dict]] = []
    while True:
        for _ in range(FIRST if not pairs else STEP):
            if rng.random() < 0.5:
                old = call_old()
                new = call_new()
            else:
                new = call_new()
                old = call_old()
            pairs.append((old, new))
            why = refusal(pairs[-1])
            if why:
                return {"verdict": "REFUSED", "reason": why, "pairs": len(pairs)}
        read = judge_pairs(pairs, narrowed, rng)
        if read["verdict"] != "INCONCLUSIVE" or len(pairs) >= CAP:
            return {
                **read,
                "pairs": len(pairs),
                "old": summarise([o for o, _ in pairs]),
                "new": summarise([n for _, n in pairs]),
            }


def read_set(cmdfile: str) -> list[str]:
    with open(cmdfile) as fh:
        return [line for line in fh.read().splitlines() if line.strip()]


def side(root: str, event: str, tool: str, cmd: str) -> tuple[bytes, dict]:
    """One work tree's payload and hook environment."""
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
    return payload(root, str(transcript), event=event, tool=tool, cmd=cmd), env


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    paired = args[:1] == ["--paired"]
    narrowed = False
    roots = {"--old-root": host_root(), "--new-root": host_root()}
    if paired:
        args.pop(0)
        while args and args[0] in ("--narrowed", *roots):
            flag = args.pop(0)
            if flag == "--narrowed":
                narrowed = True
            elif args:
                roots[flag] = os.path.realpath(args.pop(0))
    if paired and len(args) == 5:
        sets = [read_set(args[0]), read_set(args[1])]
        event, tool, cmd = args[2:]
    elif not paired and len(args) == 5 and args[4].isdigit() and int(args[4]) >= 1:
        sets = [read_set(args[0])]
        event, tool, cmd, n = args[1], args[2], args[3], int(args[4])
    else:
        print(__doc__, file=sys.stderr)
        return 1
    become_subreaper()
    before = machine_state()
    if paired:
        old, new = sets
        old_root, new_root = roots["--old-root"], roots["--new-root"]
        old_body, old_env = side(old_root, event, tool, cmd)
        new_body, new_env = side(new_root, event, tool, cmd)
        out = run_paired(
            lambda: one_call(old, old_body, old_env, old_root),
            lambda: one_call(new, new_body, new_env, new_root),
            narrowed,
            random.Random(),
        )
        out["hooks"] = [len(old), len(new)]
    else:
        root = host_root()
        body, env = side(root, event, tool, cmd)
        calls = [one_call(sets[0], body, env, root) for _ in range(n)]
        out = {"hooks": len(sets[0]), **summarise(calls)}
    print(json.dumps({**out, "before": before, "after": machine_state()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
