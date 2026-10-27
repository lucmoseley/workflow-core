"""Split the idle wait for background test runs into queue wait, vitest time and the rest, in the
ratio those parts hold in the launch-to-notice window of the same session.
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I bg_split.py bg_idle.jsonl wfc-runs.jsonl <.suite-queue-exits.jsonl> [start]"""

import json
import re
import sys
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


idle = queue = vitest = rest = 0.0
n = 0
for r in map(json.loads, open(bi)):
    if r["repo"] != "wfc" or r["sub"] or r["at"] < start:
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
    n += 1
    idle += f
    queue += f * w / (b - a)
    vitest += f * v / (b - a)
    rest += f * (b - a - w - v) / (b - a)
print(
    f"main-session bg idle rows {n}: idle {idle / 3600:.2f} h = queue {queue / 3600:.2f} h + vitest {vitest / 3600:.2f} h + rest {rest / 3600:.2f} h"
)
