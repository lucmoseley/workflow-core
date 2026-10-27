"""The pytest half of the pre-push marker (mantahostels#1256).

Driven against fakes rather than a nested pytest run: every field the plugin
reads — the stats dict, the ini settings, the command-line options — is plain
data.

`scripts/run-pytest.js` loads the plugin on every `npm run test:py`, and
`.husky/pre-push` and `npm run push:check` read the marker it writes: loosen a
case and a failing or partial Python run is recorded as a certificate over the
whole corpus.
"""

import json
import subprocess
import sys
import types
from pathlib import Path

import pytest

import pytest_pass_plugin as plugin


class FakeReport:
    def __init__(self, nodeid):
        self.nodeid = nodeid


class FakePhaseReport:
    def __init__(self, nodeid, duration):
        self.nodeid = nodeid
        self.duration = duration


class FakeTerminalReporter:
    def __init__(self, stats):
        self.stats = stats
        self.lines = []

    def write_line(self, line):
        self.lines.append(line)


def fake_config(
    tmp_path,
    *,
    args=("scripts",),
    keyword="",
    markexpr="",
    testpaths=("scripts",),
    norecursedirs=(".*", "node_modules", "venv"),
):
    return types.SimpleNamespace(
        rootpath=tmp_path,
        args=list(args),
        option=types.SimpleNamespace(
            keyword=keyword, markexpr=markexpr, collectonly=False
        ),
        getini=lambda name: {
            "testpaths": list(testpaths),
            "python_files": ["test_*.py"],
            "norecursedirs": list(norecursedirs),
        }[name],
    )


def corpus(tmp_path, *relative):
    for rel in relative:
        target = tmp_path / "scripts" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("")
    return tmp_path


def test_counts_one_module_per_distinct_nodeid_prefix(tmp_path):
    reporter = FakeTerminalReporter(
        {
            "passed": [
                FakeReport("scripts/test_a.py::test_one"),
                FakeReport("scripts/test_a.py::test_two"),
                FakeReport("scripts/measure/test_b.py::test_three"),
            ]
        }
    )
    scope = plugin.describe_run(reporter, fake_config(corpus(tmp_path)))

    assert scope["modulesRun"] == 2
    assert scope["tests"] == 3
    assert scope["passed"] == 3


def test_counts_a_module_skipped_whole_as_run(tmp_path):
    """A `pytestmark` skip reports at setup and never at call, so a call-only
    filter drops the module and a full run reads as partial."""
    reporter = FakeTerminalReporter(
        {
            "passed": [FakeReport("scripts/test_a.py::test_one")],
            "skipped": [FakeReport("scripts/test_corpus.py::test_absent")],
        }
    )
    scope = plugin.describe_run(reporter, fake_config(corpus(tmp_path)))

    assert scope["modulesRun"] == 2
    assert scope["skipped"] == 1


def test_a_failing_phase_wins_over_a_passing_one_for_the_same_test(tmp_path):
    node = "scripts/test_a.py::test_one"
    reporter = FakeTerminalReporter(
        {"passed": [FakeReport(node)], "failed": [FakeReport(node)]}
    )
    scope = plugin.describe_run(reporter, fake_config(corpus(tmp_path)))

    assert scope["tests"] == 1
    assert scope["failed"] == 1
    assert scope["passed"] == 0


def test_errors_count_as_failures(tmp_path):
    reporter = FakeTerminalReporter(
        {"error": [FakeReport("scripts/test_a.py::test_one")]}
    )
    assert plugin.describe_run(reporter, fake_config(corpus(tmp_path)))["failed"] == 1


def test_ignores_entries_that_name_no_test(tmp_path):
    """`stats` also holds warnings, which carry no nodeid at all."""
    reporter = FakeTerminalReporter(
        {"passed": [FakeReport("scripts/test_a.py::test_one"), object()]}
    )
    assert plugin.describe_run(reporter, fake_config(corpus(tmp_path)))["tests"] == 1


def test_the_denominator_is_recursive(tmp_path):
    """A flat glob would miss every module in a subdirectory, and every full
    run would read as partial."""
    corpus(tmp_path, "test_a.py", "measure-one/test_b.py", "deep/deeper/test_c.py")
    reporter = FakeTerminalReporter({})
    assert plugin.describe_run(reporter, fake_config(tmp_path))["modulesTotal"] == 3


