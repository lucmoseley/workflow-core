"""Tests for scripts/fault_bench.py — #3246's bench at 28 h uptime (#4768).

Each run case points the script at literal /proc stand-ins and a temp log, and
benches `true` in place of python.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import fault_bench as f

HERE = Path(__file__).resolve().parent
TRUE = shutil.which("true")


@pytest.fixture
def box(tmp_path):
    uptime = tmp_path / "uptime"
    meminfo = tmp_path / "meminfo"
    boot_id = tmp_path / "boot_id"
    log = tmp_path / "fault-bench.log"
    minute = tmp_path / "minute.jsonl"
    boot_id.write_text("abcdef12-3456\n")
    (tmp_path / "Users/luc").mkdir(parents=True)
    wslconfig = tmp_path / "Users/luc/.wslconfig"
    wslconfig.write_text(
        "[wsl2]\nmemory=10GB\n[experimental]\nautoMemoryReclaim=disabled\n"
    )

    def run(up_s, avail_mb):
        uptime.write_text(f"{up_s} 1.00\n")
        meminfo.write_text(
            f"MemTotal: 10000000 kB\nMemAvailable: {avail_mb * 1024} kB\n"
        )
        return f.run(
            log,
            minute,
            uptime=uptime,
            meminfo=meminfo,
            boot_id=boot_id,
            wslconfigs=str(tmp_path / "Users/*/.wslconfig"),
            python=TRUE,
        )

    def lines():
        return log.read_text().splitlines() if log.exists() else []

    return run, lines, boot_id, log, minute


def test_benches_at_28_h_and_1900_mb(box):
    run, lines, *_ = box
    line = run(100_800, 1_900)
    assert lines() == [line]
    assert " boot abcdef12 up since " in line
    assert (
        "(28.0 h), reclaim disabled, MemAvailable 1,900 MB, Windows unread: 1 x 100 MB: "
        in line
    )
    assert line.count(" x 100 MB: ") == 5
    assert f.NO_BENCH not in line


def test_no_bench_under_1900_mb_and_the_next_firing_retries(box):
    run, lines, *_ = box
    first = run(200_000, 1_899)
    assert first.endswith(f"{f.NO_BENCH}: needs 28 h up and 1,900 MB available")
    second = run(200_900, 4_000)
    assert lines() == [first, second]
    assert f.NO_BENCH not in second


def test_no_bench_under_28_h(box):
    run, *_ = box
    assert f.NO_BENCH in run(100_799, 8_000)


def test_a_failed_allocation_is_named(box, tmp_path):
    run, *_ = box
    false = shutil.which("false")
    up, mem = tmp_path / "uptime", tmp_path / "meminfo"
    up.write_text("100800 1.00\n")
    mem.write_text("MemAvailable: 4096000 kB\n")
    line = f.run(
        tmp_path / "log",
        tmp_path / "none",
        uptime=up,
        meminfo=mem,
        boot_id=tmp_path / "boot_id",
        wslconfigs=str(tmp_path / "none/*"),
        python=false,
    )
    assert "8 x 100 MB: " in line and "(8 failed)" in line


def test_the_proc_readers_parse_the_real_files():
    for path in (f.UPTIME, f.MEMINFO, f.BOOT_ID):
        if not Path(path).exists():
            pytest.skip(f"no {path}")
    assert f.read_uptime_s() > 0
    assert f.read_avail_mb() > 0
    assert len(f.read_boot_id()) == 8


def test_reclaim_reads_unread_with_no_file_or_two_that_disagree(tmp_path):
    assert f.reclaim_mode(str(tmp_path / "*/.wslconfig")) == "unread"
    for user, mode in (("a", "disabled"), ("b", "gradual")):
        (tmp_path / user).mkdir()
        (tmp_path / user / ".wslconfig").write_text(f"autoMemoryReclaim = {mode}\n")
    assert f.reclaim_mode(str(tmp_path / "*/.wslconfig")) == "unread"
    (tmp_path / "b/.wslconfig").write_text("AutoMemoryReclaim=disabled\n")
    assert f.reclaim_mode(str(tmp_path / "*/.wslconfig")) == "disabled"


def test_one_bench_a_boot(box):
    run, lines, boot_id, *_ = box
    run(100_800, 4_000)
    assert run(110_000, 4_000) is None
    boot_id.write_text("99999999-0000\n")
    assert run(100_800, 4_000) is not None
    assert len(lines()) == 2


def test_windows_figure_reads_memwatch_and_skips_a_torn_line(box):
    run, _, _, _, minute = box
    minute.write_text(
        json.dumps(
            {"ts": "2026-11-09T20:16:08+0800", "win_avail_mb": 2239, "win_age_s": 63}
        )
        + '\n{"ts": "2026-11-09T20:1'
    )
    assert ", Windows 2,239 MB (" in run(100_800, 4_000)


def test_install_copies_the_script_writes_both_units_and_enables_the_timer(
    tmp_path, stub_bin
):
    systemctl, calls = stub_bin("systemctl", "active\n")
    home = tmp_path / "home"
    env = {**os.environ, "HOME": str(home), "WFC_SYSTEMCTL": systemctl}
    env.pop("XDG_CONFIG_HOME", None)
    done = subprocess.run(
        [sys.executable, str(HERE / "fault_bench.py"), "install"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert done.returncode == 0, done.stderr
    installed = home / ".local/lib/workflow-core/fault-bench/fault_bench.py"
    assert installed.read_text() == (HERE / "fault_bench.py").read_text()
    # The copy reads the minute log through its own lib/ at run time.
    assert (
        home / ".local/lib/workflow-core/fault-bench/lib/memwatch_minute.py"
    ).exists()
    units = home / ".config/systemd/user"
    service = (units / "fault-bench.service").read_text()
    # The unit runs the installed copy, which outlives any worktree.
    assert f'"{installed}" run --log "{home / "fault-bench.log"}"' in service
    assert "@" not in service
    # Rendered from scripts/fault-bench.service.template and scripts/fault-bench.timer.template.
    assert "OnBootSec=100800s" in (units / "fault-bench.timer").read_text()
    assert calls() == [
        "--user daemon-reload",
        "--user enable --now fault-bench.timer",
        "--user is-active fault-bench.timer",
    ]


def test_install_names_the_rerun_when_systemctl_fails(tmp_path):
    env = {**os.environ, "HOME": str(tmp_path), "WFC_SYSTEMCTL": "false"}
    env.pop("XDG_CONFIG_HOME", None)
    done = subprocess.run(
        [sys.executable, str(HERE / "fault_bench.py"), "install"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert done.returncode == 1
    assert "re-run: python3 scripts/fault_bench.py install" in done.stderr
