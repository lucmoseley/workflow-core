#!/usr/bin/env python3
"""
scan_doc_reads.py — does a session that was handed the tracker rules go and READ them? (mantahostels#1869)

`scripts/inject-tracker-docs.sh` points at `docs/agents/issue-tracker.md` and
`docs/agents/triage-labels.md` rather than pasting them (mantahostels#1869), so
they land only where the session opens the file. mantahostels#1872 runs this before/after.

WHAT IT COUNTS. Per transcript: which tracker commands were invoked, and
whether the session opened either document with its own tools. Rates are
per command, never pooled — a single number hides the command that needs the
fix.

THE TRAP THIS EXISTS TO AVOID. Grepping a whole transcript for the document's
path scores every session, because the injected payload names both documents in
its own `--- BEGIN <path> ---` fences and the persisted stub echoes the header
into the transcript. So a read is counted ONLY from a `tool_use` block's own
`input` — never from message text, never from a tool RESULT, and never from the
attachment carrying the injection.

WHY `Edit`/`Write` ARE NOT READS. Editing a document implies having read it,
but a session that edits one of these two is maintaining the rules rather than
following them, and counting it would score the tickets that rewrite the docs
as compliance. Such a session STAYS IN THE DENOMINATOR, and where it never also
read the file it counts as a non-reader, biasing every rate DOWNWARD; the size
of the bias is printed as `edited` so a reader can take it off (mantahostels#1869).

WHY A `Bash` COMMAND IS NOT AUTOMATICALLY A READ. `git commit -- <doc>`, a `gh`
call quoting the path in an issue body and an arbiter claim all name the file
without opening it. The command is split into pipeline segments and a segment
counts only where its program is in READING_PROGRAMS. That allowlist is a
judgement, not a measurement, and it biases DOWNWARD: a reading program nobody
listed is scored as a non-read.

INVOCATION DETECTION is an ATTACHMENT carrying the literal `You invoked /<cmd>,`
marker. The loose form — any line containing the marker anywhere — also matches
an assistant turn quoting it, a `cat` of the injector's own source and a test
failure printing it, so it is not used; `--loose` reproduces the looser figure
for comparison.

TWO RECORD SHAPES, AND NEITHER IS THE ONE TO CUT ON.
`hook_additional_context` is what actually reached the session; `hook_success`
is the hook's execution log — `stdout`, `exitCode`, `durationMs` — emitted at
any payload size. Both are accepted, and every corpus session carries both, so
the denominator is the same either way.

**PERSISTENCE IS A MARKER, NOT A SHAPE.** A `hook_additional_context` whose
content opens `<persisted-output>` is the stub the harness writes when the
payload crosses the 10,000-character cut; one without it carries the full text
inline — every inline one under the cut, as it must be (mantahostels#1869). **This is what
mantahostels#1872 counts after mantahostels#1870**: `--shape` reports it, and the test is that the
persisted count for `inject-tracker-docs.sh` reaches zero while the inline
count holds.

**`/code-review` appears in NEITHER shape**, despite being the one command
already under the cut: it is reached through the Skill tool inside another
session, so no prompt is ever submitted carrying `/code-review` and the
`UserPromptSubmit` hook never fires.

CORPUS. Every seat root's `projects/<slug>` main transcripts, one copy of
each session (`scripts/lib/transcript_corpus.py`'s `roots()`): each seat keeps
its own sessions, so one root alone is a fraction of the corpus (#375).
`--dir` reads one directory instead.

A file that will not open or a line that will not parse is COUNTED, not
skipped silently: `unreadable_files` and `unparsed_lines` ride on the output.

CONDITIONING ON TRACKER-MUTATION (mantahostels#3214). `/implement` is a generic coding
command; most invocations plausibly never touch the tracker, which depresses
its raw read rate without that being an injection failure. Each session is
also scored on whether it made at least one tracker-mutating `gh issue`
call — `create`, `edit`, `close`, `comment`, or a `gh api`/`graphql`
equivalent that mutates an issue — and the read rate is reported a second way,
restricted to that subset. This is a DIFFERENT predicate from
`commands_in_record`: that one detects a tracker COMMAND being invoked as
text (`/wayfinder`); this one detects an actual mutating call in the
transcript's own tool-use records (`command_mutates_tracker`).

A THIRD READ CHANNEL: `rule-text` (mantahostels#3275). The injector hands each command
a NAMED-RULE INDEX rather than a document pointer (mantahostels#2499), each id fetched at
its trigger with `scripts/lib/rule-text.sh <id>`. A session doing exactly what
the index asks opens neither document, so on the two path channels alone it
scores as a miss and every post-mantahostels#2499 figure is a lower bound of unknown
tightness. The third channel scores a session that RUNS the fetcher and asks it
for something, and records the ids it asked for where they parse statically.
Naming the path without running it (`cat scripts/lib/rule-text.sh`) is a
negative, read off the pipeline segment's program position exactly as
`bash_opens_path` reads its own — and so is a heredoc body line that merely
opens with the path, and a call that asks for no rule.

WHY THE WINDOW STILL CUTS ON THE OLD PREFILTER. `timestamp` is the first line
to survive the prefilter, so admitting `rule-text.sh` lines to it would place
some sessions earlier and move them across an `--after` bound (mantahostels#3275). The
fetch lines are therefore parsed but never timestamped, so mantahostels#1972's and mantahostels#3214's
figures stay comparable.

Output: one JSON object of raw counts on stdout, or a table with --table.
"""

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

