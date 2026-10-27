#!/usr/bin/env python3
r"""scan_docmap_denials.py — denial events on the doc-map family, per day, over one window.

Counting rule, kept identical to mantahostels#2409's:
  - both transcript tiers, top-level and subagent, on every seat root (#379)
  - a denial is `buildDenyReason()`'s fixed string `is held by session`
    (scripts/session-arbiter.js:226)
  - the subject counted is the one actually HELD, which is not always the one
    asked for (mantahostels#970)
  - events dedupe per (transcript, subject, minute)

Re-validated against mantahostels#2409's three published rows at mantahostels#2621, which carries the
comparison. It reproduces region and sidecar and reads whole-file a third under,
in every window — the one bucket mantahostels#2430 argues mantahostels#2409's regex inflated by counting
the deny string as this repo's test files write it out. mantahostels#2621's two fixes did
not close that gap, so report against BOTH whole-file baselines (mantahostels#2430): 21.9/day
as published, and 14.6/day recomputed here.

  scan_docmap_denials.py --from 2026-09-08T11:02:33Z [--to <iso>]
"""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

# The subject actually held, anchored on the two prefixes a real denial puts in
# front of it — a bare `(\\S+) is held` also matches a session READING
# session-arbiter.js's source.
# A subject never contains a `"`, so excluding one keeps the match off a raw
# hook payload, whose `{"hookSpecificOutput":…` runs unbroken into the subject.
ANCHOR = r'(?:^|session-arbiter: |it is covered: )([^\s"]+) is held by session '
HELD = re.compile(ANCHOR, re.M)
# A denial minted by a live arbiter names when its holder took the claim, off
# the lock's `claimedAt` (session-arbiter.js:189), and the two echo shapes this
# corpus actually carries both stop at the holder id: this repo's test fixtures,
# and an earlier measurement's tabulated output read back into a later
# transcript. So the trailer, not the field the string arrived in, is what
# separates them from a real denial — the grep and the tool result reach the
# transcript by the same route (mantahostels#2621).
#
# It is a proxy, and it fails both ways. A denial quoted in FULL — from a review
# artefact, an issue comment, a diagnostic's own output — keeps its trailer and
# is counted as an event of the session that read it, so a run of this scan that
# prints its own matches seeds the next window. In the other direction a trailer
# cut off by truncation drops a real denial, as does a lock carrying no
# `claimedAt` — none is known to exist.
LIVE = re.compile(ANCHOR + r"[^\n]*? since \d{4}-\d\d-\d\dT\d\d:\d\d", re.M)
# The deny payload `session-arbiter.js check` writes to stdout (:551), which the
# Write/Edit hook consumes — so what reaches a TRANSCRIPT under this key is a
# session running `check` by hand from Bash. That is a refusal of the same
# subject to the same session, `check` being claim as well as check, so it is
# counted; but it is a pre-flight, not a blocked edit, and mantahostels#2409's rule does not
# say which it meant.
#
# The reason is read without the trailer, which is what recovers one the
# transcript truncated mid-string. Admitting a leading `"` in ANCHOR instead
# would readmit every quote-prefixed source echo, the hole that inflated mantahostels#2409's
# own count (mantahostels#2430).
REASON_AT = re.compile(r'"permissionDecisionReason"\s*:\s*"')
MAP = "docs/doc-map.md"
SIDECAR = "docs/doc-map-classes.json"


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def strings(node):
    """Every string value in a transcript record, at any depth."""
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [s for v in node.values() for s in strings(v)]
    if isinstance(node, list):
        return [s for v in node for s in strings(v)]
    return []


def hook_reasons(blob):
    """Every `permissionDecisionReason` this string carries, decoded.

    A hook's payload reaches a session as JSON inside a JSON string, so the
    reason's own newlines are escaped and ANCHOR's `^` never sees the subject.
    A payload the transcript truncated has no closing quote and may end on a
    half-escape, which `json.loads` refuses; it still leads with the subject,
    so it is unescaped by hand rather than dropped (mantahostels#2621).
    """
    for m in REASON_AT.finditer(blob):
        rest = blob[m.end() :]
        i = 0
        while i < len(rest):
            if rest[i] == "\\":
                i += 2
                continue
            if rest[i] == '"':
                break
            i += 1
        raw = rest[:i]
        try:
            yield json.loads(f'"{raw}"')
        except ValueError:
            yield raw.replace("\\n", "\n").replace('\\"', '"')


