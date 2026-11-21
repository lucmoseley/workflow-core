#!/usr/bin/env node
const { readCommitsBy } = require("./lib/arbiter-ledger.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { readText } = require("./lib/file-read.js");
const { gateRunLogPath, readGateRunsAt } = require("./lib/gate-seat.js");
const {
	firstHeldAt,
	renderReplay,
	renderSweep,
	unreadLine,
} = require("./lib/gate-budget-replay.js");
const { gitOrNull } = require("./lib/git.js");
const { parseJsonl } = require("./lib/jsonl.js");
const { BUDGET_RULE } = require("./lib/refill-budget.js");
const { breakerRecordPath } = require("./lib/refill-breaker.js");
const { scriptPath } = require("./lib/script-path.js");
const {
	GIT_LOG_TIMEOUT_MS,
	readSuiteCommand,
} = require("./lib/throughput-reads.js");
const { writeFd } = require("./lib/write-fd");

const USAGE = `usage: node ${scriptPath("replay-gate-budget.js")} [options]
  --record <file>          the breaker's record (default: the loop's)
  --streak <n>             failed whole-suite runs in a row that park (default ${BUDGET_RULE.streakLimit})
  --backstop <n>           counted runs since a landing that park (default ${BUDGET_RULE.backstopRuns})
  --systemic-sessions <n>  other sessions whose ceilings make one systemic (default ${BUDGET_RULE.systemicSessions})
  --systemic-hours <n>     the window they are read over (default ${BUDGET_RULE.systemicWindowMs / 3_600_000})
  --sleep-s <n>            wall time past awake time that marks a sleep (default ${BUDGET_RULE.sleepAllowanceS})
  --sweep                  try streaks 2-6 against backstops 6-14 instead`;

const NUMBER_FLAGS = /** @type {const} */ ([
	["--streak", "streakLimit", 1],
	["--backstop", "backstopRuns", 1],
	["--systemic-sessions", "systemicSessions", 1],
	["--systemic-hours", "systemicWindowMs", 3_600_000],
	["--sleep-s", "sleepAllowanceS", 1],
]);

/**
 * @param {string[]} args
 * @param {string} root
 */
const git = (args, root) =>
	gitOrNull(["-C", root, ...args], { timeout: GIT_LOG_TIMEOUT_MS });

/**
 * @param {string} root
 * @returns {{at: number, sha: string}[]}
 */
function readMainReflog(root) {
	const out = git(
		[
			"reflog",
			"show",
			"--date=unix",
			"--format=%H %gd",
			"refs/remotes/origin/main",
		],
		root,
	);
	return (out ?? "")
		.split("\n")
		.flatMap((line) => {
			const m = /^([0-9a-f]+) .*@\{(\d+)\}$/.exec(line);
			return m ? [{ at: Number(m[2]) * 1000, sha: m[1] ?? "" }] : [];
		})
		.sort((a, b) => a.at - b.at);
}

/**
 * @param {string} root
 * @param {string} session
 * @param {{at: number, sha: string}[]} reflog
 * @returns {import("./lib/gate-budget-replay.js").Landing[]|null}
 */
function readLandings(root, session, reflog) {
	const shas = readCommitsBy(session, root);
	if (shas === null) return null;
	return shas.flatMap((sha) => {
		const ct = git(["log", "-1", "--format=%ct", sha], root);
		const arrivedAt =
			ct === null
				? null
				: firstHeldAt(
						reflog,
						(entry) =>
							git(["merge-base", "--is-ancestor", sha, entry], root) !== null,
					);
		return arrivedAt === null
			? []
			: [{ arrivedAt, at: Number(ct?.trim()) * 1000 }];
	});
}

/**
 * @param {import("./lib/gate-budget-replay.js").Park[]} parks
 */
function readInputs(parks) {
	/** @type {import("./lib/gate-budget-replay.js").ParkInput[]} */
	const inputs = [];
	const notes = [];
	/** @type {Map<string, {runs: import("./lib/gate-seat.js").GateRun[]|null, suite: string|null, reflog: {at: number, sha: string}[]}>} */
	const roots = new Map();
	for (const park of parks) {
		let root = roots.get(park.repo);
		if (!root) {
			root = {
				runs: readGateRunsAt(gateRunLogPath(park.repo)),
				suite: readSuiteCommand(park.repo),
				reflog: readMainReflog(park.repo),
			};
			roots.set(park.repo, root);
		}
		const { runs, suite, reflog } = root;
		if (runs === null || suite === null) {
			notes.push(
				unreadLine(park, runs === null ? "gate-run record" : "commands.test"),
			);
			continue;
		}
		const landings = readLandings(park.repo, park.session, reflog);
		if (landings === null) notes.push(unreadLine(park, "commit ledger"));
		inputs.push({
			park,
			repoRuns: runs,
			suiteCommand: suite,
			landings: landings ?? [],
		});
	}
	return { inputs, notes };
}

/**
 * @param {string} message
 * @returns {2}
 */
function refuse(message) {
	writeFd(2, `${message}\n\n${USAGE}\n`);
	return 2;
}

/** @returns {0 | 2} */
function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--record": "value",
			"--sweep": "boolean",
			...Object.fromEntries(NUMBER_FLAGS.map(([flag]) => [flag, "value"])),
		},
	});
	if (typeof parsed === "number") return parsed;
	const { flags } = parsed;
	/** @type {import("./lib/refill-budget.js").BudgetRule} */
	const rule = { ...BUDGET_RULE };
	for (const [flag, key, scale] of NUMBER_FLAGS) {
		const given = flagValue(flags, flag);
		if (given === undefined) continue;
		const n = Number(given);
		if (!(n > 0)) return refuse(`${flag} ${given} is not a positive number`);
		rule[key] = n * scale;
	}
	const file = flagValue(flags, "--record") ?? breakerRecordPath();
	const read = readText(file);
	if (read.state !== "read")
		return refuse(`the breaker's record ${file} will not read`);
	const parks = /** @type {import("./lib/gate-budget-replay.js").Park[]} */ (
		parseJsonl(read.data).rows.filter((r) => r.event === "budget-park")
	);
	const { inputs, notes } = readInputs(parks);
	const body =
		flags["--sweep"] === true
			? renderSweep(
					inputs,
					{ streaks: [2, 3, 4, 5, 6], backstops: [6, 8, 10, 12, 14] },
					rule,
				)
			: renderReplay(inputs, rule);
	writeFd(1, `${[...notes, body].join("\n")}\n`);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
