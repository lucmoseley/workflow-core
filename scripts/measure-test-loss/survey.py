import collections
import json
import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
)
from fail_open import fail_open

d = sys.argv[1]
for name in [
    ".suite-queue-exits.jsonl",
    ".test-pass-markers.jsonl",
    ".test-pass-markers.archive.jsonl",
    ".test-fail-markers.jsonl",
    ".test-fail-markers.archive.jsonl",
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
        except ValueError as e:
            fail_open(e, f"torn line in {name} skipped")
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
