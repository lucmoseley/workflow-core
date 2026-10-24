"""resolve_core.py — the Python mirror of scripts/lib/resolve-core.js: finds the
workflow-core directory an adopter's Python scripts and pytest suite import the
helper surface from (#457, #465). Like the JS file, an adopter copies it once
into its own tree and never re-syncs it.

FROZEN, as resolve-core.js is: a change to its lookup, its export or its
variable names is a major release with a migration note. Standard library only,
Python 3.10 or later, because it runs before the core is found.

Same lookup, same variables, same messages as resolve-core.js, whose header
explains each step: WORKFLOW_CORE_DIR, then WORKFLOW_CORE_CHECKOUT, then the
installed plugin's install row for the adopter root. test_resolve_core.py runs
both files over the same fixtures and fails on any difference. A value the CLI
never writes — a non-string ref or install path — fails in both, naming the
pin, but its message text can differ.

An adopter's conftest.py puts the core's lib on the path before any test
imports from it:

    sys.path.insert(0, os.path.join(resolve_core(), "scripts", "lib"))
"""

import json
import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping

PLUGIN = "workflow-core"
OVERRIDE = "WORKFLOW_CORE_DIR"
CHECKOUT = "WORKFLOW_CORE_CHECKOUT"
# resolve-core.js's TAG_REF; [0-9] because Python's \d also matches non-ASCII digits.
TAG_REF = re.compile(r"v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?")


def _read_json(at):
    try:
        with open(at, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        # Absent or malformed reads as unset; the caller tries its next source
        # (#1274).
        return None


def _get(value, key):
    return value.get(key) if isinstance(value, dict) else None


def _adopter_root():
    """resolve-core.js's adopterRoot: the main checkout, even from a linked worktree."""
    try:
        common, top = (
            subprocess.run(
                [
                    "git",
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                    "--show-toplevel",
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            .stdout.strip()
            .split("\n")
        )
    except (OSError, subprocess.CalledProcessError, ValueError):
        # Outside a git tree the working directory is the adopter (#1274).
        return os.getcwd()
    return os.path.dirname(common) if os.path.basename(common) == ".git" else top


def _read_pin(root):
    settings = _read_json(os.path.join(root, ".claude", "settings.json"))
    known = _get(settings, "extraKnownMarketplaces")
    if not isinstance(known, dict):
        known = {}
    enabled = _get(settings, "enabledPlugins")
    for key in enabled if isinstance(enabled, dict) else {}:
        name, marketplace = ([*key.split("@"), ""])[:2]
        if name == PLUGIN and marketplace and marketplace in known:
            ref = _get(_get(known[marketplace], "source"), "ref")
            return marketplace, ref
    return None, None


def _stderr(line):
    sys.stderr.write(f"{line}\n")


def resolve_core(
    *,
    root: str | None = None,
    env: Mapping[str, str] | None = None,
    warn: Callable[[str], None] = _stderr,
) -> str:
    """The core's directory. Raises RuntimeError, naming the pin and what was
    missing, where no directory is found."""
    if root is None:
        root = _adopter_root()
    if env is None:
        env = os.environ
    marketplace, ref = _read_pin(root)
    pin = "none" if ref is None else str(ref)

    def fail(missing):
        raise RuntimeError(
            f"resolve-core: no {PLUGIN} directory for pin {pin} — {missing}"
        )

    for name in (OVERRIDE, CHECKOUT):
        directory = env.get(name)
        if not directory:
            continue
        if not os.path.isdir(directory):
            fail(f"{name} names {directory}, which is not a directory")
        return os.path.abspath(directory)

    unset = f"{OVERRIDE} and {CHECKOUT} are unset"
    if not marketplace:
        settings = os.path.join(root, ".claude", "settings.json")
        fail(f"{unset}, and {settings} enables no {PLUGIN} from a known marketplace")
    config = env.get("CLAUDE_CONFIG_DIR")
    if config is None:
        config = os.path.join(os.path.expanduser("~"), ".claude")
    record = os.path.join(config, "plugins", "installed_plugins.json")
    key = f"{PLUGIN}@{marketplace}"
    entries = _get(_get(_read_json(record), "plugins"), key)
    rows = (
        [row for row in entries if _get(row, "projectPath") == root]
        if isinstance(entries, list)
        else []
    )
    install_path = _get(rows[-1], "installPath") if rows else None
    if not install_path:
        fail(f"{unset}, and {record} records no {key} install for {root}")
    if not isinstance(install_path, str) or not os.path.isdir(install_path):
        fail(f"{record} records {install_path}, which is not a directory")

    version = _get(
        _read_json(os.path.join(install_path, ".claude-plugin", "plugin.json")),
        "version",
    )
    if (
        TAG_REF.fullmatch(pin)
        and isinstance(version, str)
        and version.removeprefix("v") != pin.removeprefix("v")
    ):
        warn(
            f"resolve-core: the installed {PLUGIN} is {version}, not the pinned {pin}"
            " — local results can differ from CI's until the install catches up"
        )
    return install_path
