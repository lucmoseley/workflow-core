#!/usr/bin/env python3
"""lib.py — shared constants and helpers for the context-bucket measurement (mantahostels#1081).

The four stages run in order — extract, stage2, stage3, stage4 — handing state
on through pickles in OUT. Add a bucket here, never in a stage.
"""

import os
import sys

# Output directory for findings.md and the inter-stage pickles.
# Override with OUT=<dir>; defaults to the current working directory.
OUT = os.environ.get("OUT", os.getcwd())
FINDINGS = OUT + "/findings.md"

BUCKET_KEYS = [
    "fixed_preamble",
    "always_loaded",
    "hook_injected.hook_success",
    "hook_injected.hook_success.tracker",
    "hook_injected.hook_additional_context",
    "hook_injected.hook_additional_context.tracker",
    "hook_injected.other",
    "tool_results.Bash",
    "tool_results.Read",
    "tool_results.Grep",
    "tool_results.Glob",
    "tool_results.Edit",
    "tool_results.Write",
    "tool_results.WebFetch",
    "tool_results.WebSearch",
    "tool_results.Task",
    "tool_results.other",
    "tool_results.file_attachment",
    "conversation_history.text",
    "conversation_history.thinking",
    "conversation_history.tool_use",
    "user_prompts",
    "skill_bodies",
    "subagent_dispatch",
]


def log(msg):
    """Append to findings.md and echo, so a long run reports as it goes."""
    with open(FINDINGS, "a") as f:
        f.write(msg + "\n")
    print(msg)
    sys.stdout.flush()


# Substrings that identify the always-loaded block in a session's first user
# message: CLAUDE.md and its two @-imports, wrapped by the harness.
#
# RECONSTRUCTED, not recovered. extract.py referenced this list and
# TRACKER_MARKERS below without ever defining or importing either, so the
# committed script has never run — it raises NameError on its first user
# message. The values the mantahostels#1081 measurement actually used lived only in that
# session's own copy and are unrecoverable, so the figures published from that
# run cannot be reproduced by re-running this file. These strings are read off
# the harness wrapper and the two imported files as they stand today.
ALWAYS_LOADED_MARKERS = [
    "Codebase and user instructions are shown below",
    "# This is NOT the Next.js you know",
    "# Working contract",
]

# Substrings that identify the issue-tracker rules scripts/inject-tracker-docs.sh
# pastes into a session. Same reconstruction caveat as ALWAYS_LOADED_MARKERS.
TRACKER_MARKERS = [
    "The project's tracker rules are below",
    "# Issue tracker: GitHub",
]
