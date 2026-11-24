const pythonBin = () => process.env.WFC_PYTHON || "python3";

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
 * @param {Error} error
 * @returns {string}
 */
const pythonSpawnRemedy = (error) => {
	const remedy =
		SPAWN_REMEDIES[/** @type {NodeJS.ErrnoException} */ (error).code ?? ""];
	return remedy ? `${remedy}\n` : "";
};

module.exports = { pythonBin, pythonSpawnRemedy };
