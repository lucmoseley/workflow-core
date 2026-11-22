#!/usr/bin/env python3
from __future__ import annotations

import ctypes
import json
import os
import random
import resource
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gitop
from fail_open import expected
from host_root import host_root
from machine import machine_state

SESSION = "bench-2783-0000"
MARGIN = 1.03
FIRST, STEP, CAP = 30, 30, 90
REREAD = 720
RESAMPLES = 10_000
PR_SET_CHILD_SUBREAPER = 36
PF_EXITING = 0x4
EXIT_WAIT_S = 1.0
HOOK_CPU_CALLS = 15

USAGE = """usage:
  bench.py <hooks.txt> <event> <tool> <command> <n>
  bench.py --paired [--narrowed] [--reread] [--old-root DIR] [--new-root DIR] \\
      <old.txt> <new.txt> <event> <tool> <command>
  bench.py --paired --git <shape> [--reread] --old-root DIR --new-root DIR

Prints one JSON line. Exits 0 on any finished read, its verdict included;
1 on a bad invocation."""


def tool_call(event: str, tool: str, cmd: str) -> dict:
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
        except BrokenPipeError as e:
            expected(e, "the hook exited before reading its stdin")
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
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0):
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER) failed")


def reap_orphans() -> int:
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError as e:
            expected(e, "no child left, none running")
            return 0
        if pid == 0:
            break
    me = str(os.getpid())
    running = 0
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            stat = (d / "stat").read_text()
        except (FileNotFoundError, PermissionError, ProcessLookupError) as e:
            expected(
                e, f"pid {d.name} exited since the listing, or is not ours to read"
            )
            continue
        fields = stat[stat.rindex(")") + 2 :].split()
        if fields[1] != me:
            continue
        if (fields[0] == "Z" or int(fields[6]) & PF_EXITING) and reaped(int(d.name)):
            continue
        running += 1
    return running


def reaped(pid: int) -> bool:
    deadline = time.monotonic() + EXIT_WAIT_S
    while True:
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                return True
        except ChildProcessError as e:
            expected(e, f"pid {pid} reaped already")
            return True
        if time.monotonic() > deadline:
            return False
        time.sleep(0.005)


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
    if "exit" in old and old["exit"] != new["exit"]:
        return f"exit codes differ: old {old['exit']}, new {new['exit']}"
    if old["denies"] != new["denies"]:
        return f"deny counts differ: old {old['denies']}, new {new['denies']}"
    if old["detached"] or new["detached"]:
        return "a hook left a detached child running, whose CPU is not counted"
    return None


def run_paired(
    call_old, call_new, narrowed: bool, rng: random.Random, *, reread: bool = False
) -> dict:
    first, cap = (REREAD, REREAD) if reread else (FIRST, CAP)
    pairs: list[tuple[dict, dict]] = []
    while True:
        for _ in range(first if not pairs else STEP):
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
        if read["verdict"] != "INCONCLUSIVE" or len(pairs) >= cap:
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


def run_git_paired(shape: str, old_root: str, new_root: str, reread: bool) -> dict:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    work = tempfile.mkdtemp(prefix="bench-git-", dir=tmp_dir())
    try:
        fx = {}
        for name, root in (("old", old_root), ("new", new_root)):
            os.mkdir(os.path.join(work, name))
            fx[name] = gitop.Fixture(os.path.join(work, name), root, shape)
        last = {}

        def call(name):
            last[name] = gitop.timed_call(fx[name], reap_orphans)
            return last[name]

        out = run_paired(
            lambda: call("old"),
            lambda: call("new"),
            False,
            random.Random(),
            reread=reread,
        )
        out["exit"] = [last["old"]["exit"], last["new"]["exit"]]
        if out["verdict"] == "REFUSED":
            out["stderr"] = [last["old"]["stderr"], last["new"]["stderr"]]
        else:
            out["hook_cpu_ms"] = {
                name: gitop.hook_cpu(
                    fx[name], HOOK_CPU_CALLS, os.path.join(work, name), reap_orphans
                )
                for name in ("old", "new")
            }
        return {"shape": shape, "gated": shape not in gitop.UNGATED, **out}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def tmp_dir() -> str:
    d = os.path.join(host_root(), ".claude", "tmp")
    os.makedirs(d, exist_ok=True)
    return d


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    paired = args[:1] == ["--paired"]
    narrowed = reread = False
    shape = None
    roots = {"--old-root": host_root(), "--new-root": host_root()}
    if paired:
        args.pop(0)
        while args and args[0] in ("--narrowed", "--reread", "--git", *roots):
            flag = args.pop(0)
            if flag == "--narrowed":
                narrowed = True
            elif flag == "--reread":
                reread = True
            elif args and flag == "--git":
                shape = args.pop(0)
            elif args:
                roots[flag] = os.path.realpath(args.pop(0))
    if shape is not None:
        if args or narrowed or shape not in gitop.SHAPES:
            print(USAGE, file=sys.stderr)
            return 1
        become_subreaper()
        before = machine_state()
        out = run_git_paired(shape, roots["--old-root"], roots["--new-root"], reread)
        print(json.dumps({**out, "before": before, "after": machine_state()}))
        return 0
    if paired and len(args) == 5:
        sets = [read_set(args[0]), read_set(args[1])]
        event, tool, cmd = args[2:]
    elif not paired and len(args) == 5 and args[4].isdigit() and int(args[4]) >= 1:
        sets = [read_set(args[0])]
        event, tool, cmd, n = args[1], args[2], args[3], int(args[4])
    else:
        print(USAGE, file=sys.stderr)
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
            reread=reread,
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
