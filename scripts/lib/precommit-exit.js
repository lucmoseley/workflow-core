/*
 * precommit-exit.js — check-precommit-exit.js's core (#3456, #3808, #4123):
 * which lines of a pre-commit hook's text run a checker and exit 1 on its
 * failure. check-precommit-exit.js's header holds the contract: what a
 * breach and a checker are, and what defeats them.
 *
 * A CORE (base §T7): it performs no I/O. The shell reads each hook file.
 */

const { programSource } = require("./shell-words.js");

const EXIT_ONE = /\|\|\s*exit\s+1\s*(?:;;\s*)?(?:#.*)?$/;
const OPENS_BLOCK = /\|\|\s*\{\s*(?:#.*)?$/;
const EXIT_ONE_LINE = /^exit\s+1\s*(?:;;?\s*)?(?:#.*)?$/;
const SUBSTITUTION = /^[A-Za-z_][A-Za-z0-9_]*="?\$\((.*)\)"?$/;
const FALLBACK = /^([A-Za-z_][A-Za-z0-9_]*)=\S*$/;
const ARM_END = /;;\s*(?:#.*)?$/;
const INTERPRETERS = new Set(["node", "bash", "sh"]);
const SCRIPT = /\.(?:[cm]?js|sh)["']?$/;
const LEADING = new Set(["if", "then", "else", "elif", "do", "!", "{", "("]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const EXEMPLAR = ".husky/pre-commit";
const FIX = `pass the checker's own exit code on with \`|| exit "$?"\` (in a block, \`|| { rc=$?; ...; exit "$rc"; }\`), or gate it through staged_gate's \`status\` mode in scripts/lib/precommit-gate.sh, as ${EXEMPLAR}'s check-jsonl-reads.js line does; where the hook reads a probe's or lister's output, its crash exits 2, since a crash's own code may be 1 (base §N4, #3456, #3808).`;

/**
 * A command's words, quotes kept, split on blanks outside quotes.
 * @param {string} text
 */
function wordsOf(text) {
	/** @type {string[]} */
	const words = [];
	let word = "";
	/** @type {string | null} */
	let quote = null;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (/\s/.test(ch)) {
			if (word) words.push(word);
			word = "";
			continue;
		}
		word += ch;
	}
	if (word) words.push(word);
	return words;
}

/**
 * Whether the command before a line's `||` runs a checker: the last command
 * after any `;` or `&&`, past its keywords and variable assignments.
 * @param {string} command
 * @returns {boolean}
 */
function isCheckerCommand(command) {
	const last = (command.split(/;|&&/).at(-1) ?? "").trim();
	const substituted = SUBSTITUTION.exec(last)?.[1];
	if (substituted)
		return !substituted.includes("|") && isCheckerCommand(substituted);
	const words = wordsOf(last);
	while (words.length > 0) {
		const first = words[0] ?? "";
		if (!LEADING.has(first) && !ASSIGNMENT.test(first)) break;
		words.shift();
	}
	const [program = "", ...rest] = words;
	if (!INTERPRETERS.has(program)) return SCRIPT.test(program);
	return programSource(program, rest)?.source === "script";
}

/**
 * @param {string[]} raw
 * @param {number} last
 * @param {string} trimmed
 */
function hasBlockExitOne(raw, last, trimmed) {
	if (!OPENS_BLOCK.test(trimmed)) return false;
	for (const line of raw.slice(last + 1)) {
		const body = line.trim();
		if (body.startsWith("}")) return false;
		if (EXIT_ONE_LINE.test(body)) return true;
	}
	return false;
}

/**
 * A `case` body's own lines, from the line after its `in` to its `esac`: any
 * nested `case` is cut to its closing line, which may end the arm.
 * @param {string[]} lines trimmed
 */
function ownCaseLines(lines) {
	/** @type {string[]} */
	const own = [];
	let depth = 0;
	for (const line of lines) {
		const closes = /^esac\b/.test(line);
		if (closes && depth === 0) return own;
		const opens = /^case\b/.test(line);
		if (closes) depth--;
		if (opens && !/\besac\b/.test(line)) depth++;
		if (depth === 0 && !opens) own.push(line);
	}
	return own;
}

/**
 * Whether a `case` body exits 1 from its own `*)` arm.
 * @param {string[]} lines trimmed, from the line after the `in`
 */
function caseCatchAllExitsOne(lines) {
	const own = ownCaseLines(lines);
	const from = own.findIndex((line) => line.startsWith("*)"));
	if (from < 0) return false;
	for (const line of own.slice(from)) {
		const code = line.startsWith("*)") ? line.slice(2).trim() : line;
		if (EXIT_ONE_LINE.test(code)) return true;
		if (ARM_END.test(code)) return false;
	}
	return false;
}

/**
 * Whether the variable a checker line's `||` falls back to reaches a `case`
 * whose `*)` arm exits 1, nothing assigning it first.
 * @param {string[]} raw
 * @param {number} last
 * @param {string} fallback the text after the line's `||`
 */
function hasCatchAllExitOne(raw, last, fallback) {
	const variable = FALLBACK.exec(fallback)?.[1];
	if (!variable) return false;
	const lines = raw.slice(last + 1).map((line) => line.trim());
	for (const [i, line] of lines.entries()) {
		if (line === `case "$${variable}" in`)
			return caseCatchAllExitsOne(lines.slice(i + 1));
		if (line.startsWith(`${variable}=`) || line.includes(`|| ${variable}=`))
			return false;
	}
	return false;
}

/**
 * Each checker line in a hook's text that exits 1 on its failure: its first
 * line's 1-based number and its text, whitespace collapsed.
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
function parseBreaches(text) {
	const raw = text.split("\n");
	/** @type {{ line: number, text: string }[]} */
	const found = [];
	for (let i = 0; i < raw.length; i++) {
		const first = i;
		let logical = raw[i] ?? "";
		while (logical.endsWith("\\") && i + 1 < raw.length)
			logical = `${logical.slice(0, -1)} ${raw[++i] ?? ""}`;
		const trimmed = logical.trim();
		if (trimmed.startsWith("#")) continue;
		if (
			!EXIT_ONE.test(trimmed) &&
			!hasBlockExitOne(raw, i, trimmed) &&
			!hasCatchAllExitOne(
				raw,
				i,
				trimmed.slice(trimmed.lastIndexOf("||") + 2).trim(),
			)
		)
			continue;
		const command = trimmed.slice(0, trimmed.lastIndexOf("||"));
		if (!isCheckerCommand(command)) continue;
		found.push({ line: first + 1, text: trimmed.replace(/\s+/g, " ") });
	}
	return found;
}

/**
 * Each breach in one hook file, with the message it prints.
 * @param {string} rel
 * @param {string} text
 * @returns {{ line: number, match: string, message: string }[]}
 */
const judgeHook = (rel, text) =>
	parseBreaches(text).map(({ line, text: match }) => ({
		line,
		match,
		message: `${rel}:${line} exits 1 on a checker's failure, turning its BROKEN into a finding (\`${match}\`). Fix: ${FIX}`,
	}));

/** The fix line a run with findings prints beneath them. */
const FIX_LINE = `Fix: ${FIX}`;

module.exports = { FIX_LINE, judgeHook, parseBreaches };
