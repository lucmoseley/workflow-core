"""The half of the pre-push marker that knows what pytest did (mantahostels#1256).

Without it the pre-push gate read markers only vitest wrote, so a sha green
under TypeScript alone looked fully attested. This plugin records pytest's
verdict and scope; the node wrapper
`scripts/run-pytest.js` holds the tree findings and writes the marker.

`pytest_terminal_summary` is the seam, not `pytest_sessionfinish`: under `-n 2`
(pytest-xdist) it fires ONCE, in the controller, and is handed the exit status,
the stats and the config together. `pytest_sessionfinish` runs in the workers too
and cannot see the run as a whole.

The hand-off is a JSON file named by WFC_PYTEST_SCOPE_OUT rather than a shared
variable: pytest is a separate process from the node wrapper. No env var means
nobody is listening, and the plugin does nothing at all.

It also hands over each test file's worker-seconds, for the run-cost report the
wrapper prints (#1884): its tests' setup, call and teardown summed across xdist
workers, never one file's wall time, since xdist splits a file.

IT MUST NEVER TURN A PASSING SUITE RED. Every read is wrapped; a failure records
the verdict with no scope, which reads as unknown at the push.
"""

import fnmatch
import json
import os
from pathlib import Path

#: Report keys whose entries name a test that actually ran, in the order an
#: outcome takes precedence: a module skipped at setup and a test that failed
#: both matter more than a passing setup phase for the same nodeid.
_OUTCOME_KEYS = ("failed", "error", "skipped", "passed")

_file_seconds = {}


def _nodeid_outcomes(terminalreporter):
    """One outcome per test id, across every phase.

    NOT FILTERED TO ``when == "call"``. A module skipped whole by ``pytestmark``
    never reaches the call phase, so a call-only count drops the module from the
    run entirely.
    """
    outcomes = {}
    for key in _OUTCOME_KEYS:
        for report in terminalreporter.stats.get(key, []):
            nodeid = getattr(report, "nodeid", None)
            if nodeid and nodeid not in outcomes:
                outcomes[nodeid] = key
    return outcomes


def _excluded(config, path, root):
    """Is this file somewhere pytest itself would never collect from?

    `Path.glob` descends into dot-directories and knows nothing of
    `norecursedirs`, so a `.venv` or a vendored `node_modules` under `scripts/`
    would inflate the denominator and leave every full run reading as partial.
    """
    patterns = config.getini("norecursedirs") or []
    return any(
        fnmatch.fnmatch(part, pattern)
        for part in path.relative_to(root).parts[:-1]
        for pattern in patterns
    )


def _corpus_size(config):
    """Every test module on disk, run or not — the denominator vitest gets from
    ``globTestSpecifications()``.

    RECURSIVE, DELIBERATELY: modules sit in subdirectories of ``scripts/``, so
    a flat glob undercounts and every full run reads as partial. Cheaper than
    collecting the run twice with ``--collect-only``.
    """
    root = Path(str(config.rootpath))
    testpaths = config.getini("testpaths") or ["."]
    patterns = config.getini("python_files") or ["test_*.py"]
    found = set()
    for testpath in testpaths:
        for pattern in patterns:
            found.update(
                p.resolve()
                for p in (root / testpath).glob(f"**/{pattern}")
                if not _excluded(config, p, root)
            )
    return len(found)


def _expand(root, entry):
    """A testpath as resolved paths. Globbed only where it is a glob: `glob`
    matches nothing that does not exist, and `Path.glob(".")` raises outright."""
    if any(c in entry for c in "*?["):
        return [match.resolve() for match in root.glob(entry)]
    return [(root / entry).resolve()]


def _filters(config, deselected=0):
    """What narrowed the run: ``-k``, ``-m``, ``--deselect`` and any path
    argument that is not just the configured testpaths.

    ``--deselect`` HAS TO BE COUNTED HERE. A deselected item leaves every module
    collected, so module count alone reads the run as full while tests nobody
    ran are missing from it — the one narrowing that fails open.

    Path arguments are compared RESOLVED, not as strings: pytest glob-expands
    testpaths into ``config.args`` and rewrites them relative to the invocation
    directory, so a string compare calls an ordinary full run filtered as soon as
    ``pytest.ini`` gains a second testpath, a glob, or a trailing slash.
    """
    name = " ".join(
        f"{flag} {value}"
        for flag, value in (
            ("-k", getattr(config.option, "keyword", "")),
            ("-m", getattr(config.option, "markexpr", "")),
            ("--deselect", deselected or ""),
        )
        if value
    )
    root = Path(str(config.rootpath)).resolve()
    testpaths = {root} | {
        p for entry in config.getini("testpaths") or [] for p in _expand(root, entry)
    }
    files = [a for a in config.args if (root / a).resolve() not in testpaths]
    return name or None, files


def describe_run(terminalreporter, config):
    outcomes = _nodeid_outcomes(terminalreporter)
    counted = list(outcomes.values())
    name_filter, file_filters = _filters(
        config, len(terminalreporter.stats.get("deselected", []))
    )
    return {
        "modulesRun": len({nodeid.split("::")[0] for nodeid in outcomes}),
        "modulesTotal": _corpus_size(config),
        "tests": len(counted),
        "passed": counted.count("passed"),
        "skipped": counted.count("skipped"),
        "failed": counted.count("failed") + counted.count("error"),
        "nameFilter": name_filter,
        "fileFilters": file_filters,
    }


def pytest_runtest_logreport(report):
    """Under xdist this fires in the controller for every report a worker
    sends.

    Residual: a phase it cannot time is left out, so its file reads cheaper."""
    try:
        file = report.nodeid.split("::")[0]
        _file_seconds[file] = _file_seconds.get(file, 0.0) + float(report.duration)
    except Exception:  # noqa: BLE001 - a report hook that raises is an INTERNALERROR (#1884)
        pass


def file_seconds(config):
    root = Path(str(config.rootpath))
    return {str(root / file): seconds for file, seconds in _file_seconds.items()}


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    out = os.environ.get("WFC_PYTEST_SCOPE_OUT")
    # `--collect-only` exits 0 having run nothing. A green marker for it would
    # be offered at the next push as the most recent green run.
    if not out or getattr(config.option, "collectonly", False):
        return
    # Only exit code 0 is green. 5 (no tests collected) is not: a run that
    # collected nothing attests nothing.
    # Everything from here is inside a catch: this hook runs on a suite that has
    # already passed, and an exception here is reported as INTERNALERROR, exit 3.
    try:
        result = {"passed": int(exitstatus) == 0, "scope": None}
        try:
            result["scope"] = describe_run(terminalreporter, config)
        except Exception as error:  # noqa: BLE001 - an unreadable scope still records the pass (mantahostels#1256)
            terminalreporter.write_line(
                f"SCOPE UNRECORDED (mantahostels#1256) — this run cannot say how much of the "
                f"suite it covered: {error}"
            )
        try:
            result["fileSeconds"] = file_seconds(config)
        except Exception as error:  # noqa: BLE001 - null reads as a failed report at the wrapper, never a failed suite (#1884)
            terminalreporter.write_line(f"TIMINGS UNRECORDED (#1884): {error}")
            result["fileSeconds"] = None
        Path(out).write_text(json.dumps(result), encoding="utf-8")
    except Exception:  # noqa: BLE001 - a passed suite must not exit 3 over its marker (mantahostels#1256)
        pass
