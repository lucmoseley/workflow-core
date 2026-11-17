"""`relative_under`'s edge spellings (#5374), the contract of `relativeUnder`
in `is-under.js`. In-process calls on literal paths, no I/O; the drive case
swaps the module's `os` for Windows spelling, the one host difference no
Linux run reaches. A break here mis-answers every §LG3 containment test
Python code makes."""

import ntpath
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import is_under
from is_under import relative_under


def test_the_root_itself_is_the_empty_answer():
    assert relative_under("/r", "/r") == ""
    assert relative_under("/r", "/r/.") == ""


def test_a_path_beneath_is_its_relative_spelling():
    assert relative_under("/r", "/r/a/b") == "a/b"


def test_the_parent_is_outside():
    assert relative_under("/r/a", "/r") is None


def test_a_sibling_reached_through_dotdot_is_outside():
    assert relative_under("/r/a", "/r/x") is None
    assert relative_under("/r", "/r/../x") is None


def test_a_file_named_dotdot_something_is_inside():
    assert relative_under("/r", "/r/..x") == "..x"


def test_a_name_sharing_the_roots_prefix_is_outside():
    assert relative_under("/r/docs", "/r/docsx/a") is None


def test_an_absolute_path_elsewhere_is_outside():
    assert relative_under("/r", "/elsewhere/x") is None


def test_an_empty_path_is_outside():
    assert relative_under("/r", "") is None


def test_a_path_on_another_drive_is_outside(monkeypatch):
    monkeypatch.setattr(is_under, "os", _NtOs)
    assert relative_under("C:\\r", "D:\\x") is None


class _NtOs:
    """`os` as Windows spells paths, so the drive case runs on any host."""

    path = ntpath
    curdir = "."
    pardir = ".."
    sep = "\\"
