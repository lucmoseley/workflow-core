#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");

const USAGE = `usage: check-facts.js <before-file> <after-file> [--verbose]

Lists every fact-shaped token present in BEFORE and absent from AFTER:
numbers and percentages, issue refs (#65), section refs (§B16), clause
numbers (6.1(c)), versions, git shas, backticked spans and quoted strings.
A token that merely appears fewer times is counted, not listed, unless
--verbose.

Exit 0: nothing lost. Exit 2: tokens to account for. Exit 1: usage or IO error.
`;

/** @type {Array<[RegExp, string]>} */
const PATTERNS = [
	[/#\d+/g, "issue ref"],
	[/§\s?[A-Za-z]?\d+(?:\.\d+)*/g, "section ref"],
	[/\bv\d+(?:\.\d+)+\b/g, "version"],
	[/\b\d+\.\d+(?:\([a-z]\))?/g, "clause/decimal"],
	[/\b\d[\d,]*(?:\.\d+)?\s?%/g, "percentage"],
	[/\b\d[\d,]*(?:\.\d+)?\b/g, "number"],
	[/\b(?=\d*[a-f])[0-9a-f]{7,40}\b/g, "sha"],
	[/`[^`\n]{2,80}`/g, "code span"],
	[/[“][^”\n]{3,80}[”]/g, "quotation"],
	[/"[^"\n]{3,80}"/g, "quotation"],
];

/**
 * @param {string} raw
 * @param {boolean} isHtml
 * @returns {string}
 */
function normalise(raw, isHtml) {
	if (!isHtml) return raw;
	return raw
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\\'/g, "'");
}

/**
 * @param {string} text
 * @returns {Map<string, {kind: string, count: number}>}
 */
function tokenise(text) {
	const found = new Map();
	for (const [re, kind] of PATTERNS) {
		for (const m of text.matchAll(re)) {
			const tok = m[0].trim();
			const prev = found.get(tok);
			if (prev) prev.count += 1;
			else found.set(tok, { kind, count: 1 });
		}
	}
	return found;
}

/**
 * @param {string} beforePath
 * @param {string} afterPath
 * @returns {{beforeRaw: string, afterRaw: string}}
 */
function readBoth(beforePath, afterPath) {
	try {
		const beforeRaw = fs.readFileSync(beforePath, "utf8");
		const afterRaw = fs.readFileSync(afterPath, "utf8");
		return { beforeRaw, afterRaw };
	} catch (err) {
		writeFd(2, `cannot read: ${err instanceof Error ? err.message : err}\n`);
		process.exit(1);
	}
}

/**
 * @param {Map<string, {kind: string, count: number}>} before
 * @param {Map<string, {kind: string, count: number}>} after
 */
function diffTokens(before, after) {
	const gone = [];
	const thinned = [];
	for (const [tok, { kind, count }] of before) {
		const stillThere = after.get(tok);
		if (!stillThere) gone.push({ tok, kind, was: count, now: 0 });
		else if (stillThere.count < count)
			thinned.push({ tok, kind, was: count, now: stillThere.count });
	}
	return { gone, thinned };
}

function main() {
	const args = process.argv.slice(2);
	const verbose = args.includes("--verbose");
	const [beforePath, afterPath] = args.filter((a) => !a.startsWith("--"));
	if (!beforePath || !afterPath) {
		writeFd(2, USAGE);
		process.exit(1);
	}

	const { beforeRaw, afterRaw } = readBoth(beforePath, afterPath);

	const isHtml = /\.html?$/i.test(beforePath) || /\.html?$/i.test(afterPath);
	const before = tokenise(normalise(beforeRaw, isHtml));
	const afterText = normalise(afterRaw, isHtml);
	const after = tokenise(afterText);

	const { gone, thinned } = diffTokens(before, after);

	const beforeWords = normalise(beforeRaw, isHtml)
		.split(/\s+/)
		.filter(Boolean).length;
	const afterWords = afterText.split(/\s+/).filter(Boolean).length;
	const pct = beforeWords
		? Math.round(((beforeWords - afterWords) / beforeWords) * 100)
		: 0;
	writeFd(1, `words: ${beforeWords} -> ${afterWords} (${pct}% cut)\n`);

	/** @typedef {{tok: string, kind: string, was: number, now: number}} Token */
	/** @param {Token} a @param {Token} b */
	const byKind = (a, b) =>
		a.kind.localeCompare(b.kind) || a.tok.localeCompare(b.tok);

	/** @param {Token[]} list @param {string} heading */
	const report = (list, heading) => {
		writeFd(1, `\n${heading}\n\n`);
		for (const { tok, kind, was, now } of [...list].sort(byKind))
			writeFd(1, `  [${kind}] ${tok}  (${was} -> ${now})\n`);
	};

	if (thinned.length > 0) {
		if (verbose)
			report(thinned, `${thinned.length} token(s) mentioned fewer times:`);
		else
			writeFd(
				1,
				`${thinned.length} token(s) survive but are mentioned fewer times — repetition cut, as intended (--verbose to list).\n`,
			);
	}

	if (gone.length === 0) {
		writeFd(1, "OK — every fact-shaped token survived the cut.\n");
		process.exit(0);
	}

	report(gone, `${gone.length} token(s) GONE ENTIRELY — account for each:`);
	writeFd(
		1,
		"\nEach is an intended cut or a lost fact. Say which, for each. A figure\nrespelled in words (4 -> 'four') is safe; a figure simply absent is not.\n",
	);
	process.exit(2);
}

main();
