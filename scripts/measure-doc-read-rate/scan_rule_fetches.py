#!/usr/bin/env python3
"""
scan_rule_fetches.py — does a session handed a per-command rule INDEX go and fetch the rules? (mantahostels#2501)

`scripts/inject-tracker-docs.sh` hands a session a per-command index of rule ids
(mantahostels#2499), each named with its trigger, and one instruction: fetch with
`scripts/lib/rule-text.sh <id>` at the moment the trigger fires. So the question
`scan_doc_reads.py` answers — did the session open
`docs/agents/issue-tracker.md`? — does not measure delivery for
an indexed rule: its text does not live in that file's read path at all.

Per transcript: which tracker commands were invoked, whether the session ran
`scripts/lib/rule-text.sh` and what it got — read from a `Bash` tool_use's own
`input.command`, never from message text, a tool result or the injected
attachment. Rates are per command, never pooled.

CALLED IS NOT RESOLVED. The fetcher exits 1 on an id the store cannot answer,
and takes the whole list down with it, so a session can run the fetcher and get
no rule text at all. So three columns, not one — `called`, `resolved` and
`refused`, the last being sessions that asked for an id they never went back
and got. Pooling them would score a refusal as delivery.

THE `rule:` PREFIX IS NOT A REFUSAL. `rule-text.{sh,js}` strip ONE leading
`rule:` and resolve the rest (mantahostels#2718), so `rule:gh-cli-limits` scores exactly as
`gh-cli-limits` does and only an id naming no fragment lands in `refused`.

A TOKEN THAT IS NOT AN ID AT ALL refuses the call and NAMES NOTHING, so it
appears in no column but `called` — a path, a stray word, and `rule:rule:x`,
which bares once to `rule:x` and fails the grammar.

RUNNING THE FETCHER IS NOT NAMING IT. `cat`, `sed`, `wc`, `shellcheck` and
`git log -- <path>` all put the path in a Bash command without opening it, and
the last of them would score its trailing pathspec words as rule ids. So a call
is read from the PROGRAM POSITION of a pipeline segment — `scan_doc_reads`'s
own `fetcher_args`, imported rather than duplicated (mantahostels#3279) — and `bash` is the
only word allowed in front of it: `source`/`.` stop at the fetcher's CLI guard
and `sh` (dash here) dies on a bashism first, so none of the three delivers any
rule text, matching what `scan_doc_reads` scores as a read.

ONE DIVERGENCE IS DELIBERATELY KEPT, NOT IMPORTED: `scan_doc_reads` refuses an
argument-less call — a bare `rule-text.sh` or one holding only flags such as
`--ids` — as not `called` (its `rule_fetches_in_command`); this file's
`fetches_in_record` still scores such a call `called = True`, because whether
the call was ANSWERED, not merely made, is this file's own question (`--ids`
enumeration among them). So `called` here and `read`'s `rule-text` channel
there disagree on that one shape, by design (mantahostels#3279).

THIS IS NOT A COMPLIANCE RATE. The index says to fetch
*at the trigger*, so a session that never reaches one is correct to fetch
nothing. The denominator here is every session naming the command, so the
figure is a LOWER BOUND on correct behaviour by an unmeasured margin — the
number of sessions that hit a trigger is not observable from the transcript.

BIASES, all DOWNWARD:
  * The command is taken from the tool_use `input` only, so a fetch made from
    inside a script, or by a subagent in its own transcript, is unseen.
  * A session that already knows a rule and acts correctly without fetching
    scores as a non-fetcher. The index tells it not to (`Never act on a
    trigger from memory or inference`), so this is the behaviour under test —
    but it means the rate is not a proxy for outcomes.
  * An id this scan cannot resolve statically — built from a shell variable, or
    reached through a command substitution — ends the argument run, so the call
    lands in `called` and in neither of the other two columns.

Invocation detection, pipeline segmentation, the corpus, the record shapes and
the fetch-call detector itself are all `scan_doc_reads.py`'s and imported from
it (mantahostels#3279), `INTERPRETERS` reached through `fetcher_args` rather than by name —
this file keeps only what is its own question: resolved-versus-refused against
the store, `--ids` enumeration, and the guard-emission needles. The two
prefilters are aligned, so the denominator here and there is the same
population. Its `scan_file` caveat carries here too: `timestamp` is the first
line to survive the prefilter, not the session's first record.

Output: one JSON object of raw counts on stdout, or a table with --table.
"""

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


def rules_dir():
    """The store the fetcher resolves against. Without it `resolved` means
    "spelled like an id" rather than "got the text": `rule-text.sh no-such-rule`
    exits 1."""
    return os.environ.get(
        "WFC_RULES_DIR",
        str(
            Path(__file__).resolve().parent.parent.parent / "docs" / "agents" / "rules"
        ),
    )


# The rules `scripts/lib/tracker-rules.js` hands over on the Bash call. That
# guard, not the index, is the route spec mantahostels#2457's "~100%" belongs
# to: the index carries only what has no `gh` shape a guard can catch it on.
GUARD = "scripts/lib/tracker-rules.js"
# The core names its ids literally, in one `injectRules: [...]` array.
IDS_ARRAY = re.compile(r"^\s*injectRules: \[(.*?)\]", re.M | re.S)
QUOTED_ID = re.compile(r'"([a-z0-9-]+)"')


