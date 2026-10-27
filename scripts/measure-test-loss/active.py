"""Active session time, the denominator for blocked time, from the Claude Code transcripts.
Counting rules: #2821 (the verification figure)'s, unchanged.
Usage: python3 -I active.py <out.jsonl> [<projects-dir>...] [--start ISO] [--end ISO]
Main-session transcripts only. Active time = the sum of gaps between consecutive timestamped
entries, each capped at corpus.CAP_S, leaving out any gap that ends in a prompt the human typed.
A gap counts in the window when it ends there. One row per transcript per UTC hour."""

import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus
from corpus import epoch

# A malformed timestamp is a skipped line, counted beside the unparsed ones (#2823).
BAD_TIMESTAMP = "bad timestamps"


def human_prompt(r):
    if r.get("type") != "user" or r.get("isMeta"):
        return False
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
            return False
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
    # the harness's own wrappers open within a prompt's first 400 characters (#2821, untraced)
    return not re.search(
        r"<task-notification>|<local-command|<command-name>|<system-reminder>",
        str(c)[:400],
    )


def scan_file(path, repo, start, end, *, tally):
    t_start, t_end = epoch(start), epoch(end)
    prev = None
    buckets = defaultdict(float)
    for _line, r in corpus.records_with_lines(path, tally, '"timestamp"'):
        t = r.get("timestamp")
        if not isinstance(t, str):
            continue
        try:
            t = epoch(t)
        except ValueError:
            # counted, never fatal (#2823)
            tally[BAD_TIMESTAMP] += 1
            continue
        if (
            prev is not None
            and t > prev
            and not human_prompt(r)
            and t_start <= t <= t_end
        ):
            buckets[int(t // 3600)] += min(t - prev, corpus.CAP_S)
        if prev is None or t > prev:
            prev = t
    return [
        {"repo": repo, "file": corpus.row_file(path), "hour": h, "s": round(s, 1)}
        for h, s in buckets.items()
    ]


if __name__ == "__main__":
    corpus.run_scanner(__doc__, scan_file, subagents=False)
