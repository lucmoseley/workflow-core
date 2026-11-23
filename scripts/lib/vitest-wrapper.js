const { ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");

const STANDING_LINE =
	"A vitest run outside `scripts/run-vitest.js` has no stall watchdog (`rule:vitest-wrapper`).";

const HEAP_CAP = "NODE_OPTIONS=--max-old-space-size=2048";

const UNSERVABLE = new Set([
	"watch",
	"bench",
	"list",
	"related",
	"init",
	"typecheck",
	"dev",
]);

const NPX_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

/**
 * @typedef {import("./kit-context.js").KitContext} WrapperContext
 */

/**
 * @param {string | undefined} word
 */
const isVitestWord = (word) =>
	word !== undefined && (word === "vitest" || word.endsWith("/vitest"));

/** @param {string[]} args */
const isUnservable = (args) =>
	args.some((w) => w === "--watch" || w.startsWith("--watch=")) ||
	args.slice(0, 1).some((w) => UNSERVABLE.has(w));

/** @param {string[]} words */
function npxTarget(words) {
	for (let i = 0; i < words.length; ) {
		const w = words[i];
		if (w === undefined || !w.startsWith("-")) return i;
		i += NPX_VALUE_FLAGS.has(w) ? 2 : 1;
	}
	return -1;
}

/** @param {string[]} words */
function vitestArgs(words) {
	const head = words[0];
	if (isVitestWord(head)) return words.slice(1);
	if (head !== "npx" && !head?.endsWith("/npx")) return null;
	const rest = words.slice(1);
	const at = npxTarget(rest);
	if (at < 0 || !isVitestWord(rest[at])) return null;
	return rest.slice(at + 1);
}

/**
 * @param {string} segment
 * @param {string[]} args
 * @param {WrapperContext} ctx
 */
function body(segment, args, ctx) {
	const forwarded =
		args[0] === "run" || args[0] === "--run" ? args.slice(1) : args;
	let suggestion = `${HEAP_CAP} node ${ctx.scriptPath("run-vitest.js")}`;
	if (forwarded.length > 0) suggestion += ` ${unmask(forwarded.join(" "))}`;
	return `This command: ${unmask(segment)}\nWrapped:      ${suggestion}`;
}

/** @param {WrapperContext} ctx */
const wrapperRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"vitest-wrapper",
		"A vitest run outside `scripts/run-vitest.js` has no stall watchdog",
		() => ctx.log("rule vitest-wrapper unreadable — its fallback sent instead"),
	);

/**
 * @param {string} command
 * @param {WrapperContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	/** @type {{ segment: string, args: string[] }[]} */
	const hits = [];
	walkCommands(
		parseCommand(command),
		({ segment, words }) => {
			const args = vitestArgs(words);
			if (args !== null && !isUnservable(args)) hits.push({ segment, args });
		},
		ctx,
	);
	const [hit] = hits;
	if (hit === undefined) return null;
	const text = body(hit.segment, hit.args, ctx);
	if (ctx.told("vitest-wrapper"))
		return { context: `${STANDING_LINE}\n\n${text}` };
	return {
		injectRules: [],
		prelude: ctx.corePaths(`${wrapperRule(ctx)}\n\n${text}`),
		latchAfter: "vitest-wrapper",
	};
}

module.exports = { field: "command", noun: "command", decide };
