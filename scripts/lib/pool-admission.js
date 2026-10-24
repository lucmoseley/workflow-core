/*
 * The always-loaded pool's rules, and the admission ledger each one must carry
 * an entry in (workflow-core#1943, workflow-core#2033).
 *
 * A RULE IS A TOP-LEVEL LIST ITEM OR A TOP-LEVEL BOLD-LED PARAGRAPH, outside
 * fences and HTML comments (workflow-core#2056) — a shape, not a reading, so a list item
 * that states no rule still counts. Its KEY is its file plus its headline — the
 * bold lead where the item opens with one, else its first sentence — so a
 * reworded headline is a new key, and its entry moves with it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group.js");

const LEDGER_PATH = "docs/pool-admission-ledger.json";

const ROUTES = new Set(["no-trigger", "trigger", "pre-first-tool-call"]);

const ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const ANY_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const FENCE = /^\s*(```|~~~)/;
const COMMENT_OPEN = /^\s*<!--/;

/** @param {string} s */
const squash = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Each index in `text` that sits outside a backtick code span, so a `**` or a
 * full stop quoted in code never ends a headline.
 * @param {string} text
 * @returns {Generator<number>}
 */
function* outsideCode(text) {
	let fence = 0;
	for (let i = 0; i < text.length; ) {
		if (text[i] === "`") {
			let run = 0;
			while (text[i + run] === "`") run++;
			if (fence === 0) fence = run;
			else if (run === fence) fence = 0;
			i += run;
			continue;
		}
		if (fence === 0) yield i;
		i++;
	}
}

/**
 * @param {string} text
 * @returns {string}
 */
function headlineOf(text) {
	if (text.startsWith("**")) {
		for (const i of outsideCode(text))
			if (i >= 2 && text.startsWith("**", i)) return squash(text.slice(2, i));
	}
	for (const i of outsideCode(text))
		if (
			/[.!?]/.test(text.charAt(i)) &&
			/^(\s|$)/.test(text.slice(i + 1, i + 2))
		)
			return squash(text.slice(0, i + 1));
	return squash(text);
}

/**
 * Each line outside fences and HTML comments, and null where a fence or a
 * comment ends the block before it.
 * @param {string} markdown
 * @returns {Generator<{ line: number, raw: string } | null>}
 */
function* proseLines(markdown) {
	let fenced = false;
	let commented = false;
	for (const [n, raw] of markdown.split("\n").entries()) {
		if (commented) {
			if (raw.includes("-->")) commented = false;
		} else if (FENCE.test(raw)) {
			fenced = !fenced;
			yield null;
		} else if (fenced) continue;
		else if (COMMENT_OPEN.test(raw)) {
			commented = !raw.slice(raw.indexOf("<!--") + 4).includes("-->");
			yield null;
		} else yield { line: n + 1, raw };
	}
}

/**
 * Lazy continuation lines join their item. A bold-led paragraph counts only
 * from its first line, at column 0: a `**` line inside another paragraph or
 * under a list item is no rule.
 * @param {string} markdown
 * @returns {{ line: number, headline: string }[]}
 */
function poolItems(markdown) {
	/** @type {{ line: number, text: string }[]} */
	const items = [];
	/** @type {{ line: number, text: string } | null} */
	let open = null;
	let inBlock = false;
	for (const l of proseLines(markdown)) {
		if (l === null || !l.raw.trim() || l.raw.startsWith("#")) {
			open = null;
			inBlock = false;
			continue;
		}
		const m = l.raw.match(ITEM);
		if (m) {
			open = { line: l.line, text: requiredGroup(m, 1, ITEM) };
			items.push(open);
		} else if (ANY_ITEM.test(l.raw)) open = null;
		else if (open) open.text += ` ${l.raw}`;
		else if (!inBlock && l.raw.startsWith("**")) {
			open = { line: l.line, text: l.raw };
			items.push(open);
		}
		inBlock = true;
	}
	return items.map(({ line, text }) => ({ line, headline: headlineOf(text) }));
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string | undefined} undefined where the revision lacks the file
 */
function readIfPresent(root, file) {
	try {
		return fs.readFileSync(path.join(root, file), "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return;
		throw e;
	}
}

/**
 * @param {string} root
 * @param {string[]} files
 * @returns {{ file: string, line: number, headline: string }[]}
 */
function readPoolItems(root, files) {
	return files.flatMap((file) => {
		const text = readIfPresent(root, file);
		if (text === undefined) return [];
		return poolItems(text).map((item) => ({ file, ...item }));
	});
}

/**
 * @typedef {{ file: string, headline: string, claim: string,
 *   route: "no-trigger" | "trigger" | "pre-first-tool-call", ticket?: number }} LedgerEntry
 */

/**
 * Absent reads as empty, so every pool item is then unadmitted.
 * @param {string} root
 * @returns {LedgerEntry[]}
 */
function readLedger(root) {
	const raw = readIfPresent(root, LEDGER_PATH);
	if (raw === undefined) return [];
	const entries = JSON.parse(raw)?.entries;
	if (!Array.isArray(entries))
		throw new Error(`${LEDGER_PATH} carries no "entries" array`);
	for (const [i, e] of entries.entries())
		checkEntry(e, `${LEDGER_PATH} entry ${i}`);
	return entries;
}

/**
 * @param {Record<string, unknown>} e
 * @param {string} at
 */
function checkEntry(e, at) {
	for (const key of ["file", "headline", "claim"]) {
		const v = e?.[key];
		if (typeof v !== "string" || !v.trim())
			throw new Error(`${at} has no "${key}"`);
	}
	if (typeof e.route !== "string" || !ROUTES.has(e.route))
		throw new Error(
			`${at} has route ${JSON.stringify(e.route)} — expected one of ${[...ROUTES].join(", ")}`,
		);
	if (e.route === "trigger" && !Number.isInteger(e.ticket))
		throw new Error(
			`${at} routes by "trigger" and names no "ticket", the /implement ticket whose guard will print it`,
		);
}

/** @param {{ file: string, headline: string }} x */
const keyOf = (x) => `${x.file}\n${squash(x.headline)}`;

/**
 * @param {{ file: string, line: number, headline: string }[]} items
 * @param {LedgerEntry[]} entries
 */
function admit(items, entries) {
	const byKey = new Map(entries.map((e) => [keyOf(e), e]));
	const inPool = new Set(items.map(keyOf));
	return {
		unadmitted: items.filter((item) => !byKey.has(keyOf(item))),
		admitted: entries.filter((e) => inPool.has(keyOf(e))),
	};
}

module.exports = {
	LEDGER_PATH,
	readPoolItems,
	readLedger,
	admit,
};
