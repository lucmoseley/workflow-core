#!/usr/bin/env node
/*
 * check-precommit-exit.js — a pre-commit line running a checker passes its
 * exit code on with `|| exit "$?"`, never `|| exit 1`, so BROKEN (2) never
 * reaches the committer as a finding (base §N4, #3456).
 *
 * Usage:
 *   node check-precommit-exit.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL. It reads `.husky/pre-commit` and `.husky/pre-commit.local` at the
 * root, joining backslash-continued lines. A BREACH is a line ending
 * `|| exit 1`, or ending `|| {` with an `exit 1` line before the block's `}`,
 * whose command before the `||` is a CHECKER: `node`, `bash` or `sh` running
 * a script file, or a `.js`, `.sh`, `.mjs` or `.cjs` path run directly, either
 * bare or as a plain assignment's `"$(...)"` holding no pipeline. An outside command is no checker: a binary such as gitleaks, or
 * inline code (`sh -c "$declared_command"`, `node -e`), whose exit alphabet is
 * not the plugin's.
 *
 * Also a BREACH: a checker line ending `|| y=...`, whose `case "$y" in`, with no
 * assignment to `y` between them, exits 1 from its own `*)` arm. A named arm is
 * left alone, as the checker's own answer, which may be a finding (#3808).
 *
 * IMPLICIT:  on every commit staging .husky/pre-commit or .husky/pre-commit.local, refuses a checker line in either exiting 1 on its failure, naming the file, line and the pre-commit gate primitive.
 * JUSTIFIED: fail-safe — `|| exit 1` turns a checker that could not run into a finding to fix.
 * DEFEAT:    --warn caps findings below the gating line; `if ! <checker>; then exit 1; fi`; a block exiting 1 on a line holding more than `exit 1`; a checker behind a shell function, a pipeline or a variable naming its interpreter; a substitution under `if`, `local` or `export`, or with a redirection after it; a fallback with a space or a comment in it, or `|| true`; a `case` spelt other than `case "$y" in`, `case "${y}" in` and `case "$y:$z" in` among them; a `(*)` arm; a `*)` arm exiting 1 on a line holding more than `exit 1`, or inside a nested `case`; a named arm catching what a crash prints.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { programSource } = require("./lib/shell-words.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const FILES = [".husky/pre-commit", ".husky/pre-commit.local"];
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

runCheck({
	name: "precommit-exit",
	usage:
		"node check-precommit-exit.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "precommit-exit",
		materialise: "blobs",
		pathspecs: () => FILES,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const files = FILES.filter((rel) => fs.existsSync(path.join(root, rel)));
		for (const rel of files)
			for (const { line, text } of parseBreaches(
				fs.readFileSync(path.join(root, rel), "utf8"),
			))
				ctx.fail(
					"PRECOMMIT-EXIT",
					`${rel}:${line} exits 1 on a checker's failure, turning its BROKEN into a finding (\`${text}\`). Fix: ${FIX}`,
					{ file: rel, line, match: text },
				);
		if (ctx.findings.length > 0)
			ctx.say(
				`  ${ctx.findings.length} checker line(s) exit 1 on failure: ${ctx.findings.map((f) => `${f.file}:${f.line}`).join(", ")}.\n  Fix: ${FIX}`,
			);
		return {
			okLine: `${files.length} pre-commit file(s), every checker line passing its exit code on.`,
			noun: "checker line(s) exiting 1 on failure",
			count: ctx.findings.length,
			data: { scanned: files.length },
		};
	},
});
