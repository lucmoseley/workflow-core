import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import host_root as host_root_module
from host_root import host_root


def test_the_owning_checkout_comes_from_the_git_at_wfc_git(
    tmp_path, monkeypatch, stub_bin
):
    main = tmp_path / "main"
    tree = tmp_path / "tree"
    main.mkdir()
    tree.mkdir()
    git, calls = stub_bin("git", f"{tree}\n{main / '.git'}\n")
    monkeypatch.setenv("WFC_GIT", git)
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)

    assert host_root(str(tree)) == str(main.resolve())
    assert calls() == [
        "rev-parse --path-format=absolute --show-toplevel --git-common-dir"
    ]


def test_a_tree_git_cannot_be_run_in_is_its_own_checkout_and_said(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("WFC_GIT", str(tmp_path / "no-git"))
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)

    assert host_root(str(tmp_path)) == str(tmp_path.resolve())
    err = capsys.readouterr().err
    assert "fail-open:" in err
    assert f"{tmp_path} taken as its own checkout" in err


def test_a_tree_git_names_no_checkout_for_is_its_own_checkout_silently(
    tmp_path, monkeypatch, capsys, stub_bin
):
    git, _ = stub_bin("git", "")
    (tmp_path / "fail").write_text(f'#!/bin/sh\n{git} "$@"\nexit 128\n')
    (tmp_path / "fail").chmod(0o755)
    monkeypatch.setenv("WFC_GIT", str(tmp_path / "fail"))
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)

    assert host_root(str(tmp_path)) == str(tmp_path.resolve())
    assert capsys.readouterr().err == ""


def test_a_declared_root_that_does_not_exist_is_kept_as_spelt_silently(
    tmp_path, monkeypatch, capsys
):
    gone = str(tmp_path / "gone")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", gone + "/")

    assert host_root() == gone
    assert capsys.readouterr().err == ""


def test_a_declared_root_that_will_not_resolve_is_kept_as_spelt_and_said(
    tmp_path, monkeypatch, capsys
):
    def refuse(self, strict=False):
        raise PermissionError("refused")

    monkeypatch.setattr(host_root_module.Path, "resolve", refuse)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))

    assert host_root() == str(tmp_path)
    err = capsys.readouterr().err
    assert "fail-open:" in err
    assert f"{tmp_path} kept unresolved" in err
