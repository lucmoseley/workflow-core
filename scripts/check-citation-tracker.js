#!/usr/bin/env node

const { runCheck } = require("./lib/check.js");
const { gitOutcome } = require("./lib/git.js");
const { readRuleTextOr } = require("./lib/rule-text");
const {
	PREFIX,
	baselineRev,
	readBaselineCommit,
	readInheritedNumbers,
	judgeLine,
} = require("./lib/citation-tracker.js");
const { requiredGroup } = require("./lib/regex-group");

/** @typedef {import("./lib/check").Ctx} Ctx */

const DEFEAT = "WFC_CITATION_TRACKER_OFF";

/**
 * @param {string} diff
 * @returns {{file: string, line: string}[]}
 */
function parseAddedLines(diff) {
	const out = [];
	let file = "";
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			file = "";
			continue;
		}
		if (!inHunk && line.startsWith("+++ ")) {
			file = line.slice(4).replace(/^b\//, "");
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (inHunk && line.startsWith("+")) out.push({ file, line: line.slice(1) });
	}
	return out;
}

/** @returns {{ ok: true, out: {file: string, line: string}[] } | { ok: false, why: string }} */
function readEveryLine() {
	const r = gitOutcome(
		["grep", "-n", "-E", `${PREFIX}#[0-9]+`, "--", ":(top)"],
		[1],
	);
	if (!r.ok) return r;
	const lines = [];
	const shape = /^(.*?):(\d+):(.*)$/s;
	for (const row of r.out.split("\n")) {
		if (!row) continue;
		const m = row.match(shape);
		if (m)
			lines.push({
				file: `${requiredGroup(m, 1, shape)}:${requiredGroup(m, 2, shape)}`,
				line: requiredGroup(m, 3, shape),
			});
	}
	return { ok: true, out: lines };
}

function readCitationRule() {
	return readRuleTextOr(
		"citation-tracker",
		"A citation of this repo's tracker is bare `#N`; the mantahostels# prefix names the inherited tracker",
		"check-citation-tracker",
	).split("\n");
}

/**
 * @param {Ctx} ctx
 * @param {boolean} all
 * @returns {{file: string, line: string}[]}
 */
function readSubjectLines(ctx, all) {
	if (all) {
		const tree = readEveryLine();
		if (!tree.ok)
			return ctx.broken(
				`could not list the tree's citations (${tree.why}), so none was judged.`,
			);
		return tree.out;
	}
	const diff = gitOutcome(
		["diff", "--cached", "-U0", "--no-color", "--no-ext-diff"],
		[],
	);
	if (!diff.ok)
		return ctx.broken(
			`could not read the staged diff (${diff.why}), so no citation was judged.`,
		);
	return parseAddedLines(diff.out);
}

/**
 * @param {Ctx} ctx
 * @param {{file: string, line: string}} at
 * @param {Set<number>} inherited
 * @returns {{citations: number, found: number[]}}
 */
function failLine(ctx, at, inherited) {
	const judged = judgeLine(at, inherited);
	for (const n of judged.found) {
		ctx.fail(
			"CITATION-TRACKER",
			`${at.file} cites ${PREFIX}#${n}, but the inherited tracker never used #${n} — this is #${n} on this repo's own tracker (#162).`,
			{ file: at.file, number: n },
		);
		ctx.say(`${at.file}: ${PREFIX}#${n} should be #${n}.`);
	}
	return judged;
}

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "citation-tracker",
	usage: "node check-citation-tracker.js [--json] [--warn] [--all]",
	flags: ["--all"],
	run(/** @type {Ctx} */ ctx) {
		if ((process.env[DEFEAT] ?? "") !== "")
			ctx.skip(
				`${DEFEAT} is set — the citation gate stood down for this commit.`,
			);

		const baseline = readBaselineCommit();
		if (!baseline.ok)
			return ctx.broken(
				`could not ask git for ${baselineRev()} (${baseline.why}), so no citation was judged.`,
			);
		if (baseline.sha === null)
			ctx.skip(
				`${baselineRev()} is not in this repository, so there is no inherited tracker to confuse this one with.`,
			);

		const inherited = readInheritedNumbers();
		if (!inherited.ok)
			return ctx.broken(
				`could not read the citations at ${baselineRev()} (${inherited.why}), so no citation was judged.`,
			);

		const all = ctx.has("--all");
		const subject = readSubjectLines(ctx, all);

		/** @type {Set<number>} */
		const found = new Set();
		let citations = 0;
		for (const at of subject) {
			const judged = failLine(ctx, at, inherited.out);
			citations += judged.citations;
			for (const n of judged.found) found.add(n);
		}
		if (found.size > 0) for (const line of readCitationRule()) ctx.say(line);

		return {
			okLine: `${citations} citation(s) in the ${all ? "tree" : "staged diff"} name the inherited tracker for a number it actually used.`,
			noun: "mis-tracked citation",
			data: { citations, numbers: [...found].sort((a, b) => a - b) },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
