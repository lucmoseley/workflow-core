"""Red-main periods from the scheduled-checks sweeps (the #2216 method), plus the lander's tests.
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I red_main.py <sweeps.json> <runs.jsonl> [start] [end]
sweeps.json: gh run list -R lucmoseley/workflow-core --workflow scheduled-checks.yml --limit 100
  --json databaseId,createdAt,updatedAt,conclusion,headSha,event,status
A red period starts at the first failed sweep after a green one and ends at the next green sweep.
'skipped' and in-progress sweeps carry no verdict and are ignored.
Lander part: each lander full run's verdict at its sha, in time order; a red stretch is from the first
red lander run to the next green lander run."""

import json
import sys
from datetime import UTC, datetime


def utc(t):
    return datetime.fromtimestamp(t, UTC).replace(tzinfo=None)


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


sw, runsf = sys.argv[1:3]
start = sys.argv[3] if len(sys.argv) > 3 else "2026-10-10T04:10:00Z"
end = sys.argv[4] if len(sys.argv) > 4 else "2026-10-24T04:10:59Z"
rows = sorted(
    [r for r in json.load(open(sw)) if r["conclusion"] in ("success", "failure")],
    key=lambda r: r["createdAt"],
)


def periods(seq, t_start, t_end):
    out = []
    red_from = None
    state = None
    for t, v in seq:
        if v == "red" and state != "red":
            red_from = max(t, t_start)
        if v == "green" and state == "red":
            if t >= t_start:
                out.append((red_from, t, False))
        state = v
    if state == "red":
        out.append((red_from, t_end, True))
    return [(a, b, o) for a, b, o in out if b > t_start]


seq = [
    (ts(r["createdAt"]), "green" if r["conclusion"] == "success" else "red")
    for r in rows
]
# state at window start
t0, t1 = ts(start), ts(end)
if not seq:
    sys.exit("no sweep with a verdict")
ci_end = max(t for t, _ in seq)
p = periods(seq, t0, min(t1, ci_end))
w = min(t1, ci_end) - t0
red = sum(b - a for a, b, _ in p)
print(
    f"CI sweeps with a verdict in window: {sum(1 for t, _ in seq if t0 <= t <= t1)}, red {sum(1 for t, v in seq if t0 <= t <= t1 and v == 'red')}"
)
print(
    f"CI window {utc(t0)} to last verdict {utc(min(t1, ci_end))}: {w / 3600:.1f} h; red {red / 3600:.1f} h ({red / w:.0%})"
)
for a, b, o in p:
    print(
        f"  red {utc(a):%m-%d %H:%M} to {utc(b):%m-%d %H:%M} {(b - a) / 3600:5.1f} h{' (open at the last verdict)' if o else ''}"
    )
ln = sorted(
    [
        (ts(r["startedAt"]), r["_v"], r["sha"][:9], r["durationMs"])
        for r in map(json.loads, open(runsf))
        if r["_k"] == "lander"
    ]
)
seq_lander = [
    (t, "green" if v == "green" else "red")
    for t, v, s, d in ln
    if v in ("green", "red")
]
pl = periods(seq_lander, ln[0][0], ln[-1][0]) if seq_lander else []
print("lander red stretches (lander full runs red until the next green):")
for a, b, o in pl:
    print(
        f"  {utc(a):%m-%d %H:%M} to {utc(b):%m-%d %H:%M} {(b - a) / 3600:5.1f} h{' (open: later runs gave no verdict)' if o else ''}"
    )
red_runs = [d for t, v, s, d in ln if v == "red"]
nov = [d for t, v, s, d in ln if v not in ("green", "red")]
print(
    f"lander red runs {len(red_runs)} {sum(red_runs) / 3.6e6:.2f} h; no-verdict runs {len(nov)} {sum(nov) / 3.6e6:.2f} h; green {sum(1 for t, v, s, d in ln if v == 'green')}"
)
