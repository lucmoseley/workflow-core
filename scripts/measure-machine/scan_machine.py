#!/usr/bin/env python3

from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import gzip
import math
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc
from fail_open import tallied

UTC = dt.timezone.utc
SGT = dt.timezone(dt.timedelta(hours=8))

DEFAULT_SYSLOGS = "/var/log/syslog*"

SESSION_FLOOR_MIB = 400

MEM_TOTAL_MB = 9924

GATES = {
    "4-suite gate (3000 MB)": 3000,
    "3-suite floor (2400 MB)": 2400,
    "2-suite floor (2100 MB)": 2100,
    "1-suite floor (1700 MB)": 1700,
    "shell-start warning (1500 MB)": 1500,
    "two session slots (1280 MB)": 1280,
    "one session slot (640 MB)": 640,
    "earlyoom kill line (794 MB)": 794,
}

_EARLYOOM = re.compile(
    r"^(?P<ts>\S+)\s+\S+\s+earlyoom\[\d+\]:\s+sending SIG(?:TERM|KILL)\s+"
    r'to process \d+ uid \d+ "(?P<name>[^"]*)":.*?VmRSS (?P<rss>\d+) MiB'
)

_FREE = re.compile(r"^Mem:\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)\s*$", re.M)

_TIMESTAMP = re.compile(r'"timestamp":"([0-9TZ:.\-]+)"')


@dataclass(frozen=True)
class Kill:
    when: dt.datetime
    name: str
    rss_mib: int

    @property
    def is_session(self) -> bool:
        return self.rss_mib >= SESSION_FLOOR_MIB


def parse_earlyoom_kill(line: str, tally) -> Kill | None:
    m = _EARLYOOM.match(line)
    if not m:
        return None
    try:
        when = dt.datetime.fromisoformat(m.group("ts"))
    except ValueError as e:
        tallied(e, tally, "undated kills")
        return None
    return Kill(when=when, name=m.group("name"), rss_mib=int(m.group("rss")))


def read_syslogs(tally, pattern: str = DEFAULT_SYSLOGS):
    paths = sorted(
        glob.glob(pattern),
        key=lambda p: os.path.getmtime(p),
    )
    for path in paths:
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", errors="ignore") as fh:
                yield from fh
        except (OSError, EOFError) as e:
            tallied(e, tally, "unreadable syslogs")
            continue


def free_available_mb(text: str, total_mb: int = MEM_TOTAL_MB) -> list[int]:
    out = []
    for total, avail in _FREE.findall(text):
        if int(total) != total_mb:
            continue
        out.append(int(avail))
    return out


def transcript_spans(
    corpus: str | None,
    tally,
    since: dt.datetime | None = None,
    subagents: bool = True,
):
    spans = []
    for path in _transcript_files(corpus, subagents):
        first = last = None
        try:
            with open(path, errors="ignore") as fh:
                for line in fh:
                    m = _TIMESTAMP.search(line)
                    if not m:
                        continue
                    if first is None:
                        first = m.group(1)
                    last = m.group(1)
        except OSError as e:
            tallied(e, tally, tc.UNREADABLE)
            continue
        if not first or not last:
            continue
        try:
            a = dt.datetime.fromisoformat(first.replace("Z", "+00:00"))
            b = dt.datetime.fromisoformat(last.replace("Z", "+00:00"))
        except ValueError as e:
            tallied(e, tally, "undated files")
            continue
        if since and b < since:
            continue
        spans.append((a, b))
    return spans


def concurrency_timeline(spans):
    if not spans:
        return []
    events = []
    for a, b in spans:
        events.append((a, 1))
        events.append((b, -1))
    events.sort(key=lambda e: (e[0], -e[1]))
    timeline = []
    cur = 0
    prev = None
    for when, delta in events:
        if prev is not None and when > prev:
            timeline.append((prev, when, cur))
        cur += delta
        prev = when
    return timeline


def percentiles(values, ps):
    if not values:
        return {}
    ordered = sorted(values)
    n = len(ordered)
    return {p: ordered[min(n - 1, max(0, math.ceil(p * n) - 1))] for p in ps}


def threshold_shares(values, gates):
    n = len(values)
    out = {}
    for name, thr in gates.items():
        c = sum(1 for v in values if v < thr)
        out[name] = (c, (c / n) if n else 0.0)
    return out


def billed_minutes(job_seconds) -> int:
    return sum(max(1, math.ceil(s / 60)) for s in job_seconds)


def _transcript_files(corpus: str | None, subagents: bool = True):
    return [p for p, _ in tc.files(corpus, subagents)]


def headroom_readings(
    corpus: str | None,
    tally,
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
) -> list[int]:
    out = []
    for path in _transcript_files(corpus):
        for line, rec in tc.records_with_lines(path, tally, needle="Mem:"):
            try:
                when = dt.datetime.fromisoformat(
                    rec.get("timestamp", "").replace("Z", "+00:00")
                )
            except ValueError as e:
                tallied(e, tally, "undated records")
                continue
            if since and when < since:
                continue
            if until and when > until:
                continue
            out.extend(free_available_mb(line.replace("\\n", "\n")))
    return out


def scan_bash_commands(
    corpus: str | None, patterns, tally, since: dt.datetime | None = None
):
    compiled = {k: re.compile(v) for k, v in patterns.items()}
    per_day = collections.defaultdict(collections.Counter)
    for path in _transcript_files(corpus):
        for rec in tc.records(path, tally, needle='"Bash"'):
            try:
                when = dt.datetime.fromisoformat(
                    rec.get("timestamp", "").replace("Z", "+00:00")
                )
            except ValueError as e:
                tallied(e, tally, "undated records")
                continue
            if since and when < since:
                continue
            content = rec.get("message", {}).get("content")
            if not isinstance(content, list):
                continue
            day = when.astimezone(SGT).date()
            for block in content:
                if not isinstance(block, dict) or block.get("name") != "Bash":
                    continue
                cmd = block.get("input", {}).get("command", "")
                for key, pat in compiled.items():
                    if pat.search(cmd):
                        per_day[day][key] += 1
    return per_day


