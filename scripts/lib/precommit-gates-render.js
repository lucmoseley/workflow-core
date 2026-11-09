/*
 * precommit-gates-render.js — renders lib/precommit-gates.js's GATES into
 * .husky/pre-commit's two `precommit-gates` regions (#4597). The generator,
 * scripts/generate-precommit-gates.js, writes and checks the hook with it.
 *
 * TWO REGIONS, because the hook exits on `--gates=merge` between them: the
 * `merge` region holds the gates the lander's merge set runs, the `batch`
 * region the rest (#4545).
 */

const { shellQuote } = require("./sh-quote.js");

/** @typedef {import("./precommit-gates").PrecommitGate} PrecommitGate */
/** @typedef {{ GATES: PrecommitGate[], FLAG_ARGS: Record<string, string> }} Registry */

const HOOK = ".husky/pre-commit";
const REGIONS = /** @type {const} */ (["merge", "batch"]);

/** @param {string} region */
const beginMarker = (region) => `# precommit-gates:${region}:begin`;
/** @param {string} region */
const endMarker = (region) => `# precommit-gates:${region}:end`;

/**
 * The shell word `armed` takes: the ERE quoted, each `$JS_TEST_ERE` in it
 * left to the shell as the double-quoted hook variable.
 * @param {string} ere
 */
const quoteEre = (ere) =>
	ere
		.split("$JS_TEST_ERE")
		.map((piece) => (piece ? shellQuote(piece) : ""))
		.join('"$JS_TEST_ERE"');

/**
 * @param {PrecommitGate} gate
 * @param {Record<string, string>} flagArgs
 */
const renderBlock = (gate, flagArgs) =>
	[
		`if ${gate.lander === "batch" ? "" : "! lander_batch && "}armed ${quoteEre(gate.ere)}; then`,
		`  node "\${WFC_PLUGIN_ROOT:-.}"/${gate.script} ${flagArgs[gate.flag]} || exit "$?"`,
		"fi",
	].join("\n");

/**
 * @param {Registry} registry
 * @param {string} region
 */
const renderRegionBody = ({ GATES, FLAG_ARGS }, region) =>
	GATES.filter((g) => (g.lander === "merge") === (region === "merge"))
		.map((g) => renderBlock(g, FLAG_ARGS))
		.join("\n\n");

/**
 * The hook with each region re-rendered.
 * @param {string} hook
 * @param {Registry} registry
 * @returns {string}
 */
function render(hook, registry) {
	let out = hook;
	for (const region of REGIONS) {
		const lines = out.split("\n");
		const from = lines.indexOf(beginMarker(region));
		const to = lines.indexOf(endMarker(region));
		if (from === -1 || to < from)
			throw new Error(
				`${HOOK} has no \`${beginMarker(region)}\` … \`${endMarker(region)}\` pair`,
			);
		const body = renderRegionBody(registry, region);
		out = [
			...lines.slice(0, from + 1),
			...(body ? [body] : []),
			...lines.slice(to),
		].join("\n");
	}
	return out;
}

module.exports = { HOOK, render };
