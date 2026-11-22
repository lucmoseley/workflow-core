"""is_under.py — `relativeUnder` of `scripts/lib/is-under.js` for Python code
(workflow-core#5374), under local §LG3.

A relpath's leading `..` alone is not a substitute: a file named `..foo`
inside the root would read as outside.
"""

import os


def relative_under(root: str, p: str) -> str | None:
    """`p` relative to `root`, in the platform's separator, where `p` is `root`
    (`""`) or sits beneath it; None where it lies outside, another drive
    included, or is empty. Strictly beneath is a truthy answer. No I/O: a
    caller comparing real paths resolves both first."""
    if not p or _drive(p) != _drive(root):
        return None
    rel = os.path.relpath(p, root)
    if rel == os.curdir:
        return ""
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        return None
    return rel


def _drive(p: str) -> str:
    """`p`'s drive as `os.path.relpath` compares it: "" on POSIX."""
    return os.path.normcase(os.path.splitdrive(os.path.abspath(os.path.normpath(p)))[0])
