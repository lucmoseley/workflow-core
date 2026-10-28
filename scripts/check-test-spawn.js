#!/usr/bin/env node
/*
 * check-test-spawn.js — a test runs the Node program under test through
 * lib/run-in-process.js, not a spawn of `node`, unless it states why (base
 * §X3's house clause, #3458).
 *
 * Usage:
 *   node check-test-spawn.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * `.husky/pre-commit` runs it over the whole tree. Not in the scheduled sweeps.
 *
 * A SPAWN is one call of spawnSync, spawn, execFileSync or execFile whose
 * program is `"node"` or `process.execPath`, of execSync or exec on a command
 * string starting `node `, or of fork, in a test file (lib/test-kind.js) under
 * scripts/ or .claude/skills/. A call passing node `-e`, `--eval`, `-p` or
 * `--print` before its first non-flag word runs inline code, not a program,
 * and is not one. Its identity is the file and the call's first line, whitespace collapsed, with
 * a count among identical lines (lib/fault-profiles.js's `test-spawn`
 * profile): an edit to that line reads as a new spawn, and moving it does not.
 *
 * THE STATED REASON is a `spawn-kept: <why>` comment: anywhere from the call's
 * first line to the end of the line it closes on, in the comments directly
 * above it, or in the file's opening comments, which covers every spawn in
 * the file. A marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a test under scripts/ or .claude/skills/, refuses any spawn of `node` in the tree without a `spawn-kept: <why>` comment, naming the file, line and run-in-process.js's exemplar.
 * JUSTIFIED: fail-safe — a spawn pays node's startup on every case (mantahostels#1907).
 * DEFEAT:    the `spawn-kept: <why>` marker, whatever its reason, the header's covering every later spawn in its file; --warn caps findings below the gating line; a program named through a variable, a helper or a testkit; a spawn inside a template literal, or behind an env prefix in a command string; a spawn swapped for another whose first line reads the same; a test file outside scripts/ and .claude/skills/.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { scanJs } = require("./lib/strip-comments.js");
const { isJsTestFile } = require("./lib/test-kind.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { isAgainstSide, runCheck } = require("./lib/check");

const ROOTS = ["scripts", path.join(".claude", "skills")];
const NODE = String.raw`(?:"node"|'node'|\`node\`|process\.execPath)`;
const SPAWN = new RegExp(
	[
		String.raw`\b(?:spawnSync|spawn|execFileSync|execFile)\s*\(\s*${NODE}(\s*,)?`,
		String.raw`\b(?:execSync|exec)\s*\(\s*["'\`]node\s`,
		String.raw`\bfork\s*\(`,
	].join("|"),
	"g",
);
const INLINE_CODE = new Set(["-e", "--eval", "-p", "--print"]);
const MARKER = /spawn-kept:\s*\w/;

const EXEMPLAR = "scripts/check-cli-args.test.ts";
const WHY = "spawns node on the program under test";
const NOUN = "spawn(s) of node on the program under test";
const FIX = `run it through \`runInProcess\` in the plugin's scripts/lib/run-in-process.js, as its ${EXEMPLAR} does; or, where §X3 keeps a spawn (a timeout or a signal, two processes at once, a real fd, an async entry runInProcessAsync cannot load), state which in a \`spawn-kept: <why>\` comment on the call or in the file's header (#3458).`;

/**
 * @param {string} dir
 * @param {string} rel
 * @returns {string[]} paths relative to the root, sorted
 */
function listTestFiles(dir, rel) {
	if (!fs.existsSync(dir)) return [];
	/** @type {string[]} */
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const at = path.join(dir, entry.name);
		const name = path.posix.join(rel, entry.name);
		if (entry.isDirectory()) out.push(...listTestFiles(at, name));
		else if (entry.isFile() && isJsTestFile(entry.name)) out.push(name);
	}
	return out.sort();
}

