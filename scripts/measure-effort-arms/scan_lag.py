#!/usr/bin/env python3
import argparse
import datetime as dt
import sys
from concurrent.futures import ThreadPoolExecutor

import scan_rework as sr

DAY = sr.DAY
UNBOUNDED = 10_000


def lag_days(issue):
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", help="owner/name (default: the config's tracker)")
    ap.add_argument("--label", default="takes:implement")
    ap.add_argument("--since", default="2026-08-01")
    ap.add_argument(
        "--sample",
        type=int,
        # guess, lucmoseley/mantahostels#1215
        default=250,
        help="how many closed issues to fetch (0 for all)",
    )
    # guess, lucmoseley/mantahostels#1215
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
