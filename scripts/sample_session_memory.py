#!/usr/bin/env python3
"""sample_session_memory.py — sample each live Claude session's memory, with every process it starts.

Prices what a session costs, repo by repo (#333).

Every --interval seconds, for each session `claude agents --json` lists:

  own   PSS of the session's pair, paired as admission's `sessionPairPids`
        pairs it: the session process and every `claude` process sharing its
        `/spare/` socket id (`docs/environment.md` §5). A session with no
        such socket is its own process alone. Where a half has exited or will
        not read, admission credits the session nothing, so its row is not
        written for that sample.
  desc  PSS of every descendant of the session process: hooks, suites,
        builds, `gh`, `git`. Admission's session draw is own + desc (#2139).
        A process that detaches (`setsid`, a daemonised sweep) reparents out
        of the tree and is not counted; a nested listed session is left, with
        its subtree, to its own row, as admission's `descendantsPssKb` leaves
        it (#2231).

A descendant is tracked as an instance, keyed (session, pid, start time) so a
recycled pid is a new instance, from its first sample to its last. Instances
whose peak reaches --min-proc-mb are written out when they end; `analyse`
reads those as spikes. A spike is read only at sample instants, so its peak
is a floor and a process shorter than one interval may be missed outright.

`claude agents --json` is re-read every --agents-every seconds, not every
sample: one call holds ~240 MB for ~1 s, which at every sample would itself be a
load on the machine being measured. A session that starts and ends between two
reads is missed.

`run` appends to <out-dir>/{samples,sessions,procs}.csv, so a killed run can be
restarted into the same directory, and exits by itself after --duration
(default 24 h).
"""

import argparse
import csv
import gzip
import json
import os
import signal
import statistics
import subprocess
import sys
import time
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from claude_sessions import session_pair, spare_socket
from wfc_bin import bin_path

SAMPLES_HEADER = ["ts", "mem_available_kb", "swap_used_kb", "sessions", "sample_ms"]
SESSIONS_HEADER = [
    "ts",
    "session",
    "repo",
    "state",
    "own_pss_kb",
    "desc_pss_kb",
    "desc_count",
]
PROCS_HEADER = [
    "session",
    "repo",
    "pid",
    "first_ts",
    "last_ts",
    "samples",
    "peak_pss_kb",
    "key",
    "cmdline",
]

INTERPRETERS = {"node", "bash", "sh", "npx", "npm", "uv"}
SUBCOMMAND_TOOLS = {"git", "gh", "claude", "npm", "npx"}
VALUE_FLAGS = {"-C", "-c", "-R", "--repo", "--prefix"}
HOME = os.path.expanduser("~")


def command_key(argv):
    """Name a command for the spike table: the thing that ran, not its flags.

    `node scripts/check-reachability.js --x` -> `node check-reachability.js`,
    `python3 -m pytest -n 2` -> `python3 -m pytest`, `git -C x status` ->
    `git status`, `bash -c <script>` -> `bash -c`.
    """
    if not argv:
        return "?"
    head = os.path.basename(argv[0])
    rest = argv[1:]
    if head.startswith("python"):
        head = "python3" if head.startswith("python3") else "python"
    if head in SUBCOMMAND_TOOLS:
        if head == "npm" and rest[:1] == ["run"] and len(rest) > 1:
            return f"npm run {rest[1]}"
        skip = False
        for arg in rest:
            if skip:
                skip = False
            elif arg in VALUE_FLAGS:
                skip = True
            elif not arg.startswith("-"):
                return f"{head} {os.path.basename(arg)}"
        return head
    if head in INTERPRETERS or head.startswith("python"):
        for i, arg in enumerate(rest):
            if arg in ("-c", "-e"):
                return f"{head} {arg}"
            if arg == "-m" and i + 1 < len(rest):
                return f"{head} -m {rest[i + 1]}"
            if arg == "--test":
                return f"{head} --test"
            if not arg.startswith("-"):
                return f"{head} {os.path.basename(arg)}"
        return head
    return head


