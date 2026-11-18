#!/usr/bin/env python3
"""fault_bench.py — workflow-core#3246's page-fault bench, run by a user timer at 28 h uptime (workflow-core#4768).

workflow-core#3246 needs the bench at 28 h up, and a session must happen to read its gate
while the boot is that old. fault-bench.timer runs it instead, and the log
outlives the boot.

  run      run by fault-bench.service. Once this boot has a bench line, does
           nothing. Otherwise, at 28 h up and 1,900 MB available, runs 1, 2, 4,
           8 and 8 concurrent 100 MB allocations and appends their times; short
           of either, appends a `NO BENCH` line, and the timer retries.
  install  installs it as a user timer (lib/user_timer.py). Re-run it to take
           up a change to this script or lib/memwatch_minute.py. No sudo.
             python3 scripts/fault_bench.py install

Each line carries the boot's start (`uptime -s`), its uptime, `.wslconfig`'s
autoMemoryReclaim, the guest's MemAvailable and Windows' free memory off
memwatch's newest minute line. workflow-core#3246 gates on a line reading `reclaim disabled`.

Exit codes: 0; 1 where a read, write or systemctl call fails; 2 on a command line.
"""

import argparse
import glob
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
# lib/ beside the checkout's copy and the installed one alike (lib/user_timer.py).
sys.path.insert(0, str(HERE / "lib"))
import memwatch_minute  # noqa: E402
from memwatch_minute import MINUTE_LOG  # noqa: E402

# workflow-core#3246's bench: 28 h, at which the `gradual` bench read 37.9 s, and 1,900 MB,
# earlyoom's 794 + the bench's 800 + a 300 margin.
MIN_UPTIME_S = 100_800
MIN_AVAIL_MB = 1_900
# workflow-core#3246's bench shape: rounds of concurrent 100 MB allocations.
ROUNDS = (1, 2, 4, 8, 8)
ALLOC = "b=bytearray(100*1024*1024)"
NO_BENCH = "NO BENCH"

UNIT = "fault-bench"
LOG = Path.home() / "fault-bench.log"
UPTIME = "/proc/uptime"
MEMINFO = "/proc/meminfo"
BOOT_ID = "/proc/sys/kernel/random/boot_id"
WSLCONFIGS = "/mnt/c/Users/*/.wslconfig"


def read_uptime_s(path=UPTIME):
    return float(Path(path).read_text().split()[0])


def read_avail_mb(path=MEMINFO):
    for raw in Path(path).read_text().splitlines():
        if raw.startswith("MemAvailable:"):
            return int(raw.split()[1]) // 1024
    raise OSError(f"no MemAvailable in {path}")


def read_boot_id(path=BOOT_ID):
    return Path(path).read_text().strip()[:8]


def reclaim_mode(pattern=WSLCONFIGS):
    """`.wslconfig`'s autoMemoryReclaim, `unread` where no one file names it.
    The file as it reads now: a change takes at the next boot, not this one."""
    modes = set()
    for path in glob.glob(pattern):
        for raw in Path(path).read_text(errors="replace").splitlines():
            key, _, value = raw.partition("=")
            if key.strip().lower() == "automemoryreclaim":
                modes.add(value.strip())
    return modes.pop() if len(modes) == 1 else "unread"


def windows_reading(minute_log, now):
    """`Windows N MB (S s old)` off memwatch's newest whole minute line."""
    try:
        sample = memwatch_minute.win_sample(memwatch_minute.newest_line(minute_log))
    except OSError:
        # No memwatch, so no Windows figure; the bench still stands (workflow-core#4768).
        return "Windows unread"
    if not sample:
        return "Windows unread"
    return f"Windows {sample.avail_mb:,} MB ({round(now - sample.taken_at)} s old)"


def bench(python):
    """Each round's wall time in ms: n allocations started at once, all awaited."""
    out = []
    for n in ROUNDS:
        start = time.monotonic_ns()
        procs = [subprocess.Popen([python, "-I", "-c", ALLOC]) for _ in range(n)]
        failed = sum(p.wait() != 0 for p in procs)
        ms = (time.monotonic_ns() - start) // 1_000_000
        # A killed allocation's time understates the round, so it is named (workflow-core#4768).
        out.append(f"{n} x 100 MB: {ms} ms" + (f" ({failed} failed)" if failed else ""))
    return out


def benched_this_boot(log, boot_id):
    try:
        lines = Path(log).read_text().splitlines()
    except FileNotFoundError:
        # No log yet, so no bench this boot (workflow-core#4768).
        return False
    tag = f" boot {boot_id} "
    return any(tag in line and NO_BENCH not in line for line in lines)


def run(
    log,
    minute_log,
    *,
    uptime=UPTIME,
    meminfo=MEMINFO,
    boot_id=BOOT_ID,
    wslconfigs=WSLCONFIGS,
    python=sys.executable,
):
    """One timer firing. Returns the line it appended, or None."""
    boot = read_boot_id(boot_id)
    if benched_this_boot(log, boot):
        return None
    up = read_uptime_s(uptime)
    avail = read_avail_mb(meminfo)
    now = time.time()
    started = (
        datetime.fromtimestamp(now - up).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    )
    head = (
        f"{memwatch_minute.format_ts(now)}"
        f" boot {boot} up since {started} ({up / 3600:.1f} h),"
        f" reclaim {reclaim_mode(wslconfigs)},"
        f" MemAvailable {avail:,} MB, {windows_reading(minute_log, now)}"
    )
    if up < MIN_UPTIME_S or avail < MIN_AVAIL_MB:
        line = f"{head}: {NO_BENCH}: needs 28 h up and {MIN_AVAIL_MB:,} MB available"
    else:
        line = f"{head}: {', '.join(bench(python))}"
    with open(log, "a") as f:
        f.write(line + "\n")
    return line


def main(argv=None):
    parser = argparse.ArgumentParser(prog="fault_bench.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--log", default=str(LOG))
    r.add_argument("--minute-log", default=str(MINUTE_LOG))
    sub.add_parser("install")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "run":
            line = run(args.log, args.minute_log)
            if line:
                print(line)
            return 0
        # Imported here: the installed copy runs `run` alone.
        import user_timer

        return user_timer.install(
            HERE / "fault_bench.py",
            UNIT,
            {"LOG": LOG, "MINUTE_LOG": MINUTE_LOG, "BOOT_SEC": f"{MIN_UPTIME_S}s"},
        )
    except OSError as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
