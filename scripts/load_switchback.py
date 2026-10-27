#!/usr/bin/env python3
"""load_switchback.py — the 24-against-48 load-ceiling switchback (#3223).

The design was ruled on #3211 (research: issuecomment-6434262362). Time is cut
into 15-minute blocks taken in pairs; one fair coin per pair gives one block
of the pair ceiling 24 and the other 48 (Bojinov, Simchi-Levi and Zhao 2023,
Theorem 3.2). Each block's first 5 minutes are a
washout and are not read, since load1 has lost almost all its memory of the
previous block by then (autocorrelation 0.10 at 5 minutes, #3223).

  draw     pre-draw the whole schedule into <home>/.claude/load-switchback/
  run      at each block's start, write its ceiling to <home>/.claude/load-ceiling,
           which lib/cpu-sample.js re-reads at every launch. Exits at the end of
           the schedule, at a stop rule or when the minute log falls silent,
           and removes the file whichever way it ends. Run it detached, the unit removing the file even on a
           kill the script cannot see:
             systemd-run --user --unit=wfc-load-switchback --collect \\
               -p ExecStopPost="/bin/rm -f $HOME/.claude/load-ceiling" \\
               python3 "$PWD/scripts/load_switchback.py" run
  readout  print the markdown readout for the ticket; --drop-pairs 1,2,3 (pairs
           count from 0) leads with the readout without those pairs and follows
           it with all pairs, for pairs an incident logged on the ticket before
           any readout ran (#3223 issuecomment-6446052849)

Residual: nothing enforces that order; pairs dropped after a readout was seen
are taken on trust.

Residual: a WSL shutdown during a 48 block stops the unit without its
ExecStopPost, leaving 48 in force until `rm ~/.claude/load-ceiling`.

Stop rules, set before the start (#3223): CPU PSI some avg60 at or above 90%
for 10 minutes in either arm, or a 24-arm block in which more than 3 test runs
were refused after their 5-minute hold.

The readout reads each block's last 10 minutes: hook-timeout refusals per
minute and the Bash median round-trip (dense_minute.py), the two measures that
decide the verdict; and beside them CPU PSI from ~/memwatch-minute.jsonl and
completed closes per hour across the owner's repos. Closes are context only:
they carry over for hours (#3211 Finding 1.4).
"""

import argparse
import json
import math
import os
import random
import secrets
import signal
import subprocess
import sys
import time
from collections import Counter
from datetime import UTC, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dense_minute
from dense_minute import epoch, median
from transcript_corpus import skips
from wfc_bin import bin_path

ARMS = LOW, HIGH = (24, 48)
BLOCK_S = 15 * 60
WASHOUT_S = 5 * 60
READ_MIN = (BLOCK_S - WASHOUT_S) // 60
# The ticket's "up to 36 h", inside the 48 h the founder gave the check (#3211).
HOURS = 36
PSI_STOP = 90.0
PSI_STOP_MINUTES = 10
REFUSAL_STOP = 3
# lib/cpu-sample.js's LOAD_HOLD_MS: a test refused at t was launched at t - HOLD_S.
HOLD_S = 5 * 60
# The minute log writes a line a minute; this many seconds without one is a
# memwatch that has stopped, half the PSI stop's window gone unseen.
SILENT_S = PSI_STOP_MINUTES * 60 // 2
# Twice the lines the PSI stop reads, at the minute log's longest line
# (337 bytes over 3,000 lines, 27 Oct).
TAIL_BYTES = 2 * (PSI_STOP_MINUTES + 1) * 340
OWNER = "lucmoseley"
ALPHA = 0.05
# 2**16 sums is as cheap as the sampled path; past it the draws sample. At
# 100,000 draws a p near ALPHA has a Monte Carlo standard error of 0.0007.
EXACT_MAX_PAIRS = 16
SIGN_FLIP_DRAWS = 100_000


def paths(home):
    state = os.path.join(home, ".claude", "load-switchback")
    return {
        "schedule": os.path.join(state, "schedule.json"),
        "events": os.path.join(state, "events.jsonl"),
        "ceiling": os.path.join(home, ".claude", "load-ceiling"),
        "minute_log": os.path.join(home, "memwatch-minute.jsonl"),
    }


