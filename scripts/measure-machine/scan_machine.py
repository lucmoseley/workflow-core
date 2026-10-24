#!/usr/bin/env python3
"""scan_machine.py — measure whether this machine binds on anything but the token allowance.

Commissioned by mantahostels#1127, under map mantahostels#1122 (the standing capacity-and-procurement
policy), to find out whether buying cloud compute would relieve a real constraint.

The companion measurement is mantahostels#1125's `scripts/measure-ceiling/scan_ceiling.py`,
which counts allowance blockage over the same corpus.

Three sources on disk, and one priced from figures collected elsewhere —
nothing here starts a workload:

  * **`/var/log/syslog*`** — every `earlyoom` kill. A kill is the one
    unambiguous record of the machine stopping work, and it names its victim
    and that victim's RSS, so a lost session can be told from a lost watchdog.
  * **Claude Code transcripts** — every `free -m` a session ever ran, which is
    a sample of real headroom at the moments sessions cared about it, and the
    Bash commands that show what heavy work runs locally.
  * **Transcript spans** — first to last record per transcript, swept into a
    time-weighted concurrency distribution. This is what "how many parallel
    sessions actually run" means; a peak is not an answer.
  * **Actions job durations**, collected by `gh` outside this script and priced
    by `billed_minutes` below at GitHub's own rule of a whole started minute per
    job. A helper the report calls, not a section `main()` prints.

Every figure is reported with the window it was measured over, because the
machine's configuration changed on 18 August 2026 (8 -> 10 GB, 6 -> 8 cores)
and readings across that line are not comparable.
"""

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

UTC = dt.timezone.utc
# The reset stamps and the founder's day are both Asia/Singapore. Fixed +08:00:
# Singapore has had no DST since 1936, so no tz database is needed.
SGT = dt.timezone(dt.timedelta(hours=8))

DEFAULT_SYSLOGS = "/var/log/syslog*"

# A victim this small is never a session. The smallest Claude session pair PSS
# ever sampled on this machine is 488 MB (docs/environment.md §5), and the
# collateral earlyoom takes -- `memwatch.sh`, `(sd-pam)` -- is 1-3 MiB. 400
# sits in the empty band between, so the split is insensitive to where exactly
# it goes.
SESSION_FLOOR_MIB = 400

# This guest's MemTotal as `free -m` prints it, read from /proc/meminfo on
# 18 August 2026. Readings quoting any other total came off a different
# machine configuration and are dropped rather than mixed in.
MEM_TOTAL_MB = 9924

# The gates `scripts/lib/admission.js` enforces, restated here so a reading can
# be scored against what actually refuses work.
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

# `free -m`'s Mem: row. The total is captured so a reading off another machine
# configuration can be dropped.
_FREE = re.compile(r"^Mem:\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)\s*$", re.M)

_TIMESTAMP = re.compile(r'"timestamp":"([0-9TZ:.\-]+)"')


@dataclass(frozen=True)
class Kill:
    """One earlyoom kill signal."""

    when: dt.datetime
    name: str
    rss_mib: int

    @property
    def is_session(self) -> bool:
        """True where the victim was big enough to have been real work.

        earlyoom kills the largest consumer, so a big victim is a session and
        a 1-3 MiB one is collateral it took on the way past.
        """
        return self.rss_mib >= SESSION_FLOOR_MIB


def parse_earlyoom_kill(line: str) -> Kill | None:
    """Read one syslog line, or None where it is not a kill.

    The line that is *not* a kill and looks most like one is earlyoom's
    startup banner, `sending SIGTERM when mem <= 8.00%`. It is printed on
    every start and this machine restarts often, so admitting it would inflate
    the tally about threefold.
    """
    m = _EARLYOOM.match(line)
    if not m:
        return None
    try:
        when = dt.datetime.fromisoformat(m.group("ts"))
    except ValueError:
        # A kill whose stamp is not ISO cannot be placed in a day; `main`
        # counts it as undated (#1274).
        return None
    return Kill(when=when, name=m.group("name"), rss_mib=int(m.group("rss")))


def read_syslogs(tally, pattern: str = DEFAULT_SYSLOGS):
    """Yield lines from every syslog, plain and gzipped, oldest first.

    `tally` is the caller's accumulator, which `main` prints: one that will
    not open or is truncated mid-gzip is skipped and counted into it (#1274).
    """
    paths = sorted(
        glob.glob(pattern),
        key=lambda p: os.path.getmtime(p),
    )
    for path in paths:
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", errors="ignore") as fh:
                yield from fh
        except (OSError, EOFError):
            tally["unreadable syslogs"] += 1
            continue


