import collections
import json
import sys

runs = [json.loads(line) for line in open(sys.argv[1])]
last = {}
cls = collections.defaultdict(lambda: [0, 0.0])
same_sha_any = collections.defaultdict(lambda: [0, 0.0])
first_by_sha = {}
by_kind = collections.defaultdict(lambda: [0, 0.0])
sess_cross = [0, 0.0]
for r in runs:
    if r["suite"] != "vitest":
        continue
    if not r.get("treeAtEnd"):
        continue
    key = (r["sha"], r["treeAtEnd"], tuple(r.get("argv") or []))
    h = r["durationMs"] / 3.6e6
    if key in last:
        prev = last[key]
        c = cls[
            f"after {prev['_v']}, {'same' if prev['sessionId'] == r['sessionId'] else 'other'} session, now {r['_v']}"
        ]
        c[0] += 1
        c[1] += h
        b = by_kind[r["_k"]]
        b[0] += 1
        b[1] += h
    last[key] = r
tot = sum(r["durationMs"] for r in runs if r["suite"] == "vitest") / 3.6e6
n = sum(v[0] for v in cls.values())
hh = sum(v[1] for v in cls.values())
print(f"vitest runs {sum(1 for r in runs if r['suite'] == 'vitest')}, wall {tot:.2f} h")
print(
    f"re-runs of an identical (sha, tree, argv): {n} runs, {hh:.2f} h ({hh / tot:.1%} of wall)"
)
for k, v in sorted(cls.items(), key=lambda kv: -kv[1][1]):
    print(f"  {k:55} {v[0]:5} {v[1]:6.2f} h")
print("by kind of the re-run:")
for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1][1]):
    print(f"  {k:14} {v[0]:5} {v[1]:6.2f} h")
per_sha = collections.Counter(r["sha"] for r in runs if r["suite"] == "vitest")
dist = collections.Counter(min(v, 10) for v in per_sha.values())
print(
    "runs per sha (10 = 10 or more):", dict(sorted(dist.items())), "shas", len(per_sha)
)
