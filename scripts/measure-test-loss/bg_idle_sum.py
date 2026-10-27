"""Sum bg_idle.py's rows. Usage: python3 -I bg_idle_sum.py bg_idle.jsonl
Counting rules: #2812 (the baseline)'s, unchanged."""

import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1])]


def q(x, p):
    return x[int((len(x) - 1) * p)] if x else 0


for repo in ("wfc", "mh"):
    for how in ("bg", "autobg"):
        R = [r for r in rows if r["repo"] == repo and r["how"] == how]
        if not R:
            continue
        idle = sorted(r["idle_s"] for r in R)
        run = sorted(r["run_s"] for r in R)
        print(
            f"{repo} {how}: {len(R)} runs; launch-to-notice {sum(run) / 3600:.1f} h p50 {q(run, 0.5):.0f}s p95 {q(run, 0.95):.0f}s; "
            f"idle {sum(idle) / 3600:.1f} h p50 {q(idle, 0.5):.0f}s p95 {q(idle, 0.95):.0f}s; idle over 5 s: {sum(1 for x in idle if x > 5)}; "
            f"main-session idle {sum(r['idle_s'] for r in R if not r['sub']) / 3600:.1f} h"
        )
