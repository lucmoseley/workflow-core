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
  install  run once under sudo, from the main checkout: writes the service and
           timer to /etc/systemd/system from the templates beside this script,
           creates the drop log owned by the sudo user, and starts the timer.
             sudo /usr/bin/python3 scripts/drop_guest_cache.py install
           `--root <dir>` prefixes every path written and drops the need for
           root, for a test. WFC_SYSTEMCTL names the systemctl to call.

Exit codes: 0; 1 where a read, write or systemctl call fails; 2 on a command
line, or an install with no sudo user or from a linked worktree.
"""

import argparse
import json
import os
import pwd
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

# Guesses until #4759's day of drops is read: the line Windows' free memory
# must fall under, and the least time between two drops.
TRIGGER_MB = 1500
FLOOR_S = 300
# A Windows sample older than this is not acted on: memwatch samples Windows
# about once a minute (`win_age_s` reads ~65 s on a healthy log), so this
# allows one missed sample.
MAX_SAMPLE_AGE_S = 180

UNIT = "drop-guest-cache"
HERE = Path(__file__).resolve().parent
DROP_CACHES = "/proc/sys/vm/drop_caches"
MEMINFO = "/proc/meminfo"


def parse_ts(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z").timestamp()


def iso(t):
    return datetime.fromtimestamp(t, UTC).isoformat().replace("+00:00", "Z")


def last_line(path):
    """The newest whole JSON line of `path`, or None."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 16384))
            lines = f.read().splitlines()
    except OSError:
        # No minute log yet, or memwatch rotating it: no reading, no drop (#4759).
        return None
    for raw in reversed(lines):
        try:
            return json.loads(raw)
        except ValueError:
            # A line memwatch is still writing; the one before it stands (#4759).
            continue
    return None


def win_sample(line):
    """(epoch the Windows sample was taken, its win_avail_mb), or None."""
    if not line:
        return None
    avail, age, ts = line.get("win_avail_mb"), line.get("win_age_s"), line.get("ts")
    if not isinstance(avail, int) or not isinstance(age, int) or not ts:
        return None
    try:
        return parse_ts(ts) - age, avail
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
    with open(path, "a") as f:
        f.write(json.dumps(record) + "\n")


def cached_mb(meminfo):
    for raw in Path(meminfo).read_text().splitlines():
        if raw.startswith("Cached:"):
            return int(raw.split()[1]) // 1024
    return None


def drop(drop_caches, meminfo):
    """Sync, drop the page cache; returns guest Cached MB before and after."""
    before = cached_mb(meminfo)
    os.sync()
    Path(drop_caches).write_text("1")
    return before, cached_mb(meminfo)


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
        and sample[0] > parse_iso(last["ts"])
    ):
        append_record(
            drop_log,
            {
                "kind": "after",
                "drop": last["ts"],
                "line_ts": line["ts"],
                "win_avail_mb": sample[1],
                "mem_avail_mb": line.get("mem_avail_mb"),
            },
        )
        done.append("after")
    if not sample or now - sample[0] > MAX_SAMPLE_AGE_S or sample[1] >= TRIGGER_MB:
        return done
    if last and now - parse_iso(last["ts"]) < FLOOR_S:
        return done
    cached_before, cached_after = drop(drop_caches, meminfo)
    append_record(
        drop_log,
        {
            "kind": "drop",
            "ts": iso(now),
            "line_ts": line["ts"],
            "win_avail_mb": sample[1],
            "mem_avail_mb": line.get("mem_avail_mb"),
            "cached_mb_before": cached_before,
            "cached_mb_after": cached_after,
        },
    )
    done.append("drop")
    return done


def parse_iso(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def render(template, script, minute_log, drop_log):
    return (
        template.replace("@SCRIPT@", str(script))
        .replace("@MINUTE_LOG@", str(minute_log))
        .replace("@DROP_LOG@", str(drop_log))
    )


def install(root):
    """Write both units, create the drop log, start the timer. Returns an exit code."""
    user = os.environ.get("SUDO_USER", "")
    if not user or user == "root":
        print(f'SUDO_USER is "{user}", not a user to install for', file=sys.stderr)
        return 2
    if not (HERE.parent / ".git").is_dir():
        print(
            f"{HERE.parent} is a linked worktree, which is removed when its work"
            " lands; run this from the main checkout",
            file=sys.stderr,
        )
        return 2
    if root == Path("/") and os.geteuid() != 0:
        print(
            "needs root: sudo /usr/bin/python3 scripts/drop_guest_cache.py install",
            file=sys.stderr,
        )
        return 2
    home = Path(pwd.getpwnam(user).pw_dir)
    minute_log = home / "memwatch-minute.jsonl"
    drop_log = home / "guest-cache-drops.jsonl"
    units = root / "etc/systemd/system"
    units.mkdir(parents=True, exist_ok=True)
    for suffix in ("service", "timer"):
        template = (HERE / f"{UNIT}.{suffix}.template").read_text()
        out = units / f"{UNIT}.{suffix}"
        out.write_text(
            render(template, HERE / "drop_guest_cache.py", minute_log, drop_log)
        )
        out.chmod(0o644)
        print(out)
    log = root / str(drop_log).lstrip("/")
    log.parent.mkdir(parents=True, exist_ok=True)
    log.touch()
    if root == Path("/"):
        os.chown(log, pwd.getpwnam(user).pw_uid, pwd.getpwnam(user).pw_gid)
    print(log)
    systemctl = os.environ.get("WFC_SYSTEMCTL") or "systemctl"
    for args in (["daemon-reload"], ["enable", "--now", f"{UNIT}.timer"]):
        run = subprocess.run([systemctl, *args], capture_output=True, text=True)
        if run.returncode != 0:
            print(f"systemctl {' '.join(args)}: {run.stderr.strip()}", file=sys.stderr)
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
            tick(args.minute_log, args.drop_log, datetime.now(UTC).timestamp())
            return 0
        return install(Path(args.root))
    except OSError as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
