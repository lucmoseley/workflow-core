#!/usr/bin/env python3
"""bench_agents_oracle.py — price `claude agents --json` as a per-turn-end cost (mantahostels#653, map mantahostels#632).

Samples the session oracle under this machine's real concurrent session load
and reports a distribution, not a single reading. Deliberately modest: tens of
calls, spaced, so the harness does not become the load it measures.

Per sample it records:
  * wall-clock latency of `claude agents --json`
  * the caller's peak RSS (the CLI is a fresh Node process, not a thin client)
  * the session count the oracle itself reported, and a process-count census
  * the daemon's RSS and cumulative CPU either side of the call

Usage: bench_agents_oracle.py [n_samples] [gap_seconds]
"""

import json
import os
import re
import resource
import statistics
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from wfc_bin import bin_path

# Samples, and seconds between them. Both are guesses at "tens of calls, spaced":
# the call rate at which the bench itself loads the machine was never measured.
N = int(sys.argv[1]) if len(sys.argv) > 1 else 30
GAP = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0

CLK = os.sysconf("SC_CLK_TCK")
PAGE = resource.getpagesize()


def find_daemon():
    """The daemon is the `claude daemon run` process. Match on argv[0]+args,
    never `comm` -- comm is the version string for a versioned binary."""
    out = subprocess.run(
        [bin_path("ps"), "-eo", "pid,args", "--no-headers"],
        capture_output=True,
        text=True,
    ).stdout
    for line in out.splitlines():
        pid, _, args = line.strip().partition(" ")
        if "daemon run" in args and re.search(r"(^|/)claude(\.exe)? ", args + " "):
            return int(pid)
    return None


def proc_stat(pid):
    """(rss_kb, cpu_seconds) for a pid, or None if it has gone — the row then
    carries a null daemon reading, which the summary counts (#1274)."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            raw = fh.read()
        # comm can contain spaces/parens; split after the final ')'
        fields = raw[raw.rindex(")") + 2 :].split()
        utime, stime = int(fields[11]), int(fields[12])
        rss_pages = int(fields[21])
        return rss_pages * PAGE // 1024, (utime + stime) / CLK
    except (OSError, ValueError):
        return None


CLAUDE_ARGV0 = re.compile(
    r"^(?:\S*/)?claude(?:\.exe)?$"  # `claude`, `claude.exe`, `/path/bin/claude`
    r"|^\S*/claude/versions/\S+$"  # the bare versioned binary a RESUMED session runs
)


def session_process_census():
    """Count claude processes by argv[0] in all three spellings."""
    out = subprocess.run(
        [bin_path("ps"), "-eo", "pid,args", "--no-headers"],
        capture_output=True,
        text=True,
    ).stdout
    pty_hosts = spares = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        argv0 = parts[1]
        if not CLAUDE_ARGV0.match(argv0):
            continue
        if "bg-pty-host" in line:
            pty_hosts += 1
        elif "bg-spare" in line or "--resume" in line:
            spares += 1
    return pty_hosts, spares


def meminfo_available_kb():
    with open("/proc/meminfo") as fh:
        for line in fh:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1])
    return None


def time_meminfo(reps=2000):
    """Cost of option (B)'s pre-gate on its own: one MemAvailable read.

    `reps` is a guess, enough reads for the timer's resolution to vanish."""
    t0 = time.perf_counter()
    for _ in range(reps):
        meminfo_available_kb()
    return (time.perf_counter() - t0) / reps


def main():
    daemon = find_daemon()
    print(f"# daemon pid: {daemon}", file=sys.stderr)

    # (B) pre-gate, measured before the oracle sampling perturbs anything.
    pregate_s = time_meminfo()
    print(
        f"# /proc/meminfo MemAvailable read: {pregate_s * 1e6:.1f} us", file=sys.stderr
    )

    claude = bin_path("claude")
    rows = []
    for i in range(N):
        d_before = proc_stat(daemon) if daemon else None
        pty, spare = session_process_census()
        rusage_before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss

        t0 = time.perf_counter()
        proc = subprocess.run(
            [claude, "agents", "--json"], capture_output=True, text=True
        )
        wall = time.perf_counter() - t0

        rusage_after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        d_after = proc_stat(daemon) if daemon else None

        try:
            n_sessions = len(json.loads(proc.stdout))
        except (ValueError, TypeError):
            # A failed call is still a latency sample; -1 marks it and the
            # summary counts it (#1274).
            n_sessions = -1

        rows.append(
            {
                "i": i,
                "wall_s": round(wall, 4),
                "rc": proc.returncode,
                "sessions": n_sessions,
                "pty_hosts": pty,
                "spares": spare,
                "mem_avail_mb": meminfo_available_kb() // 1024,
                "daemon_rss_kb": d_after[0] if d_after else None,
                "daemon_cpu_delta_s": round(d_after[1] - d_before[1], 3)
                if d_before and d_after
                else None,
                "caller_peak_rss_kb": max(rusage_after - rusage_before, 0)
                or rusage_after,
            }
        )
        print(json.dumps(rows[-1]), flush=True)
        if i < N - 1:
            time.sleep(GAP)

    walls = sorted(r["wall_s"] for r in rows)

    def pct(p):
        return walls[min(len(walls) - 1, int(round(p * (len(walls) - 1))))]

    summary = {
        "n": len(walls),
        "pregate_meminfo_us": round(pregate_s * 1e6, 1),
        "wall_min_s": walls[0],
        "wall_median_s": round(statistics.median(walls), 4),
        "wall_p90_s": pct(0.90),
        "wall_max_s": walls[-1],
        "wall_mean_s": round(statistics.fmean(walls), 4),
        "sessions_min": min(r["sessions"] for r in rows),
        "sessions_max": max(r["sessions"] for r in rows),
        "daemon_cpu_total_s": round(sum(r["daemon_cpu_delta_s"] or 0 for r in rows), 3),
        "oracle_unparsed": sum(r["sessions"] == -1 for r in rows),
        "daemon_unread": sum(r["daemon_cpu_delta_s"] is None for r in rows),
        "daemon_rss_first_kb": rows[0]["daemon_rss_kb"],
        "daemon_rss_last_kb": rows[-1]["daemon_rss_kb"],
    }
    print("SUMMARY " + json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
