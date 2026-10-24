#!/usr/bin/env python3
"""scan_lag.py — how long after close does rework actually land?

Built for mantahostels#1215 to derive the horizon of mantahostels#1108's rework
measurement; its reading is the 1 September addendum to
https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/effort-low-arm-measurement.md.

`scan_rework.py` counts rework inside a `--horizon` window whose default, 21
days, is a guess: it appears once, as an argparse default, and no ticket or
note derives it. This scans the lag distribution that should set it.

The corpus is short — the first `takes:implement` close is 13 August 2026 — so
every ticket's observation window is open-ended and unequal, and a raw
histogram of observed lags would understate long ones badly. So the estimate
is **Kaplan-Meier**: at each day `d` the risk set is the tickets that were
still rework-free and had at least `d` days of exposure, and a ticket drops out
of the denominator on the day its own exposure runs out rather than counting as
a clean pass forever.

What it cannot fix: nothing observable here reaches past the corpus age, so any
statement about rework landing after ~19 days is extrapolation, and the script
refuses to make one.

Signals are `scan_rework.signals`' two, unchanged, read with an effectively
infinite horizon so nothing is truncated before the lag is taken.
"""

import argparse
import datetime as dt
import sys
from concurrent.futures import ThreadPoolExecutor

import scan_rework as sr

DAY = sr.DAY
# Days. Any horizon past the corpus age truncates nothing; 10,000 is an arbitrary
# figure far beyond it, not a derived one.
UNBOUNDED = 10_000


def lag_days(issue):
    """`(first_rework_lag_or_None, exposure_days)` for one closed issue."""
    s = sr.signals(issue, UNBOUNDED)
    if s is None:
        return None
    closed = s["closed"]
    now = dt.datetime.now(dt.timezone.utc)
    exposure = (now - closed) / DAY

    stamps = []
    for e in issue["timeline"]:
        if e.get("event") == "reopened":
            t = sr.parse_ts(e.get("createdAt"))
            if t and t > closed:
                stamps.append(t)
        elif e.get("event") == "cross-referenced":
            src = e.get("source") or {}
            if src.get("isPullRequest"):
                continue
            t = sr.parse_ts(src.get("createdAt"))
            if t and t > closed:
                stamps.append(t)

    first = (min(stamps) - closed) / DAY if stamps else None
    return {"number": s["number"], "lag": first, "exposure": exposure}


def kaplan_meier(rows, max_day):
    """Cumulative incidence of rework by day, censoring on exposure."""
    surv, out = 1.0, []
    for d in range(1, max_day + 1):
        at_risk = [
            r
            for r in rows
            if r["exposure"] >= d and (r["lag"] is None or r["lag"] > d - 1)
        ]
        events = [r for r in at_risk if r["lag"] is not None and r["lag"] <= d]
        n = len(at_risk)
        if n == 0:
            break
        surv *= 1 - len(events) / n
        out.append({"day": d, "at_risk": n, "events": len(events), "cum": 1 - surv})
    return out


def fetch_parallel(numbers, repo, workers):
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return [i for i in pool.map(lambda n: sr.fetch([n], repo)[0], numbers)]


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--repo", help="owner/name (default: the config's tracker)")
    ap.add_argument("--label", default="takes:implement")
    ap.add_argument("--since", default="2026-08-01")
    ap.add_argument(
        "--sample",
        type=int,
        # A guess at a sample big enough to read a tail from; 250 is what the
        # mantahostels#1215 reading fetched.
        default=250,
        help="how many closed issues to fetch (0 for all)",
    )
    # One fetch per core (8, docs/environment.md); a guess, gh's rate limit unmeasured.
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    a.repo = a.repo or sr.config_tracker()

    nums = sr.numbers_for_label(a.label, a.repo, a.since)
    nums = sr.sample(nums, a.sample)
    print(
        f"Fetching {len(nums)} closed `{a.label}` issues on {a.workers} workers...",
        file=sys.stderr,
    )
    issues = fetch_parallel(nums, a.repo, a.workers)

    rows = [r for r in (lag_days(i) for i in issues) if r]
    if not rows:
        sys.exit("No closed issues fetched.")

    reworked = [r for r in rows if r["lag"] is not None]
    max_exposure = max(r["exposure"] for r in rows)
    print(f"\nn = {len(rows)} closed issues; {len(reworked)} show rework at any lag.")
    print(
        f"Corpus depth: longest exposure since close is "
        f"{max_exposure:.1f} days — nothing beyond that is observable."
    )

    if reworked:
        lags = sorted(r["lag"] for r in reworked)

        def pct(p):
            return lags[min(len(lags) - 1, int(p * len(lags)))]

        print("\nObserved first-rework lag, in days (raw, censoring-blind):")
        print(
            f"  median {pct(0.5):.2f}   p75 {pct(0.75):.2f}   "
            f"p90 {pct(0.90):.2f}   max {lags[-1]:.2f}"
        )

    km = kaplan_meier(rows, int(max_exposure))
    print("\nKaplan-Meier cumulative rework incidence by day since close:")
    print("  day  at-risk  events  cumulative")
    for r in km:
        print(f"  {r['day']:>3}  {r['at_risk']:>7}  {r['events']:>6}  {r['cum']:>9.1%}")

    if km:
        plateau = km[-1]["cum"]
        if plateau > 0:
            for share in (0.80, 0.90, 0.95):
                hit = next((r["day"] for r in km if r["cum"] >= share * plateau), None)
                if hit:
                    print(f"  {share:.0%} of observed rework has landed by day {hit}.")
        print(
            f"\nAll of this is right-censored at {int(max_exposure)} days. "
            f"A horizon longer than that\ncannot be validated from this "
            f"corpus at all, only assumed."
        )


if __name__ == "__main__":
    main()
