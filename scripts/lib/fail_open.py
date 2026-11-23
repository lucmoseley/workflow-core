import sys


def fail_open(error, instead):
    """Print `error` and what the program does `instead` to stderr."""
    sys.stderr.write(f"fail-open: {instead}: {type(error).__name__}: {error}\n")
    sys.stderr.flush()


def tallied(error, tally, key):
    # #5503
    tally[key] += 1


def expected(error, outcome):
    # #5503
    pass
