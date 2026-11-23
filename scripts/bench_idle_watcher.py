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
    EARLYOOM_PCT,
    DEFAULT_FLOOR_MARGIN_MB,
    REPO,
    children_map,
    meminfo,
    mem_available_mb,
    proc_stats,
    swap_used_mb,
    tree,
)
from fail_open import expected, fail_open

WAITING = "Waiting for file changes"
# guess: 5 Hz catches a re-run's worker spawn, which lives for seconds, #5652
SAMPLE_S = 0.2
# #2667
FIRST_RUN_MAX_S = 840


def volunteer(pid):
    try:
        with open(f"/proc/{pid}/oom_score_adj", "w") as f:
            f.write("1000")
    except (FileNotFoundError, ProcessLookupError, PermissionError) as e:
        expected(e, f"pid {pid} exited, or is not ours to rank")


def floor_mb():
    return meminfo()["MemTotal"] / 1024 * EARLYOOM_PCT / 100 + DEFAULT_FLOOR_MARGIN_MB


def tree_rss_mb(root):
    kids = children_map()
    rss, npids = 0, 0
    for pid in tree(root, kids):
        st = proc_stats(pid)
        if st:
            volunteer(pid)
            rss += st[1]
            npids += 1
    return rss / 1e6, npids


class Watcher:
    def __init__(self, watch_files, standalone, log_path):
        cmd = ["node_modules/.bin/vitest", "--watch"]
        if standalone:
            cmd.append("--standalone")
        cmd.extend(watch_files)
        env = {**os.environ, "NODE_OPTIONS": "--max-old-space-size=2048"}
        self.log = open(log_path, "w")
        self.proc = subprocess.Popen(
            cmd,
            cwd=REPO,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
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

    def counts(self):
        with self.lock:
            return self.waits, self.lines

    def close(self):
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired as e:
            fail_open(e, "SIGKILL the watcher's group")
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()
        except ProcessLookupError as e:
            expected(e, "the watcher's group already exited")
        self.log.close()


def rest(watcher, seconds):
    readings = []
    end = time.time() + seconds
    while time.time() < end:
        readings.append(tree_rss_mb(watcher.proc.pid))
        time.sleep(1)
    rss = [r for r, _ in readings]
    return {
        "rss_mean_mb": round(sum(rss) / len(rss), 1),
        "rss_max_mb": round(max(rss), 1),
        "pids": max(n for _, n in readings),
    }


def run_other(watcher, other_files, floor):
    env = {
        **os.environ,
        "NODE_OPTIONS": "--max-old-space-size=2048",
        "WFC_TEST_STALL_MS": "0",
    }
    start_avail = mem_available_mb()
    start_swap = swap_used_mb()
    waits_before, lines_before = watcher.counts()
    other = subprocess.Popen(
        ["node", "scripts/run-vitest.js", *other_files],
        cwd=REPO,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    peak_rss, peak_pids, trough = 0.0, 0, start_avail
    started = time.time()
    while other.poll() is None:
        rss, npids = tree_rss_mb(watcher.proc.pid)
        peak_rss = max(peak_rss, rss)
        peak_pids = max(peak_pids, npids)
        avail = mem_available_mb()
        trough = min(trough, avail)
        if avail < floor:
            os.killpg(other.pid, signal.SIGKILL)
            watcher.close()
            raise SystemExit(
                f"MemAvailable {avail:.0f} MB under the {floor:.0f} MB floor: killed both"
            )
        time.sleep(SAMPLE_S)
    waits_after, lines_after = watcher.counts()
    return {
        "other_exit": other.returncode,
        "other_s": round(time.time() - started, 1),
        "watcher_peak_rss_mb": round(peak_rss, 1),
        "watcher_peak_pids": peak_pids,
        "rest_avail_mb": round(start_avail),
        "dip_mb": round(start_avail - trough),
        "swap_delta_mb": round(swap_used_mb() - start_swap),
        "watcher_reran": waits_after > waits_before,
        "watcher_lines_during": lines_after - lines_before,
    }


def row(args, n, out_dir):
    floor = floor_mb()
    watcher = Watcher(
        args.watch, args.standalone, os.path.join(out_dir, f"watcher-{n}.log")
    )
    try:
        opened = time.time()
        first_peak = 0.0
        while watcher.counts()[0] == 0:
            if watcher.proc.poll() is not None:
                raise SystemExit(
                    f"watcher exited {watcher.proc.returncode} before idling"
                )
            if time.time() - opened > FIRST_RUN_MAX_S:
                raise SystemExit("watcher never printed its idle line")
            first_peak = max(first_peak, tree_rss_mb(watcher.proc.pid)[0])
            if mem_available_mb() < floor:
                raise SystemExit(
                    "MemAvailable under the floor during the watcher's first run"
                )
            time.sleep(SAMPLE_S)
        result = {
            "row": n,
            "watch": "standalone"
            if args.standalone
            else (f"{len(args.watch)} files" if args.watch else "whole"),
            "first_run_s": round(time.time() - opened, 1),
            "first_run_peak_rss_mb": round(first_peak, 1),
            "rest_before": rest(watcher, args.rest),
        }
        result.update(run_other(watcher, args.other, floor))
        result["rest_after"] = rest(watcher, args.rest)
        return result
    finally:
        watcher.close()


def main(argv):
    p = argparse.ArgumentParser(
        description="Hold a vitest watcher open through another suite's run."
    )
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
    rows = []
    for n in range(1, args.rows + 1):
        r = row(args, n, args.out)
        print(json.dumps(r), flush=True)
        rows.append(r)
    with open(os.path.join(args.out, f"rows-{int(time.time())}.json"), "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
