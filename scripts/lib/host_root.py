import os
import subprocess
from pathlib import Path

from fail_open import fail_open
from wfc_bin import bin_path


def host_root(cwd: str | None = None) -> str:
    declared = os.environ.get("CLAUDE_PROJECT_DIR")
    if declared:
        stripped = (
            declared[:-1] if len(declared) > 1 and declared.endswith("/") else declared
        )
        kept = _deref(stripped)
        if not os.path.isfile(os.path.join(kept, ".git")):
            return kept
        return _owning_checkout(kept)
    return _owning_checkout(cwd or os.getcwd())


def _owning_checkout(here: str) -> str:
    try:
        answer = subprocess.run(
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
        )
    except OSError as error:
        fail_open(error, f"{here} taken as its own checkout")
        return _deref(here)
    if answer.returncode != 0:
        return _deref(here)
    top, common = answer.stdout.strip().split("\n")
    return _deref(
        os.path.dirname(common) if os.path.basename(common) == ".git" else top
    )


def _deref(path: str) -> str:
    if not os.path.exists(path):
        return path
    try:
        return str(Path(path).resolve(strict=True))
    except OSError as error:
        fail_open(error, f"{path} kept unresolved")
        return path
