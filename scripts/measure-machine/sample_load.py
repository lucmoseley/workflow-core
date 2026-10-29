#!/usr/bin/env python3
"""sample_load.py — sample CPU, load, headroom and session count while the machine works.

The other half of mantahostels#1127's measurement. `scan_machine.py` reads history off
disk; nothing on this machine records CPU at all, so the only way to answer
"do the cores ever bind?" is to watch while real work runs.

Run it *alongside* whatever load is being judged — it starts nothing itself, so
a run against an idle machine measures an idle machine.

**CPU is read as a delta between two `/proc/stat` reads, never as a sampled
per-process figure**, which under-reports by 4-7x (docs/environment.md §6). The
first sample therefore has no CPU figure and is dropped.

Sessions are counted by lib/claude_sessions.py, docs/environment.md §5's unit:
`bg-pty-host` processes matched on `argv[0]`, less the daemon's unclaimed spare
(#1798). That count misses an interactively-driven terminal session, which
spawns no such process, so it is a floor; the process count beside it is the
check.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from claude_sessions import PS_ARGS, count_sessions, is_claude, live_cwd, parse_ps
from wfc_bin import bin_path

# The real /proc, never WFC_PROC's fake, here and for load1: the sampler
# measures this machine (#3608).
MEMINFO = "/proc/meminfo"
STAT = "/proc/stat"


def cpu_totals(path: str = STAT) -> tuple[int, int]:
    """(busy, total) jiffies from /proc/stat's aggregate line.

    Only the first four fields are used — user, nice, system, idle. `iowait`
    and the rest are deliberately excluded: a process blocked on disk is not a
    process the cores are refusing to run, and folding it in reads as CPU
    pressure that no extra core would relieve.
    """
    with open(path) as fh:
        fields = fh.readline().split()
    user, nice, system, idle = (int(x) for x in fields[1:5])
    busy = user + nice + system
    return busy, busy + idle


def available_mb(path: str = MEMINFO) -> int | None:
    """MemAvailable in MB, or None where the file will not say — the row then
    prints None in that column, which is the report saying so (#1274).

    MemAvailable, never MemFree — MemFree counts reclaimable page cache as
    spent and reads catastrophically low on a machine that is fine.
    """
    try:
        with open(path) as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        return None
    return None


def count_claude(ps_output: str, cwd_of=live_cwd) -> tuple[int, int]:
    """(sessions, processes) from the output of `ps -eo pid=,ppid=,args=`."""
    rows = parse_ps(ps_output)
    return count_sessions(rows, cwd_of), sum(is_claude(argv[0]) for _, _, argv in rows)


def ps_snapshot() -> str:
    """`ps -eo pid=,ppid=,args=`, or "" where ps fails — never its output on success, so
    `main` counts it as a failed snapshot (#1274)."""
    try:
        # A guess, never measured: a ps that has not answered in 10 s is wedged.
        return subprocess.run(
            [bin_path("ps"), *PS_ARGS], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    # Both guesses, never measured: 72 samples, one every 10 s.
    ap.add_argument("--seconds", type=int, default=720, help="how long to sample")
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
