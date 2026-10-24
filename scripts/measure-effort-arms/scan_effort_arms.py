#!/usr/bin/env python3
"""scan_effort_arms.py — split this machine's transcripts into `--effort` arms and compare them.

Built for mantahostels#1108, which asked for the one term mantahostels#1084 (should checkable work run
at Opus `low` and re-run at `high` only on failure?) was missing: what `low`
actually costs and fails at on live work. Nothing in the corpus could answer it
retrospectively — there was not one `low` turn in it — so the arm is generated
by launching sessions with `claude --effort low` and read back here.

**The whole question is turns and tool calls, not thinking tokens.**
https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/effort-thinking-token-share.md already priced the thinking
term: halving thinking saves at most ~6.5% of spend, and break-even for
low-then-re-run is `1 - L/H`, so at a 6.5% saving the strategy drowns above a
~7% failure rate — below the 16% Anthropic's own `low` arm reported. The escape
is that effort is not only a thinking dial: Anthropic's *Effort* doc says it
"affects all tokens in the response", tool calls included, and spend here is
`turns x standing context`. So this report leads on turns and tool calls.

Extraction is `scripts/measure-burn/scan_burn.py`'s — one billable unit per
`requestId`, every token field the MAX across that request's records (mantahostels#1121).
The `effort`, thinking-token and `tool_use` fields are MAXed there beside them.

Every dollar is the four token classes weighted at Opus 5 API list ratios,
never a bill (mantahostels#829).

Four things this report cannot see, all of which belong in any verdict written
off it:

  * **First-time-pass rate.** Whether a session's own check passed first time
    is not in the transcript in any form a script can trust. Read it off the
    sessions themselves and state it beside these numbers.
  * **Reasoning quality.** Thinking text is not stored -- every `thinking`
    block keeps only its signature -- so `low` reasoning cannot be compared
    with `medium` reasoning directly, only through the check outcome.
  * **Task difficulty.** Arms are matched by filtering (`--skill`, `--model`),
    never by pairing. A `low` arm of a handful of sessions against a `medium`
    baseline of hundreds is matched on work class and on nothing else.
  * **Parallelism.** Sessions here run alongside ~8 neighbours and the
    per-session spread is wide, so a small arm's median carries a wide band.
"""

import argparse
import datetime as dt
import json
import os
import statistics as st
import sys
from collections import Counter, defaultdict

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "measure-burn")
)
import scan_burn as sb

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
)
import transcript_corpus as tc

# Ordered so the report reads low -> high whatever the corpus holds.
ARM_ORDER = ["low", "medium", "high", "xhigh"]


def arm_rank(arm):
    return (ARM_ORDER.index(arm), "") if arm in ARM_ORDER else (len(ARM_ORDER), arm)


