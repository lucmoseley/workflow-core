#!/usr/bin/env python3

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from claude_sessions import PS_ARGS, count_sessions, is_claude, live_cwd, parse_ps
from fail_open import fail_open
from wfc_bin import bin_path

MEMINFO = "/proc/meminfo"
STAT = "/proc/stat"
# guess, lucmoseley/mantahostels#1127
PS_TIMEOUT_S = 10


def cpu_totals(path: str = STAT) -> tuple[int, int]:
    with open(path) as fh:
        fields = fh.readline().split()
    user, nice, system, idle = (int(x) for x in fields[1:5])
    busy = user + nice + system
    return busy, busy + idle


def available_mb(path: str = MEMINFO) -> int | None:
    try:
        with open(path) as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError as e:
        fail_open(e, f"{path} MemAvailable read as None")
        return None
    return None


def count_claude(ps_output: str, cwd_of=live_cwd) -> tuple[int, int]:
    rows = parse_ps(ps_output)
    return count_sessions(rows, cwd_of), sum(is_claude(argv[0]) for _, _, argv in rows)


def ps_snapshot() -> str:
    try:
        return subprocess.run(
            [bin_path("ps"), *PS_ARGS],
            capture_output=True,
            text=True,
            timeout=PS_TIMEOUT_S,
        ).stdout
    except (OSError, subprocess.SubprocessError) as e:
        fail_open(e, "ps snapshot read as empty")
        return ""


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Sample CPU, load, headroom and session count while the machine works."
    )
    # guess, lucmoseley/mantahostels#1127
    ap.add_argument("--seconds", type=int, default=720, help="how long to sample")
    # guess, lucmoseley/mantahostels#1127
    ap.add_argument("--interval", type=int, default=10)
    args = ap.parse_args()

    print("ts\tload1\tavail_mb\tsessions\tprocs\tcpu_busy_pct")
    prev = cpu_totals()
    deadline = time.time() + args.seconds
    samples = []
    ps_failed = 0
    while time.time() < deadline:
        time.sleep(args.interval)
        now = cpu_totals()
        d_busy, d_total = now[0] - prev[0], now[1] - prev[1]
        prev = now
        pct = (100.0 * d_busy / d_total) if d_total > 0 else 0.0
        with open("/proc/loadavg") as fh:
            load1 = fh.read().split()[0]
        snapshot = ps_snapshot()
        ps_failed += not snapshot
        sessions, procs = count_claude(snapshot)
        samples.append(pct)
        print(
            f"{time.strftime('%H:%M:%S')}\t{load1}\t{available_mb()}\t"
            f"{sessions}\t{procs}\t{pct:.1f}"
        )
        sys.stdout.flush()

    if samples:
        ordered = sorted(samples)
        n = len(ordered)
        print(
            f"\n# n={n} cpu busy: median={ordered[n // 2]:.1f}% "
            f"p90={ordered[min(n - 1, int(n * 0.9))]:.1f}% max={max(ordered):.1f}% "
            f"of the 100% all-core ceiling; samples over 80%: "
            f"{sum(1 for x in ordered if x > 80)}; ps failures, read as 0 "
            f"sessions: {ps_failed}"
        )


if __name__ == "__main__":
    main()
