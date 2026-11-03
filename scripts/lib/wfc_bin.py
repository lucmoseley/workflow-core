"""wfc_bin.py — the Python scripts' one route to a binary base §N7 injects: its
WFC_* var where set and non-empty, else the bare name on PATH, as the Node
scripts' `process.env.WFC_GH || "gh"` reads it. Tests point the var at a stub
(conftest.py's `stub_bin`, workflow-core#1278) instead of prepending PATH. One lookup rather
than one per script, so the var names live in one table (workflow-core#1298).
"""

import os

# Base §N7's house names, one var per binary.
VARS = {"gh": "WFC_GH", "claude": "WFC_CLAUDE_BIN", "ps": "WFC_PS"}


def bin_path(name):
    """`name`'s executable."""
    return os.environ.get(VARS[name]) or name