def free_available_mb(text: str, total_mb: int = MEM_TOTAL_MB) -> list[int]:
    """Every `available` figure in a blob of `free -m` output.

    The `available` column, never `free`: `free` counts reclaimable page cache
    as spent, so it reads catastrophically low on a machine that is fine.
    Only readings quoting `total_mb` as their total are kept.
    """
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
    """(first, last) timestamp per transcript, main sessions and subagents.

    Subagent turns live in `<session-id>/subagents/agent-*.jsonl`, not as
    sidechain lines in the parent (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/allowance-burn-measurement.md).
    A sweep of `*.jsonl` alone therefore misses them.

    **The two populations answer different questions and must not be merged
    into one figure.** Sessions are what costs memory and what
    `scripts/lib/admission.js` admits; subagents are extra concurrent agents
    inside a session's own slot.

    `tally` is the caller's accumulator, which `main` prints: a transcript
    that will not open or whose stamps will not parse is skipped and counted
    into it (#1274). Every line is read
    for its timestamp, unparsed, so `tc.records` cannot stand in here.
    """
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
        except OSError:
            tally[tc.UNREADABLE] += 1
            continue
        if not first or not last:
            continue
        try:
            a = dt.datetime.fromisoformat(first.replace("Z", "+00:00"))
            b = dt.datetime.fromisoformat(last.replace("Z", "+00:00"))
        except ValueError:
            tally["undated files"] += 1
            continue
        if since and b < since:
            continue
        spans.append((a, b))
    return spans


def concurrency_timeline(spans):
    """Half-open intervals of constant concurrency, as (start, end, count).

    Time-weighted by construction. Sampling instead -- counting how many
    transcripts were open at each of N moments -- lets a peak that lasted
    seconds read as the machine's working level.
    """
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
    """Nearest-rank percentiles, never interpolated.

    Every value here is an observation the machine actually produced;
    interpolating invents a reading between two of them.
    """
    if not values:
        return {}
    ordered = sorted(values)
    n = len(ordered)
    return {p: ordered[min(n - 1, max(0, math.ceil(p * n) - 1))] for p in ps}


def threshold_shares(values, gates):
    """{gate name: (count strictly below, share)} for each gate.

    Strictly below: a reading exactly at a gate admits the work, so counting
    it as a refusal overstates how often the machine says no.
    """
    n = len(values)
    out = {}
    for name, thr in gates.items():
        c = sum(1 for v in values if v < thr)
        out[name] = (c, (c / n) if n else 0.0)
    return out


def billed_minutes(job_seconds) -> int:
    """GitHub Actions minutes for a set of job durations.

    Billed per job per started minute, so two 30-second jobs cost two minutes.
    """
    return sum(max(1, math.ceil(s / 60)) for s in job_seconds)


def _transcript_files(corpus: str | None, subagents: bool = True):
    """Every transcript under a corpus, main sessions and subagents. A corpus
    of None is every seat root's, one copy of each session (#379)."""
    return [p for p, _ in tc.files(corpus, subagents)]


def headroom_readings(
    corpus: str | None,
    tally,
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
) -> list[int]:
    """Every `free -m` available figure a session ever recorded, in time order.

    The seam behind the report's headroom distribution. Two things it has to
    get right:

    * **The output is inside a JSON string**, so the record's `\n` escaping is
      undone before the line-anchored `free -m` regex can match anything at all.
    * **One reading per record, not per file.** A session that ran `free -m`
      six times contributes six observations; collapsing them would drop
      exactly the crowded moments the distribution exists to capture, because a
      busy session is the one that checks memory most often.

    `tally` is the caller's accumulator, which `main` prints: it receives
    `tc.records`'s skip counts and `undated records`, those with no parsable
    timestamp (#1274).
    """
    out = []
    for path in _transcript_files(corpus):
        for line, rec in tc.records_with_lines(path, tally, needle="Mem:"):
            try:
                when = dt.datetime.fromisoformat(
                    rec.get("timestamp", "").replace("Z", "+00:00")
                )
            except ValueError:
                tally["undated records"] += 1
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
    """Count Bash tool calls per pattern per local day.

    What runs heavily on this machine is a fact about the workload, not the
    hardware, and it is what a move to hosted runners would have to absorb.

    `tally` is the caller's accumulator: skips are counted into it as
    `headroom_readings` counts them (#1274).
    """
    compiled = {k: re.compile(v) for k, v in patterns.items()}
    per_day = collections.defaultdict(collections.Counter)
    for path in _transcript_files(corpus):
        # Cheap prefilter before the JSON parse: most records are not tool
        # calls at all. Matches the bare quoted name rather than
        # `"name":"Bash"`, so a corpus written with spaces after the colon is
        # not silently skipped.
        for rec in tc.records(path, tally, needle='"Bash"'):
            try:
                when = dt.datetime.fromisoformat(
                    rec.get("timestamp", "").replace("Z", "+00:00")
                )
            except ValueError:
                tally["undated records"] += 1
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
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--corpus", help="one transcripts directory; default every seat root"
    )
    ap.add_argument("--syslogs", default=DEFAULT_SYSLOGS)
    ap.add_argument(
        "--days",
        type=int,
        # The seven days mantahostels#1127 measured.
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

    # --- 1. earlyoom kills ---
    tally = collections.Counter()
    kills = []
    for line in read_syslogs(tally, args.syslogs):
        if k := parse_earlyoom_kill(line):
            kills.append(k)
        elif _EARLYOOM.match(line):
            tally["undated kills"] += 1
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

    # --- 2. headroom ---
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

    # --- 3. concurrency ---
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

    # --- 4. heavy local work ---
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
