import os

VARS = {
    "gh": "WFC_GH",
    "claude": "WFC_CLAUDE_BIN",
    "ps": "WFC_PS",
    "git": "WFC_GIT",
    "systemctl": "WFC_SYSTEMCTL",
}


def bin_path(name):
    return os.environ.get(VARS[name]) or name
