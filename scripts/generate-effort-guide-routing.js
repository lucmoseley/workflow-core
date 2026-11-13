#!/usr/bin/env node
/*
 * generate-effort-guide-routing.js — renders docs/effort-guide.md's routing
 * block, between its `routing:begin` and `routing:end` markers, from the
 * routing file lib/model-table.js loads (#5033). Everything outside the
 * markers is the guide's own prose and is kept byte for byte.
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
const { capture } = require("./lib/check-sink.js");
const { writeFd } = require("./lib/write-fd.js");

const DEFAULT_GUIDE = "docs/effort-guide.md";
const BEGIN =
	"<!-- routing:begin — rendered from scripts/lib/model-routing.json by scripts/generate-effort-guide-routing.js; edit the file and re-run it, never this block -->";
const END = "<!-- routing:end -->";
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
	for (const [mode, m] of Object.entries(modes)) {
		const title = `${mode[0]?.toUpperCase()}${mode.slice(1)} mode`;
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
	return render(
		guide,
		{ check: flags["--check"] === true, claim: flags["--no-claim"] !== true },
		writeFd,
	);
}

/**
 * Renders `guide`'s routing block, or with `check` compares it.
 * @param {string} guide
 * @param {{ check: boolean, claim: boolean }} opts
 * @param {import("./lib/write-fd.js").Write} write
 * @returns {number}
 */
function render(guide, { check, claim }, write) {
	let text;
	let block;
	try {
		text = fs.readFileSync(guide, "utf8");
		block = renderBlock();
	} catch (e) {
		write(2, `generate-effort-guide-routing: ${caught(e).message}\n`);
		return 2;
	}
	const rendered = renderGuide(text, block);
	if (rendered === null) {
		write(
			2,
			`${guide} carries no routing:begin / routing:end marker pair. Nothing was written.\n`,
		);
		return 2;
	}
	if (rendered === text) {
		write(1, `${guide}'s routing block already matches ${routingPath()}.\n`);
		return 0;
	}
	if (check) {
		write(
			2,
			`${guide}'s routing block does not match ${routingPath()}. Regenerate it:\n` +
				`  node ${scriptPath("generate-effort-guide-routing.js")}\n`,
		);
		return 1;
	}
	if (claim) claimDataFile(guide);
	try {
		fs.writeFileSync(guide, rendered);
	} catch (e) {
		write(2, `cannot write ${guide} — ${caught(e).message}\n`);
		return 2;
	}
	write(1, `rendered ${guide}'s routing block from ${routingPath()}.\n`);
	return 0;
}

/**
 * The --check run over the guide of the repo at `cwd`, as the pre-commit
 * dispatcher runs it in its own process (#5172).
 * @type {import("./lib/precommit-gates.js").Program}
 */
const PROGRAM = ({ cwd }) =>
	capture((write) =>
		render(path.join(cwd, DEFAULT_GUIDE), { check: true, claim: false }, write),
	);

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, PROGRAM };
