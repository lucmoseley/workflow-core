"""A program with a lazy import on its rare branch, a failing mode, a noisy
mode and a throwing mode, for test_call_cost_harness.py."""

import sys

mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode == "rare":
    import call_cost_rare  # noqa: F401
if mode == "noisy":
    sys.stderr.write("stray\n")
if mode == "throw":
    raise RuntimeError("boom")
if mode == "fail":
    sys.exit(3)
