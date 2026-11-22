import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from call_cost_harness import CallCostError, call_cost

FIXTURES = Path(__file__).resolve().parent / "fixtures"
STARTS = FIXTURES / "call_cost_starts.py"
LAZY = FIXTURES / "call_cost_lazy.py"


def _patched_state():
    return {
        "Popen": subprocess.Popen,
        "system": os.system,
        "posix_spawn": os.posix_spawn,
        "posix_spawnp": os.posix_spawnp,
        "argv": list(sys.argv),
        "path": list(sys.path),
        "environ": dict(os.environ),
        "cwd": os.getcwd(),
        "stdin": sys.stdin,
        "stdout": sys.stdout,
        "stderr": sys.stderr,
        "modules": dict(sys.modules),
    }


def test_each_spawn_route_is_recorded_once_in_start_order(tmp_path):
    r = call_cost(STARTS, cwd=tmp_path)
    assert r.children == [
        "python3 --version",
        "python3 -V",
        "python3 -E",
        "python3 -c",
        "python3 -I",
        "python3 -S",
        "python3 lib/fixtures/call_cost_child.py",
    ]


def test_a_lazy_import_is_absent_from_the_common_call(tmp_path):
    r = call_cost(LAZY, cwd=tmp_path)
    assert r.modules == ["lib/fixtures/call_cost_lazy.py"]
    assert r.children == []


def test_a_lazy_import_shows_on_the_rare_call(tmp_path):
    r = call_cost(LAZY, ["rare"], cwd=tmp_path)
    assert r.modules == [
        "lib/fixtures/call_cost_lazy.py",
        "lib/fixtures/call_cost_rare.py",
    ]


def test_each_call_reads_its_load_set_from_a_purged_registry(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "call_cost_rare", FIXTURES / "call_cost_rare.py"
    )
    rare = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rare)
    monkeypatch.setitem(sys.modules, "call_cost_rare", rare)

    assert call_cost(LAZY, ["rare"], cwd=tmp_path).modules == [
        "lib/fixtures/call_cost_lazy.py",
        "lib/fixtures/call_cost_rare.py",
    ]
    assert call_cost(LAZY, cwd=tmp_path).modules == ["lib/fixtures/call_cost_lazy.py"]
    assert sys.modules["call_cost_rare"] is rare


def test_a_non_zero_exit_raises_naming_it(tmp_path):
    with pytest.raises(CallCostError, match="exited 3, not 0"):
        call_cost(LAZY, ["fail"], cwd=tmp_path)


def test_stray_stderr_raises(tmp_path):
    with pytest.raises(CallCostError, match="wrote to stderr"):
        call_cost(LAZY, ["noisy"], cwd=tmp_path)


def test_the_exit_and_stderr_a_pin_names_are_admitted(tmp_path):
    assert call_cost(LAZY, ["fail"], cwd=tmp_path, expect_status=3).code == 3
    r = call_cost(LAZY, ["noisy"], cwd=tmp_path, allow_stderr=True)
    assert r.stderr == "stray\n"


def test_argv_cwd_env_and_stdin_reach_the_program(tmp_path):
    probe = tmp_path / "scripts" / "probe.py"
    probe.parent.mkdir()
    probe.write_text(
        "import os, sys\n"
        "print(sys.argv[1:], os.getcwd(), os.environ.get('PROBE'), "
        "'OTHER' in os.environ, sys.stdin.read(), os.read(0, 9))\n"
    )
    r = call_cost(
        probe, ["a", "b"], cwd=tmp_path, env={"PROBE": "yes"}, stdin="payload"
    )
    assert r.stdout == f"['a', 'b'] {tmp_path} yes False payload b''\n"
    assert r.modules == ["probe.py"]


def test_every_patch_is_undone_after_a_call(tmp_path, monkeypatch):
    monkeypatch.setenv("OTHER", "kept")
    before = _patched_state()
    call_cost(LAZY, ["rare"], cwd=tmp_path, env={"ONLY": "1"}, stdin="x")
    assert _patched_state() == before


def test_every_patch_is_undone_after_a_throwing_call(tmp_path, monkeypatch):
    monkeypatch.setenv("OTHER", "kept")
    before = _patched_state()
    with pytest.raises(CallCostError, match="exited 1") as raised:
        call_cost(LAZY, ["throw"], cwd=tmp_path, env={"ONLY": "1"})
    assert "RuntimeError: boom" in str(raised.value)
    assert _patched_state() == before


def test_a_program_that_closes_its_own_stdout_still_exits_cleanly(tmp_path):
    probe = tmp_path / "scripts" / "closer.py"
    probe.parent.mkdir()
    probe.write_text("import sys\nprint('kept')\nsys.stdout.close()\n")
    r = call_cost(probe, cwd=tmp_path)
    assert (r.code, r.stderr) == (0, "")


def test_a_non_int_exit_is_printed_as_exit_1_as_under_python3(tmp_path):
    probe = tmp_path / "scripts" / "quitter.py"
    probe.parent.mkdir()
    probe.write_text("import sys\nsys.exit('gave up')\n")
    r = call_cost(probe, cwd=tmp_path, expect_status=1, allow_stderr=True)
    assert r.stderr == "gave up\n"
