/*
 * python-bin.js — the `python3` to run: WFC_PYTHON, else `python3` (§N7: the
 * tests feed it chosen output, #2102). Read per call, not frozen at load: a suite
 * re-points it between tests.
 */

const pythonBin = () => process.env.WFC_PYTHON || "python3";

module.exports = { pythonBin };
