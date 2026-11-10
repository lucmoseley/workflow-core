#!/usr/bin/env python3
"""memory_switchback.py — the memory-hold switchback (#4862, designed on #4162).

Does holding one session's worth of guest memory, with launches held fixed,
slow Bash round-trip? Time is cut into 15-minute blocks taken in pairs; one
fair coin per pair gives one block a hold and the other none. Each block's
first 5 minutes are a washout and are not read (load_switchback.py's shape).

The hold is one more session's launch charge as admission computes it at
`draw` (`nextNeedMb - drawNeedMb` in ~/.claude/concurrency.jsonl, 668 MB on
10 Nov). Pair 0 holds half of it and is never read: the low-side start. While
a hold runs, ~/.claude/memory-hold reads `<MB> <pid> <procStart>`, and
lib/meminfo.js adds the MB back to MemAvailable for admission, the suite
ladder and the reap, so launches stay fixed and only the kernel feels the
hold. The Windows-memory limb of the suite and tsc gates (lib/windows-memory.js)
gets no add-back: it guards the VM against freezing, and how much of a guest
hold reaches Windows is unmeasured. The readout counts its stand-down minutes
per arm instead, as a balance check.

  draw     pre-draw the schedule and the hold size into <home>/.claude/memory-switchback/;
           run it right before `run`, which refuses a schedule whose pair 0 has passed
  run      walk the schedule, starting and ending the holder at each block's edges.
           Ends at the schedule's end, at USABLE_PAIRS usable pairs or at a stop
           rule, and removes the hold whichever way it ends. Run it detached, the
           unit removing the hold file even on a kill the script cannot see;
           stopping the unit kills the holder with it:
             systemd-run --user --unit=wfc-memory-switchback --collect \\
               -p ExecStopPost="/bin/rm -f $HOME/.claude/memory-hold" \\
               python3 "$PWD/scripts/memory_switchback.py" run
           Restarted after a reboot or a kill, it resumes at the block in
           progress; after a stop rule or a finished trial it refuses.
  hold     the holder itself: resident anonymous memory, re-touched every
           TOUCH_S seconds at low CPU, `ready` on stdout once every page is in
  readout  print the markdown readout for the ticket

Stop rules, set before the start (#4162 issuecomment-6757858934, the Windows
rule re-set on #4862). Each binds while a hold runs and through the washout
after it, where its harm would show; any one ends the trial:
  an earlyoom kill; guest MemAvailable under 1,094 MB for 2 min; swap used over
  1,800 MB; memory PSI full avg60 >= 10% for 5 min; Windows available memory
  (`win_avail_mb`, the minute log) under 500 MB for 5 minute lines; and the
  minute log silent for 3 min, which blinds the Windows rule; and a holder
  that does not report ready within READY_S.

The readout reads each block's last 10 minutes. Decision: the within-pair log
ratio of block median Bash round-trip, hold over none, by a two-sided sign-flip
test at ALPHA. Companions: hook-timeout refusals per minute, machine CPU-s per
Bash call. Guardrail, spending no alpha: closes per hour. A pair counts only
where both blocks are usable: a refill-loop tick, a median of >= 3 active
transcripts over the minutes with a call (#4162's sizing mask) and >= 20 Bash
calls in the read window.
"""

import argparse
import json
import math
import os
import secrets
import selectors
import signal
import statistics
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dense_minute
from dense_minute import epoch, median
from load_switchback import (
    ALPHA,
    BLOCK_S,
    READ_MIN,
    WASHOUT_S,
    _events,
    _iso,
    _log,
    block_span,
    closes,
    load_schedule,
    minute_log,
    sign_flip_p,
)
from memwatch_minute import json_lines
from wfc_bin import bin_path

HOLD, NONE = "hold", "none"
# #4162: 77 usable pairs detect a 14% slowdown at 80% power, two-sided ALPHA.
USABLE_PAIRS = 77
# The slowdown at which one more session stops paying for itself (#4162).
BREAK_EVEN = 1.14
# Half of loop-on pairs were usable on 4-10 Nov (#4162), and the loop is not
# always on: a week of schedule bounds the run, USABLE_PAIRS ends it sooner.
SCHEDULE_H = 7 * 24
# #4162's usable-block mask, the one its 77 pairs were sized on.
MIN_ACTIVE = 3
MIN_BASH = 20
# The pairs each read skips: pair 0 is the half-size low-side start (#4162).
UNREAD_PAIRS = {0}
# Ticks admitting no session by memory, of which the hold size is the median:
# the newest 50 span ~1 h of the loop's ticks (concurrency.jsonl, 10 Nov).
CHARGE_TICKS = 50

