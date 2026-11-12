/*
 * run-command.js — one command's trimmed stdout, or why it failed in `error`, so
 * a caller reports the failure itself: an installer every failure rather than
 * stopping at the first, `refill-loop.js watch` its restart's.
 */

const { spawnSync } = require("node:child_process");

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv}} [opts]  the child's environment, else this one's
 */
function runCommand(file, args, opts = {}) {
	const r = spawnSync(file, args, { encoding: "utf8", env: opts.env });
	const out = (r.stdout ?? "").trim();
	if (r.error) return { out, error: `${file}: ${r.error.message}` };
	if (r.status !== 0)
		return {
			out,
			error: `${file} ${args.join(" ")} exited ${r.status}: ${(r.stderr ?? "").trim()}`,
		};
	return { out, error: null };
}

module.exports = { runCommand };
