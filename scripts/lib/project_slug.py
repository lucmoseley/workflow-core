"""project_slug.py — the Python mirror of scripts/lib/project-slug.js's rule:
how the harness spells a project path as a transcript-directory name
(mantahostels#2148, which replaced the slug literal 17 measure scripts hard-coded).

Kept in sync by hand, not by shared code — a JS and a Python caller do not
share a runtime, the same reason project-slug.js's own header gives for
`proving-run.ts` restating the regex rather than requiring it.
"""

import re

from host_root import host_root


def project_slug(path: str) -> str:
    """Every non-alphanumeric character becomes its own hyphen. Case preserved."""
    return re.sub(r"[^a-zA-Z0-9]", "-", path)


def slug_for_repo() -> str:
    """The slug of the HOST repo, regardless of caller cwd.

    From host_root.py's seam, not this file's own location (workflow-core#1): the checkout
    this file is in is the plugin cache in a plugin install, and the slug would
    name a transcript directory the harness never writes to.
    """
    return project_slug(host_root())
