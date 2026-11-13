"""host_root.py — the Python mirror of scripts/lib/host-root.js's seam: how a
script in the core finds the HOST repository (workflow-core#1).

The main checkout owning CLAUDE_PROJECT_DIR where the harness sets it, else
the one owning the working directory — in a linked worktree the parent of a git
common dir called `.git`, elsewhere the git top level (workflow-core#4482, workflow-core#4493) — symlinks
dereferenced either way, failing open to the declared or working directory. A
declared directory whose `.git` is no file is kept without asking git.

NEVER `Path(__file__)`. In a plugin install this file lives in the plugin cache,
so a root resolved from its own location names the cache and every host read
lands in the wrong tree.

Kept in sync by hand, not by shared code — a JS and a Python caller do not share
a runtime.
"""

import os
import subprocess
from pathlib import Path

from wfc_bin import bin_path


def host_root(cwd: str | None = None) -> str:
    """The host repository's root, as an absolute path."""
    declared = os.environ.get("CLAUDE_PROJECT_DIR")
    if declared:
        # Only a trailing slash, and never the last one: a repo rooted at `/`
        # would otherwise normalise to the empty string.
        stripped = (
            declared[:-1] if len(declared) > 1 and declared.endswith("/") else declared
        )
        kept = _deref(stripped)
        if not os.path.isfile(os.path.join(kept, ".git")):
            return kept
        return _owning_checkout(kept)
    return _owning_checkout(cwd or os.getcwd())


def _owning_checkout(here: str) -> str:
    """The main checkout owning `here`, else `here` itself."""
    try:
        top, common = (
            subprocess.run(
                [
                    bin_path("git"),
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
        # directory asked from (workflow-core#1).
        return _deref(here)
    return _deref(
        os.path.dirname(common) if os.path.basename(common) == ".git" else top
    )


def _deref(path: str) -> str:
    """Symlinks dereferenced, or the path itself where it cannot be resolved."""
    try:
        return str(Path(path).resolve(strict=True))
    except OSError:
        # A dangling or missing path still names the root it was given (workflow-core#1274).
        return path
