"""host_root.py — the Python mirror of scripts/lib/host-root.js's seam: how a
script in the core finds the HOST repository (#1).

CLAUDE_PROJECT_DIR where the harness sets it — its main checkout where it names
a linked worktree (#4487) — else the main checkout owning the
working directory — in a linked worktree the parent of a git common dir called
`.git`, elsewhere the git top level (#4482) — symlinks dereferenced either way,
failing open to the working directory.

NEVER `Path(__file__)`. In a plugin install this file lives in the plugin cache,
so a root resolved from its own location names the cache and every host read
lands in the wrong tree.

Kept in sync by hand, not by shared code — a JS and a Python caller do not share
a runtime.
"""

import os
import subprocess
from pathlib import Path


def host_root(cwd: str | None = None) -> str:
    """The host repository's root, as an absolute path."""
    declared = os.environ.get("CLAUDE_PROJECT_DIR")
    if declared:
        # Only a trailing slash, and never the last one: a repo rooted at `/`
        # would otherwise normalise to the empty string.
        stripped = (
            declared[:-1] if len(declared) > 1 and declared.endswith("/") else declared
        )
        return _deref(_declared_checkout(_deref(stripped)))
    here = cwd or os.getcwd()
    try:
        top, common = (
            subprocess.run(
                [
                    "git",
                    "rev-parse",
                    "--path-format=absolute",
                    "--show-toplevel",
                    "--git-common-dir",
                ],
                cwd=here,
                capture_output=True,
                text=True,
                check=True,
            )
            .stdout.strip()
            .split("\n")
        )
    except (OSError, subprocess.CalledProcessError):
        # Not a git tree, or no git: the module docstring's fail-open to the
        # working directory (#1).
        return _deref(here)
    return _deref(
        os.path.dirname(common) if os.path.basename(common) == ".git" else top
    )


def _declared_checkout(root: str) -> str:
    """The main checkout of a declared root that is a linked worktree, else the
    root: host-root.js's declaredCheckout(), read from git's on-disk layout
    with no fork, from the dereferenced root. A submodule's git file has no
    `commondir`, so keeps it."""
    try:
        line = (Path(root) / ".git").read_text().splitlines()[0]
        if not line.startswith("gitdir: "):
            return root
        git_dir = Path(root) / line[len("gitdir: ") :].strip()
        common = git_dir / (git_dir / "commondir").read_text().strip()
    except (OSError, IndexError):
        # No git file, or one naming no common dir: no linked worktree to
        # re-point, so the declared root is the host (#4487).
        return root
    resolved = _deref(os.path.normpath(common))
    return os.path.dirname(resolved) if os.path.basename(resolved) == ".git" else root


def _deref(path: str) -> str:
    """Symlinks dereferenced, or the path itself where it cannot be resolved."""
    try:
        return str(Path(path).resolve(strict=True))
    except OSError:
        # A dangling or missing path still names the root it was given (#1274).
        return path