PAGE = 4096
# Re-touching keeps the pages on the active list, as a working session's are;
# 10 s costs ~0.1 CPU-s per 100 MB (measured on #4862) and is far inside the
# kernel's LRU ageing.
TOUCH_S = 10
# A 668 MB fill takes under 1 s; a holder that has not filled in 60 s is
# stuck behind reclaim, the harm the stop rules exist for.
READY_S = 60
# Stop rules are read every 15 s: the shortest sustained window is 2 min.
TICK_S = 15
# How long a holder has to exit on SIGTERM before it is killed.
STOP_GRACE_S = 30

AVAIL_STOP_MB = 1094  # earlyoom's 794 MB floor + 300 margin
AVAIL_STOP_S = 2 * 60
SWAP_STOP_MB = 1800
PSI_FULL_STOP = 10.0
PSI_FULL_STOP_S = 5 * 60
# Re-set on #4862 from the ruled ~1.9 GB: Windows read under 1.9 GB in 64% of
# minutes from 4 Nov with no hold, so that line would end the trial at its
# first minute. Under 500 MB for 5 minute lines read zero times from 9 Nov
# 19:04 to 10 Nov 11:50 +08 with the guest reclaim live, and 4 times with
# 668 MB taken off every line.
WIN_STOP_MB = 500
WIN_STOP_LINES = 5
# The minute log's newest lines the Windows rule reads, and the bytes that
# hold them: 10 lines at the log's ~800-byte lines.
WIN_READ_S = 10 * 60
WIN_TAIL_BYTES = 8 * 1024
# Silent for 3 lines, the Windows rule has lost most of its 5-line window.
SILENT_S = 3 * 60
# lib/windows-memory.js's WINDOWS_FLOOR_MB, under which suites and tsc wait:
# the readout's balance row. Move both, or neither.
WINDOWS_FLOOR_MB = 1000
# An end that a restart must not resume past.
FINAL = ("stop rule", "schedule complete", "usable pairs")


def paths(home):
    state = os.path.join(home, ".claude", "memory-switchback")
    return {
        "schedule": os.path.join(state, "schedule.json"),
        "events": os.path.join(state, "events.jsonl"),
        "hold": os.path.join(home, ".claude", "memory-hold"),
        "minute_log": os.path.join(home, "memwatch-minute.jsonl"),
        "concurrency": os.path.join(home, ".claude", "concurrency.jsonl"),
    }


# ---- draw -----------------------------------------------------------------


def launch_charge_mb(rows):
    """One more session's launch charge, `nextNeedMb - drawNeedMb`, as the
    median of the newest CHARGE_TICKS ticks admitting no session by memory.
    Only there is nextNeedMb the need for exactly one more: past that it
    carries the spare pairs a 2nd launch warms (lib/admission-figures.js's
    launchNeedFor)."""
    deltas = [
        m["nextNeedMb"] - m["drawNeedMb"]
        for m in (r.get("memory") or {} for r in rows)
        if m.get("memorySlots") == 0
        and isinstance(m.get("nextNeedMb"), int)
        and isinstance(m.get("drawNeedMb"), int)
    ][-CHARGE_TICKS:]
    return round(statistics.median(deltas)) if deltas else None


def read_jsonl(path):
    """`path`'s JSON lines; none where it does not exist yet."""
    try:
        with open(path) as f:
            return list(json_lines(f))
    except FileNotFoundError:
        # No log is no tick; the readout says so where that empties a block (#4862).
        return []


