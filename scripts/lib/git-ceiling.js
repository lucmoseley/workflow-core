const { execGit } = require("./git.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

// guess, #2210
const NOTICE_MS = 5000;

class CeilingPassed extends Error {}

/**
 * @typedef {{ git: (args: string[], opts: import("node:child_process").ExecFileSyncOptions, what: string) => string | Buffer }} GitCeiling
 */

/** @type {GitCeiling} */
const NO_CEILING = {
	git: (args, opts) => execGit(args, opts),
};

/**
 * @param {object} spec
 * @param {string} spec.label
 * @param {number} spec.ms
 * @param {() => number} [spec.now]
 * @param {(line: string) => void} [spec.say]
 * @returns {GitCeiling}
 */
function buildGitCeiling({
	label,
	ms,
	now = Date.now,
	say = (line) => writeFd(2, `${line}\n`),
}) {
	const start = now();
	const seconds = `${ms / 1000}s`;
	return {
		git(args, opts, what) {
			const used = now() - start;
			const left = ms - used;
			if (left <= 0)
				throw new CeilingPassed(
					`${label} passed its ${seconds} ceiling before ${what}; nothing it found is reported.`,
				);
			if (used >= NOTICE_MS)
				say(
					`${label}: waiting on ${what} (${Math.round(used / 1000)}s of ${seconds} used)`,
				);
			try {
				return execGit(args, {
					...opts,
					timeout: left,
					killSignal: "SIGKILL",
				});
			} catch (e) {
				if (caught(e).code === "ETIMEDOUT")
					throw new CeilingPassed(
						`${label} passed its ${seconds} ceiling waiting on ${what}, and killed it; nothing it found is reported.`,
						{ cause: e },
					);
				throw e;
			}
		},
	};
}

module.exports = { CeilingPassed, NO_CEILING, buildGitCeiling };
