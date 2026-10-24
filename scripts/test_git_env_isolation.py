"""Pins conftest.py's removal of git's repository-locating variables (#1677).

A pytest run started under a linked worktree's exported `GIT_DIR` — a hook,
`git bisect run` — must not let a test's plain `git init <dir>` mark the
worktree's main repo bare. Driven through a nested pytest loading the real
conftest, since the variable has to be set before the session starts; the
control run loads none, proving the probe still reproduces the bug.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent

PROBE = """
import json, os, subprocess
from pathlib import Path

def test_probe():
    out = Path(os.environ["PROBE_OUT"])
    subprocess.run(["git", "init", "-q", str(out / "fresh")], check=True)
    (out / "env.json").write_text(json.dumps([k for k in os.environ if k.startswith("GIT_")]))
"""


def run_probe(tmp_path, with_conftest):
    """Runs the probe under a leaked worktree `GIT_DIR`; returns the `GIT_*`
    names it saw and the scratch repo's `core.bare`."""

    # A CI runner has no global identity (#1692).
    ident = {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
    }

    def git(*args):
        return subprocess.run(
            ["git", *args],
            cwd=tmp_path,
            env={**os.environ, **ident},
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    git("init", "-q", "scratch")
    git("-C", "scratch", "commit", "-q", "--allow-empty", "-m", "root")
    git("-C", "scratch", "worktree", "add", "-q", "--detach", "../wt")
    (tmp_path / "test_probe.py").write_text(PROBE)
    out = tmp_path / "out"
    out.mkdir()
    env = {
        **os.environ,
        "GIT_DIR": str(tmp_path / "scratch" / ".git" / "worktrees" / "wt"),
        "PYTHONPATH": str(SCRIPTS),
        "PROBE_OUT": str(out),
    }
    plugin = ["-p", "conftest"] if with_conftest else []
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
    seen = json.loads((out / "env.json").read_text())
    return seen, git("-C", "scratch", "config", "core.bare")


def test_without_the_conftest_the_probe_marks_the_main_repo_bare(tmp_path):
    assert run_probe(tmp_path, with_conftest=False)[1] == "true"


def test_a_leaked_git_dir_leaves_the_main_repo_non_bare(tmp_path):
    seen, bare = run_probe(tmp_path, with_conftest=True)
    assert "GIT_DIR" not in seen
    assert bare == "false"
