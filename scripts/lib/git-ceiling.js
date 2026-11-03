/*
 * git-ceiling.js — one ceiling over every git read a run makes (workflow-core#2210).
 *
 * Every wait `check-instruction-surface.js --touched-by` makes is a git read,
 * so each is killed at what is left of the ceiling, and passing it is a thrown
 * CeilingPassed naming the read it was in.
 *
 * The reads are synchronous, so nothing can print while one is blocked. Once a
 * run has used NOTICE_MS, each later read is named on stderr before it starts,
 * so the post-commit hook, which prints whatever is not OK, stays quiet on a
 * normal commit.
 *
 * Residual: a CPU loop between reads (shfmt, typescript) is caught only at the
 * next read, and a git process the kernel cannot kill (uninterruptible sleep)
 * still holds the run, since Node waits on its exit.
 */

const { execGit } = require("./git.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/* A judgement (workflow-core#2210): a run before it waits silently longer than a person
 * would before wondering whether it hung. */
const NOTICE_MS = 5000;

/** The ceiling passed: the run stops, naming the read it was in. */
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
 * @param {string} spec.label what the run is, as the refusal names it
 * @param {number} spec.ms the ceiling
 * @param {() => number} [spec.now] the clock, for the suite
 * @param {(line: string) => void} [spec.say] where a wait is named
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
					/* A git hung in a lock or a pipe may ignore TERM (workflow-core#2210). */
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
