/*
 * gh-route.js — check-gh-route.js's core (workflow-core#3455, workflow-core#3559, workflow-core#4123): the shapes
 * that reach `gh` or `claude` off the binary's one route, judged line by line
 * over one file's text. check-gh-route.js's header holds the contract: the
 * four shapes, the opt-out marker and what defeats them.
 *
 * A CORE (base §T7): it performs no I/O; judgeTree reads through its
 * injected `read(rel)` port. The shell lists the tree and names its shell
 * files.
 */

const { blankComments } = require("./strip-comments.js");
const { requiredGroup } = require("./regex-group.js");
const { cutAt } = require("./cut-at.js");
const { isTestKind } = require("./test-kind.js");

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
 * `calls` names what a Node program calls from the primitive, and the
 * exemplars a Node and a shell file on the route, as the base primitives row
 * names them: each a file the release ships.
 * @param {{
 *   bin: string,
 *   envVar: string,
 *   primitive: string,
 *   secondVar: RegExp,
 *   calls: string,
 *   exemplar: string,
 *   shellExemplar: string,
 * }} spec
 * @returns {Route}
 */
function buildRoute({
	bin,
	envVar,
	primitive,
	secondVar,
	calls,
	exemplar,
	shellExemplar,
}) {
	return {
		bin,
		envVar,
		primitive,
		fix: {
			"SECOND-VAR": `name the binary through ${envVar}, the one var ${primitive} reads, as ${exemplar} and ${shellExemplar} do.`,
			"NODE-COPY": `call ${calls} from ${primitive}, as ${exemplar} does.`,
			"SHELL-BARE": `run "\${${envVar}:-${bin}}", the var ${primitive} reads, as ${shellExemplar} does; or mark it \`${bin}-route-exempt: <why>\` where \`${bin}\` is only text.`,
			"PATH-STUB": `point ${envVar} at the stub executable, never PATH.`,
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
	buildRoute({
		bin: "gh",
		envVar: "WFC_GH",
		primitive: "scripts/lib/gh.js",
		secondVar: /\bWFC_\w+_GH\b/,
		calls: "`gh`, `ghJson` or their kin",
		exemplar: "scripts/check-issue-orphans.js",
		shellExemplar: "scripts/link-sub-issue.sh",
	}),
	buildRoute({
		bin: "claude",
		envVar: "WFC_CLAUDE_BIN",
		primitive: "scripts/lib/claude-bin.js",
		secondVar: /\bWFC_\w+_CLAUDE(?:_BIN)?\b/,
		calls: "`claudeBin()`",
		exemplar: "scripts/run-mod-tests.js",
		shellExemplar: "scripts/dispatch-sessions.sh",
	}),
];

// A local helper's header: its name, then its parameter list (workflow-core#3638).
const HELPER =
	/(?:\bfunction\s+(\w+)\s*|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?)(?:<[^<>]*>\s*)?\(((?:[^()]|\([^()]*\))*)\)/g;

/**
 * `text` split at its commas outside brackets.
 * @param {string} text
 */
function splitTopLevel(text) {
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
function findBodyEnd(code, from) {
	let depth = 0;
	for (let i = from; i < code.length; i++) {
		const ch = code.charAt(i);
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) {
			depth--;
			if (depth < 0 || (depth === 0 && ch === "}")) return i;
		} else if (depth === 0 && (ch === ";" || ch === ",")) return i;
	}
	return code.length;
}

/**
 * A parameter's name, its type annotation and optional mark cut: `dir?: string`
 * and `dir: string` both give `dir`.
 * @param {string} param
 * @returns {string}
 */
function paramName(param) {
	if (!param.includes(":")) return param;
	const [head] = cutAt(param, ":");
	return head.endsWith("?") ? head.slice(0, -1) : head;
}

/**
 * The directories local helpers join their first parameter onto, a directory
 * that is itself a parameter read off its default, for each helper a call
 * passes `bin` first.
 * @param {string} bin
 * @param {string} code
 * @returns {string[]}
 */
function parseHelperDirs(bin, code) {
	return [...code.matchAll(HELPER)].flatMap((h) => {
		const name = h[1] ?? h[2];
		if (name === undefined)
			throw new Error(`HELPER matched no name in ${JSON.stringify(h[0])}`);
		const params = splitTopLevel(requiredGroup(h, 3, HELPER)).map((p) => {
			const at = p.indexOf("=");
			const id = at < 0 ? p : p.slice(0, at);
			return {
				id: paramName(id).trim(),
				fallback: at < 0 ? "" : p.slice(at + 1).trim(),
			};
		});
		const first = params[0]?.id ?? "";
		if (!/^[$\w]+$/.test(first)) return [];
		const called = new RegExp(`\\b${name}\\s*\\(\\s*(["'\`])${bin}\\1`);
		if (!called.test(code)) return [];
		const start = (h.index ?? 0) + h[0].length;
		const body = code.slice(start, findBodyEnd(code, start));
		const join = new RegExp(
			`path\\.join\\(\\s*([^()]*?)\\s*,\\s*${first.replace(/\$/g, "\\$")}\\s*\\)`,
			"g",
		);
		return [...body.matchAll(join)].map((m) => {
			const dir = requiredGroup(m, 1, join);
			return params.find((p) => p.id === dir)?.fallback || dir;
		});
	});
}

const PATH_PREPEND =
	/`\$\{([^}]+)\}(?:\$\{path\.delimiter\}|:)\$\{process\.env\.PATH\b/g;

const TS_FILE = /\.[cm]?tsx?$/;

/** @param {string} expr */
const normaliseDirExpr = (expr) =>
	expr.replace(/^path\.join\((.*)\)$/s, "$1").replace(/\s+/g, "");

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
 * `binDirs` holds the directories a file PATH-STUB reads joins the route's
 * binary onto, itself or through a helper, and is empty for any other file.
 * @param {{ r: Route, rel: string, kind: "node" | "test" | "shell", binDirs: Set<string> }} at
 * @param {string} line
 * @returns {Shape | null}
 */
function shapeOf({ r, rel, kind, binDirs }, line) {
	if (r.secondVar.test(line)) return "SECOND-VAR";
	if (kind === "shell")
		return r.shellRun.test(line) || r.shellProbe.test(line)
			? "SHELL-BARE"
			: null;
	if (
		kind === "node" &&
		(r.literalSpawn.test(line) || (rel !== r.primitive && r.envRead.test(line)))
	)
		return "NODE-COPY";
	for (const m of line.matchAll(PATH_PREPEND))
		if (binDirs.has(normaliseDirExpr(requiredGroup(m, 1, PATH_PREPEND))))
			return "PATH-STUB";
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
	if (kind === "test" || TS_FILE.test(rel)) {
		const text = code.join("\n");
		for (const m of text.matchAll(r.joinBin))
			binDirs.add(normaliseDirExpr(requiredGroup(m, 1, r.joinBin)));
		for (const dir of parseHelperDirs(r.bin, text))
			binDirs.add(normaliseDirExpr(dir));
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
 * Each finding in one file, its occurrence among identical lines counted for
 * its identity, with the fix its shape takes.
 * @param {string} rel
 * @param {"node" | "test" | "shell"} kind
 * @param {string} source
 * @returns {{ tag: Shape, message: string, line: number, match: string,
 *   bin: string, fixLine: string }[]}
 */
function judgeFile(rel, kind, source) {
	/** @type {Map<string, number>} */
	const seen = new Map();
	return findingsIn(rel, kind, source).map(({ r, shape, line, text }) => {
		const n = (seen.get(text) ?? 0) + 1;
		seen.set(text, n);
		return {
			tag: shape,
			message: `${rel}:${line} reaches \`${r.bin}\` off its one route (${shape}). Fix: ${r.fix[shape]}`,
			line,
			match: `${text} #${n}`,
			bin: r.bin,
			fixLine: `${r.bin} ${shape} Fix: ${r.fix[shape]}`,
		};
	});
}

/**
 * Every finding in `files`, each read through `read` only where its kind is
 * judged, with how many were scanned and each distinct fix line.
 * @param {string[]} files
 * @param {Set<string>} shell
 * @param {(rel: string) => string} read
 */
function judgeTree(files, shell, read) {
	let scanned = 0;
	/** @type {(ReturnType<typeof judgeFile>[number] & { file: string })[]} */
	const findings = [];
	for (const rel of files) {
		const kind = kindOf(rel, shell);
		if (!kind) continue;
		scanned++;
		for (const f of judgeFile(rel, kind, read(rel)))
			findings.push({ ...f, file: rel });
	}
	return {
		scanned,
		findings,
		fixes: [...new Set(findings.map((f) => f.fixLine))],
	};
}

module.exports = { judgeFile, judgeTree, kindOf };
