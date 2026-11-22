#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import random
import subprocess
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
)
from wfc_bin import bin_path

LOW_LABEL = "measured:effort-low"
DAY = dt.timedelta(days=1)


def parse_ts(s):
    if not s:
        return None
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def signals(issue, horizon_days, min_lag_days=0.0):
    closed = parse_ts(issue.get("closedAt"))
    if closed is None:
        return None
    deadline = closed + horizon_days * DAY
    floor = closed + min_lag_days * DAY

    reopened = [
        e
        for e in issue["timeline"]
        if e.get("event") == "reopened"
        and floor < parse_ts(e.get("createdAt")) <= deadline
    ]
    followups = []
    for e in issue["timeline"]:
        if e.get("event") != "cross-referenced":
            continue
        src = e.get("source") or {}
        if src.get("isPullRequest"):
            continue
        born = parse_ts(src.get("createdAt"))
        if born is None or not (floor < born <= deadline):
            continue
        if src.get("number") not in followups:
            followups.append(src.get("number"))

    return {
        "number": issue["number"],
        "closed": closed,
        "reopened": len(reopened),
        "followups": followups,
        "rework": bool(reopened or followups),
    }


def cohort(issues, horizon_days, now, min_lag_days=0.0):
    mature, immature = [], []
    for issue in issues:
        s = signals(issue, horizon_days, min_lag_days)
        if s is None:
            continue
        (mature if s["closed"] + horizon_days * DAY <= now else immature).append(s)
    return mature, immature


def rate(mature):
    n = len(mature)
    if n == 0:
        return None
    k = sum(1 for s in mature if s["rework"])
    lo, hi = clopper_pearson(k, n)
    return {"n": n, "k": k, "rate": k / n, "lo": lo, "hi": hi}


def clopper_pearson(k, n, alpha=0.05):

    def tail_ge(p, k, n):
        return sum(binom_pmf(i, n, p) for i in range(k, n + 1))

    def tail_le(p, k, n):
        return sum(binom_pmf(i, n, p) for i in range(0, k + 1))

    lo = 0.0 if k == 0 else bisect(lambda p: tail_ge(p, k, n) - alpha / 2)
    hi = 1.0 if k == n else bisect(lambda p: alpha / 2 - tail_le(p, k, n))
    return lo, hi


def binom_pmf(i, n, p):
    from math import comb

    return comb(n, i) * (p**i) * ((1 - p) ** (n - i))


def bisect(f, lo=0.0, hi=1.0, iters=80):
    for _ in range(iters):
        mid = (lo + hi) / 2
        if f(mid) < 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def gh(args):
    out = subprocess.run([bin_path("gh")] + args, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"gh {' '.join(args)} failed: {out.stderr.strip()}")
    return json.loads(out.stdout or "[]")


def fetch(numbers, repo):
    issues = []
    for n in numbers:
        meta = gh(["api", f"repos/{repo}/issues/{n}"])
        tl = gh(
            [
                "api",
                "--paginate",
                f"repos/{repo}/issues/{n}/timeline",
                "-H",
                "Accept: application/vnd.github+json",
            ]
        )
        events = []
        for e in tl:
            src = e.get("source", {}).get("issue") or {}
            events.append(
                {
                    "event": e.get("event"),
                    "createdAt": e.get("created_at"),
                    "source": {
                        "number": src.get("number"),
                        "createdAt": src.get("created_at"),
                        "isPullRequest": "pull_request" in src,
                    },
                }
            )
        issues.append(
            {
                "number": n,
                "closedAt": meta.get("closed_at"),
                "timeline": events,
            }
        )
    return issues


def numbers_for_label(label, repo, since):
    q = gh(
        [
            "issue",
            "list",
            "--repo",
            repo,
            "--label",
            label,
            "--state",
            "all",
            "--limit",
            "1000",
            "--search",
            f"closed:>={since}",
            "--json",
            "number",
        ]
    )
    return [i["number"] for i in q]


def sample(numbers, size, seed=1108):
    if size <= 0 or len(numbers) <= size:
        return sorted(numbers)
    return sorted(random.Random(seed).sample(sorted(numbers), size))


