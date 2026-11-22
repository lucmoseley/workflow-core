import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TORN = '{"at": "2026-10-22T'


def run(script, *args):
    return subprocess.run(
        [sys.executable, "-I", os.path.join(HERE, script), *map(str, args)],
        capture_output=True,
        text=True,
        check=True,
    )


@pytest.mark.parametrize("script", ["inherited_red.py", "survey.py"])
def test_a_torn_fail_marker_line_is_skipped_and_reported(tmp_path, script):
    row = {"at": "2026-10-22T04:00:00Z", "startedAt": "2026-10-22T03:59:00Z"}
    (tmp_path / ".test-fail-markers.jsonl").write_text(
        json.dumps(row) + "\n" + TORN + "\n"
    )
    (tmp_path / ".test-fail-markers.archive.jsonl").write_text("")
    out = run(script, tmp_path)
    store = ".test-fail-markers.jsonl"
    if script == "survey.py":
        assert f"== {store} 1 " in out.stdout
    else:
        assert "session red runs in the stretches: 0" in out.stdout
    assert "fail-open: torn line in " in out.stderr
    assert f"{store} skipped: JSONDecodeError" in out.stderr


def test_wrapper_cost_skips_and_reports_a_torn_record(tmp_path):
    logs = tmp_path / ".test-logs"
    logs.mkdir()
    rec = {"startedAt": "2026-10-22T04:00:00Z", "endedAt": "2026-10-22T04:02:00Z"}
    log = logs / "runs-s1.jsonl"
    log.write_text(json.dumps(rec) + "\n" + TORN + "\n")
    marker = {
        "sessionId": "s1",
        "startedAt": "2026-10-22T04:00:05Z",
        "at": "2026-10-22T04:01:55Z",
    }
    dump = tmp_path / "runs.jsonl"
    dump.write_text(json.dumps(marker) + "\n")
    out = run("wrapper_cost.py", tmp_path, dump)
    assert out.stdout.startswith("matched 1 runs")
    assert f"fail-open: torn line in {log} skipped: JSONDecodeError" in out.stderr