# The commands `scripts/inject-tracker-docs.sh` fires on. The marker regex would
# accept any name, so a session is filtered against this list; without it a
# `--loose` run invents commands out of prose (mantahostels#1869).
COMMANDS = {
    "wayfinder",
    "to-spec",
    "to-tickets",
    "implement",
    "triage",
    "card-close",
    "code-review",
}

# The two documents the injector pastes today and points at after mantahostels#1870.
DOCS = {
    "issue-tracker": "docs/agents/issue-tracker.md",
    "triage-labels": "docs/agents/triage-labels.md",
}

# Every read channel, in report order: the two document paths, then the fetch
# route mantahostels#2499's index made the live one (mantahostels#3275).
RULE_CHANNEL = "rule-text"
CHANNELS = list(DOCS) + [RULE_CHANNEL]

# Tools whose input naming a path means the session opened it. `Edit`/`Write`
# are deliberately absent — see the module docstring.
READ_TOOLS = {"Read", "Bash", "Grep", "Glob"}
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}

# `Bash` is a read tool, but plenty of commands name a path without opening it
# (mantahostels#1869). An ALLOWLIST, not a blocklist: a blocklist counts every program
# nobody thought of as a read, and `git commit -m "$(cat <<'EOF' … <doc> … )"`
# defeats it outright. Unknown programs therefore do not count, so the residual
# bias is DOWNWARD (mantahostels#1869).
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

# Splits a shell line into the segments that each run one program.
SEGMENT = re.compile(r"&&|\|\||[;|\n]")

# The third channel's route (mantahostels#2499's index): the rule fetcher, matched on its
# basename so `scripts/lib/rule-text.sh` and `lib/rule-text.sh` both count.
FETCHER = "rule-text.sh"

# The words a session puts in FRONT of the fetcher. Anything else in the
# program position — `cat`, `sed`, `git` — names the file without running it.
#
# `bash` ONLY. The fetcher guards its CLI on
# `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` (`scripts/lib/rule-text.sh:115`), so
# `source`/`.` define its functions and print NOTHING, and `sh` — dash here —
# dies at line 69 on the bashism before reaching the guard. Scoring any of them
# would put an UPWARD bias in a scanner whose every other bias is downward
# (mantahostels#3275).
INTERPRETERS = {"bash"}

# The fetcher strips ONE leading `rule:` and then applies its own id grammar
# (`scripts/lib/rule-text.sh:76,84`), so a token is bared the same way here.
RULE_PREFIX = "rule:"
RULE_ID = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

# A word ending the argument run rather than joining it: a redirection, a
# comment, or an id built from a variable this scan cannot resolve.
RULE_STOPS = re.compile(r"[<>#$`]")

