const fs = require("node:fs");
const path = require("node:path");
const { HOOK_GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");

// workflow-core#3162 guess: a probe is tens of lines; the largest tracked script was 66 KiB
const READ_CAP = 256 * 1024;

function buildHostPorts() {
	return {
		/** @param {string} abs @returns {string | null} */
		readScript: (abs) => {
			try {
				if (fs.statSync(abs).size > READ_CAP) return null;
				return fs.readFileSync(abs, "utf8");
			} catch {
				return null;
			}
		},
		/** @param {string} abs @returns {boolean | null} */
		isTracked: (abs) => {
			const r = spawnGitSync(
				["ls-files", "--error-unmatch", "--", path.basename(abs)],
				{
					cwd: path.dirname(abs),
					env: { ...process.env, LC_ALL: "C" },
					encoding: "utf8",
					timeout: HOOK_GIT_TIMEOUT_MS,
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
			if (r.status === 0) return true;
			if (r.status === 1) return false;
			if (r.status === 128 && /not a git repository/.test(String(r.stderr)))
				return false;
			return null;
		},
	};
}

module.exports = { buildHostPorts };
