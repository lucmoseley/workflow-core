#!/usr/bin/env python3
"""measure.py — measure turns-remaining-past-threshold distribution across this
repo's Claude Code transcripts on every seat (#379), for issue mantahostels#1546 (wayfinder
map mantahostels#1542).

Streams each jsonl line-by-line (never loads a whole file into memory).
"""

import re
import os
import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

# The candidate ceilings mantahostels#1546 priced: 150,000 is the figure mantahostels#1544
# tested, 200,000 mantahostels#1094's bundle stop, 100,000 a point in mantahostels#1544's
# 60k-120k band. That pairing is inferred from those tickets; nothing records
# why these three. https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-ceiling-firing-rates.md.
THRESHOLDS = [100_000, 150_000, 200_000]
# WFC_SESSIONS_CSV is set by hand by whoever runs the measurement, to keep
# the CSV out of the working directory: no test fills it (base §G7).
OUT_CSV = os.environ.get("WFC_SESSIONS_CSV", "sessions.csv")

CMD_RE = re.compile(r"<command-name>/([a-zA-Z0-9_-]+)</command-name>")
NAMED_RE = re.compile(r'named this session "([^"]+)"')
SECURITY_RE = re.compile(r"Review this change for security vulnerabilities")


def classify_kind(entrypoint, session_kind, first_user_text, is_subagent):
    if is_subagent:
        return "subagent"
    if entrypoint == "sdk-py":
        return "sdk-py"
    if session_kind == "bg":
        # try to refine bg kind by command/name too
        base = "background"
        m = CMD_RE.search(first_user_text or "")
        if m:
            return f"background:/{m.group(1)}"
        return base
    if first_user_text:
        m = CMD_RE.search(first_user_text)
        if m:
            return f"/{m.group(1)}"
        m = NAMED_RE.search(first_user_text)
        if m:
            name = m.group(1)
            first_word = name.split()[0].rstrip(":").lower()
            if first_word in ("implement", "wayfinder", "grilling", "triage"):
                return f"named:{first_word}"
            return "named:other"
        if SECURITY_RE.search(first_user_text):
            return "security-review-hook"
    return "unclassified"


def get_first_user_text(msg_content):
    if isinstance(msg_content, list):
        parts = []
        for c in msg_content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text", ""))
        return " ".join(parts)
    if isinstance(msg_content, str):
        return msg_content
    return ""


def process_file(path, is_subagent, tally):
    entrypoint = None
    session_kind = None
    first_user_text = None
    got_first_user = False
    turn_idx = 0
    crossing_turn = {t: None for t in THRESHOLDS}
    compactions = 0
    first_ts = None
    last_ts = None
    total_output_tokens = 0
    max_context = 0

    for o in tc.records(path, tally):
        if entrypoint is None and o.get("entrypoint"):
            entrypoint = o.get("entrypoint")
        if session_kind is None and o.get("sessionKind"):
            session_kind = o.get("sessionKind")

        ts = o.get("timestamp")
        if ts:
            if first_ts is None:
                first_ts = ts
            last_ts = ts

        otype = o.get("type")

        if not got_first_user and otype == "user":
            msg = o.get("message", {})
            if msg.get("role") == "user":
                first_user_text = get_first_user_text(msg.get("content"))
                got_first_user = True

        if otype == "system" and o.get("subtype") == "compact_boundary":
            compactions += 1

        if otype == "assistant":
            msg = o.get("message", {})
            usage = msg.get("usage")
            if not usage:
                continue
            turn_idx += 1
            inp = usage.get("input_tokens", 0) or 0
            cc = usage.get("cache_creation_input_tokens", 0) or 0
            cr = usage.get("cache_read_input_tokens", 0) or 0
            out = usage.get("output_tokens", 0) or 0
            total_output_tokens += out
            standing = inp + cc + cr
            if standing > max_context:
                max_context = standing
            for t in THRESHOLDS:
                if crossing_turn[t] is None and standing >= t:
                    crossing_turn[t] = turn_idx

    total_turns = turn_idx
    if total_turns == 0:
        return None

    kind = classify_kind(entrypoint, session_kind, first_user_text, is_subagent)

    rec = {
        "path": path,
        "is_subagent": is_subagent,
        "entrypoint": entrypoint,
        "session_kind_field": session_kind,
        "kind": kind,
        "total_turns": total_turns,
        "compactions": compactions,
        "max_context": max_context,
        "first_ts": first_ts,
        "last_ts": last_ts,
    }
    for t in THRESHOLDS:
        ct = crossing_turn[t]
        rec[f"cross_{t}_turn"] = ct
        rec[f"remaining_after_{t}"] = (total_turns - ct) if ct is not None else None
    return rec


def corpus():
    """(main files, subagent files), every seat root's, one copy of each."""
    found = tc.files()
    return (
        [p for p, is_sub in found if not is_sub],
        [p for p, is_sub in found if is_sub],
    )


def main():
    main_files, subagent_files = corpus()

    print(f"main files: {len(main_files)}")
    print(f"subagent files: {len(subagent_files)}")

    fieldnames = [
        "path",
        "is_subagent",
        "entrypoint",
        "session_kind_field",
        "kind",
        "total_turns",
        "compactions",
        "max_context",
        "first_ts",
        "last_ts",
    ]
    for t in THRESHOLDS:
        fieldnames += [f"cross_{t}_turn", f"remaining_after_{t}"]

    n_processed = 0
    n_empty = 0
    tally = Counter()
    with open(OUT_CSV, "w", newline="") as csvf:
        writer = csv.DictWriter(csvf, fieldnames=fieldnames)
        writer.writeheader()
        for i, path in enumerate(main_files):
            rec = process_file(path, False, tally)
            if rec is None:
                n_empty += 1
                continue
            writer.writerow(rec)
            n_processed += 1
            if i % 300 == 0:
                print(f"main progress {i}/{len(main_files)}")

        for i, path in enumerate(subagent_files):
            rec = process_file(path, True, tally)
            if rec is None:
                n_empty += 1
                continue
            writer.writerow(rec)
            n_processed += 1
            if i % 500 == 0:
                print(f"subagent progress {i}/{len(subagent_files)}")

    print(
        f"processed: {n_processed}, empty/skipped: {n_empty}  {tc.counts_line(tally)}"
    )


if __name__ == "__main__":
    main()
