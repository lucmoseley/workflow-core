#!/usr/bin/env python3
"""stats.py: summarises the per-session CSV that measure.py writes into the
firing rates and turns-remaining figures of
https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-ceiling-firing-rates.md (mantahostels#1546).

A separate pass so the figures can be recut without re-streaming the corpus.
"""

import csv
import importlib.util
import os
import statistics as st
from collections import defaultdict, Counter
from pathlib import Path

# Loaded by path under its own name, as test_session_ceilings.py loads it:
# measure-docmap-denials has a `measure.py` too, and a bare `from measure
# import` takes whichever one sys.modules or sys.path finds first (#1298).
_spec = importlib.util.spec_from_file_location(
    "session_ceilings_measure", Path(__file__).with_name("measure.py")
)
_measure = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_measure)
THRESHOLDS = _measure.THRESHOLDS

# WFC_SESSIONS_CSV is set by hand by whoever runs the measurement, to keep
# the CSV out of the working directory: no test fills it (base §G7).
IN_CSV = os.environ.get("WFC_SESSIONS_CSV", "sessions.csv")


def to_int(v):
    if v is None or v == "":
        return None
    return int(float(v))


def to_bool(v):
    return v == "True"


rows = []
with open(IN_CSV) as f:
    r = csv.DictReader(f)
    for row in r:
        rows.append(row)

print(f"total rows: {len(rows)}")


def is_sub(r):
    return to_bool(r["is_subagent"])


def is_sdkpy(r):
    return r["kind"] == "sdk-py"


main_rows = [r for r in rows if not is_sub(r)]
sub_rows = [r for r in rows if is_sub(r)]
print(f"main rows: {len(main_rows)}, subagent rows: {len(sub_rows)}")

sdkpy_rows = [r for r in main_rows if is_sdkpy(r)]
print(f"sdk-py main sessions: {len(sdkpy_rows)}")

# population for headline: main sessions excluding sdk-py
pop_main = [r for r in main_rows if not is_sdkpy(r)]
print(f"main sessions excl sdk-py: {len(pop_main)}")

# compaction count within pop_main
compacted = [
    r for r in pop_main if to_int(r["compactions"]) and to_int(r["compactions"]) > 0
]
print(f"pop_main sessions with >=1 compaction: {len(compacted)}")


def dist(values):
    if not values:
        return None
    values = sorted(values)
    n = len(values)

    def pct(p):
        if n == 1:
            return values[0]
        k = (n - 1) * p
        f = int(k)
        c = min(f + 1, n - 1)
        if f == c:
            return values[f]
        return values[f] + (values[c] - values[f]) * (k - f)

    return {
        "n": n,
        "median": st.median(values),
        "p25": pct(0.25),
        "p75": pct(0.75),
        "p90": pct(0.90),
        "max": values[-1],
        "min": values[0],
    }


def wilson_ci(k, n, z=1.96):
    # z for a two-sided 95% interval.
    if n == 0:
        return (None, None, None)
    p = k / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    adj = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)
    lo = (centre - adj) / denom
    hi = (centre + adj) / denom
    return (p, lo, hi)


def report_population(name, population):
    print(f"\n=== {name} (n={len(population)}) ===")
    out = {}
    for t in THRESHOLDS:
        crossed = [r for r in population if to_int(r[f"cross_{t}_turn"]) is not None]
        n_crossed = len(crossed)
        remaining = [to_int(r[f"remaining_after_{t}"]) for r in crossed]
        d = dist(remaining)
        print(
            f"-- threshold {t}: crossed {n_crossed}/{len(population)} ({100 * n_crossed / len(population):.1f}% of pop)"
        )
        if d:
            print(
                f"   remaining-turns distribution: median={d['median']:.1f} p25={d['p25']:.1f} p75={d['p75']:.1f} p90={d['p90']:.1f} max={d['max']} min={d['min']}"
            )
        out[t] = {"n_crossed": n_crossed, "dist": d, "crossed_rows": crossed}
    return out


def headline(crossed_150k_rows):
    n = len(crossed_150k_rows)
    results = {}
    for bar in (25, 30, 35):
        k = sum(
            1 for r in crossed_150k_rows if to_int(r["remaining_after_150000"]) >= bar
        )
        p, lo, hi = wilson_ci(k, n)
        results[bar] = (k, n, p, lo, hi)
        print(
            f"  >= {bar} further turns: {k}/{n} = {p * 100:.1f}% (95% CI {lo * 100:.1f}%-{hi * 100:.1f}%)"
            if n
            else "  n=0"
        )
    return results


