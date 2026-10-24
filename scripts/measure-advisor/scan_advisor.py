#!/usr/bin/env python3
"""scan_advisor.py — measure the Opus advisor's real cost across this machine's transcripts.

Built for mantahostels#1185, spun out of mantahostels#1102 (which put the advisor behind every Sonnet
`/implement` launch). mantahostels#1102 priced the advisor as an unmeasured estimate --
"~$0.41 a call at 82k context" -- and flagged two live risks: nothing caps how
often it fires, and it silently stays off wherever feature-flag fetching is
disabled, with nothing reporting that.

An advisor call is NOT `usage.server_tool_use` (that field is the web-tool
request counters, present on every record whether or not an advisor exists,
and unrelated to it) and NOT a session merely carrying `advisorModel` (that
field marks the session's *configured* advisor and is written on every
assistant record of such a session, whether or not the advisor ever actually
fired -- mantahostels#1102's own silent-off risk, live in this corpus: 22 sessions carry
`advisorModel`, only 11 have ever actually fired it, main or subagent
transcript combined). The real signal
is `usage.iterations[].type == "advisor_message"`: one entry per advisor
round, carrying its own input/output/cache token fields and `model`, nested
inside the *parent* request's usage and excluded from that request's own
top-level totals -- so `scan_burn.py` has never counted a cent of advisor
spend.

Reuses `scan_burn.py`'s transcript walk and MAX-per-requestId dedup rule
(mantahostels#1121): a request's advisor iterations are summed within each duplicate
record, then MAXed across duplicates of the same (path, requestId) -- the
same guard against double-counting a subagent's streamed replay.

Every dollar is `scan_burn.usd`: the four token classes at Opus 5 API list
ratios, each cache write at its TTL's rate, never a bill (mantahostels#829) -- and here
specifically the advisor's own consumption, priced at the same ratios
regardless of which model hosts the parent turn.
"""

import argparse
import os
import statistics as st
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "measure-burn"))
import scan_burn as sb  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)

sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import transcript_corpus as tc  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)

# mantahostels#1102 landed the advisor 23 August 2026; the first honest week closes
# ~30 August 2026 (mantahostels#1185). Everything before this date predates the routing.
DEFAULT_SINCE = "2026-08-23"


def requests_with_advisor(tally, window=None):
    """One entry per (relpath, requestId), scan_burn's key: that request's advisor spend, plus
    whether the session carried a configured advisor at all.

    `n` is 0 for a request that fired no advisor call -- kept (not filtered)
    so the caller can compute the configured-but-silent population.

    `tally`, the Counter `report` prints, receives `tc.records`'s skip counts.
    """
    agg = {}
    for rel, path, is_sub, owner in tc.transcript_files():
        for rec in tc.records(path, tally, needle='"assistant"'):
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            use = msg.get("usage") or {}
            if not use:
                continue
            its = use.get("iterations") or []
            advisor_its = [it for it in its if it.get("type") == "advisor_message"]
            rid = rec.get("requestId") or msg.get("id")
            key = (rel, rid)
            cur = agg.get(key)
            if cur is None:
                cur = agg[key] = {
                    **sb.zero(),
                    "n": 0,
                    "ts": rec.get("timestamp") or "",
                    "path": path,
                    "sub": is_sub,
                    "owner": owner,
                    "session": rec.get("sessionId") or owner,
                    "entrypoint": rec.get("entrypoint"),
                    "model": None,
                    "configured": False,
                    "rounds": [],
                }
            if advisor_its:
                # MAXed per round across the request's records, and only
                # then resolved and summed, as scan_burn MAXes before it
                # resolves the TTL split.
                rounds = cur["rounds"]
                for i, it in enumerate(advisor_its):
                    tok = sb.tokens(it)
                    if i == len(rounds):
                        rounds.append(tok)
                    else:
                        for f in sb.TOKEN_FIELDS:
                            rounds[i][f] = max(rounds[i][f], tok[f])
                cur["n"] = max(cur["n"], len(advisor_its))
                cur["model"] = cur["model"] or advisor_its[0].get("model")
            cur["configured"] = cur["configured"] or bool(rec.get("advisorModel"))
            ts = rec.get("timestamp") or ""
            if ts and ts < cur["ts"]:
                cur["ts"] = ts
    for r in agg.values():
        if window and not (window[0] <= r["ts"] < window[1]):
            continue
        for tok in r.pop("rounds"):
            sb.add_request(r, tok)
        yield r