def draw(start, rng=None):
    """The schedule: HOURS of paired blocks from `start`, a fair coin per pair."""
    rng = rng or secrets.SystemRandom()
    blocks = []
    for pair in range(HOURS * 3600 // (2 * BLOCK_S)):
        first = rng.choice(ARMS)
        for ceiling in (first, HIGH if first == LOW else LOW):
            blocks.append({"i": len(blocks), "pair": pair, "ceiling": ceiling})
    return {"start": start, "blocks": blocks}


def load_schedule(p):
    with open(p["schedule"]) as f:
        return json.load(f)


def block_span(sched, b):
    """(start, end) of block `b`."""
    start = sched["start"] + b["i"] * BLOCK_S
    return start, start + BLOCK_S


def _iso(t):
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log(p, now, **event):
    with open(p["events"], "a") as f:
        f.write(json.dumps({"ts": now, **event}) + "\n")


def _events(p):
    try:
        with open(p["events"]) as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        # No events yet: the runner has not started (#3223).
        return []


def write_ceiling(p, ceiling):
    tmp = p["ceiling"] + ".tmp"
    with open(tmp, "w") as f:
        f.write(f"{ceiling}\n")
    os.replace(tmp, p["ceiling"])


def clear_ceiling(p):
    try:
        os.remove(p["ceiling"])
    except FileNotFoundError:
        # Already gone is the state wanted: the default ceiling holds (#3223).
        pass


def minute_log(path, since, until, tail_bytes=None):
    """The minute log's lines with since <= ts < until, each with an epoch `t`.
    `tail_bytes` reads only the file's end, for the runner's minutely check."""
    try:
        f = open(path, "rb")
    except FileNotFoundError:
        # No log is no line; the runner reads that as a silent log and stops (#3223).
        return []
    with f:
        if tail_bytes:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - tail_bytes))
        raw = f.read().decode(errors="replace").splitlines()
    out = []
    for line in raw:
        try:
            r = json.loads(line)
            t = datetime.fromisoformat(r["ts"]).timestamp()
        except (ValueError, KeyError, TypeError):
            # A torn or foreign line carries no minute to read (#3223).
            continue
        if since <= t < until:
            out.append({**r, "t": t})
    return out


def psi_stop(lines, now):
    """The stop reason where the last PSI_STOP_MINUTES minute lines, all inside
    the last PSI_STOP_MINUTES + 1 minutes, read CPU PSI at or above PSI_STOP.
    A line with no PSI reading is not pressure, so it breaks the run (#3223)."""
    recent = [r for r in lines if now - (PSI_STOP_MINUTES + 1) * 60 <= r["t"] <= now]
    last = recent[-PSI_STOP_MINUTES:]
    if len(last) == PSI_STOP_MINUTES and all(
        (r.get("psi_cpu_some") or 0) >= PSI_STOP for r in last
    ):
        return f"CPU PSI some avg60 >= {PSI_STOP:g}% for {PSI_STOP_MINUTES} min"
    return None


def block_refusals(since, until):
    """(test runs refused at the load ceiling in [since, until), skip counts)."""
    tally = Counter()
    rows = dense_minute.minutes(dense_minute.transcripts(since), since, until, tally)
    return sum(m["refused"] for m in rows.values()), skips(tally)


def run(p, now=time.time, sleep=time.sleep, refusals=block_refusals):
    """Walk the schedule from now. Returns the reason it ended."""
    sched = load_schedule(p)
    pending = []  # (block, refusal window) for low blocks whose refusals are not all in

    def term(*_):
        raise SystemExit("terminated")

    def check():
        lines = minute_log(p["minute_log"], 0, math.inf, TAIL_BYTES)
        if not any(r["t"] >= now() - SILENT_S for r in lines):
            return f"no minute-log line in the last {SILENT_S // 60} min, so the PSI stop cannot see"
        stop = psi_stop(lines, now())
        if stop:
            return stop
        while pending and now() >= pending[0][1][1]:
            b, (lo, hi) = pending.pop(0)
            n, skipped = refusals(lo, hi)
            _log(p, now(), event="refusals", i=b["i"], n=n, **skipped)
            if n > REFUSAL_STOP:
                return f"{n} test runs refused in {LOW}-arm block {b['i']}"
        return None

    def wait_until(t):
        while now() < t:
            sleep(min(60, t - now()))
            stop = check()
            if stop:
                return stop
        return None

    signal.signal(signal.SIGTERM, term)
    _log(p, now(), event="start")
    why = "schedule complete"
    try:
        stop = check()
        if stop:
            why = stop
            return why
        for b in sched["blocks"]:
            start, end = block_span(sched, b)
            if now() >= end:
                continue
            stop = wait_until(start)
            if stop:
                why = stop
                return why
            write_ceiling(p, b["ceiling"])
            _log(p, now(), event="block", i=b["i"], ceiling=b["ceiling"])
            if b["ceiling"] == LOW:
                pending.append((b, (start + HOLD_S, end + HOLD_S)))
            stop = wait_until(end)
            if stop:
                why = stop
                return why
        clear_ceiling(p)
        stop = wait_until(pending[-1][1][1]) if pending else None
        why = stop or why
        return why
    except BaseException as e:
        why = f"{type(e).__name__}: {e}"
        raise
    finally:
        clear_ceiling(p)
        _log(p, now(), event="end", why=why)


