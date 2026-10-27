"""Queue wait from .suite-queue-exits.jsonl over a window.
Usage: python3 -I queue_wait.py <exits.jsonl> [start_iso] [end_iso]
Wait is counted whole at the exit's UTC day (the #2194 method, not clipped).
Skipped lines (left before they queued, #1221) are left out.
Counting rules: #2812 (the baseline)'s, unchanged."""

import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus
from corpus import epoch


def pct(xs, p):
    if not xs:
        return 0
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def exits(path, start, end, tally):
    """A line torn by the log's
    prune race (scripts/lib/queue-exit-log.js) is counted into `tally` as unparsed (#2823)."""
    return [
        r
        for _line, r in corpus.records_with_lines(path, tally)
        if start <= r["at"] <= end and not r.get("skipped")
    ]


def main():
    path = sys.argv[1]
    start = sys.argv[2] if len(sys.argv) > 2 else corpus.START
    end = sys.argv[3] if len(sys.argv) > 3 else corpus.END
    tally = collections.Counter()
    rows = exits(path, start, end, tally)
    print("skipped:", corpus.counts_line(tally), file=sys.stderr)
    tot = sum(r["waitS"] for r in rows)
    span_d = (epoch(end) - epoch(start)) / 86400
    print(
        f"exits {len(rows)}  total wait {tot / 3600:.2f} h  span-days {span_d:.2f}  mean/day {tot / 3600 / span_d:.2f} h"
    )
    w = [r["waitS"] for r in rows]
    print(
        f"per-exit wait p50 {pct(w, 0.5):.0f}s p90 {pct(w, 0.9):.0f}s p95 {pct(w, 0.95):.0f}s max {max(w) if w else 0}s"
    )
    print("\nby kind: n, hours, share, p50, p95, max")
    by = collections.defaultdict(list)
    for r in rows:
        by[r["kind"]].append(r["waitS"])
    for k, v in sorted(by.items(), key=lambda kv: -sum(kv[1])):
        print(
            f"  {k:8} {len(v):5} {sum(v) / 3600:7.2f} h {sum(v) / max(tot, 1):6.1%} p50 {pct(v, 0.5):6.0f} p95 {pct(v, 0.95):6.0f} max {max(v)}"
        )
    print("\nby reason: n, hours")
    byr = collections.defaultdict(list)
    for r in rows:
        byr[r["reason"]].append(r["waitS"])
    for k, v in byr.items():
        print(f"  {k:8} {len(v):5} {sum(v) / 3600:7.2f} h")
    print("\nby UTC day: n, hours, p50, p95, max")
    byd = collections.defaultdict(list)
    for r in rows:
        byd[r["at"][:10]].append(r["waitS"])
    for k in sorted(byd):
        v = byd[k]
        print(
            f"  {k} {len(v):5} {sum(v) / 3600:6.2f} h p50 {pct(v, 0.5):5.0f} p95 {pct(v, 0.95):6.0f} max {max(v)}"
        )
    print(
        "\nempty-selection waits:",
        sum(1 for r in rows if r.get("empty")),
        f"{sum(r['waitS'] for r in rows if r.get('empty')) / 3600:.2f} h",
    )
    print(
        "waits >= 600 s:",
        sum(1 for x in w if x >= 600),
        f"{sum(x for x in w if x >= 600) / 3600:.2f} h",
    )
    print("distinct sessions:", len({r["session"] for r in rows}))


if __name__ == "__main__":
    main()
