const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");
const { ghWords, literal, scanFlags } = require("./shell-words.js");
const { ruleOrFallback } = require("./guard-verdict.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./sweep-fire-host.js").Spend} Spend
 */

const SWEEP_WORKFLOWS = [
	"scheduled-checks.yml",
	"scheduled-checks",
	"ci.yml",
	"CI",
];

// `gh workflow run` flags that take a value: https://cli.github.com/manual/gh_workflow_run
const GH_VALUE_FLAGS = "--ref -r --field -F --raw-field -f --input --repo -R";

/**
 * @param {string[]} words
 * @param {string[]} spans
 */
const sweepFires = (words, spans) =>
	ghWords(words, spans).filter((gh) => isSweepRun(gh.args, spans)).length;

/**
 * @param {string[]} args
 * @param {string[]} spans
 */
function isSweepRun(args, spans) {
	const read = (/** @type {string | undefined} */ w) =>
		literal(w ?? "", spans).text;
	if (read(args[0]) !== "workflow" || read(args[1]) !== "run") return false;
	let named = false;
	let seen = false;
	scanFlags(GH_VALUE_FLAGS, args.slice(2), (kind, _name, value) => {
		if (kind !== "arg" || seen) return;
		seen = true;
		const lit = literal(value, spans);
		if (!lit.known) return;
		named = SWEEP_WORKFLOWS.some(
			(wf) => lit.text === wf || lit.text.endsWith(`/${wf}`),
		);
	});
	return named;
}

/**
 * @param {{ spent: number, cap: number, day: string }} spend
 * @param {string} segment
 * @param {CoreContext & { spendSweep: (env: CoreContext["env"]) => Spend }} ctx
 */
function refusal({ spent, cap, day }, segment, ctx) {
	const rule = ruleOrFallback(
		ctx,
		"sweep-fire-budget",
		"A hand-fired sweep spends the same three-a-day budget the autofire spends",
	);
	return ctx.corePaths(
		`Today's sweep budget is gone: ${spent} of ${cap} already fired on ${day} (UTC), so the next unit is available on the day after ${day}.\n\n${rule}\n\nThe command: ${trimEndRun(unmask(segment), "\n")}`,
	);
}

/**
 * @param {string} command
 * @param {CoreContext & { spendSweep: (env: CoreContext["env"]) => Spend }} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {Decision} */
	let verdict = null;
	walkCommands(
		parsed,
		(cmd) => {
			for (
				let n = sweepFires(cmd.words, parsed.spans);
				n > 0 && !verdict;
				n--
			) {
				const spend = ctx.spendSweep(ctx.env);
				if ("fault" in spend) {
					// lucmoseley/mantahostels#103
					ctx.log(
						`the sweep budget could not be counted (${spend.fault}) — a hand-fired sweep allowed uncounted`,
					);
					return;
				}
				if (spend.out) verdict = { deny: refusal(spend, cmd.segment, ctx) };
			}
		},
		ctx,
	);
	return verdict;
}

module.exports = { field: "command", noun: "command", decide };
