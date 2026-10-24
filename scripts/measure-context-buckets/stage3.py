#!/usr/bin/env python3
"""stage3.py — stage 3 of mantahostels#1081's context-bucket measurement: per-bucket
share/growth, marginal cost, before/after concision, ranking.

A stage of its own so the figures can be recut from the earlier stages' pickles
without re-streaming the transcript corpus.
"""

import pickle
import statistics
import collections
import math
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
    d = pickle.load(open(OUT + "/rows.pkl", "rb"))
    s2 = pickle.load(open(OUT + "/stage2_partial.pkl", "rb"))
    bpt = s2["BPT"]
    cli_rows = s2["cli_rows"]

    log(
        "\n---\n## Stage 3: per-bucket share / growth / marginal cost (CLI sessions only, headline)\n"
    )
    log(
        f"BPT (bytes/token, median fit) = {bpt:.3f}. All token conversions below use this factor.\n"
    )

    # per-row: attribute cache_read pro rata to bucket byte share (fixed_preamble as constant addend)
    # fixed_preamble constant estimate in bytes:
    # Recompute directly: use stage2 preamble estimate distribution median in BYTES
    preamble_rows = d["preamble_rows"]
    p_bytes = []
    for cc, it, fub in preamble_rows:
        est_tok = cc + it - fub / bpt
        if est_tok > 0:
            p_bytes.append(est_tok * bpt)
    preamble_bytes_med = pctl(p_bytes, 0.5) if p_bytes else 33584
    log(
        f"fixed_preamble constant used in attribution: {preamble_bytes_med:,.0f} bytes-equivalent per turn (median of per-session estimate).\n"
    )

    # Build per-row bucket byte breakdown INCLUDING fixed_preamble and always_loaded (already in snap under 'always_loaded' key if detected)
    n_rows = len(cli_rows)
    log(f"CLI parent cache-read rows analysed: {n_rows}\n")

    # -------- share + bytes-per-turn per bucket --------
    share_vals = collections.defaultdict(list)
    bytes_vals = collections.defaultdict(list)
    turn_idx_vals = []
    for r in cli_rows:
        (
            sid,
            is_sub,
            entry,
            model,
            ts,
            turn_idx,
            cache_read,
            cache_creation,
            out_tok,
            skill,
            total_bytes,
            snap,
        ) = r
        full_total = total_bytes + preamble_bytes_med
        if full_total <= 0:
            continue
        turn_idx_vals.append(turn_idx)
        for k in BUCKET_KEYS:
            b = snap.get(k, 0)
            if k == "fixed_preamble":
                b = preamble_bytes_med
            share_vals[k].append(100 * b / full_total)
            bytes_vals[k].append(b)

    log("### Bucket share of cache-read total & bytes-per-turn (CLI sessions)\n")
    log(
        "| bucket | share p25 | share p50 | share p90 | bytes p25 | bytes p50 | bytes p90 |"
    )
    log("|---|---|---|---|---|---|---|")
    for k in BUCKET_KEYS:
        sv = share_vals[k]
        bv = bytes_vals[k]
        if not sv:
            continue
        log(
            f"| {k} | {pctl(sv, 0.25):.2f}% | {pctl(sv, 0.5):.2f}% | {pctl(sv, 0.9):.2f}% | {pctl(bv, 0.25):,.0f} | {pctl(bv, 0.5):,.0f} | {pctl(bv, 0.9):,.0f} |"
        )
    log("")

    # -------- growth with turn index: decile analysis --------
    log("### Growth with turn index (deciles of turn_idx across CLI rows)\n")
    if turn_idx_vals:
        deciles = [pctl(turn_idx_vals, p / 10) for p in range(11)]
    log(f"turn_idx deciles: {[round(x, 1) for x in deciles]}\n")

    def decile_of(t):
        for i in range(10):
            if t <= deciles[i + 1]:
                return i
        return 9

    decile_bytes = {k: [[] for _ in range(10)] for k in BUCKET_KEYS}
    for r in cli_rows:
        (
            sid,
            is_sub,
            entry,
            model,
            ts,
            turn_idx,
            cache_read,
            cache_creation,
            out_tok,
            skill,
            total_bytes,
            snap,
        ) = r
        di = decile_of(turn_idx)
        for k in BUCKET_KEYS:
            b = snap.get(k, 0)
            if k == "fixed_preamble":
                b = preamble_bytes_med
            decile_bytes[k][di].append(b)

    log("| bucket | dec0 med | dec2 med | dec5 med | dec9 med | slope (dec9-dec0)/9 |")
    log("|---|---|---|---|---|---|")
    growing = []
    for k in BUCKET_KEYS:
        meds = [
            pctl(decile_bytes[k][i], 0.5) if decile_bytes[k][i] else 0
            for i in range(10)
        ]
        slope = (meds[9] - meds[0]) / 9
        log(
            f"| {k} | {meds[0]:,.0f} | {meds[2]:,.0f} | {meds[5]:,.0f} | {meds[9]:,.0f} | {slope:,.0f} B/turn-decile-step |"
        )
        if slope > 50:
            growing.append((k, slope))
    log("")
    log(
        "Constant-per-turn buckets (near-zero slope): fixed_preamble, always_loaded -- injected once, held flat by construction (constant addend / one-time system-reminder, not re-emitted)."
    )
    log(
        f"Compounding (growing) buckets by slope: {sorted(growing, key=lambda x: -x[1])}\n"
    )

    # -------- marginal cost multiplier --------
    log(
        "### Marginal cost of 1 KB placed in each bucket (headline multiplier = expected future turn-re-reads)\n"
    )
    # turns-per-session distribution (CLI)
    sess_max_turn = collections.defaultdict(int)
    sess_all_turns = collections.defaultdict(list)
    for r in cli_rows:
        sid, turn_idx = r[0], r[5]
        sess_max_turn[sid] = max(sess_max_turn[sid], turn_idx)
        sess_all_turns[sid].append(turn_idx)
    turns_per_session = list(sess_max_turn.values())
    mean_turns = statistics.mean(turns_per_session) if turns_per_session else 0
    n_sessions = len(turns_per_session)
    log(
        f"CLI sessions with >=1 cache-read row: {n_sessions}. Mean max-turn-index per session: {mean_turns:.1f} (this is the multiplier for a byte present from turn 0: always_loaded / fixed_preamble).\n"
    )

    # For a bucket inserted at turn t (hook_injected, tool_results, skill_bodies, subagent),
    # expected remaining turns = mean(max_turn(session) - t) over insertion events, i.e. weight by where in the
    # session index growth of that bucket occurred (approximate insertion turn = turn_idx of the row where bucket byte count first increased vs prior row for that session).
    per_bucket_insertions = collections.defaultdict(
        list
    )  # k -> list of (remaining turns)
    prev_snap_by_sid = {}
    for r in sorted(cli_rows, key=lambda x: (x[0], x[5])):
        sid, turn_idx, snap = r[0], r[5], r[11]
        prev = prev_snap_by_sid.get(sid, {})
        maxt = sess_max_turn[sid]
        for k in BUCKET_KEYS:
            if k in ("fixed_preamble",):
                continue
            cur = snap.get(k, 0)
            pv = prev.get(k, 0)
            if cur > pv:
                remaining = maxt - turn_idx
                per_bucket_insertions[k].append(remaining)
        prev_snap_by_sid[sid] = snap

    log("| bucket | median remaining-turns at insertion | headline multiplier |")
    log("|---|---|---|")
    for k in BUCKET_KEYS:
        if k == "fixed_preamble":
            log(
                f"| {k} | n/a (present turn 0) | {mean_turns:.1f} (mean turns/session) |"
            )
            continue
        if k == "always_loaded":
            log(
                f"| {k} | n/a (present turn 0/1) | {mean_turns:.1f} (mean turns/session) |"
            )
            continue
        vals = per_bucket_insertions[k]
        if not vals:
            log(f"| {k} | no insertion events detected | n/a |")
            continue
        med = pctl(vals, 0.5)
        log(f"| {k} | {med:.1f} | {med:.1f} |")
    log("")

    import pickle as pk

    with open(OUT + "/stage3_partial.pkl", "wb") as f:
        pk.dump(
            {
                "preamble_bytes_med": preamble_bytes_med,
                "mean_turns": mean_turns,
                "per_bucket_insertions": {
                    k: v for k, v in per_bucket_insertions.items()
                },
                "bytes_vals": {k: v for k, v in bytes_vals.items()},
                "share_vals": {k: v for k, v in share_vals.items()},
            },
            f,
        )
    log(
        "Checkpoint saved. Continuing to before/after concision comparison + ranking...\n"
    )


if __name__ == "__main__":
    main()
