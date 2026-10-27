#!/usr/bin/env python3
"""dense_minute.py — per-minute work rate from every seat's Claude Code transcripts (workflow-core#3211).

For every tool call in a transcript modified since --since: the minute its
result landed, its tool name and its round-trip (the result record's timestamp
less the assistant record's). Per minute it counts:

  calls    tool results
  active   transcripts with a result in that minute
  bash     each Bash round-trip, in seconds
  hto      hook-timeout refusals (a blocking hook that timed out)
  refused  test runs `run-vitest.js` refused at the load ceiling after its
           5-minute hold

Every repo's transcripts are read, not this repo's alone: the load ceiling is
the machine's.
"""

import argparse
import glob
import json
import os
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from transcript_corpus import counts_line, records_with_lines, seats

HOOK_TIMEOUT = "timed out; blocking because onFailure"
LOAD_REFUSAL = "run-vitest: REFUSED — load1 still"


def transcripts(since):
    """Every seat's transcripts, subagents' included, written at or after
    `since`: one copy per path under its seat's `projects/`, the largest."""
    copies = {}
    seen = set()
    for seat in seats():
        projects = os.path.join(seat, "projects")
        for pattern in ("*/*.jsonl", "*/*/subagents/*.jsonl"):
            for f in glob.glob(os.path.join(projects, pattern)):
                real = os.path.realpath(f)
                if real in seen:
                    continue
                seen.add(real)
                try:
                    st = os.stat(f)
                except OSError:
                    # Gone since the glob: nothing of it is left to count (workflow-core#3223).
                    continue
                rel = os.path.relpath(f, projects)
                if st.st_mtime >= since and st.st_size > copies.get(rel, ("", -1))[1]:
                    copies[rel] = (f, st.st_size)
    return [f for f, _ in copies.values()]


def epoch(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
    return ""


def minutes(files, since, until, tally):
    """{minute epoch: {calls, active, bash, hto, refused}} over [since, until).
    Unreadable files and unparsed lines are counted into `tally` (workflow-core#1274)."""
    out = defaultdict(
        lambda: {"calls": 0, "active": set(), "bash": [], "hto": 0, "refused": 0}
    )
    for f in files:
        pending = {}
        for _line, r in records_with_lines(f, tally, ("tool_use", "tool_result")):
            t = r.get("timestamp")
            msg = r.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if not t or not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "tool_use":
                    pending[c.get("id")] = (epoch(t), c.get("name"))
                elif c.get("type") == "tool_result" and c.get("tool_use_id") in pending:
                    start, name = pending.pop(c["tool_use_id"])
                    end = epoch(t)
                    if not since <= end < until:
                        continue
                    m = out[int(end // 60) * 60]
                    m["calls"] += 1
                    m["active"].add(f)
                    body = _text(c.get("content"))
                    if name == "Bash":
                        m["bash"].append(end - start)
                        if LOAD_REFUSAL in body:
                            m["refused"] += 1
                    if HOOK_TIMEOUT in body:
                        m["hto"] += 1
    return {k: {**v, "active": len(v["active"])} for k, v in out.items()}


def median(xs):
    return statistics.median(xs) if xs else None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--since", type=float, required=True)
    p.add_argument("--until", type=float, default=float("inf"))
    a = p.parse_args(argv)
    tally = Counter()
    rows = minutes(transcripts(a.since), a.since, a.until, tally)
    for k in sorted(rows):
        m = rows[k]
        b = m["bash"]
        print(
            json.dumps(
                {
                    "minute": datetime.fromtimestamp(k)
                    .astimezone()
                    .strftime("%Y-%m-%dT%H:%M%z"),
                    "calls": m["calls"],
                    "active": m["active"],
                    "bash_n": len(b),
                    "bash_p50": median(b) and round(median(b), 2),
                    "bash_p90": round(statistics.quantiles(b, n=10)[-1], 2)
                    if len(b) > 1
                    else None,
                    "hto": m["hto"],
                    "refused": m["refused"],
                }
            )
        )
    print(f"dense_minute: {counts_line(tally)}", file=sys.stderr)


if __name__ == "__main__":
    main()