# A heredoc's opening word, and the body it swallows. `SEGMENT` splits on `\n`,
# so without this a body line beginning with the fetcher path is a segment whose
# program position IS the fetcher — and the repo writes issue bodies exactly
# that way, inflating the channel UPWARD (mantahostels#3275).
#
# The lookaround on both sides of `<<` excludes a here-string (`<<<word`):
# without it, `<<<"gh"` is read as a heredoc opener whose terminator is `gh`,
# swallowing the next real line — a downward bias on whatever channel that
# line carried (mantahostels#3283). `\\?` admits an escaped opener (`<<\EOF`), which the
# shell treats identically to a quoted one for body-expansion purposes.
#
# NOT FIXED HERE, and still biased per mantahostels#3283: two heredocs opened on one
# line (only the first terminator is captured, so the second's body reads as
# command text — upward), and a plain `<<EOF` whose terminator line is
# indented (`line.strip() == terminator` below closes it early regardless of
# `-`, which the shell would not do for a non-`-` opener, so the real body's
# tail reads as command text too — also upward). Neither shape has a measured
# corpus impact; mantahostels#3283 left them open rather than ruling on them blind.
HEREDOC_OPEN = re.compile(r"(?<!<)<<-?(?!<)\s*\\?['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")

QUOTES = "\"'`"

# `gh issue <subcommand>` shapes that change tracker state, as opposed to
# `view`/`list`/`status`, which only read it.
MUTATING_ISSUE_SUBCOMMANDS = {"create", "edit", "close", "comment"}

MUTATING_METHOD = re.compile(r"(?:-X|--method)[= ]+(POST|PATCH|DELETE|PUT)\b", re.I)
GRAPHQL_MUTATION = re.compile(r"\bmutation\b", re.I)

# Both shapes a hook's output takes in a transcript; see the module docstring.
HOOK_ATTACHMENTS = {"hook_additional_context", "hook_success"}

STRICT_MARKER = re.compile(r"You invoked /([A-Za-z-]+),")
LOOSE_MARKER = re.compile(r"You invoked /([A-Za-z-]+)")


def commands_in_record(rec, loose=False):
    """The tracker commands this record shows being invoked.

    `loose=True` takes the marker from anywhere in the record, reproducing the
    over-counting detector for comparison; the default requires a hook
    attachment. Either way the result is filtered against COMMANDS.
    """
    if loose:
        return set(LOOSE_MARKER.findall(json.dumps(rec))) & COMMANDS
    if rec.get("type") != "attachment":
        return set()
    att = rec.get("attachment") or {}
    if att.get("type") not in HOOK_ATTACHMENTS:
        return set()
    # `hook_success` carries the hook's output under keys this scanner should
    # not have to know, so the whole attachment is flattened rather than one
    # field of it. It is still an attachment, so nothing a session said or read
    # can reach here.
    return set(STRICT_MARKER.findall(json.dumps(att))) & COMMANDS


def persistence_of(rec):
    """`persisted`, `inline`, or `log` for the execution record."""
    att = rec.get("attachment") or {}
    if att.get("type") != "hook_additional_context":
        return "log"
    content = att.get("content")
    text = json.dumps(content) if not isinstance(content, str) else content
    return "persisted" if "<persisted-output>" in text else "inline"


def program_of(words):
    """(index, program) for the segment's own program, stepping over an
    assignment prefix. `index` is `None` where every word is an assignment.

    `cd x && grep …` splits on the `&&`, so the leading word of a segment is
    its program; an assignment prefix (`FOO=bar cmd`) is stepped over.
    """
    idx = next((i for i, w in enumerate(words) if "=" not in w.split("/")[0]), None)
    return idx, (words[idx] if idx is not None else "")


def bash_opens_path(command, path):
    """Does this shell line actually open `path`, rather than merely name it?"""
    for segment in SEGMENT.split(command):
        if path not in segment:
            continue
        _, program = program_of(segment.split())
        if os.path.basename(program) in READING_PROGRAMS:
            return True
    return False


