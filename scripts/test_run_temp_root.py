"""Pins conftest.py's private temp root (#5083).

A session's `tempfile.gettempdir()` and `TMPDIR` are a `wfc-pytest-<pid>-`
root under the real temp dir, removed when the session finishes with every
fixture a test left in it. Breaking it leaves each such fixture in `/tmp` for
good. Driven through a nested pytest loading the real conftest.py, with its own
`TMPDIR`, since the root is made before the session starts.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent

PROBE = """
import json, os, tempfile
from pathlib import Path

def test_leaves_a_fixture(tmp_path):
    left = tempfile.mkdtemp(prefix="named-rerun-")
    Path(os.environ["PROBE_OUT"], "seen.json").write_text(json.dumps({
        "gettempdir": tempfile.gettempdir(),
        "TMPDIR": os.environ["TMPDIR"],
        "left": left,
        "tmp_path": str(tmp_path),
    }))
"""


def test_this_session_runs_under_its_own_root():
    root = Path(tempfile.gettempdir())
    assert root.name.startswith("wfc-pytest-")
    assert os.environ["TMPDIR"] == str(root)


def test_the_root_goes_when_the_session_finishes(tmp_path):
    (tmp_path / "test_probe.py").write_text(PROBE)
    real = tmp_path / "tmp"
    real.mkdir()
    out = tmp_path / "out"
    out.mkdir()
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-p",
            "conftest",
            "-p",
            "no:cacheprovider",
            "test_probe.py",
        ],
        cwd=tmp_path,
        env={
            **os.environ,
            "PYTHONPATH": str(SCRIPTS),
            "PROBE_OUT": str(out),
            "TMPDIR": str(real),
        },
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    seen = json.loads((out / "seen.json").read_text())
    root = Path(seen["gettempdir"])
    assert root.parent == real
    assert root.name.startswith("wfc-pytest-")
    assert seen["TMPDIR"] == str(root)
    assert Path(seen["left"]).parent == root
    assert Path(seen["tmp_path"]).is_relative_to(root)
    assert list(real.iterdir()) == []
