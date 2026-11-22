#!/usr/bin/env python3

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

DEFAULT_SINCE = "2026-08-23"


def requests_with_advisor(tally, window=None):
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
        description="Measure the Opus advisor's real cost across this machine's transcripts."
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
