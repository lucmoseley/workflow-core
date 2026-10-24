"""Tests for scan_machine.py and sample_load.py — the machine-binding scan
behind mantahostels#1127. Each test pins one distinction a figure in
https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/machine-binding-constraints.md rests on, bar one that pins
sample_load's `ps` to the §N7 seam (#1325).

The parsers are fed literal earlyoom, `free` and `/proc` lines, transcripts
and `/proc` files are written under `tmp_path`, and `ps` is a stub through
`WFC_PS`, so nothing reads this machine's live state or real corpus.

CI's pytest step runs this file; the scan gates
nothing and is run by hand. Breaking it can misread a bystander kill as a lost
session or MemFree as headroom, misdirecting the call on whether the 10 GB
machine or the token allowance binds the work."""

import datetime as dt
import json
import os
import sys
from collections import Counter

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from scan_machine import (  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)
    SGT,
    billed_minutes,
    concurrency_timeline,
    free_available_mb,
    parse_earlyoom_kill,
    percentiles,
    threshold_shares,
)


# --- earlyoom parsing -------------------------------------------------------


def test_parse_earlyoom_kill_reads_victim_and_rss():
    line = (
        "2026-08-18T15:00:04.123456+08:00 Luctop earlyoom[853]: sending SIGTERM "
        'to process 3487996 uid 1000 "2.1.234": badness 700, VmRSS 5638 MiB'
    )
    hit = parse_earlyoom_kill(line)
    assert hit is not None
    assert hit.name == "2.1.234"
    assert hit.rss_mib == 5638
    assert hit.when.date() == dt.date(2026, 8, 18)


def test_parse_earlyoom_kill_ignores_the_startup_banner():
    """`sending SIGTERM when mem <= 8.00%` is configuration, not a kill.

    Counting it inflates the kill tally roughly threefold — the banner is
    printed on every earlyoom start, and this machine reboots often.
    """
    line = (
        "2026-08-21T08:29:38.912679+08:00 Luctop earlyoom[1332]: sending SIGTERM "
        "when mem <=  8.00% and swap <= 100.00%,"
    )
    assert parse_earlyoom_kill(line) is None


def test_parse_earlyoom_kill_reads_sigkill_too():
    line = (
        "2026-08-19T02:00:00.000000+08:00 Luctop earlyoom[1]: sending SIGKILL "
        'to process 42 uid 1000 "claude.exe": badness 900, VmRSS 7142 MiB'
    )
    hit = parse_earlyoom_kill(line)
    assert hit is not None
    assert hit.rss_mib == 7142


def test_parse_earlyoom_kill_ignores_unrelated_lines():
    assert parse_earlyoom_kill("2026-08-19T02:00:00+08:00 Luctop kernel: hello") is None


def test_a_bystander_kill_is_not_a_lost_session():
    """The recorder and `(sd-pam)` are collateral, not work the machine stopped.

    They are killed at 1-3 MiB. Counting them as sessions doubles the tally
    and would make the machine look like it stops work twice as often as it
    does.
    """
    small = parse_earlyoom_kill(
        "2026-08-19T02:00:00.0+08:00 L earlyoom[1]: sending SIGTERM to process 1 "
        'uid 1000 "memwatch.sh": badness 733, VmRSS 3 MiB'
    )
    big = parse_earlyoom_kill(
        "2026-08-19T02:00:00.0+08:00 L earlyoom[1]: sending SIGTERM to process 2 "
        'uid 1000 "2.1.234": badness 700, VmRSS 613 MiB'
    )
    assert small.is_session is False
    assert big.is_session is True


# --- free(1) parsing --------------------------------------------------------


def test_free_available_mb_reads_the_available_column():
    """`available`, never `free` — `free` counts reclaimable cache as spent."""
    text = (
        "               total        used        free      shared  buff/cache   available\n"
        "Mem:            9924        6655         388           2        3144        3268\n"
        "Swap:           2048         422        1625\n"
    )
    assert free_available_mb(text) == [3268]


def test_free_available_mb_ignores_a_different_machine_total():
    """A reading off the retired 7,924 MiB cap is not comparable."""
    text = "Mem:            7924        6000         100           2        1800        1500\n"
    assert free_available_mb(text, total_mb=9924) == []


def test_free_available_mb_finds_every_reading_in_a_blob():
    text = "Mem: 9924 1 2 3 4 3268\nnoise\nMem: 9924 1 2 3 4 1016\n"
    assert free_available_mb(text) == [3268, 1016]


# --- concurrency ------------------------------------------------------------


def _t(h, m=0):
    return dt.datetime(2026, 8, 20, h, m, tzinfo=SGT)


