#!/usr/bin/env node
/*
 * check-gh-route.js — every `gh` and `claude` call goes through its one route:
 * the binary's primitive in a Node program, lib/gh.js or lib/claude-bin.js;
 * "${WFC_GH:-gh}" or "${WFC_CLAUDE_BIN:-claude}" in a shell one; and in a test
 * a stub at that var (base §X2, §N7; #3455, #3559).
 *
 * Usage:
 *   node check-gh-route.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * LEXICAL, comments aside, over scripts/, .claude/skills/, .husky/ and
 * hooks/, shell files being those lib/formatters.js's shellFiles() names.
 * Four shapes, each per binary:
 *   - SECOND-VAR: a `WFC_<name>_GH`, `WFC_<name>_CLAUDE` or
 *     `WFC_<name>_CLAUDE_BIN` var, in any code file.
 *   - NODE-COPY: a non-test Node program spawning a literal `"gh"` or
 *     `"claude"`, or one other than the primitive reading its var off
 *     `process.env`.
 *   - SHELL-BARE: a shell line running the binary as a command — at a line's
 *     start, after `$(`, an unescaped backtick, `;`, `&`, `|`, `!`, a keyword,
 *     `command` or `timeout <n>` — or probing it with `command -v`, `type -P`
 *     or `which`.
 *   - PATH-STUB: a test or test support (lib/test-kind.js), or any `.ts`,
 *     prepending to PATH a directory it joins the binary's name onto, or one
 *     a local helper joins a parameter onto where a call passes that helper
 *     the binary's name first.
 *
 * THE OPT-OUT is a `gh-route-exempt: <why>` or `claude-route-exempt: <why>`
 * comment on the line or the line above, for a shell line naming the binary
 * only as text, such as a message telling an agent what to run, a wrapper in
 * the user's own shell, or a test of what a bare name on PATH resolves to. A
 * marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a path under scripts/, .claude/skills/, .husky/ or hooks/, refuses any second `gh` or `claude` route in the tree, naming the file, line, the binary's primitive and its exemplar.
 * JUSTIFIED: fail-safe — a `gh` call off WFC_GH escapes every test's stub and reaches the founder's live tracker, and a `claude` call off WFC_CLAUDE_BIN reads or launches his live sessions.
 * DEFEAT:    the `<binary>-route-exempt: <why>` marker; --warn caps findings below the gating line; a binary named through a variable; a PATH stub whose directory is spelt differently where it is joined and where it is prepended, or written by a helper taking the name after its first parameter or into a directory a call passes it, built with `/<binary>` in a string, or prepended by `join` or `+`; a shell call after a word this list does not name; a command-string spawn such as `execSync("gh …")`; a test's own literal spawn; Python, which reaches each binary through lib/wfc_bin.py.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { readWorktreeHead, shellFiles } = require("./lib/formatters.js");
const { blankComments } = require("./lib/strip-comments.js");
const { isTestKind } = require("./lib/test-kind.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const ROOTS = ["scripts", ".claude/skills", ".husky", "hooks"];

/**
 * @typedef {"SECOND-VAR" | "NODE-COPY" | "SHELL-BARE" | "PATH-STUB"} Shape
 * @typedef {{
 *   bin: string,
 *   envVar: string,
 *   primitive: string,
 *   fix: Record<Shape, string>,
 *   secondVar: RegExp,
 *   exempt: RegExp,
 *   envRead: RegExp,
 *   literalSpawn: RegExp,
 *   shellRun: RegExp,
 *   shellProbe: RegExp,
 *   joinBin: RegExp,
 * }} Route
 */

/**
 * `calls` names what a Node program calls from the
 * primitive, `stubWith` how a test stubs the binary, and the exemplars a
 * Node, shell and test file on the route.
 * @param {{
 *   bin: string,
 *   envVar: string,
 *   primitive: string,
 *   secondVar: RegExp,
 *   calls: string,
 *   stubWith: string,
 *   exemplar: string,
 *   shellExemplar: string,
 *   stubExemplar: string,
 * }} spec
 * @returns {Route}
 */
