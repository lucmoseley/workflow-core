/*
 * npm-install-host.js — the production ports the dispatcher wires into the
 * guard-npm-install core, lib/npm-install.js (workflow-core#2800, workflow-core#3226).
 *
 * THE SEAMS. WFC_NPM and WFC_CURL name the two registry programs
 * (lib/npm-bin.js, lib/registry-call.js).
 *
 * THE TIMEOUTS. `npm view` gets 12 s and curl 8 s, both its own `--max-time`
 * and the spawn's: 20 s a package, which the core's 30 s budget is sized
 * against under the hook's 60 s ceiling (lib/package-vetting.js). Both are guesses, never measured,
 * carried from the bash guard that set them at workflow-core#1803: generous beside a
 * registry answer's usual second or so.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { entryStartedAt } = require("./hook-deadline.js");
const { npmBin } = require("./npm-bin.js");
const { call, curlBin } = require("./registry-call.js");
const { STORES } = require("./worktree-dirs.js");

const NPM_TIMEOUT_MS = 12_000;
const CURL_MAX_TIME_S = 8;

/**
 * The dependency stores are the host root's; the session tree's package.json
 * and manifests the core reads through its tree ports (workflow-core#4242).
 * @param {string} root the host root
 * @returns {import("./npm-install.js").NpmInstallPorts
 *   & import("./package-vetting.js").VettingPorts}
 */
function buildHostPorts(root) {
	const npm = npmBin();
	const curl = curlBin();
	return {
		pathExists: (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined,
		linkTarget: (p) => {
			try {
				return fs.readlinkSync(p);
			} catch (err) {
				/* Absent, or no link: nothing links there (workflow-core#4255). Any other
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
