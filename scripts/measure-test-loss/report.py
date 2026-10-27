"""The test-loss verification figure for any UTC window (#2821, the ruling that set it).
Usage: python3 -I report.py --start ISO --end ISO [--repo wfc|mh] [--queue-log PATH] [--csv PATH]
       [<projects-dir>...]

Counting rules: #2812 (the baseline)'s and #2821's, unchanged. Per UTC day, and over the window:
  blocked  main-session foreground test calls (blocked.foreground) plus idle on background runs
           (bg_idle.py), counted at the call's launch
  active   main-session active time (active.py), counted where each gap ends
  share    blocked / active; the verdict is the median of the daily shares
Beside it, the per-run p95 queue wait (queue_wait.py's per-exit p95) from the queue log, which
holds the canonical checkout's waits alone. A day with no active time is shown and left out of
the median; a day the window cuts is counted over the part inside it.

Reads main-session transcripts only (corpus.py), as text; runs at nice 19 and runs no tests.
Skipped files and lines are counted on stderr."""

import argparse
import csv
import os
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import UTC, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
)
import active
import bg_idle
import blocked
import corpus
import queue_wait
from corpus import epoch
from host_root import host_root


def default_queue_log():
    common = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=host_root(),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return os.path.join(
        os.path.dirname(common), ".claude", "tmp", "markers", ".suite-queue-exits.jsonl"
    )


def day_of_hour(h):
    return datetime.fromtimestamp(h * 3600, UTC).strftime("%Y-%m-%d")


def daily(roots, start, end, repo, *, tally):
    """({day: blocked s}, {day: active s}) for one repo's main sessions."""
    fg_rows = []
    blocked_s = defaultdict(float)
    active_s = defaultdict(float)
    for r, p in corpus.transcripts(roots, epoch(start), tally, subagents=False):
        if r != repo:
            continue
        fg_rows += blocked.scan_file(p, r, start, end, tally=tally)
        for row in bg_idle.scan_file(p, r, start, end, tally=tally):
            blocked_s[row["at"][:10]] += row["idle_s"]
        for row in active.scan_file(p, r, start, end, tally=tally):
            active_s[day_of_hour(row["hour"])] += row["s"]
    for row in blocked.foreground(fg_rows):
        blocked_s[row["at"][:10]] += row["s"]
    return blocked_s, active_s


def pct_or_dash(share):
    return f"{share:6.1%}" if share is not None else "     -"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("roots", nargs="*", help="projects dirs (default: every seat's)")
    ap.add_argument(
        "--start", required=True, help="UTC ISO window start, e.g. 2026-10-10T04:10:00Z"
    )
    ap.add_argument(
        "--end", required=True, help="UTC ISO window end, e.g. 2026-10-20T00:00:00Z"
    )
    ap.add_argument("--repo", choices=("wfc", "mh"), default="wfc")
    ap.add_argument(
        "--queue-log",
        help="the .suite-queue-exits.jsonl to read (default: the canonical checkout's)",
    )
    ap.add_argument("--csv", help="write the daily rows here")
    a = ap.parse_args()
    os.nice(19)

    tally = Counter()
    blocked_s, active_s = daily(
        a.roots or corpus.default_roots(), a.start, a.end, a.repo, tally=tally
    )
    days = sorted(set(blocked_s) | set(active_s))
    rows = []
    for d in days:
        b, act = blocked_s[d] / 3600, active_s[d] / 3600
        rows.append((d, b, act, b / act if act else None))
    shares = [s for *_, s in rows if s is not None]

    print(f"{a.repo} main sessions, {a.start} to {a.end}")
    print("  day         blocked h  active h  share")
    for d, b, act, share in rows:
        print(f"  {d}  {b:9.2f}  {act:8.2f}  {pct_or_dash(share)}")
    b_tot, a_tot = sum(blocked_s.values()) / 3600, sum(active_s.values()) / 3600
    print(
        f"blocked {b_tot:.2f} h; active {a_tot:.2f} h; window share {pct_or_dash(b_tot / a_tot if a_tot else None).strip()}"
    )
    print(
        f"median daily blocked share: {statistics.median(shares):.1%} over {len(shares)} days"
        if shares
        else "median daily blocked share: no active days"
    )

    log = a.queue_log or default_queue_log()
    if os.path.exists(log):
        w = [r["waitS"] for r in queue_wait.exits(log, a.start, a.end, tally)]
        print(
            f"per-run queue wait p95: {queue_wait.pct(w, 0.95):.0f} s over {len(w)} exits ({log})"
        )
    else:
        print(f"per-run queue wait p95: no queue log at {log}")
    print("skipped:", corpus.counts_line(tally), file=sys.stderr)

    if a.csv:
        with open(a.csv, "w", newline="") as f:
            out = csv.writer(f)
            out.writerow(["day", "blocked_h", "active_h", "share"])
            for d, b, act, share in rows:
                out.writerow(
                    [
                        d,
                        f"{b:.4f}",
                        f"{act:.4f}",
                        "" if share is None else f"{share:.4f}",
                    ]
                )


if __name__ == "__main__":
    main()
