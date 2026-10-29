#!/usr/bin/env node
/*
 * check-gh-route.js — every `gh` call goes through the one route: lib/gh.js
 * in a Node program, "${WFC_GH:-gh}" in a shell one, and in a test a stub at
 * WFC_GH (base §X2, §N7; #3455).
 *
 * Usage:
 *   node check-gh-route.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * LEXICAL, comments aside, over scripts/, .claude/skills/, .husky/ and
 * hooks/, shell files being those lib/formatters.js's shellFiles() names.
 * Four shapes:
 *   - SECOND-VAR: a `WFC_<name>_GH` var, in any code file.
 *   - NODE-COPY: a non-test Node program spawning a literal `"gh"`, or one
 *     other than lib/gh.js and the written exceptions reading
 *     `process.env.WFC_GH`.
 *   - SHELL-BARE: a shell line running `gh` as a command — at a line's
 *     start, after `$(`, an unescaped backtick, `;`, `&`, `|`, `!`, a keyword or
 *     `timeout <n>` — or probing it with `command -v gh`, `type -P gh` or
 *     `which gh`.
 *   - PATH-STUB: a test or test support (lib/test-kind.js), or any `.ts`,
 *     prepending to PATH a directory it joins a `"gh"` onto.
 *
 * THE WRITTEN EXCEPTIONS, WRITTEN_EXCEPTIONS below, may read WFC_GH; a literal
 * `"gh"` spawn fails there too.
 *
 * THE OPT-OUT is a `gh-route-exempt: <why>` comment on the line or the line
 * above, for a shell line naming `gh` only as text, such as a message telling
 * an agent what to run, or a test of a sandbox whose sessions' own Bash
 * reaches `gh` by PATH. A marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a path under scripts/, .claude/skills/, .husky/ or hooks/, refuses any second `gh` route in the tree, naming the file, line, lib/gh.js and its exemplar.
 * JUSTIFIED: fail-safe — a `gh` call off WFC_GH escapes every test's stub and reaches the founder's live tracker.
 * DEFEAT:    the `gh-route-exempt: <why>` marker; --warn caps findings below the gating line; a binary named through a variable; a PATH stub whose directory is spelt differently where it is joined and where it is prepended, or written by a helper, built with `/gh` in a string, or prepended by `join` or `+`; a shell `gh` after a word this list does not name; a command-string spawn such as `execSync("gh …")`; a test's own literal `"gh"` spawn; Python, which reaches `gh` through lib/wfc_bin.py.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { readWorktreeHead, shellFiles } = require("./lib/formatters.js");
const { blankComments } = require("./lib/js-lex.js");
const { isTestKind } = require("./lib/test-kind.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const ROOTS = ["scripts", ".claude/skills", ".husky", "hooks"];
const PRIMITIVE = "scripts/lib/gh.js";
const EXEMPLAR = "scripts/check-issue-orphans.js";
const STUB_EXEMPLAR = "scripts/check-issue-orphans.test.ts";
const SHELL_EXEMPLAR = "scripts/link-sub-issue.sh";

/** Program → the reason it keeps its own spawn, as its site comment says. */
const WRITTEN_EXCEPTIONS = new Map([
	[
		"scripts/lib/arbiter-debts.js",
		"lib/gh.js would load lib/check.js's crash handler into the session arbiter, a hook",
	],
	[
		"scripts/lib/workflow-core-config.js",
		"lib/gh.js requires it, and would load lib/check.js's crash handler into every hook",
	],
]);

const FIX = {
	"SECOND-VAR": `name the binary through WFC_GH, the one var ${PRIMITIVE} reads, as ${EXEMPLAR} and ${SHELL_EXEMPLAR} do.`,
	"NODE-COPY": `call \`gh\`, \`ghJson\` or their kin from ${PRIMITIVE}, as ${EXEMPLAR} does.`,
	"SHELL-BARE": `run "\${WFC_GH:-gh}", the var ${PRIMITIVE} reads, as ${SHELL_EXEMPLAR} does; or mark it \`gh-route-exempt: <why>\` where \`gh\` is only text.`,
	"PATH-STUB": `point WFC_GH at the stub, with \`stubGhScript\` or \`stubGhRoutes\` from scripts/lib/gh-stub.ts, as ${STUB_EXEMPLAR} does.`,
};

