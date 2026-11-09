"""Tests for scripts/guest_reclaim.py — the guest page-cache reclaimer (#4791).

Each tick case writes a literal minute log and drives a fake cgroup, so no case
touches /sys or /proc. Loosen one and a pass runs on a stale or healthy Windows
reading, runs twice on one reading, overshoots its deficit, or keeps evicting
while the guest stalls or re-reads what it evicted.
"""

import errno
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import NamedTuple

import pytest

import guest_reclaim as g

T0 = 1_800_000_000
MIB = g.MIB
HERE = Path(__file__).resolve().parent


def _ts(t):
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%S+0000")


class FakeCgroup(g.Cgroup):
    """A cgroup whose stall and refault counters grow at a set rate per second of
    the fake clock, plus whatever a step adds; each reclaim write takes 0.4 s."""

    def __init__(self):
        self.t = 0.0
        self.file = 4000 * MIB
        self.stall = 0
        self.refaults = 0
        self.stall_per_s = 20_000  # 2% of wall time
        self.refaults_per_s = 500
        self.writes = []
        self.eagain_on = None
        self.fail_on = None
        self.step_stall = 0
        self.step_refaults = 0

    def clock(self):
        return self.t

    def sleep(self, s):
        self.t += s
        self.stall += int(self.stall_per_s * s)
        self.refaults += int(self.refaults_per_s * s)

    def reclaim(self, nbytes):
        self.writes.append(nbytes)
        self.sleep(0.4)
        if len(self.writes) == self.fail_on:
            raise OSError(errno.EBUSY, "Device or resource busy")
        if len(self.writes) == self.eagain_on:
            self.file -= nbytes // 2
            raise OSError(errno.EAGAIN, "Resource temporarily unavailable")
        self.file -= nbytes
        self.stall += self.step_stall
        self.refaults += self.step_refaults

    def stat(self, key):
        return {"file": self.file, "workingset_refault_file": self.refaults}[key]

    def stall_us(self):
        return self.stall


class Box(NamedTuple):
    """`line` appends a minute line, `tick` fires the timer once against `cg`,
    `records` reads the pass log back."""

    line: object
    tick: object
    records: object
    cg: FakeCgroup


@pytest.fixture
def box(tmp_path):
    minute = tmp_path / "minute.jsonl"
    log = tmp_path / "reclaim.jsonl"
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal: 10000000 kB\nMemFree:  1314000 kB\n")
    cg = FakeCgroup()

    def line(t, win, *, age=5, mem=4000, psi=0.5):
        with minute.open("a") as f:
            f.write(
                json.dumps(
                    {
                        "ts": _ts(t),
                        "win_avail_mb": win,
                        "win_age_s": age,
                        "mem_avail_mb": mem,
                        "psi_mem_some": psi,
                    }
                )
                + "\n"
            )

    def tick(now):
        return g.tick(
            minute,
            log,
            now,
            cgroup=cg,
            meminfo=meminfo,
            clock=cg.clock,
            sleep=cg.sleep,
        )

    def records():
        return (
            [json.loads(r) for r in log.read_text().splitlines()]
            if log.exists()
            else []
        )

    return Box(line, tick, records, cg)


def test_a_pass_reclaims_the_deficit_in_steps(box):
    line, tick, records, cg = box
    line(T0, 952, mem=5591)
    assert tick(T0 + 10) == ["pass"]
    # 2,000 − 952 = 1,048 MiB: four full steps and the 24 MiB left.
    assert cg.writes == [256 * MIB] * 4 + [24 * MIB]
    [rec] = records()
    assert rec["kind"] == "pass"
    assert rec["stop"] == "met"
    assert rec["win_avail_mb"] == 952
    assert rec["deficit_bytes"] == rec["asked_bytes"] == 1048 * MIB
    assert rec["reclaimed_bytes"] == 1048 * MIB
    assert rec["mem_free_mb_after"] == 1283


def test_eagain_ends_the_pass(box):
    line, tick, records, cg = box
    cg.eagain_on = 2
    line(T0, 952)
    tick(T0 + 10)
    assert len(cg.writes) == 2
    rec = records()[0]
    assert rec["stop"] == "eagain"
    assert rec["reclaimed_bytes"] == 384 * MIB


