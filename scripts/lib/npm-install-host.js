const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { entryStartedAt } = require("./hook-deadline.js");
const { npmBin } = require("./npm-bin.js");
const { call, curlBin } = require("./registry-call.js");
const { STORES } = require("./worktree-dirs.js");

// guess, lucmoseley/mantahostels#1803
const NPM_TIMEOUT_MS = 12_000;
// guess, lucmoseley/mantahostels#1803
const CURL_MAX_TIME_S = 8;

/**
 * @param {{ root: string }} env
 * @returns {import("./npm-install.js").NpmInstallPorts
 *   & import("./package-vetting.js").VettingPorts}
 */
function buildHostPorts({ root }) {
	const npm = npmBin();
	const curl = curlBin();
	return {
		pathExists: (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined,
		linkTarget: (p) => {
			try {
				return fs.readlinkSync(p);
			} catch (err) {
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
