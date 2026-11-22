const { gitCommonDir, gitOrNull } = require("./git.js");
const { scrubbedGitEnv } = require("./hook-entry.js");
const { coreRoot } = require("./script-path.js");

// #5581
/** @returns {boolean} */
function isCoreRepo() {
	const core = coreRoot();
	const env = scrubbedGitEnv(process.env);
	if (
		gitOrNull(["rev-parse", "--show-cdup"], { cwd: core, env })?.trim() !== ""
	)
		return false;
	const own = gitCommonDir(core, { env });
	return own !== null && own === gitCommonDir(process.cwd());
}

module.exports = { isCoreRepo };
