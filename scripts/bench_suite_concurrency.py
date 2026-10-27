#!/usr/bin/env python3
"""bench_suite_concurrency.py — measure the concurrent-test-suite cap (docs/environment.md).

Runs N concurrent whole suites at `--workers` each and reports wall time, CPU,
MemAvailable and swap, one JSON blob per configuration. The metric definitions match mantahostels#352 (the
previous re-measure of this cap), so runs stay comparable:

  * CPU comes from `wait4` rusage, never a `/proc` sampler — Vitest's forks are
    born and reaped between samples, so a sampler never observes them.
  * The memory figure is the *dip* in MemAvailable (20 s resting mean minus
    trough), never the absolute trough, which mostly measures how quiet the
    machine was, and never a sampled process-tree RSS peak.
  * Swap is reported as a delta across the run. `SwapUsed` is a system-wide
    monotone gauge, so its peak is not attributable to suite count.

A kill by `earlyoom` here costs a live session, not just the run, so:

  * A watchdog samples at 10 Hz and aborts the run before that line.
  * Suite processes set `oom_score_adj=1000`, re-applied across the tree each
    second, so a kill that happens anyway takes this benchmark first.

A row the watchdog aborted measures the machine's headroom, not the suites.
Read `cpu_valid`, `dip_is_lower_bound`, `trivially_aborted` and
`baseline_stationary` before quoting one.

A row is only a measurement of the SUITES if the baseline under it held still.
Read `baseline_stationary` before quoting a dip: where it is false, a neighbour
allocated inside the run window and the raw dip charges the suites for it.
`classify_baseline` lists what a stationary verdict misses. The quiet gate
`--require-quiet=<n>` refuses to start on a busier machine.

An aborted row is degenerate under that check: the suites are killed rather than
drained, so the shift approaches the dip and the row reads contaminated whether
or not it was.

Usage:  OUTDIR=<dir> python3 scripts/bench_suite_concurrency.py [N ...]
        [--workers=<w>] [--floor-mb=<n>] [--require-quiet=<n>] [--measure-drift=<n>]
        [--no-warmup]
        Value flags take `=`.

`--measure-drift=<n>` runs n back-to-back resting settles before any suite and
records how far MemAvailable wandered with nothing running — the reading
`BASELINE_SHIFT_TOLERANCE_MB` is set from. It needs the same idle machine a
trustworthy row does, so it obeys the same quiet gate.
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import claude_sessions
from wfc_bin import bin_path

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")

# earlyoom kills at this percentage of MemTotal; see docs/environment.md §3.
EARLYOOM_PCT = 8.0
# Headroom above earlyoom's line at which we abort instead. 150 MB is a guess
# sized against a 10 Hz watchdog, not a measurement.
DEFAULT_FLOOR_MARGIN_MB = 150.0
# A row that trips this fast never loaded the machine. 5 s is a guess, not a
# measurement of how long a row takes to load it.
TRIVIAL_ABORT_S = 5.0


def meminfo():
    d = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            d[k] = int(v.split()[0])  # kB
    return d


def mem_available_mb():
    return meminfo()["MemAvailable"] / 1024


def swap_used_mb():
    m = meminfo()
    return (m["SwapTotal"] - m["SwapFree"]) / 1024


def parse_ppid(stat_text):
    """ppid from /proc/<pid>/stat, or None if the read was torn.

    `comm` may contain spaces and parens, so ppid is the field after the last
    ')'.
    """
    try:
        return int(stat_text[stat_text.rindex(")") + 2 :].split()[1])
    except (ValueError, IndexError):
        # A process exiting mid-read; it has no RSS left to count (#1274).
        return None


def parse_cpu_ticks_and_rss(stat_text, statm_text):
    """(cpu_ticks, rss_bytes) from one process's stat/statm, or None if torn."""
    try:
        tail = stat_text[stat_text.rindex(")") + 2 :].split()
        return int(tail[11]) + int(tail[12]), int(statm_text.split()[1]) * PAGE
    except (ValueError, IndexError):
        # As parse_ppid: a torn read is an exiting process, whose CPU `seen`
        # already holds (#1274).
        return None


