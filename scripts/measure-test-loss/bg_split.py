import json
import re
import sys
from collections import defaultdict
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


bi, rf, qf = sys.argv[1:4]
start = sys.argv[4] if len(sys.argv) > 4 else "2026-10-17T00:39"
runs, qs = {}, {}
for r in map(json.loads, open(rf)):
    if r["sessionId"]:
        runs.setdefault(r["sessionId"], []).append((ts(r["startedAt"]), ts(r["at"])))
for r in map(json.loads, open(qf)):
    if not r.get("skipped"):
        b = ts(r["at"])
        qs.setdefault(r["session"], []).append((b - r["waitS"], b))


def ov(xs, a, b):
    return sum(max(0, min(b, y) - max(a, x)) for x, y in xs)


tot = defaultdict(
    lambda: {"n": 0, "idle": 0.0, "queue": 0.0, "vitest": 0.0, "rest": 0.0}
)
for r in map(json.loads, open(bi)):
    if r["sub"] or r["at"] < start:
        continue
    m = re.search(r"([0-9a-f-]{36})\.jsonl$", r["file"])
    if not m:
        continue
    sid = m.group(1)
    a = ts(r["at"])
    b = a + r["run_s"]
    if b <= a:
        continue
    w = min(ov(qs.get(sid, []), a, b), b - a)
    v = min(ov(runs.get(sid, []), a, b), b - a - w)
    f = r["idle_s"]
    t = tot[r["repo"]]
    t["n"] += 1
    t["idle"] += f
    t["queue"] += f * w / (b - a)
    t["vitest"] += f * v / (b - a)
    t["rest"] += f * (b - a - w - v) / (b - a)
for repo, t in sorted(tot.items()):
    print(
        f"{repo} main-session bg idle rows {t['n']}: idle {t['idle'] / 3600:.2f} h = queue {t['queue'] / 3600:.2f} h + vitest {t['vitest'] / 3600:.2f} h + rest {t['rest'] / 3600:.2f} h"
    )
