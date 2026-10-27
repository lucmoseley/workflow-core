#!/usr/bin/env node
/*
 * allowance.js — the thin CLI over `lib/allowance.js`, for `dispatch-sessions.sh`
 * (a bash caller) to shell out to; `admission.js` (Node) `require`s the lib
 * in-process instead (workflow-core#293).
 *
 * Usage: node allowance.js [--json] [--config-dir <dir>]
 *          [--cap <members> --session-threshold <pct> --week-threshold <pct>]
 *
 * The printed `claude -p "/usage"` transcript, where the caller has one, is
 * read from STDIN — piped, never a flag, because it can be arbitrarily long
 * and a bash caller already has it in a variable.
 *
 * Exit codes:
 *   0  both bars read as trustworthy (kind: "fresh")
 *   1  at least one bar is not — the caller's ceiling refusal is its own to
 *      write; this exit code is trust, never a ceiling verdict (workflow-core#293 ruling 2)
 *   2  an unknown flag or a value flag with no value (lib/cli-args.js)
 *
 * `--cap` adds a `cap` key to `--json`'s payload: how many of a set's
 * `<members>` launch under `lib/allowance.js#capSet`, against the thresholds
 * the caller owns, and `cap.floored` whether that launch is the floor's one
 * member alone. Only where a trusted bar is past its threshold does it read
 * the running sessions — one `claude agents --json` call and their own
 * transcripts, no allowance spent. A bar counts only the spend projected to
 * land before its own `resetsAt`, by the cost table's `landedByHours`; spend
 * after it falls in the next window, and a reset that does not parse counts
 * all of it (workflow-core#2925). `cap.error` is set, and `cap.launch` is 0,
 * where that read cannot be made: the cost table is unreadable, or the listing
 * will not answer. Never changes the exit code.
 */

const fs = require("node:fs");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { writeFd } = require("./lib/write-fd.js");
const { configDir: defaultConfigDir } = require("./lib/config-dir.js");
const {
	readAllowance,
	capSet,
	isWarned,
	POINTS_PER_USD,
} = require("./lib/allowance");
const { listedAgents } = require("./lib/agent-liveness");
const {
	readCostTable,
	runningRemainders,
	landedShare,
} = require("./lib/session-spend");
const { scriptPath } = require("./lib/script-path.js");

const CLI = {
	usage:
		"usage: node allowance.js [--json] [--config-dir <dir>] [--cap <members> --session-threshold <pct> --week-threshold <pct>]",
	flags: {
		"--json": /** @type {const} */ ("boolean"),
		"--config-dir": /** @type {const} */ ("value"),
		"--cap": /** @type {const} */ ("value"),
		"--session-threshold": /** @type {const} */ ("value"),
		"--week-threshold": /** @type {const} */ ("value"),
	},
};

/** @param {string[]} argv */
function parseArgs(argv) {
	const { flags } = parseOrExit(argv, CLI);
	const num = (/** @type {string} */ flag) => {
		const v = flagValue(flags, flag);
		return v === undefined ? null : Number(v);
	};
	return {
		json: flags["--json"] === true,
		configDir: flagValue(flags, "--config-dir"),
		cap: num("--cap"),
		sessionThreshold: num("--session-threshold"),
		weekThreshold: num("--week-threshold"),
	};
}

/**
 * @param {ReturnType<typeof readAllowance>} result
 * @param {ReturnType<typeof parseArgs>} args
 */
function capOf(result, args) {
	const members = /** @type {number} */ (args.cap);
	// Thresholds are the caller's to own (workflow-core#293 ruling 2), so there is no
	// default here; a missing or non-numeric one refuses rather than reading as
	// NaN, which no reading is past, and launching the whole set.
	if (
		!Number.isInteger(members) ||
		members < 0 ||
		!Number.isFinite(args.sessionThreshold) ||
		!Number.isFinite(args.weekThreshold)
	)
		return {
			launch: 0,
			error: `--cap, --session-threshold and --week-threshold need numbers, got ${args.cap}, ${args.sessionThreshold}, ${args.weekThreshold}`,
		};
	// A trusted bar always carries a percent (`lib/allowance.js#readOne`).
	const readings = {
		session: result.session.percent ?? 0,
		weekly_all: result.weekly_all.percent ?? 0,
	};
	const thresholds = {
		session: /** @type {number} */ (args.sessionThreshold),
		weekly_all: /** @type {number} */ (args.weekThreshold),
	};
	const none = { session: 0, weekly_all: 0 };
	if (
		!isWarned("session", readings, thresholds) &&
		!isWarned("weekly_all", readings, thresholds)
	)
		return {
			...capSet({
				readings,
				thresholds,
				members,
				runningPoints: none,
				perSessionPoints: none,
			}),
			running: [],
		};
	const table = readCostTable();
	if (!table)
		return {
			launch: 0,
			error: `the session cost table is unreadable — build it: node ${scriptPath("measure-session-cost.js")} --write`,
		};
	const listed = listedAgents({ requireSelf: false });
	// An empty listing is the one `why` that still answers: nothing is running,
	// as from a terminal with no session open.
	const agents = listed.why?.includes("listed no agents at all")
		? []
		: listed.agents;
	if (!agents)
		return { launch: 0, error: `running sessions unreadable: ${listed.why}` };
	const configDir = args.configDir || defaultConfigDir();
	const running = runningRemainders({
		agents,
		table,
		configDir,
	});
	const runningUsd = running.reduce((s, r) => s + r.remainderUsd, 0);
	/** @param {"session" | "weekly_all"} bar */
	const landed = (bar) => {
		const resetMs = Date.parse(result[bar].resetsAt ?? "");
		return Number.isNaN(resetMs)
			? 1
			: landedShare(table, (resetMs - Date.now()) / 3_600_000);
	};
	const share = {
		session: landed("session"),
		weekly_all: landed("weekly_all"),
	};
	const points = (/** @type {number} */ usd) => ({
		session: usd * share.session * POINTS_PER_USD.session,
		weekly_all: usd * share.weekly_all * POINTS_PER_USD.weekly_all,
	});
	return {
		...capSet({
			readings,
			thresholds,
			members,
			runningPoints: points(runningUsd),
			perSessionPoints: points(table.meanUsd),
		}),
		running,
	};
}

function readStdin() {
	try {
		return fs.readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const usageText = readStdin();
	const result = readAllowance({ configDir: args.configDir, usageText });
	const trustworthy =
		result.session.trust === "fresh" && result.weekly_all.trust === "fresh";

	if (args.json) {
		const payload =
			args.cap !== null && trustworthy
				? { ...result, cap: capOf(result, args) }
				: result;
		writeFd(1, `${JSON.stringify(payload)}\n`);
		return trustworthy ? 0 : 1;
	}

	const line = (
		/** @type {string} */ label,
		/** @type {import("./lib/allowance").Bar} */ bar,
	) =>
		`${label}  ${bar.percent === null ? "unreadable" : `${bar.percent}%`} (${bar.trust})${bar.resetsAt ? `, resets ${bar.resetsAt}` : ""}`;
	writeFd(
		1,
		`${line("session    ", result.session)}\n${line("weekly_all ", result.weekly_all)}\n`,
	);
	return trustworthy ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { main };