def sessions(tally, window=None, *, skill=None, model=None, min_turns=1):
    """Per parent `cli` session, one record carrying its arm and its metrics.

    `cli` only: the `sdk-py` hook population is over half the session count for
    ~4% of spend, and mixing it in makes every per-session statistic an
    artefact of hook traffic (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/allowance-burn-measurement.md).

    A session's **arm** is the effort every one of its parent turns that
    *carries* one ran at. Turns with no `effort` field are counted and
    reported, never allowed to decide an arm: a handful of unlabelled records
    is routine and would otherwise send a plainly-medium session to `mixed`.

    Where two real efforts disagree the session is reported as `mixed` and
    excluded from the arm tables: effort is fixed at launch, so a mixed session
    means either a `/effort` mid-session (which rewrites the global setting and
    so may have moved a neighbour too) or a resume across a settings change.
    Neither is a clean observation of an arm.

    Subagent spend is folded into its parent under `cost_all`, because a
    session that delegates rather than working in-context has moved spend, not
    saved it. Turns, tool calls and thinking are **parent turns only** -- a
    subagent's own effort is not the parent's to claim.

    `tally` is handed to `scan_burn.requests`, which counts its skips into it.
    """
    reqs = list(sb.requests(tally, window))
    entry = {
        r["owner"]: r["entrypoint"] for r in reqs if not r["sub"] and r["entrypoint"]
    }
    agg = defaultdict(
        lambda: {
            "cost_own": 0.0,
            "cost_all": 0.0,
            "turns": 0,
            "tools": 0,
            "think": 0,
            "out": 0,
            "ctx": [],
            "efforts": Counter(),
            "skills": Counter(),
            "models": Counter(),
            "t0": None,
            "t1": None,
            "subagents": set(),
        }
    )
    for r in reqs:
        s = agg[r["owner"]]
        s["cost_all"] += sb.usd(r)
        if r["sub"]:
            s["subagents"].add(r["path"])
            continue
        s["cost_own"] += sb.usd(r)
        s["turns"] += 1
        s["tools"] += r["tools"]
        s["think"] += r["think"]
        s["out"] += r["out"]
        s["ctx"].append(r["cr"])
        s["efforts"][r["effort"] or "(none)"] += 1
        if r["skill"]:
            s["skills"][r["skill"]] += 1
        if r["model"]:
            s["models"][r["model"]] += 1
        if s["t0"] is None or r["ts"] < s["t0"]:
            s["t0"] = r["ts"]
        if s["t1"] is None or r["ts"] > s["t1"]:
            s["t1"] = r["ts"]

    out = []
    for owner, s in agg.items():
        if entry.get(owner) != "cli" or s["turns"] < min_turns:
            continue
        real = {k: v for k, v in s["efforts"].items() if k != "(none)"}
        arm = next(iter(real)) if len(real) == 1 else ("mixed" if real else "(none)")
        top_skill = s["skills"].most_common(1)[0][0] if s["skills"] else None
        top_model = s["models"].most_common(1)[0][0] if s["models"] else None
        if skill and top_skill != skill:
            continue
        # Substring, so `opus` matches whatever dated id the alias resolved to.
        if model and (top_model is None or model not in top_model):
            continue
        out.append(
            {
                "id": owner,
                "arm": arm,
                "unlabelled": s["efforts"].get("(none)", 0),
                "efforts": dict(s["efforts"]),
                "skill": top_skill,
                "model": top_model,
                "cost_own": s["cost_own"],
                "cost_all": s["cost_all"],
                "turns": s["turns"],
                "tools": s["tools"],
                "think": s["think"],
                "out": s["out"],
                "subagents": len(s["subagents"]),
                "ctx_median": st.median(s["ctx"]) if s["ctx"] else 0,
                # Per-turn figures, computed per session and only then aggregated,
                # so the arm statistic is a median of ratios rather than a ratio of
                # medians. These are the size-invariant metrics: a session's turn
                # count tracks how big its ticket was, so a low arm drawn from
                # smaller tickets reads cheaper per session whatever effort did.
                # What effort can move is the cost of a turn.
                "cost_per_turn": s["cost_all"] / s["turns"] if s["turns"] else None,
                "think_per_turn": s["think"] / s["turns"] if s["turns"] else None,
                "minutes": _minutes(s["t0"], s["t1"]),
                "t0": s["t0"],
            }
        )
    out.sort(key=lambda r: (arm_rank(r["arm"]), r["t0"] or ""))
    return out


def _minutes(t0, t1):
    try:
        a = dt.datetime.fromisoformat(t0.replace("Z", "+00:00"))
        b = dt.datetime.fromisoformat(t1.replace("Z", "+00:00"))
        return (b - a).total_seconds() / 60
    except (AttributeError, TypeError, ValueError):
        # `band` drops the None; `report` prints how many (#1274).
        return None


def band(vals):
    """median, mean, p90 -- or None where the sample is empty."""
    v = sorted(x for x in vals if x is not None)
    if not v:
        return None
    return {
        "n": len(v),
        "median": st.median(v),
        "mean": st.mean(v),
        "p90": v[min(len(v) - 1, int(len(v) * 0.9))],
    }