def draw(start, hold_mb, rng=None):
    """The schedule: SCHEDULE_H of paired blocks from `start`, a fair coin per
    pair; pair 0 holds half of `hold_mb`."""
    rng = rng or secrets.SystemRandom()
    blocks = []
    for pair in range(SCHEDULE_H * 3600 // (2 * BLOCK_S)):
        first = rng.choice((HOLD, NONE))
        for arm in (first, NONE if first == HOLD else HOLD):
            mb = (hold_mb // 2 if pair == 0 else hold_mb) if arm == HOLD else 0
            blocks.append({"i": len(blocks), "pair": pair, "arm": arm, "mb": mb})
    return {"start": start, "hold_mb": hold_mb, "blocks": blocks}


# ---- hold -----------------------------------------------------------------


def hold(mb):
    """Hold `mb` MB of anonymous memory resident: one byte written per page
    makes each resident, and rewriting it every TOUCH_S keeps the pages
    recently used. Runs until killed."""
    os.nice(19)
    buf = bytearray(mb * 2**20)
    pages = len(buf) // PAGE
    v = 1
    buf[::PAGE] = bytes([v]) * pages
    print("ready", flush=True)
    while True:
        time.sleep(TOUCH_S)
        v = 3 - v
        buf[::PAGE] = bytes([v]) * pages


def proc_start(pid):
    """/proc/<pid>/stat field 22, the start token lib/arbiter-proc.js reads."""
    with open(f"/proc/{pid}/stat") as f:
        return f.read().rsplit(")", 1)[1].split()[19]


class HolderNotReadyError(RuntimeError):
    pass


class Holder:
    """The holder child and its declaration, ~/.claude/memory-hold."""

    def __init__(self, p):
        self.p = p
        self.proc = None

    def start(self, mb):
        self.proc = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "hold", str(mb)],
            stdout=subprocess.PIPE,
            text=True,
        )
        # The pages go in before the add-back does: the brief window between
        # holds memory unannounced, the conservative side for admission.
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(self.proc.stdout, selectors.EVENT_READ)
                ready = (
                    sel.select(READY_S)
                    and self.proc.stdout.readline().strip() == "ready"
                )
            if not ready:
                raise HolderNotReadyError(
                    f"stop rule: holder of {mb} MB not ready in {READY_S} s"
                )
            tmp = self.p["hold"] + ".tmp"
            with open(tmp, "w") as f:
                f.write(f"{mb} {self.proc.pid} {proc_start(self.proc.pid)}\n")
            os.replace(tmp, self.p["hold"])
        except BaseException:
            self.stop()
            raise

    def stop(self):
        # The add-back goes before the pages do, the conservative order again.
        try:
            os.remove(self.p["hold"])
        except FileNotFoundError:
            # Already gone is the state wanted: nothing is added back (#4862).
            pass
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=STOP_GRACE_S)
            except subprocess.TimeoutExpired:
                # A holder deaf to SIGTERM still holds the pages: kill it (#4862).
                self.proc.kill()
                self.proc.wait()
            self.proc = None


# ---- stop rules -----------------------------------------------------------


def read_meminfo(path="/proc/meminfo"):
    """MemAvailable and swap used in MB, read raw: no add-back here."""
    kb = {}
    with open(path) as f:
        for line in f:
            k, _, rest = line.partition(":")
            kb[k] = int(rest.split()[0])
    return kb["MemAvailable"] // 1024, (kb["SwapTotal"] - kb["SwapFree"]) // 1024


def read_psi_full_avg60(path="/proc/pressure/memory"):
    with open(path) as f:
        for line in f:
            if line.startswith("full"):
                return float(line.split("avg60=")[1].split()[0])
    return None


