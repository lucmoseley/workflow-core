#!/usr/bin/env python3
"""extract.py — stage 1 of mantahostels#1081's mechanical cache-read bucket-breakdown
measurement.

Streams every parent + subagent transcript line-by-line (never loads a whole
file as a list of parsed objects). Reconstructs, per session, the cumulative
byte composition of the prompt prefix at each assistant turn that shows
cache_read_input_tokens > 0, and attributes that cache-read pro rata to
bucket byte share. Findings are appended to findings.md as each stage
completes.
"""

import collections
import datetime
import gc
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

from lib import (
    ALWAYS_LOADED_MARKERS,
    BUCKET_KEYS,
    FINDINGS,
    OUT,
    TRACKER_MARKERS,
    log,
)


def transcript_paths():
    """(parent paths, subagent paths) across every seat root."""
    files = sorted(tc.one_copy_each())
    return ([p for p, sub, _ in files if not sub], [p for p, sub, _ in files if sub])


def new_bucket_dict():
    return {k: 0 for k in BUCKET_KEYS}


# tool name lookup for tool_result attribution
TOOL_NAMES_KEEP = {
    "Bash",
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "WebFetch",
    "WebSearch",
    "Task",
    "Agent",
}


def classify_tool(name):
    if name in ("Task", "Agent"):
        return "tool_results.Task"
    if name in TOOL_NAMES_KEEP:
        return "tool_results." + name
    return "tool_results.other"


def content_block_iter(content):
    """Yield blocks from a message content field, whatever shape it's in."""
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict):
                yield b
    # plain string content handled by caller


class SessionState:
    __slots__ = (
        "bucket_bytes",
        "turn_idx",
        "tool_use_names",
        "first_user_seen",
        "always_loaded_bytes",
        "seen_msg_keys",
        "rows",
        "entrypoint",
        "first_asst_seen",
        "first_user_bytes",
    )

    def __init__(self):
        self.bucket_bytes = new_bucket_dict()
        self.turn_idx = 0
        self.tool_use_names = {}  # tool_use_id -> tool name
        self.first_user_seen = False
        self.always_loaded_bytes = 0
        self.seen_msg_keys = set()
        self.rows = []
        self.entrypoint = None
        self.first_asst_seen = False
        self.first_user_bytes = 0


class Totals:
    """One population's accumulators, parent or subagent, filled across its files."""

    __slots__ = (
        "rows",
        "preamble_rows",
        "always_loaded_stats",
        "skill_body_stats",
        "tool_byte_totals",
        "subagent_dispatch_bytes",
    )

    def __init__(self):
        self.rows = []
        self.preamble_rows = []
        self.always_loaded_stats = []
        self.skill_body_stats = collections.defaultdict(list)
        self.tool_byte_totals = collections.Counter()
        self.subagent_dispatch_bytes = 0


