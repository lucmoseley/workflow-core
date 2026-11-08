/*
 * npm-ci-staging.js — a frozen `node_modules` built in a staging directory,
 * for the levelling step (lib/level-main.js) and the checkout's dependency
 * stores (lib/session-checkout.js). Each swaps the result into place by rename:
 * `npm ci` into a live tree deletes it first, and hook code loads from it.
 * `npm ci --ignore-scripts`: docs/practice/dependency-and-release-management.md.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { npmBin } = require("./npm-bin.js");

const LOCKFILE = "package-lock.json";
/* What `npm ci` reads besides the lockfile; `.npmrc` only where present. */
const MANIFESTS = ["package.json", LOCKFILE, ".npmrc"];
/* Untraced: room for a cold `npm ci` over a slow link. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * @typedef {(dir: string) => void} Install builds `node_modules` in `dir`,
 *   which holds the manifests; throws where it fails
 * @typedef {(name: string) => Buffer | null} ManifestSource a manifest's
 *   bytes, null where it is absent
 */

/**
 * `npm ci` into `dir`, its output on stderr so a caller's stdout stays its
 * own.
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
		throw new Error(`npm ci exited ${r.status ?? r.signal} in ${dir}`);
}

/**
 * Write `source`'s manifests into `staging`, created where absent, and
 * install there.
 * @param {string} staging
 * @param {ManifestSource} source
 * @param {Install} [install]
 * @returns {string} the built `node_modules`
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
			`the install exited 0 but left no node_modules in ${staging} — check what WFC_NPM or npm names`,
		);
	return built;
}

module.exports = { INSTALL_TIMEOUT_MS, LOCKFILE, npmCi, stageInstall };