function route({
	bin,
	envVar,
	primitive,
	secondVar,
	calls,
	stubWith,
	exemplar,
	shellExemplar,
	stubExemplar,
}) {
	return {
		bin,
		envVar,
		primitive,
		fix: {
			"SECOND-VAR": `name the binary through ${envVar}, the one var ${primitive} reads, as ${exemplar} and ${shellExemplar} do.`,
			"NODE-COPY": `call ${calls} from ${primitive}, as ${exemplar} does.`,
			"SHELL-BARE": `run "\${${envVar}:-${bin}}", the var ${primitive} reads, as ${shellExemplar} does; or mark it \`${bin}-route-exempt: <why>\` where \`${bin}\` is only text.`,
			"PATH-STUB": `point ${envVar} at the stub${stubWith}, as ${stubExemplar} does.`,
		},
		secondVar,
		exempt: new RegExp(`${bin}-route-exempt:\\s*\\w`),
		envRead: new RegExp(`\\bprocess\\.env\\.${envVar}\\b(?!\\s*=[^=])`),
		literalSpawn: new RegExp(
			`\\b(?:execFileSync|execFile|spawnSync|spawn)\\s*\\(\\s*(["'\`])${bin}\\1`,
		),
		shellRun: new RegExp(
			`(?:^|\\$\\(|(?<!\\\\)\`|[;&|!]|\\b(?:then|do|else|elif|if|while|until|exec|time|command|timeout\\s+\\S+))\\s*${bin}\\s`,
		),
		shellProbe: new RegExp(
			`\\b(?:command\\s+-v|type\\s+-P|which)\\s+${bin}\\b`,
		),
		joinBin: new RegExp(
			`path\\.join\\(\\s*([^()]*?)\\s*,\\s*(["'\`])${bin}\\2\\s*\\)`,
			"g",
		),
	};
}

const ROUTES = [
	route({
		bin: "gh",
		envVar: "WFC_GH",
		primitive: "scripts/lib/gh.js",
		secondVar: /\bWFC_\w+_GH\b/,
		calls: "`gh`, `ghJson` or their kin",
		stubWith:
			", with `stubGhScript` or `stubGhRoutes` from scripts/lib/gh-stub.ts",
		exemplar: "scripts/check-issue-orphans.js",
		shellExemplar: "scripts/link-sub-issue.sh",
		stubExemplar: "scripts/check-issue-orphans.test.ts",
	}),
	route({
		bin: "claude",
		envVar: "WFC_CLAUDE_BIN",
		primitive: "scripts/lib/claude-bin.js",
		secondVar: /\bWFC_\w+_CLAUDE(?:_BIN)?\b/,
		calls: "`claudeBin()`",
		stubWith: "",
		exemplar: "scripts/run-mod-tests.js",
		shellExemplar: "scripts/dispatch-sessions.sh",
		stubExemplar: "scripts/run-mod-tests.test.ts",
	}),
];

// A local helper's header: its name, then its parameter list (#3638).
const HELPER =
	/(?:\bfunction\s+(\w+)|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?)\s*(?:<[^<>]*>\s*)?\(((?:[^()]|\([^()]*\))*)\)/g;

/**
 * `text` split at its commas outside brackets.
 * @param {string} text
 */
function topLevel(text) {
	/** @type {string[]} */
	const parts = [""];
	let depth = 0;
	for (const ch of text) {
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		if (ch === "," && depth === 0) parts.push("");
		else parts[parts.length - 1] += ch;
	}
	return parts;
}

/**
 * Where the helper body opening at `from` ends: its block's closing brace, or
 * the `;`, `,` or closing bracket ending an expression body.
 * @param {string} code
 * @param {number} from
 */
function bodyEnd(code, from) {
	let depth = 0;
	for (let i = from; i < code.length; i++) {
		const ch = code[i] ?? "";
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) {
			depth--;
			if (depth < 0 || (depth === 0 && ch === "}")) return i;
		} else if (depth === 0 && (ch === ";" || ch === ",")) return i;
	}
	return code.length;
}

/**
 * The directories local helpers join their first parameter onto, a directory
 * that is itself a parameter read off its default, for each helper a call
 * passes `bin` first.
 * @param {string} bin
 * @param {string} code
 * @returns {string[]}
 */
function helperDirs(bin, code) {
	return [...code.matchAll(HELPER)].flatMap((h) => {
		const name = h[1] ?? h[2] ?? "";
		const params = topLevel(h[3] ?? "").map((p) => {
			const at = p.indexOf("=");
			const id = at < 0 ? p : p.slice(0, at);
			return {
				id: id.replace(/[?]?:.*$/s, "").trim(),
				fallback: at < 0 ? "" : p.slice(at + 1).trim(),
			};
		});
		const first = params[0]?.id ?? "";
		if (!/^[$\w]+$/.test(first)) return [];
		const called = new RegExp(`\\b${name}\\s*\\(\\s*(["'\`])${bin}\\1`);
		if (!called.test(code)) return [];
		const start = (h.index ?? 0) + h[0].length;
		const body = code.slice(start, bodyEnd(code, start));
		const join = new RegExp(
			`path\\.join\\(\\s*([^()]*?)\\s*,\\s*${first.replace(/\$/g, "\\$")}\\s*\\)`,
			"g",
		);
		return [...body.matchAll(join)].map((m) => {
			const dir = m[1] ?? "";
			return params.find((p) => p.id === dir)?.fallback || dir;
		});
	});
}

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
 * `binDirs` holds the directories a test joins the route's binary onto,
 * itself or through a helper.
 * @param {{ r: Route, rel: string, kind: "node" | "test" | "shell", binDirs: Set<string> }} at
 * @param {string} line
 * @returns {Shape | null}
 */
