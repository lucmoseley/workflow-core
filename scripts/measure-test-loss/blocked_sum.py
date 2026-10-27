"""Sum blocked.py's rows. Usage: python3 -I blocked_sum.py blocked.jsonl [days]
Counting rules: #2812 (the baseline)'s, unchanged.
Rows are de-duplicated on (file, at, cls), because a transcript can repeat a line after a resume."""

import collections
import json
import sys


def pct(xs, p):
    if not xs:
        return 0
    xs = sorted(xs)
    return xs[int((len(xs) - 1) * p)]


rows = {}
for line in open(sys.argv[1]):
    r = json.loads(line)
    rows[(r["file"], r["at"], r["cls"], r["cmd"][:60])] = r
rows = list(rows.values())
CAP = 1800  # a foreground call is moved to the background near 600 s; longer rows are a held prompt or a suspended session
ex = [r for r in rows if r["cls"] == "fg" and r["s"] > CAP]
print(
    f"left out: {len(ex)} fg rows over {CAP} s, {sum(r['s'] for r in ex) / 3600:.2f} h"
)
rows = [r for r in rows if not (r["cls"] == "fg" and r["s"] > CAP)]
# The window's length in days, for the h/day figures: #2812's 14 unless given.
DAYS = float(sys.argv[2]) if len(sys.argv) > 2 else 14
for repo in ("wfc", "mh"):
    R = [r for r in rows if r["repo"] == repo]
    print(f"===== {repo}: rows {len(R)}")
    for cls in ("fg", "wait"):
        X = [r for r in R if r["cls"] == cls]
        s = [r["s"] for r in X]
        print(
            f" {cls}: {len(X)} calls, {sum(s) / 3600:.2f} h ({sum(s) / 3600 / DAYS:.2f} h/day), p50 {pct(s, 0.5):.0f}s p95 {pct(s, 0.95):.0f}s max {max(s) if s else 0:.0f}s"
        )
        for sub in (False, True):
            Y = [r["s"] for r in X if r["sub"] == sub]
            print(
                f"    {'subagent' if sub else 'main    '} {len(Y):6} {sum(Y) / 3600:8.2f} h"
            )
        by = collections.defaultdict(list)
        for r in X:
            by[r["kind"]].append(r["s"])
        for k, v in sorted(by.items(), key=lambda kv: -sum(kv[1])):
            print(
                f"    kind {k:12} {len(v):6} {sum(v) / 3600:8.2f} h p50 {pct(v, 0.5):5.0f}s p95 {pct(v, 0.95):5.0f}s"
            )
        if cls == "fg":
            A = [r["s"] for r in X if r.get("autobg")]
            print(
                f"    moved to background by the harness: {len(A)} calls, {sum(A) / 3600:.2f} h of blocked time before the move"
            )
            Q = [r["s"] for r in X if "--queue" in r["cmd"]]
            print(
                f"    with --queue in the command: {len(Q)} calls, {sum(Q) / 3600:.2f} h"
            )
    B = [r for r in R if r["cls"] == "bg"]
    print(
        f" bg launches: {len(B)}; by kind {dict(collections.Counter(r['kind'] for r in B))}"
    )
    byd = collections.defaultdict(float)
    byn = collections.Counter()
    for r in R:
        if r["cls"] in ("fg", "wait"):
            byd[r["at"][:10]] += r["s"]
            byn[r["at"][:10]] += 1
    print(
        " by day (fg+wait):",
        ", ".join(f"{d[5:]} {byn[d]}/{byd[d] / 3600:.1f}h" for d in sorted(byd)),
    )