def process_file(path, is_subagent, tally, out):
    """`out` is the caller's accumulator, its population's `Totals`: this
    file's rows and byte stats are added to it, and its skips to `tally`."""
    st = SessionState()
    session_id = os.path.basename(path).replace(".jsonl", "").replace("agent-", "")
    for d in tc.records(path, tally):
        t = d.get("type")
        if st.entrypoint is None and d.get("entrypoint"):
            st.entrypoint = d.get("entrypoint")
        ts = d.get("timestamp")

        if t == "user":
            msg = d.get("message", {})
            content = msg.get("content")
            added_prompt = 0
            if isinstance(content, str):
                added_prompt += tc.jlen(content)
                if not st.first_user_seen:
                    # check for always-loaded marker
                    if any(m in content for m in ALWAYS_LOADED_MARKERS):
                        st.always_loaded_bytes = tc.jlen(content)
                        out.always_loaded_stats.append(st.always_loaded_bytes)
                    st.first_user_bytes = tc.jlen(content)
            elif isinstance(content, list):
                for b in content:
                    bt = b.get("type")
                    if bt == "tool_result":
                        tid = b.get("tool_use_id")
                        toolname = st.tool_use_names.get(tid, "other")
                        key = classify_tool(toolname)
                        sz = tc.jlen(b.get("content"))
                        st.bucket_bytes[key] += sz
                        out.tool_byte_totals[
                            toolname if toolname != "other" else "other"
                        ] += sz
                    elif bt == "text":
                        txt = b.get("text", "")
                        added_prompt += tc.jlen(txt)
                        if not st.first_user_seen:
                            joined = txt
                            if any(m in joined for m in ALWAYS_LOADED_MARKERS):
                                st.always_loaded_bytes = tc.jlen(txt)
                                out.always_loaded_stats.append(st.always_loaded_bytes)
                            st.first_user_bytes += tc.jlen(txt)
                    else:
                        added_prompt += tc.jlen(b)
            st.bucket_bytes["user_prompts"] += added_prompt
            if not st.first_user_seen:
                st.first_user_seen = True
                if st.always_loaded_bytes == 0:
                    out.always_loaded_stats.append(0)

        elif t == "assistant":
            msg = d.get("message", {})
            usage = msg.get("usage", {}) or {}
            mid = msg.get("id")
            out_tok = usage.get("output_tokens")
            cc = usage.get("cache_creation_input_tokens")
            dedup_key = (mid, out_tok, cc)
            content = msg.get("content")
            is_dup = mid is not None and dedup_key in st.seen_msg_keys
            if mid is not None:
                st.seen_msg_keys.add(dedup_key)

            # record tool_use ids regardless of dup (harmless if repeated)
            text_bytes = thinking_bytes = tooluse_bytes = 0
            if isinstance(content, list):
                for b in content:
                    bt = b.get("type")
                    if bt == "tool_use":
                        st.tool_use_names[b.get("id")] = b.get("name")
                        sz = tc.jlen(b.get("input"))
                        tooluse_bytes += sz
                        if b.get("name") in ("Task", "Agent"):
                            out.subagent_dispatch_bytes += sz  # dispatch input
                    elif bt == "text":
                        text_bytes += tc.jlen(b.get("text", ""))
                    elif bt == "thinking":
                        thinking_bytes += tc.jlen(b.get("thinking", ""))

            if is_dup:
                continue

            cache_read = usage.get("cache_read_input_tokens") or 0
            cache_creation = usage.get("cache_creation_input_tokens") or 0
            out_tokens = usage.get("output_tokens") or 0
            model = msg.get("model")
            skill = d.get("attributionSkill")

            if cache_read > 0:
                # snapshot cumulative prefix composition BEFORE adding this turn's own content
                snap = dict(st.bucket_bytes)
                total_bytes = sum(snap.values())
                st.rows.append(
                    (
                        session_id,
                        is_subagent,
                        st.entrypoint,
                        model,
                        ts,
                        st.turn_idx,
                        cache_read,
                        cache_creation,
                        out_tokens,
                        skill,
                        total_bytes,
                        snap,
                    )
                )

            if not st.first_asst_seen:
                st.first_asst_seen = True
                out.preamble_rows.append(
                    (
                        cache_creation,
                        usage.get("input_tokens") or 0,
                        st.first_user_bytes,
                    )
                )

            # now fold this turn's own output into cumulative prefix (becomes history for next turn)
            st.bucket_bytes["conversation_history.text"] += text_bytes
            st.bucket_bytes["conversation_history.thinking"] += thinking_bytes
            st.bucket_bytes["conversation_history.tool_use"] += tooluse_bytes
            st.turn_idx += 1

        elif t == "attachment":
            att = d.get("attachment", {}) or {}
            at = att.get("type")
            if at == "hook_success":
                content = att.get("content") or att.get("stdout") or ""
                sz = tc.jlen(content)
                st.bucket_bytes["hook_injected.hook_success"] += sz
                if any(m in (content or "") for m in TRACKER_MARKERS):
                    st.bucket_bytes["hook_injected.hook_success.tracker"] += sz
            elif at == "hook_additional_context":
                content = att.get("content")
                sz = tc.jlen(content)
                st.bucket_bytes["hook_injected.hook_additional_context"] += sz
                joined = (
                    content
                    if isinstance(content, str)
                    else json.dumps(content, ensure_ascii=False)
                )
                if any(m in joined for m in TRACKER_MARKERS):
                    st.bucket_bytes[
                        "hook_injected.hook_additional_context.tracker"
                    ] += sz
            elif at in (
                "hook_system_message",
                "skill_listing",
                "agent_listing_delta",
                "deferred_tools_delta",
                "task_reminder",
                "total_tokens_reminder",
                "mcp_instructions_delta",
                "command_permissions",
                "queued_command",
            ):
                st.bucket_bytes["hook_injected.other"] += tc.jlen(att)
            elif at in ("file", "edited_text_file"):
                st.bucket_bytes["tool_results.file_attachment"] += tc.jlen(att)
            elif at == "invoked_skills":
                skills = att.get("skills") or []
                total = 0
                for s in skills:
                    name = s.get("name", "unknown")
                    sz = tc.jlen(s.get("content", ""))
                    out.skill_body_stats[name].append(sz)
                    total += sz
                st.bucket_bytes["skill_bodies"] += total
            # else: compact_file_reference, date_change, hook_blocking_error,
            # hook_non_blocking_error, hook_cancelled, task_status, auto_mode -> ignored (not billable / not context)
        # other line types (custom-title, agent-name, last-prompt, mode, queue-operation,
        # agent-setting, permission-mode, file-history-*, system, pr-link, atis-latch, ai-title)
        # -> metadata, not part of the model-visible prefix; ignored per spec.

    out.rows.extend(st.rows)


