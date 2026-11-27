#!/usr/bin/env python3
import argparse
import glob
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "lib"))
import memwatch_minute  # noqa: E402
from fail_open import expected, fail_open  # noqa: E402
from memwatch_minute import MINUTE_LOG  # noqa: E402

MIN_UPTIME_S = 100_800  # #3246 measured 3 of 3 gradual boots degraded past 28 h
MIN_AVAIL_MB = 1_900  # #3246 measured earlyoom 794 + bench 800, plus a 300 guess margin
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
    modes = set()
    for path in glob.glob(pattern):
        for raw in Path(path).read_text(errors="replace").splitlines():
            key, _, value = raw.partition("=")
            if key.strip().lower() == "automemoryreclaim":
                modes.add(value.strip())
    return modes.pop() if len(modes) == 1 else "unread"


def windows_reading(minute_log, now):
    try:
        sample = memwatch_minute.win_sample(memwatch_minute.newest_line(minute_log))
    except OSError as e:
        fail_open(e, "Windows figure read as unread")
        return "Windows unread"
    if not sample:
        return "Windows unread"
    return f"Windows {sample.avail_mb:,} MB ({round(now - sample.taken_at)} s old)"


def bench(python):
    out = []
    for n in ROUNDS:
        start = time.monotonic_ns()
        procs = [subprocess.Popen([python, "-I", "-c", ALLOC]) for _ in range(n)]
        failed = sum(p.wait() != 0 for p in procs)
        ms = (time.monotonic_ns() - start) // 1_000_000
        out.append(f"{n} x 100 MB: {ms} ms" + (f" ({failed} failed)" if failed else ""))
    return out


def benched_this_boot(log, boot_id):
    try:
        lines = Path(log).read_text().splitlines()
    except FileNotFoundError as e:
        expected(e, f"no {log} yet: no bench has run, this boot or any")
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
        # workflow-core#4791
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
