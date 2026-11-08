"""Tests for scripts/lib/host_root.py's git route: it asks git through WFC_GIT,
as scripts/lib/git.js does, so a test can feed it a stub (#4262).

A `stub_bin` git answering for two bare temp dirs, not a real repo: the stub's
answer alone can name the main checkout, so a pass proves the call reached it.
Loosen it and host_root can drift back to the real git, past every test that
means to stub it."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
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
