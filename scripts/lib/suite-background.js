const { QUOTED, carriesVar, literal } = require("./shell-words.js");
const {
	BASH_SPACE,
	asWritten,
	parseCommand,
	walkCommands,
} = require("./shell-parse.js");
const {
	afterSlash,
	suiteLaunchKind,
	buildIsWrapperScript,
} = require("./suite-launch.js");
const { launchTestFileCount } = require("./suite-bounded.js");
const { endRun, trimEndRun } = require("./trim-run.js");
const { SNAPSHOT_RUN_TIMEOUT_MS } = require("./wait-text.js");

const ANY_SESSION = "hook";

/**
 * @typedef {object} BackgroundPorts
 * @property {() => string[]} runners
 * @typedef {import("./core-contract.js").CoreContext & BackgroundPorts} Ctx
 */

const SP = "[ \\t\\v\\f\\r]";

const NOT_DETACHING = ["&&", "&>", "|&", ">&", "<&"];

const DETACHER = /(^|[^A-Za-z0-9_-])(nohup|setsid|disown)([^A-Za-z0-9_.-]|$)/m;

/** @param {string} s */
function detaches(s) {
	if (DETACHER.test(s)) return true;
	return NOT_DETACHING.reduce((t, op) => t.split(op).join("  "), s).includes(
		"&",
	);
}

const DETACH_REWRITES = /** @type {const} */ ([
	[
		new RegExp(
			`(^|[ \\t\\v\\f\\r;|&(])(/[^ \\t\\v\\f\\r]*/)?(nohup|setsid)(${SP}+-[^ \\t\\v\\f\\r]+)*(${SP}+|$)`,
			"g",
		),
		"$1",
	],
	[
		new RegExp(
			`(^|[ \\t\\v\\f\\r;|&(])disown(${SP}+[^ \\t\\v\\f\\r;|&]+)*${SP}*`,
			"g",
		),
		"$1",
	],
	[new RegExp(`&${SP}*(;|$)`, "g"), "$1"],
	[/&/g, ";"],
]);

/** @param {string} text */
function stripDetachment(text) {
	let s = NOT_DETACHING.reduce(
		(t, op, i) => t.split(op).join(String.fromCharCode(2 + i)),
		text,
	);
	s = trimEndRun(
		s
			.split("\n")
			.map((line) =>
				trimEndRun(
					DETACH_REWRITES.reduce((l, [re, to]) => l.replace(re, to), line),
					" \t\v\f\r",
				),
			)
			.join("\n"),
		"\n",
	);
	s = NOT_DETACHING.reduce(
		(t, op, i) => t.split(String.fromCharCode(2 + i)).join(op),
		s,
	);
	return trimStart(s);
}

/** @param {string} s */
const trimStart = (s) => s.replace(/^[ \t\n\v\f\r]+/, "");

const held = (/** @type {number} */ n) => `\x07${n}\x07`;

/** @param {string} raw @param {number[]} heredocLines */
function holdHeredocs(raw, heredocLines) {
	const lines = raw.split("\n");
	/** @type {Map<number, string>} */
	const kept = new Map();
	for (const n of heredocLines) {
		kept.set(n, lines[n] ?? "");
		lines[n] = held(n);
	}
	return { text: lines.join("\n"), kept };
}

/** @param {string} s @param {Map<number, string>} kept */
function putBackHeredocs(s, kept) {
	let out = s;
	for (const n of [...kept.keys()].sort((a, b) => a - b)) {
		const at = out.indexOf(held(n));
		if (at >= 0)
			out =
				out.slice(0, at) + (kept.get(n) ?? "") + out.slice(at + held(n).length);
	}
	return trimEndRun(out, "\n");
}

const TIMEOUT_VALUE_FLAGS = ["-k", "--kill-after", "-s", "--signal"];

/** @param {string} seg @param {string} commandWord */
function stripTimeout(seg, commandWord) {
	const segWords = (seg.split("\n")[0] ?? "").split(/[ \t]+/).filter(Boolean);
	const nwrap = segWords.findIndex(
		(w) => w === commandWord || w.includes(QUOTED),
	);
	if (nwrap < 0) return null;
	const kept = keptWrappers(segWords.slice(0, nwrap));
	const lead = /^[ \t\n\v\f\r]*/.exec(seg)?.[0] ?? "";
	const trail = endRun(seg, BASH_SPACE);
	return lead + [...kept, ...segWords.slice(nwrap)].join(" ") + trail;
}

/** @param {string[]} wrappers */
function keptWrappers(wrappers) {
	/** @type {string[]} */
	const kept = [];
	for (let i = 0; i < wrappers.length; i++) {
		const word = wrappers[i] ?? "";
		if (afterSlash(word) !== "timeout") {
			kept.push(word);
			continue;
		}
		while (i + 1 < wrappers.length && (wrappers[i + 1] ?? "").startsWith("-"))
			i += TIMEOUT_VALUE_FLAGS.includes(wrappers[i + 1] ?? "") ? 2 : 1;
		i += 1;
	}
	return kept;
}

/** @param {boolean} snapshot */
const fixOpener = (snapshot) =>
	`Run instead, in the foreground with the Bash tool's \`timeout: ${snapshot ? SNAPSHOT_RUN_TIMEOUT_MS : 600_000}\`: `;

