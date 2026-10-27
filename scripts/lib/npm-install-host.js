/*
 * npm-install-host.js — the production ports guard-npm-install.js wires into
 * its core, lib/npm-install.js (workflow-core#2800).
 *
 * THE SEAMS. WFC_NPM and WFC_CURL name the two registry programs, never PATH
 * (workflow-core#2266, workflow-core#2422).
 *
 * THE TIMEOUTS. `npm view` gets 12 s and curl 8 s, both its own `--max-time`
 * and the spawn's: 20 s a package, which the core's 30 s budget is sized
 * against under the hook's 60 s ceiling.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

const NPM_TIMEOUT_MS = 12_000;
const CURL_MAX_TIME_S = 8;

/**
 * One registry call: `missing` where the program could not be started, else
 * its status (null where the timeout killed it) and stdout. stderr is
 * dropped.
 * @param {string} program
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {import("./npm-install.js").Call}
 */
function call(program, args, timeoutMs) {
	const r = spawnSync(program, args, {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: CHILD_MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const code = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code;
	if (code === "ENOENT") return { missing: true };
	return { status: r.status, stdout: r.stdout ?? "" };
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * @param {import("./kit-context.js").PortEnv} env
 * @returns {import("./npm-install.js").NpmInstallPorts}
 */
function buildHostPorts({ root }) {
	const npm = process.env.WFC_NPM || "npm";
	const curl = process.env.WFC_CURL || "curl";
	const pkg = path.join(root, "package.json");
	return {
		readPackageJson: () => ({ path: pkg, text: readOrNull(pkg) }),
		readManifest: (dep) =>
			readOrNull(path.join(root, "node_modules", dep, "package.json")),
		npmView: (name) =>
			call(npm, ["view", name, "time.created", "--json"], NPM_TIMEOUT_MS),
		downloads: (name) =>
			call(
				curl,
				[
					"-fsS",
					"--max-time",
					String(CURL_MAX_TIME_S),
					`https://api.npmjs.org/downloads/point/last-month/${name}`,
				],
				CURL_MAX_TIME_S * 1000,
			),
		now: () => Date.now(),
		allowNewPackage: Boolean(process.env.WFC_ALLOW_NEW_PACKAGE),
	};
}

module.exports = { buildHostPorts };
