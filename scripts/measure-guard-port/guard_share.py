#!/usr/bin/env python3
"""guard_share.py — the guard-run share of a test file's time, the instrument
every guard port is judged by (#2202, #2733, #2783).

Guard-run share = (sum of the wall of the test file's guard calls) / (the file's
"tests" time from vitest's summary), both from ONE run. `preload.js` wraps the
fork worker's child_process calls and logs each call's program, first arguments
and wall; this script launches the run and sums the log.

A guard call is one whose program is a `*.sh` file, or `bash`/`sh` running a
script, a `source`, or a `pipefail` preamble. The test's own git calls (fixture
work) are their own class: a Node core removes none of them. A port's cut is
read on this share of its own test files, never on CI wall (#2202).

  python3 scripts/measure-guard-port/guard_share.py run <test-file> [...]
  python3 scripts/measure-guard-port/guard_share.py sum <call-log> <vitest-output>

`run` prints one JSON line per file, the machine state before and after beside
it, and keeps the call log and vitest output under `--keep`. It runs vitest under `npm run test`'s 2048 MB heap.

Exit 0; 1 where a run failed or its log carries no `start` record (the preload
never loaded), since either would read as a share near 0 — a finished port's
figure.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_root import host_root
from machine import machine_state

PRELOAD = Path(__file__).resolve().parent / "preload.js"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def classify(call: dict) -> str:
    file = call["file"]
    args = " ".join(call["args"])
    base = file.split("/")[-1]
    if file.endswith(".sh"):
        return "guard-sh"
    if base in ("bash", "sh"):
        if ".sh" in args or "source" in args or "pipefail" in args:
            return "guard-sh"
        return "bash-other"
    if base == "git":
        return "git"
    if base == "node":
        return "node"
    return "other:" + base


def vitest_tests_seconds(vitest_text: str) -> float:
    """The "tests" figure of vitest's Duration line, in seconds."""
    m = re.search(r"tests ([0-9.]+)(m?s)", ANSI.sub("", vitest_text))
    if not m:
        return float("nan")
    return float(m.group(1)) / (1000 if m.group(2) == "ms" else 1)


def percentile(sorted_ms: list[float], q: float) -> float:
    if not sorted_ms:
        return float("nan")
    return sorted_ms[min(len(sorted_ms) - 1, int(q * len(sorted_ms)))]


def summarise(calls: list[dict], vitest_text: str) -> dict:
    m = re.search(r"Tests\s+(.*)", ANSI.sub("", vitest_text))
    tests_s = vitest_tests_seconds(vitest_text)
    count = collections.Counter()
    total_ms = collections.Counter()
    guard_ms = []
    for call in calls:
        if "ms" not in call:
            continue
        cls = classify(call)
        count[cls] += 1
        total_ms[cls] += call["ms"]
        if cls == "guard-sh":
            guard_ms.append(call["ms"])
    guard_ms.sort()
    return {
        "instrumented": any(c.get("kind") == "start" for c in calls),
        "tests": m.group(1).strip() if m else "?",
        "tests_s": round(tests_s, 2),
        "counts": dict(count),
        "sum_s": {k: round(v / 1000, 2) for k, v in total_ms.items()},
        "guard_runs": count["guard-sh"],
        "guard_ms_p10": round(percentile(guard_ms, 0.1), 1),
        "guard_ms_p50": round(percentile(guard_ms, 0.5), 1),
        "guard_ms_p90": round(percentile(guard_ms, 0.9), 1),
        "guard_share": round(total_ms["guard-sh"] / 1000 / tests_s, 3),
        "all_spawn_share": round(sum(total_ms.values()) / 1000 / tests_s, 3),
    }


def read_log(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def run_one(test_file: str, keep: Path, root: str) -> dict:
    stem = re.sub(r"[^\w.-]", "_", test_file) + f"-{int(time.time())}"
    log, out = keep / f"{stem}.calls.jsonl", keep / f"{stem}.vitest.txt"
    before = machine_state()
    env = dict(
        os.environ,
        WFC_GUARD_SHARE_OUT=str(log),
        NODE_OPTIONS=f"--max-old-space-size=2048 --require {PRELOAD}",
    )
    env.pop("WFC_GUARD_SHARE_DEPTH", None)
    done = subprocess.run(
        ["node", "scripts/run-vitest.js", test_file],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
    )
    after = machine_state()
    out.write_text(done.stdout + done.stderr)
    return {
        "file": test_file,
        "vitest_exit": done.returncode,
        **summarise(read_log(log), done.stdout + done.stderr),
        "before": before,
        "after": after,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser(
        "run", help="run each test file once under the preload and sum it"
    )
    r.add_argument("files", nargs="+")
    r.add_argument("--keep", default=None, help="where the raw logs go")
    s = sub.add_parser("sum", help="sum a call log already taken")
    s.add_argument("log")
    s.add_argument("vitest_output")
    args = ap.parse_args(argv)
    if args.cmd == "sum":
        with open(args.vitest_output) as fh:
            text = fh.read()
        result = summarise(read_log(Path(args.log)), text)
        print(json.dumps(result))
        return 0 if result["instrumented"] else 1
    root = host_root()
    keep = Path(args.keep or os.path.join(root, ".claude/tmp/guard-share"))
    keep.mkdir(parents=True, exist_ok=True)
    code = 0
    for f in args.files:
        result = run_one(f, keep, root)
        print(json.dumps(result), flush=True)
        if result["vitest_exit"] != 0 or not result["instrumented"]:
            print(
                f"{f}: no reading — vitest exit {result['vitest_exit']}, "
                f"preload {'loaded' if result['instrumented'] else 'never loaded'}",
                file=sys.stderr,
            )
            code = 1
    return code


if __name__ == "__main__":
    sys.exit(main())
