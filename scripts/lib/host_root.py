"""host_root.py — the Python mirror of scripts/lib/host-root.js's seam: how a
script in the core finds the HOST repository (workflow-core#1).

CLAUDE_PROJECT_DIR where the harness sets it, else the git top level of the
working directory, symlinks dereferenced either way, failing open to the working
directory.

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
        return _deref(stripped)
    here = cwd or os.getcwd()
    try:
        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=here,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        # Not a git tree, or no git: the module docstring's fail-open to the
        # working directory (workflow-core#1).
        return _deref(here)
    return _deref(top)


def _deref(path: str) -> str:
    """Symlinks dereferenced, or the path itself where it cannot be resolved."""
    try:
        return str(Path(path).resolve(strict=True))
    except OSError:
        # A dangling or missing path still names the root it was given (workflow-core#1274).
        return path