print(
    "\n########## HEADLINE POPULATION: main sessions, excl sdk-py, excl subagents ##########"
)
res_main = report_population("main sessions (excl sdk-py)", pop_main)
print("\nHeadline % of 150k-crossers reaching N further turns (main, excl sdk-py):")
crossed_150k_main = res_main[150000]["crossed_rows"]
headline(crossed_150k_main)

print("\n########## Including subagent transcripts as their own sessions ##########")
pop_all = pop_main + sub_rows
res_all = report_population("main(excl sdk-py) + subagent transcripts", pop_all)
print("\nHeadline % of 150k-crossers reaching N further turns (incl subagents):")
crossed_150k_all = res_all[150000]["crossed_rows"]
headline(crossed_150k_all)

print("\n########## subagents only ##########")
res_sub = report_population("subagent transcripts only", sub_rows)
print("\nHeadline % (subagents only):")
crossed_150k_sub = res_sub[150000]["crossed_rows"]
headline(crossed_150k_sub)

print(
    "\n########## sdk-py sessions (excluded from headline; reported separately) ##########"
)
res_sdkpy = report_population("sdk-py main sessions", sdkpy_rows)

# Kind breakdown for main pop
print("\n########## Kind breakdown (main sessions, excl sdk-py) ##########")
kind_counter = Counter(r["kind"] for r in pop_main)
for k, v in kind_counter.most_common(30):
    print(f"  {k}: {v}")

print(
    "\n########## Per-kind headline @150k (main sessions, excl sdk-py), kinds with >=5 crossers ##########"
)
by_kind = defaultdict(list)
for r in pop_main:
    by_kind[r["kind"]].append(r)

for k, group in sorted(by_kind.items(), key=lambda x: -len(x[1])):
    crossed = [r for r in group if to_int(r["cross_150000_turn"]) is not None]
    if len(crossed) < 5:
        continue
    n = len(crossed)
    k30 = sum(1 for r in crossed if to_int(r["remaining_after_150000"]) >= 30)
    p, lo, hi = wilson_ci(k30, n)
    print(
        f"  {k}: crossed={n}/{len(group)}, >=30 further turns: {k30}/{n} = {p * 100:.1f}% (CI {lo * 100:.1f}-{hi * 100:.1f}%)"
    )

# background vs interactive split explicit
print("\n########## background vs interactive (main, excl sdk-py) ##########")
bg = [r for r in pop_main if r["kind"].startswith("background")]
interactive = [r for r in pop_main if not r["kind"].startswith("background")]
for name, grp in [("background", bg), ("interactive/other", interactive)]:
    crossed = [r for r in grp if to_int(r["cross_150000_turn"]) is not None]
    n = len(crossed)
    if n == 0:
        print(f"  {name}: n=0 crossed")
        continue
    k30 = sum(1 for r in crossed if to_int(r["remaining_after_150000"]) >= 30)
    p, lo, hi = wilson_ci(k30, n)
    print(
        f"  {name}: total={len(grp)}, crossed={n}, >=30 further turns: {k30}/{n} = {p * 100:.1f}% (CI {lo * 100:.1f}-{hi * 100:.1f}%)"
    )


# date range
def get_ts(r, key):
    v = r.get(key)
    return v if v else None


all_ts = [r["first_ts"] for r in rows if r.get("first_ts")] + [
    r["last_ts"] for r in rows if r.get("last_ts")
]
if all_ts:
    print(f"\ndate range across all files: {min(all_ts)} to {max(all_ts)}")

# max_context sanity: how many sessions never exceed 100k at all
never_100k = sum(1 for r in pop_main if to_int(r["cross_100000_turn"]) is None)
print(
    f"\nmain sessions (excl sdk-py) never crossing 100k: {never_100k}/{len(pop_main)}"
)

# turn count stats overall
tt = [to_int(r["total_turns"]) for r in pop_main]
print(
    f"\nmain session total_turns: median={st.median(tt)}, mean={sum(tt) / len(tt):.1f}, max={max(tt)}"
)
