#!/usr/bin/env python3

import os
import sys

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
    with open(FINDINGS, "a") as f:
        f.write(msg + "\n")
    print(msg)
    sys.stdout.flush()


ALWAYS_LOADED_MARKERS = [
    "Codebase and user instructions are shown below",
    "# This is NOT the Next.js you know",
    "# Working contract",
]

TRACKER_MARKERS = [
    "The project's tracker rules are below",
    "# Issue tracker: GitHub",
]
