#!/usr/bin/env python3
import argparse
import json
import os
import re
import collections
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

COMMANDS = {
    "wayfinder",
    "to-spec",
    "to-tickets",
    "implement",
    "triage",
    "card-close",
    "code-review",
}

DOCS = {
    "issue-tracker": "docs/agents/issue-tracker.md",
    "triage-labels": "docs/agents/triage-labels.md",
}

RULE_CHANNEL = "rule-text"
CHANNELS = list(DOCS) + [RULE_CHANNEL]

READ_TOOLS = {"Read", "Bash", "Grep", "Glob"}
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}

READING_PROGRAMS = {
    "cat",
    "sed",
    "grep",
    "rg",
    "egrep",
    "fgrep",
    "head",
    "tail",
    "less",
    "more",
    "awk",
    "wc",
    "diff",
    "nl",
    "cut",
    "sort",
    "uniq",
    "python3",
    "python",
    "jq",
}

SEGMENT = re.compile(r"&&|\|\||[;|\n]")

FETCHER = "rule-text.sh"

INTERPRETERS = {"bash"}

RULE_PREFIX = "rule:"
RULE_ID = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

RULE_STOPS = re.compile(r"[<>#$`]")

HEREDOC_OPEN = re.compile(r"(?<!<)<<-?(?!<)\s*\\?['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")

QUOTES = "\"'`"

MUTATING_ISSUE_SUBCOMMANDS = {"create", "edit", "close", "comment"}

MUTATING_METHOD = re.compile(r"(?:-X|--method)[= ]+(POST|PATCH|DELETE|PUT)\b", re.I)
GRAPHQL_MUTATION = re.compile(r"\bmutation\b", re.I)

HOOK_ATTACHMENTS = {"hook_additional_context", "hook_success"}

STRICT_MARKER = re.compile(r"You invoked /([A-Za-z-]+),")
LOOSE_MARKER = re.compile(r"You invoked /([A-Za-z-]+)")


def commands_in_record(rec, loose=False):
    if loose:
        return set(LOOSE_MARKER.findall(json.dumps(rec))) & COMMANDS
    if rec.get("type") != "attachment":
        return set()
    att = rec.get("attachment") or {}
    if att.get("type") not in HOOK_ATTACHMENTS:
        return set()
    return set(STRICT_MARKER.findall(json.dumps(att))) & COMMANDS


def persistence_of(rec):
    att = rec.get("attachment") or {}
    if att.get("type") != "hook_additional_context":
        return "log"
    content = att.get("content")
    text = json.dumps(content) if not isinstance(content, str) else content
    return "persisted" if "<persisted-output>" in text else "inline"


def program_of(words):
    idx = next((i for i, w in enumerate(words) if "=" not in w.split("/")[0]), None)
    return idx, (words[idx] if idx is not None else "")


def bash_opens_path(command, path):
    for segment in SEGMENT.split(command):
        if path not in segment:
            continue
        _, program = program_of(segment.split())
        if os.path.basename(program) in READING_PROGRAMS:
            return True
    return False


def strip_heredoc_bodies(command):
    if "<<" not in command:
        return command
    out, terminator = [], None
    for line in command.split("\n"):
        if terminator is not None:
            if line.strip() == terminator:
                terminator = None
            continue
        out.append(line)
        m = HEREDOC_OPEN.search(line)
        if m:
            terminator = m.group(1)
    return "\n".join(out)


def fetcher_args(segment):
    words = [w for w in (w.strip(QUOTES) for w in segment.split()) if w]
    idx, _ = program_of(words)
    if idx is None:
        return None
    if os.path.basename(words[idx]) in INTERPRETERS:
        idx += 1
    if idx >= len(words) or os.path.basename(words[idx]) != FETCHER:
        return None
    return words[idx + 1 :]


def rule_fetches_in_command(command):
    called, ids = False, set()
    if FETCHER not in command:
        return called, ids
    for segment in SEGMENT.split(strip_heredoc_bodies(command)):
        args = fetcher_args(segment)
        if args is None:
            continue
        if not any(not t.startswith("-") for t in args):
            continue
        called = True
        for token in args:
            if RULE_STOPS.search(token):
                break
            if token.startswith("-"):
                continue
            bare = token[len(RULE_PREFIX) :] if token.startswith(RULE_PREFIX) else token
            if RULE_ID.match(bare):
                ids.add(bare)
    return called, ids


def command_mutates_tracker(command):
    for segment in SEGMENT.split(strip_heredoc_bodies(command)):
        words = segment.split()
        idx, program = program_of(words)
        if idx is None or os.path.basename(program) != "gh":
            continue
        rest = words[idx + 1 :]
        if not rest:
            continue
        if (
            rest[0] == "issue"
            and len(rest) > 1
            and rest[1] in MUTATING_ISSUE_SUBCOMMANDS
        ):
            return True
        if rest[0] == "api":
            joined = " ".join(rest)
            if "graphql" in joined:
                if GRAPHQL_MUTATION.search(joined):
                    return True
                continue
            if "issues" in joined and MUTATING_METHOD.search(joined):
                return True
    return False


def tracker_mutation_in_record(rec):
    msg = rec.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return False
    for b in content:
        if (
            not isinstance(b, dict)
            or b.get("type") != "tool_use"
            or b.get("name") != "Bash"
        ):
            continue
        if command_mutates_tracker(str((b.get("input") or {}).get("command", ""))):
            return True
    return False


