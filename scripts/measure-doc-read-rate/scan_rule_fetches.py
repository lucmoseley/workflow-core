#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scan_doc_reads import (
    FETCHER,
    HOOK_ATTACHMENTS,
    RULE_ID,
    RULE_PREFIX,
    RULE_STOPS,
    SEGMENT,
    commands_in_record,
    corpus_paths,
    fetcher_args,
    in_window,
    strip_heredoc_bodies,
)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc
from fail_open import fail_open


def rules_dir():
    return os.environ.get(
        "WFC_RULES_DIR",
        str(
            Path(__file__).resolve().parent.parent.parent / "docs" / "agents" / "rules"
        ),
    )


GUARD = "scripts/lib/tracker-rules.js"
IDS_ARRAY = re.compile(r"^\s*injectRules: \[(.*?)\]", re.M | re.S)
QUOTED_ID = re.compile(r'"([a-z0-9-]+)"')


def guard_ids():
    try:
        src = open(
            os.path.join(os.path.dirname(rules_dir()), "..", "..", GUARD),
            encoding="utf-8",
        ).read()
    except OSError as e:
        fail_open(e, "guard read as no rule ids")
        return set()
    return {i for run in IDS_ARRAY.findall(src) for i in QUOTED_ID.findall(run)}


def needles():
    out, store = {}, rules_dir()
    for rule in guard_ids():
        try:
            with open(os.path.join(store, f"{rule}.txt"), encoding="utf-8") as fh:
                text = fh.read().strip()
        except OSError as e:
            fail_open(e, f"rule {rule} given no needle")
            continue
        if len(text) >= NEEDLE:
            out[rule] = text[:NEEDLE]
    return out


NEEDLE = 60


def store_ids():
    try:
        return {f[:-4] for f in os.listdir(rules_dir()) if f.endswith(".txt")}
    except OSError as e:
        fail_open(e, "rule store read as empty")
        return set()


def ids_in_call(args, ids):
    asked, bad = set(), False
    for token in args:
        if RULE_STOPS.search(token):
            break
        if token.startswith("-"):
            continue
        bare = token[len(RULE_PREFIX) :] if token.startswith(RULE_PREFIX) else token
        if bare in ids:
            asked.add(bare)
            continue
        if RULE_ID.match(bare):
            asked.add(bare)
        bad = True
    if bad:
        return set(), asked
    return asked, set()


def fetches_in_record(rec):
    called = False
    resolved, refused = set(), set()
    msg = rec.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return called, resolved, refused
    ids = store_ids()
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_use":
            continue
        if b.get("name") != "Bash":
            continue
        command = str((b.get("input") or {}).get("command", ""))
        if FETCHER not in command:
            continue
        for segment in SEGMENT.split(strip_heredoc_bodies(command)):
            args = fetcher_args(segment)
            if args is None:
                continue
            called = True
            r, x = ids_in_call(args, ids)
            resolved |= r
            refused |= x
    return called, resolved, refused


def emitted_in_record(rec, marks):
    if rec.get("type") != "attachment":
        return set()
    att = rec.get("attachment") or {}
    if att.get("type") not in HOOK_ATTACHMENTS:
        return set()
    blob = json.dumps(att)
    return {rule for rule, needle in marks.items() if json.dumps(needle)[1:-1] in blob}


def scan_file(path, tally, marks=None):
    marks = needles() if marks is None else marks
    cmds, resolved, refused, emitted = set(), set(), set(), set()
    called = False
    first_ts = None
    for rec in tc.records(
        path,
        tally,
        needle=(
            "rule-text.sh",
            "docs/agents/",
            "You invoked /",
            "hook_additional_context",
            "hook_success",
        ),
    ):
        if first_ts is None and isinstance(rec.get("timestamp"), str):
            first_ts = rec["timestamp"]
        cmds |= commands_in_record(rec)
        c, r, x = fetches_in_record(rec)
        called = called or c
        resolved |= r
        refused |= x
        emitted |= emitted_in_record(rec, marks)
    return {
        "file": os.path.basename(path),
        "timestamp": first_ts,
        "commands": sorted(cmds),
        "called": called,
        "emitted": sorted(emitted),
        "resolved": sorted(resolved),
        "refused": sorted(refused - resolved),
    }


def scan_dir(directory=None, after=None):
    sessions, skipped = [], Counter()
    for path in corpus_paths(directory):
        row = scan_file(path, skipped)
        if not row["commands"] or not in_window(row["timestamp"], after):
            continue
        sessions.append(row)
    return sessions, skipped


def tally(sessions):
    per = defaultdict(
        lambda: {
            "n": 0,
            "called": 0,
            "resolved": 0,
            "refused": 0,
            "emitted": 0,
            "ids": defaultdict(int),
        }
    )
    for s in sessions:
        for c in s["commands"]:
            per[c]["n"] += 1
            per[c]["called"] += 1 if s["called"] else 0
            per[c]["resolved"] += 1 if s["resolved"] else 0
            per[c]["refused"] += 1 if s["refused"] else 0
            per[c]["emitted"] += 1 if s["emitted"] else 0
            for i in s["resolved"]:
                per[c]["ids"][i] += 1
    return per


def main():
    ap = argparse.ArgumentParser(
        description="Does a session handed a per-command rule index go and fetch the rules?"
    )
    ap.add_argument(
        "--dir", help="one transcript directory in place of every seat root"
    )
    ap.add_argument("--after", help="ISO timestamp; keep sessions at or after it")
    ap.add_argument("--table", action="store_true")
    args = ap.parse_args()

    sessions, skipped = scan_dir(args.dir, args.after)
    per = tally(sessions)

    if args.table:
        print(
            f"sessions naming a tracker command: {len(sessions)}"
            f"  {tc.counts_line(skipped)}"
        )
        print(
            f"rule ids in the store: {len(store_ids())}  guard-routed rules "
            f"with a needle: {len(needles())} of {len(guard_ids())}"
        )
        print(
            f"{'command':<13}{'n':>6}{'gp_rule':>16}{'called':>16}{'resolved':>16}"
            f"{'refused':>16}{'ids':>6}"
        )
        for cmd, row in sorted(per.items(), key=lambda kv: -kv[1]["n"]):
            n, e, f, r, x = (
                row["n"],
                row["emitted"],
                row["called"],
                row["resolved"],
                row["refused"],
            )
            print(
                f"{cmd:<13}{n:>6}{e:>7} {e / n * 100:6.1f}%{f:>7} {f / n * 100:6.1f}%"
                f"{r:>7} {r / n * 100:6.1f}%{x:>7} {x / n * 100:6.1f}%{len(row['ids']):>6}"
            )
        return

    print(
        json.dumps(
            {
                "sessions": len(sessions),
                "unreadable_files": skipped[tc.UNREADABLE],
                "unparsed_lines": skipped[tc.UNPARSED],
                "rule_store_ids": len(store_ids()),
                "guard_ids_with_needle": len(needles()),
                "guard_ids": len(guard_ids()),
                "per_command": {
                    c: {
                        "n": r["n"],
                        "called": r["called"],
                        "resolved": r["resolved"],
                        "refused": r["refused"],
                        "emitted": r["emitted"],
                        "ids": dict(r["ids"]),
                    }
                    for c, r in per.items()
                },
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