def test_another_write_error_logs_the_pass_then_raises(box):
    line, tick, records, cg = box
    cg.fail_on = 3
    line(T0, 952)
    with pytest.raises(OSError):
        tick(T0 + 10)
    rec = records()[0]
    assert rec["stop"] == "EBUSY"
    assert rec["asked_bytes"] == 768 * MIB
    assert rec["reclaimed_bytes"] == 512 * MIB


def test_a_sample_taken_before_the_freed_pages_reach_windows_is_no_after(box):
    line, tick, records, _cg = box
    line(T0, 900)
    tick(T0 + 10)
    # The pass ran 3 s (1 s baseline, five 0.4 s steps), so its pages reach
    # Windows at T0 + 15; a sample taken at T0 + 14 predates them.
    line(T0 + 60, 900, age=46)
    assert tick(T0 + 61) == []
    line(T0 + 120, 2600, age=104)
    assert tick(T0 + 121) == ["after"]
    assert records()[-1]["win_avail_mb"] == 2600


def test_a_rise_in_memory_stall_ends_the_pass(box):
    line, tick, records, cg = box
    # 0.4 s step, 2% baseline: 0.12 s more stall is a 30-point rise.
    cg.step_stall = 120_000
    line(T0, 952)
    tick(T0 + 10)
    assert len(cg.writes) == 1
    assert records()[0]["stop"] == "stall"


def test_a_stall_under_the_rise_does_not(box):
    line, tick, records, cg = box
    # 0.02 s more over 0.4 s: a 5-point rise, under STALL_RISE.
    cg.step_stall = 20_000
    line(T0, 952)
    tick(T0 + 10)
    assert records()[0]["stop"] == "met"


def test_climbing_refaults_end_the_pass(box):
    line, tick, records, cg = box
    # Baseline 500/s; the limit is 2 × 500 + 1,024 = 2,024/s, 810 in a 0.4 s step.
    cg.step_refaults = 1_000
    line(T0, 952)
    tick(T0 + 10)
    assert len(cg.writes) == 1
    assert records()[0]["stop"] == "refault"


def test_no_pass_at_or_over_the_trigger(box):
    line, tick, records, cg = box
    line(T0, g.TRIGGER_MB)
    assert tick(T0 + 10) == []
    assert cg.writes == []


def test_no_pass_on_a_stale_windows_sample(box):
    line, tick, _records, cg = box
    line(T0, 900, age=100)
    assert tick(T0 + g.MAX_SAMPLE_AGE_S - 99) == []
    assert cg.writes == []


def test_no_pass_on_a_null_windows_reading(box):
    line, tick, _records, cg = box
    line(T0, None)
    assert tick(T0 + 10) == []
    assert cg.writes == []


def test_a_reading_taken_before_the_last_pass_runs_no_second(box):
    line, tick, records, cg = box
    line(T0, 900)
    tick(T0 + 10)
    # The next minute line, but its Windows sample predates the pass.
    line(T0 + 60, 900, age=55)
    assert tick(T0 + 61) == []
    line(T0 + 120, 1500, age=5)
    assert tick(T0 + 121) == ["after", "pass"]
    kinds = [r["kind"] for r in records()]
    assert kinds == ["pass", "after", "pass"]
    after = records()[1]
    assert after["pass"] == records()[0]["ts"]
    assert after["win_avail_mb"] == 1500


def test_after_is_logged_once(box):
    line, tick, records, _cg = box
    line(T0, 900)
    tick(T0 + 10)
    line(T0 + 120, 2600, age=5)
    assert tick(T0 + 121) == ["after"]
    assert tick(T0 + 122) == []
    assert [r["kind"] for r in records()] == ["pass", "after"]


def test_a_torn_last_line_reads_the_one_before(box, tmp_path):
    line, tick, _records, _cg = box
    line(T0, 900)
    with (tmp_path / "minute.jsonl").open("a") as f:
        f.write('{"ts": "2026-')
    assert tick(T0 + 10) == ["pass"]


def test_the_cgroup_reader_parses_the_kernel_files(tmp_path):
    (tmp_path / "memory.stat").write_text(
        "anon 1\nfile 3802972160\nworkingset_refault_file 10258902\n"
    )
    (tmp_path / "memory.pressure").write_text(
        "some avg10=0.13 avg60=0.61 avg300=0.30 total=33847053\n"
        "full avg10=0.11 avg60=0.48 avg300=0.25 total=19560236\n"
    )
    (tmp_path / "memory.reclaim").write_text("")
    cg = g.Cgroup(tmp_path)
    assert cg.stat("file") == 3802972160
    assert cg.stat("workingset_refault_file") == 10258902
    assert cg.stall_us() == 33847053
    cg.reclaim(256 * MIB)
    assert (tmp_path / "memory.reclaim").read_text() == "268435456 swappiness=0"


