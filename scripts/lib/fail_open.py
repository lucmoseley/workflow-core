"""fail_open.py — base §N5's reporters for Python: an `except` that keeps
working past the error it binds hands that error to one of these, and
`scripts/swallowed_errors.py` passes it. A test pins each site (workflow-core#5487, workflow-core#5503).

- `fail_open`: a fault the program absorbs, printed so a person reading its
  stderr sees what was dropped.
- `tallied`: a fault counted into a tally the caller prints, which reports
  every drop under one line rather than one line each.
- `expected`: a condition that is the program's normal path, not a fault — a
  loop's end, or a process that exited between being listed and being read.
  It prints nothing, so the walk passes it only under a specific caught type.
"""

import sys


def fail_open(error, instead):
    """Print `error` and what the program does `instead` to stderr."""
    sys.stderr.write(f"fail-open: {instead}: {type(error).__name__}: {error}\n")
    sys.stderr.flush()


def tallied(error, tally, key):
    """Count `error` under `key` in `tally`, the counts the caller prints.
    `error` is unread: it is passed so the walk sees the bound name."""
    tally[key] += 1


def expected(error, outcome):
    """Take `error` as the normal-path `outcome`; nothing is printed. Neither
    is read: `error` is passed so the walk sees the bound name, and `outcome`
    names the condition for the reader of the site."""
