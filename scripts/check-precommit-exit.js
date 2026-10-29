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
 * a script file, or a `.js`, `.sh`, `.mjs` or `.cjs` path run directly. An outside command is no checker: a binary such as gitleaks, or
 * inline code (`sh -c "$declared_command"`, `node -e`), whose exit alphabet is
 * not the plugin's.
 *
 * IMPLICIT:  on every commit staging .husky/pre-commit or .husky/pre-commit.local, refuses a checker line in either exiting 1 on its failure, naming the file, line and the pre-commit gate primitive.
 * JUSTIFIED: fail-safe — `|| exit 1` turns a checker that could not run into a finding to fix.
 * DEFEAT:    --warn caps findings below the gating line; `if ! <checker>; then exit 1; fi`; a block exiting 1 on a line holding more than `exit 1`; a checker behind a shell function, a pipeline or a variable naming its interpreter.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { isInlineCode } = require("./lib/shell-words.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const FILES = [".husky/pre-commit", ".husky/pre-commit.local"];
const EXIT_ONE = /\|\|\s*exit\s+1\s*(?:;;)?\s*(?:#.*)?$/;
const OPENS_BLOCK = /\|\|\s*\{\s*(?:#.*)?$/;
const EXIT_ONE_LINE = /^exit\s+1\s*;?\s*(?:#.*)?$/;
const INTERPRETERS = new Set(["node", "bash", "sh"]);
const SCRIPT = /\.(?:[cm]?js|sh)["']?$/;
const LEADING = new Set(["if", "then", "else", "elif", "do", "!", "{", "("]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const EXEMPLAR = ".husky/pre-commit";
const FIX = `pass the checker's own exit code on with \`|| exit "$?"\` (in a block, \`|| { rc=$?; ...; exit "$rc"; }\`), or gate it through staged_gate's \`status\` mode in scripts/lib/precommit-gate.sh, as ${EXEMPLAR}'s check-jsonl-reads.js line does (base §N4, #3456).`;

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
 */
function isCheckerCommand(command) {
	const last = command.split(/;|&&/).at(-1) ?? "";
	const words = wordsOf(last.trim());
	while (words.length > 0) {
		const first = words[0] ?? "";
		if (!LEADING.has(first) && !ASSIGNMENT.test(first)) break;
		words.shift();
	}
	const [program = "", ...rest] = words;
	if (!INTERPRETERS.has(program)) return SCRIPT.test(program);
	return !isInlineCode(program, rest) && rest.some((w) => !w.startsWith("-"));
}

/**
 * @param {string[]} raw
 * @param {number} last
 * @param {string} trimmed
 */
function exitsOneInBlock(raw, last, trimmed) {
	if (!OPENS_BLOCK.test(trimmed)) return false;
	for (const line of raw.slice(last + 1)) {
		const body = line.trim();
		if (body.startsWith("}")) return false;
		if (EXIT_ONE_LINE.test(body)) return true;
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
		if (!EXIT_ONE.test(trimmed) && !exitsOneInBlock(raw, i, trimmed)) continue;
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
