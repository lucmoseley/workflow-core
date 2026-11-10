"""scripts/conftest.py — fixtures shared across scripts/ and its subdirectories.

`bench` exists so every test in test_bench_suite_concurrency.py takes the
harness as `bench` (#1277). `stub_bin` is the §N7 seam: a program's `WFC_GH`,
`WFC_CLAUDE_BIN`, `WFC_PS` or `WFC_GIT` pointed at a real executable, never a patched
`subprocess` (#1278). `seat_roots` is transcript_corpus.py's: its seats pointed at temp config
dirs by the env it reads, never a patched module global (#1275). `corpus` and
`unkeyed` are the transcript scanners' tests' own, written once (#1297).
"""

import atexit
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

# No test's git call reaches the real repo through an inherited GIT_DIR
# (#1677): under a linked worktree's hook or `git bisect run`, a plain
# `git init <dir>` re-initialises the worktree's git dir and marks the shared
# `.git/config` bare. Cleared at import, before any test or xdist worker runs;
# a test that wants one sets it in its child's env. The same seven as
# vitest.setup.ts, unlike which this clears the whole pytest process — harmless,
# as no plugin here runs git.
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

# No test's git call writes to this checkout's repository (#3161): the `git`
# on `PATH` becomes lib/host-git-guard/git, as vitest.setup.ts makes it.
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

# A live memory-hold trial's declaration never lifts a test's meminfo fixture,
# as vitest.setup.ts blanks it (#4862).
os.environ["WFC_MEMORY_HOLD"] = ""

# No test reaches the session's host through CLAUDE_PROJECT_DIR (#3334): an
# empty dir that is no repository, as vitest.setup.ts points it at.
_test_host_dir = tempfile.mkdtemp(prefix="wfc-test-host-")
os.environ["CLAUDE_PROJECT_DIR"] = _test_host_dir
atexit.register(shutil.rmtree, _test_host_dir, ignore_errors=True)


@pytest.fixture(scope="session")
def bench():
    import bench_suite_concurrency

    return bench_suite_concurrency


@pytest.fixture
def stub_bin(tmp_path):
    """`stub_bin(name, stdout)` writes an executable that logs its argv and
    prints `stdout`, and returns (path, calls): `calls()` lists each run's argv."""
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
    """`seat_roots(n)` points transcript_corpus.py's seats at `.claude`,
    `.claude2` and `.claude3` under a temp dir, plan A to C, and returns the
    first `n` seats' transcript roots for this repo, created."""

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
    """`corpus(name, records, subagent_of=None, seat=0)` writes `records` as a
    transcript under seat `seat`'s root, a subagent's where `subagent_of` names
    its parent session, and returns its path. The first seat's root exists
    from the start."""
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
    """`unkeyed(record, uuid)`: `record` with neither `requestId` nor
    `message.id`, carrying `uuid` — what a scanner counts as unkeyed (#1293)."""

    def strip(record, uuid):
        del record["requestId"]
        del record["message"]["id"]
        record["uuid"] = uuid
        return record

    return strip


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    """A `HOME` holding no checkout, so a scanner's launch-record read reaches no
    live ledger (#3696)."""
    root = tmp_path / "isolated-home"
    root.mkdir()
    monkeypatch.setenv("HOME", str(root))
    return root


OVERFLOW_KEY_VAR = "WFC_OVERFLOW_API_KEY_FAKE"


def declare_overflow_seat(home):
    """`home`'s seat file: a plan seat and an overflow seat on its dir, as a
    launch-record reader consults the ledger only where one is declared
    (#4393)."""
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / "refill-seats").write_text(
        f"~/.claude\n~/.claude api key={OVERFLOW_KEY_VAR} grant=100 cycle-day=1\n"
    )


def ledger_of_checkout(home, name):
    """A fixture checkout under `home`, and the dispatch ledger path in it."""
    root = home / name
    (root / ".git").mkdir(parents=True)
    (root / ".claude").mkdir()
    (root / ".claude" / "workflow-core.json").write_text("{}\n")
    return root / ".claude" / "tmp" / "markers" / ".pick-next" / "dispatched.jsonl"


@pytest.fixture
def unreadable_launch_record(isolated_home):
    """An overflow seat declared under `isolated_home` beside a checkout whose
    dispatch ledger will not read; returns that checkout."""
    declare_overflow_seat(isolated_home)
    ledger = ledger_of_checkout(isolated_home, "broken")
    ledger.mkdir(parents=True)
    return isolated_home / "broken"


@pytest.fixture
def mark_overflow(isolated_home):
    """Marks a session overflow in a fixture checkout's dispatch ledger under
    `isolated_home`, in the row's shape `scripts/lib/dispatch-ledger.js` writes,
    its overflow seat declared."""

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
