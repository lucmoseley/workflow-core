#!/usr/bin/env node
const { parseOrExit, flagValue } = require("./lib/cli-args.js");
const { configDir: defaultConfigDir } = require("./lib/config-dir.js");
const { claudeBin } = require("./lib/agent-liveness.js");
const { OUTCOME_PREFIX, probeUsage } = require("./lib/usage-probe.js");
const { writeFd } = require("./lib/write-fd.js");
const { now } = require("./lib/check.js");

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
		configDir: flagValue(flags, "--config-dir") ?? defaultConfigDir(),
		claudeBin: claudeBin(),
		claudeArgs: positionals,
		signal: abort.signal,
		now: now(),
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
