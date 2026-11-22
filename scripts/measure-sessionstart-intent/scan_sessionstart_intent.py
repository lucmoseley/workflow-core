#!/usr/bin/env python3

import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc
from fail_open import tallied

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
    text = attachment.get("stdout") or ""
    content = attachment.get("content")
    if isinstance(content, str):
        text += content
    elif content:
        text += json.dumps(content)
    return text


def scan_transcript(path, tally):
    named = injected = False
    for record in tc.records(path, tally, needle='"hookEvent"'):
        attachment = record.get("attachment") or {}
        if attachment.get("hookName") != STARTUP_MATCHER:
            continue
        text = attachment_text(attachment)
        named = named or NAMED_MARKER in text
        injected = injected or INJECTED_MARKER in text
    return named, injected


def scan(jobs_dir, projects_dirs):
    by_version = defaultdict(lambda: {"jobs": 0, "named": 0, "injected": 0})
    jobs = []
    skipped_no_transcript = 0
    tally = Counter()
    for state_path in sorted(glob.glob(os.path.join(jobs_dir, "*", "state.json"))):
        try:
            with open(state_path) as handle:
                state = json.load(handle)
        except (OSError, ValueError) as e:
            tallied(e, tally, "skipped_unreadable_state")
            continue
        session_id = state.get("sessionId")
        intent = (state.get("intent") or "").strip()
        if not session_id or not intent.startswith("/"):
            continue
        command = intent.split()[0].lstrip("/")
        if command not in INJECTED_COMMANDS:
            continue
        transcript = next(
            (
                p
                for p in (os.path.join(d, session_id + ".jsonl") for d in projects_dirs)
                if os.path.exists(p)
            ),
            None,
        )
        if transcript is None:
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


def config_dirs():
    seen = []
    for d in tc.seats():
        resolved = os.path.realpath(d)
        if resolved not in seen and os.path.isdir(os.path.join(resolved, "jobs")):
            seen.append(resolved)
    return seen


def main():
    parser = argparse.ArgumentParser(
        description="Whether a background job's SessionStart sees the job's intent yet."
    )
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
        pairs = [(args.jobs_dir, [args.projects_dir])]
    else:
        roots = args.config_dir or config_dirs()
        pairs = [(os.path.join(root, "jobs"), tc.roots_on(root)) for root in roots]

    result = merge([scan(jobs_dir, projects_dir) for jobs_dir, projects_dir in pairs])
    result["scanned"] = [jobs_dir for jobs_dir, _ in pairs]
    if not args.per_job:
        result.pop("jobs")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
