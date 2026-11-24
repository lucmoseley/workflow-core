#!/usr/bin/env node

const { writeFd } = require("./write-fd.js");

const ROOT_VARS = Object.freeze([
	"WFC_REPO_ROOT",
	"CLAUDE_PROJECT_DIR",
	"WFC_DISPATCH_ROOT",
]);

/** @param {Record<string, string|undefined>} env */
function forgetRoots(env) {
	for (const v of ROOT_VARS) delete env[v];
}

if (require.main === module) writeFd(1, `${ROOT_VARS.join(" ")}\n`);

module.exports = { ROOT_VARS, forgetRoots };
