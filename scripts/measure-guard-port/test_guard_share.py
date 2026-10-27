"""Pins guard_share.py's classing and ratio, the figure a guard port's 59% stop
rule is read on (#2733, #2783).

A call misclassed as a guard inflates the share a port is judged against; one
missed deflates it.
"""

import json
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from guard_share import classify, summarise, vitest_tests_seconds

HERE = Path(__file__).parent


def rec(file, *args, ms=10.0):
    return {"kind": "spawnSync", "file": file, "args": list(args), "ms": ms}


START = {"kind": "start", "pid": 1}
VITEST = "\x1b[2m Tests \x1b[22m 12 passed (12)\n Duration 3.10s (transform 20ms, tests 2.00s)\n"


def test_a_script_path_or_a_bash_running_one_is_a_guard_call():
    assert classify(rec("/r/scripts/guard-x.sh")) == "guard-sh"
    assert classify(rec("bash", "/r/scripts/guard-x.sh")) == "guard-sh"
    assert (
        classify(rec("/bin/bash", "-c", "source scripts/lib/guard-log.sh; f"))
        == "guard-sh"
    )


def test_a_bash_that_runs_no_script_is_not_a_guard_call():
    assert classify(rec("bash", "-c", "echo hi")) == "bash-other"


def test_the_tests_own_git_and_node_calls_are_their_own_classes():
    assert classify(rec("git", "init")) == "git"
    assert classify(rec("/usr/local/bin/node", "x.js")) == "node"
    assert classify(rec("jq", ".")) == "other:jq"


def test_vitest_tests_seconds_reads_seconds_and_milliseconds():
    assert vitest_tests_seconds(VITEST) == 2.0
    assert vitest_tests_seconds("Duration 1s (tests 500ms)") == 0.5
    assert math.isnan(vitest_tests_seconds("no summary"))


def test_the_share_is_guard_wall_over_the_files_tests_time():
    calls = [rec("/r/a.sh", ms=600), rec("/r/b.sh", ms=400), rec("git", ms=200)]
    out = summarise([START, *calls], VITEST)
    assert out["guard_runs"] == 2
    assert out["guard_share"] == 0.5
    assert out["all_spawn_share"] == 0.6
    assert out["sum_s"]["git"] == 0.2
    assert out["tests"] == "12 passed (12)"
    assert out["instrumented"]


def test_a_record_with_no_wall_is_skipped():
    out = summarise([START, rec("/r/a.sh", ms=200)], VITEST)
    assert out["guard_runs"] == 1
    assert out["guard_share"] == 0.1


def test_a_log_with_no_start_record_is_not_instrumented():
    assert not summarise([rec("/r/a.sh")], VITEST)["instrumented"]


def test_sum_prints_the_share_and_refuses_a_log_the_preload_never_wrote(tmp_path):
    vitest = tmp_path / "vitest.txt"
    vitest.write_text(VITEST)
    log = tmp_path / "calls.jsonl"
    log.write_text(json.dumps(START) + "\n" + json.dumps(rec("/r/a.sh", ms=500)) + "\n")
    ok = subprocess.run(
        [sys.executable, str(HERE / "guard_share.py"), "sum", str(log), str(vitest)],
        capture_output=True,
        text=True,
    )
    assert ok.returncode == 0
    assert json.loads(ok.stdout)["guard_share"] == 0.25
    missing = subprocess.run(
        [
            sys.executable,
            str(HERE / "guard_share.py"),
            "sum",
            str(tmp_path / "none"),
            str(vitest),
        ],
        capture_output=True,
        text=True,
    )
    assert missing.returncode == 1
    assert json.loads(missing.stdout)["instrumented"] is False
