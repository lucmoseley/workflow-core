#!/usr/bin/env python3
"""measure.py — doc-map claim-denial rate, measured off the session transcripts (mantahostels#1761).

Why not the prescribed one-liner. mantahostels#1761's Instrument section counts every
transcript line carrying `is held by session` and `docs/doc-map.md`. Measured
28 Aug 2026, 609 of those lines are matches and only 445 are denials: the rest
are file dumps of session-arbiter.js, code-review prompts, context summaries,
vitest failures and prior sessions quoting a denial back. It also counts the
MEASURING session's own reads of the corpus. Both inflations are removed here.

A denial is a tool result that either (a) carries denyReason()'s invariant
paragraph ("A claim is taken by writing the file") alongside the deny sentence
-- the PreToolUse hook route -- or (b) opens with `session-arbiter: <path> is
held by session` -- the CLI route, whose output is too short to carry (a).

Events are deduped on (second-resolution timestamp, denied session).

Denominator is session density: transcripts whose own first/last timestamps
overlap the window. Volume is not the cause and must not be read as it (mantahostels#1413).

Every seat root's main transcripts are read, one copy of each session (#379);
`--base DIR` reads one directory instead.

Usage:  python3 measure.py [--base DIR] [--self SESSION_UUID]
"""

import argparse
import collections
import json
import math
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

DENY = re.compile(
    r"(\S*docs/doc-map\.md\S*) (?:is held by session|cannot be claimed while it is covered)"
)
CLI = re.compile(
    r"^(?:Exit code \d+\s*|rc=\d+\s*)?session-arbiter: (\S*docs/doc-map\.md\S*) (?:is held by session|cannot be claimed)",
    re.M,
)
HOOK_MARK = "A claim is taken by writing the file"
ESCALATION = "This write claims the WHOLE of docs/doc-map.md"


def contents(rec):
    """Every tool-result string on a transcript record, both shapes it takes."""
    out = []
    c = (rec.get("message") or {}).get("content")
    if isinstance(c, str):
        out.append(c)
    elif isinstance(c, list):
        for b in c:
            if not isinstance(b, dict):
                continue
            cc = b.get("content")
            if isinstance(cc, str):
                out.append(cc)
            elif isinstance(cc, list):
                out += [
                    x["text"]
                    for x in cc
                    if isinstance(x, dict) and isinstance(x.get("text"), str)
                ]
    t = rec.get("toolUseResult")
    if isinstance(t, str):
        out.append(t)
    return out


def main_files(base=None):
    """`base`'s main transcripts, or every seat root's where it is None."""
    return [p for p, _ in tc.files(base, subagents=False)]


def scan(files, self_session, tally):
    """`tally` is the caller's accumulator, which `main` prints: a matched
    line that will not parse is skipped and counted into `tally[tc.UNPARSED]`
    (#1274). Every line is read for its timestamp, so `tc.records` and its
    needle cannot stand in here."""
    events, spans = [], []
    for path in files:
        first = last = None
        for line in open(path, errors="replace"):
            m = re.search(r'"timestamp":"([^"]+)"', line)
            if m:
                first = first or m.group(1)
                last = m.group(1)
            if "is held by session" not in line or "docs/doc-map.md" not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                tally[tc.UNPARSED] += 1
                continue
            if rec.get("sessionId") == self_session:
                continue
            txt = "\n".join(contents(rec))
            hit, route = None, None
            if HOOK_MARK in txt and DENY.search(txt):
                hit, route = DENY.search(txt), "hook"
            elif CLI.search(txt):
                hit, route = CLI.search(txt), "cli"
            if not hit or not hit.group(1).startswith("docs/doc-map.md"):
                continue  # a transcript quoting a denial inside a JSON blob
            events.append(
                {
                    "ts": rec.get("timestamp", ""),
                    "sess": rec.get("sessionId"),
                    "subj": hit.group(1),
                    "route": route,
                    "escalation": ESCALATION in txt,
                }
            )
        if first and last:
            spans.append((min(first, last), max(first, last)))
    seen, deduped = set(), []
    for e in sorted(events, key=lambda x: x["ts"]):
        k = (e["ts"][:19], e["sess"])
        if k not in seen:
            seen.add(k)
            deduped.append(e)
    return deduped, spans


def subject_class(s):
    if s == "docs/doc-map.md":
        return "whole-file"
    if re.match(r"docs/doc-map\.md#B\d+$", s):
        return "B-entry"
    if s.startswith("docs/doc-map.md#A:"):
        return "A-row"
    return "region:" + s.split("#")[-1][:28]