def repo_of(cwd):
    """The repo a session belongs to: the first path segment under $HOME."""
    if cwd and cwd.startswith(HOME + os.sep):
        return cwd[len(HOME) + 1 :].split(os.sep, 1)[0]
    return os.path.basename(cwd or "") or "?"


def percentile(values, p):
    """Nearest-rank percentile, so every figure reported is a real sample."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * p // 100))
    return ordered[int(rank) - 1]


# --- /proc readers -----------------------------------------------------------


def read_proc_table():
    """pid -> (ppid, starttime) for every process readable now."""
    table = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat") as f:
                stat = f.read()
            fields = stat[stat.rfind(")") + 2 :].split()
            table[int(name)] = (int(fields[1]), int(fields[19]))
        except (OSError, IndexError, ValueError):
            # Exited between listdir and read; nothing of it is left to sample
            # (#1274).
            continue
    return table


def pss_kb(pid):
    """Proportional set size in kB, or None for a process gone since the table
    was read — it has no memory left to count (#1274)."""
    try:
        with open(f"/proc/{pid}/smaps_rollup") as f:
            for line in f:
                if line.startswith("Pss:"):
                    return int(line.split()[1])
    except (OSError, IndexError, ValueError):
        pass
    return None


def cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            raw = f.read()
    except OSError:
        # Gone since the table was read: no argv, as for a kernel thread
        # (#1274).
        return []
    return [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]


def meminfo():
    values = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, rest = line.split(":", 1)
            values[key] = int(rest.split()[0])
    return values["MemAvailable"], values["SwapTotal"] - values["SwapFree"]


def descendants(root, children, session_pids):
    """Every pid under `root`, less any listed session and its subtree.

    The stop is DUPLICATED BY HAND from scripts/lib/admission.js's
    descendantsPssKb: move both, or neither (#2231)."""
    out, stack = [], list(children.get(root, ()))
    while stack:
        pid = stack.pop()
        if pid in session_pids:
            continue
        out.append(pid)
        stack.extend(children.get(pid, ()))
    return out


def pair_pss_kb(pair, procs, pss_of=pss_kb):
    """The summed PSS of a session's pair, each half a (pid, start time), or
    None where a half has exited, been replaced under its pid, or will not
    read — as admission's `sessionsPssKb` stops at an unreadable half."""
    total = 0
    for pid, start in pair:
        pss = pss_of(pid) if procs.get(pid, (None, None))[1] == start else None
        if pss is None:
            return None
        total += pss
    return total


def list_sessions():
    """The `claude agents --json` sessions, or None where the oracle will not
    answer — the caller then keeps its previous list rather than dropping all
    (#1274)."""
    try:
        listed = json.loads(
            subprocess.run(
                [bin_path("claude"), "agents", "--json"],
                capture_output=True,
                text=True,
                # A guess, never measured: well past the ~1 s a call takes.
                timeout=30,
            ).stdout
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if not isinstance(listed, list):
        return None
    return [s for s in listed if isinstance(s, dict) and isinstance(s.get("pid"), int)]


# --- run ---------------------------------------------------------------------


def open_csv(path, header):
    fresh = not os.path.exists(path) or os.path.getsize(path) == 0
    f = open(path, "a", newline="")
    writer = csv.writer(f)
    if fresh:
        writer.writerow(header)
    return f, writer


def run(args):
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "sampler.pid"), "w") as f:
        f.write(f"{os.getpid()}\n")
    handles, writers = {}, {}
    for name, header in (
        ("samples", SAMPLES_HEADER),
        ("sessions", SESSIONS_HEADER),
        ("procs", PROCS_HEADER),
    ):
        handles[name], writers[name] = open_csv(
            os.path.join(args.out, f"{name}.csv"), header
        )
    stopping = False

    def on_signal(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    me = os.getpid()
    min_proc_kb = args.min_proc_mb * 1024
    # Monotonic for the schedule: WSL2's wall clock jumps after host sleep.
    deadline = time.monotonic() + args.duration
    sessions = {}  # pid -> {"id", "repo", "state", "start", "pair"}
    instances = {}  # (session, pid, start) -> dict
    next_agents = 0.0

    def flush_instance(key, inst):
        if inst["peak"] >= min_proc_kb:
            writers["procs"].writerow(
                [
                    key[0],
                    inst["repo"],
                    key[1],
                    inst["first"],
                    inst["last"],
                    inst["samples"],
                    inst["peak"],
                    inst["key"],
                    inst["cmd"][:300],
                ]
            )

    while not stopping and time.monotonic() < deadline:
        tick = time.monotonic()
        procs = read_proc_table()
        if tick >= next_agents:
            listed = list_sessions()
            if listed is not None:
                # Read at each listing, not each sample: a claimed pair's
                # pids are fixed for the session's life.
                sockets = {
                    pid: sock
                    for pid in procs
                    if (sock := spare_socket(cmdline(pid))) is not None
                }
                sessions = {
                    s["pid"]: {
                        "id": s.get("id") or str(s.get("sessionId", "?"))[:8],
                        "repo": repo_of(s.get("cwd")),
                        "state": s.get("state") or s.get("status") or "?",
                        "start": procs[s["pid"]][1],
                        "pair": [
                            (pid, procs[pid][1])
                            for pid in session_pair(s["pid"], sockets)
                        ],
                    }
                    for s in listed
                    if s["pid"] in procs
                }
            next_agents = tick + args.agents_every
        children = defaultdict(list)
        for pid, (ppid, _) in procs.items():
            if pid != me:
                children[ppid].append(pid)
        ts = int(time.time())
        seen = set()
        listed_pids = set(sessions)
        for spid, sess in list(sessions.items()):
            if spid not in procs or procs[spid][1] != sess["start"]:
                del sessions[spid]
                continue
            own = pair_pss_kb(sess["pair"], procs)
            if own is None:
                continue
            desc_total, desc_count = 0, 0
            for dpid in descendants(spid, children, listed_pids):
                pss = pss_kb(dpid)
                if pss is None:
                    continue
                desc_total += pss
                desc_count += 1
                ikey = (sess["id"], dpid, procs[dpid][1])
                seen.add(ikey)
                inst = instances.get(ikey)
                if inst is None:
                    argv = cmdline(dpid)
                    inst = instances[ikey] = {
                        "repo": sess["repo"],
                        "first": ts,
                        "last": ts,
                        "samples": 0,
                        "peak": 0,
                        "key": command_key(argv),
                        "cmd": " ".join(argv),
                    }
                inst["last"] = ts
                inst["samples"] += 1
                inst["peak"] = max(inst["peak"], pss)
            writers["sessions"].writerow(
                [
                    ts,
                    sess["id"],
                    sess["repo"],
                    sess["state"],
                    own,
                    desc_total,
                    desc_count,
                ]
            )
        for ikey in [k for k in instances if k not in seen]:
            flush_instance(ikey, instances.pop(ikey))
        avail, swap = meminfo()
        writers["samples"].writerow(
            [ts, avail, swap, len(sessions), int((time.monotonic() - tick) * 1000)]
        )
        for f in handles.values():
            f.flush()
        time.sleep(max(0.0, args.interval - (time.monotonic() - tick)))

    for ikey, inst in instances.items():
        flush_instance(ikey, inst)
    for f in handles.values():
        f.close()


# --- analyse -----------------------------------------------------------------


def read_rows(path, int_fields, tally):
    """Rows whose integer fields all parse — a run killed mid-write leaves a
    torn last line, which is dropped rather than failing the whole read.
    `tally` is the caller's accumulator: each dropped row is counted into it
    under the file's name, for `analyse` to print (#1274). Falls back to
    `<path>.gz`, the form a dataset lands in under `docs/data/`."""
    rows = []
    opener = (
        open
        if os.path.exists(path)
        else lambda p, **kw: gzip.open(p + ".gz", "rt", **kw)
    )
    with opener(path, newline="") as f:
        for row in csv.DictReader(f):
            try:
                for field in int_fields:
                    int(row[field])
            except (KeyError, TypeError, ValueError):
                tally[os.path.basename(path)] += 1
                continue
            rows.append(row)
    return rows


def summarise(values_kb):
    mb = [v / 1024 for v in values_kb]
    return {
        "n": len(mb),
        "mean": statistics.mean(mb) if mb else None,
        "sd": statistics.stdev(mb) if len(mb) > 1 else None,
        "median": statistics.median(mb) if mb else None,
        "p90": percentile(mb, 90),
        "p95": percentile(mb, 95),
        "max": max(mb) if mb else None,
    }


def analyse_rows(session_rows, proc_rows, spike_mb):
    """Per repo: session+descendants and own-alone distributions, over every
    session sample and over `working` ones alone — a finished session idling
    resident would otherwise pull the medians down — and the spike table:
    every tracked process instance whose peak reached spike_mb."""
    by_repo = defaultdict(
        lambda: {
            "total": [],
            "own": [],
            "working_total": [],
            "working_own": [],
            "sessions": set(),
        }
    )
    for row in session_rows:
        own, desc = int(row["own_pss_kb"]), int(row["desc_pss_kb"])
        repo = by_repo[row["repo"]]
        repo["total"].append(own + desc)
        repo["own"].append(own)
        if row.get("state") == "working":
            repo["working_total"].append(own + desc)
            repo["working_own"].append(own)
        repo["sessions"].add(row["session"])
    spikes = defaultdict(list)
    for row in proc_rows:
        if int(row["peak_pss_kb"]) >= spike_mb * 1024:
            spikes[(row["repo"], row["key"])].append(row)
    result = {}
    for name, repo in sorted(by_repo.items()):
        table = []
        for (spike_repo, key), rows in spikes.items():
            if spike_repo != name:
                continue
            peaks = [int(r["peak_pss_kb"]) / 1024 for r in rows]
            durations = [int(r["last_ts"]) - int(r["first_ts"]) for r in rows]
            table.append(
                {
                    "key": key,
                    "count": len(rows),
                    "peak_max": max(peaks),
                    "peak_median": statistics.median(peaks),
                    "duration_median": statistics.median(durations),
                    "duration_max": max(durations),
                }
            )
        table.sort(key=lambda r: (-r["peak_max"], r["key"]))
        result[name] = {
            "sessions": len(repo["sessions"]),
            "spikes": table,
            **{
                label: summarise(repo[label])
                for label in ("total", "own", "working_total", "working_own")
            },
        }
    return result


# `agent-liveness.js`'s TERMINAL_STATES: a session admission never charges.
TERMINAL_STATES = {"done", "failed", "stopped"}
# The aggregate's p95, ruled at #2221. DUPLICATED BY HAND as DRAW_Z in
# scripts/lib/admission.js, which admits on it: move both, or neither.
DRAW_Z = 1.645


def draw_kb(row):
    return int(row["own_pss_kb"]) + int(row["desc_pss_kb"])


def aggregate_rows(session_rows, mean_mb, sd_mb):
    """The check on the aggregate draw (#2221): per count N of live sessions
    at one sample instant, how many instants had it, the measured p95 of their
    summed draw, and the N·mean + z·sd·√N admission charges for them."""
    ticks = defaultdict(list)
    for row in session_rows:
        if row.get("state") in TERMINAL_STATES:
            continue
        ticks[row["ts"]].append(draw_kb(row))
    by_count = defaultdict(list)
    for totals in ticks.values():
        by_count[len(totals)].append(sum(totals) / 1024)
    return [
        {
            "sessions": n,
            "ticks": len(sums),
            "p95": percentile(sums, 95),
            "model": n * mean_mb + DRAW_Z * sd_mb * n**0.5,
        }
        for n, sums in sorted(by_count.items())
    ]


def mb_text(v):
    return "-" if v is None else f"{v:,.0f}"


def analyse(args):
    torn = Counter()
    session_rows = read_rows(
        os.path.join(args.out, "sessions.csv"),
        ("ts", "own_pss_kb", "desc_pss_kb"),
        torn,
    )
    proc_rows = read_rows(
        os.path.join(args.out, "procs.csv"),
        ("first_ts", "last_ts", "peak_pss_kb"),
        torn,
    )
    samples = read_rows(
        os.path.join(args.out, "samples.csv"), ("ts", "sample_ms"), torn
    )
    print(
        "(torn rows dropped: "
        + ", ".join(
            f"{name} {torn[name]}"
            for name in ("sessions.csv", "procs.csv", "samples.csv")
        )
        + ")"
    )
    if samples:
        span = int(samples[-1]["ts"]) - int(samples[0]["ts"])
        cost = [int(s["sample_ms"]) for s in samples]
        print(
            f"{len(samples)} samples over {span / 3600:.1f} h; "
            f"sample cost median {statistics.median(cost):.0f} ms"
        )
    for name, repo in analyse_rows(session_rows, proc_rows, args.spike_mb).items():
        print(
            f"\n## {name} — {repo['sessions']} sessions, {repo['total']['n']} session-samples (MB)"
        )
        for label in ("total", "own", "working_total", "working_own"):
            print_summary(label, repo[label])
        print(
            f"  spikes >= {args.spike_mb:g} MB — n counts process instances, so one suite "
            "run is several rows; peaks are sample-instant floors; duration 0 = one sample:"
        )
        for r in repo["spikes"]:
            print(
                f"    {r['key'][:48]:48}  n {r['count']:4}  peak max {mb_text(r['peak_max'])}  "
                f"median {mb_text(r['peak_median'])}  dur median {r['duration_median']:.0f} s  "
                f"max {r['duration_max']} s"
            )

    working = [draw_kb(r) for r in session_rows if r.get("state") == "working"]
    pooled = summarise(working)
    print("\n## every repo pooled — one working session's draw (MB)")
    print_summary("working_total", pooled)
    if pooled["sd"] is None:
        return
    print(
        f"\n## the aggregate check — live sessions summed per sample instant against "
        f"N × {pooled['mean']:,.0f} + {DRAW_Z} × {pooled['sd']:,.0f} × √N (MB)"
    )
    for r in aggregate_rows(session_rows, pooled["mean"], pooled["sd"]):
        print(
            f"  N {r['sessions']:3}  ticks {r['ticks']:5}  measured p95 {mb_text(r['p95'])}  "
            f"model {mb_text(r['model'])}"
        )


def print_summary(label, summary):
    print(
        f"  {label:13}  n {summary['n']:6}  mean {mb_text(summary['mean'])}  sd {mb_text(summary['sd'])}  "
        f"median {mb_text(summary['median'])}  p90 {mb_text(summary['p90'])}  "
        f"p95 {mb_text(summary['p95'])}  max {mb_text(summary['max'])}"
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("out")
    # One day: the span #333 asked to price.
    run_parser.add_argument("--duration", type=float, default=24 * 3600)
    # Measured at #333's review.
    run_parser.add_argument("--interval", type=float, default=2)
    # Guesses, never measured.
    run_parser.add_argument("--agents-every", type=float, default=60)
    run_parser.add_argument("--min-proc-mb", type=float, default=10)
    analyse_parser = sub.add_parser("analyse")
    analyse_parser.add_argument("out")
    # A guess, never measured.
    analyse_parser.add_argument("--spike-mb", type=float, default=100)
    args = parser.parse_args(argv)
    (run if args.cmd == "run" else analyse)(args)


if __name__ == "__main__":
    sys.exit(main())
