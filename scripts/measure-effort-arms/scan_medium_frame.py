#!/usr/bin/env python3
"""scan_medium_frame.py — build the `medium` sampling frame for mantahostels#1214 and draw six at random.

mantahostels#1214 asks for a control mantahostels#1108 never ran: put six closed `medium`
`takes:implement` commits through the same blind review the `low` arm got
(https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/effort-low-arm-measurement.md). This script builds that
frame and performs the draw, so both are reproducible and checkable for
cherry-picking rather than asserted.

Frame, in order:

  1. `scan_effort_arms.sessions()` restricted to arm=medium, skill=implement,
     model=opus, window 2026-08-12..2026-08-23 (identical to the `low` arm's
     own match criteria).
  2. Turns in [47, 97] -- the closed interval spanning the six already-reviewed
     `low` tickets (mantahostels#1148 47, mantahostels#1150 65, mantahostels#1145 97, mantahostels#1034 89, mantahostels#1106 76, mantahostels#1191
     52). This is a biased proxy, not clean difficulty-matching, and the bias
     has a known direction: 47-97 was the range *`low` effort produced*
     (median 58.5), well under the medium arm's own median of 84 turns/session
     (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/effort-low-arm-measurement.md). Filtering medium sessions
     to that band selects medium's faster-finishing, likely easier tickets --
     which favours the medium arm on exactly the defect-rate comparison this
     ticket exists to make. No better proxy is available (task size has no
     independent measure here), so the frame is built on it anyway and the
     bias is reported, not hidden, in the write-up.
  3. Each session's own issue number, read from its transcript's
     `<command-args>` (the `/implement <n>` invocation) -- never hand-mapped.
  4. Deduplicated to one session per issue (resumes), keeping the first
     session encountered in `scan_effort_arms`'s own (arm, t0) order.
  5. Issue closed, carries `takes:implement` -- checked against
     `gh issue list --state closed --label takes:implement`.
  6. Issue does not carry `measured:effort-low` (would mean it's already in
     the reviewed low arm under another label path).

The draw is `random.Random(seed).sample(frame, 6)`, seed and full frame
printed so the six can be checked against the whole population.
"""

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
]  # mantahostels#1148 mantahostels#1150 mantahostels#1145 mantahostels#1034 mantahostels#1106 mantahostels#1191


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
    """`tally` receives the corpus's skipped files, lines and unkeyed records
    for the caller to print (#1274)."""
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
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--seed", type=int, required=True)
    # Six, to match the six `low` tickets mantahostels#1108 reviewed.
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
