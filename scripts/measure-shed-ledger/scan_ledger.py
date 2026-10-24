#!/usr/bin/env python3
"""scan_ledger.py — mantahostels#1407: what the shed ledger (docs/doc-map.md §Capture and placement §5) costs.

The unit measured is every bullet in §5. Any line-oriented read of
docs/doc-map.md that matches one — `grep -n <anything>` included — delivers that
bullet into the session's context, where every later turn re-reads it. Until
mantahostels#1430 §5 held its 19 tranches on ONE 22 KB physical line, so a single match
delivered all of them.

Three things this deliberately does NOT count. Two are understatements —
subagent transcripts, and occurrences outside a `tool_result` such as an `Agent`
dispatch prompt. The third pushes the other way and makes the figure a ceiling:
a turn after a context compaction has dropped the delivery.
"""

import argparse
import os
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc
from context_cost import grossed_up, price, window_cost
from delivery_scan import (
    REPO,
    bash_read_kind,
    git,
    growth_per_day,
    landed_bytes,
    parent_transcripts,
    intent_text,
    revision_on,
    suffix_distinct_turns,
    tool_results,
    tool_route,
    window_days,
)

NEEDLE = "Sheds paid, most recent first"
DOC_MAP = "docs/doc-map.md"
# §5 is located from NEEDLE's own line rather than from its heading text: the
# heading has been respelled since the window this script measures, and a
# missed section silently drops a day out of the growth series (mantahostels#1430).
HEADING = re.compile(r"^#{1,6} ")
# What counts as §5 payload: its bullets, nested ones included. §5's prose —
# the reconciliation paragraph above the ledger — is excluded, because no
# line-oriented read delivers a bullet and that prose together.
BULLET = re.compile(r"^\s*- ")
# How much of a bullet's opening identifies it in a transcript. Long enough that
# no two §5 bullets share one, short enough to survive a truncating read. 40
# is a guess against both limits, not a measurement.
ANCHOR_LEN = 40


def classify(res):
    route = tool_route(res.name, res.input)
    if route:
        return route
    cmd = res.command
    if "doc-map" not in cmd:
        # The line reached context some other way — a `gh issue view` quoting it,
        # a task-output `cat`.
        return "Bash, not a doc-map read"
    return f"{bash_read_kind(cmd)} on doc-map"


def scan(start, end, anchors, tally):
    routes, route_bytes, intent = Counter(), Counter(), Counter()
    deliveries = []
    for _fp, _hit, recs in parent_transcripts(tally, anchors.search):
        after = suffix_distinct_turns(recs)
        for res in tool_results(recs, start, end):
            if not anchors.search(res.text):
                continue
            # Matching per line keeps this the same quantity ledger_bytes_at()
            # sums, which is what makes their ratio a truncation fraction.
            ledger_b = landed_bytes(res.text, anchors.search)
            route = classify(res)
            routes[route] += 1
            route_bytes[route] += ledger_b
            # Lexical, and over the whole tool input rather than the command
            # alone — so it over-counts "deliberate", making incidental a floor.
            hay = intent_text(res)
            asked = re.search(
                r"shed|ledger|always-loaded|capture and placement|context-budget|ratchet",
                hay,
            )
            intent["deliberate" if asked else "incidental"] += 1
            deliveries.append((res.timestamp[:10], ledger_b, after[res.pos + 1]))
        del recs
    return routes, route_bytes, intent, deliveries


def section_5_bullets(blob, where):
    """§5's bullet lines, at whatever heading level and spelling it carries."""
    lines = blob.split("\n")
    hits = [i for i, ln in enumerate(lines) if NEEDLE in ln]
    if len(hits) != 1:
        raise SystemExit(f"expected 1 ledger stem at {where}, found {len(hits)}")
    start = hits[0]
    while start > 0 and not HEADING.match(lines[start]):
        start -= 1
    end = hits[0] + 1
    while end < len(lines) and not HEADING.match(lines[end]):
        end += 1
    return [ln for ln in lines[start:end] if BULLET.match(ln)]


def ledger_bytes_at(rev=None):
    """Total bytes of every bullet in §5, at a revision or in the working tree.

    The same quantity on both sides of mantahostels#1430's split — 26,496 B the commit
    before, 26,502 B the commit after — so the growth series stays comparable.

    Raises rather than returning 0: a silent zero here prints a $0 headline.
    """
    where = rev or "HEAD tree"
    if rev:
        blob = git("show", f"{rev}:{DOC_MAP}")
    else:
        blob = open(os.path.join(REPO, DOC_MAP), errors="replace").read()
    bullets = section_5_bullets(blob, where)
    if not bullets:
        raise SystemExit(f"no §5 bullets at {where}")
    return sum(len(b.encode("utf-8", "replace")) for b in bullets)


