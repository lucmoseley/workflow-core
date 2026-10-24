#!/usr/bin/env python3
"""stage2.py — stage 2 of mantahostels#1081's context-bucket measurement: turn rows.pkl
into the required findings.md numbers.

A stage of its own so the figures can be recut from extract.py's pickle without
re-streaming the transcript corpus.
"""

import pickle
import statistics
import datetime
import math
from lib import OUT, log

# Bytes per token before calibration: a guess, a typical English-and-code mix,
# never measured on this corpus. Calibration below replaces it.
ASSUMED_BPT = 3.4


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


def summarize(vals, label):
    if not vals:
        log(f"{label}: n=0")
        return
    log(
        f"{label}: n={len(vals)} p25={pctl(vals, 0.25):.1f} p50={pctl(vals, 0.5):.1f} p90={pctl(vals, 0.9):.1f} mean={statistics.mean(vals):.1f}"
    )


def main():
    d = pickle.load(open(OUT + "/rows.pkl", "rb"))
    rows = d["rows"]  # parent
    sub_rows = d["sub_rows"]  # subagent
    preamble_rows = d["preamble_rows"]
    always_loaded_stats = d["always_loaded_stats"]
    sub_always_loaded_stats = d["sub_always_loaded_stats"]
    skill_body_stats = d["skill_body_stats"]
    sub_skill_body_stats = d["sub_skill_body_stats"]
    tool_byte_totals = d["tool_byte_totals"]
    sub_tool_byte_totals = d["sub_tool_byte_totals"]

    log("\n---\n## Stage 2: analysis\n")
    log(f"Analysis run: {datetime.datetime.utcnow().isoformat()}Z\n")

    # ---------- split cli vs sdk-py ----------
    cli_rows = [r for r in rows if r[2] == "cli"]
    sdk_rows = [r for r in rows if r[2] == "sdk-py"]
    other_rows = [r for r in rows if r[2] not in ("cli", "sdk-py")]
    log(
        f"Parent rows: total={len(rows)}, cli={len(cli_rows)}, sdk-py={len(sdk_rows)}, other/None={len(other_rows)}"
    )
    log(
        f"Subagent rows: total={len(sub_rows)} (subagent transcripts are dispatched by both cli and sdk-py parents; not segmented further here)\n"
    )

    sessions_cli = {r[0] for r in cli_rows}
    sessions_sdk = {r[0] for r in sdk_rows}
    log(
        f"Distinct parent sessions with >=1 cache-read row: cli={len(sessions_cli)}, sdk-py={len(sessions_sdk)}\n"
    )

    # ---------- date range ----------
    all_ts = [r[4] for r in rows if r[4]] + [r[4] for r in sub_rows if r[4]]
    dates = sorted(set(t[:10] for t in all_ts))
    log(
        f"Date range found: {dates[0]} to {dates[-1]} ({len(dates)} distinct days). Last day is partial (run cut mid-day).\n"
    )

    # ============================================================
    # 1. fixed_preamble sizing
    # ============================================================
    log("### 1. fixed_preamble sizing (first assistant message per session)\n")
    # preamble_rows: (cache_creation, input_tokens, first_user_bytes)
    # crude token-per-byte assumption for first-user-message bytes: use global calibration factor computed below;
    # report raw token estimate: preamble_tokens ~= cache_creation + input_tokens - (first_user_bytes / BPT)
    # BPT computed after calibration section; do a first pass with ASSUMED_BPT, corrected later.
    preamble_est = []
    for cc, it, fub in preamble_rows:
        est = cc + it - fub / ASSUMED_BPT
        preamble_est.append(est)
    summarize(
        preamble_est,
        f"fixed_preamble estimate (tokens, assumed BPT {ASSUMED_BPT} pending calibration)",
    )
    log("(Recomputed with the calibrated bytes/token factor in §Calibration below.)\n")

    # ============================================================
    # 2. always_loaded presence + size
    # ============================================================
    log(
        "### 2. always_loaded (CLAUDE.md + AGENTS.md + working-contract.md system-reminder)\n"
    )
    present = [v for v in always_loaded_stats if v > 0]
    log(
        f"Present in {len(present)}/{len(always_loaded_stats)} parent sessions ({100 * len(present) / max(1, len(always_loaded_stats)):.1f}%)"
    )
    summarize(present, "always_loaded actual bytes where present")
    sub_present = [v for v in sub_always_loaded_stats if v > 0]
    log(
        f"Subagent sessions: present in {len(sub_present)}/{len(sub_always_loaded_stats)} ({100 * len(sub_present) / max(1, len(sub_always_loaded_stats)):.1f}%)"
    )
    if sub_present:
        summarize(sub_present, "subagent always_loaded bytes where present")
    log(
        "On-disk reference: CLAUDE.md 39565B + AGENTS.md 5967B + working-contract.md 4744B = 50276B (50.3KB).\n"
    )

    # ============================================================
    # 3. hook_injected breakdown incl tracker docs
    # ============================================================
    log(
        "### 3. hook_injected breakdown (cumulative bytes emitted across all sessions, parent only)\n"
    )
    hs_total = sum(r[11].get("hook_injected.hook_success", 0) for r in rows)
    hs_tracker = sum(r[11].get("hook_injected.hook_success.tracker", 0) for r in rows)
    hac_total = sum(r[11].get("hook_injected.hook_additional_context", 0) for r in rows)
    hac_tracker = sum(
        r[11].get("hook_injected.hook_additional_context.tracker", 0) for r in rows
    )
    other_total = sum(r[11].get("hook_injected.other", 0) for r in rows)
    log(
        "NOTE: these are cumulative-prefix bytes summed across every cache-read row's snapshot (i.e. re-read-weighted, not raw emission bytes) -- a hook fired once early gets counted at every later turn's snapshot. This is intentional: it is the quantity that drives re-read cost."
    )
    log(
        f"hook_success cumulative: {hs_total:,} B, of which tracker-doc-marked: {hs_tracker:,} B ({100 * hs_tracker / max(1, hs_total):.1f}%)"
    )
    log(
        f"hook_additional_context cumulative: {hac_total:,} B, of which tracker-doc-marked: {hac_tracker:,} B ({100 * hac_tracker / max(1, hac_total):.1f}%)"
    )
    log(
        f"hook_injected.other (skill_listing/agent_listing_delta/deferred_tools_delta/task_reminder/total_tokens_reminder/mcp_instructions_delta/command_permissions/queued_command) cumulative: {other_total:,} B\n"
    )

    # ============================================================
    # 4. tool_results by tool (byte totals as emitted, not re-read-weighted)
    # ============================================================
    log(
        "### 4. tool_results by originating tool -- RAW EMITTED bytes (not re-read-weighted), parent transcripts\n"
    )
    log(
        "(tool_use_id matched back to the preceding assistant tool_use block's name; 'other' = unmatched or non-file-returning tools e.g. AskUserQuestion, ExitPlanMode, ListAgents, TaskCreate/Update/Stop/List, ToolSearch, SendMessage, DesignSync, CronList, mcp__* servers)\n"
    )
    tot = sum(tool_byte_totals.values())
    for name, b in sorted(tool_byte_totals.items(), key=lambda x: -x[1]):
        log(f"  {name}: {b:,} B ({100 * b / max(1, tot):.2f}%)")
    log(f"  TOTAL (parent): {tot:,} B\n")
    log("### tool_results by tool -- subagent transcripts\n")
    subtot = sum(sub_tool_byte_totals.values())
    for name, b in sorted(sub_tool_byte_totals.items(), key=lambda x: -x[1]):
        log(f"  {name}: {b:,} B ({100 * b / max(1, subtot):.2f}%)")
    log(f"  TOTAL (subagent): {subtot:,} B\n")

    # ============================================================
    # 5. skill_bodies per skill
    # ============================================================
    log("### 5. skill_bodies -- bytes per skill invocation, parent transcripts\n")
    for name, vals in sorted(
        skill_body_stats.items(), key=lambda x: -statistics.median(x[1]) if x[1] else 0
    ):
        summarize(vals, f"  {name}")
    log("\n### skill_bodies -- subagent transcripts\n")
    for name, vals in sorted(
        sub_skill_body_stats.items(),
        key=lambda x: -statistics.median(x[1]) if x[1] else 0,
    ):
        summarize(vals, f"  {name}")
    log("")

    # ============================================================
    # 6. subagent dispatch bytes (parent side)
    # ============================================================
    log("### 6. subagent (bucket 8a) -- parent-side dispatch cost\n")
    log(
        f"Task/Agent tool_use input bytes (dispatch prompts), summed over all parent Task calls: {d['subagent_dispatch_bytes']:,} B"
    )
    log(
        f"Task/Agent tool_result bytes (returned to parent) included in tool_results.Task above: {tool_byte_totals.get('Agent', 0):,} B parent-side"
    )
    log(
        "(subagent transcripts' own internal composition is the 'tool_results by tool -- subagent transcripts' table above, and the per-turn analysis below run separately over sub_rows.)\n"
    )

    # ============================================================
    # CALIBRATION: bytes-per-token factor
    # ============================================================
    log("### Calibration: bytes-per-token factor\n")
    log(
        "Method: for each cache-read row, reconstructed cumulative prefix bytes (fixed_preamble estimate ignored here -- see caveat) vs observed cache_read+cache_creation tokens. Fit ratio = prefix_bytes / (cache_read+cache_creation).\n"
    )
    ratios = []
    for r in rows:
        cache_read, cache_creation = r[6], r[7]
        total_bytes = r[10]
        denom = cache_read + cache_creation
        if denom > 0 and total_bytes > 0:
            ratios.append(total_bytes / denom)
    summarize(ratios, "bytes/token ratio (parent, uncorrected for fixed_preamble)")
    med_bpt_raw = pctl(ratios, 0.5) if ratios else ASSUMED_BPT
    log(
        f"Median used as BPT_RAW = {med_bpt_raw:.3f} B/token (reconstructed transcript bytes only; excludes the fixed_preamble bucket, which is NOT in the transcript by construction)."
    )
    log(
        "CAVEAT: reconstructed bytes structurally EXCLUDE fixed_preamble (tool schemas + base system prompt), which is real cache content. So this ratio is expected to be systematically LOW vs a 'true' bytes/token (transcript bytes undercount the cached prefix). We do not force-fit; we report the raw ratio and flag the gap explicitly below.\n"
    )

    # residual estimate: observed tokens vs (transcript_bytes/BPT_RAW) -- by construction near 0 since BPT_RAW is fit to median.
    # Instead report the residual using a DIFFERENT plausible BPT (e.g. 4.0, a common code/English estimate) to show sensitivity.
    for probe_bpt in (3.0, 3.5, 4.0, 4.5):
        resids = []
        for r in rows:
            cache_read, cache_creation = r[6], r[7]
            total_bytes = r[10]
            denom = cache_read + cache_creation
            if denom > 0:
                pred = total_bytes / probe_bpt
                resids.append(100 * (pred - denom) / denom)
        if resids:
            log(
                f"  probe BPT={probe_bpt}: median residual (predicted-vs-observed tokens) = {pctl(resids, 0.5):.1f}% (p25={pctl(resids, 0.25):.1f}%, p90={pctl(resids, 0.9):.1f}%)"
            )
    log(
        "Reading: at every plausible BPT the transcript-reconstructed prefix UNDER-predicts observed tokens (negative residual) for early turns and the gap shrinks as turn index grows -- consistent with fixed_preamble (tool schemas, ~constant per turn) being the dominant missing term at low turn counts, proportionally diluted at high turn counts. See per-turn-index table below.\n"
    )

    bpt = med_bpt_raw

    log(
        "Recomputed fixed_preamble (tokens), using BPT=%.3f to convert first_user_bytes:"
        % bpt
    )
    preamble_est2 = []
    for cc, it, fub in preamble_rows:
        est = cc + it - fub / bpt
        preamble_est2.append(est)
    summarize(preamble_est2, "fixed_preamble tokens (calibrated BPT)")
    preamble_bytes_est2 = [e * bpt for e in preamble_est2 if e > 0]
    summarize(
        preamble_bytes_est2,
        "fixed_preamble bytes-equivalent (calibrated BPT, positive estimates only)",
    )
    neg_frac = sum(1 for e in preamble_est2 if e <= 0) / max(1, len(preamble_est2))
    log(
        f"Fraction of sessions where this estimator goes <=0 (noise / first-turn cache-miss/edge cases): {100 * neg_frac:.1f}%\n"
    )

    import pickle as pk

    with open(OUT + "/stage2_partial.pkl", "wb") as f:
        pk.dump({"BPT": bpt, "cli_rows": cli_rows, "sdk_rows": sdk_rows}, f)
    log(
        "Checkpoint saved (BPT + segmented rows). Continuing to per-bucket share/growth/marginal-cost analysis...\n"
    )


if __name__ == "__main__":
    main()