LIVE_CGROUP = g.user_cgroup()


@pytest.mark.skipif(
    not (LIVE_CGROUP / "memory.stat").exists(), reason="no user cgroup here"
)
def test_the_readers_parse_the_live_cgroup_and_meminfo():
    # Reads only: a mark and MemFree, no reclaim write.
    start = g.Cgroup(LIVE_CGROUP).mark(lambda: 0.0)
    assert start.stall_us >= 0
    assert start.refaults >= 0
    assert g.mem_free_mb("/proc/meminfo") > 0


def test_a_minute_line_with_an_unreadable_ts_is_no_reading_and_says_so(capsys):
    line = {"ts": "yesterday", "win_avail_mb": 900, "win_age_s": 5}
    assert g.win_sample(line) is None
    assert "unreadable minute-line ts" in capsys.readouterr().err


def test_report_counts_minutes_under_the_trigger(box, tmp_path):
    line, _tick, _records, _cg = box
    line(T0, 1500, psi=1.0)
    line(T0 + 60, 2500, psi=3.0)
    line(T0 + 120, None)
    line(T0 + 180, 900, psi=5.0)
    out = g.report(tmp_path / "minute.jsonl", T0, T0 + 180)
    assert out == {"minutes": 2, "under_trigger_pct": 50.0, "psi_mem_some_mean": 2.0}


def test_cli_tick_with_no_minute_log_does_nothing(tmp_path):
    run = subprocess.run(
        [
            sys.executable,
            str(HERE / "guest_reclaim.py"),
            "tick",
            "--minute-log",
            str(tmp_path / "none"),
            "--log",
            str(tmp_path / "log"),
            "--cgroup",
            str(tmp_path / "cg"),
        ],
        capture_output=True,
        text=True,
    )
    assert run.returncode == 0, run.stderr
    assert "no minute log" in run.stderr
    assert not (tmp_path / "log").exists()


def test_install_copies_the_script_writes_both_units_and_enables_the_timer(
    tmp_path, stub_bin
):
    systemctl, calls = stub_bin("systemctl", "active\n")
    home = tmp_path / "home"
    env = {**os.environ, "HOME": str(home), "WFC_SYSTEMCTL": systemctl}
    env.pop("XDG_CONFIG_HOME", None)
    done = subprocess.run(
        [sys.executable, str(HERE / "guest_reclaim.py"), "install"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert done.returncode == 0, done.stderr
    installed = home / ".local/lib/workflow-core/guest_reclaim.py"
    assert installed.read_text() == (HERE / "guest_reclaim.py").read_text()
    # The copy reads the minute log through its own lib/ at run time.
    assert (home / ".local/lib/workflow-core/lib/memwatch_minute.py").read_text() == (
        HERE / "lib/memwatch_minute.py"
    ).read_text()
    units = home / ".config/systemd/user"
    # Rendered from scripts/guest-reclaim.service.template and scripts/guest-reclaim.timer.template.
    service = (units / "guest-reclaim.service").read_text()
    # The unit runs the installed copy, which outlives any worktree.
    assert f'"{installed}" tick' in service
    assert f'--log "{home / "guest-reclaim.jsonl"}"' in service
    uid = os.getuid()
    assert (
        f'--cgroup "/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service"'
        in service
    )
    assert "@SCRIPT@" not in service
    assert (units / "guest-reclaim.timer").exists()
    assert calls() == [
        "--user daemon-reload",
        "--user enable --now guest-reclaim.timer",
        "--user is-active guest-reclaim.timer",
    ]


def test_install_names_the_rerun_when_systemctl_fails(tmp_path):
    env = {**os.environ, "HOME": str(tmp_path / "home"), "WFC_SYSTEMCTL": "false"}
    env.pop("XDG_CONFIG_HOME", None)
    done = subprocess.run(
        [sys.executable, str(HERE / "guest_reclaim.py"), "install"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert done.returncode == 1
    assert "re-run: python3 scripts/guest_reclaim.py install" in done.stderr
