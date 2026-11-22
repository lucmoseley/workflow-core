#!/usr/bin/env node

const { execFile } = require("node:child_process");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");

const notify = require("./lib/notify-report.js");
const { delivered } = require("./lib/delivery-stamp.js");
const {
	readPersistingProducers,
	judge,
	parkStamps,
} = require("./lib/persist-replay.js");
const {
	readSessionStartRoster,
	KEY_OVERRIDES,
} = require("./lib/session-start-roster.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");

const REPO = hostRoot();

/** @typedef {import("./lib/persist-replay.js").Producer} Producer */
/** @typedef {import("./lib/persist-replay.js").RunOutcome} RunOutcome */

const PRODUCERS = readPersistingProducers(REPO);

/**
 * @param {string[]} argv
 * @param {{ env: NodeJS.ProcessEnv, timeoutMs: number }} opts
 */
function run(argv, { env, timeoutMs }) {
	const started = Date.now();
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			argv,
			// lucmoseley/mantahostels#1977 measured: largest report 15 kB (ci-status), so 32 MB is three orders over
			{ cwd: REPO, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
			(err, stdout, stderr) => {
				/** @type {number | null} */
				let code = 0;
				if (err && typeof err.code === "number") code = err.code;
				else if (err) code = null;
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code,
					killed: Boolean(err && /** @type {any} */ (err).killed),
					ms: Date.now() - started,
				});
			},
		);
	});
}

/**
 * @param {Producer[]} producers
 * @param {{ persist: boolean, timeoutMs: number }} opts
 * @returns {Promise<Record<string, RunOutcome>>}
 */
function stampede(producers, { persist, timeoutMs }) {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, CLAUDE_PROJECT_DIR: REPO };
	if (persist) env.WFC_NOTIFY_PERSIST = "1";
	else delete env.WFC_NOTIFY_PERSIST;
	return Promise.all(
		producers.map(async (p) => [
			p.key,
			await run([path.join(__dirname, p.script), "--notify"], {
				env,
				timeoutMs,
			}),
		]),
	).then((pairs) => Object.fromEntries(pairs));
}

/** @returns {string[]} */
function readWiredRoster() {
	return readSessionStartRoster(REPO, { keyOverrides: KEY_OVERRIDES })
		.map((p) => p.key)
		.sort();
}

/** @param {Producer[]} producers */
function buildWiredLine(producers) {
	const wired = readWiredRoster();
	if (wired.length === 0)
		return "The repo's hooks wire no persisting producer — main() has already refused to run over an empty PRODUCERS by the time this prints.";
	const expected = producers.map((p) => p.key).sort();
	const missing = expected.filter((k) => !wired.includes(k));
	const extra = wired.filter((k) => !expected.includes(k));
	if (missing.length === 0 && extra.length === 0)
		return `The repo's hooks wire the same ${wired.length} producer(s) this table holds — membership only, never their timeouts.`;
	return `The hooks' persist set has drifted from this table — wired but untested: ${extra.join(", ") || "none"}; tested but unwired: ${missing.join(", ") || "none"}.`;
}

const USAGE = `usage: node ${scriptPath("verify-persist-replay.js")} [--json] [--timeout <s>] [--only <key>[,<key>...]] [--no-control]`;

/** @param {string[]} argv */
function parseArgs(argv) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: {
			"--json": "boolean",
			"--no-control": "boolean",
			"--timeout": "value",
			"--only": "value",
		},
	});
	const only = flags["--only"];
	return {
		json: flags["--json"] === true,
		control: flags["--no-control"] !== true,
		// lucmoseley/mantahostels#1921 measured: 34.3 s worst case under the stampede; 180 s is five times it
		timeoutMs: Number(flags["--timeout"] ?? 180) * 1000,
		only: typeof only === "string" ? new Set(only.split(",")) : null,
	};
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const producers = selectProducers(opts.only);
	if (!producers) {
		process.exitCode = 2;
		return;
	}

	const from = Date.now();
	const persistRuns = await stampede(producers, {
		persist: true,
		timeoutMs: opts.timeoutMs,
	});
	const to = Date.now();

	const { reports, open } = readReports(producers);

	/** @type {Record<string, RunOutcome>} */
	const controlRuns = opts.control
		? await controlPhase(producers, reports, opts.timeoutMs)
		: {};

	const rows = producers.map((p) =>
		judgeProducer(p, {
			persistRuns,
			controlRuns,
			reports,
			open,
			window: { from, to },
		}),
	);
	const faulted = rows.filter((r) => r.faults.length);

	if (opts.json) {
		writeFd(
			1,
			`${JSON.stringify(
				{ base: notify.base(), wired: readWiredRoster(), rows },
				null,
				2,
			)}\n`,
		);
	} else printTable(producers, rows, faulted, opts.control);
	// process.exit() can cut off pending writes to a piped stdout: https://nodejs.org/api/process.html#processexitcode
	process.exitCode = faulted.length > 0 ? 1 : 0;
}

