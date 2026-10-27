"""corpus.py — the transcript walk, time helper and caps the test-loss scanners share (#2823).

A project dir counts when its name names workflow-core or mantahostels (repo `wfc` or `mh`);
every *.jsonl below it modified at or after the window start is read, as text only. The default
roots are every seat's `projects` dir. A file that will not open, and a line that is not JSON, is counted into the caller's tally, never fatal."""

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

# #2812 (the baseline)'s window, each scanner's default.
START = "2026-10-10T04:10:00Z"
END = "2026-10-24T04:10:59Z"
# #2812's foreground cap: the harness moves a foreground call to the background near 600 s, so a
# longer row is a held prompt or a suspended session. #2821 reused it, untraced, as active.py's
# gap cap.
CAP_S = 1800
# #2812's row identity: the path's last 60 characters hold the session id and the project slug's
# tail, and a resume repeats a row whose command matches in its first 60. Both untraced.
FILE_KEY_CHARS = 60
CMD_KEY_CHARS = 60


def epoch(iso):
    """Seconds since the epoch for an ISO time ending in Z."""
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
    """(repo, path) for each transcript under `roots` modified at or after `t_start`. A root or
    file that cannot be listed or stat'd counts as unreadable (#2823)."""
    for root in roots:
        try:
            projects = sorted(os.listdir(root))
        except OSError:
            tally[tc.UNREADABLE] += 1
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
                    except OSError:
                        tally[tc.UNREADABLE] += 1
                        continue
                    yield repo, p


def run_scanner(doc, scan_file, subagents=True):
    """A scanner's CLI."""
    ap = argparse.ArgumentParser(description=doc.splitlines()[0])
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