def strip_heredoc_bodies(command):
    """`command` with every heredoc body dropped, terminators included.

    Quoting is not read: `<<'EOF'` and `<<EOF` swallow their body either way,
    and this scan never cares what a body expands to. An UNTERMINATED heredoc
    swallows the rest of the line run, which is what the shell does too.
    """
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
    """This pipeline segment's fetcher arguments, or None where it is not a call.

    The program is the segment's first word that is not an assignment prefix —
    `bash_opens_path`'s idiom — after stepping over `bash`, which is what makes
    `git log -- scripts/lib/rule-text.sh` score nothing.
    """
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
    """(called, ids) for one shell line: did it run the fetcher, and for what?

    `ids` holds only what parses statically — an id built from a variable, or
    reached past a redirection, ends the run — so it is a lower bound on what
    was asked for and never a reason to score the call itself as absent.
    Resolved-versus-refused is `scan_rule_fetches.py`'s question, not this one.
    """
    called, ids = False, set()
    if FETCHER not in command:
        return called, ids
    for segment in SEGMENT.split(strip_heredoc_bodies(command)):
        args = fetcher_args(segment)
        if args is None:
            continue
        # A call that asks for nothing gets no rule text: `--ids` enumerates the
        # store and exits, and a bare call is a usage error (exit 2). Neither is
        # delivery, so neither scores the channel. An unresolvable argument —
        # `"$id"` — still asks, and still does.
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
    """Does this shell line make a tracker-mutating `gh issue` call, or a
    `gh api`/`graphql` equivalent (create/edit/close/comment)?

    Same allowlist spirit as `bash_opens_path`: an unrecognised shape scores as
    NOT a mutation, so the bias sits downward on the conditioned n — with two
    named exceptions. A `gh api` call with a field flag (`-f`/`-F`) and no
    explicit `-X`/`--method` defaults to POST; that shape is scored as a
    non-mutation here, since every repo-documented mutation spells its method
    explicitly (`docs/agents/issue-tracker.md` §Where decisions get written).
    And `strip_heredoc_bodies` itself still carries the upward biases named on
    `HEREDOC_OPEN`'s own comment (mantahostels#3283).
    """
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
    """Does this record's own `tool_use` input carry a tracker-mutating call?

    Same guard as `paths_in_tool_use`: only the tool's INPUT, never message
    text or a tool result reporting back what a mutation did.
    """
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
    """(read, edited, rule_ids) off this record's own tool_use inputs.

    `read` carries the two document keys and, where the record ran the rule
    fetcher, `rule-text` beside them (mantahostels#3275).
    """
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
        # The tool's INPUT only. A tool_result carrying the file's text back is
        # a different record type and never reaches here.
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


# The needles whose line also places a session in time.
TIMED = ("docs/agents/", "You invoked /", "gh issue", "gh api")


def scan_file(path, tally, loose=False):
    """One transcript. `commands` is empty where it is not a tracker session.

    Always returns a row, never None: a file whose only marker sat on an
    unparsable line is not a tracker session AND has an unparsed count in
    `tally`.

    `timestamp` is the first line surviving the prefilter below, not the
    session's first record — the prefilter drops everything naming neither a
    document nor the marker. The injection lands early, so the two are close in
    practice, but a window cut on this field is cutting on an approximation.
    """
    cmds, read, edited, rule_ids = set(), set(), set(), set()
    shapes = collections.Counter()
    first_ts = None
    mutated = False
    # Cheap prefilter: a line mentioning neither a document, the invocation
    # marker, nor a `gh` call shaped like a mutation can carry none of the three
    # signals, so it is never parsed. The fetch route is parsed but NOT
    # timestamped — see the docstring's window paragraph.
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
    """Is this session at or after the cutoff?

    Compared lexically, so the cutoff is padded to the millisecond form the
    corpus uses. Without that, `--after 2026-08-28T14:03:24Z` drops every
    session inside that second, because `"…24.500Z" >= "…24Z"` is False.
    """
    if not after:
        return True
    if not timestamp:
        # Unplaceable, so dropped from a windowed run rather than assumed in it.
        return False
    if "." not in after and after.endswith("Z"):
        after = after[:-1] + ".000Z"
    return timestamp >= after


def corpus_paths(directory=None):
    """`directory`'s transcripts, or every seat root's main transcripts."""
    if directory is not None:
        return [
            os.path.join(directory, n)
            for n in sorted(os.listdir(directory))
            if n.endswith(".jsonl")
        ]
    return tc.main_transcripts()


def scan_dir(directory=None, loose=False, after=None):
    """(sessions, skipped): `skipped` sums every file's skip counts, the dropped
    files' included, so it covers the whole population the sessions were drawn
    from."""
    sessions, skipped = [], collections.Counter()
    for path in corpus_paths(directory):
        row = scan_file(path, skipped, loose)
        if not row["commands"] or not in_window(row["timestamp"], after):
            continue
        sessions.append(row)
    return sessions, skipped


def tally(sessions):
    """Per-command counts, plus the subset conditioned on a tracker-mutating
    `gh issue` call (mantahostels#3214) — `n_mutated` and `read_mutated` cover only that
    subset, so the raw and conditioned rates stay directly comparable.
    A session naming two commands counts under both.
    """
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
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
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
                # Every channel is emitted explicitly, zero included, so a consumer can
                # tell "no session read it" from "this run does not measure it".
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
