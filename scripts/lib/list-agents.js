#!/usr/bin/env node
/*
 * list-agents.js — runs `<bin> agents --json` once per config dir, all at
 * once, and prints every stdout as one JSON array of strings, in the order the
 * dirs were given (#3512). lib/agent-liveness.js classifies and unions them.
 *
 * WHY ONE PER DIR. The listing is scoped to CLAUDE_CONFIG_DIR, and this machine
 * runs a plan under each of several, so a session missing from its own plan's
 * listing would read dead to a reader on another.
 *
 * WHY IN PARALLEL. Serially the reads cost the sum of three or four CLI starts
 * against agent-liveness.js's 10 s cap.
 *
 * WHY A PROCESS. Node's synchronous spawns can neither run children in
 * parallel nor start a process group, so agent-liveness spawns this under its
 * own timeout. Each read runs in a group of its own (lib/grouped-child.js), and
 * the SIGTERM that timeout sends kills every group (#2665).
 *
 * Every read is waited on before any is judged, so none outlives this process.
 * One that fails fails the whole call.
 *
 * Usage: node scripts/lib/list-agents.js <ceiling-ms> <bin> <config-dir>…
 * Exit: 0 with the array on stdout; else the first failed read's status, 128 +
 * the signal number where a signal ended it, 1 with why on stderr where the
 * backstop or output cap killed it, or 127 with the spawn code alone on stderr
 * where it would not start.
 */

const os = require("node:os");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { runGrouped } = require("./grouped-child.js");
const { writeFd } = require("./write-fd.js");

/* process.exit runs grouped-child's exit hook, which kills every live group. */
for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
	process.on(signal, () => process.exit(128 + os.constants.signals[signal]));

/**
 * @param {number} backstopMs  past the caller's own timeout, which is the cap
 *   that is meant to fire
 * @param {string} file  the `claude` binary
 * @param {string[]} configDirs
 * @returns {Promise<number>} the exit status
 */
async function main(backstopMs, file, configDirs) {
	const reads = await Promise.all(
		configDirs.map((dir) =>
			runGrouped(file, ["agents", "--json"], {
				cwd: process.cwd(),
				env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
				timeoutMs: backstopMs,
				maxBuffer: CHILD_MAX_BUFFER,
			}),
		),
	);
	for (const r of reads) {
		if (r.spawnCode) {
			writeFd(2, r.spawnCode);
			return 127;
		}
		if (r.killedFor) {
			writeFd(2, r.killedFor);
			return 1;
		}
		if (r.signal) return 128 + os.constants.signals[r.signal];
		if (r.code !== 0) return r.code ?? 1;
	}
	writeFd(1, JSON.stringify(reads.map((r) => r.stdout)));
	return 0;
}

const { positionals } = parseArgs({ allowPositionals: true, strict: true });
const [ceiling, bin, ...dirs] = positionals;
const ceilingMs = Number(ceiling);
if (!(ceilingMs > 0) || !bin || dirs.length === 0) {
	writeFd(2, "usage: list-agents.js <ceiling-ms> <bin> <config-dir>…\n");
	process.exit(2);
}
main(ceilingMs, bin, dirs).then(
	(status) => process.exit(status),
	(e) => {
		writeFd(2, String(caught(e).message));
		process.exit(1);
	},
);
