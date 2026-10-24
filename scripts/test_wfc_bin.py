"""Tests for scripts/lib/wfc_bin.py — the Python scripts' WFC_* binary lookup (#1298).

Env only, no stub executable: bin_path resolves a name and never runs it — the
callers' own tests run a stub through it (#1278). A hard gate in CI's python job:
loosen it and a Python script can ignore its `WFC_*` override, so its tests' stub
is bypassed and the real binary (`gh` among them) runs instead.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from wfc_bin import VARS, bin_path


@pytest.mark.parametrize("name", sorted(VARS))
def test_the_var_names_the_binary_where_set(name, monkeypatch):
    monkeypatch.setenv(VARS[name], "/stub/bin")
    assert bin_path(name) == "/stub/bin"


@pytest.mark.parametrize("value", [None, ""])
def test_an_unset_or_empty_var_falls_back_to_the_bare_name(value, monkeypatch):
    if value is None:
        monkeypatch.delenv("WFC_GH", raising=False)
    else:
        monkeypatch.setenv("WFC_GH", value)
    assert bin_path("gh") == "gh"
