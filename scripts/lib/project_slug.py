import re

from host_root import host_root


def project_slug(path: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "-", path)


def slug_for_repo() -> str:
    """The slug of the HOST repo, regardless of caller cwd.

    From host_root.py's seam, not this file's own location (#1): the checkout
    this file is in is the plugin cache in a plugin install, and the slug would
    name a transcript directory the harness never writes to.
    """
    return project_slug(host_root())
