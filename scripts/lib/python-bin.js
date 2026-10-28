/*
 * python-bin.js — the `python3` to run: WFC_PYTHON, else `python3` (§N7: the
 * tests feed it chosen output, #2102). Read per call, not frozen at load: a suite
 * re-points it between tests.
 */

const pythonBin = () => process.env.WFC_PYTHON || "python3";

/* Each remedy fits its own code alone: reinstalling python cures no fork
 * limit (#3120). A code with no remedy here gets none. */
const SPAWN_REMEDIES = /** @type {Record<string, string>} */ ({
	ENOENT:
		"Install python3 or point WFC_PYTHON at it, then its test deps: " +
		"python3 -m pip install --require-hashes --only-binary :all: -r requirements-dev.txt",
	EACCES:
		"The python, or a directory on its path, is not executable by you: " +
		"fix that permission, or point WFC_PYTHON at a python that is.",
	EAGAIN:
		"The system refused a new process at a process-count limit (ulimit -u, " +
		"a cgroup's pids.max), not python: retry once other runs have ended.",
});

/**
 * @param {Error} error a failed spawn of `pythonBin()`, carrying its errno code
 * @returns {string} what to do about it, as a line, or "" where nothing fits
 */
const pythonSpawnRemedy = (error) => {
	const remedy =
		SPAWN_REMEDIES[/** @type {NodeJS.ErrnoException} */ (error).code ?? ""];
	return remedy ? `${remedy}\n` : "";
};

module.exports = { pythonBin, pythonSpawnRemedy };
