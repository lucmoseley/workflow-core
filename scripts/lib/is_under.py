import os


def relative_under(root: str, p: str) -> str | None:
    if not p or _drive(p) != _drive(root):
        return None
    rel = os.path.relpath(p, root)
    if rel == os.curdir:
        return ""
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        return None
    return rel


def _drive(p: str) -> str:
    return os.path.normcase(os.path.splitdrive(os.path.abspath(os.path.normpath(p)))[0])
