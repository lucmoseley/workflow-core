import collections
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


bl, rf, qf = sys.argv[1:4]
runs = {}
for path in rf.split(","):
    for r in map(json.loads, open(path)):
        if r["sessionId"]:
            runs.setdefault(r["sessionId"], []).append(
                (
                    ts(r["startedAt"]),
                    ts(r["at"]),
                    r["durationMs"] / 1000,
                    r["_k"],
                    r["_v"],
                )
            )
qs = {}
for path in qf.split(","):
    for r in map(json.loads, open(path)):
        if r.get("skipped"):
            continue
        b = ts(r["at"])
        qs.setdefault(r["session"], []).append((b - r["waitS"], b))


def q(x, p):
    return x[int((len(x) - 1) * p)] if x else 0


def hours_desc(by):
    return {k: round(x / 3600, 2) for k, x in sorted(by.items(), key=lambda kv: -kv[1])}


@dataclass
class ForegroundSplit:
    call: list = field(default_factory=list)
    queue_wait: list = field(default_factory=list)
    vitest: list = field(default_factory=list)
    rest: list = field(default_factory=list)
    queue_and_vitest_by_kind: dict = field(
        default_factory=lambda: collections.defaultdict(float)
    )
    vitest_by_verdict: dict = field(
        default_factory=lambda: collections.defaultdict(float)
    )
    vitest_by_kind: dict = field(default_factory=lambda: collections.defaultdict(float))


by_repo = collections.defaultdict(ForegroundSplit)
for r in map(json.loads, open(bl)):
    if r["cls"] != "fg" or r["sub"] or r["s"] > 1800 or r["at"] < "2026-10-17T00:39":
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
    split = by_repo[r["repo"]]
    split.queue_and_vitest_by_kind[inside[0][3]] += v + w
    split.vitest_by_verdict[inside[0][4]] += v
    split.vitest_by_kind[inside[0][3]] += v
    split.rest.append(r["s"] - v - w)
    split.queue_wait.append(w)
    split.vitest.append(v)
    split.call.append(r["s"])
for repo, split in sorted(by_repo.items()):
    print(f"===== {repo}")
    n = len(split.rest)
    for name, xs in (
        ("call", split.call),
        ("queue wait", split.queue_wait),
        ("vitest", split.vitest),
        ("rest", split.rest),
    ):
        s = sorted(xs)
        print(
            f"{name:10} n {n} sum {sum(xs) / 3600:7.2f} h  p50 {q(s, 0.5):6.1f}s  p95 {q(s, 0.95):6.1f}s"
        )
    print("queue + vitest by run kind (h):", hours_desc(split.queue_and_vitest_by_kind))
    print("vitest by verdict (h):", hours_desc(split.vitest_by_verdict))
    print("vitest only by run kind (h):", hours_desc(split.vitest_by_kind))