HEAVY = {
    "npm run test": r"npm run test\b",
    "npm run typecheck": r"npm run typecheck",
    "build": r"next build|npm run build",
}


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Measure whether this machine binds on anything but the token allowance."
    )
    ap.add_argument(
        "--corpus", help="one transcripts directory; default every seat root"
    )
    ap.add_argument("--syslogs", default=DEFAULT_SYSLOGS)
    ap.add_argument(
        "--days",
        type=int,
        # guess: the window lucmoseley/mantahostels#1127 sampled
        default=7,
        help="window for headroom, concurrency and command counts",
    )
    ap.add_argument(
        "--until",
        default=None,
        help="pin the window's end (ISO 8601, UTC assumed). The corpus grows "
        "while sessions run, so an unpinned run drifts between invocations and "
        "cannot reproduce a published figure",
    )
    ap.add_argument(
        "--since-config",
        default="2026-08-18",
        help="first day of the current 10 GB / 8-core guest; kills before it "
        "are reported separately because they are not comparable",
    )
    args = ap.parse_args()

    now = (
        dt.datetime.fromisoformat(args.until).replace(tzinfo=UTC)
        if args.until
        else dt.datetime.now(UTC)
    )
    since = now - dt.timedelta(days=args.days)
    config_day = dt.date.fromisoformat(args.since_config)

    print(f"# Machine binding scan — {now.astimezone(SGT):%Y-%m-%d %H:%M} SGT\n")

    tally = collections.Counter()
    kills = []
    for line in read_syslogs(tally, args.syslogs):
        if k := parse_earlyoom_kill(line, tally):
            kills.append(k)
    sessions = [k for k in kills if k.is_session]
    recent = [k for k in sessions if k.when.astimezone(SGT).date() >= config_day]
    print("## 1. earlyoom kills — the machine stopping work outright")
    if kills:
        span = (
            kills[0].when.astimezone(SGT).date(),
            kills[-1].when.astimezone(SGT).date(),
        )
        print(f"syslog window: {span[0]} to {span[1]}")
    print(
        f"kill signals: {len(kills)}  {tc.counts_line(tally, 'unreadable syslogs', 'undated kills')}"
    )
    print(f"  session-sized (>= {SESSION_FLOOR_MIB} MiB): {len(sessions)}")
    print(f"  collateral (watchdog, sd-pam, shells): {len(kills) - len(sessions)}")
    print(f"  session-sized since {config_day} (current guest): {len(recent)}")
    by_day = collections.Counter(k.when.astimezone(SGT).date() for k in sessions)
    for day in sorted(by_day):
        print(f"    {day}  {by_day[day]}")
    victims = collections.Counter(k.name for k in kills)
    print("  victims: " + ", ".join(f"{n}×{v}" for v, n in victims.most_common(8)))

    print("\n## 2. Headroom actually observed, from every `free -m` a session ran")
    tally = collections.Counter()
    readings = headroom_readings(args.corpus, tally, since=since, until=now)
    print(
        f"window: last {args.days} days · n={len(readings)}  "
        f"{tc.counts_line(tally, tc.UNREADABLE, tc.UNPARSED, 'undated records')}"
    )
    if readings:
        q = percentiles(readings, [0.1, 0.25, 0.5, 0.75, 0.9])
        print(
            f"  min={min(readings)} p10={q[0.1]} p25={q[0.25]} p50={q[0.5]} "
            f"p75={q[0.75]} p90={q[0.9]} max={max(readings)} MB available"
        )
        for name, (c, share) in threshold_shares(readings, GATES).items():
            print(f"  under {name:32s} {c:6d}  {share * 100:5.1f}%")

    print("\n## 3. Parallel sessions actually running")
    for label, subagents in (("sessions only", False), ("sessions + subagents", True)):
        tally = collections.Counter()
        spans = transcript_spans(args.corpus, tally, since=since, subagents=subagents)
        dist = collections.Counter()
        for a, b, c in concurrency_timeline(spans):
            a = max(a, since)
            if b <= a:
                continue
            dist[c] += (b - a).total_seconds()
        total = sum(dist.values())
        print(
            f"\n### {label} — {len(spans)} transcripts, {total / 3600:.1f} h swept  "
            f"{tc.counts_line(tally, tc.UNREADABLE, 'undated files')}"
        )
        run = 0.0
        for c in sorted(dist):
            run += dist[c]
            print(
                f"  {c:3d} concurrent  {dist[c] / 3600:7.2f} h  "
                f"{dist[c] / total * 100 if total else 0:5.1f}%  "
                f"cum {run / total * 100 if total else 0:5.1f}%"
            )

    print("\n## 4. Heavy work running locally (what a hosted runner would absorb)")
    tally = collections.Counter()
    per_day = scan_bash_commands(args.corpus, HEAVY, tally, since=since)
    print(f"  {tc.counts_line(tally, tc.UNREADABLE, tc.UNPARSED, 'undated records')}")
    totals = collections.Counter()
    for day in sorted(per_day):
        print(
            f"  {day}  "
            + "  ".join(f"{k}={v}" for k, v in sorted(per_day[day].items()))
        )
        totals.update(per_day[day])
    for k, v in totals.most_common():
        print(f"  total {k}: {v} over {args.days}d — {v / args.days:.0f}/day")


if __name__ == "__main__":
    main()
