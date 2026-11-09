#!/usr/bin/env python3
"""drop_guest_cache.py — drop the WSL guest's page cache when Windows runs short (#4759).

With `autoMemoryReclaim=disabled` (#3246) the guest's page cache stays backed in
`vmmemWSL`, and WSL's own reclaim runs only on a near-idle VM, which this one
almost never is. A root `drop_caches` hands that memory back to Windows at once.

  tick     run each minute by drop-guest-cache.timer, as root. Reads the newest
           line of memwatch's minute log; when its Windows sample is fresh and
           reads under TRIGGER_MB, and the last drop is FLOOR_S old, syncs and
           drops the page cache, logging a `drop` record. Once a later minute
           line carries a Windows sample taken after that drop, logs its
           `after` record.
  install  run under sudo: copies this script to INSTALLED, root-owned, so no
           session's edit runs as root; writes the service and timer to
           /etc/systemd/system from the templates beside it; creates the drop
           log owned by the sudo user; starts the timer. Re-run it to take up a
           change to this script.
             sudo /usr/bin/python3 scripts/drop_guest_cache.py install
           `--root <dir>` prefixes every path written and drops the need for
           root, for a test. WFC_SYSTEMCTL names the systemctl to call.

Exit codes: 0; 1 where a read, write or systemctl call fails; 2 on a command
line, or an install with no sudo user or not run as root.
"""

import argparse
import json
import os
import pwd
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

# Guesses until #4759's day of drops is read: the line Windows' free memory
# must fall under, and the least time between two drops.
TRIGGER_MB = 1500
FLOOR_S = 300
# A Windows sample older than this is not acted on: memwatch samples Windows
# about once a minute (`win_age_s` reads ~65 s on a healthy log), so this
# allows one missed sample.
MAX_SAMPLE_AGE_S = 180
# Read from the minute log's end: a line is ~800 bytes, so this holds several
# whole lines, a torn last one included.
TAIL_BYTES = 16384

UNIT = "drop-guest-cache"
HERE = Path(__file__).resolve().parent
INSTALLED = Path("/usr/local/lib/workflow-core/drop_guest_cache.py")
DROP_CACHES = "/proc/sys/vm/drop_caches"
MEMINFO = "/proc/meminfo"


class WinSample(NamedTuple):
    taken_at: float
    avail_mb: int


