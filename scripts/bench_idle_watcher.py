#!/usr/bin/env python3
import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from bench_suite_concurrency import (
    REPO,
    Watchdog,
    default_floor_mb,
    meminfo,
    mem_available_mb,
    swap_used_mb,
    sample,
)
from fail_open import expected, fail_open

# #5652
NODE_HEAP = "--max-old-space-size=2048"
WAITING = "Waiting for file changes"
# guess: 5 Hz catches a re-run's worker spawn, which lives for seconds, #5652
SAMPLE_S = 0.2
# guess: a resting watcher changes over tens of seconds, not within one, #5652
REST_SAMPLE_S = 1.0
# #2667
FIRST_RUN_MAX_S = 840
# guess: vitest closes on SIGTERM within a second when idle, #5652
CLOSE_GRACE_S = 10


class Watcher:
    def __init__(self, watch_files, standalone, log_path):
        cmd = ["node_modules/.bin/vitest", "--watch"]
        if standalone:
            cmd.append("--standalone")
        cmd.extend(watch_files)
        self.log = open(log_path, "w")
        self.proc = subprocess.Popen(
            cmd,
            cwd=REPO,
            env={**os.environ, "NODE_OPTIONS": NODE_HEAP},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        self._seen = {}
        self.waits = 0
        self.lines = 0
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.log.write(line)
            self.log.flush()
            with self.lock:
                self.lines += 1
                if WAITING in line:
                    self.waits += 1

    def rss_mb(self):
        return sample([self.proc.pid], self._seen)[1:]

    def counts(self):
        with self.lock:
            return self.waits, self.lines

    def close(self):
        close_group(self.proc, CLOSE_GRACE_S)
        self.log.close()


def close_group(proc, grace_s):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=grace_s)
    except subprocess.TimeoutExpired as e:
        fail_open(e, "SIGKILL the watcher's group")
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    except ProcessLookupError as e:
        expected(e, "the watcher's group already exited")
        proc.wait()


def resting_rss(read, seconds, clock=time.monotonic, sleep=time.sleep):
    readings = []
    end = clock() + seconds
    while clock() < end:
        readings.append(read())
        sleep(REST_SAMPLE_S)
    rss = [r for r, _ in readings]
    return {
        "rss_mean_mb": round(sum(rss) / len(rss), 1),
        "rss_max_mb": round(max(rss), 1),
        "pids": max(n for _, n in readings),
    }


def run_beside(watcher, other_files, watchdog):
    start_avail = mem_available_mb()
    start_swap = swap_used_mb()
    waits_before, lines_before = watcher.counts()
    other = subprocess.Popen(
        ["node", "scripts/run-vitest.js", *other_files],
        cwd=REPO,
        env={**os.environ, "NODE_OPTIONS": NODE_HEAP, "WFC_TEST_STALL_MS": "0"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    watchdog.arm([watcher.proc.pid, other.pid])
    peak_rss, peak_pids = 0.0, 0
    started = time.monotonic()
    while other.poll() is None:
        rss, npids = watcher.rss_mb()
        peak_rss = max(peak_rss, rss)
        peak_pids = max(peak_pids, npids)
        time.sleep(SAMPLE_S)
    stop_if_tripped(watchdog, "beside the other run")
    trough = watchdog.min_avail if watchdog.min_avail is not None else start_avail
    waits_after, lines_after = watcher.counts()
    return {
        "other_exit": other.returncode,
        "other_s": round(time.monotonic() - started, 1),
        "watcher_peak_rss_mb": round(peak_rss, 1),
        "watcher_peak_pids": peak_pids,
        "rest_avail_mb": round(start_avail),
        "dip_mb": round(start_avail - trough),
        "swap_delta_mb": round(swap_used_mb() - start_swap),
        "watcher_reran": waits_after > waits_before,
        "watcher_lines_during": lines_after - lines_before,
    }


def stop_if_tripped(watchdog, phase):
    if watchdog.tripped_at is not None:
        raise SystemExit(f"watchdog tripped at {watchdog.tripped_at} MB {phase}")


def first_run(watcher, watchdog):
    opened = time.monotonic()
    peak = 0.0
    while watcher.counts()[0] == 0:
        stop_if_tripped(watchdog, "in the first run")
        if watcher.proc.poll() is not None:
            raise SystemExit(f"watcher exited {watcher.proc.returncode} before idling")
        if time.monotonic() - opened > FIRST_RUN_MAX_S:
            raise SystemExit("watcher never printed its idle line")
        peak = max(peak, watcher.rss_mb()[0])
        time.sleep(SAMPLE_S)
    return round(time.monotonic() - opened, 1), round(peak, 1)


def bench_row(args, n, watchdog):
    log = os.path.join(args.out, f"watcher-{n}.log")
    watcher = Watcher(args.watch, args.standalone, log)
    watchdog.arm([watcher.proc.pid])
    watchdog.start()
    try:
        first_s, first_peak = first_run(watcher, watchdog)
        result = {
            "row": n,
            "watch": "standalone"
            if args.standalone
            else (f"{len(args.watch)} files" if args.watch else "whole"),
            "first_run_s": first_s,
            "first_run_peak_rss_mb": first_peak,
            "rest_before": resting_rss(watcher.rss_mb, args.rest),
        }
        stop_if_tripped(watchdog, "at rest")
        result.update(run_beside(watcher, args.other, watchdog))
        watchdog.arm([watcher.proc.pid])
        result["rest_after"] = resting_rss(watcher.rss_mb, args.rest)
        stop_if_tripped(watchdog, "at rest")
        return result
    finally:
        watchdog.disarm()
        watcher.close()


def main(argv):
    p = argparse.ArgumentParser(
        description="Hold a vitest watcher open through another suite's run."
    )
    # guess: two rows show whether a figure repeats, #5652
    p.add_argument("--rows", type=int, default=2)
    # guess: long enough for vitest to reap an idle worker pool, #5652
    p.add_argument("--rest", type=int, default=30)
    p.add_argument(
        "--standalone", action="store_true", help="open the watcher with no first run"
    )
    p.add_argument(
        "--watch",
        nargs="*",
        default=[],
        help="the watcher's files; none is the whole suite",
    )
    p.add_argument(
        "--other",
        nargs="+",
        required=True,
        help="files run through scripts/run-vitest.js beside the idle watcher",
    )
    p.add_argument(
        "--out", default=os.path.join(REPO, ".claude", "tmp", "bench-idle-watcher")
    )
    args = p.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    watchdog = Watchdog(default_floor_mb(meminfo()["MemTotal"] / 1024))
    rows = []
    for n in range(1, args.rows + 1):
        r = bench_row(args, n, watchdog)
        print(json.dumps(r), flush=True)
        rows.append(r)
    with open(os.path.join(args.out, f"rows-{int(time.time())}.json"), "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