def render(name, mature, immature, *, horizon, now):
    print(f"\n{name}: {len(mature)} mature, {len(immature)} still ripening")
    r = rate(mature)
    if r is None:
        if immature:
            first = min(s["closed"] for s in immature) + horizon * DAY
            print(
                f"  No reading yet. Earliest: {first:%Y-%m-%d} "
                f"({(first - now).days} days away)."
            )
        else:
            print("  No closed issues in this cohort at all.")
        return None
    print(
        f"  Rework in {horizon}d of close: {r['k']}/{r['n']} = "
        f"{r['rate']:.0%}  (95% CI {r['lo']:.0%} - {r['hi']:.0%})"
    )
    for s in sorted(mature, key=lambda s: -int(s["rework"])):
        if s["rework"]:
            bits = []
            if s["reopened"]:
                bits.append(f"reopened x{s['reopened']}")
            if s["followups"]:
                bits.append("follow-ups " + ", ".join(f"#{n}" for n in s["followups"]))
            print(f"    #{s['number']}: {'; '.join(bits)}")
    return r


def config_tracker():
    root = (
        os.environ.get("CLAUDE_PROJECT_DIR")
        or subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    )
    path = os.path.join(os.path.realpath(root), ".claude", "workflow-core.json")
    untracked = f'{path} declares no "tracker" — add it, or pass --repo.'
    try:
        with open(path, encoding="utf-8") as f:
            tracker = json.load(f).get("tracker")
    except FileNotFoundError:
        sys.exit(untracked)
    if not isinstance(tracker, str):
        sys.exit(untracked)
    return tracker


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Count downstream rework against the `--effort low` cohort and a control."
    )
    ap.add_argument("--repo", help="owner/name (default: the config's tracker)")
    ap.add_argument(
        "--horizon",
        type=int,
        # measured: longest first-rework lag 5.27 days, lucmoseley/mantahostels#1215
        default=5,
        help="days after close in which rework counts (default 5)",
    )
    ap.add_argument(
        "--min-lag",
        type=float,
        default=1.0,
        help="drop rework landing sooner than this many days after "
        "the close (default 1.0 — see signals())",
    )
    ap.add_argument(
        "--since",
        default="2026-08-01",
        help="earliest close date to consider for the control",
    )
    ap.add_argument(
        "--control-label",
        default="takes:implement",
        help="label defining the comparison cohort",
    )
    ap.add_argument(
        "--control-sample",
        type=int,
        # guess, lucmoseley/mantahostels#1084
        default=60,
        help="how many control issues to fetch; 0 for all "
        "(default 60 — the full set is a several-minute fetch)",
    )
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    a.repo = a.repo or config_tracker()

    now = dt.datetime.now(dt.timezone.utc)
    low_nums = numbers_for_label(LOW_LABEL, a.repo, a.since)
    ctl_all = [
        n
        for n in numbers_for_label(a.control_label, a.repo, a.since)
        if n not in low_nums
    ]
    ctl_nums = sample(ctl_all, a.control_sample)

    low_issues = fetch(low_nums, a.repo)
    ctl_issues = fetch(ctl_nums, a.repo)
    low = cohort(low_issues, a.horizon, now, a.min_lag)
    ctl = cohort(ctl_issues, a.horizon, now, a.min_lag)

    if a.json:
        print(
            json.dumps(
                {
                    "horizon": a.horizon,
                    "min_lag": a.min_lag,
                    "low": rate(low[0]),
                    "low_immature": len(low[1]),
                    "control": rate(ctl[0]),
                    "control_immature": len(ctl[1]),
                },
                default=str,
                indent=2,
            )
        )
        return 0

    print(
        f"Rework horizon: {a.horizon} days after close, counting rework "
        f"from {a.min_lag:g} day(s) after it.\nCloses considered from "
        f"{a.since}."
    )
    label = f"control ({a.control_label}, unlabelled)"
    if len(ctl_nums) < len(ctl_all):
        label += f" — sample of {len(ctl_nums)} from {len(ctl_all)}"
    lr = render(f"low arm ({LOW_LABEL})", *low, horizon=a.horizon, now=now)
    cr = render(label, *ctl, horizon=a.horizon, now=now)

    if a.min_lag > 0:
        print("\n--- same-day rework included, for comparison ---")
        render(
            f"low arm ({LOW_LABEL})",
            *cohort(low_issues, a.horizon, now, 0.0),
            horizon=a.horizon,
            now=now,
        )
        render(
            label, *cohort(ctl_issues, a.horizon, now, 0.0), horizon=a.horizon, now=now
        )

    print()
    if lr and cr:
        print(
            f"Low {lr['rate']:.0%} vs control {cr['rate']:.0%}. "
            f"mantahostels#1108 break-even is 23.7%."
        )
        if lr["lo"] > cr["hi"]:
            print("  Low arm's rework rate is above the control's, bands clear.")
        elif lr["hi"] < cr["lo"]:
            print("  Low arm's rework rate is below the control's, bands clear.")
        else:
            print("  Bands overlap: this cannot yet separate the arms.")
    else:
        print("No arm-to-arm comparison available yet — see the cohorts above.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
