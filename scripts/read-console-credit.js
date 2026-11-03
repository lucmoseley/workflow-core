#!/usr/bin/env node
/*
 * read-console-credit.js — read one overflow key's credit from the Console's
 * Billing page through a Chrome child on its plan seat, and log the result beside
 * the key's ledger (#4071, lib/console-credit.js).
 *
 *   node scripts/read-console-credit.js <overflow config dir>
 *
 * The refill loop starts it detached on lib/console-credit.js's cadence; run by
 * hand it reads at once. The child works from `/`, so no repo's hooks reach it.
 *
 * Exit 0 with the reading on stdout; 1 with why on stderr, the why also logged;
 * 2 on a usage error or a seat that is no overflow key.
 * Joins no §N3 family: nothing reads the code, as the loop reads the log.
 */

const path = require("node:path");
const { parseArgs } = require("node:util");
const {
	CHROME_TIMEOUT_MS_A_PAGE,
	spawnChild,
} = require("./lib/child-spawn.js");
const {
	appendConsoleRow,
	parseConsoleRead,
	planSeatOf,
	readSeatAccount,
} = require("./lib/console-credit.js");
const { readDeclaredSeats, seatOf } = require("./lib/refill-seats.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

/* A guess: past claude-child.js's own limit, so that limit is what kills the child. */
const CHILD_TIMEOUT_MS = CHROME_TIMEOUT_MS_A_PAGE + 30_000;
/* A guess: enough of a refusal to name it, in a one-line log row. */
const WHY_MAX_CHARS = 200;
const PROMPT_FILE = path.join(__dirname, "lib", "console-credit-prompt.txt");

/**
 * @typedef {{status: number|null, stdout: string, stderr: string}} ChildRun
 * @typedef {{runChild: (planDir: string) => ChildRun}} Deps
 */

/** @param {string} planDir */
function runChromeChild(planDir) {
	return spawnChild(
		process.execPath,
		[
			path.join(__dirname, "claude-child.js"),
			"chrome",
			"--config-dir",
			planDir,
			"--pages",
			"1",
			"--prompt-file",
			PROMPT_FILE,
		],
		{ cwd: "/", timeout: CHILD_TIMEOUT_MS },
	);
}

/**
 * @param {ChildRun} child
 * @param {string} planDir
 */
function parseChildRun(child, planDir) {
	if (child.status !== 0) {
		const firstLine = child.stderr.trim().replace(/\n[\s\S]*/, "");
		return {
			why: `the Chrome child failed: ${firstLine.slice(0, WHY_MAX_CHARS) || `exit ${child.status}`}`,
		};
	}
	return parseConsoleRead(child.stdout, readSeatAccount(planDir));
}

/**
 * @param {string[]} args
 * @param {Deps} [deps]
 * @returns {number}
 */
function main(args, deps = { runChild: runChromeChild }) {
	/** @type {string[]} */
	let positionals = [];
	try {
		({ positionals } = parseArgs({ args, allowPositionals: true }));
	} catch {
		/* An unknown flag: no positionals, so the usage line below answers it. */
	}
	const [dir, ...rest] = positionals;
	if (!dir || rest.length > 0) {
		writeFd(
			2,
			`usage: node ${scriptPath("read-console-credit.js")} <overflow config dir>\n`,
		);
		return 2;
	}
	const list = readDeclaredSeats();
	const seat = list.errors.length > 0 ? null : seatOf(list, dir);
	const planDir = seat?.kind === "overflow" ? planSeatOf(seat) : null;
	if (seat?.kind !== "overflow" || planDir === null) {
		writeFd(
			2,
			`${dir} is no overflow seat named <plan>-api in the seat file${list.errors.length > 0 ? `: ${list.errors.join("; ")}` : ""}\n`,
		);
		return 2;
	}
	const at = Date.now();
	const read = parseChildRun(deps.runChild(planDir), planDir);
	appendConsoleRow(seat, { at, ...read });
	if ("why" in read) {
		writeFd(2, `${seat.dir}: ${read.why}\n`);
		return 1;
	}
	writeFd(
		1,
		`${JSON.stringify({ seat: seat.dir, at, credits: read.credits })}\n`,
	);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
