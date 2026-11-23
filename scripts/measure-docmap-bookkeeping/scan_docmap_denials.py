#!/usr/bin/env python3

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc
from fail_open import expected, tallied

ANCHOR = r'(?:^|session-arbiter: |it is covered: )([^\s"]+) is held by session '
HELD = re.compile(ANCHOR, re.M)
LIVE = re.compile(ANCHOR + r"[^\n]*? since \d{4}-\d\d-\d\dT\d\d:\d\d", re.M)
REASON_AT = re.compile(r'"permissionDecisionReason"\s*:\s*"')
MAP = "docs/doc-map.md"
SIDECAR = "docs/doc-map-classes.json"


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def strings(node):
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [s for v in node.values() for s in strings(v)]
    if isinstance(node, list):
        return [s for v in node for s in strings(v)]
    return []


def hook_reasons(blob):
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
        except json.JSONDecodeError as e:
            expected(e, "a reason the transcript truncated, unescaped by hand")
            yield raw.replace("\\n", "\n").replace('\\"', '"')


def held_subjects(blob):
    seen = []
    for subject in list(LIVE.findall(blob)) + [
        s for reason in hook_reasons(blob) for s in HELD.findall(reason)
    ]:
        if subject not in seen:
            seen.append(subject)
    return seen


def bucket(subject):
    if subject == MAP:
        return "whole-file"
    if subject.startswith(MAP + "#"):
        return "region"
    if subject == SIDECAR or subject.startswith(SIDECAR + "#"):
        return "sidecar"
    return None


def scan(start, end, tally):
    files = tc.all_transcripts()
    events = set()
    for path in files:
        for rec in tc.records(path, tally, needle="is held by session"):
            ts = rec.get("timestamp") or ""
            try:
                when = parse_iso(ts)
            except ValueError as e:
                tallied(e, tally, "undated records")
                continue
            if not (start <= when < end):
                continue
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

    # measured 14.6/day whole-file, the recomputed baseline, lucmoseley/mantahostels#2430
    rival = 14.6
    whole = counts["whole-file"] / days
    print(
        f"\nwhole-file vs the recomputed baseline: {whole:.1f} against {rival}/day"
        f" ({(whole / rival - 1) * 100:+.0f}%) — report BOTH (mantahostels#2430)"
    )


if __name__ == "__main__":
    main()
