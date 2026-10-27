"""Wrapper time outside vitest: .test-logs/runs-<session>.jsonl records (startedAt/endedAt of the
whole run) matched to a marker by pid-free time: the marker whose startedAt is the nearest after
the record's startedAt, same session, within 10 min. Before = marker.startedAt - record.startedAt;
after = record.endedAt - marker.at.
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I wrapper_cost.py <markers-dir> <runs.jsonl dump>"""

import glob
import json
import os
import sys
from datetime import datetime


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
        except ValueError:
            # A torn or partial line is skipped, as #2812 read the stores.
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
