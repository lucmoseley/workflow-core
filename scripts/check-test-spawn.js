#!/usr/bin/env node
/*
 * check-test-spawn.js — a test runs the Node program under test through
 * lib/run-in-process.js, not a spawn of `node`, unless it spawns through
 * lib/kept-spawn.js with a typed reason (base §X3's house clause, #3458, #5483).
 *
 * Usage:
 *   node check-test-spawn.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * `.husky/pre-commit` runs it over the whole tree. Not in the scheduled sweeps.
 *
 * A SPAWN is one call of spawnSync, spawn, execFileSync or execFile whose
 * program is `"node"` or `process.execPath`, of execSync or exec on a command
 * string starting `node `, or of fork, in a test file (lib/test-kind.js) under
 * scripts/ or .claude/skills/. A call whose node words lib/shell-words.js's
 * `programSource` reads as `inline` runs inline code, not a program, and is
 * not one. Its identity is the file and the call's first line, whitespace collapsed, with
 * a count among identical lines (lib/fault-profiles.js's `test-spawn`
 * profile): an edit to that line reads as a new spawn, and moving it does not.
 *
 * THE STATED REASON is the call itself spelled `keptSpawn("<reason>").<fn>(`,
 * the reason one of lib/kept-spawn.js's REASONS. Any other spelling, a
 * comment included, states none.
 *
 * IMPLICIT:  on every commit staging a test under scripts/ or .claude/skills/, refuses any spawn of `node` in the tree not called through `keptSpawn("<reason>")`, naming the file, line, run-in-process.js and kept-spawn.js.
 * JUSTIFIED: fail-safe — a spawn pays node's startup on every case (mantahostels#1907).
 * DEFEAT:    `keptSpawn` with a listed reason that is not the true one, or the name `keptSpawn` bound to something else; --warn caps findings below the gating line; a program named through a variable, a helper or a testkit; a spawn inside a template literal, or behind an env prefix in a command string; a spawn swapped for another whose first line reads the same; a test file outside scripts/ and .claude/skills/.
 */

const fs = require("node:fs");
const path = require("node:path");
const { listTreeFiles, saySites } = require("./lib/heresy-scan.js");
const { hostRoot } = require("./lib/host-root.js");
const { REASONS } = require("./lib/kept-spawn.js");
const { programSource } = require("./lib/shell-words.js");
const { scanJs } = require("./lib/strip-comments.js");
const { isJsTestFile } = require("./lib/test-kind.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

const ROOTS = ["scripts", ".claude/skills"];
const NODE = String.raw`(?:"node"|'node'|\`node\`|process\.execPath)`;
const SPAWN = new RegExp(
	[
		String.raw`\b(?:spawnSync|spawn|execFileSync|execFile)\s*\(\s*${NODE}(\s*,)?`,
		String.raw`\b(?:execSync|exec)\s*\(\s*["'\`]node\s`,
		String.raw`\bfork\s*\(`,
	].join("|"),
	"g",
);
/* The helper call ending right before a spawn: `keptSpawn("fd").`. */
const HELPER = /\bkeptSpawn\(\s*["'`](\w*)["'`]\s*\)\s*\.\s*$/;

const WHY = "spawns node on the program under test";
const NOUN = "spawn(s) of node on the program under test";
const FIX = `run it through \`runInProcess\` in the plugin's scripts/lib/run-in-process.js, \`runInProcessAsync\` for an async entry, as its header's contract states; or, where §X3 keeps a spawn, call it through scripts/lib/kept-spawn.js as \`keptSpawn("<reason>").spawnSync(process.execPath, …)\` (or .spawn, .execFile, .execFileSync), the reason one of ${REASONS.join(", ")} (#5483).`;

/**
 * @param {string} source
 */
function parseSource(source) {
	const { comments, literals } = scanJs(source);
	const isMasked = (/** @type {number} */ at) =>
		comments.some(([s, e]) => at >= s && at < e) ||
		literals.some((l) => at > l.at && at < l.at + l.raw.length);
	return {
		isMasked,
		lineStartOf: (/** @type {number} */ at) =>
			source.lastIndexOf("\n", at - 1) + 1,
		lineEndOf(/** @type {number} */ at) {
			const nl = source.indexOf("\n", at);
			return nl === -1 ? source.length : nl;
		},
		/** The offset past the bracket closing the one at `open`. */
		closeOf(/** @type {number} */ open) {
			let depth = 0;
			for (let i = open; i < source.length; i++) {
				const ch = source[i] ?? "";
				if (isMasked(i)) continue;
				if ("([{".includes(ch)) depth++;
				else if (")]}".includes(ch) && --depth === 0) return i + 1;
			}
			return source.length;
		},
	};
}

/**
 * The words a spawn hands node: its argv array's entries, or the words after
 * `node` in a command string.
 *
 * @param {string} args the call's parenthesised arguments
 * @param {boolean} isArgv whether the call takes an argv array
 */
function nodeWords(args, isArgv) {
	if (!isArgv)
		return (args.match(/["'`]node\s+([^"'`]*)/)?.[1] ?? "").split(/\s+/);
	const array = args.match(/\[([^\]]*)/)?.[1] ?? "";
	return [...array.matchAll(/["'`]([^"'`]*)["'`]|[^,\s][^,]*/g)].map((w) =>
		(w[1] ?? w[0]).trim(),
	);
}

/**
 * Each spawn in a test file's source that states no reason.
 *
 * @param {string} source
 * @returns {{ line: number, call: string }[]}
 */
function unstatedSpawns(source) {
	const src = parseSource(source);
	/** @type {{ line: number, call: string }[]} */
	const out = [];
	for (const m of source.matchAll(SPAWN)) {
		const at = m.index ?? 0;
		if (src.isMasked(at)) continue;
		const kept = source.slice(Math.max(0, at - 80), at).match(HELPER);
		if (kept && REASONS.includes(kept[1] ?? "")) continue;
		const open = source.indexOf("(", at);
		const close = src.closeOf(open);
		if (
			programSource("node", nodeWords(source.slice(open, close), Boolean(m[1])))
				?.source === "inline"
		)
			continue;
		const lineStart = src.lineStartOf(at);
		out.push({
			line: source.slice(0, at).split("\n").length,
			call: source
				.slice(lineStart, src.lineEndOf(at))
				.trim()
				.replace(/\s+/g, " "),
		});
	}
	return out;
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "test-spawn",
	usage:
		"node check-test-spawn.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "test-spawn",
		materialise: "blobs",
		pathspecs: () => ROOTS,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const files = listTreeFiles(root, ROOTS).filter(isJsTestFile);
		for (const rel of files) {
			/** @type {Record<string, number>} */
			const seen = {};
			const source = fs.readFileSync(path.join(root, rel), "utf8");
			for (const { line, call } of unstatedSpawns(source)) {
				seen[call] = (seen[call] ?? 0) + 1;
				ctx.fail("TEST-SPAWN", `${rel}:${line} ${WHY}. Fix: ${FIX}`, {
					file: rel,
					line,
					call,
					nth: seen[call],
				});
			}
		}
		saySites(ctx, NOUN, [`Fix: ${FIX}`]);
		return {
			okLine: `${files.length} test file(s), none spawning node on the program under test without a stated reason.`,
			noun: NOUN,
			count: ctx.findings.length,
			data: { scanned: files.length },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
