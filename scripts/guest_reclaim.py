#!/usr/bin/env python3
"""guest_reclaim.py — reclaim cold guest page cache when Windows runs short (#4791).

With `autoMemoryReclaim=disabled` (#3246) the guest's page cache stays backed in
`vmmemWSL`, and WSL's own reclaim runs only on a near-idle VM. This writes
`<bytes> swappiness=0` to the user manager's cgroup `memory.reclaim`, which
evicts cold page cache first; page reporting hands the freed pages to Windows.

  tick     run each minute by guest-reclaim.timer. Reads the newest line of
           memwatch's minute log; when its Windows sample is fresh, reads
           under TRIGGER_MB and was taken after the last pass's pages reached
           Windows, runs a pass: STEP_BYTES writes until the deficit
           (TRIGGER_MB less the reading) is reclaimed, a write returns EAGAIN,
           or the cgroup's memory stall or file refaults rise over their rate
           just before the pass. Logs a `pass` record; once a later minute line
           carries a Windows sample taken after that pass, logs its `after`
           record.
  report   the share of minute lines whose Windows reading is under
           TRIGGER_MB, and their mean guest memory stall, over a window.
  install  installs it as a user timer (lib/user_timer.py). Re-run it to take
           up a change to this script or lib/memwatch_minute.py.
             python3 scripts/guest_reclaim.py install

Exit codes: 0; 1 where a read, write or systemctl call fails; 2 on a command line.
"""

import argparse
import errno
import json
import os
import sys
import time
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent
# lib/ beside the checkout's copy and the installed one alike (lib/user_timer.py).
sys.path.insert(0, str(HERE / "lib"))
from memwatch_minute import (  # noqa: E402
    MINUTE_LOG,
    format_ts,
    json_lines,
    newest_line,
    parse_ts,
    win_sample,
)

MIB = 1 << 20
# Guesses until a day of passes is read (#4791). The trigger sits at or above
# the Windows hold's largest need (1,768–1,938 MB, #4759), so the hold never
# waits on a reading this ignores.
TRIGGER_MB = 2000
STEP_BYTES = 256 * MIB
# The pass stops when, over one step, the cgroup's memory stall share of wall
# time rises this far over its share in the baseline second before the pass,
# or file refaults per second exceed REFAULT_RISE times the baseline's rate
# plus REFAULT_FLOOR_PER_S. Guesses until measured (#4791).
BASELINE_S = 1.0
STALL_RISE = 0.10
REFAULT_RISE = 2.0
REFAULT_FLOOR_PER_S = 1024
# Free page reporting hands freed pages to Windows this long after the free
# (`page_reporting_delay_ms`, mm/page_reporting.c).
REPORTING_DELAY_S = 2
# A Windows sample older than this is not acted on: memwatch samples Windows
# about once a minute (`win_age_s` reads ~65 s on a healthy log), so this
# allows one missed sample.
MAX_SAMPLE_AGE_S = 180
# A rate's shortest window: a clock that has not moved divides by this, not zero.
MIN_WINDOW_S = 1e-3

UNIT = "guest-reclaim"
LOG = Path.home() / "guest-reclaim.jsonl"
MEMINFO = "/proc/meminfo"


def user_cgroup():
    """The user manager's cgroup: every session's page cache is charged under it."""
    uid = os.getuid()
    return Path(f"/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service")


class Rates(NamedTuple):
    stall_share: float
    refaults_per_s: float


class Mark(NamedTuple):
    t: float
    stall_us: int
    refaults: int


class Cgroup:
    """The cgroup v2 files a pass reads and writes."""

    def __init__(self, path):
        self.path = Path(path)

    def reclaim(self, nbytes):
        """Raises OSError with EAGAIN when the kernel reclaimed less than asked."""
        (self.path / "memory.reclaim").write_text(f"{nbytes} swappiness=0")

    def stat(self, key):
        for raw in (self.path / "memory.stat").read_text().splitlines():
            name, _, value = raw.partition(" ")
            if name == key:
                return int(value)
        raise OSError(f"{self.path / 'memory.stat'}: no {key}")

    def stall_us(self):
        """`some` total: microseconds any task in the cgroup stalled on memory."""
        for raw in (self.path / "memory.pressure").read_text().splitlines():
            if raw.startswith("some "):
                return int(raw.rsplit("total=", 1)[1])
        raise OSError(f"{self.path / 'memory.pressure'}: no some line")

    def mark(self, clock):
        return Mark(clock(), self.stall_us(), self.stat("workingset_refault_file"))

    def rates_from(self, start, clock):
        """Stall share and refault rate from `start`, a mark, to now."""
        wall = max(clock() - start.t, MIN_WINDOW_S)
        return Rates(
            (self.stall_us() - start.stall_us) / 1e6 / wall,
            (self.stat("workingset_refault_file") - start.refaults) / wall,
        )


def read_records(path):
    try:
        return list(json_lines(Path(path).read_text().splitlines()))
    except FileNotFoundError:
        # No pass logged yet (#4791).
        return []


def append_record(path, record):
    with open(path, "a") as f:
        f.write(json.dumps(record) + "\n")


def mem_free_mb(meminfo):
    for raw in Path(meminfo).read_text().splitlines():
        if raw.startswith("MemFree:"):
            return int(raw.split()[1]) // 1024
    return None


