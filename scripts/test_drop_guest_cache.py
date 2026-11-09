"""Tests for scripts/drop_guest_cache.py — the guest page-cache drop (#4759).

Each tick case writes a literal minute log and points the drop at a temp file,
so no case touches /proc. Loosen one and the timer drops on a stale or healthy
Windows reading, drops more often than the floor, or logs an `after` taken
before its drop.
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

import drop_guest_cache as d

T0 = 1_800_000_000
HERE = Path(__file__).resolve().parent


def _ts(t):
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%S+0000")


@pytest.fixture
def box(tmp_path):
    minute = tmp_path / "minute.jsonl"
    drops = tmp_path / "drops.jsonl"
    sink = tmp_path / "drop_caches"
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal: 10000000 kB\nCached:  2048000 kB\n")

    def line(t, win, age=5, mem=4000):
        with minute.open("a") as f:
            f.write(
                json.dumps(
                    {
                        "ts": _ts(t),
                        "win_avail_mb": win,
                        "win_age_s": age,
                        "mem_avail_mb": mem,
                    }
                )
                + "\n"
            )

    def tick(now):
        return d.tick(minute, drops, now, drop_caches=sink, meminfo=meminfo)

    def records():
        return (
            [json.loads(r) for r in drops.read_text().splitlines()]
            if drops.exists()
            else []
        )

    return line, tick, records, sink


def test_drops_under_the_line_and_logs_the_before(box):
    line, tick, records, sink = box
    line(T0, 1146, mem=4658)
    assert tick(T0 + 10) == ["drop"]
    assert sink.read_text() == "1"
    [rec] = records()
    assert rec["kind"] == "drop"
    assert rec["win_avail_mb"] == 1146
    assert rec["mem_avail_mb"] == 4658
    assert rec["cached_mb_before"] == 2000


def test_no_drop_at_or_over_the_line(box):
    line, tick, records, sink = box
    line(T0, d.TRIGGER_MB)
    assert tick(T0 + 10) == []
    assert not sink.exists()


def test_no_drop_on_a_stale_windows_sample(box):
    line, tick, _records, sink = box
    line(T0, 900, age=100)
    assert tick(T0 + d.MAX_SAMPLE_AGE_S - 99) == []
    assert not sink.exists()


def test_no_drop_on_a_null_windows_reading(box):
    line, tick, _records, sink = box
    line(T0, None)
    assert tick(T0 + 10) == []
    assert not sink.exists()


def test_floor_holds_the_next_drop(box):
    line, tick, records, _sink = box
    line(T0, 900)
    tick(T0 + 10)
    line(T0 + 60, 900)
    assert "drop" not in tick(T0 + 70)
    line(T0 + d.FLOOR_S + 10, 900)
    assert "drop" in tick(T0 + d.FLOOR_S + 20)
    assert [r["kind"] for r in records()].count("drop") == 2


def test_after_waits_for_a_sample_taken_after_the_drop(box):
    line, tick, records, _sink = box
    line(T0, 900)
    tick(T0 + 10)
    # The next minute line, but its Windows sample predates the drop.
    line(T0 + 60, 2000, age=55)
    assert tick(T0 + 61) == []
    line(T0 + 120, 2600, age=5)
    assert tick(T0 + 121) == ["after"]
    assert tick(T0 + 122) == []
    after = records()[-1]
    assert after["kind"] == "after"
    assert after["drop"] == records()[0]["ts"]
    assert after["win_avail_mb"] == 2600


def test_a_torn_last_line_reads_the_one_before(box, tmp_path):
    line, tick, _records, _sink = box
    line(T0, 900)
    with (tmp_path / "minute.jsonl").open("a") as f:
        f.write('{"ts": "2026-')
    assert tick(T0 + 10) == ["drop"]


def test_cli_tick_with_no_minute_log_does_nothing(tmp_path):
    run = subprocess.run(
        [
            sys.executable,
            str(HERE / "drop_guest_cache.py"),
            "tick",
            "--minute-log",
            str(tmp_path / "none"),
            "--drop-log",
            str(tmp_path / "drops"),
        ],
        capture_output=True,
        text=True,
    )
    assert run.returncode == 0, run.stderr
    assert not (tmp_path / "drops").exists()


def _checkout(tmp_path):
    root = tmp_path / "repo"
    (root / "scripts/lib").mkdir(parents=True)
    for name in (
        "drop_guest_cache.py",
        "drop-guest-cache.service.template",
        "drop-guest-cache.timer.template",
        "lib/wfc_bin.py",
    ):
        shutil.copy(HERE / name, root / "scripts" / name)
    return root


def _install(root, target, env, *extra):
    return subprocess.run(
        [sys.executable, str(root / "scripts/drop_guest_cache.py"), "install", *extra]
        + (["--root", str(target)] if target else []),
        capture_output=True,
        text=True,
        env=env,
    )


def _env(systemctl):
    return {
        **os.environ,
        "SUDO_USER": os.environ.get("USER") or "nobody",
        "WFC_SYSTEMCTL": systemctl,
    }


def test_install_copies_the_script_writes_both_units_and_starts_the_timer(
    tmp_path, stub_bin
):
    root = _checkout(tmp_path)
    target = tmp_path / "target"
    systemctl, calls = stub_bin("systemctl", "active\n")
    env = _env(systemctl)
    run = _install(root, target, env)
    assert run.returncode == 0, run.stderr
    installed = target / str(d.INSTALLED).lstrip("/")
    assert installed.read_text() == (root / "scripts/drop_guest_cache.py").read_text()
    service = (target / "etc/systemd/system/drop-guest-cache.service").read_text()
    # Root runs the root-owned copy, never the checkout's file a session can edit.
    assert f'"{d.INSTALLED}" tick' in service
    home = Path(os.path.expanduser(f"~{env['SUDO_USER']}"))
    assert f'--minute-log "{home / "memwatch-minute.jsonl"}"' in service
    assert "@" not in service
    assert (target / "etc/systemd/system/drop-guest-cache.timer").exists()
    assert (target / str(home / "guest-cache-drops.jsonl").lstrip("/")).exists()
    assert calls() == [
        "daemon-reload",
        "enable --now drop-guest-cache.timer",
        "is-active drop-guest-cache.timer",
    ]


def test_install_names_the_rerun_when_systemctl_fails(tmp_path):
    root = _checkout(tmp_path)
    run = _install(root, tmp_path / "target", _env("false"))
    assert run.returncode == 1
    assert (
        "re-run: sudo /usr/bin/python3 scripts/drop_guest_cache.py install"
        in run.stderr
    )


def test_install_refuses_with_no_sudo_user(tmp_path):
    root = _checkout(tmp_path)
    env = {k: v for k, v in os.environ.items() if k != "SUDO_USER"}
    run = _install(root, tmp_path / "target", env)
    assert run.returncode == 2
    assert "run it as sudo /usr/bin/python3" in run.stderr


def test_install_refuses_without_root(tmp_path, stub_bin):
    root = _checkout(tmp_path)
    systemctl, calls = stub_bin("systemctl", "active\n")
    run = _install(root, None, _env(systemctl))
    assert run.returncode == 2
    assert "needs root: run it as sudo" in run.stderr
    assert calls() == []


def test_the_drop_log_is_never_written_through_a_symlink(box, tmp_path):
    line, tick, _records, _sink = box
    target = tmp_path / "elsewhere"
    target.write_text("")
    (tmp_path / "drops.jsonl").symlink_to(target)
    line(T0, 900)
    with pytest.raises(OSError):
        tick(T0 + 10)
    assert target.read_text() == ""
