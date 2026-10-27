"""Survey each log: line count, date span, field keys and value counts.
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I survey.py <markers-dir>"""

import collections
import json
import os
import sys

d = sys.argv[1]
for name in [
    ".suite-queue-exits.jsonl",
    ".test-pass-markers.jsonl",
    ".test-pass-markers.archive.jsonl",
    ".test-fail-markers.jsonl",
    ".test-fail-markers.archive.jsonl",
    ".suite-standdowns.jsonl",
    ".unasked-rerun-refusals.jsonl",
]:
    p = os.path.join(d, name)
    if not os.path.exists(p):
        print("==", name, "MISSING")
        continue
    rows = []
    for line in open(p, errors="replace"):
        try:
            rows.append(json.loads(line))
        except ValueError:
            # A torn or partial line is skipped, as #2812 read the stores.
            pass
    ats = sorted(r.get("at", "") for r in rows if r.get("at"))
    keys = collections.Counter(k for r in rows for k in r)
    print("==", name, len(rows), ats[0] if ats else None, ats[-1] if ats else None)
    print("  keys:", dict(keys))
    for f in ["suite", "kind", "reason", "limb", "ceilingKill"]:
        c = collections.Counter(str(r.get(f)) for r in rows)
        if len(c) > 1 or "None" not in c:
            print("  ", f, dict(c))
    sc = collections.Counter(k for r in rows for k in (r.get("scope") or {}))
    if sc:
        print("  scope keys:", dict(sc))
    for f in ["full", "fullCause", "changed"]:
        c = collections.Counter(
            str((r.get("scope") or {}).get(f)) for r in rows if r.get("scope")
        )
        if c:
            print("  scope.", f, dict(c.most_common(12)))