function shapeOf({ r, rel, kind, binDirs }, line) {
	if (r.secondVar.test(line)) return "SECOND-VAR";
	if (kind === "node") {
		const copies =
			r.literalSpawn.test(line) ||
			(rel !== r.primitive && r.envRead.test(line));
		return copies ? "NODE-COPY" : null;
	}
	if (kind === "shell")
		return r.shellRun.test(line) || r.shellProbe.test(line)
			? "SHELL-BARE"
			: null;
	for (const m of line.matchAll(PATH_PREPEND))
		if (binDirs.has(normal(m[1] ?? ""))) return "PATH-STUB";
	return null;
}

const MARKABLE = new Set(["SHELL-BARE", "PATH-STUB"]);

/** @typedef {{ r: Route, shape: Shape, line: number, text: string }} Found */

/**
 * One route's findings, `code` being `raw` with its comments blanked.
 * @param {Route} r
 * @param {string} rel
 * @param {"node" | "test" | "shell"} kind
 * @param {{ raw: string[], code: string[] }} lines
 * @returns {Found[]}
 */
function routeFindings(r, rel, kind, { raw, code }) {
	/** @type {Set<string>} */
	const binDirs = new Set();
	if (kind === "test") {
		const text = code.join("\n");
		for (const m of text.matchAll(r.joinBin)) binDirs.add(normal(m[1] ?? ""));
		for (const dir of helperDirs(r.bin, text)) binDirs.add(normal(dir));
	}
	const at = { r, rel, kind, binDirs };
	/** @type {Found[]} */
	const found = [];
	for (const [i, line] of code.entries()) {
		const shape = shapeOf(at, line);
		if (!shape) continue;
		const marked = raw
			.slice(Math.max(0, i - 1), i + 1)
			.some((l) => r.exempt.test(l));
		if (marked && MARKABLE.has(shape)) continue;
		found.push({
			r,
			shape,
			line: i + 1,
			text: line.trim().replace(/\s+/g, " "),
		});
	}
	return found;
}

/**
 * @param {string} rel
 * @param {"node" | "test" | "shell"} kind
 * @param {string} source
 * @returns {Found[]}
 */
function findingsIn(rel, kind, source) {
	const raw = source.split("\n");
	const code =
		kind === "shell"
			? raw.map((l) => (/^\s*#/.test(l) ? "" : l))
			: blankComments(source).split("\n");
	return ROUTES.flatMap((r) => routeFindings(r, rel, kind, { raw, code })).sort(
		(a, b) => a.line - b.line,
	);
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
		/** @type {Map<string, string>} */
		const fixes = new Map();
		for (const rel of files) {
			const kind = kindOf(rel, shell);
			if (!kind) continue;
			scanned++;
			const source = fs.readFileSync(path.join(root, rel), "utf8");
			/** @type {Map<string, number>} */
			const seen = new Map();
			for (const { r, shape, line, text } of findingsIn(rel, kind, source)) {
				const n = (seen.get(text) ?? 0) + 1;
				seen.set(text, n);
				fixes.set(`${r.bin} ${shape}`, r.fix[shape]);
				ctx.fail(
					shape,
					`${rel}:${line} reaches \`${r.bin}\` off its one route (${shape}). Fix: ${r.fix[shape]}`,
					{ file: rel, line, match: `${text} #${n}`, bin: r.bin },
				);
			}
		}
		if (ctx.findings.length > 0)
			ctx.say(
				`  ${ctx.findings.length} second binary route(s): ${ctx.findings.map((f) => `${f.file}:${f.line}`).join(", ")}.\n${[
					...fixes,
				]
					.map(([what, fix]) => `  ${what} Fix: ${fix}`)
					.join("\n")}`,
			);
		return {
			okLine: `${scanned} file(s), every \`gh\` call on WFC_GH and every \`claude\` call on WFC_CLAUDE_BIN.`,
			noun: "second binary route(s)",
			count: ctx.findings.length,
			data: { scanned },
		};
	},
});
