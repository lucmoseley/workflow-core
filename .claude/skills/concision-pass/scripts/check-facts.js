#!/usr/bin/env node
/**
 * Mechanical guard for a concision pass.
 *
 * Lists every fact-shaped token present in the BEFORE text and absent from the
 * AFTER text: numbers and percentages, issue refs (#65), section refs (§B16),
 * clause numbers (6.1(c)), backticked spans, and quoted strings.
 *
 * A token that merely appears FEWER times is the pass working as intended, so
 * those are counted, not listed, unless --verbose.
 *
 * Exit 0 — nothing lost. Exit 2 — hits to account for. Exit 1 — usage/IO error.
 */

const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");

/** @type {Array<[RegExp, string]>} */
const PATTERNS = [
	// Order matters only for readability of the report; matches may overlap.
	[/#\d+/g, "issue ref"],
	[/§\s?[A-Za-z]?\d+(?:\.\d+)*/g, "section ref"],
	// vN.M: a leading `v` blocks \b before the digit, so the decimal pattern
	// below never anchors on it and a version bump reads as bare-number
	// repetition instead of a changed fact (mantahostels#3323).
	[/\bv\d+(?:\.\d+)+\b/g, "version"],
	[/\b\d+\.\d+(?:\([a-z]\))?/g, "clause/decimal"],
	[/\b\d[\d,]*(?:\.\d+)?\s?%/g, "percentage"],
	[/\b\d[\d,]*(?:\.\d+)?\b/g, "number"],
	// Bare git sha: hex digits glued to hex letters block \b on either side of
	// the digit run, so the number pattern above never anchors and the sha is
	// read as nothing at all (mantahostels#3323). Requires an a-f letter: a token's kind is
	// whichever pattern matches it first, so a plain digit run matching both
	// patterns would inflate the number pattern's own count instead of gaining
	// a distinct "sha" line. Costs the reverse false positive on a 7+-letter
	// a-f-only word ("defaced") — the safe direction, so left as is.
	[/\b(?=\d*[a-f])[0-9a-f]{7,40}\b/g, "sha"],
	[/`[^`\n]{2,80}`/g, "code span"],
	[/[“][^”\n]{3,80}[”]/g, "quotation"],
	[/"[^"\n]{3,80}"/g, "quotation"],
];

/**
 * Strip HTML tags and decode the few entities the roadmap actually uses.
 *
 * ONLY for HTML. `<[^>]+>` is not a tag matcher outside one: in a .ts file the
 * `<` of `while (Date.now() < deadline)` pairs with an unrelated `>` far later
 * and deletes everything between, so tokens plainly still in the file are
 * reported GONE ENTIRELY (mantahostels#898 carries the run that measured it). A false loss
 * report is worse than none, because the whole point of the check is that the
 * reader trusts it over their own eye.
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
 * Map of token -> {kind, count} for one text.
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
 * Read both files, or exit 1 naming the one that failed.
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
		// writeFd, not console.error: this line sits right above
		// process.exit, and node drops whatever is still buffered on a pipe at
		// exit — the four .claude skill scripts bind §N6 at full force (mantahostels#1189).
		writeFd(2, `cannot read: ${err instanceof Error ? err.message : err}\n`);
		process.exit(1);
	}
}

/**
 * Split BEFORE's tokens into those gone from AFTER and those mentioned fewer times.
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
		console.error(
			"usage: check-facts.js <before-file> <after-file> [--verbose]",
		);
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
	console.log(`words: ${beforeWords} -> ${afterWords} (${pct}% cut)`);

	/** @typedef {{tok: string, kind: string, was: number, now: number}} Token */
	/** @param {Token} a @param {Token} b */
	const byKind = (a, b) =>
		a.kind.localeCompare(b.kind) || a.tok.localeCompare(b.tok);

	/** @param {Token[]} list @param {string} heading */
	const report = (list, heading) => {
		console.log(`\n${heading}\n`);
		for (const { tok, kind, was, now } of [...list].sort(byKind))
			console.log(`  [${kind}] ${tok}  (${was} -> ${now})`);
	};

	if (thinned.length > 0) {
		if (verbose)
			report(thinned, `${thinned.length} token(s) mentioned fewer times:`);
		else
			console.log(
				`${thinned.length} token(s) survive but are mentioned fewer times — repetition cut, as intended (--verbose to list).`,
			);
	}

	if (gone.length === 0) {
		console.log("OK — every fact-shaped token survived the cut.");
		process.exit(0);
	}

	report(gone, `${gone.length} token(s) GONE ENTIRELY — account for each:`);
	console.log(
		"\nEach is an intended cut or a lost fact. Say which, for each. A figure\nrespelled in words (4 -> 'four') is safe; a figure simply absent is not.",
	);
	process.exit(2);
}

main();
