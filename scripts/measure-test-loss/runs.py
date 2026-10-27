"""Run duration, count and kind from the 30-day run ledger, `.test-runs.jsonl` (`scripts/lib/run-ledger.js`).
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I runs.py <markers-dir> [start_iso] [end_iso] [--dump runs.jsonl]
Each ledger line is one run; (startedAt, session, suite) stays unique only as a guard.
Kind, verdict and fullCause are the ledger's, except one rule applied here:
  lander-rerun  any vitest line other than a lander's with no session after the lander's first run
          (inferred: the lander's bisect, flake and confirm re-runs run with no session id)"""

import collections
import json
import os
import sys
from datetime import datetime


def pct(xs, p):
    if not xs:
        return 0
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


args = [a for a in sys.argv[1:] if not a.startswith("--dump")]
dump = None
if "--dump" in sys.argv:
    dump = sys.argv[sys.argv.index("--dump") + 1]
    args = [a for a in args if a != dump]
d = args[0]
start = args[1] if len(args) > 1 else "2026-10-10T04:10:00Z"
end = args[2] if len(args) > 2 else "2026-10-24T04:10:59Z"
LANDER_START = "2026-10-22T01:55:00Z"


def kind_with_lander_rerun(r):
    unsessioned = r["kind"] not in ("pytest", "lander") and not r.get("session")
    return (
        "lander-rerun" if unsessioned and r["startedAt"] >= LANDER_START else r["kind"]
    )


seen = {}
p = os.path.join(d, ".test-runs.jsonl")
if not os.path.exists(p):
    sys.exit(f"no run ledger at {p}")
for line in open(p, errors="replace"):
    try:
        r = json.loads(line)
    except ValueError:
        # A torn or partial line is skipped, as #2812 read the stores.
        continue
    if not r.get("startedAt") or r.get("durationMs") is None:
        continue
    if not (start <= r["at"] <= end):
        continue
    r["_v"] = r["verdict"]
    r["_k"] = kind_with_lander_rerun(r)
    seen[(r["startedAt"], r.get("session"), r.get("suite"))] = r
runs = sorted(seen.values(), key=lambda r: r["startedAt"])
if not runs:
    print("no runs")
    sys.exit()
t0, t1 = runs[0]["startedAt"], runs[-1]["at"]
span_d = (
    datetime.fromisoformat(t1.replace("Z", "+00:00"))
    - datetime.fromisoformat(t0.replace("Z", "+00:00"))
).total_seconds() / 86400
tot = sum(r["durationMs"] for r in runs) / 3.6e6
print(
    f"runs {len(runs)} from {t0} to {t1} ({span_d:.2f} days); run wall {tot:.2f} h; {tot / span_d:.2f} h/day; {len(runs) / span_d:.0f} runs/day"
)
print("\nby kind: runs, runs/day, hours, h/day, share, p50 s, p95 s, max s, red share")
by = collections.defaultdict(list)
for r in runs:
    by[r["_k"]].append(r)
for k, v in sorted(by.items(), key=lambda kv: -sum(r["durationMs"] for r in kv[1])):
    ds = [r["durationMs"] / 1000 for r in v]
    h = sum(ds) / 3600
    red = sum(1 for r in v if r["_v"] != "green") / len(v)
    print(
        f"  {k:8} {len(v):5} {len(v) / span_d:6.1f} {h:7.2f} {h / span_d:6.2f} {h / tot:6.1%} {pct(ds, 0.5):7.1f} {pct(ds, 0.95):7.1f} {max(ds):7.0f} {red:6.1%}"
    )
print("\nby verdict: runs, hours")
for v in ["green", "red", "killed", "stalled"]:
    xs = [r for r in runs if r["_v"] == v]
    print(f"  {v:8} {len(xs):5} {sum(r['durationMs'] for r in xs) / 3.6e6:7.2f}")
print("\nfull and lander runs by cause: runs, hours, p50 s")
fc = collections.defaultdict(list)
for r in runs:
    if r["_k"] in ("full", "lander", "lander-rerun"):
        fc[(r["_k"], r.get("fullCause") or "no flag (whole selection)")].append(
            r["durationMs"] / 1000
        )
for k, v in sorted(fc.items(), key=lambda kv: -sum(kv[1])):
    print(f"  {k} {len(v)} {sum(v) / 3600:.2f} h p50 {pct(v, 0.5):.0f}")
print("\nby UTC day of start: runs, hours, full+lander runs")
bd = collections.defaultdict(list)
for r in runs:
    bd[r["startedAt"][:10]].append(r)
for k in sorted(bd):
    v = bd[k]
    print(
        f"  {k} {len(v):5} {sum(r['durationMs'] for r in v) / 3.6e6:6.2f} h  full {sum(1 for r in v if r['_k'] in ('full', 'lander'))}"
    )
if dump:
    with open(dump, "w") as f:
        for r in runs:
            row = {
                k: r.get(k)
                for k in [
                    "sha",
                    "startedAt",
                    "at",
                    "durationMs",
                    "suite",
                    "treeAtEnd",
                    "argv",
                    "_k",
                    "_v",
                ]
            }
            # fg_split, bg_split, reruns and wrapper_cost key on sessionId, the marker stores' name.
            row["sessionId"] = r.get("session")
            f.write(json.dumps(row) + "\n")
