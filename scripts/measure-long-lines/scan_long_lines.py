#!/usr/bin/env python3
"""scan_long_lines.py — mantahostels#1431: which tracked documents hide a physical line
long enough that a line-oriented read aimed at something else delivers it wholesale.

Prior art, hard-coded to one needle: `scripts/measure-shed-ledger/scan_ledger.py`
(mantahostels#1407). Here the candidate set is discovered: every physical line at or
above `--min-line` bytes in the mapped scope (`docs/`, `.claude/`, `AGENTS.md`,
`CLAUDE.md`, `PRODUCT.md`, `DESIGN.md`), each given a needle taken from its own
text, then all of them counted in one pass over the transcript corpus.

Validated against mantahostels#1407.

Four bounds. Two understate: subagent transcripts are not scanned, and an
occurrence outside a `tool_result` — an `Agent` dispatch prompt, say — is not
counted. One overstates, making every cost a ceiling: a turn after a context
compaction has dropped the delivery is still charged for re-reading it. The
fourth cuts either way — the candidate set is today's tree matched against a
past window, so a line deleted or renamed since is invisible, and a line whose
opening changed mid-window is undercounted.
"""

import argparse
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
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

SCOPE = ["docs", ".claude", "AGENTS.md", "CLAUDE.md", "PRODUCT.md", "DESIGN.md"]

# Extensions that are binary but survive a NUL test over the first 8 KB — a
# PDF's compressed streams start well past it, so `trademark-clearance-brief.pdf`
# otherwise enters the table with a needle of decompression garbage.
SKIP_EXT = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ttf",
    ".woff",
    ".woff2",
    ".xlsx",
    ".zip",
    ".ico",
    ".webp",
}

# A needle carries no quote and no backslash, so it survives JSON encoding
# unchanged and can be found in a raw transcript line. Length is not fixed: it
# starts short, because the line may be *edited* mid-window and only its opening
# is stable, then grows until the needle is unique across every in-scope file.
# The start length and the steps are guesses; no collision rate was measured.
NEEDLE_STEPS = (32, 48, 64, 96, 128, 192)
NEEDLE_MIN = NEEDLE_STEPS[0]


def readable_text(path, tally):
    """Whether `path` is a text file to read. `tally` is the caller's
    accumulator: a file that will not open is counted into it."""
    if os.path.splitext(path)[1].lower() in SKIP_EXT:
        return False
    try:
        with open(os.path.join(REPO, path), "rb") as fh:
            head = fh.read(8192)
    except OSError:
        # Skipped so one bad file cannot sink the window, and printed by `main`
        # (#1274).
        tally["unreadable repo files"] += 1
        return False
    return b"\0" not in head


def opening_runs(line, limit=400):
    """Quote-free, backslash-free runs in the line's opening, in order.

    The 400-byte opening and the 24-byte shortest run are guesses, like
    NEEDLE_STEPS."""
    return [r.strip() for r in re.split(r'["\\]', line[:limit]) if len(r.strip()) >= 24]


def card_id_for(lines, idx):
    """Nearest preceding roadmap card id, so intent can be tested against it."""
    for j in range(idx, max(-1, idx - 12), -1):
        m = re.search(r'\{id:"([a-z0-9-]+)"', lines[j])
        if m:
            return m.group(1)
    return None


def candidates(min_line, tally):
    """Every line at or above `min_line` bytes, each with a unique needle.

    Uniqueness is tested against the whole text of every in-scope file, not just
    against the other candidates: a needle that collides with ordinary prose
    charges that prose's bytes to this line, silently.

    `tally` is the caller's accumulator: unreadable files are counted into it.
    """
    blobs = {}
    for path in git("ls-files", *SCOPE).split("\n"):
        path = path.strip()
        if not path or not os.path.isfile(os.path.join(REPO, path)):
            continue
        if not readable_text(path, tally):
            continue
        try:
            blobs[path] = open(os.path.join(REPO, path), errors="replace").read()
        except OSError:
            # As `readable_text` (#1274).
            tally["unreadable repo files"] += 1
            continue
    corpus = "\n".join(blobs.values())

    out, dropped = [], []
    for path, text in blobs.items():
        lines = text.split("\n")
        for i, line in enumerate(lines):
            nbytes = len(line.encode("utf-8", "replace"))
            if nbytes < min_line:
                continue
            head = opening_runs(line)
            if not head:
                dropped.append((path, i + 1, "no quote-free run in the line's opening"))
                continue
            needle = next(
                (
                    head[0][:n]
                    for n in NEEDLE_STEPS
                    if len(head[0][:n]) >= NEEDLE_MIN and corpus.count(head[0][:n]) == 1
                ),
                None,
            )
            if not needle:
                dropped.append((path, i + 1, "no unique needle at any length"))
                continue
            out.append(
                {
                    "path": path,
                    "lineno": i + 1,
                    "bytes": nbytes,
                    "needle": needle,
                    "card": card_id_for(lines, i) if path.endswith(".html") else None,
                    # Intent words come from the line's opening, not the needle:
                    # the needle is truncated to whatever length made it unique,
                    # which can cut a word in half and lose the term a session
                    # would actually have grepped for.
                    "words": sorted(
                        {w for w in re.findall(r"[a-z]{5,}", line[:300].lower())}
                    ),
                }
            )
    return out, dropped


