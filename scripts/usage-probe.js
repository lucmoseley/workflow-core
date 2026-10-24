#!/usr/bin/env node
/*
 * usage-probe.js — the CLI over `lib/usage-probe.js`, for the callers that
 * cannot `await` it: `dispatch-sessions.sh`'s allowance gate and the refill
 * loop's synchronous stale-seat read (#2306).
 *
 * Usage: node usage-probe.js [--config-dir <dir>] [-- <claude flag>...]
 *
 * Prints whatever the probe printed on stdout, nothing where the cache was
 * fresh, for `allowance.js` to read on stdin; one `usage probe: <outcome>`
 * line on stderr, for a log. Flags after `--` go to `claude` before
 * `-p "/usage"`. The binary is WFC_CLAUDE_BIN, else `claude` on PATH; the
 * seat is --config-dir, else lib/config-dir.js's. A SIGTERM, SIGINT or SIGHUP
 * stops the probe's group before this exits, so a caller's own timeout
 * orphans nothing; only a SIGKILL does.
 *
 * Joins no §N3 family: it gates nothing and writes no file, and its caller
 * reads the exit code as which way the probe went.
 *
 * Exit codes: 0 a probe ran to an answer; 3 none ran, the cache being fresh;
 * 1 the probe would not start, met its ceiling or was stopped by a signal;
 * 2 on a command line it refuses.
 */

const { parseOrExit, flagValue } = require("./lib/cli-args.js");
const { configDir: defaultConfigDir } = require("./lib/config-dir.js");
const { claudeBin } = require("./lib/agent-liveness.js");
const { OUTCOME_PREFIX, probeUsage } = require("./lib/usage-probe.js");
const { writeFd } = require("./lib/write-fd.js");

const CLI = {
	usage:
		"usage: node usage-probe.js [--config-dir <dir>] [-- <claude flag>...]",
	flags: { "--config-dir": /** @type {const} */ ("value") },
	max: Number.POSITIVE_INFINITY,
};

/** @type {Record<import("./lib/usage-probe.js").ProbeOutcome, number>} */
const EXIT = {
	stopped: 0,
	finished: 0,
	cached: 3,
	"timed-out": 1,
	aborted: 1,
	failed: 1,
};

async function main() {
	const { flags, positionals } = parseOrExit(process.argv.slice(2), CLI);
	const abort = new AbortController();
	for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
		process.once(sig, () => abort.abort());
	const r = await probeUsage({
		configDir: flagValue(flags, "--config-dir") || defaultConfigDir(),
		claudeBin: claudeBin(),
		claudeArgs: positionals,
		signal: abort.signal,
	});
	writeFd(1, r.text);
	writeFd(
		2,
		`${OUTCOME_PREFIX}${r.outcome}${r.error ? ` (${r.error})` : ""}\n`,
	);
	process.exitCode = EXIT[r.outcome];
}

if (require.main === module) {
	main().then(
		() => process.exit(),
		(e) => {
			writeFd(2, `usage-probe: ${e.stack || e}\n`);
			process.exit(1);
		},
	);
}

module.exports = { main };
