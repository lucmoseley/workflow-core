#!/usr/bin/env python3
"""scan_arbiter.py — corpus-wide session-arbiter.js tool-output cost, both
transcript tiers, every seat root (#379).

Path-blind by design: mantahostels#1139 flagged that `session-arbiter.js list` never names
docs/doc-map.md on its command line, so every path-matched scan misses it.
"""

import re
import collections
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus
from delivery_scan import result_text

ARB = re.compile(r"session-arbiter\.js\s+([a-z][a-z-]*)")
# mantahostels#970's closedAt, taken as region claims going live: the last
# region-claim commit landed ~4 minutes earlier. The scan splits pre/post on it,
# and so does list_shape.py, which imports it (#1298).
CUT = "2026-08-21T16:13:50Z"


def span_days(first, last):
    """(pre, post) days: first record to CUT, CUT to last record (#1324).

    A window the corpus never reaches spans 0 days.
    """
    if not first:
        return 0.0, 0.0
    start, end, cut = (datetime.fromisoformat(t) for t in (first, last, CUT))
    day = 86400
    return (
        max((cut - start).total_seconds(), 0) / day,
        max((end - cut).total_seconds(), 0) / day,
    )


def per_day(n, days):
    # nan, not 0: a window with no days has no rate, and 0 would read as a
    # measured absence of calls (#1324).
    return n / days if days else float("nan")


def main():
    calls = collections.Counter()
    byts = collections.Counter()
    win_calls = collections.Counter()
    win_byts = collections.Counter()
    tally = collections.Counter()
    files = sorted(transcript_corpus.one_copy_each())
    first = last = None

    for path, is_sub, _owner in files:
        tier = "nested" if is_sub else "top"
        pending = {}
        for rec in transcript_corpus.records(
            path, tally, needle=("session-arbiter", "toolUseResult")
        ):
            msg = rec.get("message") or {}
            ts = rec.get("timestamp") or ""
            if ts:
                first = min(first or ts, ts)
                last = max(last or ts, ts)
            for c in (
                (msg.get("content") or [])
                if isinstance(msg.get("content"), list)
                else []
            ):
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "tool_use" and c.get("name") == "Bash":
                    cmd = (c.get("input") or {}).get("command", "")
                    m = ARB.search(cmd)
                    if m:
                        pending[c.get("id")] = (m.group(1), ts)
                elif c.get("type") == "tool_result" and c.get("tool_use_id") in pending:
                    sub, ts0 = pending.pop(c["tool_use_id"])
                    # Residual: a list result counts a byte per separator between
                    # its joined blocks, and content neither string nor list
                    # counts 0 B (#1351).
                    n = len(result_text(c).encode())
                    calls[(sub, tier)] += 1
                    byts[(sub, tier)] += n
                    w = "post" if (ts0 or ts) >= CUT else "pre"
                    win_calls[(sub, w)] += 1
                    win_byts[(sub, w)] += n

    print("=== session-arbiter.js output, whole corpus, both tiers ===")
    print(transcript_corpus.counts_line(tally))
    subs = sorted(
        {k[0] for k in calls}, key=lambda s: -(byts[(s, "top")] + byts[(s, "nested")])
    )
    print(f"{'subcommand':16}{'calls':>8}{'bytes':>12}{'mean B':>9}")
    total_calls = total_bytes = 0
    for s in subs:
        c = calls[(s, "top")] + calls[(s, "nested")]
        b = byts[(s, "top")] + byts[(s, "nested")]
        total_calls += c
        total_bytes += b
        print(f"{s:16}{c:8d}{b:12d}{b // max(c, 1):9d}")
    print(f"{'TOTAL':16}{total_calls:8d}{total_bytes:12d}")

    print("\n=== pre / post mantahostels#970 (region claims, 21 Aug 16:13 UTC) ===")
    # Spans come from the records the scan reads, which its needle limits to
    # lines holding a tool result or an arbiter call.
    # Residual: a corpus whose first or last line holds neither reads each
    # span short by that gap, and its per-day rates high.
    pre_d, post_d = span_days(first, last)
    print(f"spans: pre {pre_d:.2f} d from {first}, post {post_d:.2f} d to {last}")
    print(
        f"{'subcommand':16}{'pre c/d':>9}{'post c/d':>10}{'pre B/d':>10}{'post B/d':>10}"
    )
    for s in subs:
        print(
            f"{s:16}{per_day(win_calls[(s, 'pre')], pre_d):9.1f}{per_day(win_calls[(s, 'post')], post_d):10.1f}"
            f"{per_day(win_byts[(s, 'pre')], pre_d):10.0f}{per_day(win_byts[(s, 'post')], post_d):10.0f}"
        )
    pre_b = sum(win_byts[(s, "pre")] for s in subs)
    post_b = sum(win_byts[(s, "post")] for s in subs)
    print(
        f"{'TOTAL':16}{'':9}{'':10}{per_day(pre_b, pre_d):10.0f}{per_day(post_b, post_d):10.0f}"
    )


if __name__ == "__main__":
    main()