def test_the_denominator_ignores_files_that_are_not_test_modules(tmp_path):
    corpus(tmp_path, "test_a.py", "conftest.py", "helper.py")
    reporter = FakeTerminalReporter({})
    assert plugin.describe_run(reporter, fake_config(tmp_path))["modulesTotal"] == 1


def test_an_unfiltered_run_names_no_filter(tmp_path):
    scope = plugin.describe_run(FakeTerminalReporter({}), fake_config(corpus(tmp_path)))
    assert scope["nameFilter"] is None
    assert scope["fileFilters"] == []


def test_a_keyword_or_mark_narrowing_is_named(tmp_path):
    scope = plugin.describe_run(
        FakeTerminalReporter({}),
        fake_config(corpus(tmp_path), keyword="corpus", markexpr="slow"),
    )
    assert scope["nameFilter"] == "-k corpus -m slow"


def test_a_path_argument_beyond_the_testpaths_is_a_file_filter(tmp_path):
    scope = plugin.describe_run(
        FakeTerminalReporter({}),
        fake_config(corpus(tmp_path), args=("scripts/test_a.py",)),
    )
    assert scope["fileFilters"] == ["scripts/test_a.py"]


@pytest.mark.parametrize("exitstatus,expected", [(0, True), (1, False), (5, False)])
def test_only_exit_zero_is_green(tmp_path, monkeypatch, exitstatus, expected):
    """Exit 5 is "no tests collected": a run that collected nothing attests
    nothing."""
    out = tmp_path / "scope.json"
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(out))
    plugin.pytest_terminal_summary(
        FakeTerminalReporter({}), exitstatus, fake_config(corpus(tmp_path))
    )
    assert json.loads(out.read_text())["passed"] is expected


def test_writes_nothing_when_no_wrapper_is_listening(tmp_path, monkeypatch):
    monkeypatch.delenv("WFC_PYTEST_SCOPE_OUT", raising=False)
    reporter = FakeTerminalReporter({})
    plugin.pytest_terminal_summary(reporter, 0, fake_config(corpus(tmp_path)))
    assert list(tmp_path.glob("*.json")) == []


def test_a_scope_it_cannot_read_records_the_verdict_and_no_scope(tmp_path, monkeypatch):
    out = tmp_path / "scope.json"
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(out))
    broken = types.SimpleNamespace(
        rootpath=tmp_path,
        args=[],
        option=types.SimpleNamespace(keyword="", markexpr=""),
        getini=lambda name: (_ for _ in ()).throw(ValueError("no such ini")),
    )
    reporter = FakeTerminalReporter({})

    plugin.pytest_terminal_summary(reporter, 0, broken)

    written = json.loads(out.read_text())
    assert written["passed"] is True
    assert written["scope"] is None
    assert any("SCOPE UNRECORDED" in line for line in reporter.lines)


def test_an_unwritable_hand_off_never_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(tmp_path / "nodir" / "s.json"))
    plugin.pytest_terminal_summary(
        FakeTerminalReporter({}), 0, fake_config(corpus(tmp_path))
    )


def test_a_deselected_item_is_a_filter_even_though_every_module_ran(tmp_path):
    """`--deselect` leaves every module collected, so module count alone reads
    the run as full while tests nobody ran are missing from it."""
    reporter = FakeTerminalReporter(
        {
            "passed": [FakeReport("scripts/test_a.py::test_one")],
            "deselected": [FakeReport("scripts/test_a.py::test_two")],
        }
    )
    scope = plugin.describe_run(reporter, fake_config(corpus(tmp_path, "test_a.py")))

    assert scope["modulesRun"] == scope["modulesTotal"]
    assert scope["nameFilter"] == "--deselect 1"


def test_a_testpath_named_any_other_way_is_not_read_as_a_filter(tmp_path):
    """pytest rewrites testpaths into `config.args`, so a string compare would
    call an ordinary full run filtered as soon as the ini gains a trailing
    slash, a glob or a second entry."""
    corpus(tmp_path, "test_a.py")
    scope = plugin.describe_run(
        FakeTerminalReporter({}),
        fake_config(tmp_path, args=("scripts/", "./scripts")),
    )
    assert scope["fileFilters"] == []


