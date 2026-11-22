import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus
from corpus import epoch
from fail_open import fail_open

BAD_TIMESTAMP = "bad timestamps"


def human_prompt(r):
    if r.get("type") != "user" or r.get("isMeta"):
        return False
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
            return False
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
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
        except ValueError as e:
            fail_open(e, f"timestamp in {path} skipped")
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
    corpus.run_scanner(
        "Active session time, the denominator for blocked time, from the Claude Code transcripts.",
        scan_file,
        subagents=False,
    )