def main():
    open(FINDINGS, "w").close()
    log("# Issue mantahostels#1081 bucket-breakdown findings\n")
    log(f"Run started: {datetime.datetime.now(datetime.UTC).isoformat()}\n")

    os.system("free -m")
    import subprocess

    free_before = subprocess.run(["free", "-m"], capture_output=True, text=True).stdout
    log("## free -m BEFORE\n```\n" + free_before + "```\n")

    parent_files, subagent_files = transcript_paths()
    log(f"Parent transcript files found: {len(parent_files)}")
    log(f"Subagent transcript files found: {len(subagent_files)}\n")

    parent, sub = Totals(), Totals()
    tally = collections.Counter()

    n = 0
    for p in parent_files:
        process_file(p, False, tally, parent)
        n += 1
        if n % 200 == 0:
            log(
                f"...processed {n}/{len(parent_files)} parent files, rows so far: {len(parent.rows)}"
            )
            gc.collect()

    log(f"\nParent files done. Total cache-read rows: {len(parent.rows)}\n")

    n = 0
    for p in subagent_files:
        process_file(p, True, tally, sub)
        n += 1
        if n % 200 == 0:
            log(
                f"...processed {n}/{len(subagent_files)} subagent files, rows so far: {len(sub.rows)}"
            )
            gc.collect()

    log(f"\nSubagent files done. Total cache-read rows: {len(sub.rows)}")
    log(f"{tc.counts_line(tally)}\n")

    free_after = subprocess.run(["free", "-m"], capture_output=True, text=True).stdout
    log("## free -m AFTER\n```\n" + free_after + "```\n")

    # -------- Save intermediate rows to disk for downstream analysis (avoid recompute) -----
    import pickle

    with open(OUT + "/rows.pkl", "wb") as f:
        pickle.dump(
            {
                "rows": parent.rows,
                "sub_rows": sub.rows,
                "preamble_rows": parent.preamble_rows,
                "sub_preamble_rows": sub.preamble_rows,
                "always_loaded_stats": parent.always_loaded_stats,
                "sub_always_loaded_stats": sub.always_loaded_stats,
                "skill_body_stats": dict(parent.skill_body_stats),
                "sub_skill_body_stats": dict(sub.skill_body_stats),
                "tool_byte_totals": dict(parent.tool_byte_totals),
                "sub_tool_byte_totals": dict(sub.tool_byte_totals),
                "subagent_dispatch_bytes": parent.subagent_dispatch_bytes,
                "sub_subagent_dispatch_bytes": sub.subagent_dispatch_bytes,
            },
            f,
        )
    log("Saved intermediate rows to rows.pkl for stage 2 analysis.\n")


if __name__ == "__main__":
    main()