def held_subjects(blob):
    """Each subject a real denial in this string names, once.

    An untruncated hook payload matches on both routes — `it is covered: `
    satisfies ANCHOR inside the raw JSON and the decoded reason satisfies it
    again — so the routes are unioned rather than concatenated. scan()'s own
    dedupe hides that from the counts; a caller reading this directly would see
    it.
    """
    seen = []
    for subject in list(LIVE.findall(blob)) + [
        s for reason in hook_reasons(blob) for s in HELD.findall(reason)
    ]:
        if subject not in seen:
            seen.append(subject)
    return seen


def bucket(subject):
    """region / whole-file / sidecar, or None for a subject off the family."""
    if subject == MAP:
        return "whole-file"
    if subject.startswith(MAP + "#"):
        return "region"
    if subject == SIDECAR or subject.startswith(SIDECAR + "#"):
        return "sidecar"
    return None


def scan(start, end, tally):
    """(denial events in the window, transcripts listed).

    `tally` is the caller's accumulator, which `main` prints: it receives
    `tc.records`'s skip counts and `undated records`, those with no parsable
    timestamp (#1274).
    """
    files = tc.all_transcripts()
    events = set()
    for path in files:
        for rec in tc.records(path, tally, needle="is held by session"):
            ts = rec.get("timestamp") or ""
            try:
                when = parse_iso(ts)
            except ValueError:
                tally["undated records"] += 1
                continue
            if not (start <= when < end):
                continue
            # A denial reaches a session by three routes — a tool result, a
            # hook's `permissionDecisionReason`, and injected context — so
            # every string in the record is read rather than three named
            # fields. Assistant records are skipped: a session writing ABOUT
            # a denial is not one.
            if rec.get("type") == "assistant":
                continue
            for blob in strings(rec):
                for subject in held_subjects(blob):
                    if bucket(subject) is None:
                        continue
                    events.add((path, subject, when.strftime("%Y-%m-%dT%H:%M")))
    return events, len(files)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", default=None)
    args = ap.parse_args()
    start = parse_iso(args.start)
    end = parse_iso(args.end) if args.end else datetime.now(timezone.utc)
    days = (end - start).total_seconds() / 86400
    if days <= 0:
        sys.exit("empty window")

    tally = Counter()
    events, nfiles = scan(start, end, tally)
    counts = {"region": 0, "whole-file": 0, "sidecar": 0}
    for _, subject, _ in events:
        counts[bucket(subject)] += 1
    total = sum(counts.values())

    # mantahostels#2409's post-§A baseline. It published no per-day sidecar rate, though its
    # 8 sidecar events are inside the 33.2 total.
    base = {"region": 8.8, "whole-file": 21.9, "sidecar": None, "total": 33.2}

    print(f"window  {start.isoformat()} .. {end.isoformat()}  ({days:.2f} days)")
    print(
        f"corpus  {nfiles} transcripts, both tiers  "
        f"{tc.counts_line(tally, tc.UNREADABLE, tc.UNPARSED, 'undated records')}"
    )
    print(f"{'bucket':12}{'events':>8}{'per day':>10}{'baseline':>10}{'change':>9}")
    for k in ("region", "whole-file", "sidecar"):
        rate = counts[k] / days
        b = base[k]
        chg = f"{(rate / b - 1) * 100:+.0f}%" if b else "—"
        shown = f"{b:.1f}" if b else "n/a"
        print(f"{k:12}{counts[k]:8d}{rate:10.1f}{shown:>10}{chg:>9}")
    print(
        f"{'TOTAL':12}{total:8d}{total / days:10.1f}{base['total']:10.1f}"
        f"{(total / days / base['total'] - 1) * 100:+8.0f}%"
    )

    # The founder's ruling on mantahostels#2430 is to report whole-file against both
    # baselines, so the rival is printed rather than left to be worked out.
    rival = 14.6
    whole = counts["whole-file"] / days
    print(
        f"\nwhole-file vs the recomputed baseline: {whole:.1f} against {rival}/day"
        f" ({(whole / rival - 1) * 100:+.0f}%) — report BOTH (mantahostels#2430)"
    )


if __name__ == "__main__":
    main()
