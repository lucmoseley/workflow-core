import json
import subprocess
import sys
from pathlib import Path

import pytest

import bench_idle_watcher as bw

REPO = Path(__file__).resolve().parent.parent

IGNORES_TERM = (
    "import signal, time\n"
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    "print('ready', flush=True)\n"
    "time.sleep(60)\n"
)


@pytest.fixture
def child():
    procs = []

    def spawn(code):
        p = subprocess.Popen(
            [sys.executable, "-c", code],
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        procs.append(p)
        assert p.stdout.readline() == "ready\n"
        return p

    yield spawn
    for p in procs:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_resting_rss_summarises_the_trees_readings():
    readings = iter([(100.0, 1), (300.0, 3), (200.0, 1)])
    clock = iter([0, 0, 1, 2, 3])
    rest = bw.resting_rss(
        lambda: next(readings), 3, clock=lambda: next(clock), sleep=lambda s: None
    )
    assert rest == {"rss_mean_mb": 200.0, "rss_max_mb": 300.0, "pids": 3}


def test_the_heap_matches_package_jsons_watch_script():
    scripts = json.loads((REPO / "package.json").read_text())["scripts"]
    assert scripts["test:watch"] == f"NODE_OPTIONS={bw.NODE_HEAP} vitest"


def test_the_first_run_cap_is_the_suite_ceiling():
    source = (REPO / "scripts/lib/suite-ceiling.js").read_text()
    ms = f"{bw.FIRST_RUN_MAX_S * 1000:_}"
    assert f"const CEILING_MS = {ms};" in source


# #5652
def test_close_kills_a_group_that_ignores_sigterm(child, capsys):
    p = child(IGNORES_TERM)
    bw.close_group(p, 0.2)
    assert p.returncode == -9
    assert "fail-open: SIGKILL the watcher's group" in capsys.readouterr().err


def test_close_passes_over_a_group_already_gone(child, capsys):
    p = child("print('ready', flush=True)\n")
    p.wait()
    bw.close_group(p, 0.2)
    assert capsys.readouterr().err == ""
