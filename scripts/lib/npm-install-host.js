/*
 * npm-install-host.js — the production ports the dispatcher wires into the
 * guard-npm-install core, lib/npm-install.js (#2800, #3226).
 *
 * THE SEAMS. WFC_NPM and WFC_CURL name the two registry programs, never PATH
 * (#2266, #2422).
 *
 * THE TIMEOUTS. `npm view` gets 12 s and curl 8 s, both its own `--max-time`
 * and the spawn's: 20 s a package, which the core's 30 s budget is sized
 * against under the hook's 60 s ceiling. Both are guesses, never measured,
 * carried from the bash guard that set them at #1803: generous beside a
 * registry answer's usual second or so.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { entryStartedAt } = require("./hook-deadline.js");
const { npmBin } = require("./npm-bin.js");
const { STORES } = require("./worktree-dirs.js");

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
 * The dependency stores are the host root's; the session tree's package.json
 * and manifests the core reads through its tree ports (#4242).
 * @param {string} root the host root
 * @returns {import("./npm-install.js").NpmInstallPorts}
 */
function buildHostPorts(root) {
	const npm = npmBin();
	const curl = process.env.WFC_CURL || "curl";
	return {
		pathExists: (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined,
		linkTarget: (p) => {
			try {
				return fs.readlinkSync(p);
			} catch (err) {
				/* Absent, or no link: nothing links there (#4255). Any other
				 * fault throws, and the entry refuses on the record. */
				const code = caught(err).code;
				if (code === "ENOENT" || code === "EINVAL") return null;
				throw err;
			}
		},
		storesDir: () => path.join(root, STORES),
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
		startedAt: () => entryStartedAt() ?? Date.now(),
		allowNewPackage: Boolean(process.env.WFC_ALLOW_NEW_PACKAGE),
	};
}

module.exports = { buildHostPorts };
