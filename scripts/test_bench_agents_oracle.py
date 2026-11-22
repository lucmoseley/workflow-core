import importlib
import sys
from collections import Counter

import pytest

GONE = 99_999_999


@pytest.fixture
def oracle(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["bench_agents_oracle.py"])
    sys.modules.pop("bench_agents_oracle", None)
    yield importlib.import_module("bench_agents_oracle")
    sys.modules.pop("bench_agents_oracle", None)


def test_a_gone_daemon_reads_as_none_silently(oracle, capsys):
    assert oracle.proc_stat(GONE) is None
    assert capsys.readouterr().err == ""


def test_the_oracle_count_is_the_listed_sessions(oracle):
    assert oracle.oracle_sessions('[{"pid": 1}, {"pid": 2}]', Counter()) == 2


@pytest.mark.parametrize("stdout", ["", "not json", "5"])
def test_an_unparsable_oracle_reply_counts_minus_one_into_the_tally(
    oracle, capsys, stdout
):
    tally = Counter()
    assert oracle.oracle_sessions(stdout, tally) == -1
    assert tally == {oracle.ORACLE_UNPARSED: 1}
    assert capsys.readouterr().err == ""