/** @param {Set<string> | null} only */
function selectProducers(only) {
	const producers = only ? PRODUCERS.filter((p) => only.has(p.key)) : PRODUCERS;
	if (only && producers.length !== only.size) {
		const known = PRODUCERS.map((p) => p.key);
		const unknown = [...only].filter((k) => !known.includes(k));
		writeFd(
			2,
			`no such producer: ${unknown.join(", ")}. Known: ${known.join(", ")}\n`,
		);
		return null;
	}
	if (producers.length === 0) {
		writeFd(
			2,
			"self-plugin/hooks/hooks.json wires no persisting producer — nothing to verify.\n",
		);
		return null;
	}
	return producers;
}

/** @param {typeof PRODUCERS} producers */
function readReports(producers) {
	/** @type {Record<string, import("./lib/notify-report.js").Report|null>} */
	const reports = {};
	/** @type {Record<string, boolean>} */
	const open = {};
	for (const p of producers) {
		reports[p.key] = notify.readReport(p.key);
		open[p.key] = notify.readRun(p.key) !== null;
	}
	return { reports, open };
}

/**
 * @param {typeof PRODUCERS} producers
 * @param {Record<string, import("./lib/notify-report.js").Report|null>} reports
 * @param {number} timeoutMs
 */
async function controlPhase(producers, reports, timeoutMs) {
	const restore = parkStamps(producers, reports);
	try {
		return await stampede(producers, { persist: false, timeoutMs });
	} finally {
		restore();
	}
}

/**
 * @param {(typeof PRODUCERS)[number]} p
 * @param {{
 *   persistRuns: Record<string, RunOutcome>,
 *   controlRuns: Record<string, RunOutcome>,
 *   reports: Record<string, import("./lib/notify-report.js").Report|null>,
 *   open: Record<string, boolean>,
 *   window: { from: number, to: number },
 * }} phases
 */
function judgeProducer(p, { persistRuns, controlRuns, reports, open, window }) {
	const persistRun = persistRuns[p.key];
	const report = reports[p.key];
	const runOpen = open[p.key];
	if (persistRun === undefined || report === undefined || runOpen === undefined)
		throw new Error(`${p.key} was launched and read, yet has no entry`);
	const stamp = report?.stamp;
	return judge(p, {
		persistRun,
		controlRun: controlRuns[p.key] ?? null,
		report,
		runOpen,
		window,
		stampSeen: Boolean(stamp && delivered(p.key, stamp)),
	});
}

/**
 * @param {typeof PRODUCERS} producers
 * @param {ReturnType<typeof judge>[]} rows
 * @param {ReturnType<typeof judge>[]} faulted
 * @param {boolean} control
 */
function printTable(producers, rows, faulted, control) {
	writeFd(
		1,
		`persist-and-replay verification — ${producers.length} producer(s)\n`,
	);
	writeFd(1, `reports under ${notify.base()}\n`);
	writeFd(1, `${buildWiredLine(producers)}\n\n`);
	writeFd(
		1,
		"  key                       outcome  bytes  persist  control  match\n",
	);
	for (const r of rows)
		writeFd(
			1,
			`  ${r.key.padEnd(24)}  ${String(r.outcome ?? "-").padEnd(7)}  ${String(r.bytes).padStart(5)}  ${`${r.persistMs}ms`.padStart(7)}  ${`${r.controlMs ?? "-"}ms`.padStart(7)}  ${r.match}\n`,
		);
	for (const r of rows) {
		if (r.diff)
			writeFd(
				1,
				`\n▸ ${r.key} differs between the two phases:\n--- persisted\n${r.diff.persisted}\n--- live\n${r.diff.control}\n`,
			);
	}
	for (const r of faulted)
		for (const f of r.faults) writeFd(1, `\nFAULT ${r.key}: ${f}\n`);
	writeFd(1, `${buildVerdictLine(faulted.length, control)}\n`);
}

/** @param {number} faultedCount @param {boolean} control */
function buildVerdictLine(faultedCount, control) {
	if (faultedCount > 0)
		return `\nFAIL: ${faultedCount} producer(s) with faults.`;
	if (control)
		return "\nOK: every producer persisted a well-formed report reflecting its live finding.";
	return "\nOK: every producer persisted a well-formed report — its CONTENT is unchecked, --no-control having skipped the comparison.";
}

module.exports = { main };

if (require.main === module) {
	main().catch((e) => {
		writeFd(2, `${e?.message ?? String(e)}\n`);
		process.exit(2);
	});
}
