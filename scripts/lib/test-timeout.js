const path = require("node:path");
const { isBackgroundJob } = require("./job-paths.js");
const {
	buildIsWrapperScript,
	isSnapshotLaunch,
	suiteLaunchKind,
} = require("./suite-launch.js");
const {
	MOVED_RUN_WAIT,
	SNAPSHOT_RUN_TIMEOUT_MS,
	SUBAGENT_WAIT,
} = require("./wait-text.js");

const UNQUOTED_REFUSED = new Set([..."$`;&<>(){}\\\n"]);
const DOUBLE_QUOTED_REFUSED = new Set([..."$`\\"]);
const MERGE = "2>&1";
const FILTERS = new Set(["tail", "head", "grep"]);

/**
 * @typedef {{ out: string[][], word: string, started: boolean,
 *   quote: "" | "'" | '"' }} Lex
 */

/** @param {Lex} lex */
function endWord(lex) {
	if (lex.started) lex.out.at(-1)?.push(lex.word);
	lex.word = "";
	lex.started = false;
}

/**
 * @param {Lex} lex
 * @param {string} c
 * @returns {boolean}
 */
function stepQuoted(lex, c) {
	if (c === lex.quote) lex.quote = "";
	else if (lex.quote === '"' && DOUBLE_QUOTED_REFUSED.has(c)) return false;
	else lex.word += c;
	return true;
}

/**
 * @param {Lex} lex
 * @param {string} c
 * @returns {boolean}
 */
function step(lex, c) {
	if (lex.quote) return stepQuoted(lex, c);
	if (UNQUOTED_REFUSED.has(c)) return false;
	if (c === " " || c === "\t") endWord(lex);
	else if (c === "|") {
		endWord(lex);
		lex.out.push([]);
	} else {
		if (c === "'" || c === '"') lex.quote = c;
		else lex.word += c;
		lex.started = true;
	}
	return true;
}

/**
 * @param {string} command
 * @returns {string[][] | null}
 */
function stages(command) {
	const text = command.trim().split(` ${MERGE} |`).join(" |");
	const merged = text.endsWith(` ${MERGE}`)
		? text.slice(0, -MERGE.length)
		: text;
	/** @type {Lex} */
	const lex = { out: [[]], word: "", started: false, quote: "" };
	for (const c of merged) if (!step(lex, c)) return null;
	if (lex.quote) return null;
	endWord(lex);
	return lex.out.every((s) => s.length > 0) ? lex.out : null;
}

/** @param {string} script */
const ownScript = (script) => {
	const shipped = path.resolve(__dirname, "..", script);
	return new Set([`scripts/${script}`, `./scripts/${script}`, shipped]);
};
const BG_RUN = ownScript("bg-run.sh");
const RUN_VITEST = ownScript("run-vitest.js");

/** @param {string[]} words */
function unwrapBgRun(words) {
	return BG_RUN.has(words[0] ?? "") && words[1] === "run" && words.length > 3
		? words.slice(3)
		: words;
}

/** @param {string[]} words */
function isOwnLaunchSpelling(words) {
	if (words[0] === "node") return RUN_VITEST.has(words[1] ?? "");
	if (words[0] !== "npm") return false;
	const end = words.indexOf("--");
	const npmWords = end < 0 ? words : words.slice(0, end);
	return !npmWords.some((w) => w.startsWith("-"));
}

/**
 * @param {string} command
 * @param {import("./core-contract.js").CoreContext} ctx
 */
function isSnapshotTestCommand(command, ctx) {
	const parsed = stages(command);
	if (!parsed) return false;
	const [first = [], ...filters] = parsed;
	if (!filters.every((s) => FILTERS.has(s[0] ?? ""))) return false;
	const words = unwrapBgRun(first);
	if (!isOwnLaunchSpelling(words)) return false;
	const isWrapperScript = buildIsWrapperScript(ctx.tree, ctx.log);
	const launch = suiteLaunchKind(words, { runners: () => [], isWrapperScript });
	if (!launch || !isSnapshotLaunch(launch, words)) return false;
	return launch.kind === "wrapper" || isWrapperScript(launch.script);
}

/** @param {import("./core-contract.js").CoreContext} ctx */
function overrunNote(ctx) {
	const opener = `This test run's Bash \`timeout\` was set to ${SNAPSHOT_RUN_TIMEOUT_MS} (#5800): it reads a launch snapshot, so past ${SNAPSHOT_RUN_TIMEOUT_MS / 1000} s it moves to the background and notifies.`;
	if (ctx.agent) return `${opener} Then ${SUBAGENT_WAIT}`;
	const idle = isBackgroundJob(ctx.env)
		? `hold the turn on ${MOVED_RUN_WAIT}`
		: "end the turn with NO tool call";
	return `${opener} Then keep working on independent work; with none left, ${idle}.`;
}

/**
 * @param {string} command
 * @param {import("./core-contract.js").CoreContext} ctx
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(command, ctx) {
	const { input } = ctx;
	if (input.run_in_background === true) return null;
	const asked = input.timeout;
	if (typeof asked === "number" && asked <= SNAPSHOT_RUN_TIMEOUT_MS)
		return null;
	if (!isSnapshotTestCommand(command, ctx)) return null;
	return {
		context: overrunNote(ctx),
		updatedInput: { ...input, timeout: SNAPSHOT_RUN_TIMEOUT_MS },
	};
}

module.exports = { field: "command", noun: "test launch", decide };
