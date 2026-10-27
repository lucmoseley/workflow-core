"""Lander events and the session queue wait while a lander suite runs.
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I lander.py <.lander.log> <runs.jsonl> <.suite-queue-exits.jsonl>
Lander gate wait: each 'lander: gate opened after N s' line (the lander waits for a running suite).
Overlap: each session queue wait [exit - waitS, exit] is cut into the seconds that fall while a
lander full run (kind 'lander' in runs.jsonl) was live, and the seconds that do not."""

import collections
import json
import re
import sys
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


log, runsf, qf = sys.argv[1:4]
gate = []
ev = collections.Counter()
ff = []
for line in open(log, errors="replace"):
    m = re.match(r"lander: gate opened after (\d+)s", line)
    if m:
        gate.append(int(m.group(1)))
    m = re.match(r"(20\d\d-\d\d-\d\dT[\d:.]+Z) (\S+)", line)
    if m:
        ev[m.group(2)] += 1
        if m.group(2) == "fast-forward":
            ff.append(m.group(1))
print(
    f"lander gate waits: {len(gate)}, {sum(gate) / 3600:.2f} h, p50 {sorted(gate)[len(gate) // 2] if gate else 0}s, max {max(gate) if gate else 0}s"
)
print("event counts:", dict(ev))
print("fast-forwards:", len(ff), "first", ff[:1], "last", ff[-1:])
lr = [
    (ts(r["startedAt"]), ts(r["startedAt"]) + r["durationMs"] / 1000)
    for r in map(json.loads, open(runsf))
    if r["_k"] in ("lander", "lander-rerun")
]
lr.sort()
t0 = min(a for a, b in lr) if lr else 0


def live_overlap(a, b):
    s = 0.0
    for x, y in lr:
        lo, hi = max(a, x), min(b, y)
        if hi > lo:
            s += hi - lo
    return s


# union of lander-live time after t0
union = 0.0
cur = None
for x, y in lr:
    if cur is None or x > cur[1]:
        if cur:
            union += cur[1] - cur[0]
        cur = [x, y]
    else:
        cur[1] = max(cur[1], y)
if cur:
    union += cur[1] - cur[0]
end = max(ts(r["at"]) for r in map(json.loads, open(qf)))
span = end - t0
inside = outside = 0.0
for r in map(json.loads, open(qf)):
    if r.get("skipped"):
        continue
    b = ts(r["at"])
    a = b - r["waitS"]
    if b < t0:
        continue
    a = max(a, t0)
    o = live_overlap(a, b)
    o = min(o, b - a)
    inside += o
    outside += (b - a) - o
print(
    f"since the first lander run: span {span / 3600:.1f} h, lander suite live {union / 3600:.1f} h ({union / span:.0%})"
)
print(
    f"session queue wait while a lander suite was live: {inside / 3600:.2f} h = {inside / max(union, 1):.2f} waiting sessions on mean"
)
print(
    f"session queue wait while none was live: {outside / 3600:.2f} h = {outside / max(span - union, 1):.2f} waiting sessions on mean"
)
