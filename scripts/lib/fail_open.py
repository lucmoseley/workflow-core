"""fail_open.py — base §N5's printed fail-open for Python: a program that keeps
working past an error it caught hands that error here, so a person reading its
stderr sees what was dropped. `scripts/swallowed_errors.py` passes an `except`
that calls `fail_open` with the name the clause binds, and a test pins each
such site (#5487).
"""

import sys


def fail_open(error, instead):
    """Print `error` and what the program does `instead` to stderr."""
    sys.stderr.write(f"fail-open: {instead}: {type(error).__name__}: {error}\n")
    sys.stderr.flush()