def classify(res, path):
    route = tool_route(res.name, res.input)
    if route:
        return route
    cmd = res.command
    base = os.path.basename(path)
    if base not in cmd and os.path.splitext(base)[0] not in cmd:
        return "Bash, not a read of that file"
    return bash_read_kind(cmd)


def intent_of(cand, res, route):
    """Did the session ask for this line, or did it arrive as collateral?

    Lexical, and it errs in **both** directions, so it is not a floor. It
    over-counts *deliberate*
    because it matches the whole tool input, not the command alone. It would
    over-count *incidental* on a whole-file `Read`, which carries only a path
    and so can match no content word; that route is left unclassified instead.
    """
    if route.startswith("Read (whole"):
        return "unclassified"
    hay = intent_text(res)
    if cand["card"] and cand["card"] in hay:
        return "deliberate"
    return "deliberate" if any(w in hay for w in cand["words"]) else "incidental"


def scan(cands, start, end, tally):
    by_key = defaultdict(
        lambda: {
            "n": 0,
            "bytes": 0,
            "byte_turns": 0,
            "routes": Counter(),
            "intent": Counter(),
            "sessions": set(),
            "deliveries": [],
        }
    )

    def find(raw):
        return [c for c in cands if c["needle"] in raw]

    for fp, present, recs in parent_transcripts(tally, find):
        after = suffix_distinct_turns(recs)
        sess = os.path.basename(fp)[:-6]
        for res in tool_results(recs, start, end):
            for cand in present:
                needle = cand["needle"]
                if needle not in res.text:
                    continue
                landed = landed_bytes(res.text, lambda s, n=needle: n in s)
                route = classify(res, cand["path"])
                e = by_key[(cand["path"], cand["lineno"])]
                e["n"] += 1
                e["bytes"] += landed
                e["byte_turns"] += landed * after[res.pos + 1]
                e["routes"][route] += 1
                e["intent"][intent_of(cand, res, route)] += 1
                e["sessions"].add(sess)
                e["deliveries"].append((res.timestamp[:10], landed))
        del recs
    return by_key