def paths_in_tool_use(rec):
    read, edited, rule_ids = set(), set(), set()
    msg = rec.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return read, edited, rule_ids
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_use":
            continue
        name = b.get("name")
        if name not in READ_TOOLS and name not in EDIT_TOOLS:
            continue
        inp = b.get("input", {})
        blob = json.dumps(inp)
        if name == "Bash":
            called, ids = rule_fetches_in_command(str(inp.get("command", "")))
            if called:
                read.add(RULE_CHANNEL)
                rule_ids |= ids
        for key, path in DOCS.items():
            if path not in blob:
                continue
            if name == "Bash" and not bash_opens_path(
                str(inp.get("command", "")), path
            ):
                continue
            (read if name in READ_TOOLS else edited).add(key)
    return read, edited, rule_ids


TIMED = ("docs/agents/", "You invoked /", "gh issue", "gh api")


def scan_file(path, tally, loose=False):
    cmds, read, edited, rule_ids = set(), set(), set(), set()
    shapes = collections.Counter()
    first_ts = None
    mutated = False
    for raw, rec in tc.records_with_lines(
        path, tally, needle=TIMED + ("rule-text.sh",)
    ):
        timed = any(n in raw for n in TIMED)
        if timed and first_ts is None and isinstance(rec.get("timestamp"), str):
            first_ts = rec["timestamp"]
        found = commands_in_record(rec, loose)
        if found:
            shapes[persistence_of(rec)] += 1
        cmds |= found
        r, e, ids = paths_in_tool_use(rec)
        read |= r
        edited |= e
        rule_ids |= ids
        if not mutated and tracker_mutation_in_record(rec):
            mutated = True
    return {
        "file": os.path.basename(path),
        "timestamp": first_ts,
        "commands": sorted(cmds),
        "read": sorted(read),
        "edited": sorted(edited),
        "rule_ids": sorted(rule_ids),
        "shapes": dict(shapes),
        "mutated_tracker": mutated,
    }


def in_window(timestamp, after):
    if not after:
        return True
    if not timestamp:
        return False
    if "." not in after and after.endswith("Z"):
        after = after[:-1] + ".000Z"
    return timestamp >= after


def corpus_paths(directory=None):
    if directory is not None:
        return [
            os.path.join(directory, n)
            for n in sorted(os.listdir(directory))
            if n.endswith(".jsonl")
        ]
    return tc.main_transcripts()


def scan_dir(directory=None, loose=False, after=None):
    sessions, skipped = [], collections.Counter()
    for path in corpus_paths(directory):
        row = scan_file(path, skipped, loose)
        if not row["commands"] or not in_window(row["timestamp"], after):
            continue
        sessions.append(row)
    return sessions, skipped


def tally(sessions):
    per = defaultdict(
        lambda: {
            "n": 0,
            "read": defaultdict(int),
            "edited": defaultdict(int),
            "n_mutated": 0,
            "read_mutated": defaultdict(int),
        }
    )
    for s in sessions:
        for c in s["commands"]:
            per[c]["n"] += 1
            for key in s["read"]:
                per[c]["read"][key] += 1
            for key in s["edited"]:
                per[c]["edited"][key] += 1
            if s.get("mutated_tracker"):
                per[c]["n_mutated"] += 1
                for key in s["read"]:
                    per[c]["read_mutated"][key] += 1
    return per


def main():
    ap = argparse.ArgumentParser(
        description="Does a session handed the tracker rules go and read them?"
    )
    ap.add_argument(
        "--dir", help="one transcript directory in place of every seat root"
    )
    ap.add_argument(
        "--after",
        help="ISO timestamp (2026-08-28T14:03:24.000Z); keep sessions at or after it",
    )
    ap.add_argument(
        "--loose",
        action="store_true",
        help="reproduce the over-counting detector; never trust it",
    )
    ap.add_argument("--table", action="store_true")
    ap.add_argument(
        "--shape",
        action="store_true",
        help="count persisted vs inline deliveries; the test mantahostels#1872 runs",
    )
    args = ap.parse_args()

    sessions, skipped = scan_dir(args.dir, args.loose, args.after)
    per = tally(sessions)

    if args.shape:
        totals = collections.Counter()
        for s in sessions:
            totals.update(s["shapes"])
        print(f"deliveries across {len(sessions)} session(s):")
        for k in ("persisted", "inline", "log"):
            print(f"  {k:<10}{totals[k]:>7}")
        return

    if args.table:
        print(
            f"sessions naming a tracker command: {len(sessions)}"
            f"  {tc.counts_line(skipped)}"
        )
        head = f"{'command':<13}{'n':>6}"
        head += "".join(f"{c:>15}" for c in CHANNELS)
        head += f"{'edited':>8}{'mut-n':>8}"
        head += "".join(f"{'mut-' + c:>19}" for c in CHANNELS)
        print(head)
        for cmd, row in sorted(per.items(), key=lambda kv: -kv[1]["n"]):
            n = row["n"]
            mn = row["n_mutated"]
            line = f"{cmd:<13}{n:>6}"
            line += "".join(
                f"{row['read'][c]:>7} {row['read'][c] / n * 100:6.1f}%"
                for c in CHANNELS
            )
            line += f"{sum(row['edited'].values()):>8}{mn:>8}"
            for c in CHANNELS:
                m = row["read_mutated"][c]
                line += f"{m:>11} {m / mn * 100:6.1f}%" if mn else f"{'n/a':>19}"
            print(line)
        return

    print(
        json.dumps(
            {
                "sessions": len(sessions),
                "unreadable_files": skipped[tc.UNREADABLE],
                "unparsed_lines": skipped[tc.UNPARSED],
                "per_command": {
                    c: {
                        "n": r["n"],
                        "read": {k: r["read"][k] for k in CHANNELS},
                        "edited": dict(r["edited"]),
                        "n_mutated": r["n_mutated"],
                        "read_mutated": {k: r["read_mutated"][k] for k in CHANNELS},
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