def closes(since, until):
    """The epoch of each COMPLETED issue close across OWNER's repos (#3212)."""
    q = f"user:{OWNER} is:issue is:closed reason:completed closed:{_iso(since)}..{_iso(until)}"
    out = subprocess.run(
        [
            bin_path("gh"),
            "api",
            "-X",
            "GET",
            "search/issues",
            "-f",
            f"q={q}",
            "-f",
            "per_page=100",
            "--paginate",
            "--jq",
            ".items[].closed_at",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [epoch(s) for s in out.split()]


def median_ci(xs):
    """The distribution-free 95% interval for a median: the order statistics
    x(k) and x(n-k+1), k the largest with P(Bin(n, 1/2) < k) <= 0.025."""
    s = sorted(xs)
    n = len(s)
    k, tail = 0, 0.0
    while True:
        nxt = tail + math.comb(n, k) / 2**n
        if nxt > ALPHA / 2:
            break
        tail, k = nxt, k + 1
    return None if k == 0 else (s[k - 1], s[n - k])


def sign_flip_p(diffs):
    """One-sided p that the mean within-pair difference is this large by the
    coin alone: exact over every flip up to EXACT_MAX_PAIRS, else sampled."""
    n = len(diffs)
    if not n:
        return None
    obs = sum(diffs)
    if n <= EXACT_MAX_PAIRS:
        hits = sum(
            sum(d if mask >> j & 1 else -d for j, d in enumerate(diffs)) >= obs - 1e-12
            for mask in range(2**n)
        )
        return hits / 2**n
    rng = random.Random(3223)
    hits = sum(
        sum(d if rng.random() < 0.5 else -d for d in diffs) >= obs - 1e-12
        for _ in range(SIGN_FLIP_DRAWS)
    )
    return (hits + 1) / (SIGN_FLIP_DRAWS + 1)


# Each metric's readout row: its label, and the sign that makes "the low arm
# is worse" a positive difference. A sign of 0 is context, never tested.
METRICS = (
    ("hto_min", "Hook-timeout refusals / min", 1),
    ("bash_p50", "Bash median round-trip, s", 1),
    ("closes_h", "Closes / h (context)", 0),
    ("psi", "CPU PSI some avg60, % (context)", 0),
)


def blocks_read(sched, events, *, minute_rows, mem, close_ts, until):
    """One row per block that ended by `until`, which a runner started inside
    its washout and did not end before the block did, read past its washout."""
    rows = []
    for b in sched["blocks"]:
        start, hi = block_span(sched, b)
        lo = start + WASHOUT_S
        began = [
            e["ts"] for e in events if e.get("event") == "block" and e["i"] == b["i"]
        ]
        if hi > until or not began or not start <= began[-1] <= lo:
            continue
        if any(e.get("event") == "end" and began[-1] <= e["ts"] < hi for e in events):
            continue
        mins = [m for k, m in minute_rows.items() if lo <= k < hi]
        in_block = [r for r in mem if lo <= r["t"] < hi]
        rows.append(
            {
                **b,
                "hto_min": sum(m["hto"] for m in mins) / READ_MIN,
                "bash_p50": median([x for m in mins for x in m["bash"]]),
                "closes_h": sum(lo <= t < hi for t in close_ts) * 60 / READ_MIN,
                "psi": median(
                    [
                        r["psi_cpu_some"]
                        for r in in_block
                        if r.get("psi_cpu_some") is not None
                    ]
                ),
                "binding": any((r.get("load1") or 0) >= LOW for r in in_block),
            }
        )
    return rows


def _fmt(x):
    return "–" if x is None else f"{x:.2f}"


def _cell(xs):
    xs = [x for x in xs if x is not None]
    ci = median_ci(xs) if xs else None
    band = f" [{_fmt(ci[0])}, {_fmt(ci[1])}]" if ci else ""
    return f"{_fmt(median(xs))}{band} (n {len(xs)})"


def report(rows, end_why):
    """The readout's markdown, and its verdict word: `keep 24` or `revert`."""
    arm = {c: [r for r in rows if r["ceiling"] == c] for c in ARMS}
    by_pair = {}
    for r in rows:
        by_pair.setdefault(r["pair"], {})[r["ceiling"]] = r
    pairs = [v for v in by_pair.values() if len(v) == 2]
    out = [
        f"| Measure | {LOW} arm | {HIGH} arm | Within-pair {LOW} − {HIGH} | p ({LOW} worse) |",
        "|---|---|---|---|---|",
    ]
    worse = []
    for key, label, sign in METRICS:
        diffs = [
            pr[LOW][key] - pr[HIGH][key]
            for pr in pairs
            if pr[LOW][key] is not None and pr[HIGH][key] is not None
        ]
        p = sign_flip_p([sign * d for d in diffs]) if sign and diffs else None
        if p is not None and p < ALPHA:
            worse.append(label)
        out.append(
            f"| {label} | {_cell(r[key] for r in arm[LOW])} | {_cell(r[key] for r in arm[HIGH])} "
            f"| {_cell(diffs)} | {'–' if p is None else f'{p:.3f}'} |"
        )
    out.append(
        f"| Blocks where load1 reached {LOW} | {sum(r['binding'] for r in arm[LOW])} of {len(arm[LOW])} "
        f"| {sum(r['binding'] for r in arm[HIGH])} of {len(arm[HIGH])} | | |"
    )
    verdict = "revert" if worse else f"keep {LOW}"
    out += [
        "",
        f"Ended: {end_why}. {len(pairs)} complete pairs; each block read over its last {READ_MIN} minutes.",
        f"**Verdict: {verdict}**"
        + (
            f" — the {LOW} arm is worse at p < {ALPHA} on: {', '.join(worse)}."
            if worse
            else f" — the {LOW} arm is worse on no tested measure at p < {ALPHA}."
        ),
    ]
    return "\n".join(out), verdict


def readouts(rows, end_why, drop_pairs):
    """The readout of `rows`; with `drop_pairs`, the readout without them
    first, the one the verdict is taken from, then all pairs beside it."""
    if not drop_pairs:
        return report(rows, end_why)[0]
    named = ", ".join(map(str, sorted(drop_pairs)))
    kept = [r for r in rows if r["pair"] not in drop_pairs]
    return "\n\n".join(
        [
            f"**Primary — pairs {named} dropped:**",
            report(kept, end_why)[0],
            "**Sensitivity — all pairs:**",
            report(rows, end_why)[0],
        ]
    )


def pair_set(v):
    try:
        return {int(x) for x in v.split(",")}
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"{v!r} is not comma-separated pair numbers, e.g. 1,2,3"
        ) from None


def readout(p, drop_pairs):
    sched = load_schedule(p)
    unknown = drop_pairs - {b["pair"] for b in sched["blocks"]}
    if unknown:
        last = sched["blocks"][-1]["pair"]
        sys.exit(
            f"readout: no pair {sorted(unknown)} in the schedule; pairs run 0-{last}"
        )
    events = _events(p)
    last = events[-1] if events else {}
    end_why = last["why"] if last.get("event") == "end" else "still running"
    since, until = sched["start"], time.time()
    tally = Counter()
    minute_rows = dense_minute.minutes(
        dense_minute.transcripts(since), since, until, tally
    )
    rows = blocks_read(
        sched,
        events,
        minute_rows=minute_rows,
        mem=minute_log(p["minute_log"], since, until),
        close_ts=closes(since, until),
        until=until,
    )
    return f"{readouts(rows, end_why, drop_pairs)}\n\nTranscripts skipped: {dense_minute.counts_line(tally)}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--home", default=os.path.expanduser("~"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("draw")
    sub.add_parser("run")
    sub.add_parser("readout").add_argument(
        "--drop-pairs",
        type=pair_set,
        default=set(),
        help="comma-separated pair numbers, counted from 0, to lead the readout without",
    )
    a = ap.parse_args(argv)
    p = paths(a.home)
    if a.cmd == "draw":
        for k in ("schedule", "events", "ceiling"):
            if os.path.exists(p[k]):
                sys.exit(f"draw: {p[k]} already exists; move it aside first")
        os.makedirs(os.path.dirname(p["schedule"]), exist_ok=True)
        start = math.ceil(time.time() / 60) * 60
        with open(p["schedule"], "w") as f:
            json.dump(draw(start), f, indent=1)
        print(f"draw: {HOURS} h of paired blocks from {_iso(start)} -> {p['schedule']}")
    elif a.cmd == "run":
        print(f"run: ended — {run(p)}")
    else:
        print(readout(p, a.drop_pairs))


if __name__ == "__main__":
    main()
