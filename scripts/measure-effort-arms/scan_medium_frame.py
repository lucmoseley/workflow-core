#!/usr/bin/env python3
import argparse
import json
import os
import random
import re
import subprocess
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scan_effort_arms as sea

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
)
import transcript_corpus as tc
from wfc_bin import bin_path

LOW_TURNS = [
    47,
    65,
    97,
    89,
    76,
    52,
]


def session_issue(session_id):
    matches = [
        p
        for p in (os.path.join(r, f"{session_id}.jsonl") for r in tc.roots())
        if os.path.isfile(p)
    ]
    if not matches:
        return None
    cmd = issue = None
    with open(matches[0], errors="replace") as f:
        for line in f:
            if "<command-name>" not in line:
                continue
            m = re.search(r"<command-name>/?([a-zA-Z\-]+)</command-name>", line)
            a = re.search(r"<command-args>(\d+)</command-args>", line)
            if m:
                cmd = m.group(1)
            if a:
                issue = a.group(1)
            if cmd and issue:
                break
    return issue if cmd == "implement" and issue else None


def gh_issue_numbers(label, state="closed"):
    out = subprocess.run(
        [
            bin_path("gh"),
            "issue",
            "list",
            "--state",
            state,
            "--label",
            label,
            "--limit",
            "1000",
            "--json",
            "number",
            "-q",
            ".[].number",
        ],
        capture_output=True,
        text=True,
        check=True,
        cwd=os.path.dirname(os.path.abspath(__file__)) + "/../..",
    )
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


def build_frame(tally, window=("2026-08-12", "2026-08-23")):
    rows = sea.sessions(tally, window, skill="implement", model="opus")
    medium = [
        r
        for r in rows
        if r["arm"] == "medium" and min(LOW_TURNS) <= r["turns"] <= max(LOW_TURNS)
    ]

    seen_issues = {}
    for r in medium:
        issue = session_issue(r["id"])
        if not issue or issue in seen_issues:
            continue
        seen_issues[issue] = r

    closed_implement = gh_issue_numbers("takes:implement")
    low_arm = gh_issue_numbers("measured:effort-low")

    frame = []
    for issue, r in seen_issues.items():
        if issue not in closed_implement:
            continue
        if issue in low_arm:
            continue
        frame.append({"issue": issue, "session": r["id"], "turns": r["turns"]})
    frame.sort(key=lambda x: int(x["issue"]))
    return frame


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    tally = Counter()
    frame = build_frame(tally)
    draw = random.Random(args.seed).sample(frame, args.n)

    if args.json:
        print(
            json.dumps(
                {
                    "seed": args.seed,
                    "frame": frame,
                    "draw": draw,
                    "skipped": tc.skips(
                        tally, tc.UNREADABLE, tc.UNPARSED, sea.sb.UNKEYED
                    ),
                },
                indent=1,
            )
        )
        return 0

    print(
        f"Frame: {len(frame)} issues (medium, cli, opus, implement, "
        f"12-23 Aug 2026, turns {min(LOW_TURNS)}-{max(LOW_TURNS)}, closed "
        f"takes:implement, not measured:effort-low)\n"
    )
    for row in frame:
        print(f"  #{row['issue']:<6} turns={row['turns']:<4} session={row['session']}")
    print(f"\nSeed {args.seed}, drew {args.n}:")
    for row in draw:
        print(f"  #{row['issue']:<6} turns={row['turns']:<4} session={row['session']}")
    print(f"\n{tc.counts_line(tally)}")
    if warning := sea.sb.unkeyed_warning(tally):
        print(warning)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
