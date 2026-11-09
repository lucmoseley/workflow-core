#!/usr/bin/env python3
"""fault_bench.py — #3246's page-fault bench, run by a user timer at 28 h uptime (#4768).

#3246 needs the bench at 28 h up, and a session must happen to read its gate
while the boot is that old. fault-bench.timer runs it instead, and the log
outlives the boot.

  run      run by fault-bench.service. Once this boot has a bench line, does
           nothing. Otherwise, at 28 h up and 1,900 MB available, runs 1, 2, 4,
           8 and 8 concurrent 100 MB allocations and appends their times; short
           of either, appends a `NO BENCH` line, and the timer retries.
  install  copies this script to INSTALLED, so removing a worktree leaves the
           unit whole; writes the service and timer to the user's systemd dir
           from the templates beside it; enables the timer. Re-run it to take
           up a change to this script. No sudo.
             python3 scripts/fault_bench.py install
           WFC_SYSTEMCTL names the systemctl to call.

Each line carries the boot's start (`uptime -s`), its uptime, `.wslconfig`'s
autoMemoryReclaim, the guest's MemAvailable and Windows' free memory off
memwatch's newest minute line. #3246 gates on a line reading `reclaim disabled`.

Exit codes: 0; 1 where a read, write or systemctl call fails; 2 on a command line.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# #3246's bench: 28 h, at which the `gradual` bench read 37.9 s, and 1,900 MB,
# earlyoom's 794 + the bench's 800 + a 300 margin.
MIN_UPTIME_S = 100_800
MIN_AVAIL_MB = 1_900
# #3246's bench shape: rounds of concurrent 100 MB allocations.
ROUNDS = (1, 2, 4, 8, 8)
ALLOC = "b=bytearray(100*1024*1024)"
NO_BENCH = "NO BENCH"
# Read from the minute log's end: a line is ~800 bytes, so this holds several
# whole lines, a torn last one included.
TAIL_BYTES = 16384

UNIT = "fault-bench"
HERE = Path(__file__).resolve().parent
HOME = Path.home()
INSTALLED = HOME / ".local/lib/workflow-core/fault_bench.py"
LOG = HOME / "fault-bench.log"
MINUTE_LOG = HOME / "memwatch-minute.jsonl"
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
        with open(minute_log, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            lines = f.read().splitlines()
    except OSError:
        # No memwatch, so no Windows figure; the bench still stands (#4768).
        return "Windows unread"
    for raw in reversed(lines):
        try:
            line = json.loads(raw)
        except ValueError:
            # A line memwatch is still writing; the one before it stands (#4768).
            continue
        avail, age, ts = line.get("win_avail_mb"), line.get("win_age_s"), line.get("ts")
        if not isinstance(avail, int) or not isinstance(age, int) or not ts:
            return "Windows unread"
        try:
            taken = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S%z").timestamp() - age
        except ValueError:
            # An unreadable timestamp is no Windows figure; the bench still stands (#4768).
            return "Windows unread"
        return f"Windows {avail:,} MB ({round(now - taken)} s old)"
    return "Windows unread"


def bench(python):
    """Each round's wall time in ms: n allocations started at once, all awaited."""
    out = []
    for n in ROUNDS:
        start = time.monotonic_ns()
        procs = [subprocess.Popen([python, "-I", "-c", ALLOC]) for _ in range(n)]
        failed = sum(p.wait() != 0 for p in procs)
        ms = (time.monotonic_ns() - start) // 1_000_000
        # A killed allocation's time understates the round, so it is named (#4768).
        out.append(f"{n} x 100 MB: {ms} ms" + (f" ({failed} failed)" if failed else ""))
    return out


def benched_this_boot(log, boot_id):
    try:
        lines = Path(log).read_text().splitlines()
    except FileNotFoundError:
        # No log yet, so no bench this boot (#4768).
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
        f"{datetime.fromtimestamp(now).astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')}"
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


def render(template, script, log, minute_log):
    return (
        template.replace("@SCRIPT@", str(script))
        .replace("@LOG@", str(log))
        .replace("@MINUTE_LOG@", str(minute_log))
        .replace("@BOOT_SEC@", f"{MIN_UPTIME_S}s")
    )


def install(script, units, log, minute_log):
    sys.path.insert(0, str(HERE / "lib"))
    from wfc_bin import bin_path

    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_bytes((HERE / "fault_bench.py").read_bytes())
    print(script)
    units.mkdir(parents=True, exist_ok=True)
    for suffix in ("service", "timer"):
        template = (HERE / f"{UNIT}.{suffix}.template").read_text()
        out = units / f"{UNIT}.{suffix}"
        out.write_text(render(template, script, log, minute_log))
        print(out)
    systemctl = bin_path("systemctl")
    for args in (
        ["--user", "daemon-reload"],
        ["--user", "enable", "--now", f"{UNIT}.timer"],
    ):
        done = subprocess.run([systemctl, *args], capture_output=True, text=True)
        if done.returncode != 0:
            print(
                f"systemctl {' '.join(args)}: {done.stderr.strip()}; re-run: python3 scripts/fault_bench.py install",
                file=sys.stderr,
            )
            return 1
    state = subprocess.run(
        [systemctl, "--user", "is-active", f"{UNIT}.timer"],
        capture_output=True,
        text=True,
    ).stdout.strip()
    print(f"{UNIT}.timer: {state}")
    return 0 if state == "active" else 1


def user_units():
    config = os.environ.get("XDG_CONFIG_HOME") or str(HOME / ".config")
    return Path(config) / "systemd/user"


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
        return install(INSTALLED, user_units(), LOG, MINUTE_LOG)
    except OSError as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
