#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { listTreeFiles, saySites } = require("./lib/heresy-scan.js");
const { worktreeRoot } = require("./lib/host-root.js");
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
const HELPER = /\bkeptSpawn\(\s*["'`](\w*)["'`]\s*\)\s*\.\s*$/;

const WHY = "spawns node on the program under test";
const NOUN = "spawn(s) of node on the program under test";
const FIX = `run it through \`runInProcess\` in the plugin's scripts/lib/run-in-process.js, \`runInProcessAsync\` for an async entry, as its header's contract states; or, where §X3 keeps a spawn, call it through scripts/lib/kept-spawn.js as \`keptSpawn("<reason>").spawnSync(process.execPath, …)\` (or .spawn, .execFile, .execFileSync, which a fork or exec of node is rewritten as), the reason one of ${REASONS.join(", ")} (workflow-core#5483).`;

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
 * @param {string} args
 * @param {boolean} isArgv
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
		const kept = source.slice(0, at).match(HELPER);
		if (
			kept &&
			!src.isMasked(kept.index ?? 0) &&
			REASONS.some((r) => r === kept[1])
		)
			continue;
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
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
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
