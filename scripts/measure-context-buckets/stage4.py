#!/usr/bin/env python3
"""stage4.py — stage 4 of mantahostels#1081's context-bucket measurement: before/after
concision-work split, per-day series, cost weighting, ranking.

A stage of its own so the figures can be recut from stages 2 and 3's pickles
without re-streaming the transcript corpus.
"""

import pickle
import collections
import math
import datetime
from lib import BUCKET_KEYS, OUT, log


def pctl(vals, p):
    if not vals:
        return 0
    vals = sorted(vals)
    k = (len(vals) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return vals[int(k)]
    return vals[f] + (vals[c] - vals[f]) * (k - f)


def main():
    s2 = pickle.load(open(OUT + "/stage2_partial.pkl", "rb"))
    s3 = pickle.load(open(OUT + "/stage3_partial.pkl", "rb"))
    cli_rows = s2["cli_rows"]
    preamble_bytes_med = s3["preamble_bytes_med"]

    log(
        "\n---\n## Stage 4: before/after 15 Aug 2026 split, per-day series, ranking, cost weighting\n"
    )

    def day(ts):
        return ts[:10] if ts else None

    pre = [r for r in cli_rows if r[4] and day(r[4]) <= "2026-08-14"]
    post = [r for r in cli_rows if r[4] and day(r[4]) >= "2026-08-15"]
    log(
        f"Pre (through 14 Aug): {len(pre)} rows. Post (15 Aug onward): {len(post)} rows.\n"
    )

    def bucket_bytes_per_turn(rows):
        out = {}
        for k in BUCKET_KEYS:
            vals = []
            for r in rows:
                snap = r[11]
                b = snap.get(k, 0)
                if k == "fixed_preamble":
                    b = preamble_bytes_med
                vals.append(b)
            out[k] = vals
        return out

    pre_b = bucket_bytes_per_turn(pre)
    post_b = bucket_bytes_per_turn(post)

    log("### Pre vs post per-turn median bytes (key buckets)\n")
    log("| bucket | pre median | post median | abs change | %% change |")
    log("|---|---|---|---|---|")
    total_pre_med = 0
    total_post_med = 0
    for k in BUCKET_KEYS:
        pm = pctl(pre_b[k], 0.5)
        qm = pctl(post_b[k], 0.5)
        total_pre_med += pm
        total_post_med += qm
        chg = qm - pm
        pct = 100 * chg / pm if pm else float("nan")
        log(
            f"| {k} | {pm:,.0f} | {qm:,.0f} | {chg:+,.0f} | {pct:+.1f}% |"
            if pm
            else f"| {k} | {pm:,.0f} | {qm:,.0f} | {chg:+,.0f} | n/a |"
        )
    log(
        f"| **sum of per-bucket medians** | {total_pre_med:,.0f} | {total_post_med:,.0f} | {total_post_med - total_pre_med:+,.0f} | {100 * (total_post_med - total_pre_med) / total_pre_med:+.1f}% |"
    )
    log(
        "(Note: sum-of-medians is not the median-of-sums; use as a directional summary only.)\n"
    )

    # total cache-read per turn pre/post (observed, not reconstructed)
    pre_cr = [r[6] for r in pre]
    post_cr = [r[6] for r in post]
    log(
        f"Observed cache_read_input_tokens per turn: pre median={pctl(pre_cr, 0.5):,.0f} tok, post median={pctl(post_cr, 0.5):,.0f} tok, change={pctl(post_cr, 0.5) - pctl(pre_cr, 0.5):+,.0f} tok ({100 * (pctl(post_cr, 0.5) - pctl(pre_cr, 0.5)) / max(1, pctl(pre_cr, 0.5)):+.1f}%).\n"
    )

    # per-day series for always_loaded(folded->fixed_preamble constant, so use hook_injected total instead), hook_injected, total cache-read
    log(
        "### Per-day median series: hook_injected (all 3 sub-buckets summed) and total cache-read-per-turn\n"
    )
    log(
        "(always_loaded is not separable from fixed_preamble -- see finding above -- so its own daily series cannot be produced; fixed_preamble is a constant by construction and has no daily series.)\n"
    )
    by_day = collections.defaultdict(list)
    for r in cli_rows:
        dy = day(r[4])
        if dy:
            by_day[dy].append(r)
    log("| day | n_turns | hook_injected median B | total cache-read median tok |")
    log("|---|---|---|---|")
    for dy in sorted(by_day.keys()):
        rs = by_day[dy]
        hi_vals = [
            r[11].get("hook_injected.hook_success", 0)
            + r[11].get("hook_injected.hook_additional_context", 0)
            + r[11].get("hook_injected.other", 0)
            for r in rs
        ]
        cr_vals = [r[6] for r in rs]
        log(
            f"| {dy} | {len(rs)} | {pctl(hi_vals, 0.5):,.0f} | {pctl(cr_vals, 0.5):,.0f} |"
        )
    log("")

    # weighted cost-equivalent: Opus 5 list ratios fresh input/output/cache write/cache read = 15/75/18.75/1.50 per Mtok
    log(
        "### Weighted cost-equivalent (Opus 5 API list ratios: fresh input $15, output $75, cache write $18.75, cache read $1.50 per Mtok -- ANALYTICAL WEIGHTING, NOT MONEY)\n"
    )

    def cost_equiv(rows_):
        cr_tok = sum(r[6] for r in rows_)
        cc_tok = sum(r[7] for r in rows_)
        out_tok = sum(r[8] for r in rows_)
        cost = cr_tok * 1.50 + cc_tok * 18.75 + out_tok * 75.0
        return cost, cr_tok, cc_tok, out_tok

    pre_cost, pre_cr_t, pre_cc_t, pre_out_t = cost_equiv(pre)
    post_cost, post_cr_t, post_cc_t, post_out_t = cost_equiv(post)
    n_pre_days = len(set(day(r[4]) for r in pre if r[4]))
    n_post_days = len(set(day(r[4]) for r in post if r[4]))
    log(
        f"Pre: {n_pre_days} days, cache_read={pre_cr_t:,} tok, cache_creation={pre_cc_t:,} tok, output={pre_out_t:,} tok -> cost-equiv units/day = {pre_cost / max(1, n_pre_days):,.0f}"
    )
    log(
        f"Post: {n_post_days} days, cache_read={post_cr_t:,} tok, cache_creation={post_cc_t:,} tok, output={post_out_t:,} tok -> cost-equiv units/day = {post_cost / max(1, n_post_days):,.0f}"
    )
    log(
        f"Change in cost-equiv/day: {100 * (post_cost / max(1, n_post_days) - pre_cost / max(1, n_pre_days)) / (pre_cost / max(1, n_pre_days)):+.1f}%"
    )
    log(
        "CAVEAT: pre-window (22 Jul-14 Aug, 24 days) vs post-window (15-22 Aug, 8 days, LAST DAY PARTIAL) -- volume/day comparison, not a controlled before/after on identical workload. Turn-count and session-count also differ between windows; a raw per-turn median (table above) is the more apples-to-apples comparator than the per-day total.\n"
    )

    # ---------------- Cheapest 20% to remove: ranking ----------------
    log(
        "### Cheapest-to-remove ranking (share of re-read total, largest first, correctness cost NOT judged)\n"
    )
    bv = s3["bytes_vals"]
    total_all = sum(pctl(vals, 0.5) for vals in bv.values())
    ranked = sorted(BUCKET_KEYS, key=lambda k: -pctl(bv[k], 0.5))
    log(
        "| rank | bucket | median B/turn | share of total median B/turn | what it is made of |"
    )
    log("|---|---|---|---|---|")
    made_of = {
        "fixed_preamble": "Claude Code base system prompt + tool schemas (+ always_loaded folded in, undetectable separately -- see finding). Not directly editable.",
        "hook_injected.other": "skill_listing, agent_listing_delta, deferred_tools_delta, task_reminder, total_tokens_reminder, mcp_instructions_delta, command_permissions, queued_command -- static per-session listings re-sent whole.",
        "tool_results.Bash": "Bash stdout/stderr, largest single tool_results contributor.",
        "tool_results.Read": "Read tool file contents.",
        "user_prompts": "human/skill-injected prompt text (plain user turns + text blocks).",
        "conversation_history.tool_use": "assistant's own prior tool_use JSON blocks re-read as history.",
        "hook_injected.hook_success": "SessionStart/PreToolUse hook stdout, most of it tracker-doc injection (83% cumulative, see §3).",
        "tool_results.file_attachment": "file/edited_text_file attachments (large file reads/writes surfaced outside tool_result).",
        "hook_injected.hook_additional_context": "UserPromptSubmit hook additionalContext, incl. tracker-doc injection (27% cumulative).",
        "conversation_history.text": "assistant's own prior text blocks re-read as history.",
        "skill_bodies": "Skill tool invocation bodies (wayfinder/roadmap-edit/etc, median ~6-13KB each, see §5).",
        "tool_results.Task": "Agent/Task tool_result (subagent report text returned to parent).",
        "tool_results.Edit": "Edit tool diffs.",
        "always_loaded": "undetectable separately in this corpus -- folded into fixed_preamble, see finding.",
        "hook_injected.hook_success.tracker": "subset of hook_success: tracker-doc injection specifically.",
        "hook_injected.hook_additional_context.tracker": "subset of hook_additional_context: tracker-doc injection specifically.",
        "tool_results.other": "unmatched/misc tool results.",
        "tool_results.Write": "Write tool results.",
        "tool_results.WebFetch": "WebFetch results (near-zero in this corpus).",
        "tool_results.WebSearch": "WebSearch results (near-zero in this corpus).",
        "tool_results.Grep": "Grep results (near-zero, mostly small).",
        "tool_results.Glob": "Glob results (near-zero).",
        "conversation_history.thinking": "assistant thinking blocks re-read (near-zero -- thinking is typically not re-sent).",
        "subagent_dispatch": "not populated by this attribution pass (see bucket 8 note, measured separately in §6).",
    }
    cum = 0
    for i, k in enumerate(ranked, 1):
        v = pctl(bv[k], 0.5)
        share = 100 * v / total_all if total_all else 0
        cum += share
        log(
            f"| {i} | {k} | {v:,.0f} | {share:.1f}% (cum {cum:.1f}%) | {made_of.get(k, '')} |"
        )
    log(
        "\nCandidates whose cumulative share crosses ~20% of the median per-turn re-read total (largest-first, NOT correctness-weighted): the top rows above until cum%~20%. Parent should judge correctness cost per row before acting on any of them.\n"
    )

    log("\n---\n## Run complete: " + datetime.datetime.utcnow().isoformat() + "Z\n")


if __name__ == "__main__":
    main()