def test_the_denominator_skips_directories_pytest_never_collects_from(tmp_path):
    corpus(
        tmp_path, "test_a.py", ".venv/lib/test_vendored.py", "node_modules/test_b.py"
    )
    scope = plugin.describe_run(FakeTerminalReporter({}), fake_config(tmp_path))
    assert scope["modulesTotal"] == 1


def test_collect_only_writes_no_verdict(tmp_path, monkeypatch):
    """It exits 0 having run nothing, and that certificate would be offered at the
    next push as the most recent green run."""
    out = tmp_path / "scope.json"
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(out))
    config = fake_config(corpus(tmp_path))
    config.option.collectonly = True

    plugin.pytest_terminal_summary(FakeTerminalReporter({}), 0, config)

    assert not out.exists()


def test_an_unserialisable_scope_never_reaches_pytest_as_an_internalerror(
    tmp_path, monkeypatch
):
    out = tmp_path / "scope.json"
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(out))
    # A path argument reaches `fileFilters` as given, so a Path, which pytest
    # never passes but nothing stops, leaves the scope unserialisable.
    config = fake_config(tmp_path, args=(Path("scripts/test_a.py"),))

    plugin.pytest_terminal_summary(FakeTerminalReporter({}), 0, config)

    assert not out.exists()


def test_a_non_numeric_exit_status_never_reaches_pytest_either(tmp_path, monkeypatch):
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(tmp_path / "scope.json"))
    plugin.pytest_terminal_summary(
        FakeTerminalReporter({}), "not a number", fake_config(tmp_path)
    )


def test_sums_each_files_setup_call_and_teardown_into_the_hand_off(
    tmp_path, monkeypatch
):
    """Keyed absolute so the wrapper can make it relative to its own root
    (#1884)."""
    monkeypatch.setattr(plugin, "_file_seconds", {})
    out = tmp_path / "scope.json"
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(out))
    for nodeid, duration in (
        ("scripts/test_a.py::test_one", 1.5),
        ("scripts/test_a.py::test_one", 7.0),
        ("scripts/test_a.py::test_two", 2.25),
        ("scripts/test_b.py::test_three", 0.5),
    ):
        plugin.pytest_runtest_logreport(FakePhaseReport(nodeid, duration))

    plugin.pytest_terminal_summary(
        FakeTerminalReporter({}), 1, fake_config(corpus(tmp_path))
    )

    assert json.loads(out.read_text())["fileSeconds"] == {
        str(tmp_path / "scripts/test_a.py"): 10.75,
        str(tmp_path / "scripts/test_b.py"): 0.5,
    }


def test_a_report_it_cannot_time_never_raises_and_times_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(plugin, "_file_seconds", {})
    out = tmp_path / "scope.json"
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(out))
    plugin.pytest_runtest_logreport(FakePhaseReport("scripts/test_a.py::t", None))
    plugin.pytest_runtest_logreport(object())

    plugin.pytest_terminal_summary(
        FakeTerminalReporter({}), 0, fake_config(corpus(tmp_path))
    )

    assert json.loads(out.read_text())["fileSeconds"] == {}


def test_timings_it_cannot_read_hand_over_null_and_keep_the_verdict(
    tmp_path, monkeypatch
):
    """Null is what the wrapper turns into one fail-open line; the cause is
    printed here, since that line cannot know it."""

    class Unprintable:
        def __str__(self):
            raise ValueError("no rootpath")

    out = tmp_path / "scope.json"
    monkeypatch.setenv("WFC_PYTEST_SCOPE_OUT", str(out))
    monkeypatch.setattr(plugin, "_file_seconds", {"scripts/test_a.py": 1.0})
    config = fake_config(corpus(tmp_path))
    config.rootpath = Unprintable()

    reporter = FakeTerminalReporter({})

    plugin.pytest_terminal_summary(reporter, 0, config)

    written = json.loads(out.read_text())
    assert written["passed"] is True
    assert written["fileSeconds"] is None
    assert "TIMINGS UNRECORDED (#1884): no rootpath" in reporter.lines