/**
 * Whether a run of argv strings or a command's words runs inline code: an
 * inline-code flag before the first word that is not a flag.
 *
 * @param {string[]} words
 */
function runsInlineCode(words) {
	for (const w of words) {
		if (!w.startsWith("-")) return false;
		if (INLINE_CODE.has(w.split("=")[0] ?? w)) return true;
	}
	return false;
}

/**
 * @param {string} source
 */
function readSource(source) {
	const { comments, literals } = scanJs(source);
	const isMasked = (/** @type {number} */ at) =>
		comments.some(([s, e]) => at >= s && at < e) ||
		literals.some((l) => at > l.at && at < l.at + l.raw.length);
	const text = (/** @type {[number, number]} */ [s, e]) => source.slice(s, e);
	const isBlank = (/** @type {string} */ s) => s.trim() === "";
	const lineStartOf = (/** @type {number} */ at) =>
		source.lastIndexOf("\n", at - 1) + 1;
	const lineEndOf = (/** @type {number} */ at) => {
		const nl = source.indexOf("\n", at);
		return nl === -1 ? source.length : nl;
	};

	/** @type {string[]} */
	const header = [];
	let edge = 0;
	for (const c of comments) {
		if (!isBlank(source.slice(edge, c[0]))) break;
		header.push(text(c));
		edge = c[1];
	}

	return {
		isMasked,
		lineStartOf,
		lineEndOf,
		header,
		/** The comments starting in [from, to). */
		commentsIn: (/** @type {number} */ from, /** @type {number} */ to) =>
			comments.filter(([s]) => s >= from && s < to).map(text),
		/* The comments a run of whitespace joins to `from`, walking back; a
		 * comment trailing code on its own line belongs to that code. */
		chainBefore(/** @type {number} */ from) {
			/** @type {string[]} */
			const found = [];
			let at = from;
			for (const c of [...comments].reverse()) {
				if (c[1] > at) continue;
				if (!isBlank(source.slice(c[1], at))) break;
				if (!isBlank(source.slice(lineStartOf(c[0]), c[0]))) break;
				found.push(text(c));
				at = c[0];
			}
			return found;
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
	const src = readSource(source);
	if (src.header.some((c) => MARKER.test(c))) return [];

	/** @type {{ line: number, call: string }[]} */
	const out = [];
	for (const m of source.matchAll(SPAWN)) {
		const at = m.index ?? 0;
		if (src.isMasked(at)) continue;
		const open = source.indexOf("(", at);
		const close = src.closeOf(open);
		if (runsInlineCode(nodeWords(source.slice(open, close), Boolean(m[1]))))
			continue;
		const lineStart = src.lineStartOf(at);
		const reasons = [
			...src.commentsIn(lineStart, src.lineEndOf(close)),
			...src.chainBefore(lineStart),
		];
		if (reasons.some((c) => MARKER.test(c))) continue;
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

runCheck({
	name: "test-spawn",
	usage:
		"node check-test-spawn.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "test-spawn",
		materialise: "blobs",
		pathspecs: () => ROOTS.map((r) => r.split(path.sep).join("/")),
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const files = ROOTS.flatMap((r) =>
			listTestFiles(path.join(root, r), r.split(path.sep).join("/")),
		);
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
		/* Under --against every commit staging a test prints this report,
		 * inherited spawns included, so there it names none: the parent
		 * re-lists a spawn this commit adds in full. */
		const where = isAgainstSide()
			? ""
			: `: ${ctx.findings.map((f) => `${f.file}:${f.line}`).join(", ")}`;
		if (ctx.findings.length > 0)
			ctx.say(`  ${ctx.findings.length} ${NOUN}${where}.\n  Fix: ${FIX}`);
		return {
			okLine: `${files.length} test file(s), none spawning node on the program under test without a stated reason.`,
			noun: NOUN,
			count: ctx.findings.length,
			data: { scanned: files.length },
		};
	},
});