def delivery_anchors():
    """One matcher for the openings of §5's bullets, as a transcript sees them.

    Post-mantahostels#1430 the tranches carry no NEEDLE of their own, so matching on NEEDLE
    alone would count a 36 B stem where 22 KB of tranches landed and report the
    ledger as free.
    """
    bullets = section_5_bullets(
        open(os.path.join(REPO, DOC_MAP), errors="replace").read(), "HEAD tree"
    )
    opens = {b.strip()[:ANCHOR_LEN] for b in bullets}
    return re.compile("|".join(sorted(map(re.escape, opens))))


def sizes_by_date(start, end):
    """§5's bullet total at the end of each day in the window.

    A day whose revision cannot be parsed is dropped AND named: an unnamed drop
    silently shortens the least-squares fit and leaves its deliveries scored
    against a zero exposure, inflating the truncation fraction (mantahostels#1430).
    """
    out = {}
    for day in window_days(start, end):
        sha = revision_on(day, DOC_MAP)
        if not sha:
            continue
        try:
            out[day] = ledger_bytes_at(sha)
        except SystemExit as e:
            print(f"  ! {day} ({sha[:8]}) dropped from the series: {e}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", nargs=2, default=["2026-08-20", "2026-08-25"])
    args = ap.parse_args()
    start, end = args.window
    days = len(window_days(start, end))

    anchors = delivery_anchors()
    tally, spend = Counter(), Counter()
    routes, route_bytes, intent, deliveries = scan(start, end, anchors, tally)
    if not deliveries:
        print("no deliveries in window")
        return
    delivered = sum(d[1] for d in deliveries)
    byte_turns = sum(d[1] * d[2] for d in deliveries)

    print(f"window {start}..{end} ({days} days)   deliveries {len(deliveries)}")
    print(f"{'route':32s} {'n':>4s} {'bytes':>10s}")
    for k, v in routes.most_common():
        print(f"{k:32s} {v:4d} {route_bytes[k]:10d}")
    print(f"\nintent: {dict(intent)} — incidental is a floor, see scan()")

    bwt = byte_turns / delivered
    cost = price(byte_turns)
    denom_parent = window_cost(start, end, spend)
    denom_all = grossed_up(denom_parent)
    print(f"\ndelivered {delivered} B, byte-weighted turns-after {bwt:.1f}")
    print(f"measured re-read cost-equivalent ${cost:.0f}")
    print(
        f"  of parent-only window spend (${denom_parent:.0f}): {cost / denom_parent * 100:.2f}%"
    )
    print(
        f"  of spend grossed up for fan-out (${denom_all:.0f}): {cost / denom_all * 100:.2f}%"
    )
    print(f"  scan {tc.counts_line(tally)}; spend {tc.counts_line(spend)}")

    # A command rarely delivers the whole of what it matched — `head -c`, `cut`
    # and `--stat` all truncate — and it usually matches one bullet of §5 rather
    # than all of it (mantahostels#1430).
    sizes = sizes_by_date(start, end)
    exposed = sum(sizes.get(d, 0) for d, _, _ in deliveries)
    frac = delivered / exposed if exposed else 1.0
    now_b = ledger_bytes_at()
    slope = growth_per_day(sizes)
    per_day_counts = Counter(d for d, _, _ in deliveries)
    per_day = len(deliveries) / days
    lo, hi = min(per_day_counts.values()), max(per_day_counts.values())

    print(
        f"\n§5 bullets today {now_b} B, growing {slope:+.0f} B/day (least squares over the window)"
    )
    print(
        f"{per_day:.1f} deliveries/day (range {lo}-{hi}); {frac:.1%} of §5 lands per delivery"
    )

    def fwd(size, n_per_day):
        return price(n_per_day * size * frac * bwt)

    base = fwd(now_b, per_day)
    print(
        f"forward ${base:.1f}/day = ${base * 7:.0f}/week-equivalent"
        f"  (band ${fwd(now_b, lo) * 7:.0f}-${fwd(now_b, hi) * 7:.0f}/week on the delivery-rate spread)"
    )
    print(f"  {base / (denom_all / days) * 100:.2f}% of spend at the window's rate")
    for horizon in (30, 90):
        c = fwd(now_b + slope * horizon, per_day)
        print(
            f"  at {horizon} days of {slope:+.0f} B/day: §5 {now_b + slope * horizon:.0f} B, "
            f"${c:.0f}/day, {c / (denom_all / days) * 100:.1f}% of spend"
        )


if __name__ == "__main__":
    main()
