"""Split foreground test-call time into queue wait, vitest time and the rest (wrapper cost before
and after vitest, plus any other part of the same shell command).
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I fg_split.py blocked.jsonl wfc-runs.jsonl <.suite-queue-exits.jsonl>
Only main-session WFC rows (transcript file name = session id) in the marker window
(17 Oct 00:39 on) with exactly one marker started inside the call are used."""

import collections
import json
import re
import sys
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


bl, rf, qf = sys.argv[1:4]
runs = {}
for r in map(json.loads, open(rf)):
    if r["sessionId"]:
        runs.setdefault(r["sessionId"], []).append(
            (ts(r["startedAt"]), ts(r["at"]), r["durationMs"] / 1000, r["_k"], r["_v"])
        )
qs = {}
for r in map(json.loads, open(qf)):
    if r.get("skipped"):
        continue
    b = ts(r["at"])
    qs.setdefault(r["session"], []).append((b - r["waitS"], b))


def q(x, p):
    return x[int((len(x) - 1) * p)] if x else 0


rest, qw, vt, tot = [], [], [], []
byk = collections.defaultdict(float)
byv = collections.defaultdict(float)
byvk = collections.defaultdict(float)
for r in map(json.loads, open(bl)):
    if (
        r["repo"] != "wfc"
        or r["cls"] != "fg"
        or r["sub"]
        or r["s"] > 1800
        or r["at"] < "2026-10-17T00:39"
    ):
        continue
    m = re.search(r"([0-9a-f-]{36})\.jsonl$", r["file"])
    if not m:
        continue
    sid = m.group(1)
    a = ts(r["at"])
    b = a + r["s"]
    inside = [x for x in runs.get(sid, []) if a <= x[0] <= b]
    if len(inside) != 1:
        continue
    w = sum(max(0, min(b, y) - max(a, x)) for x, y in qs.get(sid, []))
    v = inside[0][2]
    byk[inside[0][3]] += v + w
    byv[inside[0][4]] += v
    byvk[inside[0][3]] += v
    rest.append(r["s"] - v - w)
    qw.append(w)
    vt.append(v)
    tot.append(r["s"])
n = len(rest)
for name, xs in (("call", tot), ("queue wait", qw), ("vitest", vt), ("rest", rest)):
    s = sorted(xs)
    print(
        f"{name:10} n {n} sum {sum(xs) / 3600:7.2f} h  p50 {q(s, 0.5):6.1f}s  p95 {q(s, 0.95):6.1f}s"
    )
print(
    "queue + vitest by run kind (h):",
    {k: round(x / 3600, 2) for k, x in sorted(byk.items(), key=lambda kv: -kv[1])},
)
print("vitest by verdict (h):", {k: round(x / 3600, 2) for k, x in byv.items()})
print(
    "vitest only by run kind (h):",
    {k: round(x / 3600, 2) for k, x in sorted(byvk.items(), key=lambda kv: -kv[1])},
)