def test_concurrency_timeline_counts_overlapping_spans():
    spans = [(_t(1), _t(4)), (_t(2), _t(5)), (_t(6), _t(7))]
    tl = concurrency_timeline(spans)
    peak = max(c for _, _, c in tl)
    assert peak == 2


def test_concurrency_timeline_is_time_weighted_not_sample_counted():
    """One long quiet stretch must outweigh a brief burst.

    Counting samples instead of seconds is what turns a 16-session peak that
    lasted seconds into a claim that the machine runs 16 sessions.
    """
    spans = [(_t(0), _t(10)), (_t(9), _t(9, 6))]
    tl = concurrency_timeline(spans)
    at_one = sum((b - a).total_seconds() for a, b, c in tl if c == 1)
    at_two = sum((b - a).total_seconds() for a, b, c in tl if c == 2)
    assert at_one > at_two * 50


def test_concurrency_timeline_handles_no_spans():
    assert concurrency_timeline([]) == []


# --- summary helpers --------------------------------------------------------


def test_percentiles_are_nearest_rank_not_interpolated():
    assert percentiles([1, 2, 3, 4, 5], [0.5]) == {0.5: 3}


def test_threshold_shares_count_strictly_below():
    """A reading exactly at the gate admits the suite; it is not a refusal."""
    shares = threshold_shares([2999, 3000, 3001], {"gate": 3000})
    assert shares["gate"] == (1, pytest.approx(1 / 3))


# --- Actions billing --------------------------------------------------------


def test_billed_minutes_rounds_each_job_up_separately():
    """GitHub bills per job per started minute, so two 30s jobs cost 2, not 1.

    Summing seconds first and rounding once halves the estimate for this
    repo's CI, whose two jobs are both under a minute.
    """
    assert billed_minutes([30, 30]) == 2


def test_billed_minutes_charges_a_whole_minute_for_a_one_second_job():
    assert billed_minutes([1]) == 1


def test_billed_minutes_of_nothing_is_nothing():
    assert billed_minutes([]) == 0


# --- the seams that produce the headline numbers ----------------------------


def _free(avail):
    """`free -m` output as a session actually records it — header row included.

    The header matters: `Mem:` only starts a line because something precedes
    it, and the extractor anchors on line start deliberately so a stray
    "Mem:" inside prose cannot be read as a reading.
    """
    return (
        "               total        used        free      shared  buff/cache   available\n"
        f"Mem:            9924        6655         388           2        3144        {avail}\n"
        "Swap:           2048         422        1625\n"
    )


FREE_OUTPUT = _free(3268)


def _write_transcript(tmp_path, name, records):
    p = tmp_path / name
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return p


def test_headroom_readings_finds_free_output_inside_a_tool_result(tmp_path):
    """The readings live inside JSON string fields, escaped, not as raw lines.

    This is the seam the 1,207-reading headline comes from, and it is the one
    place a transcript's `\\n` escaping has to be undone before the `free -m`
    regex can match a line at all.
    """
    from scan_machine import headroom_readings

    _write_transcript(
        tmp_path,
        "a.jsonl",
        [
            {
                "timestamp": "2026-08-22T00:00:00.000Z",
                "message": {"content": FREE_OUTPUT},
            }
        ],
    )
    assert headroom_readings(str(tmp_path), Counter()) == [3268]


def test_headroom_readings_respects_the_since_cutoff(tmp_path):
    from scan_machine import headroom_readings

    _write_transcript(
        tmp_path,
        "a.jsonl",
        [
            {
                "timestamp": "2020-01-01T00:00:00.000Z",
                "message": {"content": _free(999)},
            },
            {
                "timestamp": "2026-08-22T00:00:00.000Z",
                "message": {"content": _free(3268)},
            },
        ],
    )
    cut = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    assert headroom_readings(str(tmp_path), Counter(), since=cut) == [3268]


def test_headroom_readings_counts_one_reading_per_record_not_per_file(tmp_path):
    """Two `free -m` calls in one session are two observations, not one.

    Collapsing them would silently shrink n and, because a busy session runs
    `free -m` more often, would drop exactly the crowded moments the
    distribution exists to capture.
    """
    from scan_machine import headroom_readings

    _write_transcript(
        tmp_path,
        "a.jsonl",
        [
            {
                "timestamp": "2026-08-22T00:00:00.000Z",
                "message": {"content": _free(3268)},
            },
            {
                "timestamp": "2026-08-22T00:01:00.000Z",
                "message": {"content": _free(1016)},
            },
        ],
    )
    assert sorted(headroom_readings(str(tmp_path), Counter())) == [1016, 3268]