/**
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words
 */
const isSnapshotRun = (launch, words) =>
	(launch.kind === "wrapper" || launch.kind === "npm-vitest") &&
	!words.includes("--queue") &&
	require("./launch-route.js").launchRoute(words, ANY_SESSION).tree ===
		"snapshot";

const DETACHED_TEXT =
	"This suite is DETACHED INSIDE THE SHELL — `&`, `nohup`, `setsid` or `disown` — so the call registers no job for the run and nothing will ever tell you it ended. `run_in_background` with a detachment does not help: the job is then the wrapper shell, which exits at once. An overrun is moved to the background and notifies: then end the turn with NO tool call — a notification arriving mid-call is almost never delivered. A `--full=<cause>` or `--queue` run may overrun, so wrap it in `scripts/bg-run.sh run <name>` in the same call: a `killed` notification often lies, so before relaunching read `scripts/bg-run.sh check <name>`, which tells KILLED from DONE. If guard-suite-concurrency refuses the re-issue, no job exists: take its corrected command rather than reporting `waiting:`. Genuinely need the detachment? Prefix the command with `WFC_SUITE_DETACH=1`.";

const TIMED_TEXT =
	"This suite is WRAPPED IN A SHELL `timeout`, which kills it with no result and no pass/fail marker when the clock runs out — and the clock counts time spent waiting in the `--queue` too. The Bash tool's own timeout does not kill it: an overrun is moved to the background and notifies, and you end the turn with NO tool call. If guard-suite-concurrency refuses the re-issue, take its corrected command. A run naming its own test files is not refused. Genuinely need the shell timeout? Prefix the command with `WFC_SUITE_TIMEOUT=1`.";

/**
 * @param {string} command
 * @param {Ctx} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	const { spans } = parsed;
	/** @param {string} w */
	const typed = (w) => {
		if (!w.includes(QUOTED)) return w;
		const lit = literal(w, spans);
		return lit.known ? lit.text : w;
	};
	/** @type {import("./suite-launch.js").LaunchPorts} */
	const launchPorts = {
		runners: ctx.runners,
		isWrapperScript: buildIsWrapperScript(ctx.tree, ctx.log),
	};
	let foundSuite = false;
	let escaped = false;
	let snapshot = true;
	/** @type {{ from: string, to: string }[]} */
	const timed = [];
	/**
	 * @param {string[]} leading
	 * @param {import("./shell-words.js").Unwrapped} run
	 */
	const noteLaunch = (leading, { words, wrapperWords }) => {
		const launch = suiteLaunchKind(words.map(typed), launchPorts);
		if (!launch) return null;
		if (carriesVar("WFC_SUITE_DETACH", leading, wrapperWords)) escaped = true;
		if (!isSnapshotRun(launch, words.map(typed))) snapshot = false;
		foundSuite = true;
		return launch;
	};
	walkCommands(
		parsed,
		(cmd) => {
			const [first, ...later] = cmd.runs();
			for (const run of later) noteLaunch(cmd.leading, run);
			const { words, wrapperWords } = first;
			const nwrap = cmd.words.length - words.length;
			const isTimed =
				nwrap > 0 &&
				cmd.words.slice(0, nwrap).some((w) => afterSlash(w) === "timeout");
			if (words.length === 0) return;
			const launch = noteLaunch(cmd.leading, first);
			if (!launch) return;
			if (!isTimed || !isUnbounded(launch, words, spans)) return;
			if (carriesVar("WFC_SUITE_TIMEOUT", cmd.leading, wrapperWords)) return;
			let stripped = stripTimeout(cmd.segment, words[0] ?? "");
			if (stripped === null) {
				ctx.log(
					"stripTimeout could not place the wrappers — the deny re-issues the segment as typed",
				);
				stripped = cmd.segment;
			}
			timed.push({
				from: asWritten(cmd.segment, spans),
				to: asWritten(stripped, spans),
			});
		},
		ctx,
	);
	const hold = holdHeredocs(command, parsed.heredocLines);
	const detached = foundSuite && !escaped && detaches(hold.text);
	if (!detached && timed.length === 0) return null;

	let fix = hold.text;
	for (const { from, to } of timed)
		if (from !== "") fix = fix.split(from).join(to);
	if (detached) fix = stripDetachment(fix);
	fix = putBackHeredocs(trimStart(fix), hold.kept);
	if (fix === "") {
		ctx.log(
			"the re-issue came out empty — the deny re-issues the command as typed",
		);
		fix = command;
	}
	let reason = `${fixOpener(snapshot)}${fix}`;
	if (detached) reason += `\n${DETACHED_TEXT}`;
	if (timed.length > 0) reason += `\n${TIMED_TEXT}`;
	return { deny: ctx.corePaths(reason.replace(/\n$/, "")) };
}

/**
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words
 * @param {string[]} spans
 */
function isUnbounded(launch, words, spans) {
	if (launch.kind !== "wrapper" && launch.kind !== "npm-vitest") return false;
	return (
		launchTestFileCount(launch, words, (w) => literal(w, spans).text) === null
	);
}

module.exports = { field: "command", noun: "suite launch", decide };
