"""Tests for scripts/bench_agents_oracle.py's fail-open reads (#5487): a gone
daemon and an unparsable oracle reply each keep the sample and say so."""

import importlib
import sys

import pytest

# Above pid_max, so no live process owns it.
GONE = 99_999_999


@pytest.fixture
def oracle(monkeypatch):
    # The module reads its sample count and gap off argv at import.
    monkeypatch.setattr(sys, "argv", ["bench_agents_oracle.py"])
    sys.modules.pop("bench_agents_oracle", None)
    yield importlib.import_module("bench_agents_oracle")
    sys.modules.pop("bench_agents_oracle", None)


def test_a_gone_daemon_reads_as_none_and_is_named(oracle, capsys):
    assert oracle.proc_stat(GONE) is None
    assert f"fail-open: pid {GONE} read as gone" in capsys.readouterr().err


def test_the_oracle_count_is_the_listed_sessions(oracle):
    assert oracle.oracle_sessions('[{"pid": 1}, {"pid": 2}]') == 2


@pytest.mark.parametrize("stdout", ["", "not json", "5"])
def test_an_unparsable_oracle_reply_counts_minus_one_and_is_named(
    oracle, capsys, stdout
):
    assert oracle.oracle_sessions(stdout) == -1
    assert (
        "fail-open: oracle output counted as unparsed (-1)" in capsys.readouterr().err
    )
