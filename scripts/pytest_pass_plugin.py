import contextlib
import fnmatch
import json
import os
import sys
from pathlib import Path

import pytest

_OUTCOME_KEYS = ("failed", "error", "skipped", "passed")

_file_seconds = {}

_inflight = {}
_finished = 0
_collected = None

_NEXT_STAGE = {"setup": "call", "call": "teardown"}

_told = set()


def _nodeid_outcomes(terminalreporter):
    outcomes = {}
    for key in _OUTCOME_KEYS:
        for report in terminalreporter.stats.get(key, []):
            nodeid = getattr(report, "nodeid", None)
            if nodeid and nodeid not in outcomes:
                outcomes[nodeid] = key
    return outcomes


def _excluded(config, path, root):
    patterns = config.getini("norecursedirs") or []
    return any(
        fnmatch.fnmatch(part, pattern)
        for part in path.relative_to(root).parts[:-1]
        for pattern in patterns
    )


def _corpus_size(config):
    root = Path(str(config.rootpath))
    testpaths = config.getini("testpaths") or ["."]
    patterns = config.getini("python_files")
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
    if any(c in entry for c in "*?["):
        return [match.resolve() for match in root.glob(entry)]
    return [(root / entry).resolve()]


def _filters(config, deselected=0):
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
    with _told_once("TIMINGS SHORT (#1884) — a test phase went untimed"):
        file = report.nodeid.split("::")[0]
        _file_seconds[file] = _file_seconds.get(file, 0.0) + float(report.duration)
    with _told_once("IN-FLIGHT STAGE UNTRACKED — a test's stage went unrecorded"):
        if report.nodeid in _inflight and report.when in _NEXT_STAGE:
            _inflight[report.nodeid] = _NEXT_STAGE[report.when]
            _write_inflight()


def _write_inflight():
    out = os.environ.get("WFC_PYTEST_INFLIGHT_OUT")
    if not out or os.environ.get("PYTEST_XDIST_WORKER"):
        return
    with _told_once(f"IN-FLIGHT FILE UNWRITTEN — {out} is stale"):
        part = f"{out}.part"
        Path(part).write_text(
            json.dumps(
                {
                    "open": [
                        {"nodeid": nodeid, "stage": stage}
                        for nodeid, stage in _inflight.items()
                    ],
                    "finished": _finished,
                    "collected": _collected,
                }
            ),
            encoding="utf-8",
        )
        os.replace(part, out)


def pytest_collection_finish(session):
    global _collected
    _collected = len(session.items)
    _write_inflight()


@pytest.hookimpl(optionalhook=True)
def pytest_xdist_node_collection_finished(node, ids):
    global _collected
    if _collected is None:
        _collected = len(ids)
        _write_inflight()


def pytest_runtest_logstart(nodeid, location):
    _inflight[nodeid] = "setup"
    _write_inflight()


def pytest_runtest_logfinish(nodeid, location):
    global _finished
    _inflight.pop(nodeid, None)
    _finished += 1
    _write_inflight()


def file_seconds(config):
    root = Path(str(config.rootpath))
    return {str(root / file): seconds for file, seconds in _file_seconds.items()}


class _ReportedAs(contextlib.AbstractContextManager):
    def __init__(self, write_line, headline):
        self._write_line = write_line
        self._headline = headline

    def __exit__(self, exc_type, error, tb):
        if not isinstance(error, Exception):
            return False
        self._write_line(f"{self._headline}: {error}")
        return True


def _told_once(headline):
    def write_line(line):
        if headline not in _told:
            _told.add(headline)
            print(line, file=sys.stderr, flush=True)

    return _ReportedAs(write_line, headline)


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    out = os.environ.get("WFC_PYTEST_SCOPE_OUT")
    if not out or getattr(config.option, "collectonly", False):
        return
    write_line = terminalreporter.write_line
    with _ReportedAs(
        write_line,
        f"VERDICT UNWRITTEN — {out} holds no record of this run",
    ):
        result = {"passed": int(exitstatus) == 0, "scope": None, "fileSeconds": None}
        with _ReportedAs(
            write_line,
            "SCOPE UNRECORDED (mantahostels#1256) — this run cannot say how much of the "
            "suite it covered",
        ):
            result["scope"] = describe_run(terminalreporter, config)
        with _ReportedAs(write_line, "TIMINGS UNRECORDED (#1884)"):
            result["fileSeconds"] = file_seconds(config)
        Path(out).write_text(json.dumps(result), encoding="utf-8")