const EXEMPT = /gh-route-exempt:\s*\w/;
const SECOND_VAR = /\bWFC_\w+_GH\b/;
const ENV_READ = /\bprocess\.env\.WFC_GH\b(?!\s*=[^=])/;
const LITERAL_SPAWN =
	/\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*(["'`])gh\1/;
const SHELL_RUN =
	/(?:^|\$\(|(?<!\\)`|[;&|!]|\b(?:then|do|else|elif|if|while|until|exec|time|timeout\s+\S+))\s*gh\s/;
const SHELL_PROBE = /\b(?:command\s+-v|type\s+-P|which)\s+gh\b/;
const JOIN_GH = /path\.join\(\s*([^()]*?)\s*,\s*(["'`])gh\2\s*\)/g;
const PATH_PREPEND =
	/`\$\{([^}]+)\}(?:\$\{path\.delimiter\}|:)\$\{process\.env\.PATH\b/g;

/** @param {string} expr */
const normal = (expr) =>
	expr.replace(/^path\.join\(\s*(.*)\)$/s, "$1").replace(/\s+/g, "");

/**
 * @param {string} rel
 * @param {Set<string>} shell
 * @returns {"node" | "test" | "shell" | null}
 */
function kindOf(rel, shell) {
	if (shell.has(rel)) return "shell";
	if (!/\.[cm]?[jt]sx?$/.test(rel)) return null;
	return isTestKind(rel) ? "test" : "node";
}

/**
 * `ghDirs` holds the directories a test joins a `"gh"` onto.
 * @param {string} rel
 * @param {"node" | "test" | "shell"} kind
 * @param {string} line
 * @param {Set<string>} ghDirs
 * @returns {keyof FIX | null}
 */
function shapeOf(rel, kind, line, ghDirs) {
	if (SECOND_VAR.test(line)) return "SECOND-VAR";
	if (kind === "node") {
		const own = rel === PRIMITIVE || WRITTEN_EXCEPTIONS.has(rel);
		const copies = LITERAL_SPAWN.test(line) || (!own && ENV_READ.test(line));
		return copies ? "NODE-COPY" : null;
	}
	if (kind === "shell")
		return SHELL_RUN.test(line) || SHELL_PROBE.test(line) ? "SHELL-BARE" : null;
	for (const m of line.matchAll(PATH_PREPEND))
		if (ghDirs.has(normal(m[1] ?? ""))) return "PATH-STUB";
	return null;
}

const MARKABLE = new Set(["SHELL-BARE", "PATH-STUB"]);

/**
 * @param {string} rel
 * @param {"node" | "test" | "shell"} kind
 * @param {string} source
 * @returns {{ shape: keyof FIX, line: number, text: string }[]}
 */
function findingsIn(rel, kind, source) {
	const raw = source.split("\n");
	const code =
		kind === "shell"
			? raw.map((l) => (/^\s*#/.test(l) ? "" : l))
			: blankComments(source).split("\n");
	/** @type {Set<string>} */
	const ghDirs = new Set();
	if (kind === "test")
		for (const m of code.join("\n").matchAll(JOIN_GH))
			ghDirs.add(normal(m[1] ?? ""));
	/** @type {{ shape: keyof FIX, line: number, text: string }[]} */
	const found = [];
	for (const [i, line] of code.entries()) {
		const shape = shapeOf(rel, kind, line, ghDirs);
		if (!shape) continue;
		const marked = raw
			.slice(Math.max(0, i - 1), i + 1)
			.some((l) => EXEMPT.test(l));
		if (marked && MARKABLE.has(shape)) continue;
		found.push({ shape, line: i + 1, text: line.trim().replace(/\s+/g, " ") });
	}
	return found;
}

/**
 * @param {string} root
 */
function listFiles(root) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} rel */
	const walk = (rel) => {
		const at = path.join(root, rel);
		if (!fs.existsSync(at)) return;
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const name = path.posix.join(rel, entry.name);
			if (entry.isDirectory()) walk(name);
			else if (entry.isFile()) out.push(name);
		}
	};
	for (const dir of ROOTS) walk(dir);
	return out.sort();
}

runCheck({
	name: "gh-route",
	usage:
		"node check-gh-route.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "gh-route",
		materialise: "blobs",
		pathspecs: () => ROOTS,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const files = listFiles(root);
		const shell = new Set(
			shellFiles(files, (rel) => readWorktreeHead(path.join(root, rel))),
		);
		let scanned = 0;
		for (const rel of files) {
			const kind = kindOf(rel, shell);
			if (!kind) continue;
			scanned++;
			const source = fs.readFileSync(path.join(root, rel), "utf8");
			/** @type {Map<string, number>} */
			const seen = new Map();
			for (const { shape, line, text } of findingsIn(rel, kind, source)) {
				const n = (seen.get(text) ?? 0) + 1;
				seen.set(text, n);
				ctx.fail(
					shape,
					`${rel}:${line} reaches \`gh\` off its one route (${shape}). Fix: ${FIX[shape]}`,
					{ file: rel, line, match: `${text} #${n}` },
				);
			}
		}
		if (ctx.findings.length > 0)
			ctx.say(
				`  ${ctx.findings.length} second \`gh\` route(s): ${ctx.findings.map((f) => `${f.file}:${f.line}`).join(", ")}.\n${[
					...new Set(ctx.findings.map((f) => f.tag)),
				]
					.map((tag) => `  ${tag} Fix: ${FIX[/** @type {keyof FIX} */ (tag)]}`)
					.join("\n")}`,
			);
		return {
			okLine: `${scanned} file(s), every \`gh\` call on WFC_GH.`,
			noun: "second `gh` route(s)",
			count: ctx.findings.length,
			data: { scanned },
		};
	},
});