def run_pass(cgroup, deficit_bytes, clock, sleep):
    """Reclaim up to `deficit_bytes` in steps. Returns the record's figures, the
    pass's length in seconds, and a write error other than EAGAIN, if one ended it."""
    began = clock()
    failure = None
    start = cgroup.mark(clock)
    sleep(BASELINE_S)
    base = cgroup.rates_from(start, clock)
    file_before = cgroup.stat("file")
    asked = 0
    stop = "met"
    while asked < deficit_bytes:
        step = min(STEP_BYTES, deficit_bytes - asked)
        start = cgroup.mark(clock)
        try:
            cgroup.reclaim(step)
        except OSError as err:
            asked += step
            if err.errno != errno.EAGAIN:
                # Logged with what earlier steps freed, then raised by tick (#4791).
                failure = err
                stop = errno.errorcode.get(err.errno, "error")
            else:
                stop = "eagain"
            break
        asked += step
        step_rates = cgroup.rates_from(start, clock)
        if step_rates.stall_share > base.stall_share + STALL_RISE:
            stop = "stall"
            break
        if (
            step_rates.refaults_per_s
            > REFAULT_RISE * base.refaults_per_s + REFAULT_FLOOR_PER_S
        ):
            stop = "refault"
            break
    figures = {
        "deficit_bytes": deficit_bytes,
        "asked_bytes": asked,
        "reclaimed_bytes": max(0, file_before - cgroup.stat("file")),
        "stop": stop,
        "base_stall_share": round(base.stall_share, 4),
        "base_refaults_per_s": round(base.refaults_per_s),
    }
    return figures, clock() - began, failure


def reading(line, sample):
    return {
        "line_ts": line["ts"],
        "win_avail_mb": sample.avail_mb,
        "mem_avail_mb": line.get("mem_avail_mb"),
    }


def tick(
    minute_log,
    pass_log,
    now,
    *,
    cgroup,
    meminfo=MEMINFO,
    clock=time.monotonic,
    sleep=time.sleep,
):
    """One timer firing. Returns what it logged: `pass`, `after`, both or neither."""
    try:
        line = newest_line(minute_log)
    except OSError as err:
        # No reading, so no pass; said, so a dead memwatch shows in the journal (#4791).
        print(f"no minute log: {err}", file=sys.stderr)
        return []
    sample = win_sample(line)
    records = read_records(pass_log)
    passes = [r for r in records if r.get("kind") == "pass"]
    afters = {r.get("pass") for r in records if r.get("kind") == "after"}
    last = passes[-1] if passes else None
    logged = []
    # A sample taken before the last pass's pages reached Windows still counts
    # what that pass freed.
    fresh = sample and (not last or sample.taken_at > parse_ts(last["ts"]))
    if last and last["ts"] not in afters and fresh:
        append_record(
            pass_log, {"kind": "after", "pass": last["ts"], **reading(line, sample)}
        )
        logged.append("after")
    if (
        not fresh
        or now - sample.taken_at > MAX_SAMPLE_AGE_S
        or sample.avail_mb >= TRIGGER_MB
    ):
        return logged
    figures, took_s, failure = run_pass(
        cgroup, (TRIGGER_MB - sample.avail_mb) * MIB, clock, sleep
    )
    append_record(
        pass_log,
        {
            "kind": "pass",
            "ts": format_ts(now + took_s + REPORTING_DELAY_S),
            **reading(line, sample),
            **figures,
            "mem_free_mb_after": mem_free_mb(meminfo),
        },
    )
    logged.append("pass")
    if failure:
        raise failure
    return logged


def report(minute_log, since_ts, until_ts):
    """Minutes with a Windows reading in [since_ts, until_ts): how many, the share
    under TRIGGER_MB, and the mean guest memory stall (`psi_mem_some`)."""
    total = under = 0
    psi = []
    with open(minute_log) as f:
        for line in json_lines(f):
            try:
                t = parse_ts(line.get("ts", ""))
            except ValueError:
                # A line with no readable time falls in no window (#4791).
                continue
            avail = line.get("win_avail_mb")
            if not since_ts <= t < until_ts or not isinstance(avail, int):
                continue
            total += 1
            under += avail < TRIGGER_MB
            if isinstance(line.get("psi_mem_some"), (int, float)):
                psi.append(line["psi_mem_some"])
    return {
        "minutes": total,
        "under_trigger_pct": round(100 * under / total, 1) if total else None,
        "psi_mem_some_mean": round(sum(psi) / len(psi), 2) if psi else None,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(prog="guest_reclaim.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tick")
    t.add_argument("--minute-log", default=str(MINUTE_LOG))
    t.add_argument("--log", default=str(LOG))
    t.add_argument("--cgroup", default=str(user_cgroup()))
    r = sub.add_parser("report")
    r.add_argument("--minute-log", default=str(MINUTE_LOG))
    r.add_argument(
        "--since",
        type=parse_ts,
        required=True,
        help="memwatch timestamp, e.g. 2026-11-10T19:00:00+0800",
    )
    r.add_argument("--until", type=parse_ts, help="memwatch timestamp; default now")
    sub.add_parser("install")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "tick":
            tick(args.minute_log, args.log, time.time(), cgroup=Cgroup(args.cgroup))
            return 0
        if args.cmd == "report":
            until = args.until or time.time()
            print(json.dumps(report(args.minute_log, args.since, until)))
            return 0
        # Imported here: the installed copy runs `tick` alone.
        import user_timer

        return user_timer.install(
            HERE / "guest_reclaim.py",
            UNIT,
            {"LOG": LOG, "MINUTE_LOG": MINUTE_LOG, "CGROUP": user_cgroup()},
        )
    except OSError as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
