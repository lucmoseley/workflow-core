#!/usr/bin/env python3
"""scan_rework.py — count downstream rework against the `--effort low` cohort and a control.

Built for mantahostels#1108, which measured what Opus `low` effort costs on live work.
The pass rate it observed is an *in-session* reading: a ticket whose own gate
went green today and which spawns a repair ticket next week scores there as a
clean pass.

The term it feeds is mantahostels#1084's: should checkable work run at `low` and be re-run
at `high` only when its check fails? Break-even measured at mantahostels#1108 is a **23.7%**
failure rate, and that figure is a lower bound (no `high` arm exists for this
work, so the ratio is against `medium`, and `high` costs at least as much).

## The horizon

Five days, measured rather than assumed (mantahostels#1215, `scan_lag.py`). Over 250 closed
`takes:implement` tickets the Kaplan-Meier curve of first rework flatlines by
day 6 and records nothing after it: 95% of observed rework has landed by day 4,
and the longest lag seen at all is 5.27 days. The 21 days this defaulted to
before was an argparse default no ticket derived, and it exceeded the corpus's
own depth — the deepest exposure available is ~12 days — so it could never have
been validated, only assumed, and it held every cohort permanently immature.

## Two signals

  * **Re-opened.** A `reopened` timeline event after the issue's first close.
  * **A follow-up issue citing it.** An issue *created after* the close whose
    body or title references it, read off the `cross-referenced` timeline
    events. Pull requests are excluded; this repo commits straight to `main`,
    so a PR reference here is noise from a dependency bot.

**File churn was considered and dropped.** "A later commit touched the same
files" is the strongest-looking signal and the least trustworthy one: this repo
has a handful of hot files (`docs/doc-map.md`, `scripts/session-arbiter.js`)
that nearly every session touches, so overlap measures a file's popularity, not
a ticket's quality.

## The maturation trap

An issue closed yesterday has had no opportunity to generate rework. The low
cohort closed inside one week; the control spans the whole corpus. Comparing
raw rework rates across them would show `low` looking cleaner purely because it
is younger.

So the comparison is **age-matched**, twice over:

  * an issue joins its cohort only once it has had `--horizon` days since close
    to generate rework (`mature`); and
  * only rework landing *within* `--horizon` days of that close is counted,
    so a 3-week-old issue and a 3-month-old one contribute the same window.

Where a cohort has no mature members, this prints the date its first reading
becomes available and returns **no rate at all**, rather than a rate off the
immature ones.

## What it still cannot see

  * **Silent degradation.** A brittle test, a poor abstraction, a comment that
    misleads a later reader -- none of these open an issue, so none is counted.
    A zero here is evidence about rework, never about quality.
  * **Rework nobody filed.** Work redone inside a later unrelated session
    leaves no issue and no reopen.
  * **Cohort difficulty.** The low arm was `scripts/`-tooling tickets with
    in-session verdicts, picked for checkability. `--control-label` narrows the
    control to the same class; it cannot match difficulty within it.
"""

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
    """GitHub timestamps, as an aware UTC datetime. `None` passes through."""
    if not s:
        return None
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def signals(issue, horizon_days, min_lag_days=0.0):
    """Rework signals for one issue, counted inside `horizon_days` of its close.

    `issue` is the shape `fetch()` returns: a number, a `closedAt`, and a
    timeline of `{event, createdAt, ...}` dicts. Returns `None` for an issue
    that is not closed at all: there is no close to measure a horizon from.

    `min_lag_days` drops rework landing sooner than that after the close.
    Measured at mantahostels#1215 over 250 closed tickets: 89 of 122 rework events land
    inside day one, at a median lag of 0.19 days. Nobody discovers a defect in
    four hours — that is the closing session filing its own follow-ups, which
    is this repo's normal practice and not degradation. Left at zero the count
    measures how issues get filed here, not whether the work held up.
    """
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
        # The *source* issue's creation date is the one that matters: a
        # reference added later to an issue that already existed is a link,
        # not rework this ticket caused.
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
    """Split a cohort into the mature members and the ones still ripening."""
    mature, immature = [], []
    for issue in issues:
        s = signals(issue, horizon_days, min_lag_days)
        if s is None:
            continue
        (mature if s["closed"] + horizon_days * DAY <= now else immature).append(s)
    return mature, immature


def rate(mature):
    """Rework rate plus a 95% Clopper-Pearson band, or `None` on an empty set.

    0 of 6 is compatible with a true rate near 40%, above mantahostels#1108's 23.7%
    break-even, so the point estimate alone would overstate the evidence.
    """
    n = len(mature)
    if n == 0:
        return None
    k = sum(1 for s in mature if s["rework"])
    lo, hi = clopper_pearson(k, n)
    return {"n": n, "k": k, "rate": k / n, "lo": lo, "hi": hi}


def clopper_pearson(k, n, alpha=0.05):
    """Exact binomial confidence interval, by bisection on the binomial tail.

    `alpha` defaults to the conventional 95% interval.

    Written out rather than pulled from scipy: scipy is not a dependency of
    this repo and one figure does not justify making it one.
    """

    def tail_ge(p, k, n):  # P(X >= k)
        return sum(binom_pmf(i, n, p) for i in range(k, n + 1))

    def tail_le(p, k, n):  # P(X <= k)
        return sum(binom_pmf(i, n, p) for i in range(0, k + 1))

    # `bisect` assumes an increasing function. P(X >= k) increases in p, so
    # the lower limit passes straight through; P(X <= k) *decreases* in p, so
    # the upper limit's residual is negated to point the search the right way.
    lo = 0.0 if k == 0 else bisect(lambda p: tail_ge(p, k, n) - alpha / 2)
    hi = 1.0 if k == n else bisect(lambda p: alpha / 2 - tail_le(p, k, n))
    return lo, hi


def binom_pmf(i, n, p):
    from math import comb

    return comb(n, i) * (p**i) * ((1 - p) ** (n - i))


def bisect(f, lo=0.0, hi=1.0, iters=80):
    # 80 halvings of [0, 1] reach 2**-80, past a float's 2**-52 precision.
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
    """One issue record per number, timeline included, via the REST API."""
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
    """A fixed sample of the control cohort, since it is far larger than the arm.

    The seed is fixed so two runs a week apart compare the same tickets
    rather than two different draws. Its value, mantahostels#1108's number,
    is arbitrary.
    """
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
    """The `tracker` declared in .claude/workflow-core.json at the host root
    (mantahostels#3568) — scripts/lib/workflow-core-config.js's rule, in Python."""
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
    try:
        with open(path, encoding="utf-8") as f:
            tracker = json.load(f).get("tracker")
    except FileNotFoundError:
        # No file is no tracker, and the exit below says so (#1274).
        tracker = None
    if not isinstance(tracker, str):
        sys.exit(f'{path} declares no "tracker" — add it, or pass --repo.')
    return tracker


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--repo", help="owner/name (default: the config's tracker)")
    ap.add_argument(
        "--horizon",
        type=int,
        # Measured: the module docstring's five days (mantahostels#1215).
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
        # A guess, never measured against the reading it changes.
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