def test_scan_bash_commands_counts_tool_calls_by_local_day(tmp_path):
    from scan_machine import scan_bash_commands

    _write_transcript(
        tmp_path,
        "a.jsonl",
        [
            {
                "timestamp": "2026-08-22T02:00:00.000Z",  # 10:00 SGT
                "message": {
                    "content": [
                        {"name": "Bash", "input": {"command": "npm run test"}},
                        {"name": "Bash", "input": {"command": "npm run typecheck"}},
                    ]
                },
            }
        ],
    )
    out = scan_bash_commands(str(tmp_path), {"t": r"npm run test\b"}, Counter())
    assert out[dt.date(2026, 8, 22)]["t"] == 1


def test_scan_bash_commands_ignores_a_non_bash_block(tmp_path):
    """A Read or Edit block carries no command and must not be counted."""
    from scan_machine import scan_bash_commands

    _write_transcript(
        tmp_path,
        "a.jsonl",
        [
            {
                "timestamp": "2026-08-22T02:00:00.000Z",
                "message": {
                    "content": [{"name": "Read", "input": {"command": "npm run test"}}]
                },
            }
        ],
    )
    assert scan_bash_commands(str(tmp_path), {"t": r"npm run test\b"}, Counter()) == {}


# --- the live sampler -------------------------------------------------------


def test_cpu_totals_excludes_iowait(tmp_path):
    """A process blocked on disk is not one the cores are refusing to run.

    Folding `iowait` into busy reads as CPU pressure that no extra core would
    relieve — the opposite of what this measurement is for.
    """
    from sample_load import cpu_totals

    p = tmp_path / "stat"
    p.write_text("cpu  100 0 100 800 5000 0 0 0 0 0\nintr 1\n")
    busy, total = cpu_totals(str(p))
    assert (busy, total) == (200, 1000)


def test_available_mb_reads_memavailable_not_memfree(tmp_path):
    from sample_load import available_mb

    p = tmp_path / "meminfo"
    p.write_text(
        "MemTotal: 10162176 kB\nMemFree: 102400 kB\nMemAvailable: 3348480 kB\n"
    )
    assert available_mb(str(p)) == 3270


def test_available_mb_is_none_when_the_file_will_not_say(tmp_path):
    from sample_load import available_mb

    p = tmp_path / "meminfo"
    p.write_text("MemTotal: 10162176 kB\n")
    assert available_mb(str(p)) is None


def test_count_claude_matches_the_versioned_binary_a_resumed_session_runs():
    """`comm` is the version string for a backgrounded session (mantahostels#481).

    Matching on the bare name alone finds no resumed session at all, so the
    count silently loses one live session per resume.
    """
    from sample_load import count_claude

    ps = "\n".join(
        [
            "10 1 claude bg-pty-host --x",
            "11 10 /home/l/.local/share/claude/versions/2.1.241 --bg",
            "12 1 /home/l/.local/bin/claude",
            "13 1 claude",
            "14 1 grep claude bg-pty-host",
            "15 1 sshd: lucmo",
        ]
    )
    sessions, procs = count_claude(ps)
    assert sessions == 1
    assert procs == 4


def test_count_claude_leaves_out_the_daemons_unclaimed_spare():
    """The unit is lib/claude_sessions.py's, which test_claude_sessions.py pins (#1798)."""
    from sample_load import count_claude

    spare = "/tmp/cc-daemon-1000/d/spare"
    ps = "\n".join(
        [
            f"10 1 claude bg-pty-host --bg-pty-host {spare}/a.pty.sock",
            f"11 10 claude bg-spare --bg-spare {spare}/a.claim.sock",
        ]
    )
    assert count_claude(ps, {11: spare}.get) == (0, 2)


def test_the_snapshot_runs_the_ps_wfc_ps_names(stub_bin, monkeypatch):
    from sample_load import ps_snapshot

    path, calls = stub_bin("ps", "10 1 claude bg-pty-host --x\n")
    monkeypatch.setenv("WFC_PS", path)
    assert ps_snapshot() == "10 1 claude bg-pty-host --x\n"
    assert calls() == ["-eo pid=,ppid=,args="]


def test_the_default_corpus_spans_every_seat_root(seat_roots):
    import scan_machine

    roots = seat_roots(2)
    for i, r in enumerate(roots):
        (r / f"s{i}.jsonl").write_text(
            json.dumps(
                {"timestamp": f"2026-09-0{i + 1}T10:00:00Z"}, separators=(",", ":")
            )
            + "\n"
        )
    (roots[1] / "s1" / "subagents").mkdir(parents=True)
    (roots[1] / "s1" / "subagents" / "agent-x.jsonl").write_text("")
    assert len(scan_machine.transcript_spans(None, Counter(), subagents=False)) == 2
    assert scan_machine._transcript_files(None) == [
        str(roots[0] / "s0.jsonl"),
        str(roots[1] / "s1.jsonl"),
        str(roots[1] / "s1" / "subagents" / "agent-x.jsonl"),
    ]
