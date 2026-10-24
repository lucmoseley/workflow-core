"""list_shape.py — what each `session-arbiter.js list` call printed, before and
after region claims went live: calls, bytes, lines, and how many lines name a
doc-map region.

Built for lucmoseley/mantahostels#1759. No path-matched scan sees `list` output;
scan_arbiter.py found it 57% of the claim subsystem's cost, and this splits it on the
region-claim cut to show what the claims themselves added.
"""

import re
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scan_arbiter import CUT


def rt(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(x.get("text", "") for x in c if isinstance(x, dict))
    return ""


def main():
    stats = collections.defaultdict(
        lambda: [0, 0, 0, 0]
    )  # calls, bytes, docmap-region lines, total lines
    files = tc.all_transcripts()
    tally = collections.Counter()
    for p in files:
        pend = {}
        for r in tc.records(p, tally, needle=("session-arbiter", "toolUseResult")):
            m = r.get("message") or {}
            ts = r.get("timestamp") or ""
            cs = m.get("content")
            if not isinstance(cs, list):
                continue
            for c in cs:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "tool_use" and c.get("name") == "Bash":
                    cmd = (c.get("input") or {}).get("command", "")
                    if re.search(r"session-arbiter\.js\s+list\b", cmd):
                        pend[c.get("id")] = ts
                elif c.get("type") == "tool_result" and c.get("tool_use_id") in pend:
                    ts0 = pend.pop(c["tool_use_id"]) or ts
                    t = rt(c.get("content"))
                    w = "post" if ts0 >= CUT else "pre"
                    s = stats[w]
                    s[0] += 1
                    s[1] += len(t.encode())
                    lines = t.splitlines()
                    s[3] += len(lines)
                    s[2] += sum(1 for line in lines if "doc-map.md#" in line)
    print(tc.counts_line(tally))
    for w in ("pre", "post"):
        c, b, dm, ln = stats[w]
        print(
            f"{w}: {c} list calls, {b} B, mean {b // max(c, 1)} B, {ln} lines total ({ln / max(c, 1):.1f}/call), "
            f"{dm} doc-map region lines ({dm / max(c, 1):.1f}/call, {100 * dm / max(ln, 1):.1f}% of lines)"
        )


if __name__ == "__main__":
    main()