def class_breakdown(rs):
    """Per subject-class event and episode counts, plus route and escalation
    mix, one entry per class.

    An episode is one (session, class) pair, so one session's serial retries
    inflate its event share without touching anyone else's -- the cut mantahostels#1031's
    criterion (2) is judged on, not events alone (mantahostels#2430).
    """
    events_by_class = collections.Counter(subject_class(e["subj"]) for e in rs)
    episode_pairs = {(e["sess"], subject_class(e["subj"])) for e in rs}
    episodes_by_class = collections.Counter(cls for _, cls in episode_pairs)
    routes_by_class = collections.defaultdict(collections.Counter)
    escalations_by_class = collections.Counter()
    for e in rs:
        cls = subject_class(e["subj"])
        routes_by_class[cls][e["route"]] += 1
        if e["escalation"]:
            escalations_by_class[cls] += 1
    return events_by_class, episodes_by_class, routes_by_class, escalations_by_class


def window(events, spans, w0, w1):
    n = [e for e in events if w0 <= e["ts"] < w1]
    active = sum(1 for a, b in spans if a < w1 and b > w0)
    return n, active


def rate_ratio(n1, e1, n0, e0):
    """Poisson rate ratio and its 95% band. Ignores day-level overdispersion,
    the dominant variance term here -- see mantahostels#1761's answer, closing paragraphs
    of the headline-rate section."""
    r = (n1 / e1) / (n0 / e0)
    se = math.sqrt(1 / n1 + 1 / n0)
    return r, math.exp(math.log(r) - 1.96 * se), math.exp(math.log(r) + 1.96 * se)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="one transcripts directory; default every seat root")
    ap.add_argument(
        "--self", dest="self_session", default=os.environ.get("CLAUDE_SESSION_ID")
    )
    ap.add_argument("--split", default="2026-08-28T02:27", help="fix landed at")
    ap.add_argument(
        "--band", default="02:27-14:00", help="UTC hours to compare like with like"
    )
    a = ap.parse_args()

    tally = collections.Counter()
    events, spans = scan(main_files(a.base), a.self_session, tally)
    print(
        f"denial events: {len(events)}   transcripts spanned: {len(spans)}"
        f"   {tc.counts_line(tally, tc.UNPARSED)}"
    )

    by_day = collections.Counter(e["ts"][:10] for e in events)
    lo, hi = a.band.split("-")
    print("\nday        events  active  per-session   (band %s UTC)" % a.band)
    rows = []
    for day in sorted(by_day):
        n, act = window(events, spans, f"{day}T{lo}", f"{day}T{hi}")
        if not act:
            continue
        rows.append((day, len(n), act))
        print(f"{day}  {len(n):5d}  {act:6d}   {len(n) / act:.3f}")

    pre = [r for r in rows if f"{r[0]}T{hi}" <= a.split]
    post = [r for r in rows if f"{r[0]}T{lo}" >= a.split]
    if pre and post:
        n0, e0 = sum(r[1] for r in pre), sum(r[2] for r in pre)
        n1, e1 = sum(r[1] for r in post), sum(r[2] for r in post)
        r, lo_, hi_ = rate_ratio(n1, e1, n0, e0)
        print(f"\npre  {n0}/{e0} = {n0 / e0:.3f}   post {n1}/{e1} = {n1 / e1:.3f}")
        print(f"rate ratio {r:.2f} (95% Poisson band {lo_:.2f}-{hi_:.2f})")
        daily = [x[1] / x[2] for x in pre]
        mean = sum(daily) / len(daily)
        sd = (sum((d - mean) ** 2 for d in daily) / (len(daily) - 1)) ** 0.5
        print(
            f"pre-fix DAY-level mean {mean:.3f} sd {sd:.3f} over {len(daily)} days"
            f"  -> post sits {(n1 / e1 - mean) / sd:+.2f} sd from it"
        )

    print("\nsubject mix")
    for label, rs in (
        ("pre", [e for e in events if e["ts"] < a.split]),
        ("post", [e for e in events if e["ts"] >= a.split]),
    ):
        by_events, by_episodes, by_route, by_escalation = class_breakdown(rs)
        n_episodes = sum(by_episodes.values())
        esc = sum(1 for e in rs if e["escalation"])
        print(
            f"  {label}: n={len(rs)} episodes={n_episodes} "
            f"whole-file-escalation-warnings={esc} "
            f"routes={dict(collections.Counter(e['route'] for e in rs))}"
        )
        print(
            f"      {'class':34s}{'events':>8}{'ev%':>7}{'episodes':>10}{'ep%':>7}"
            f"  {'esc':>4}  route"
        )
        for k, ep in by_episodes.most_common():
            v = by_events[k]
            ev_pct = f"{v / len(rs) * 100:.1f}" if rs else "—"
            ep_pct = f"{ep / n_episodes * 100:.1f}" if n_episodes else "—"
            route_mix = dict(by_route[k])
            print(
                f"      {k:34s}{v:8d}{ev_pct:>7}{ep:10d}{ep_pct:>7}"
                f"  {by_escalation[k]:>4d}  {route_mix}"
            )


if __name__ == "__main__":
    main()
