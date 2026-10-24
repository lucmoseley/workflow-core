#!/usr/bin/env node
/*
 * check-citation-tracker.js — a citation of THIS repo's tracker is bare `#N`.
 * `mantahostels#N` names the INHERITED tracker, a different set of issues (#162).
 *
 * Usage:
 *   node check-citation-tracker.js [--json] [--warn] [--all]
 *   (no arguments: the staged diff is read out of git)
 *
 * The test itself — the pre-rewrite use count, and what it misses — is
 * lib/citation-tracker.js's, shared with guard-citation-tracker.sh (#2015).
 *
 * STAGED, AND ADDED LINES ONLY. The ~13,000 citations already in the tree are
 * not this gate's business — it is prospective, exactly like the branch and
 * commit-form guards. `--all` scans the whole working tree instead, which is
 * what the audit route wants.
 *
 * IT NO-OPS IN AN ADOPTER REPO. `ec8654cd` is this repo's own history; where it
 * does not resolve there is no inherited tracker to confuse ours with, and the
 * check skips rather than refusing every citation it sees.
 *
 * IMPLICIT:  on every commit, refuses a newly-added citation that names the inherited tracker for a number that tracker never used.
 * JUSTIFIED: fail-safe — a git that cannot run is BROKEN rather than green. A baseline commit that is genuinely absent is a SKIP, that being an adopter's repo rather than a failure.
 * DEFEAT:    --warn caps findings below the gating line; a `citation-exempt: <why>` comment drops one line, and nothing validates the reason it gives; an owner-qualified `lucmoseley/mantahostels#N` passes unjudged, so a mis-copy spelled with that prefix gets through; WFC_CITATION_TRACKER_OFF stands the gate down for one commit.
 */

const { runCheck } = require("./lib/check.js");
const { ruleTextOr } = require("./lib/rule-text");
const {
	PREFIX,
	REWRITE,
	baselineCommit,
	gitOutcome,
	inheritedNumbers,
	judgeLine,
} = require("./lib/citation-tracker.js");
const { requiredGroup } = require("./lib/regex-group");

/** @typedef {import("./lib/check").CheckContext} Ctx */

const DEFEAT = "WFC_CITATION_TRACKER_OFF";

/**
 * The lines this commit ADDS, by file.
 *
 * `-U0` so no context line is read as an addition, and `--no-color`/
 * `--no-ext-diff` so a session's own git config cannot change what is parsed.
 *
 * THE FILE HEADER IS READ ONLY OUTSIDE A HUNK. A `+++ ` test applied to hunk
 * body lines swallows an added line that itself begins `++ ` — markdown and
 * diff-quoting prose both produce them — and takes the rest of that hunk with
 * it. `diff --git ` resets, so a header is never missed either.
 *
 * @param {string} diff
 * @returns {{file: string, line: string}[]}
 */
function addedLines(diff) {
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

/**
 * Every tracked citation, in the same shape `addedLines` returns — so `--all`
 * and the staged route share one judging loop.
 *
 * `:(top)` rather than `.`, so a run from a subdirectory still scans the whole
 * repository. The row is split on the LAST colon before the line number, since
 * a path may hold one.
 *
 * @returns {{ ok: true, out: {file: string, line: string}[] } | { ok: false, why: string }}
 */
function everyLine() {
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

/*
 * The rule this checker prints, through `ruleTextOr` (mantahostels#1649's
 * split): `ruleText` throws on an unreadable store, and a throw here would
 * report BROKEN — "the checker cannot do its job" — over a fault that has
 * nothing to do with the commit's diff.
 */
function citationRule() {
	return ruleTextOr(
		"citation-tracker",
		"A citation of this repo's tracker is bare `#N`; the mantahostels# prefix names the inherited tracker.",
		"check-citation-tracker",
	).split("\n");
}

/**
 * The lines judged: every tracked line under --all, else the staged diff's
 * added lines.
 *
 * @param {Ctx} ctx
 * @param {boolean} all
 * @returns {{file: string, line: string}[]}
 */
function subjectLines(ctx, all) {
	if (all) {
		const tree = everyLine();
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
	return addedLines(diff.out);
}

/**
 * Fails each inherited-tracker citation on one line whose number the
 * inherited tracker never used.
 *
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

runCheck({
	name: "citation-tracker",
	usage: "node check-citation-tracker.js [--json] [--warn] [--all]",
	flags: ["--all"],
	run(/** @type {Ctx} */ ctx) {
		if ((process.env[DEFEAT] ?? "") !== "")
			ctx.skip(
				`${DEFEAT} is set — the citation gate stood down for this commit.`,
			);

		/* A SKIP on apparatus would report a checker that never ran as a pass. */
		const baseline = baselineCommit();
		if (!baseline.ok)
			return ctx.broken(
				`could not ask git for ${REWRITE} (${baseline.why}), so no citation was judged.`,
			);
		if (!baseline.out.trim())
			ctx.skip(
				`${REWRITE} is not in this repository, so there is no inherited tracker to confuse this one with.`,
			);

		const inherited = inheritedNumbers();
		if (!inherited.ok)
			return ctx.broken(
				`could not read the citations at ${REWRITE} (${inherited.why}), so no citation was judged.`,
			);

		const all = ctx.has("--all");
		const subject = subjectLines(ctx, all);

		/** @type {Set<number>} */
		const found = new Set();
		let citations = 0;
		for (const at of subject) {
			const judged = failLine(ctx, at, inherited.out);
			citations += judged.citations;
			for (const n of judged.found) found.add(n);
		}
		if (found.size > 0) for (const line of citationRule()) ctx.say(line);

		return {
			okLine: `${citations} citation(s) in the ${all ? "tree" : "staged diff"} name the inherited tracker for a number it actually used.`,
			noun: "mis-tracked citation",
			data: { citations, numbers: [...found].sort((a, b) => a - b) },
		};
	},
});
