import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# #1677
for _name in (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
):
    os.environ.pop(_name, None)

# #3161
_guard_dir = str(Path(__file__).resolve().parent / "lib" / "host-git-guard")
os.environ["WFC_HOST_GIT_DIR"] = subprocess.run(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd=_guard_dir,
    capture_output=True,
    text=True,
    check=True,
).stdout.strip()
_path_dirs = [
    d for d in os.environ.get("PATH", "").split(os.pathsep) if d and d != _guard_dir
]
_real_git = shutil.which(
    "git",
    path=os.pathsep.join(d for d in _path_dirs if Path(d).name != "host-git-guard"),
)
if _real_git:
    os.environ["WFC_HOST_GIT_REAL"] = _real_git
os.environ["PATH"] = os.pathsep.join([_guard_dir] + _path_dirs)

# #5083
_RUN_ROOT_ENV = "WFC_PYTEST_TMP_ROOT"
_inherited_root = os.environ.get(_RUN_ROOT_ENV)
_owns_run_root = not (
    _inherited_root
    and _inherited_root == os.environ.get("TMPDIR")
    and os.path.isdir(_inherited_root)
)
_owner_pid = os.getpid()
if _owns_run_root:
    _run_root = tempfile.mkdtemp(prefix=f"wfc-pytest-{_owner_pid}-")
    os.environ[_RUN_ROOT_ENV] = _run_root
else:
    _run_root = _inherited_root
os.environ["TMPDIR"] = _run_root
tempfile.tempdir = _run_root


def _remove_run_root():
    if os.getpid() != _owner_pid or not os.path.exists(_run_root):
        return
    try:
        shutil.rmtree(_run_root)
    except OSError:
        for _dir, _subdirs, _files in os.walk(_run_root):
            for _sub in _subdirs:
                os.chmod(os.path.join(_dir, _sub), 0o700)
        shutil.rmtree(_run_root, ignore_errors=True)
    if os.path.exists(_run_root):
        print(
            f"conftest: {_run_root} would not go; a later run-pytest.js removes it",
            file=sys.stderr,
        )


if _owns_run_root:
    atexit.register(_remove_run_root)


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session):
    if _owns_run_root:
        _remove_run_root()


# #3334
_test_host_dir = tempfile.mkdtemp(prefix="wfc-test-host-")
os.environ["CLAUDE_PROJECT_DIR"] = _test_host_dir


@pytest.fixture(scope="session")
def bench():
    import bench_suite_concurrency

    return bench_suite_concurrency


@pytest.fixture
def stub_bin(tmp_path):
    log = tmp_path / "stub-calls"

    def make(name, stdout):
        (tmp_path / f"{name}.out").write_text(stdout)
        path = tmp_path / name
        path.write_text(
            f'#!/bin/sh\necho "$*" >> "{log}"\ncat "{tmp_path / name}.out"\n'
        )
        path.chmod(0o755)
        return str(path), lambda: log.read_text().splitlines() if log.exists() else []

    return make


@pytest.fixture
def seat_roots(tmp_path, monkeypatch):

    def make(n=1):
        monkeypatch.syspath_prepend(str(Path(__file__).resolve().parent / "lib"))
        import transcript_corpus

        for letter in "ABC":
            monkeypatch.delenv(f"WFC_CLAUDE_CONFIG_{letter}", raising=False)
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "seats" / ".claude"))
        out = [Path(r) for r in transcript_corpus.roots()[:n]]
        for root in out:
            root.mkdir(parents=True, exist_ok=True)
        return out

    return make


@pytest.fixture
def corpus(seat_roots):
    seat_roots()

    def write(name, records, subagent_of=None, seat=0):
        root = seat_roots(seat + 1)[seat]
        if subagent_of:
            d = root / subagent_of / "subagents"
            d.mkdir(parents=True, exist_ok=True)
            p = d / f"agent-{name}.jsonl"
        else:
            p = root / f"{name}.jsonl"
        p.write_text("".join(json.dumps(r) + "\n" for r in records))
        return p

    return write


@pytest.fixture
def unkeyed():

    def strip(record, uuid):
        del record["requestId"]
        del record["message"]["id"]
        record["uuid"] = uuid
        return record

    return strip


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    root = tmp_path / "isolated-home"
    root.mkdir()
    monkeypatch.setenv("HOME", str(root))
    return root


OVERFLOW_KEY_VAR = "WFC_OVERFLOW_API_KEY_FAKE"


def declare_overflow_seat(home):
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / "refill-seats").write_text(
        f"~/.claude\n~/.claude api key={OVERFLOW_KEY_VAR} grant=100 cycle-day=1\n"
    )


def ledger_of_checkout(home, name):
    root = home / name
    (root / ".git").mkdir(parents=True)
    (root / ".claude").mkdir()
    (root / ".claude" / "workflow-core.json").write_text("{}\n")
    return root / ".claude" / "tmp" / "markers" / ".pick-next" / "dispatched.jsonl"


@pytest.fixture
def unreadable_launch_record(isolated_home):
    declare_overflow_seat(isolated_home)
    ledger = ledger_of_checkout(isolated_home, "broken")
    ledger.mkdir(parents=True)
    return isolated_home / "broken"


@pytest.fixture
def mark_overflow(isolated_home):

    def mark(session_id):
        declare_overflow_seat(isolated_home)
        ledger = ledger_of_checkout(isolated_home, "other-checkout")
        ledger.parent.mkdir(parents=True)
        ledger.write_text(
            json.dumps(
                {
                    "ts": "2026-08-23T09:00:00.000Z",
                    "issues": [1],
                    "jobId": session_id[:8],
                    "kind": "overflow",
                    "keyVar": OVERFLOW_KEY_VAR,
                    "allowanceUsd": 100,
                    "sessionId": session_id,
                }
            )
            + "\n"
        )

    return mark
