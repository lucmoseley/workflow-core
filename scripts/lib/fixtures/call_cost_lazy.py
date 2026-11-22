import sys

mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode == "rare":
    import call_cost_rare

    __all__ = ["call_cost_rare"]
if mode == "noisy":
    sys.stderr.write("stray\n")
if mode == "throw":
    raise RuntimeError("boom")
if mode == "fail":
    sys.exit(3)