def guard_ids():
    """The ids `lib/tracker-rules.js` registers, read from the core itself.

    Read rather than listed here, so a rule added to or dropped from the guard
    is counted without this file being touched. An unreadable guard reads as no
    ids, which the output prints as its needle count (#1274).
    """
    try:
        src = open(
            os.path.join(os.path.dirname(rules_dir()), "..", "..", GUARD),
            encoding="utf-8",
        ).read()
    except OSError:
        return set()
    return {i for run in IDS_ARRAY.findall(src) for i in QUOTED_ID.findall(run)}


def needles():
    """One stable needle per guard-routed rule: its fragment's opening bytes.

    An emission reaches the transcript as the fragment's own text inside a hook
    attachment, so the fragment is the only thing to match on. The opening is
    taken rather than the whole because `gp_rule` truncates a fragment that
    does not fit its cap, and a whole-text match would score a truncated
    delivery as no delivery.

    A rule whose fragment will not open gets no needle, so its emissions read
    as none; the output prints how many guard ids got one (#1274).
    """
    out, store = {}, rules_dir()
    for rule in guard_ids():
        try:
            with open(os.path.join(store, f"{rule}.txt"), encoding="utf-8") as fh:
                text = fh.read().strip()
        except OSError:
            continue
        if len(text) >= NEEDLE:
            out[rule] = text[:NEEDLE]
    return out


# Long enough that no ordinary prose collides with it, short enough to survive
# `gp_rule`'s truncation of a fragment that does not fit its cap. 60 is a guess
# against both limits, not a measurement.
NEEDLE = 60


def store_ids():
    try:
        return {f[:-4] for f in os.listdir(rules_dir()) if f.endswith(".txt")}
    except OSError:
        # No store reads as every fetch refused; the output prints the store's
        # size, so an empty read shows as 0 (#1274).
        return set()


def ids_in_call(args, ids):
    """(resolved, refused) for one call, against the store's `ids`.

    ALL OR NOTHING, because the fetcher is: `rule-text.sh` resolves every id in
    the list before printing any of them and exits 1 with empty stdout on one
    bad id anywhere (its header, mantahostels#2494). So a call mixing a good id with an
    unanswerable one delivered NEITHER, and scoring the good one as resolved
    would credit a session that got nothing.
    """
    asked, bad = set(), False
    for token in args:
        if RULE_STOPS.search(token):
            break
        if token.startswith("-"):
            # `--ids` enumerates and exits before resolving; it asks for nothing
            # and refuses nothing.
            continue
        # One prefix, as the fetcher strips one.
        bare = token[len(RULE_PREFIX) :] if token.startswith(RULE_PREFIX) else token
        if bare in ids:
            asked.add(bare)
            continue
        if RULE_ID.match(bare):
            # An id the store cannot answer. Named, because the session asked
            # for it by name — and the fetcher exits 1, taking the list with it.
            asked.add(bare)
        # A path or a stray word refuses the call without naming an id.
        bad = True
    if bad:
        return set(), asked
    return asked, set()


def fetches_in_record(rec):
    """What this record's own Bash tool_use inputs asked the fetcher for.

    Returns `(called, resolved, refused)`: whether any segment RAN the fetcher,
    and the ids it got and did not get.
    """
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
    """The guard-routed rules whose text this record's hook attachment carries.

    An attachment only, never a message and never a tool result: the guard's
    output arrives as one, and a session quoting a rule back would otherwise
    score as having been handed it.
    """
    if rec.get("type") != "attachment":
        return set()
    att = rec.get("attachment") or {}
    if att.get("type") not in HOOK_ATTACHMENTS:
        return set()
    blob = json.dumps(att)
    return {rule for rule, needle in marks.items() if json.dumps(needle)[1:-1] in blob}


def scan_file(path, tally, marks=None):
    """One transcript, its skips counted into `tally`. `commands` is empty where
    it is not a tracker session."""
    marks = needles() if marks is None else marks
    cmds, resolved, refused, emitted = set(), set(), set(), set()
    called = False
    first_ts = None
    # scan_doc_reads' prefilter, WIDENED by the fetch route rather than replaced
    # by it. `timestamp` is the first line to survive this, so a narrower filter
    # here would place the same session at a different instant and cut it
    # differently at the window edge — measured, 4 of 143 `/implement` sessions
    # moved across the bound.
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
    """(sessions, skipped), as scan_doc_reads' `scan_dir`."""
    sessions, skipped = [], Counter()
    for path in corpus_paths(directory):
        row = scan_file(path, skipped)
        if not row["commands"] or not in_window(row["timestamp"], after):
            continue
        sessions.append(row)
    return sessions, skipped


def tally(sessions):
    """Per-command counts. A session naming two commands counts under both."""
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
            # `refused` counts SESSIONS, not ids, and excludes any id the
            # session later resolved.
            per[c]["refused"] += 1 if s["refused"] else 0
            per[c]["emitted"] += 1 if s["emitted"] else 0
            for i in s["resolved"]:
                per[c]["ids"][i] += 1
    return per


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
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