def count_sessions(ps_output, cwd_of=claude_sessions.live_cwd):
    """Live Claude sessions in `ps -eo pid=,ppid=,args=` output, by
    lib/claude_sessions.py's unit — `docs/environment.md` §5's.

    DELIBERATELY NOT the `claude agents --json` oracle docs/environment.md admits sessions on:
    that call starts a Claude process of its own, and this figure is sampled
    per row on a machine whose memory is the thing being measured.

    ⚠ `sessions_live` rows recorded before 18 August 2026 (mantahostels#229, mantahostels#352) counted
    `claude` processes that were NOT pty hosts — roughly the spares — so they
    undercount a resumed session by one and are not comparable with later rows.

    ⚠ Rows recorded before 17 October 2026 00:54 UTC (#1798) also count the
    daemon's unclaimed spare, so they read one high wherever the daemon ran.
    """
    return claude_sessions.count_sessions(claude_sessions.parse_ps(ps_output), cwd_of)


def session_count():
    return count_sessions(
        subprocess.run(
            [bin_path("ps"), *claude_sessions.PS_ARGS], capture_output=True, text=True
        ).stdout
    )


def children_map():
    """pid -> [child pids], from /proc/*/stat."""
    kids = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                stat_text = f.read()
        except OSError:
            # Exited between listdir and open; nothing of it is left to map
            # (#1274).
            continue
        ppid = parse_ppid(stat_text)
        if ppid is not None:
            kids.setdefault(ppid, []).append(int(pid))
    return kids


def tree(root, kids):
    out, stack = [], [root]
    while stack:
        p = stack.pop()
        out.append(p)
        stack.extend(kids.get(p, []))
    return out