def parse_ts(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z").timestamp()


def format_ts(t):
    """memwatch's own timestamp shape, so parse_ts reads drop records too."""
    return datetime.fromtimestamp(t).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def last_line(path):
    """The newest whole JSON line of `path`, or None."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            lines = f.read().splitlines()
    except OSError as err:
        # No reading, so no drop; said, so a dead memwatch shows in the journal (#4759).
        print(f"no minute log: {err}", file=sys.stderr)
        return None
    for raw in reversed(lines):
        try:
            return json.loads(raw)
        except ValueError:
            # A line memwatch is still writing; the one before it stands (#4759).
            continue
    return None


def win_sample(line):
    """The line's Windows sample, or None."""
    if not line:
        return None
    avail, age, ts = line.get("win_avail_mb"), line.get("win_age_s"), line.get("ts")
    if not isinstance(avail, int) or not isinstance(age, int) or not ts:
        return None
    try:
        return WinSample(parse_ts(ts) - age, avail)
    except ValueError:
        # An unreadable timestamp is no reading, so no drop (#4759).
        return None


def read_records(path):
    try:
        text = Path(path).read_text()
    except FileNotFoundError:
        # No drop logged yet (#4759).
        return []
    records = []
    for raw in text.splitlines():
        try:
            records.append(json.loads(raw))
        except ValueError:
            # A torn record from a killed run; the rest still count (#4759).
            continue
    return records


def append_record(path, record):
    """Append as root to a log in the user's home: never through a symlink, which
    would let the user aim root's write at any file."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "a") as f:
        f.write(json.dumps(record) + "\n")


def cached_mb(meminfo):
    for raw in Path(meminfo).read_text().splitlines():
        if raw.startswith("Cached:"):
            return int(raw.split()[1]) // 1024
    return None


def drop(drop_caches, meminfo):
    """Sync, drop the page cache; returns guest Cached MB before and after.
    `1` drops the page cache alone, the memory #4759 measured held in vmmemWSL;
    `3` would also drop dentries and inodes, which every session re-reads."""
    before = cached_mb(meminfo)
    os.sync()
    Path(drop_caches).write_text("1")
    return before, cached_mb(meminfo)


def reading(line, sample):
    return {
        "line_ts": line["ts"],
        "win_avail_mb": sample.avail_mb,
        "mem_avail_mb": line.get("mem_avail_mb"),
    }


def tick(minute_log, drop_log, now, *, drop_caches=DROP_CACHES, meminfo=MEMINFO):
    """One timer firing. Returns what it did: `drop`, `after`, both or nothing."""
    line = last_line(minute_log)
    sample = win_sample(line)
    records = read_records(drop_log)
    drops = [r for r in records if r.get("kind") == "drop"]
    afters = {r.get("drop") for r in records if r.get("kind") == "after"}
    done = []
    last = drops[-1] if drops else None
    if (
        last
        and last["ts"] not in afters
        and sample
        and sample.taken_at > parse_ts(last["ts"])
    ):
        append_record(
            drop_log, {"kind": "after", "drop": last["ts"], **reading(line, sample)}
        )
        done.append("after")
    if (
        not sample
        or now - sample.taken_at > MAX_SAMPLE_AGE_S
        or sample.avail_mb >= TRIGGER_MB
    ):
        return done
    if last and now - parse_ts(last["ts"]) < FLOOR_S:
        return done
    cached_before, cached_after = drop(drop_caches, meminfo)
    append_record(
        drop_log,
        {
            "kind": "drop",
            "ts": format_ts(now),
            **reading(line, sample),
            "cached_mb_before": cached_before,
            "cached_mb_after": cached_after,
        },
    )
    done.append("drop")
    return done


def render(template, script, minute_log, drop_log):
    return (
        template.replace("@SCRIPT@", str(script))
        .replace("@MINUTE_LOG@", str(minute_log))
        .replace("@DROP_LOG@", str(drop_log))
    )


def under(root, path):
    return root / str(path).lstrip("/")


def install(root):
    """Copy the script, write both units, create the drop log, start the timer.
    Returns an exit code."""
    # Imported here: the installed copy runs `tick` alone, with no lib/ beside it.
    sys.path.insert(0, str(HERE / "lib"))
    from wfc_bin import bin_path

    usage = "sudo /usr/bin/python3 scripts/drop_guest_cache.py install"
    user = os.environ.get("SUDO_USER", "")
    if not user or user == "root":
        print(f'SUDO_USER is "{user}": run it as {usage}', file=sys.stderr)
        return 2
    if root == Path("/") and os.geteuid() != 0:
        print(f"needs root: run it as {usage}", file=sys.stderr)
        return 2
    account = pwd.getpwnam(user)
    home = Path(account.pw_dir)
    minute_log = home / "memwatch-minute.jsonl"
    drop_log = home / "guest-cache-drops.jsonl"
    script = under(root, INSTALLED)
    script.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HERE / "drop_guest_cache.py", script)
    script.chmod(0o644)
    print(script)
    units = under(root, "/etc/systemd/system")
    units.mkdir(parents=True, exist_ok=True)
    for suffix in ("service", "timer"):
        template = (HERE / f"{UNIT}.{suffix}.template").read_text()
        out = units / f"{UNIT}.{suffix}"
        out.write_text(render(template, INSTALLED, minute_log, drop_log))
        out.chmod(0o644)
        print(out)
    log = under(root, drop_log)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.touch()
    if root == Path("/"):
        os.chown(log, account.pw_uid, account.pw_gid)
    print(log)
    systemctl = bin_path("systemctl")
    for args in (["daemon-reload"], ["enable", "--now", f"{UNIT}.timer"]):
        run = subprocess.run([systemctl, *args], capture_output=True, text=True)
        if run.returncode != 0:
            print(
                f"systemctl {' '.join(args)}: {run.stderr.strip()}; re-run: {usage}",
                file=sys.stderr,
            )
            return 1
    state = subprocess.run(
        [systemctl, "is-active", f"{UNIT}.timer"], capture_output=True, text=True
    ).stdout.strip()
    print(f"{UNIT}.timer: {state}")
    return 0 if state == "active" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(prog="drop_guest_cache.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tick")
    t.add_argument("--minute-log", required=True)
    t.add_argument("--drop-log", required=True)
    i = sub.add_parser("install")
    i.add_argument("--root", default="/")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "tick":
            tick(args.minute_log, args.drop_log, time.time())
            return 0
        return install(Path(args.root))
    except OSError as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
