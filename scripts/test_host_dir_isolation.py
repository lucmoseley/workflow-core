"""Pins conftest.py's empty host (#3334).

A test that drops its `CLAUDE_PROJECT_DIR` pin reads an empty temp dir that is
no repository, whether the run started under a session's live checkout or, as
in CI, with the variable unset — in process, and in a child spawned on the
inherited env. Breaking it lets such a test read the live checkout and go red
only on the founder's machine. Driven through a nested pytest loading the real
conftest.py, since the variable has to be set before the session starts.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent
CONFTEST = SCRIPTS / "conftest.py"

PROBE = f"""
import json, os, subprocess
from pathlib import Path
from host_root import host_root

def test_probe():
    host = host_root({str(REPO)!r})
    spawned = subprocess.run(
        ["node", "-e", "process.stdout.write(require({str(SCRIPTS / "lib" / "host-root.js")!r}).hostRoot())"],
        cwd={str(REPO)!r}, capture_output=True, text=True, check=True,
    ).stdout
    Path(os.environ["PROBE_OUT"], "host.json").write_text(json.dumps({{
        "host": host,
        "spawned": spawned,
        "entries": os.listdir(host),
    }}))
"""


def read_host(tmp_path, project_dir, with_conftest=True):
    """Runs the probe with `CLAUDE_PROJECT_DIR` set to `project_dir`, or unset
    for None; returns what it read."""
    (tmp_path / "test_probe.py").write_text(PROBE)
    out = tmp_path / "out"
    out.mkdir()
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(SCRIPTS), str(SCRIPTS / "lib")]),
        "PROBE_OUT": str(out),
    }
    env.pop("CLAUDE_PROJECT_DIR")
    if project_dir is not None:
        env["CLAUDE_PROJECT_DIR"] = project_dir
    plugin = ["-p", CONFTEST.stem] if with_conftest else []
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            *plugin,
            "-p",
            "no:cacheprovider",
            "test_probe.py",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    return json.loads((out / "host.json").read_text())


def test_without_the_conftest_and_the_variable_unset_the_probe_reads_this_checkout(
    tmp_path,
):
    assert read_host(tmp_path, None, with_conftest=False)["host"] == str(REPO)


@pytest.mark.parametrize(
    "project_dir", [str(REPO), None], ids=["set to a live checkout", "unset, as in CI"]
)
def test_the_host_is_an_empty_temp_dir(tmp_path, project_dir):
    seen = read_host(tmp_path, project_dir)
    assert Path(seen["host"]).parent == Path(tempfile.gettempdir()).resolve()
    assert seen["entries"] == []
    assert seen["spawned"] == seen["host"]
