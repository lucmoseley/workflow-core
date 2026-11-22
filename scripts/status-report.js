#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");
const { hostRoot } = require("./lib/host-root.js");
const { pool } = require("./lib/pool.js");
const { render } = require("./lib/status-render.js");

const CORE_SCRIPTS = __dirname;

const POOL_WIDTH = 4;

/** @type {ReadonlyArray<readonly [string, string, ...string[]]>} */
const CHECKS = [
	["guard-errors", "check-guard-errors.js"],
	["hook-liveness", "check-hook-liveness.js"],
	["stop-guards", "check-stop-guard-outcomes.js"],
	["issue-labels", "check-issue-labels.js"],
	["file-claims", "check-stranded-file-claims.js"],
	["suite-queue", "check-stale-suite-queue.js"],
	["ghost-jobs", "check-ghost-jobs.js"],
	["tracker-sweep", "check-tracker-sweep.js"],
	["stray-scratch", "check-stray-scratch.js"],
	["manual-freshness", "check-manual-freshness.js"],
	["captures", "check-capture-drain.js"],
	["cleared-trackers", "check-cleared-trackers.js"],
	["context-budget", "check-context-budget.js"],
	["always-loaded-pass", "check-always-loaded-pass.js"],
	["scripts-typecheck", "check-scripts-typecheck.js"],
	["suite-size", "check-suite-size-drift.js"],
	["suite-margin", "check-suite-margin.js"],
	["time-to-land", "check-time-to-land.js"],
	["file-ci-time", "check-file-ci-time.js"],
	["contract-live", "check-contract-live.js"],
	["pass-store", "check-pass-store.js"],
	["pick-next-model", "check-pick-next-model.js"],
	["history-trim", "check-history-trim.js"],
	["gates", "check-gates.js"],
	["skill-body-size", "check-skill-body-size.js"],
	["marker-integrity", "check-marker-integrity.js"],
	["release-pin", "check-release-pin.js"],
	["release-lag", "check-release-lag.js"],
	["main-checkout-cutover", "check-main-checkout-cutover.js"],
	["band-drift", "check-band-drift.js"],
	["citation-ceiling", "check-citation-ceiling.js"],
	["orphaned-edits", "check-orphaned-edits.js"],
	["git-locks", "check-stale-git-locks.js"],
	["orphan-reaps", "check-orphan-reaps.js"],
	["husky-shim", "check-husky-shim.js"],
	["primitives", "check-primitives.js"],
	["adopter-boundary", "check-adopter-boundary.js"],
	["verdict-proof", "check-verdict-proof.js"],
	["output-style", "check-output-style.js"],
	["held-reports", "replay-notify-reports.js", "--status"],
	["jev-flags", "check-jev-flags.js", "--notify"],
	["escape-audit", "audit-escape-lines.js"],
	["throttling", "check-self-throttling.js"],
	["config-links", "link-config-dirs.js", "--check"],
	["effort-guide-routing", "generate-effort-guide-routing.js", "--check"],
	["harness-canary", "check-harness-canary.js"],
	["concurrency", "concurrency-readout.js"],
	["interop-latency", "check-interop-latency.js"],
	["kernel-stall", "check-kernel-stall.js"],
	["wsl-currency", "check-wsl-currency.js"],
	["wsl-disk", "check-wsl-disk.js"],
	["retry-watchdog", "check-retry-watchdog.js"],
	["idle-efforts", "check-idle-efforts.js"],
	["unclosed-launches", "check-unclosed-launches.js"],
	["compaction-backstop", "check-compaction-backstop.js"],
	["session-draw", "check-session-draw.js"],
	["peak-tripwire", "check-peak-tripwire.js"],
];

const WRITERS = new Set(["band-drift", "history-trim", "orphaned-edits"]);

/** @typedef {import("./lib/status-render.js").Result} Result */

/** @param {string} msg */
function fail(msg) {
	writeFd(2, `status-report: ${msg}\n`);
}

/**
 * @param {readonly [string, string, ...string[]]} entry
 * @param {boolean} write
 * @returns {Promise<Result>}
 */
function run(entry, write) {
	const [name, script, ...args] = entry;
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				path.join(CORE_SCRIPTS, script),
				...args,
				...(write && WRITERS.has(name) ? ["--write"] : []),
			],
			{
				cwd: hostRoot(),
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("error", (err) =>
			resolve({
				name,
				code: null,
				signal: null,
				out: `did not run: ${err.message}`,
			}),
		);
		child.on("close", (code, signal) =>
			resolve({ name, code, signal, out: out.trim() }),
		);
	});
}

async function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage:
			`usage: node ${scriptPath("status-report.js")} [--only <substring>] [--serial] [--write]\n` +
			`  e.g. \`node ${scriptPath("status-report.js")} --only gates\``,
		flags: { "--only": "value", "--serial": "boolean", "--write": "boolean" },
	});
	const onlyValue = flagValue(flags, "--only") ?? null;
	const write = flags["--write"] === true;
	const selected = onlyValue
		? CHECKS.filter(([name]) => name.includes(onlyValue))
		: CHECKS;
	if (selected.length === 0) {
		fail(`no checker matches --only ${String(onlyValue)}`);
		process.exit(2);
	}

	/** @type {Result[]} */
	const results = [];
	if (flags["--serial"] === true) {
		for (const c of selected) results.push(await run(c, write));
	} else {
		results.push(...(await pool(selected, POOL_WIDTH, (c) => run(c, write))));
	}
	writeFd(1, render(results));
}

module.exports = { main };
if (require.main === module)
	main().catch((err) => {
		fail(err.message);
		process.exitCode = 1;
	});
