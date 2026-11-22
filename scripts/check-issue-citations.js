#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { readCitationFindings } = require("./lib/citation-findings-cache");
const { raiseGhFailure } = require("./lib/gh");
const { titleFirstLinks } = require("./lib/title-first-links");
const { requireKey } = require("./lib/workflow-core-config");

let tracker = "";

const BLOCKER_LINE = /^[*_\-\s]*(?:un)?block(?:ed by|s|ing)\b/i;
const HEADING = /^\s{0,3}#{1,6}\s/;
const CITED = /#\d+\s*(?:\([^)]*\))?/g;
const REFERRING_PHRASE =
	/\bthe\s+[\w'-]+(?:\s+[\w'-]+){0,3}\s+(ticket|decision|route|question|audit|check|clean|issue)\b/i;
const NO_BLOCKER = new RegExp(
	`${BLOCKER_LINE.source}(?:(?<!by)\\s+[^\\W_]+(?=[*_]*:))?[\\s:*_\`'"(\\[—–-]*` +
		`(?:none|nothing|no blockers?)\\b[*_\`'")\\]]*\\s*(?:$|([.;:,(—–-]))`,
	"i",
);

/** @param {string} line */
function statesNoBlocker(line) {
	const m = NO_BLOCKER.exec(line);
	if (!m) return false;
	if (!m[1] || m[1] === ".") return true;
	const [sentence = ""] = line
		.slice(m.index + m[0].length)
		.split(/[.?!](?:\s|$)/);
	return !REFERRING_PHRASE.test(sentence.replace(CITED, " "));
}

/** @param {string} text */
function numberlessBlockers(text) {
	const found = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || HEADING.test(line)) continue;
		if (!BLOCKER_LINE.test(line)) continue;
		if (statesNoBlocker(line)) continue;
		if (/#\d+/.test(line) && !REFERRING_PHRASE.test(line.replace(CITED, " ")))
			continue;
		found.push(line.slice(0, 120));
	}
	return found;
}

/** @returns {import("./lib/citation-findings-cache").Scanner} */
const buildScanner = () => ({
	version: crypto
		.createHash("sha256")
		.update(fs.readFileSync(__filename))
		.update(fs.readFileSync(require.resolve("./lib/title-first-links")))
		.update(fs.readFileSync(require.resolve("./lib/regex-group")))
		.digest("hex")
		.slice(0, 16),
	/** @param {string} text */
	body(text) {
		const links = titleFirstLinks(text, tracker);
		const lines = numberlessBlockers(text);
		return links.length > 0 || lines.length > 0 ? { links, lines } : null;
	},
	/** @param {string} text */
	comment(text) {
		const links = titleFirstLinks(text, tracker);
		return links.length > 0 ? { links } : null;
	},
});

/**
 * @param {Record<string, import("./lib/citation-findings-cache").Entry>} issues
 */
function splitFindings(issues) {
	const titleFirst = [];
	const noNumber = [];
	const entries = Object.entries(issues)
		.map(([n, e]) => /** @type {const} */ ([Number(n), e]))
		.sort(([a], [b]) => b - a);
	for (const [number, e] of entries) {
		const base = { number, title: e.title, url: e.url };
		if (e.body?.links.length)
			titleFirst.push({ ...base, where: "body", links: e.body.links });
		for (const [id, c] of Object.entries(e.comments))
			titleFirst.push({ ...base, where: `comment ${id}`, links: c.links });
		if (e.body?.lines?.length) noNumber.push({ ...base, lines: e.body.lines });
	}
	return { titleFirst, noNumber };
}

/**
 * @param {any} ctx
 * @param {any[]} titleFirst
 * @param {number} linkCount
 */
function sayTitleFirst(ctx, titleFirst, linkCount) {
	ctx.say(
		`TITLE-FIRST (${linkCount} citation(s) across ${titleFirst.length} surface(s)) — number hidden in the URL:`,
	);
	for (const i of titleFirst) {
		ctx.say(`  #${i.number} ${i.title}  [${i.where}]\n    ${i.url}`);
		for (const l of i.links)
			ctx.say(`      → #${l.target} cited as "${l.linkText}"`);
	}
	ctx.say(
		"\n  Rewrite as `[#<n> — <title>](<url>)`. The title stays; the number leads.\n",
	);
}

/**
 * @param {any} ctx
 * @param {any[]} noNumber
 * @param {number} lineCount
 */
function sayNoNumber(ctx, noNumber, lineCount) {
	ctx.say(
		`NO-NUMBER (${lineCount} line(s) across ${noNumber.length} issue(s)) — blocker named by description only:`,
	);
	for (const i of noNumber) {
		ctx.say(`  #${i.number} ${i.title}\n    ${i.url}`);
		for (const l of i.lines) ctx.say(`      ${l}`);
	}
	ctx.say(
		"\n  Resolve each description to its issue and cite it `#<n> (<gloss>)`. The\n" +
			"  native dependency graph usually already knows the answer:\n" +
			`  \`gh api repos/${tracker}/issues/<n>/dependencies/blocked_by\`.\n`,
	);
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "issue-citations",
	usage: "node check-issue-citations.js [--warn] [--json]",
	async run(ctx) {
		tracker = requireKey("tracker");
		let found;
		try {
			found = await readCitationFindings(tracker, buildScanner());
		} catch (e) {
			return raiseGhFailure(e);
		}

		const { titleFirst, noNumber } = splitFindings(found.issues);

		const linkCount = titleFirst.reduce((n, i) => n + i.links.length, 0);
		const lineCount = noNumber.reduce((n, i) => n + i.lines.length, 0);
		const total = linkCount + lineCount;

		for (const i of titleFirst)
			ctx.fail(
				"TITLE-FIRST",
				`#${i.number} [${i.where}] — ${i.links.length} citation(s) with the number hidden in the URL`,
				i,
				`TITLE-FIRST\t#${i.number}\t${i.where}`,
			);
		for (const i of noNumber)
			ctx.fail(
				"NO-NUMBER",
				`#${i.number} — ${i.lines.length} blocker line(s) naming no issue number`,
				i,
				`NO-NUMBER\t#${i.number}`,
			);

		const r = found.read;
		ctx.say(
			r.full
				? `Checked all ${r.issues} issue(s) and ${r.comments} comment(s) on ${tracker}.\n`
				: `Checked the ${r.issues} issue(s) and ${r.comments} comment(s) on ${tracker} changed since ${r.since};\n` +
						`every other surface's findings carried from the cache begun ${r.fullStamp}.\n`,
		);

		if (titleFirst.length > 0) sayTitleFirst(ctx, titleFirst, linkCount);

		if (noNumber.length > 0) sayNoNumber(ctx, noNumber, lineCount);

		return {
			okLine: "every issue cross-reference leads with its number.",
			count: total,
			noun: "citation(s) not leading with an issue number",
			data: { titleFirst, noNumber, linkCount, lineCount, total },
		};
	},
};

const main = () => runCheck(SPEC);

module.exports = { main };
if (require.main === module) main();
