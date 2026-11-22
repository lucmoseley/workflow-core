#!/usr/bin/env python3

import json
import os
import re
import resource
import statistics
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from fail_open import expected, fail_open, tallied
from wfc_bin import bin_path

# guess, origin untraced, #5550
N = int(sys.argv[1]) if len(sys.argv) > 1 else 30
# guess, origin untraced, #5550
GAP = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0

CLK = os.sysconf("SC_CLK_TCK")
PAGE = resource.getpagesize()
ORACLE_UNPARSED = "oracle_unparsed"


def find_daemon():
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
    try:
        with open(f"/proc/{pid}/stat") as fh:
            raw = fh.read()
        fields = raw[raw.rindex(")") + 2 :].split()
        utime, stime = int(fields[11]), int(fields[12])
        rss_pages = int(fields[21])
        return rss_pages * PAGE // 1024, (utime + stime) / CLK
    except (FileNotFoundError, ProcessLookupError) as e:
        expected(e, f"pid {pid} gone")
        return None
    except (OSError, ValueError) as e:
        fail_open(e, f"pid {pid} read as gone")
        return None


CLAUDE_ARGV0 = re.compile(
    r"^(?:\S*/)?claude(?:\.exe)?$"
    r"|^\S*/claude/versions/\S+$"
)


def session_process_census():
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


def oracle_sessions(stdout, tally):
    try:
        return len(json.loads(stdout))
    except (ValueError, TypeError) as e:
        tallied(e, tally, ORACLE_UNPARSED)
        return -1


def meminfo_available_kb():
    with open("/proc/meminfo") as fh:
        for line in fh:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1])
    return None


def time_meminfo(reps=2000):
    t0 = time.perf_counter()
    for _ in range(reps):
        meminfo_available_kb()
    return (time.perf_counter() - t0) / reps


def main():
    daemon = find_daemon()
    print(f"# daemon pid: {daemon}", file=sys.stderr)

    pregate_s = time_meminfo()
    print(
        f"# /proc/meminfo MemAvailable read: {pregate_s * 1e6:.1f} us", file=sys.stderr
    )

    claude = bin_path("claude")
    rows = []
    tally = Counter()
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

        n_sessions = oracle_sessions(proc.stdout, tally)

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
        ORACLE_UNPARSED: tally[ORACLE_UNPARSED],
        "daemon_unread": sum(r["daemon_cpu_delta_s"] is None for r in rows),
        "daemon_rss_first_kb": rows[0]["daemon_rss_kb"],
        "daemon_rss_last_kb": rows[-1]["daemon_rss_kb"],
    }
    print("SUMMARY " + json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
