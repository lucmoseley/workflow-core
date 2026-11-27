import argparse
import csv
import os
import statistics
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


def queue_log_of(checkout):
    return os.path.join(
        checkout, ".claude", "tmp", "markers", ".suite-queue-exits.jsonl"
    )


def day_of_hour(h):
    return datetime.fromtimestamp(h * 3600, UTC).strftime("%Y-%m-%d")


def daily_by_repo(roots, start, end, repos, *, checkouts, tally):
    fg_rows = []
    blocked_s = {r: defaultdict(float) for r in repos}
    active_s = {r: defaultdict(float) for r in repos}
    for r, p in corpus.transcripts(
        roots, epoch(start), tally, subagents=False, repos=checkouts
    ):
        if r not in repos:
            continue
        fg_rows += blocked.scan_file(p, r, start, end, tally=tally)
        for row in bg_idle.scan_file(p, r, start, end, tally=tally):
            blocked_s[r][row["at"][:10]] += row["idle_s"]
        for row in active.scan_file(p, r, start, end, tally=tally):
            active_s[r][day_of_hour(row["hour"])] += row["s"]
    for row in blocked.foreground(fg_rows):
        blocked_s[row["repo"]][row["at"][:10]] += row["s"]
    return blocked_s, active_s


def pooled(by_repo):
    out = defaultdict(float)
    for days in by_repo.values():
        for d, s in days.items():
            out[d] += s
    return out


def day_rows(blocked_s, active_s):
    rows = []
    for d in sorted(set(blocked_s) | set(active_s)):
        b, act = blocked_s.get(d, 0.0) / 3600, active_s.get(d, 0.0) / 3600
        rows.append((d, b, act, b / act if act else None))
    return rows


def queue_p95(logs, start, end, tally):
    w = [r["waitS"] for g in logs for r in queue_wait.exits(g, start, end, tally)]
    return queue_wait.pct(w, 0.95), len(w)


def pct_or_dash(share):
    return f"{share:6.1%}" if share is not None else "     -"


def main():
    ap = argparse.ArgumentParser(
        description="The test-loss verification figure for any UTC window."
    )
    ap.add_argument("roots", nargs="*", help="projects dirs (default: every seat's)")
    ap.add_argument(
        "--start", required=True, help="UTC ISO window start, e.g. 2026-10-10T04:10:00Z"
    )
    ap.add_argument(
        "--end", required=True, help="UTC ISO window end, e.g. 2026-10-20T00:00:00Z"
    )
    ap.add_argument(
        "--repo",
        action="append",
        help="a checkout name to pool, repeatable, or 'all' for every adopter (default: workflow-core)",
    )
    ap.add_argument(
        "--queue-log",
        action="append",
        help="a .suite-queue-exits.jsonl to read, repeatable (default: each repo's checkout's)",
    )
    ap.add_argument("--csv", help="write the daily rows here")
    a = ap.parse_args()
    checkouts = corpus.adopter_checkouts()
    repos = sorted(checkouts) if a.repo == ["all"] else a.repo or ["workflow-core"]
    unknown = [r for r in repos if r not in checkouts]
    if unknown:
        ap.error(
            f"no adopter checkout named {', '.join(unknown)}; known: {', '.join(sorted(checkouts))}"
        )
    os.nice(19)

    tally = Counter()
    blocked_by, active_by = daily_by_repo(
        a.roots or corpus.default_roots(),
        a.start,
        a.end,
        set(repos),
        checkouts=checkouts,
        tally=tally,
    )
    blocked_s, active_s = pooled(blocked_by), pooled(active_by)
    rows = day_rows(blocked_s, active_s)
    shares = [s for *_, s in rows if s is not None]

    print(f"{' + '.join(repos)} main sessions, {a.start} to {a.end}")
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

    tried = a.queue_log or [queue_log_of(checkouts[r]) for r in repos]
    logs = [g for g in tried if os.path.exists(g)]
    if logs:
        p95, n = queue_p95(logs, a.start, a.end, tally)
        print(f"per-run queue wait p95: {p95:.0f} s over {n} exits ({', '.join(logs)})")
    else:
        print(f"per-run queue wait p95: no queue log at {', '.join(tried)}")

    if len(repos) > 1:
        print(f"  {'by repo':22}  blocked h  active h   share  median  queue p95")
        for r in repos:
            r_rows = day_rows(blocked_by[r], active_by[r])
            b = sum(x[1] for x in r_rows)
            act = sum(x[2] for x in r_rows)
            r_shares = [x[3] for x in r_rows if x[3] is not None]
            med = statistics.median(r_shares) if r_shares else None
            log = queue_log_of(checkouts[r])
            q = (
                f"{queue_p95([log], a.start, a.end, tally)[0]:.0f} s"
                if os.path.exists(log)
                else "no log"
            )
            print(
                f"  {r:22}  {b:9.2f}  {act:8.2f}  {pct_or_dash(b / act if act else None)}  {pct_or_dash(med)}  {q:>9}"
            )
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