def earlyoom_kills(since):
    """earlyoom's kill lines since epoch `since`, from the journal."""
    out = subprocess.run(
        [
            bin_path("journalctl"),
            "-u",
            "earlyoom",
            "--since",
            f"@{int(since)}",
            "-o",
            "cat",
            "--no-pager",
        ],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    return [
        line
        for line in out.splitlines()
        if "sending SIG" in line and "to process" in line
    ]


class Stops:
    """The stop rules. `check` takes one reading and returns the reason the
    trial ends, or None. A sustained rule fires once its condition has held,
    unbroken, for its window."""

    def __init__(self):
        self.since = {}

    def _held(self, key, cond, now, window):
        if not cond:
            self.since.pop(key, None)
            return False
        t0 = self.since.setdefault(key, now)
        return now - t0 >= window

    def check(self, now, *, avail_mb, swap_mb, psi_full, win_lines, kills):
        why = self._why(
            now,
            avail_mb=avail_mb,
            swap_mb=swap_mb,
            psi_full=psi_full,
            win_lines=win_lines,
            kills=kills,
        )
        return f"stop rule: {why}" if why else None

    def _why(self, now, *, avail_mb, swap_mb, psi_full, win_lines, kills):
        if kills:
            return f"earlyoom killed: {kills[0]}"
        if self._held("avail", avail_mb < AVAIL_STOP_MB, now, AVAIL_STOP_S):
            return f"guest MemAvailable under {AVAIL_STOP_MB} MB for {AVAIL_STOP_S // 60} min"
        if swap_mb > SWAP_STOP_MB:
            return f"swap used {swap_mb} MB, over {SWAP_STOP_MB} MB"
        if self._held(
            "psi",
            psi_full is not None and psi_full >= PSI_FULL_STOP,
            now,
            PSI_FULL_STOP_S,
        ):
            return f"memory PSI full avg60 >= {PSI_FULL_STOP:g}% for {PSI_FULL_STOP_S // 60} min"
        if not any(r["t"] >= now - SILENT_S for r in win_lines):
            return f"no minute-log line in the last {SILENT_S // 60} min, so the Windows rule cannot see"
        recent = [
            r.get("win_avail_mb")
            for r in win_lines
            if now - (WIN_STOP_LINES + 1) * 60 <= r["t"] <= now
        ]
        last = recent[-WIN_STOP_LINES:]
        if len(last) == WIN_STOP_LINES and all(
            w is not None and w < WIN_STOP_MB for w in last
        ):
            return f"Windows available under {WIN_STOP_MB} MB for {WIN_STOP_LINES} minute lines"
        return None

    def reset(self):
        self.since.clear()


def live_reading(p, now, kills_since):
    avail, swap = read_meminfo()
    return {
        "avail_mb": avail,
        "swap_mb": swap,
        "psi_full": read_psi_full_avg60(),
        "win_lines": minute_log(
            p["minute_log"], now - WIN_READ_S, math.inf, WIN_TAIL_BYTES
        ),
        "kills": earlyoom_kills(kills_since),
    }


# ---- run ------------------------------------------------------------------


def refusal(sched, events, now):
    """Why `run` must not start, or None: a trial already over, or a schedule
    drawn so long ago that its half-size pair 0 has passed unrun."""
    ends = [e["why"] for e in events if e.get("event") == "end"]
    final = [w for w in ends if any(w.startswith(f) or w.endswith(f) for f in FINAL)]
    if final:
        return f"the trial ended ({final[-1]}); draw a new schedule to run again"
    started = any(e.get("event") == "block" for e in events)
    if not started and now >= block_span(sched, sched["blocks"][0])[0] + WASHOUT_S:
        return "the schedule's pair 0 has passed unrun; move it aside and draw again"
    return None


def run(
    p,
    *,
    now=time.time,
    sleep=time.sleep,
    reading=None,
    holder=None,
    usable=None,
    target=USABLE_PAIRS,
):
    """Walk the schedule from now. Returns the reason it ended."""
    sched = load_schedule(p)
    past = _events(p)
    refused = refusal(sched, past, now())
    if refused:
        return f"refused: {refused}"
    holder = holder or Holder(p)
    stops = Stops()
    reading = reading or (lambda t, since: live_reading(p, t, since))
    usable = usable or (lambda pair: pair_usable(p, sched, pair))
    # Resume-safe: a restarted run counts the pairs its last life logged.
    count = sum(bool(e.get("usable")) for e in past if e.get("event") == "pair")
    guard_until = 0.0  # the end of the washout after the last hold
    hold_began = None

    def term(*_):
        raise SystemExit("terminated")

    def check():
        t = now()
        if holder.proc is None and t >= guard_until:
            stops.reset()
            return None
        return stops.check(t, **reading(t, hold_began or t))

    def wait_until(t):
        while now() < t:
            sleep(min(TICK_S, t - now()))
            stop = check()
            if stop:
                return stop
        return None

    signal.signal(signal.SIGTERM, term)
    _log(p, now(), event="start", hold_mb=sched["hold_mb"])
    why = "schedule complete"
    try:
        for b in sched["blocks"]:
            start, end = block_span(sched, b)
            if now() >= end:
                continue
            stop = wait_until(start)
            if stop:
                why = stop
                return why
            if b["arm"] == HOLD:
                hold_began = now()
                try:
                    holder.start(b["mb"])
                except HolderNotReadyError as e:
                    # A fill stuck behind reclaim is the harm a stop rule ends on (#4862).
                    why = str(e)
                    return why
            _log(p, now(), event="block", i=b["i"], arm=b["arm"], mb=b["mb"])
            stop = wait_until(end)
            if b["arm"] == HOLD:
                holder.stop()
                guard_until = end + WASHOUT_S
            if stop:
                why = stop
                return why
            if b["i"] % 2 == 1:
                ok = usable(b["pair"])
                count += ok
                _log(p, now(), event="pair", pair=b["pair"], usable=ok, count=count)
                if count >= target:
                    why = f"{count} usable pairs"
                    return why
        return why
    except BaseException as e:
        why = f"{type(e).__name__}: {e}"
        raise
    finally:
        holder.stop()
        _log(p, now(), event="end", why=why)


# ---- readout --------------------------------------------------------------


def loop_ticks(p, since, until):
    return [
        epoch(r["at"])
        for r in read_jsonl(p["concurrency"])
        if "at" in r and since <= epoch(r["at"]) < until
    ]


def blocks_read(sched, events, *, minute_rows, mem, ticks, close_ts, until):
    """One row per block that ended by `until`, begun by a runner inside its
    washout and not ended before the block did, read past its washout."""
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
        bash = [x for m in mins for x in m["bash"]]
        in_block = [r for r in mem if lo <= r["t"] < hi]
        cpu_s = sum((r.get("cpu_busy_pct") or 0) / 100 * 60 for r in in_block)
        active = median([m["active"] for m in mins]) if mins else 0
        rows.append(
            {
                **b,
                "bash_p50": median(bash),
                "hto_min": sum(m["hto"] for m in mins) / READ_MIN,
                "cpu_per_call": cpu_s / len(bash) if bash else None,
                "closes_h": sum(lo <= t < hi for t in close_ts) * 60 / READ_MIN,
                "win_floor_min": sum(
                    r.get("win_avail_mb") is not None
                    and r["win_avail_mb"] < WINDOWS_FLOOR_MB
                    for r in in_block
                ),
                "ticked": any(lo <= t < hi for t in ticks),
                "usable": any(lo <= t < hi for t in ticks)
                and (active or 0) >= MIN_ACTIVE
                and len(bash) >= MIN_BASH,
            }
        )
    return rows


def usable_pairs(rows):
    """{pair: {arm: row}} for each read pair whose two blocks are both usable."""
    by_pair = {}
    for r in rows:
        if r["pair"] not in UNREAD_PAIRS:
            by_pair.setdefault(r["pair"], {})[r["arm"]] = r
    return {
        k: v
        for k, v in by_pair.items()
        if len(v) == 2 and all(r["usable"] for r in v.values())
    }


# The companions: label, key. Each is read as a within-pair hold − none
# difference beside the decision; none spends alpha.
COMPANIONS = (
    ("Hook-timeout refusals / min", "hto_min"),
    ("Machine CPU-s per Bash call", "cpu_per_call"),
    ("Closes / h (guardrail)", "closes_h"),
    (
        f"Minutes Windows under its {WINDOWS_FLOOR_MB} MB launch floor (balance)",
        "win_floor_min",
    ),
)


def _fmt(x, f="{:.3f}"):
    return "–" if x is None else f.format(x)


def verdict(p, mean, lo, hi):
    if p is None:
        return "no reading — no usable pair"
    if p < ALPHA and mean > 0:
        side = "beyond" if lo > math.log(BREAK_EVEN) else "not clearly beyond"
        return f"the hold slows Bash round-trip ({side} the {BREAK_EVEN - 1:.0%} break-even)"
    if p < ALPHA:
        return "the hold speeds Bash round-trip"
    if hi is not None and hi < math.log(BREAK_EVEN):
        return f"no slowdown detected at p < {ALPHA}, and the interval rules out the {BREAK_EVEN - 1:.0%} break-even"
    return f"inconclusive: no slowdown detected at p < {ALPHA}, but the interval reaches the {BREAK_EVEN - 1:.0%} break-even"


def report(rows, end_why):
    pairs = usable_pairs(rows)
    logs = [
        math.log(pr[HOLD]["bash_p50"] / pr[NONE]["bash_p50"])
        for pr in pairs.values()
        if pr[HOLD]["bash_p50"] and pr[NONE]["bash_p50"]
    ]
    p = sign_flip_p(logs, two_sided=True)
    mean = statistics.fmean(logs) if logs else None
    half = (
        1.96 * statistics.stdev(logs) / math.sqrt(len(logs)) if len(logs) > 1 else None
    )
    lo, hi = (mean - half, mean + half) if half is not None else (None, None)
    arm = {a: [pr[a] for pr in pairs.values()] for a in (HOLD, NONE)}

    def med(a, k):
        return median([r[k] for r in arm[a] if r[k] is not None]) if arm[a] else None

    ratio = (
        f"× {math.exp(mean):.3f} [{math.exp(lo):.3f}, {math.exp(hi):.3f}]"
        if half is not None
        else "–"
    )
    out = [
        "| Measure | Hold arm | No-hold arm | Within-pair hold − none | p (two-sided) |",
        "|---|---|---|---|---|",
        f"| Bash median round-trip, s (decision) | {_fmt(med(HOLD, 'bash_p50'))} | {_fmt(med(NONE, 'bash_p50'))} | {ratio} | {_fmt(p)} |",
    ]
    for label, key in COMPANIONS:
        diffs = [
            pr[HOLD][key] - pr[NONE][key]
            for pr in pairs.values()
            if pr[HOLD][key] is not None and pr[NONE][key] is not None
        ]
        out.append(
            f"| {label} | {_fmt(med(HOLD, key))} | {_fmt(med(NONE, key))} | {_fmt(median(diffs) if diffs else None)} | |"
        )
    read = {r["pair"] for r in rows} - UNREAD_PAIRS
    out += [
        "",
        f"Ended: {end_why}. {len(pairs)} usable pairs of {len(read)} read; "
        f"each block read over its last {READ_MIN} minutes; ratio is the geometric mean with its 95% interval.",
    ]
    if rows and not any(r["ticked"] for r in rows):
        out.append(
            "No block saw a refill-loop tick in ~/.claude/concurrency.jsonl, so none was usable."
        )
    out.append(f"**Verdict: {verdict(p, mean, lo, hi)}.**")
    return "\n".join(out)


def read_rows(p, sched, until, *, since=None, with_closes=True):
    events = _events(p)
    since = sched["start"] if since is None else since
    tally = Counter()
    minute_rows = dense_minute.minutes(
        dense_minute.transcripts(since), since, until, tally
    )
    rows = blocks_read(
        sched,
        events,
        minute_rows=minute_rows,
        mem=minute_log(p["minute_log"], since, until),
        ticks=loop_ticks(p, since, until),
        close_ts=closes(since, until) if with_closes else [],
        until=until,
    )
    return rows, events, tally


def pair_usable(p, sched, pair):
    """Whether `pair`, just ended, counts: read over its own half hour alone,
    so the check costs one pair's transcripts, not the whole run's."""
    blocks = [b for b in sched["blocks"] if b["pair"] == pair]
    since, _ = block_span(sched, blocks[0])
    _, until = block_span(sched, blocks[-1])
    rows, _, _ = read_rows(
        p, {**sched, "blocks": blocks}, until, since=since, with_closes=False
    )
    return pair in usable_pairs(rows)


def readout(p):
    sched = load_schedule(p)
    rows, events, tally = read_rows(p, sched, time.time())
    last = events[-1] if events else {}
    end_why = last["why"] if last.get("event") == "end" else "still running"
    return f"Hold: {sched['hold_mb']} MB.\n\n{report(rows, end_why)}\n\nTranscripts skipped: {dense_minute.counts_line(tally)}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--home", default=os.path.expanduser("~"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("draw")
    sub.add_parser("run")
    sub.add_parser("hold").add_argument("mb", type=int)
    sub.add_parser("readout")
    a = ap.parse_args(argv)
    p = paths(a.home)
    if a.cmd == "draw":
        for k in ("schedule", "events", "hold"):
            if os.path.exists(p[k]):
                sys.exit(f"draw: {p[k]} already exists; move it aside first")
        mb = launch_charge_mb(read_jsonl(p["concurrency"]))
        if not mb or mb <= 0:
            sys.exit(f"draw: no launch charge in {p['concurrency']}")
        os.makedirs(os.path.dirname(p["schedule"]), exist_ok=True)
        start = math.ceil(time.time() / 60) * 60
        with open(p["schedule"], "w") as f:
            json.dump(draw(start, mb), f, indent=1)
        print(
            f"draw: {SCHEDULE_H} h of paired blocks from {_iso(start)}, hold {mb} MB -> {p['schedule']}"
        )
    elif a.cmd == "run":
        why = run(p)
        print(f"run: ended — {why}")
        if why.startswith("refused"):
            sys.exit(1)
    elif a.cmd == "hold":
        hold(a.mb)
    else:
        print(readout(p))


if __name__ == "__main__":
    main()