def report(reqs, since, tally):
    reqs = list(reqs)
    # A "firing request" is one whose parent turn carries >=1 advisor round.
    # `n` (>1 seen nowhere yet, but possible) is the round count within it --
    # keep requests and rounds distinct so a request bundling several rounds
    # doesn't silently understate the per-round price.
    firing = [r for r in reqs if r["n"] > 0]
    rounds_total = sum(r["n"] for r in firing)
    tot = sb.zero()
    for r in firing:
        sb.add_request(tot, r)
    cost = sb.usd(tot)

    print(
        f"window: {since} onward ({len(reqs):,} requests scanned)  "
        f"{tc.counts_line(tally)}\n"
    )
    print(
        f"advisor-firing requests: {len(firing):,}  (advisor rounds: {rounds_total:,})"
    )
    if not firing:
        print(
            "No advisor calls in this window -- see the configured-but-silent "
            'count below before reading this as "the advisor is cheap".'
        )
    else:
        print(
            f"  cost-equivalent total: ${cost:,.2f}  "
            f"(Opus 5 API list ratios, mantahostels#829 -- never a bill)"
        )
        per_round = sorted(sb.usd(r) / r["n"] for r in firing)
        print(
            f"  per round: median ${st.median(per_round):.3f}  "
            f"mean ${st.mean(per_round):.3f}  max ${per_round[-1]:.3f}"
        )
        ctx = sorted(r["fi"] + r["cr"] for r in firing)
        print(
            f"  context per request: median {st.median(ctx) / 1000:.0f}k  "
            f"mean {st.mean(ctx) / 1000:.0f}k  max {ctx[-1] / 1000:.0f}k"
        )
        cached = sum(1 for r in firing if r["cr"] > 0)
        print(
            f"  requests with any cache read: {cached}/{len(firing)} "
            f"({cached / len(firing) * 100:.0f}%) -- mantahostels#1102 claimed 0%"
        )
        models = defaultdict(int)
        for r in firing:
            models[r["model"] or "?"] += 1
        print("  by model: " + ", ".join(f"{m} x{n}" for m, n in models.items()))

    print()
    sessions = defaultdict(lambda: {"configured": False, "rounds": 0})
    for r in reqs:
        s = sessions[r["owner"]]
        s["configured"] = s["configured"] or r["configured"]
        s["rounds"] += r["n"]
    configured = [k for k, v in sessions.items() if v["configured"]]
    fired = [k for k in configured if sessions[k]["rounds"] > 0]
    silent = [k for k in configured if sessions[k]["rounds"] == 0]
    print(f"sessions with advisor configured: {len(configured):,}")
    print(f"  fired >=1 round: {len(fired):,}")
    print(
        f"  configured but zero rounds (ambiguous -- cheap or never ran, "
        f"mantahostels#1102's silent-off risk): {len(silent):,}"
    )
    if fired:
        per_sess = sorted(sessions[k]["rounds"] for k in fired)
        print(
            f"  rounds per firing session: median {st.median(per_sess):.0f}  "
            f"mean {st.mean(per_sess):.1f}  max {per_sess[-1]}"
        )


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--since",
        default=DEFAULT_SINCE,
        help=f"ISO date/time, inclusive (default: {DEFAULT_SINCE}, "
        "when mantahostels#1102 landed)",
    )
    ap.add_argument("--all", action="store_true", help="whole corpus, no window")
    args = ap.parse_args()
    window = None if args.all else (args.since, "9999")
    tally = Counter()
    report(
        requests_with_advisor(tally, window),
        "whole corpus" if args.all else args.since,
        tally,
    )


if __name__ == "__main__":
    raise SystemExit(main())
