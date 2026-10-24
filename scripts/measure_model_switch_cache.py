#!/usr/bin/env python3
"""measure_model_switch_cache.py — measure what a mid-session model switch does to the prompt cache.

Re-runs the measurement behind https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/opusplan-model-switch-cache.md
(mantahostels#1092): every seat root's transcripts for this repo are scanned for a
turn whose model differs from the turn before it, and the cache counters either
side of that turn are printed.

A switch turn that kept its prefix would show a large
cache_read_input_tokens; one that lost the cache shows ~0 read and the whole
prefix as cache_creation_input_tokens.

It also prints the two figures the note's "not partial survival" argument
rests on: the commonest first-turn cache reads across the corpus (a small fixed
preamble block cached against a model by other sessions' traffic), and whether
each switch's write is read back whole on the next turn.

Usage: python3 scripts/measure_model_switch_cache.py [project-dir]

Scope: this repo on every seat (#379), not the whole machine; a project-dir
argument reads that one directory instead.
"""

import collections
import os
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import transcript_corpus as tc

# Claude Code writes a model as a full id (`claude-opus-5`) or, in some
# sessions, as the bare alias the founder typed (`opus`). A turn either side of
# an alias boundary may be the same model under two spellings, so an event
# whose two models share a family and one of whose sides is a bare alias is
# reported as ALIAS? rather than counted as a settled switch.
ALIASES = {"opus", "sonnet", "fable", "haiku"}


def family(model):
    """The model family a spelling names — `claude-opus-5` and `opus` are both opus."""
    for name in ALIASES:
        if name in model:
            return name
    return model


def is_alias_boundary(before, after):
    return family(before) == family(after) and (before in ALIASES or after in ALIASES)


def turns(path, tally):
    """Assistant turns in one transcript, de-duplicated and model-tagged.

    De-duplication key is `(message.id, output_tokens,
    cache_creation_input_tokens)` — the key
    https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/allowance-burn-measurement.md (mantahostels#830) established, kept so
    the counts here stay comparable with that measurement.

    A turn with no `model`, and a `<synthetic>` one (a message the harness
    wrote, carrying no real usage), is dropped rather than counted. A transcript
    rotated or deleted between the glob and the open — the corpus is live
    (mantahostels#1092) — is counted into `tally` with the lines that will not
    parse.
    """
    seen = set()
    out = []
    for entry in tc.records(path, tally):
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        model = message.get("model")
        if not model or model == "<synthetic>":
            continue
        usage = message.get("usage") or {}
        key = (
            message.get("id"),
            usage.get("output_tokens"),
            usage.get("cache_creation_input_tokens"),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "ts": entry.get("timestamp"),
                "model": model,
                "read": usage.get("cache_read_input_tokens", 0),
                "write": usage.get("cache_creation_input_tokens", 0),
            }
        )
    return out


def switches(seq):
    """Every model change in one transcript, with the turns either side."""
    out = []
    for i in range(1, len(seq)):
        if seq[i]["model"] != seq[i - 1]["model"]:
            out.append(
                {
                    "index": i,
                    "prev": seq[i - 1],
                    "switch": seq[i],
                    "next": seq[i + 1] if i + 1 < len(seq) else None,
                    "alias_boundary": is_alias_boundary(
                        seq[i - 1]["model"], seq[i]["model"]
                    ),
                }
            )
    return out


def reconciles(event):
    """Does the next turn read back exactly what the switch turn wrote?

    Exactly means the write, plus whatever the switch turn itself read — the
    small fixed preamble block, where that was already cached against the
    destination model. A re-write that reconciles is a one-off: the new cache
    is built once and read normally thereafter.
    """
    nxt = event["next"]
    if not nxt:
        return None
    return nxt["read"] == event["switch"]["write"] + event["switch"]["read"]


def corpus(project_dir=None):
    """(path, "session" | "subagent") under `project_dir`, or under every seat
    root, one copy of each session, where it is None."""
    return [
        (p, "subagent" if is_sub else "session") for p, is_sub in tc.files(project_dir)
    ]


def main():
    project_dir = sys.argv[1] if len(sys.argv) > 1 else None
    if project_dir is not None and not os.path.isdir(project_dir):
        sys.exit(f"not a directory: {project_dir}")
    files = corpus(project_dir)
    if not files:
        sys.exit(f"no transcripts under {project_dir or ', '.join(tc.roots())}")

    events = []
    steady_writes = []
    first_reads = []
    tally = collections.Counter()
    for path, kind in files:
        seq = turns(path, tally)
        if not seq:
            continue
        if kind == "session":
            first_reads.append(seq[0]["read"])
        for event in switches(seq):
            event["file"] = os.path.basename(path)
            event["kind"] = kind
            events.append(event)
        for i in range(1, len(seq)):
            # The ordinary-turn baseline is cache HITS only: a turn that read
            # nothing is either a switch or a cold start, neither of which is
            # the steady state being compared against.
            if seq[i]["model"] == seq[i - 1]["model"] and seq[i]["read"] > 0:
                steady_writes.append(seq[i]["write"])

    sessions = sum(1 for _, kind in files if kind == "session")
    print(
        f"corpus: {sessions} session transcripts, {len(files) - sessions} subagent ones"
        f"  {tc.counts_line(tally)}"
    )

    print("\ncommonest first-turn cache_read (the fixed preamble block):")
    for read, n in collections.Counter(first_reads).most_common(6):
        print(f"  {read:>7} tokens  {n} sessions")

    real = [e for e in events if not e["alias_boundary"]]
    aliased = [e for e in events if e["alias_boundary"]]
    print(
        f"\nswitch events: {len(real)} across "
        f"{len({e['file'] for e in real})} transcripts "
        f"({len({e['file'] for e in real if e['kind'] == 'session'})} sessions, "
        f"{len({e['file'] for e in real if e['kind'] == 'subagent'})} subagents)"
    )
    if aliased:
        print(f"  plus {len(aliased)} ALIAS? boundaries, not counted as switches")
    if not real:
        return
    for pair, n in collections.Counter(
        f"{e['prev']['model']} -> {e['switch']['model']}" for e in real
    ).most_common():
        print(f"  {pair}: {n}")

    reads = sorted(e["switch"]["read"] for e in real)
    writes = [e["switch"]["write"] for e in real]
    print(f"\nswitch-turn cache_read:  {reads}")
    print(
        "switch-turn cache_write: "
        f"min {min(writes)} median {int(statistics.median(writes))} max {max(writes)}"
    )
    if steady_writes:
        print(
            "same-model turn cache_write (cache hits only): median "
            f"{int(statistics.median(steady_writes))} (n={len(steady_writes)})"
        )
    checked = [e for e in real if e["next"]]
    print(
        f"next turn reads the switch's write back whole: "
        f"{sum(1 for e in checked if reconciles(e))} / {len(checked)}"
    )

    print("\nper event (prev turn / switch turn / next turn):")
    for e in real:
        print(
            f"\n  {e['file']} [{e['kind']}]  "
            f"{e['prev']['model']} -> {e['switch']['model']}  at {e['switch']['ts']}"
        )
        print(f"    prev  read={e['prev']['read']:>7} write={e['prev']['write']:>7}")
        print(
            f"    SWCH  read={e['switch']['read']:>7} write={e['switch']['write']:>7}"
        )
        if e["next"]:
            print(
                f"    next  read={e['next']['read']:>7} write={e['next']['write']:>7}"
            )


if __name__ == "__main__":
    main()
