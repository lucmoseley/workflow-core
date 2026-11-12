#!/usr/bin/env node
/*
 * generate-effort-guide-routing.js — renders docs/effort-guide.md's routing
 * block, between its `routing:begin` and `routing:end` markers, from the
 * routing file lib/model-table.js loads (#5033). Everything outside the
 * markers is the guide's own prose and is kept byte for byte.
 *
 * Usage:
 *   node scripts/generate-effort-guide-routing.js [--check] [--guide <path>]
 *     [--no-claim]
 *
 * --check     render and compare without writing; exit 1 on drift.
 * --guide     the guide to render into; the session's own docs/effort-guide.md
 *             by default. WFC_MODEL_ROUTING names another routing file.
 * --no-claim  skip the claim below; for tests, which write throwaway guides.
 *
 * A write claims the guide first, as the claim hook would on a Write, and
 * leaves the claim for the commit landing it to give back. Fails open: a
 * refused claim costs the record and nothing else.
 *
 * Exit 2 where the guide or the routing file cannot be read, or the guide
 * carries no marker pair.
 */

const fs = require("node:fs");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const {
	loadRouting,
	modeSettings,
	modelId,
	routingPath,
} = require("./lib/model-table.js");
const { claimDataFile } = require("./lib/doc-map-generator");
const { caught } = require("./lib/caught.js");

const DEFAULT_GUIDE = "docs/effort-guide.md";
const BEGIN =
	"<!-- routing:begin — rendered from scripts/lib/model-routing.json by scripts/generate-effort-guide-routing.js; edit the file and re-run it, never this block -->";
const END = "<!-- routing:end -->";
const MODES = /** @type {const} */ ([
	["standard", "Standard mode"],
	["burn", "Burn mode"],
]);

const code = (/** @type {string} */ s) => `\`${s}\``;

/** @returns {string} */
function renderBlock() {
	const { models, modes } = loadRouting();
	const lines = [
		BEGIN,
		"",
		"| Alias | Model id | Also read as |",
		"|---|---|---|",
		...Object.entries(models).map(
			([alias, m]) =>
				`| ${code(alias)} | ${code(m.id)} | ${m.also.length > 0 ? m.also.map(code).join(", ") : "—"} |`,
		),
	];
	for (const [mode, title] of MODES) {
		const m = modes[mode];
		const efforts = Object.entries(m.modelSettings)
			.map(([alias, level]) => `${code(modelId(alias))} ${code(level)}`)
			.join(", ");
		lines.push(
			"",
			`**${title}.** Session model ${code(modeSettings(mode === "burn").model)}; settings efforts ${efforts}.`,
			"",
			"| Asked for | Runs on | At effort |",
			"|---|---|---|",
			...Object.entries(m.route).map(
				([alias, row]) =>
					`| ${code(alias)} | ${code(row.to)} · ${code(modelId(row.to))} | ${row.effort ? code(row.effort) : "as asked"} |`,
			),
		);
	}
	lines.push("", END);
	return lines.join("\n");
}

/**
 * @param {string} text
 * @param {string} block
 * @returns {string | null} the guide with its block replaced, or null where it
 *   carries no marker pair
 */
function renderGuide(text, block) {
	const start = text.indexOf("<!-- routing:begin");
	const end = text.indexOf(END, start);
	if (start < 0 || end < 0) return null;
	return text.slice(0, start) + block + text.slice(end + END.length);
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage: `usage: node ${scriptPath("generate-effort-guide-routing.js")} [--check] [--guide <path>] [--no-claim]`,
		flags: {
			"--check": "boolean",
			"--guide": "value",
			"--no-claim": "boolean",
		},
	});
	const guide =
		flagValue(flags, "--guide") ?? path.join(worktreeRoot(), DEFAULT_GUIDE);
	let text;
	let block;
	try {
		text = fs.readFileSync(guide, "utf8");
		block = renderBlock();
	} catch (e) {
		console.error(`generate-effort-guide-routing: ${caught(e).message}`);
		return 2;
	}
	const rendered = renderGuide(text, block);
	if (rendered === null) {
		console.error(
			`${guide} carries no routing:begin / routing:end marker pair, so there is nowhere to render the routing. Nothing was written.`,
		);
		return 2;
	}
	if (rendered === text) {
		console.log(`${guide}'s routing block already matches ${routingPath()}.`);
		return 0;
	}
	if (flags["--check"] === true) {
		console.error(
			`${guide}'s routing block does not match ${routingPath()}. Regenerate it:\n` +
				`  node ${scriptPath("generate-effort-guide-routing.js")}`,
		);
		return 1;
	}
	if (flags["--no-claim"] !== true) claimDataFile(guide);
	try {
		fs.writeFileSync(guide, rendered);
	} catch (e) {
		console.error(`cannot write ${guide} — ${caught(e).message}`);
		return 2;
	}
	console.log(`rendered ${guide}'s routing block from ${routingPath()}.`);
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
