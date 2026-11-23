import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
)
import transcript_corpus as tc
from fail_open import tallied

START = "2026-10-10T04:10:00Z"
END = "2026-10-24T04:10:59Z"
# guess: a longer row is a held prompt or a suspended session, #2812
CAP_S = 1800
# guess: holds the session id and the slug's tail, #2812
FILE_KEY_CHARS = 60
CMD_KEY_CHARS = 60


def epoch(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def is_subagent(path):
    return "subagents" in path


def row_file(path):
    return path[-FILE_KEY_CHARS:]


def default_roots():
    return [os.path.join(d, "projects") for d in tc.seats()]


records_with_lines = tc.records_with_lines
counts_line = tc.counts_line


def transcripts(roots, t_start, tally, subagents=True):
    for root in roots:
        try:
            projects = sorted(os.listdir(root))
        except OSError as e:
            tallied(e, tally, tc.UNREADABLE)
            continue
        for proj in projects:
            m = re.search(r"workflow-core|mantahostels", proj)
            if not m:
                continue
            repo = "wfc" if m.group(0) == "workflow-core" else "mh"
            for dp, _dn, fn in os.walk(os.path.join(root, proj)):
                if not subagents and is_subagent(dp):
                    continue
                for f in fn:
                    if not f.endswith(".jsonl"):
                        continue
                    p = os.path.join(dp, f)
                    try:
                        if os.path.getmtime(p) < t_start:
                            continue
                    except OSError as e:
                        tallied(e, tally, tc.UNREADABLE)
                        continue
                    yield repo, p


def run_scanner(description, scan_file, subagents=True):
    ap = argparse.ArgumentParser(description=description.splitlines()[0])
    ap.add_argument("out", help="JSONL file the rows are written to")
    ap.add_argument("roots", nargs="*", help="projects dirs (default: every seat's)")
    ap.add_argument(
        "--start", default=START, help=f"UTC ISO window start (default {START})"
    )
    ap.add_argument("--end", default=END, help=f"UTC ISO window end (default {END})")
    a = ap.parse_args()
    tally = Counter()
    nfiles = 0
    with open(a.out, "w") as out:
        for repo, p in transcripts(
            a.roots or default_roots(), epoch(a.start), tally, subagents
        ):
            nfiles += 1
            for row in scan_file(p, repo, a.start, a.end, tally=tally):
                out.write(json.dumps(row) + "\n")
    print("files read", nfiles, counts_line(tally), file=sys.stderr)