def proc_stats(pid):
    """(cpu_ticks, rss_bytes) for one pid, or None if it is gone."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            stat_text = f.read()
        with open(f"/proc/{pid}/statm") as f:
            statm_text = f.read()
    except OSError:
        # Gone since the tree was mapped — the docstring's None (#1274).
        return None
    return parse_cpu_ticks_and_rss(stat_text, statm_text)


def volunteer(pid):
    """Volunteer one process as earlyoom's first victim.

    Written from the parent rather than a `preexec_fn`, which is unsafe once
    the watchdog thread exists. Raising the score never needs privilege. Called
    again over the whole tree each sample, because npm forks vitest after we
    set it on npm and `oom_score_adj` is inherited only at fork.
    """
    try:
        with open(f"/proc/{pid}/oom_score_adj", "w") as f:
            f.write("1000")
        return True
    except OSError:
        # Exited before it could be volunteered; no caller reads the False
        # (#1274).
        return False


def sample(roots, seen):
    """CPU ticks and RSS across the roots' trees, volunteering each process.

    `seen` is the caller's accumulator: a per-pid high-water tick count, so a
    worker fork that exits between samples still contributes the CPU it burned. Kept only to report
    the sampler/rusage ratio.
    """
    kids = children_map()
    rss = 0
    npids = 0
    for r in roots:
        for pid in tree(r, kids):
            st = proc_stats(pid)
            if st:
                volunteer(pid)
                seen[pid] = max(seen.get(pid, 0), st[0])
                rss += st[1]
                npids += 1
    return sum(seen.values()), rss / 1e6, npids


# How far MemAvailable may end below where it started before the row is called
# contaminated. ABSOLUTE, NOT A SHARE OF THE DIP: a share lets an inflated dip
# buy itself a larger allowance, which is feedback in the wrong direction.
#
# MEASURED at mantahostels#1449: MemAvailable wanders up to 214.3 MB between consecutive
# resting settles with nothing running. Rounded up to that max, because a
# tolerance below the idle wander condemns rows nothing was wrong with.
#
# ONE SAMPLE, THREE GAPS, AND NOT A BARE MACHINE — 3 sessions were live.
BASELINE_SHIFT_TOLERANCE_MB = 215.0


def classify_baseline(
    rest_mb, avail_end_mb, dip_mb, *, sessions_start, sessions_end, rss_peak_mb=None
):
    """Was the baseline under this row stationary, and what did the suites cost?

    On a machine running parallel Claude sessions the dip metric's stationary
    baseline is routinely absent: a neighbour allocating mid-row is charged to
    the suites (mantahostels#954).

    A `baseline_stationary: False` is trustworthy. **A True is not** — both
    disqualifiers compare the same two endpoints, and the thing they guard is an
    instantaneous trough, so all of these pass: a neighbour that allocates
    mid-row and frees before the end, one arrival cancelling one departure, an
    already-live session growing, and every consumer that is not a Claude
    session at all. `dip_over_rss_peak` is the corroborator for exactly those —
    the sampled suite-tree peak against the dip charged to it — but it has no
    threshold, because a dip legitimately exceeds RSS (page cache, slab, 1 Hz
    undersampling) by a ratio nobody here has bounded. Read it, do not gate on
    it.

    `dip_attributable_mb` is the dip that came back; it cancels to
    `avail_end_mb - trough`. It bounds the suites' cost from below only where
    the machine ended no richer than it started — where it ended richer, the raw
    dip understates the suites and neither figure bounds anything.
    """
    shift = max(0.0, rest_mb - avail_end_mb)
    sessions_delta = sessions_end - sessions_start
    stationary = shift <= BASELINE_SHIFT_TOLERANCE_MB and sessions_delta <= 0
    return {
        "baseline_shift_mb": round(shift, 1),
        "sessions_delta": sessions_delta,
        "baseline_stationary": stationary,
        "dip_attributable_mb": round(max(0.0, dip_mb - shift), 1),
        "dip_over_rss_peak": round(dip_mb / rss_peak_mb, 2) if rss_peak_mb else None,
    }


def drift_from_settle_means(means):
    """How far resting `MemAvailable` wandered across a series of idle settles.

    This is what `BASELINE_SHIFT_TOLERANCE_MB` is supposed to stand for, and
    until mantahostels#1449 nobody had measured it here — 200.0 was a guess.

    The gaps are ABSOLUTE. A signed drift lets a machine that drifted down then
    back up report as perfectly stationary, which is the one reading that would
    wrongly ratify a small tolerance.
    """
    if len(means) < 2:
        raise ValueError("drift needs at least two settles; one measures nothing")
    # strict=False: the offset slice is one shorter by construction, which is
    # the point — n settles give n-1 gaps.
    deltas = [round(abs(b - a), 1) for a, b in zip(means, means[1:], strict=False)]
    return {
        "settles": len(means),
        "settle_means_mb": [round(m, 1) for m in means],
        "drift_deltas_mb": deltas,
        "drift_max_mb": max(deltas),
        "drift_mean_mb": round(sum(deltas) / len(deltas), 1),
    }


def measure_baseline_drift(settles, settle_fn):
    """`settles` consecutive resting settles, back to back, nothing between."""
    return drift_from_settle_means([settle_fn() for _ in range(settles)])


def parse_flags(flags, floor_mb):
    """`(floor_mb, require_quiet, measure_drift, workers)` from the `--` flags, or ValueError.

    Value flags take `=`, and an unrecognised one is refused rather than
    ignored: `--require-quiet 3` would otherwise drop the gate AND leave the 3
    to be read as a suite count — three suites on a machine of any busyness.
    `--measure-drift 4` and `--workers 2` fail the same way, as suite counts.
    """
    require_quiet = None
    measure_drift = None
    workers = DEFAULT_WORKERS
    for f in flags:
        if f.startswith("--floor-mb="):
            floor_mb = float(f.split("=", 1)[1])
        elif f.startswith("--require-quiet="):
            require_quiet = int(f.split("=", 1)[1])
        elif f.startswith("--measure-drift="):
            measure_drift = int(f.split("=", 1)[1])
        elif f.startswith("--workers="):
            workers = int(f.split("=", 1)[1])
        elif f != "--no-warmup":
            raise ValueError(f"unrecognised flag {f!r}; see this file's usage line")
    return floor_mb, require_quiet, measure_drift, workers


# The workers a suite the ladder was measured at (suite-ladder.js's
# LADDER_SUITE_WORKERS), so a row without `--workers` stays comparable with
# #1603's rows.
DEFAULT_WORKERS = 3


def suite_command(workers):
    """One whole suite at `workers`. A bare `npm run test` narrows to the diff
    (mantahostels#3208), so on a clean tree it would time an almost empty run.
    `other` because #182's cause vocabulary has no bench entry."""
    return ["npm", "run", "test", "--", "--full=other", f"--maxWorkers={workers}"]


def suite_env(env):
    """`env` with the stall-killer off: a suite slowed by its neighbours is the
    measurement, and a kill would cut the row short."""
    return {**env, "WFC_TEST_STALL_MS": "0"}


def quiet_enough(sessions, required):
    """True where the machine is quiet enough to measure. `required` None = any."""
    return required is None or sessions <= required


def too_busy(sessions, required):
    return f"{sessions} sessions live, above the --require-quiet={required} this run demands"


# Seconds of settling either side of a row. 20 s is inherited from mantahostels#352.
SETTLE_S = 20


def settle(seconds, label):
    print(f"  settling {seconds}s ({label})...", flush=True)
    end = time.time() + seconds
    readings = []
    while time.time() < end:
        readings.append(mem_available_mb())
        time.sleep(1)
    return sum(readings) / len(readings)


class Watchdog:
    """Kills the suites if MemAvailable approaches earlyoom's threshold.

    Samples at 10 Hz rather than the metric sampler's 1 Hz: the point is to
    beat a fast allocation into the kill zone, not to measure anything.

    It signals **process groups**, so it must be told when one is reaped: a
    reaped pid is free for the kernel to reuse, and signalling a reused pid's
    group would kill an unrelated process.
    """

    def __init__(self, floor_mb, read_avail=mem_available_mb, killer=None):
        self.floor_mb = floor_mb
        self.read_avail = read_avail
        self.killer = killer or self._killpg
        self.tripped_at = None
        self.min_avail = None
        self._live = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    @staticmethod
    def _killpg(pgid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            # The group exited before the kill landed, or its pgid was reused
            # by a process not ours; either way nothing of ours is left (#1274).
            pass

    def arm(self, pgids):
        """Reset state over a fresh set of process groups. Starts no thread —
        `start` does that."""
        self.tripped_at = None
        self.min_avail = None
        with self._lock:
            self._live = set(pgids)

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def note_reaped(self, pgid):
        """Drop a reaped group, so its pid can never be signalled after reuse."""
        with self._lock:
            self._live.discard(pgid)

    def disarm(self):
        self._stop.set()
        if self._thread:
            # A guess, never measured: time for a check_once in progress to end.
            self._thread.join(timeout=2)
        with self._lock:
            self._live = set()

    def check_once(self):
        """One reading. Returns True if it tripped."""
        avail = self.read_avail()
        self.min_avail = avail if self.min_avail is None else min(self.min_avail, avail)
        if avail >= self.floor_mb:
            return False
        self.tripped_at = round(avail, 1)
        print(
            f"  WATCHDOG: MemAvailable {avail:.0f} MB below floor "
            f"{self.floor_mb:.0f} MB — killing suites",
            flush=True,
        )
        with self._lock:
            doomed = list(self._live)
            self._live = set()
        for pgid in doomed:
            self.killer(pgid)
        return True

    def _loop(self):
        while not self._stop.is_set():
            if self.check_once():
                return
            self._stop.wait(0.1)


def run_config(n, workers, *, rest_avail, rest_swap, watchdog, out, run_seq):
    print(f"[{n} suite(s) x {workers} workers] launching", flush=True)
    sessions_start = session_count()
    logs, procs = [], []
    t0 = time.time()
    try:
        for i in range(n):
            log = open(f"{out}/run-{n}-{run_seq}-{i}.log", "w")
            logs.append(log)
            procs.append(
                subprocess.Popen(
                    suite_command(workers),
                    cwd=REPO,
                    env=suite_env(os.environ),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )
            )
            volunteer(procs[-1].pid)

        # start_new_session=True makes each child its own group leader, so its
        # pgid is its pid. Captured here rather than looked up at kill time,
        # when the process may already be gone.
        roots = [p.pid for p in procs]
        watchdog.arm(roots)
        watchdog.start()
        peak_rss = 0.0
        min_avail_1hz = 1e9
        max_swap = rest_swap
        max_pids = 0
        samples = []
        last_ticks, last_t = 0, t0
        peak_cpu = 0.0

        finished = [None] * n
        seen = {}
        while any(f is None for f in finished):
            time.sleep(1.0)
            now = time.time()
            ticks, rss, npids = sample(roots, seen)
            avail = mem_available_mb()
            swap = swap_used_mb()
            cpu = (ticks - last_ticks) / CLK / (now - last_t) * 100
            last_ticks, last_t = ticks, now
            peak_rss = max(peak_rss, rss)
            min_avail_1hz = min(min_avail_1hz, avail)
            max_swap = max(max_swap, swap)
            max_pids = max(max_pids, npids)
            if npids:  # ignore the tail sample after everything exited
                peak_cpu = max(peak_cpu, cpu)
            samples.append(
                {
                    "t": round(now - t0, 1),
                    "cpu_pct": round(cpu, 1),
                    "rss_mb": round(rss, 1),
                    "avail_mb": round(avail, 1),
                    "swap_mb": round(swap, 1),
                    "pids": npids,
                }
            )
            for i, p in enumerate(procs):
                if finished[i] is not None:
                    continue
                wpid, status, ru = os.wait4(p.pid, os.WNOHANG)
                if wpid == 0:
                    continue
                watchdog.note_reaped(p.pid)
                p.returncode = os.waitstatus_to_exitcode(status)
                finished[i] = (
                    round(now - t0, 1),
                    p.returncode,
                    ru.ru_utime + ru.ru_stime,
                )
    finally:
        watchdog.disarm()
        for log in logs:
            log.close()

    aborted = watchdog.tripped_at is not None
    wall = max(f[0] for f in finished)
    # A settle, not the last sample. The sampler reads `avail` *before* the
    # `wait4` that observes an exit, so the final reading can still hold a
    # second of suite memory, and the kernel reclaims after it regardless.
    # Charging either to the baseline biases every row toward contaminated.
    avail_end = settle(SETTLE_S, f"after {n}-suite run")
    sessions_end = session_count()
    rusage_cpu_s = sum(f[2] for f in finished)
    # The 10 Hz watchdog sees a truer trough than the 1 Hz metric sampler, so
    # the dip is taken from it. The 1 Hz figure is kept alongside because every
    # earlier measurement (mantahostels#229, mantahostels#352) quoted that one.
    trough = watchdog.min_avail if watchdog.min_avail is not None else min_avail_1hz
    return {
        "suites": n,
        "workers": workers,
        "aborted_by_watchdog": aborted,
        # An aborted row has no usable CPU figure: killing the process group
        # means npm never reaps its vitest children, so their rusage never
        # rolls up into what wait4 returns here and the total reads near zero.
        "cpu_valid": not aborted,
        "dip_is_lower_bound": aborted,
        "trivially_aborted": aborted and wall < TRIVIAL_ABORT_S,
        "watchdog_tripped_at_mb": watchdog.tripped_at,
        "headroom_at_start_mb": round(rest_avail - watchdog.floor_mb, 1),
        "sessions_live": sessions_end,
        "sessions_start": sessions_start,
        "avail_end_mb": round(avail_end, 1),
        **classify_baseline(
            rest_avail,
            avail_end,
            rest_avail - trough,
            sessions_start=sessions_start,
            sessions_end=sessions_end,
            rss_peak_mb=peak_rss,
        ),
        "wall_s": round(wall, 1),
        "per_run": [
            {"wall_s": f[0], "exit": f[1], "cpu_s": round(f[2], 1)} for f in finished
        ],
        "all_green": all(f[1] == 0 for f in finished),
        "cpu_pct_peak": round(peak_cpu, 1),
        "cpu_s_sampled": round(last_ticks / CLK, 1),
        "cpu_s_rusage": round(rusage_cpu_s, 1),
        "cpu_pct_avg_rusage": round(rusage_cpu_s / wall * 100, 1),
        "rss_peak_mb": round(peak_rss, 1),
        "avail_min_mb": round(trough, 1),
        "avail_min_mb_1hz": round(min_avail_1hz, 1),
        "avail_rest_mb": round(rest_avail, 1),
        "avail_dip_mb": round(rest_avail - trough, 1),
        "swap_rest_mb": round(rest_swap, 1),
        "swap_delta_mb": round(max_swap - rest_swap, 1),
        "max_pids": max_pids,
        "samples": samples,
    }


def main(argv):
    out = os.environ["OUTDIR"]
    args = [a for a in argv if not a.startswith("--")]
    flags = [a for a in argv if a.startswith("--")]

    mem_total_mb = meminfo()["MemTotal"] / 1024
    earlyoom_mb = mem_total_mb * EARLYOOM_PCT / 100
    floor_mb = earlyoom_mb + DEFAULT_FLOOR_MARGIN_MB
    try:
        floor_mb, require_quiet, measure_drift, workers = parse_flags(flags, floor_mb)
    except ValueError as e:
        sys.exit(str(e))

    configs = [int(x) for x in args] or [1, 2, 3]
    watchdog = Watchdog(floor_mb)
    live = session_count()

    print(
        f"MemTotal {mem_total_mb:.0f} MB · earlyoom kills at {earlyoom_mb:.0f} MB · "
        f"watchdog floor {floor_mb:.0f} MB · {live} sessions live",
        flush=True,
    )
    # Before the warm-up, not only per row: on a busy machine the warm-up is a
    # whole-suite run spent before every row refuses anyway. A run that would
    # have gone quiet by its first row is given up for that (#2862).
    if not quiet_enough(live, require_quiet):
        sys.exit(f"refused: {too_busy(live, require_quiet)}; no warm-up run")

    if measure_drift:
        # Before the warm-up, not after: the figure is what an IDLE machine
        # does, and a suite that has just exited leaves page cache settling.
        print(
            f"measuring idle baseline drift over {measure_drift} settles",
            flush=True,
        )
        drift = measure_baseline_drift(
            measure_drift, lambda: settle(SETTLE_S, "idle drift")
        )
        drift["sessions_live"] = live
        drift["settle_s"] = SETTLE_S
        with open(f"{out}/drift.json", "w") as f:
            json.dump(drift, f, indent=1)
        print(
            f"  idle drift over {drift['settles']} x {SETTLE_S}s settles: "
            f"max {drift['drift_max_mb']} MB, mean {drift['drift_mean_mb']} MB "
            f"(BASELINE_SHIFT_TOLERANCE_MB is currently {BASELINE_SHIFT_TOLERANCE_MB})",
            flush=True,
        )

    if "--no-warmup" not in flags:
        print("warm-up run (discarded)", flush=True)
        with open(f"{out}/warmup.log", "w") as wl:
            subprocess.run(
                suite_command(workers),
                cwd=REPO,
                env=suite_env(os.environ),
                stdout=wl,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )

    results = []
    for run_seq, n in enumerate(configs):
        rest = settle(SETTLE_S, f"before {n}-suite run")
        if rest <= floor_mb:
            # Launching here would abort on the first reading and emit a row
            # indistinguishable from a measurement.
            print(
                f"[{n} suite(s)] SKIPPED: resting {rest:.0f} MB is already at or "
                f"below the {floor_mb:.0f} MB floor",
                flush=True,
            )
            results.append(
                {
                    "suites": n,
                    "workers": workers,
                    "skipped_below_floor": True,
                    "avail_rest_mb": round(rest, 1),
                }
            )
            break
        live = session_count()
        if not quiet_enough(live, require_quiet):
            print(
                f"[{n} suite(s)] SKIPPED: {too_busy(live, require_quiet)}",
                flush=True,
            )
            results.append(
                {
                    "suites": n,
                    "workers": workers,
                    "skipped_not_quiet": True,
                    "sessions_live": live,
                    "avail_rest_mb": round(rest, 1),
                }
            )
            # `continue`, not the floor skip's `break`: a session can leave,
            # where headroom under the floor only falls as the ladder climbs.
            continue
        rest_swap = swap_used_mb()
        r = run_config(
            n,
            workers,
            rest_avail=rest,
            rest_swap=rest_swap,
            watchdog=watchdog,
            out=out,
            run_seq=run_seq,
        )
        results.append(r)
        print(
            f"[{n} suite(s)] wall {r['wall_s']}s"
            f"  cpu {r['cpu_pct_avg_rusage']}% (valid={r['cpu_valid']})"
            f"  avail rest {r['avail_rest_mb']:.0f} -> min {r['avail_min_mb']:.0f}"
            f"  dip {r['avail_dip_mb']:.0f}MB  sessions {r['sessions_live']}"
            f"  green={r['all_green']}  aborted={r['aborted_by_watchdog']}"
            f"  trivial={r['trivially_aborted']}"
            f"  stationary={r['baseline_stationary']}"
            f" (shift {r['baseline_shift_mb']:.0f}MB, sessions {r['sessions_start']}->{r['sessions_live']},"
            f" attributable {r['dip_attributable_mb']:.0f}MB)",
            flush=True,
        )
        with open(f"{out}/results.json", "w") as f:
            json.dump(results, f, indent=1)
        if r["aborted_by_watchdog"]:
            print("  stopping the ladder: the watchdog fired", flush=True)
            break
    with open(f"{out}/results.json", "w") as f:
        json.dump(results, f, indent=1)
    print("DONE", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