def report(rows, ratio_to="medium"):
    arms = defaultdict(list)
    for r in rows:
        arms[r["arm"]].append(r)
    if not arms:
        print("No session matched. Widen --window, or drop --skill/--model.")
        return

    print(
        "Every dollar is a cost-equivalent at Opus 5 list ratios, not a bill "
        "(mantahostels#829).\n"
    )
    print("== Sessions per arm ==")
    for arm in sorted(arms, key=arm_rank):
        n = len(arms[arm])
        note = ""
        if arm == "mixed":
            note = "  <- effort changed mid-session; excluded from the tables below"
        print(f"  {arm:<8} {n:>5} session(s){note}")
    if "mixed" in arms:
        for r in arms["mixed"][:5]:
            print(f"      {r['id'][:8]}  {r['efforts']}")
    print()

    metrics = [
        ("turns", "Turns", "{:.1f}"),
        ("tools", "Tool calls", "{:.1f}"),
        ("cost_own", "Cost $ (parent)", "{:.2f}"),
        ("cost_all", "Cost $ (+subagents)", "{:.2f}"),
        ("think", "Thinking tokens", "{:.0f}"),
        ("out", "Output tokens", "{:.0f}"),
        ("ctx_median", "Ctx re-read/turn", "{:.0f}"),
        ("cost_per_turn", "Cost $ per turn", "{:.4f}"),
        ("think_per_turn", "Thinking per turn", "{:.0f}"),
        ("minutes", "Duration (min)", "{:.1f}"),
        ("subagents", "Subagents", "{:.1f}"),
    ]
    live = [a for a in sorted(arms, key=arm_rank) if a != "mixed"]
    for key, label, fmt in metrics:
        print(f"== {label} ==")
        if key == "minutes":
            print(f"  (undated sessions: {sum(r['minutes'] is None for r in rows)})")
        base = band([r[key] for r in arms.get(ratio_to, [])])
        for arm in live:
            b = band([r[key] for r in arms[arm]])
            if not b:
                continue
            line = (
                f"  {arm:<8} n={b['n']:<4} median {fmt.format(b['median']):>10}"
                f"  mean {fmt.format(b['mean']):>10}  p90 {fmt.format(b['p90']):>10}"
            )
            # The ratio is what the verdict turns on: `low` buys nothing unless
            # turns and tool calls fall, and break-even for low-then-re-run is
            # 1 - L/H on the cost ratio.
            if base and arm != ratio_to and base["median"]:
                line += f"   x{b['median'] / base['median']:.2f} vs {ratio_to}"
            print(line)
        print()

    print("== Thinking share of output tokens ==")
    for arm in live:
        o = sum(r["out"] for r in arms[arm])
        t = sum(r["think"] for r in arms[arm])
        if o:
            print(f"  {arm:<8} {t / o * 100:5.1f}%   ({t:,} of {o:,})")
    print()

    lows = arms.get("low", [])
    if lows:
        print("== Every `low` session, individually ==")
        print(
            "  A handful of sessions has no median worth the name. These are "
            "the observations; read them, do not summarise them."
        )
        print(
            f"  {'session':<10}{'turns':>7}{'tools':>7}{'$parent':>10}"
            f"{'$all':>9}{'think':>9}{'min':>8}  started"
        )
        for r in lows:
            m = f"{r['minutes']:.0f}" if r["minutes"] is not None else "?"
            print(
                f"  {r['id'][:8]:<10}{r['turns']:>7}{r['tools']:>7}"
                f"{r['cost_own']:>10.2f}{r['cost_all']:>9.2f}{r['think']:>9,}"
                f"{m:>8}  {(r['t0'] or '')[:16]}"
            )
        print()

    base = band([r["cost_all"] for r in arms.get(ratio_to, [])])
    lb = band([r["cost_all"] for r in lows])
    if base and lb and base["median"]:
        ratio = lb["median"] / base["median"]
        print("== Break-even for low-then-re-run-at-high ==")
        print(f"  L/H on median cost (+subagents) = {ratio:.3f}")
        if ratio >= 1:
            print(
                "  `low` is not cheaper here, so there is no failure rate at "
                "which re-running pays. Break-even does not exist."
            )
        else:
            print(f"  Break-even failure rate = 1 - L/H = {(1 - ratio) * 100:.1f}%")
            print(
                "  Above that share of `low` runs needing a `high` re-run, "
                "the strategy costs more than running `high` throughout."
            )
            print(
                "  Compare against the observed first-time-pass rate, which "
                "this script cannot see, and against the 16% Anthropic "
                "reported on a 482-problem SWE-bench Pro subset."
            )
        print(
            f"  n={lb['n']} low vs n={base['n']} {ratio_to}. At a single-digit "
            "`low` n the ratio is an observation, not an estimate."
        )


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--window",
        nargs=2,
        metavar=("FROM", "TO"),
        help="ISO bounds on a request's earliest record, e.g. "
        "2026-08-23 2026-08-25. Default: whole corpus.",
    )
    ap.add_argument(
        "--skill",
        help="keep sessions whose modal attributionSkill is this, e.g. implement",
    )
    ap.add_argument("--model", help="substring of the modal model id, e.g. opus")
    ap.add_argument(
        "--min-turns",
        type=int,
        # A guess, never measured: a floor low enough to keep any session that
        # did work.
        default=5,
        help="drop sessions below this many parent turns (default 5) "
        "-- a session that died at launch is not an arm "
        "observation",
    )
    ap.add_argument("--baseline", default="medium", help="arm the ratios divide by")
    ap.add_argument(
        "--json",
        action="store_true",
        help="per-session rows and the skip counts, no report",
    )
    args = ap.parse_args(argv)

    tally = Counter()
    rows = sessions(
        tally,
        tuple(args.window) if args.window else None,
        skill=args.skill,
        model=args.model,
        min_turns=args.min_turns,
    )
    if args.json:
        skipped = tc.skips(tally, tc.UNREADABLE, tc.UNPARSED, sb.UNKEYED)
        print(json.dumps({"sessions": rows, "skipped": skipped}, indent=1))
        return 0
    scope = " to ".join(args.window) if args.window else "whole corpus"
    filt = (
        ", ".join(
            f"{k}={v}" for k, v in (("skill", args.skill), ("model", args.model)) if v
        )
        or "none"
    )
    print(f"window: {scope}   filters: {filt}   min turns: {args.min_turns}")
    print(tc.counts_line(tally))
    if warning := sb.unkeyed_warning(tally):
        print(warning)
    print()
    report(rows, ratio_to=args.baseline)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
