#!/usr/bin/env python3
"""
scan_sessionstart_intent.py — does a background job's SessionStart see the job's `intent` yet? (mantahostels#1142)

It is a race the daemon usually loses, and the Claude Code version moves the
odds enough to look like a rule: open through 2.1.234, shut across
2.1.235-2.1.239, open again at 2.1.241 (per-version counts on mantahostels#1142). Re-run
after a CLI upgrade rather than re-deriving the argument.

Method. Every job record under <config>/jobs/*/state.json whose `intent` opens
with one of the injected slash commands, joined to that job's own transcript at
<config>/projects/<project-slug>/<sessionId>.jsonl. A firing counts only from a
hook attachment on matcher `SessionStart:startup` — a fresh start, so a resume,
a compact, a fork and a clear are all excluded. Two markers are looked for in
the attachment's stdout/content:

  "Session named "   scripts/name-issue-session.sh emitted a name
  "You invoked /"    scripts/inject-tracker-docs.sh injected the tracker docs

EVERY config dir is scanned, not just the live one: this machine sets
CLAUDE_CONFIG_DIR=~/.claude2, and the ~/.claude it left behind holds a disjoint
set of older jobs. Scanning one dir alone makes an intermittent race read as a
clean version cut-off (mantahostels#1142).

BLIND SPOT: a hook whose output was too large also writes a second attachment
under the bare matcher `SessionStart`, holding only a `<persisted-output>`
pointer. Those are ignored, which is right while the matcher-tagged line still
carries the text inline. If a harness change ever drops that inline copy, this
scanner returns zeros and they will read as a CLI regression rather than as its
own blindness.
"""

import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

# Commands scripts/inject-tracker-docs.sh injects for. `pick-next` is named by
# the naming hook but never injected, so counting it would understate injection.
INJECTED_COMMANDS = {
    "wayfinder",
    "to-spec",
    "to-tickets",
    "implement",
    "triage",
    "card-close",
    "code-review",
}

NAMED_MARKER = "Session named "
INJECTED_MARKER = "You invoked /"
STARTUP_MATCHER = "SessionStart:startup"


def attachment_text(attachment):
    """Everything a hook attachment can carry its output in, concatenated."""
    text = attachment.get("stdout") or ""
    content = attachment.get("content")
    if isinstance(content, str):
        text += content
    elif content:
        text += json.dumps(content)
    return text


def scan_transcript(path, tally):
    """(named, injected) — did either hook fire at SessionStart:startup here?

    `tally` receives `tc.records`'s skip counts, which the result carries."""
    named = injected = False
    for record in tc.records(path, tally, needle='"hookEvent"'):
        attachment = record.get("attachment") or {}
        if attachment.get("hookName") != STARTUP_MATCHER:
            continue
        text = attachment_text(attachment)
        named = named or NAMED_MARKER in text
        injected = injected or INJECTED_MARKER in text
    return named, injected


def scan(jobs_dir, projects_dir):
    by_version = defaultdict(lambda: {"jobs": 0, "named": 0, "injected": 0})
    jobs = []
    skipped_no_transcript = 0
    tally = Counter()
    for state_path in sorted(glob.glob(os.path.join(jobs_dir, "*", "state.json"))):
        try:
            with open(state_path) as handle:
                state = json.load(handle)
        except (OSError, ValueError):
            # A job's state that will not read is skipped and counted beside
            # skipped_no_transcript (#1274).
            tally["skipped_unreadable_state"] += 1
            continue
        session_id = state.get("sessionId")
        intent = (state.get("intent") or "").strip()
        if not session_id or not intent.startswith("/"):
            continue
        command = intent.split()[0].lstrip("/")
        if command not in INJECTED_COMMANDS:
            continue
        transcript = os.path.join(projects_dir, session_id + ".jsonl")
        if not os.path.exists(transcript):
            skipped_no_transcript += 1
            continue
        named, injected = scan_transcript(transcript, tally)
        version = state.get("cliVersion") or "unknown"
        row = by_version[version]
        row["jobs"] += 1
        row["named"] += named
        row["injected"] += injected
        jobs.append(
            {
                "job": os.path.basename(os.path.dirname(state_path)),
                "createdAt": state.get("createdAt"),
                "cliVersion": version,
                "command": command,
                "named_at_sessionstart": named,
                "injected_at_sessionstart": injected,
            }
        )
    jobs.sort(key=lambda job: job["createdAt"] or "")
    return {
        "jobs_scanned": len(jobs),
        "skipped_no_transcript": skipped_no_transcript,
        "skipped_unreadable_state": tally["skipped_unreadable_state"],
        "unreadable_files": tally[tc.UNREADABLE],
        "unparsed_lines": tally[tc.UNPARSED],
        "by_cli_version": {
            version: by_version[version] for version in sorted(by_version)
        },
        "jobs": jobs,
    }


def merge(results):
    """Several config dirs' scans as one."""
    counts = (
        "jobs_scanned",
        "skipped_no_transcript",
        "skipped_unreadable_state",
        "unreadable_files",
        "unparsed_lines",
    )
    merged = {**dict.fromkeys(counts, 0), "by_cli_version": {}, "jobs": []}
    for result in results:
        for key in counts:
            merged[key] += result[key]
        merged["jobs"].extend(result["jobs"])
        for version, row in result["by_cli_version"].items():
            into = merged["by_cli_version"].setdefault(
                version, {"jobs": 0, "named": 0, "injected": 0}
            )
            for key in into:
                into[key] += row[key]
    merged["by_cli_version"] = {
        version: merged["by_cli_version"][version]
        for version in sorted(merged["by_cli_version"])
    }
    merged["jobs"].sort(key=lambda job: job["createdAt"] or "")
    return merged


def project_slug(cwd):
    """The transcript directory Claude Code writes for a working directory."""
    return cwd.replace("/", "-")


def config_dirs():
    """Every seat's config dir holding jobs — transcript_corpus.py's seat set."""
    seen = []
    for d in tc.seats():
        resolved = os.path.realpath(d)
        if resolved not in seen and os.path.isdir(os.path.join(resolved, "jobs")):
            seen.append(resolved)
    return seen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config-dir",
        action="append",
        help="a Claude Code config dir to scan; repeatable. Default: every one found",
    )
    parser.add_argument(
        "--jobs-dir", help="scan this jobs dir alone (needs --projects-dir)"
    )
    parser.add_argument("--projects-dir", help="the transcripts for --jobs-dir")
    parser.add_argument(
        "--per-job",
        action="store_true",
        help="include the per-job rows, not just the per-version counts",
    )
    args = parser.parse_args()

    if args.jobs_dir or args.projects_dir:
        if not (args.jobs_dir and args.projects_dir):
            parser.error("--jobs-dir and --projects-dir go together")
        pairs = [(args.jobs_dir, args.projects_dir)]
    else:
        slug = project_slug(os.getcwd())
        roots = args.config_dir or config_dirs()
        pairs = [
            (os.path.join(root, "jobs"), os.path.join(root, "projects", slug))
            for root in roots
        ]

    result = merge([scan(jobs_dir, projects_dir) for jobs_dir, projects_dir in pairs])
    result["scanned"] = [jobs_dir for jobs_dir, _ in pairs]
    if not args.per_job:
        result.pop("jobs")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
