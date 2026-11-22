import glob
import json
import os
import sys
from datetime import datetime

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
)
from fail_open import fail_open


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


d, dump = sys.argv[1:3]
runs = [json.loads(line) for line in open(dump)]
by = {}
for r in runs:
    by.setdefault(r["sessionId"], []).append(r)
pre, post = [], []
for f in glob.glob(os.path.join(d, ".test-logs", "runs-*.jsonl")):
    sess = os.path.basename(f)[5:-6]
    for line in open(f):
        try:
            rec = json.loads(line)
        except ValueError as e:
            fail_open(e, f"torn line in {f} skipped")
            continue
        a = ts(rec["startedAt"])
        b = ts(rec["endedAt"])
        best = None
        for m in by.get(sess, []):
            s = ts(m["startedAt"])
            if a <= s <= a + 600 and (best is None or s < ts(best["startedAt"])):
                best = m
        if best:
            pre.append(ts(best["startedAt"]) - a)
            post.append(b - ts(best["at"]))
if not pre:
    sys.exit("matched 0 runs")
pre.sort()
post.sort()


def q(xs, p):
    return xs[int((len(xs) - 1) * p)] if xs else None


print(
    f"matched {len(pre)} runs; before spawn p50 {q(pre, 0.5):.1f}s p95 {q(pre, 0.95):.1f}s; after end p50 {q(post, 0.5):.1f}s p95 {q(post, 0.95):.1f}s"
)
