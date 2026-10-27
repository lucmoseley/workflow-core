"""Session red runs that fail only on files the lander's red full suite also failed on, inside the
lander's red stretches. These reds are inherited from a red tip, not made by the session's own work.
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I inherited_red.py <markers-dir>
Stretches are those red_main.py prints for the lander (hard-coded below, UTC)."""

import json
import os
import sys

d = sys.argv[1]
STRETCHES = [
    ("2026-10-22T03:21", "2026-10-22T14:35"),
    ("2026-10-22T15:42", "2026-10-22T17:08"),
    ("2026-10-22T23:01", "2026-10-22T23:53"),
    ("2026-10-23T01:11", "2026-10-23T15:33"),
]
rows = []
for n in [".test-fail-markers.archive.jsonl", ".test-fail-markers.jsonl"]:
    for line in open(os.path.join(d, n), errors="replace"):
        try:
            rows.append(json.loads(line))
        except ValueError:
            # A torn or partial line is skipped, as #2812 read the stores.
            pass


def norm(f):
    return (
        f.split("/.claude/worktrees/")[-1].split("/", 1)[-1]
        if "/.claude/worktrees/" in f
        else f.replace("/home/lucmo/workflow-core/", "")
    )


seen = set()
tot_n = 0
tot_h = 0.0
red_n = 0
red_h = 0.0
for a, b in STRETCHES:
    inst = [r for r in rows if a <= r["at"][:16] <= b and r.get("startedAt")]
    lander = [
        r
        for r in inst
        if not r.get("sessionId") and (r.get("argv") or []) and "--shared" in r["argv"]
    ]
    F = {
        norm(f["file"])
        for r in lander
        for f in (r.get("scope") or {}).get("failures") or []
    }
    for r in inst:
        if not r.get("sessionId"):
            continue
        k = (r["startedAt"], r["sessionId"])
        if k in seen:
            continue
        seen.add(k)
        fl = {norm(f["file"]) for f in (r.get("scope") or {}).get("failures") or []}
        h = r.get("durationMs", 0) / 3.6e6
        red_n += 1
        red_h += h
        if fl and fl <= F:
            tot_n += 1
            tot_h += h
    print(f"{a} to {b}: lander failing files {len(F)}")
print(
    f"session red runs in the stretches: {red_n}, {red_h:.2f} h; failing only on lander-red files: {tot_n}, {tot_h:.2f} h"
)
