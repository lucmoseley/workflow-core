const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { npmBin } = require("./npm-bin.js");

const LOCKFILE = "package-lock.json";
const MANIFESTS = ["package.json", LOCKFILE, ".npmrc"];
// guess, workflow-core#4235
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * @typedef {(dir: string) => void} Install
 * @typedef {(name: string) => Buffer | null} ManifestSource
 */

/**
 * @type {Install}
 */
function npmCi(dir) {
	const r = spawnSync(
		npmBin(),
		["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
		{ cwd: dir, stdio: ["ignore", 2, 2], timeout: INSTALL_TIMEOUT_MS },
	);
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(
			`npm ci exited ${r.status ?? r.signal} in ${dir} — its output is above; fix the lockfile or the network`,
		);
}

/**
 * @param {string} staging
 * @param {ManifestSource} source
 * @param {Install} [install]
 * @returns {string}
 */
function stageInstall(staging, source, install = npmCi) {
	fs.mkdirSync(staging, { recursive: true });
	for (const name of MANIFESTS) {
		const bytes = source(name);
		if (bytes !== null) fs.writeFileSync(path.join(staging, name), bytes);
	}
	install(staging);
	const built = path.join(staging, "node_modules");
	if (!fs.existsSync(built))
		throw new Error(
			`the install left no node_modules in ${staging} — check what WFC_NPM or npm names`,
		);
	return built;
}

module.exports = { INSTALL_TIMEOUT_MS, LOCKFILE, npmCi, stageInstall };