def sizes_by_date(cands, start, end, tally):
    """Each candidate line's size at the end of each day in the window.

    A delivery is charged against the line as it stood *that day*, not as it
    stands today. Lines are found by needle rather than by number, so this
    survives the edits that shift every line below them.

    `tally` is the caller's accumulator: a revision git will not show is
    counted into it.
    """
    by_path = defaultdict(list)
    for c in cands:
        by_path[c["path"]].append(c)
    sizes = defaultdict(dict)
    for day in window_days(start, end):
        for path, group in by_path.items():
            sha = revision_on(day, path)
            if not sha:
                continue
            try:
                blob = git("show", f"{sha}:{path}")
            except subprocess.CalledProcessError:
                # The day then prices at today's size, the fallback in `main`;
                # counted so the substitution is seen (#1274).
                tally["unshown revisions"] += 1
                continue
            for line in blob.split("\n"):
                for c in group:
                    if c["needle"] in line:
                        sizes[(path, c["lineno"])][day] = len(
                            line.encode("utf-8", "replace")
                        )
    return sizes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", nargs=2, default=["2026-08-20", "2026-08-25"])
    # A guess, never measured against a read's own cut-off.
    ap.add_argument("--min-line", type=int, default=4000)
    ap.add_argument("--list-only", action="store_true")
    ap.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="PATH:LINE",
        help="report a second total without this line — for one already being fixed",
    )
    args = ap.parse_args()
    start, end = args.window
    days = len(window_days(start, end))

    tally, spend = Counter(), Counter()
    cands, dropped = candidates(args.min_line, tally)
    cands.sort(key=lambda c: -c["bytes"])
    print(
        f"{len(cands)} candidate lines at >= {args.min_line} B "
        f"({len(dropped)} dropped for want of a unique needle; unreadable repo "
        f"files: {tally['unreadable repo files']})\n"
    )
    for c in cands:
        print(
            f"  {c['bytes']:8d} B  {c['path']}:{c['lineno']}"
            f"{'  card=' + c['card'] if c['card'] else ''}"
        )
    for path, lineno, why in dropped:
        print(f"  DROPPED   {path}:{lineno} — {why}")
    if args.list_only:
        return
    if not cands:
        sys.exit("no candidate lines: nothing to price")

    by_key = scan(cands, start, end, tally)
    if not by_key:
        sys.exit(
            "no deliveries in window — a $0 total here is a broken scan, not a finding"
        )
    sizes = sizes_by_date(cands, start, end, tally)
    denom_parent = window_cost(start, end, spend)
    if denom_parent <= 0:
        sys.exit("window carries no billed turns: the denominator would be zero")
    denom_all = grossed_up(denom_parent)
    daily_spend = denom_all / days

    print(
        f"\nwindow {start}..{end} ({days} days); parent spend ${denom_parent:.0f}, "
        f"grossed up for fan-out ${denom_all:.0f}"
    )
    print(
        f"scan {tc.counts_line(tally, tc.UNREADABLE, tc.UNPARSED, 'unshown revisions')}; "
        f"spend {tc.counts_line(spend)}\n"
    )

    excluded = set(args.exclude)
    rows, totals = [], Counter()
    for c in cands:
        key = (c["path"], c["lineno"])
        e = by_key.get(key)
        if not e:
            continue
        cost = price(e["byte_turns"])
        # mantahostels#1407's forward model, not an extrapolation of the window cost: the
        # delivery rate and the landed *fraction* carry forward, the line's size
        # does not — it is taken as it stands today.
        exposed = sum(sizes[key].get(day, c["bytes"]) for day, _ in e["deliveries"])
        frac = min(e["bytes"] / exposed, 1.0) if exposed else 1.0
        bwt = e["byte_turns"] / e["bytes"] if e["bytes"] else 0.0
        per_day = e["n"] / days
        fwd_daily = price(per_day * c["bytes"] * frac * bwt)
        slope = growth_per_day(sizes.get(key, {}))
        rows.append((fwd_daily, c, e, cost, frac, bwt, slope, per_day))
        tag = "excl" if f"{c['path']}:{c['lineno']}" in excluded else "incl"
        totals[f"{tag}_window"] += cost
        totals[f"{tag}_fwd"] += fwd_daily
        totals[f"{tag}_growth"] += slope

    rows.sort(key=lambda r: -r[0])
    for fwd_daily, c, e, cost, frac, _bwt, slope, per_day in rows:
        inc = e["intent"]["incidental"]
        classified = inc + e["intent"]["deliberate"]
        share = f"{inc / classified:.0%}" if classified else "n/a"
        print(
            f"{c['path']}:{c['lineno']}  {c['bytes']} B"
            f"{'  card=' + c['card'] if c['card'] else ''}"
        )
        print(
            f"  deliveries {e['n']} across {len(e['sessions'])} sessions "
            f"({per_day:.1f}/day); {e['bytes']} B landed, {frac:.0%} of the line "
            f"as it stood on the day"
        )
        print(
            f"  incidental {inc}/{classified} classified ({share} — errs both "
            f"ways, see intent_of)"
        )
        print(
            f"  window ${cost:.2f} ({cost / denom_all * 100:.3f}% of spend); "
            f"forward ${fwd_daily * 7:.1f}/week-equivalent "
            f"({fwd_daily / daily_spend * 100:.3f}% of spend); "
            f"growth {slope:+.0f} B/day"
        )
        print(f"  routes: {dict(e['routes'])}\n")

    by_file = defaultdict(lambda: [0, 0.0, 0.0])
    for fwd_daily, c, _e, cost, *_ in rows:
        agg = by_file[c["path"]]
        agg[0] += 1
        agg[1] += cost
        agg[2] += fwd_daily
    print("by file:")
    for path, (n, cost, fwd) in sorted(by_file.items(), key=lambda kv: -kv[1][2]):
        print(
            f"  {path:44s} {n:3d} lines  window ${cost:7.2f}  "
            f"forward ${fwd * 7:6.1f}/week ({fwd / daily_spend * 100:.3f}%)"
        )

    def report(label, w, f, g):
        print(
            f"\n{label}: window ${w:.2f} ({w / denom_all * 100:.3f}% of spend); "
            f"forward ${f * 7:.0f}/week-equivalent "
            f"({f / daily_spend * 100:.3f}% of spend); "
            f"combined growth {g:+.0f} B/day"
        )

    report(
        "TOTAL, all candidate lines",
        totals["incl_window"] + totals["excl_window"],
        totals["incl_fwd"] + totals["excl_fwd"],
        totals["incl_growth"] + totals["excl_growth"],
    )
    if excluded:
        report(
            f"TOTAL, excluding {', '.join(sorted(excluded))}",
            totals["incl_window"],
            totals["incl_fwd"],
            totals["incl_growth"],
        )


if __name__ == "__main__":
    main()