def test_keeps_the_tests_in_flight_oldest_first_and_counts_the_finished(
    tmp_path, monkeypatch
):
    """What the wrapper's suite-ceiling report names (#2702)."""
    monkeypatch.setattr(plugin, "_inflight", {})
    monkeypatch.setattr(plugin, "_finished", 0)
    monkeypatch.setattr(plugin, "_collected", None)
    out = tmp_path / "inflight.json"
    monkeypatch.setenv("WFC_PYTEST_INFLIGHT_OUT", str(out))
    monkeypatch.delenv("PYTEST_XDIST_WORKER", raising=False)
    plugin.pytest_xdist_node_collection_finished(None, ["a", "b", "c", "d"])
    plugin.pytest_xdist_node_collection_finished(None, ["a", "b", "c", "d"])
    for nodeid in ("test_a.py::one", "test_b.py::two", "test_c.py::three"):
        plugin.pytest_runtest_logstart(nodeid, None)
    report = FakePhaseReport("test_c.py::three", 0.1)
    report.when = "setup"
    plugin.pytest_runtest_logreport(report)
    plugin.pytest_runtest_logfinish("test_b.py::two", None)

    assert json.loads(out.read_text()) == {
        "open": [
            {"nodeid": "test_a.py::one", "stage": "setup"},
            {"nodeid": "test_c.py::three", "stage": "call"},
        ],
        "finished": 1,
        "collected": 4,
    }


def test_an_xdist_worker_leaves_the_in_flight_file_to_the_controller(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(plugin, "_inflight", {})
    out = tmp_path / "inflight.json"
    monkeypatch.setenv("WFC_PYTEST_INFLIGHT_OUT", str(out))
    monkeypatch.setenv("PYTEST_XDIST_WORKER", "gw0")
    plugin.pytest_runtest_logstart("test_a.py::one", None)

    assert not out.exists()


def test_an_unwritable_in_flight_file_never_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(plugin, "_inflight", {})
    monkeypatch.setenv("WFC_PYTEST_INFLIGHT_OUT", str(tmp_path / "no" / "such"))
    monkeypatch.delenv("PYTEST_XDIST_WORKER", raising=False)
    plugin.pytest_runtest_logstart("test_a.py::one", None)


def test_the_plugin_really_loads_and_reports_under_xdist(tmp_path):
    """The one case that runs pytest for real.

    Everything else here drives the plugin's functions directly, and the JS side
    drives an injected spawn — so `-p pytest_pass_plugin`, the PYTHONPATH entry,
    the env var reaching the child and `pytest_terminal_summary` firing ONCE in
    the xdist controller are all otherwise asserted as arguments rather than as
    behaviour. Break any of them and the only symptom is a marker that never
    appears, which at the push reads exactly like "you did not run the suite".
    """
    (tmp_path / "test_tiny.py").write_text(
        "def test_one():\n    assert True\n\n\ndef test_two():\n    assert True\n"
    )
    (tmp_path / "pytest.ini").write_text(
        "[pytest]\ntestpaths = .\npython_files = test_*.py\n"
    )
    out = tmp_path / "scope.json"
    inflight = tmp_path / "inflight.json"
    scripts_dir = str(Path(__file__).resolve().parent)

    run = subprocess.run(
        [sys.executable, "-m", "pytest", "-n", "2", "-p", "pytest_pass_plugin", "-q"],
        cwd=tmp_path,
        env={
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": scripts_dir,
            "WFC_PYTEST_SCOPE_OUT": str(out),
            "WFC_PYTEST_INFLIGHT_OUT": str(inflight),
        },
        capture_output=True,
        text=True,
    )

    assert run.returncode == 0, run.stdout + run.stderr
    written = json.loads(out.read_text())
    assert written["passed"] is True
    assert written["scope"]["modulesRun"] == written["scope"]["modulesTotal"] == 1
    assert written["scope"]["tests"] == 2
    assert written["scope"]["nameFilter"] is None
    assert written["scope"]["fileFilters"] == []
    assert list(written["fileSeconds"]) == [str(tmp_path / "test_tiny.py")]
    # The controller hears both tests finish, which a worker's own count would not.
    assert json.loads(inflight.read_text()) == {
        "open": [],
        "finished": 2,
        "collected": 2,
    }
