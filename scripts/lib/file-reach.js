const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isBuiltin } = require("node:module");
const {
	HASH_COMMENT_LINE,
	JS_COMMENT_LINE,
} = require("./qualify-citations.js");
const {
	CALLER_BODY,
	LOADS_BODY,
	pragmaLine,
} = require("./code-edges-pragmas.js");
const { readText } = require("./file-read.js");
const { closeOf, inertSpans, topLevelArgs } = require("./js-lex.js");
const { escapeRe, requiredGroup } = require("./regex-group.js");
const {
	SH_ASSIGN,
	SH_RESERVED,
	braceEnd,
	shCommands,
	substitutionAt,
} = require("./shell-script-lexer.js");
/**
 * @param {string} file
 * @returns {"js"|"jsx"|"sh"|"python"|null}
 */
function languageOf(file) {
	if (/\.[cm]?[jt]s$/.test(file)) return "js";
	if (/\.[cm]?[jt]sx$/.test(file)) return "jsx";
	if (file.endsWith(".sh")) return "sh";
	if (file.endsWith(".py")) return "python";
	return null;
}
/**
 * @typedef {"node"|"python"|"other"|"shell"} InterpreterKind
 * @typedef {{name: string, test: RegExp, kind: InterpreterKind,
 *   language: "js"|"python"|"sh"|null}} InterpreterRow
 */

/** @type {InterpreterRow[]} */
const INTERPRETERS = [
	["node(?:js)?", "node", "js"],
	[String.raw`python(?:3(?:\.\d+)?)?`, "python", "python"],
	["perl|ruby", "other", null],
	["bash|sh|dash|zsh|ksh", "shell", "sh"],
].map(([name, kind, language]) => ({
	name: String(name),
	test: new RegExp(`^(?:${name})$`),
	kind: /** @type {InterpreterKind} */ (kind),
	language: /** @type {InterpreterRow["language"]} */ (language),
}));

/**
 * @param {string} name
 */
const interpreterNamed = (name) => INTERPRETERS.find((i) => i.test.test(name));

/**
 * @param {string} text
 * @returns {InterpreterRow|undefined}
 */
function parseShebang(text) {
	if (!text.startsWith("#!")) return;
	const words = text.slice(2, text.indexOf("\n") + 1 || undefined).split(/\s+/);
	const program = words.filter(Boolean).map((w) => path.basename(w));
	const name =
		program[0] === "env"
			? program.slice(1).find((w) => !w.startsWith("-"))
			: program[0];
	return name === undefined ? undefined : interpreterNamed(name);
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {"js"|"jsx"|"sh"|"python"|null}
 */
function scriptLanguage(file, text) {
	const named = languageOf(file);
	if (named !== null || !isExtensionless(file)) return named;
	return parseShebang(text)?.language ?? null;
}

/**
 * @param {string} file
 */
const isCodeFile = (file) => languageOf(file) !== null;

/**
 * @param {string} file
 */
const isExtensionless = (file) => !path.basename(file).includes(".");

/**
 * @param {string} file
 */
const isExecutedScript = (file) => isExtensionless(file);

/**
 * @param {string} file
 */
const isScript = (file) =>
	isCodeFile(file) || (isExtensionless(file) && isFile(file));
const JS_SPEC =
	/\brequire(?:\.resolve)?\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;
const CREATE_REQUIRE_SPEC =
	/\bcreateRequire\([^()]*(?:\([^()]*\)[^()]*)?\)\(\s*["'](\.[^"']*)["']\s*(?:,\s*)?\)/g;

/**
 * @param {RegExpMatchArray} m
 * @returns {string}
 */
function jsSpecifier(m) {
	const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
	if (spec === undefined)
		throw new Error(`no specifier group took part in ${JSON.stringify(m[0])}`);
	return spec;
}

const PATH_JOIN = /\b[A-Za-z_$][\w$]*\.(join|resolve)\(/g;
const PATH_JOIN_HEAD = /^[A-Za-z_$][\w$]*\.(join|resolve)\(/;
const LOAD_CALL = /(?:(?<![\w$.])|(?<=\.\.\.))(?:require|import)\s*\(/g;
const LOAD_LITERAL = /^(["'])[^"'\\]*\1$/;
const LOAD_CONST_VALUE = /^(?:["'][^"'\\]*["']|process\.env\.\w+)$/;
const LOADS_PRAGMA = pragmaLine(String.raw`\/\/|\/?\*`, LOADS_BODY);
const SH_LOADS_PRAGMA = pragmaLine("#", LOADS_BODY);
const PY_IMPORT =
	/^\s*(?:from\s+([\w.]+)\s+import\s+\(?([\w., ]*)|import\s+([\w., ]+))/;
const PY_LOAD =
	/\bimport\b|\b(?:__import__|import_module|spec_from_file_location|spec_from_loader|exec_module|load_module|SourceFileLoader|run_path|run_module|exec|execfile)\s*\(/;
const ONE_LINE_STRING = String.raw`"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'`;
const PY_LEXEME = new RegExp(
	String.raw`("""|''')[\s\S]*?\1|${ONE_LINE_STRING}|#[^\n]*`,
	"g",
);
const PY_STRING = new RegExp(ONE_LINE_STRING, "g");
const PY_COMPOUND =
	/^\s*(?:(?:try|else|finally)\s*|(?:if|elif|while|for|with|except|def|class|match|case|async\s+(?:def|for|with))\b[^:]*):(?=\s*\S)/;
const SYS_PATH_EDIT =
	/\bsys\.path\s*(?:\.\s*(?:insert|append|extend|pop|remove|clear)\b|\[[^\]]*\]\s*=|\+=|=(?!=))|\bdel\s+sys\.path\b/;
const SYS_PATH_ADD =
	/^\s*sys\.path\.(?:insert\(\s*0\s*,(.+)\)|append\((.+)\))\s*$/;
const PY_ASSIGN = /^\s*([A-Za-z_]\w*)\s*=(?!=)(.+)$/;
const PY_PATH_TOKEN = /(?:(\.?[A-Za-z_][\w.]*)|("[^"\\]*"|'[^'\\]*')|([(),/]))/;
const PY_PATH_CALLS = new Set([
	"str",
	"Path",
	"os.path.abspath",
	"os.path.dirname",
	"os.path.join",
]);

/**
 * @param {string} text
 * @param {RegExp} comment
 */
const parseCodeLines = (text, comment) =>
	text.split("\n").filter((line) => !comment.test(line));

/**
 * @param {string} abs
 */
const candidatesOf = (abs) => [
	abs,
	`${abs}.js`,
	`${abs}.json`,
	`${abs}.ts`,
	...(abs.endsWith(".js") ? [`${abs.slice(0, -3)}.ts`] : []),
	path.join(abs, "index.js"),
];

/** @param {string} c */
const isFile = (c) =>
	fs.statSync(c, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * @param {string} abs
 * @returns {{target: string, tried: string[]}}
 */
function resolutionOf(abs) {
	const candidates = candidatesOf(abs);
	for (const [i, candidate] of candidates.entries())
		if (isFile(candidate))
			return { target: candidate, tried: candidates.slice(0, i) };
	return { target: abs, tried: [] };
}

/**
 * @typedef {{version: string, builtins: Set<string>, stdlib: Set<string>}} Python
 */

const PYTHON_ANSWER = /^(\S+)\n(.*)\n(.*)\n$/;
/** @type {Python | null} */
let python = null;
/**
 * @returns {Python}
 */
function readPython() {
	if (python) return python;
	const r = spawnSync(
		"python3",
		[
			"-c",
			"import sys; print('.'.join(map(str, sys.version_info))); print(' '.join(sys.builtin_module_names)); print(' '.join(sys.stdlib_module_names))",
		],
		{ encoding: "utf8" },
	);
	const answer = r.status === 0 ? r.stdout.match(PYTHON_ANSWER) : null;
	if (!answer)
		throw new Error(
			`python3 cannot list its stdlib (${(r.stderr || String(r.error) || r.stdout).trim().split("\n")[0]})`,
		);
	const names = (/** @type {number} */ g) =>
		new Set(requiredGroup(answer, g, PYTHON_ANSWER).split(" "));
	python = {
		version: requiredGroup(answer, 1, PYTHON_ANSWER),
		builtins: names(2),
		stdlib: names(3),
	};
	return python;
}

const pythonVersion = () => readPython().version;

/**
 * @typedef {{edges: string[], shadows: string[]}} Found
 * @typedef {{edges: string[], shadows: string[], reads: string[],
 *   unread: string[], unknown: string[], python: boolean}} Reach
 * @typedef {Reach & {pySearch: PyEntry[] | null}} FileReach
 */

/**
 * @param {string} file
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @param {PyEntry[] | null} importerSearch
 * @returns {FileReach}
 */
function fileReach(file, text, fault, importerSearch) {
	const language = scriptLanguage(file, text);
	if (language === "sh") return shReach(file, text);
	if (language === "jsx")
		fault(`is ${path.extname(file)} code, whose loads the walk cannot read`);
	if (language !== "js" && language !== "python")
		return {
			edges: [],
			shadows: [],
			reads: [],
			unread: [],
			unknown: [],
			python: false,
			pySearch: null,
		};
	const code = parseCodeLines(
		text,
		language === "js" ? JS_COMMENT_LINE : HASH_COMMENT_LINE,
	).join("\n");
	const inline = inlineSpawns(file, code);
	const own =
		language === "python"
			? {
					...pyReach(file, text, fault, importerSearch),
					reads: [],
					unread: [],
					unknown: [],
				}
			: { ...jsReach(file, text, code), pySearch: null };
	return {
		...own,
		edges: [...own.edges, ...inline.edges],
		unread: [...own.unread, ...inline.unread],
		python: inline.python,
	};
}

/**
 * @param {string} dir
 * @param {string} code
 * @returns {string[]}
 */
function relativeSpecifiers(dir, code) {
	/** @type {string[]} */
	const joined = [];
	for (const m of code.matchAll(JS_SPEC)) {
		const spec = jsSpecifier(m);
		if (spec.startsWith(".")) joined.push(path.join(dir, spec));
	}
	for (const m of code.matchAll(CREATE_REQUIRE_SPEC))
		joined.push(path.join(dir, requiredGroup(m, 1, CREATE_REQUIRE_SPEC)));
	return joined;
}

/**
 * @param {string} file
 * @param {string} text
 * @param {string} code
 * @returns {Found & {reads: string[], unread: string[], unknown: string[]}}
 */
function jsReach(file, text, code) {
	const resolved = relativeSpecifiers(path.dirname(file), code).map(
		resolutionOf,
	);
	const edges = resolved.map((r) => r.target);
	/** @type {string[]} */
	const reads = [];
	/** @type {string[]} */
	const unknown = [];
	const spans = inertSpans(code);
	for (const m of code.matchAll(PATH_JOIN)) {
		const at = m.index ?? 0;
		const close = closeOf(code, at + m[0].length - 1);
		if (close === -1 || isProse(code, spans, at)) continue;
		const join = code.slice(at, close);
		const target = joinedPath(file, code, join);
		if (target === null) {
			const base = parseJoin(join)?.args[0];
			if (base !== undefined && joinedPath(file, code, base) !== null)
				unknown.push(`joins ${join.replace(/\s+/g, " ")} off its directory`);
		} else if (isCodeFile(target)) edges.push(target);
		else if (isFile(target)) reads.push(target);
	}
	const declared = declaredLoads(file, text);
	edges.push(...declared.edges);
	reads.push(...declared.reads);
	const unread = [
		...declared.unread,
		...unreadLoads(file, code)
			.filter((l) => !declared.keys.some((k) => isKeyRead(l.arg, k)))
			.map((l) => l.said),
	];
	return {
		edges,
		shadows: resolved.flatMap((r) => r.tried),
		reads,
		unread,
		unknown,
	};
}

/**
 * @param {string} file
 * @param {string} code
 * @returns {{arg: string, said: string}[]}
 */
function unreadLoads(file, code) {
	const spans = inertSpans(code);
	/** @type {{arg: string, said: string}[]} */
	const unread = [];
	for (const m of code.matchAll(LOAD_CALL)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = closeOf(code, open);
		if (close === -1 || isProse(code, spans, m.index ?? 0)) continue;
		const arg = code.slice(open + 1, close - 1).trim();
		if (LOAD_LITERAL.test(arg) || isReadConst(file, code, arg)) continue;
		unread.push({
			arg: constOrSelf(code, arg),
			said: `loads ${code.slice(m.index, close).replace(/\s+/g, " ")}`,
		});
	}
	return unread;
}

/**
 * @param {string} code
 * @param {[number, number][]} spans
 * @param {number} i
 */
function isProse(code, spans, i) {
	const span = spans.find(([first, last]) => i >= first && i <= last);
	if (span === undefined) return false;
	if (code[span[0]] !== "`") return true;
	let depth = 0;
	for (let k = span[0] + 1; k < i; k++) {
		const c = code[k];
		if (depth === 0 && c === "\\") k++;
		else if (depth === 0 && code.startsWith("${", k)) {
			depth = 1;
			k++;
		} else if (depth > 0 && c === "{") depth++;
		else if (depth > 0 && c === "}") depth--;
	}
	return depth === 0;
}

/**
 * @param {string} arg
 * @param {string} key
 */
const isKeyRead = (arg, key) =>
	new RegExp(String.raw`\.${escapeRe(key)}(?![\w$])`).test(arg);

/**
 * @param {string} file
 * @param {string} code
 * @param {string} name
 */
function isReadConst(file, code, name) {
	const values = constValues(code, name);
	return (
		values.length > 0 &&
		values.every(
			(v) => LOAD_CONST_VALUE.test(v) || joinedPath(file, code, v) !== null,
		)
	);
}

/**
 * @param {string} code
 * @param {string} name
 * @returns {string[]}
 */
function constValues(code, name) {
	if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
	const bound = new RegExp(
		String.raw`\bconst\s+${escapeRe(name)}\s*=\s*([^;\n]+?)\s*;?\s*$`,
		"gm",
	);
	return [...code.matchAll(bound)].map((m) => requiredGroup(m, 1, bound));
}

/**
 * @param {string} code
 * @param {string} expr
 */
function constOrSelf(code, expr) {
	const values = new Set(constValues(code, expr));
	const [only] = values;
	return values.size === 1 && only !== undefined ? only : expr;
}

/**
 * @param {string} expr
 * @returns {{method: string, args: string[]} | null}
 */
function parseJoin(expr) {
	const m = expr.match(PATH_JOIN_HEAD);
	if (!m) return null;
	const open = m[0].length - 1;
	if (closeOf(expr, open) !== expr.length) return null;
	const args = topLevelArgs(expr.slice(open + 1, -1))
		.map((a) => a.trim())
		.filter((a) => a !== "");
	return { method: requiredGroup(m, 1, PATH_JOIN_HEAD), args };
}

/**
 * @param {string} file
 * @param {string} code
 * @param {string} expr
 * @param {Set<string>} [through]
 * @returns {string | null}
 */
function joinedPath(file, code, expr, through = new Set()) {
	const value = constOrSelf(code, expr);
	if (value === "__dirname") return path.dirname(file);
	const join = parseJoin(value);
	const [base, ...rest] = join?.args ?? [];
	if (!join || base === undefined || base === expr || through.has(base))
		return null;
	const from = joinedPath(file, code, base, new Set([...through, expr]));
	if (from === null) return null;
	const parts = rest.map((p) => constOrSelf(code, p));
	if (!parts.every((p) => LOAD_LITERAL.test(p))) return null;
	const literals = parts.map((p) => p.slice(1, -1));
	return join.method === "resolve"
		? path.resolve(from, ...literals)
		: path.join(from, ...literals);
}

/**
 * @typedef {{keys: string[], edges: string[], reads: string[],
 *   unread: string[]}} Declared
 */

/**
 * @param {string} file
 * @param {string} text
 * @returns {Declared}
 */
function declaredLoads(file, text) {
	const dir = path.dirname(file);
	/** @type {Declared} */
	const out = { keys: [], edges: [], reads: [], unread: [] };
	const pragma =
		scriptLanguage(file, text) === "sh" ? SH_LOADS_PRAGMA : LOADS_PRAGMA;
	for (const m of text.matchAll(pragma)) {
		const said = `declares ${m[0].trim()}`;
		const named = path.join(dir, requiredGroup(m, 1, pragma));
		const key = m[2];
		if (key === undefined) {
			addKeyless(out, named, said);
			continue;
		}
		const values = readManifestValues(named, key);
		if (values === null) {
			out.unread.push(`${said}, which will not read`);
			continue;
		}
		out.keys.push(key);
		out.reads.push(named);
		for (const v of values) {
			const target = path.join(dir, v);
			if (isFile(target)) out.edges.push(target);
			else out.unread.push(`${said}, whose ${v} is no file`);
		}
	}
	return out;
}

/**
 * @param {Declared} out
 * @param {string} named
 * @param {string} said
 */
function addKeyless(out, named, said) {
	if (!isFile(named)) out.unread.push(`${said}, no file`);
	else if (isScript(named)) out.edges.push(named);
	else out.reads.push(named);
}

/**
 * @param {string} file
 * @param {string} key
 * @returns {string[] | null}
 */
function readManifestValues(file, key) {
	const read = readText(file);
	if (read.state !== "read") return null;
	let data;
	try {
		data = JSON.parse(read.data);
	} catch {
		return null;
	}
	/** @type {string[]} */
	const found = [];
	const visit = (/** @type {unknown} */ node) => {
		if (Array.isArray(node)) node.forEach(visit);
		else if (node !== null && typeof node === "object")
			for (const [k, v] of Object.entries(node)) {
				if (k === key && typeof v === "string") found.push(v);
				else visit(v);
			}
	};
	visit(data);
	return found;
}

/**
 * @typedef {{dir: string | null, maybe: boolean, tail: boolean}} PyEntry
 * @typedef {{own: PyEntry[], shared: PyEntry[], handed: boolean,
 *   names: Map<string, string>}} PyScope
 * @typedef {{file: string, dir: string, scope: PyScope, reach: Found,
 *   fault: (msg: string) => void}} PyWalk
 * @typedef {{text: string, indented: boolean}} PyStatement
 */

/**
 * @param {string} file
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @param {PyEntry[] | null} importerSearch
 * @returns {Found & {pySearch: PyEntry[]}}
 */
function pyReach(file, text, fault, importerSearch) {
	const walk = pyWalkOf(file, fault, importerSearch);
	/** @type {PyImportTarget[]} */
	const deferred = [];
	for (const statement of pyStatements(text, walk.fault)) {
		const imp = statement.text.match(PY_IMPORT);
		if (imp) {
			const targets = pyImportTargets(imp);
			for (const target of targets) placePyImport(walk, target);
			if (statement.indented) deferred.push(...targets);
		} else if (PY_LOAD.test(blankPyStrings(statement.text)))
			walk.fault(
				`imports through ${statement.text.trim()}, which the walk cannot parse`,
			);
		else if (SYS_PATH_EDIT.test(statement.text)) editSysPath(walk, statement);
		else bindPyName(walk, statement.text);
	}
	for (const target of deferred) placePyImport(walk, target);
	return pyWalkFound(walk);
}

/**
 * @param {PyWalk} walk
 * @returns {Found & {pySearch: PyEntry[]}}
 */
const pyWalkFound = (walk) => ({
	edges: [...new Set(walk.reach.edges)],
	shadows: [...new Set(walk.reach.shadows)],
	pySearch: settledPySearch(walk.scope.shared),
});

/**
 * @param {string} file
 * @param {(msg: string) => void} fault
 * @param {PyEntry[] | null} importerSearch
 * @returns {PyWalk}
 */
function pyWalkOf(file, fault, importerSearch) {
	const dir = path.dirname(file);
	/** @type {Set<string>} */
	const faulted = new Set();
	const first = { dir, maybe: false, tail: false };
	return {
		file,
		dir,
		scope: {
			own: [first],
			shared: [...(importerSearch ?? [first])],
			handed: importerSearch !== null,
			names: new Map(),
		},
		reach: { edges: [], shadows: [] },
		fault: (msg) => {
			if (!faulted.has(msg)) fault(msg);
			faulted.add(msg);
		},
	};
}

/**
 * @param {PyEntry[]} search
 * @returns {PyEntry[]}
 */
function settledPySearch(search) {
	const group = (/** @type {(e: PyEntry) => boolean} */ keep) => [
		...new Map(search.filter(keep).map((e) => [e.dir, e])).values(),
	];
	const byDir = (/** @type {PyEntry} */ a, /** @type {PyEntry} */ b) =>
		Number((a.dir ?? "") > (b.dir ?? "")) -
		Number((a.dir ?? "") < (b.dir ?? ""));
	const ordered = [
		...group((e) => e.maybe && !e.tail).sort(byDir),
		...group((e) => !e.maybe),
		...group((e) => e.maybe && e.tail).sort(byDir),
	];
	const unread = ordered.findIndex((e) => e.dir === null);
	return unread === -1 ? ordered : ordered.slice(0, unread + 1);
}

/**
 * @param {string} text
 */
const blankPyStrings = (text) =>
	text.replace(
		PY_STRING,
		(s) => `${s.charAt(0)}${" ".repeat(s.length - 2)}${s.charAt(0)}`,
	);

/**
 * @param {PyWalk} walk
 * @param {string} text
 */
function bindPyName(walk, text) {
	const assign = text.match(PY_ASSIGN);
	if (!assign) return;
	const name = requiredGroup(assign, 1, PY_ASSIGN);
	const value = evalPyPath(requiredGroup(assign, 2, PY_ASSIGN), walk);
	if (value === null) walk.scope.names.delete(name);
	else walk.scope.names.set(name, value);
}

/**
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {PyStatement[]}
 */
function pyStatements(text, fault) {
	/** @type {PyStatement[]} */
	const statements = [];
	let pending = "";
	let indented = false;
	let depth = 0;
	const flush = () => {
		let inBody = indented;
		for (const part of pending.split(";")) {
			const header = blankPyStrings(part).match(PY_COMPOUND);
			if (header) inBody = true;
			statements.push({
				text: header ? part.slice(header[0].length) : part,
				indented: inBody,
			});
		}
		pending = "";
	};
	const code = text.replace(PY_LEXEME, cutPyLexeme);
	for (const line of code.split("\n")) {
		if (pending === "") indented = /^\s/.test(line);
		const blank = line.replace(PY_STRING, '""');
		depth +=
			(blank.match(/[([{]/g)?.length ?? 0) -
			(blank.match(/[)\]}]/g)?.length ?? 0);
		const continued = /\\\s*$/.test(line);
		pending += ` ${continued ? line.replace(/\\\s*$/, "") : line}`;
		if (depth > 0 || continued) continue;
		flush();
		depth = 0;
	}
	if (depth > 0)
		fault("ends inside an open bracket, so its last statement goes unread");
	if (pending) flush();
	return statements;
}

/**
 * @param {string} m
 */
function cutPyLexeme(m) {
	if (m.startsWith("#")) return "";
	return /^("""|''')/.test(m) ? '""' : m;
}

/**
 * @param {PyWalk} walk
 * @param {PyStatement} statement
 */
function editSysPath(walk, statement) {
	const m = statement.text.match(SYS_PATH_ADD);
	const dir = m
		? evalPyPath(m[1] ?? requiredGroup(m, 2, SYS_PATH_ADD), walk)
		: null;
	const tail = m?.[2] !== undefined;
	const entry = { dir, maybe: statement.indented, tail };
	const put = tail ? "push" : "unshift";
	walk.scope.own[put](entry);
	walk.scope.shared[put]({ ...entry, maybe: true });
}

/**
 * @param {string} expr
 * @param {PyWalk} walk
 * @returns {string | null}
 */
function evalPyPath(expr, walk) {
	/** @type {string[]} */
	const tokens = [];
	const tokenRe = new RegExp(PY_PATH_TOKEN.source, "g");
	if (expr.replace(tokenRe, "").trim() !== "") return null;
	for (const m of expr.matchAll(tokenRe))
		tokens.push(m[1] ?? m[2] ?? requiredGroup(m, 3, PY_PATH_TOKEN));
	try {
		const parser = new PyPathParser(tokens, walk);
		const v = parser.pathExpr();
		return parser.done() && path.isAbsolute(v) ? path.normalize(v) : null;
	} catch {
		return null;
	}
}

const pyJoin = (/** @type {string[]} */ parts) =>
	parts.reduce((a, b) => (path.isAbsolute(b) ? b : path.join(a, b)));

class PyPathParser {
	/**
	 * @param {string[]} tokens
	 * @param {PyWalk} walk
	 */
	constructor(tokens, walk) {
		this.tokens = tokens;
		this.i = 0;
		this.walk = walk;
	}

	done() {
		return this.i === this.tokens.length;
	}

	peek() {
		return this.tokens[this.i];
	}

	take() {
		const t = this.tokens[this.i++];
		if (t === undefined) throw new Error("ends early");
		return t;
	}

	/** @param {string} t */
	expect(t) {
		if (this.take() !== t) throw new Error(`wants ${t}`);
	}

	/** @returns {string} */
	pathExpr() {
		let v = this.term();
		while (this.peek() === "/") {
			this.take();
			v = pyJoin([v, this.term()]);
		}
		return v;
	}

	/** @returns {string} */
	term() {
		let v = this.primary();
		while (this.peek()?.startsWith("."))
			v = this.attrs(v, this.take().slice(1));
		return v;
	}

	/** @returns {string} */
	primary() {
		const t = this.take();
		if (/^["']/.test(t)) return t.slice(1, -1);
		if (t === "(") {
			const v = this.pathExpr();
			this.expect(")");
			return v;
		}
		if (this.peek() === "(" && PY_PATH_CALLS.has(t)) return this.call(t);
		const dot = t.indexOf(".");
		const base = dot === -1 ? t : t.slice(0, dot);
		const v =
			base === "__file__" ? this.walk.file : this.walk.scope.names.get(base);
		if (v === undefined) throw new Error(`unknown ${base}`);
		return dot === -1 ? v : this.attrs(v, t.slice(dot + 1));
	}

	/** @param {string} name */
	call(name) {
		this.expect("(");
		/** @type {string[]} */
		const args = [];
		while (this.peek() !== ")") {
			args.push(this.pathExpr());
			if (this.peek() === ",") this.take();
		}
		this.take();
		return pyPathCall(name, args);
	}

	/**
	 * @param {string} v
	 * @param {string} chain
	 */
	attrs(v, chain) {
		const parts = chain.split(".");
		for (const [k, part] of parts.entries()) {
			const resolve =
				k === parts.length - 1 && part === "resolve" && this.peek() === "(";
			if (part === "parent") v = path.dirname(v);
			else if (resolve) {
				this.take();
				this.expect(")");
			} else throw new Error(`.${part}`);
		}
		return v;
	}
}

/**
 * @param {string} name
 * @param {string[]} args
 * @returns {string}
 */
function pyPathCall(name, args) {
	const [first] = args;
	if (first === undefined) throw new Error(`${name}() without a path`);
	if (name === "os.path.join" || name === "Path") return pyJoin(args);
	if (args.length !== 1) throw new Error(`${name} takes one path`);
	if (name === "os.path.dirname") return path.dirname(first);
	if (!path.isAbsolute(first)) throw new Error(`${name} of a relative path`);
	return first;
}

/**
 * @typedef {{dots: number, parts: string[], names: string[]}} PyImportTarget
 */

/**
 * @param {string} list
 * @returns {string[]}
 */
function pyNames(list) {
	return list
		.split(",")
		.map((n) => n.trim().replace(/\s.*/s, ""))
		.filter(Boolean);
}

/**
 * @param {RegExpMatchArray} m
 * @returns {PyImportTarget[]}
 */
function pyImportTargets(m) {
	const [, from, fromNames, bareNames] = m;
	if (from === undefined) {
		if (bareNames === undefined)
			throw new Error(`PY_IMPORT matched neither branch: ${m[0]}`);
		return pyNames(bareNames).map((mod) => ({
			dots: 0,
			parts: mod.split("."),
			names: [],
		}));
	}
	if (fromNames === undefined)
		throw new Error(`PY_IMPORT's from branch matched without names: ${m[0]}`);
	const rest = from.replace(/^\.+/, "");
	return [
		{
			dots: from.length - rest.length,
			parts: rest ? rest.split(".") : [],
			names: pyNames(fromNames.replace(/[()]/g, "")),
		},
	];
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {{found: string | null, tried: string[], namespace: string | null}}
 */
function pyModuleIn(dir, name) {
	const candidates = [
		path.join(dir, name, "__init__.py"),
		path.join(dir, `${name}.py`),
	];
	const at = candidates.findIndex(isFile);
	if (at !== -1)
		return {
			found: candidates[at] ?? null,
			tried: candidates.slice(0, at),
			namespace: null,
		};
	const namespace = path.join(dir, name);
	return {
		found: null,
		tried: candidates,
		namespace: isDir(namespace) ? namespace : null,
	};
}

/** @param {string} c */
const isDir = (c) =>
	fs.statSync(c, { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * @typedef {{dir: string, maybe: boolean}} PyDir
 * @typedef {{dirs: PyDir[], namespace: boolean}} PyPlace
 * @typedef {{kind: "placed", places: PyPlace[]} | {kind: "absent"}
 *   | {kind: "opaque", tail: boolean}} PyTopPlacement
 * @typedef {{name: string, isPart: boolean, at: PyPlace,
 *   namespace: boolean}} PyMiss
 */

/** @param {string} found */
const placeOf = (found) => ({
	dirs: found.endsWith("__init__.py")
		? [{ dir: path.dirname(found), maybe: false }]
		: [],
	namespace: false,
});

/**
 * @param {Found} reach
 * @param {PyDir[]} dirs
 * @param {string} name
 * @returns {{places: PyPlace[], settled: boolean}}
 */
function placePyPart(reach, dirs, name) {
	/** @type {PyPlace[]} */
	const places = [];
	/** @type {PyDir[]} */
	const namespaceDirs = [];
	let stands = false;
	for (const { dir, maybe } of dirs) {
		const here = pyModuleIn(dir, name);
		reach.shadows.push(...here.tried);
		if (!here.found) {
			namespaceDirs.push({ dir: path.join(dir, name), maybe });
			stands ||= here.namespace !== null;
			continue;
		}
		reach.edges.push(here.found);
		places.push(placeOf(here.found));
		if (!maybe) return { places, settled: true };
	}
	if (stands) places.push({ dirs: namespaceDirs, namespace: true });
	return { places, settled: false };
}

/**
 * @param {PyScope} scope
 */
const pySearches = ({ own, shared, handed }) =>
	handed ? [own, shared] : [own];

/**
 * @param {PyWalk} walk
 * @param {PyImportTarget} target
 */
function placePyImport(walk, target) {
	if (target.dots > 0) {
		placeRelativePyImport(walk, target);
		return;
	}
	const [top] = target.parts;
	if (top === undefined) throw new Error("an absolute import names no module");
	const placements = pySearches(walk.scope).map((search) =>
		placePyTop(search, top, walk.reach),
	);
	if (placements.every((placed) => placed.kind === "absent")) {
		if (!readPython().stdlib.has(top))
			walk.fault(
				`imports ${top}, which is neither stdlib nor found beside it or on a sys.path entry it adds`,
			);
		return;
	}
	for (const placed of placements) {
		if (placed.kind !== "opaque") continue;
		const { builtins, stdlib } = readPython();
		if (!builtins.has(top) && !(placed.tail && stdlib.has(top)))
			walk.fault(`imports ${top} after a sys.path edit the walk cannot read`);
	}
	descendPlaced(
		walk,
		target,
		placements.flatMap((placed) =>
			placed.kind === "placed" ? placed.places : [],
		),
	);
}

/**
 * @param {PyWalk} walk
 * @param {PyImportTarget} target
 * @param {PyPlace[]} places
 */
function descendPlaced(walk, target, places) {
	const below = { parts: target.parts.slice(1), names: target.names };
	const dotted = target.parts.join(".");
	const misses = places.flatMap((place) => descend(walk, place, below));
	for (const miss of misses.filter(isFaultingMiss))
		walk.fault(
			miss.isPart
				? `imports ${dotted}, whose ${miss.name} the walk cannot place`
				: `imports ${miss.name} from ${dotted}, a namespace package that holds no ${miss.name}`,
		);
}

/**
 * @param {PyMiss} miss
 */
const isFaultingMiss = (miss) =>
	miss.isPart || (miss.at.namespace && !miss.namespace);

/**
 * @param {PyWalk} walk
 * @param {PyPlace} at
 * @param {{parts: string[], names: string[]}} below
 * @returns {PyMiss[]}
 */
function descend(walk, at, { parts, names }) {
	const [part, ...rest] = parts;
	if (part === undefined)
		return (at.dirs.length > 0 ? names : []).flatMap((name) => {
			const { places } = placePyPart(walk.reach, at.dirs, name);
			return places.every((place) => place.namespace)
				? [{ name, isPart: false, at, namespace: places.length > 0 }]
				: [];
		});
	const { places } = placePyPart(walk.reach, at.dirs, part);
	if (places.length === 0)
		return [{ name: part, isPart: true, at, namespace: false }];
	return places.flatMap((place) =>
		descend(walk, place, { parts: rest, names }),
	);
}

/**
 * @param {PyWalk} walk
 * @param {PyImportTarget} target
 */
function placeRelativePyImport(walk, { dots, parts, names }) {
	const pkg = path.resolve(walk.dir, "../".repeat(dots - 1));
	const init = path.join(pkg, "__init__.py");
	if (walk.scope.handed && !isFile(init))
		walk.fault(
			`imports ${".".repeat(dots)}${parts.join(".")} relative to a namespace package, whose other directories the walk cannot tell`,
		);
	if (parts.length === 0 && isFile(init)) walk.reach.edges.push(init);
	const at = { dirs: [{ dir: pkg, maybe: false }], namespace: false };
	for (const miss of descend(walk, at, { parts, names }))
		for (const { dir } of miss.at.dirs)
			walk.reach.edges.push(path.join(dir, `${miss.name}.py`));
}

/**
 * @param {PyEntry[]} search
 * @param {string} top
 * @param {Found} reach
 * @returns {PyTopPlacement}
 */
function placePyTop(search, top, reach) {
	/** @type {PyDir[]} */
	const readable = [];
	let opaque = null;
	for (const entry of search) {
		if (entry.dir === null) {
			opaque = entry;
			break;
		}
		readable.push({ dir: entry.dir, maybe: entry.maybe });
	}
	const { places, settled } = placePyPart(reach, readable, top);
	if (opaque && !settled) return { kind: "opaque", tail: opaque.tail };
	return places.length > 0 ? { kind: "placed", places } : { kind: "absent" };
}

const INTERPRETER = INTERPRETERS.filter((i) => i.kind !== "shell")
	.map((i) => i.name)
	.join("|");
const INLINE_FLAG = "-[A-Za-z]*[cep]|--eval|--print|-";
const ARG_LITERAL = String.raw`(?:${ONE_LINE_STRING}|\x60[^\x60]*\x60)`;
const PLAIN_LITERAL = String.raw`${ONE_LINE_STRING}|\x60[^\x60$\\]*\x60`;
const PLAIN_LITERAL_WHOLE = new RegExp(`^(?:${PLAIN_LITERAL})$`);
const INLINE_ARGV = new RegExp(
	String.raw`(["'\x60](?:${INTERPRETER})["'\x60]|process\.execPath|sys\.executable)\s*,\s*(?:\[\s*)?(?:${ARG_LITERAL}\s*,\s*)*?["'\x60](${INLINE_FLAG})["'\x60]\s*(?:,\s*(${PLAIN_LITERAL})\s*(?=[,\])]))?`,
	"g",
);
const INLINE_COMMAND = new RegExp(
	String.raw`\bexec(?:Sync)?\(\s*["'\x60][^"'\x60]*?\b(${INTERPRETER})\s+(?:-\S+\s+)*?(?:${INLINE_FLAG})(?=[\s"'\x60])`,
	"g",
);
const ARGV_REQUIRE = /\brequire\(\s*process\.argv\[(\d+)\]\s*\)/g;
const LITERAL_ESCAPES = new Map([
	["n", "\n"],
	["t", "\t"],
	["\\", "\\"],
	["'", "'"],
	['"', '"'],
	["`", "`"],
]);

/**
 * @typedef {"python"|"node"|"other"} Interpreter
 * @typedef {{unread: boolean, argv: number[]}} ProgramLoads
 */

/**
 * @param {string} literal
 * @returns {string | null}
 */
function literalBody(literal) {
	let unknown = false;
	const body = literal.slice(1, -1).replace(/\\([\s\S])/g, (_, c) => {
		const undone = LITERAL_ESCAPES.get(c);
		if (undone === undefined) unknown = true;
		return undone ?? "";
	});
	return unknown ? null : body;
}

/**
 * @returns {Set<string> | null}
 */
function readPythonBuiltins() {
	try {
		return readPython().builtins;
	} catch {
		return null;
	}
}

/**
 * @param {Interpreter} interpreter
 * @param {string | null} program
 * @returns {ProgramLoads}
 */
function programLoads(interpreter, program) {
	if (program === null) return { unread: true, argv: [] };
	if (interpreter === "python") {
		const builtins = readPythonBuiltins();
		if (builtins === null) return { unread: true, argv: [] };
		const unread = pyStatements(program, () => undefined).some((s) => {
			const imp = s.text.match(PY_IMPORT);
			if (!imp) return PY_LOAD.test(blankPyStrings(s.text));
			return pyImportTargets(imp).some((t) => {
				const [top] = t.parts;
				return t.dots > 0 || top === undefined || !builtins.has(top);
			});
		});
		return { unread, argv: [] };
	}
	if (interpreter === "node") {
		const specs = [...program.matchAll(JS_SPEC)].map(jsSpecifier);
		const argv = [...program.matchAll(ARGV_REQUIRE)].map((m) =>
			Number(requiredGroup(m, 1, ARGV_REQUIRE)),
		);
		const loads = program.match(/\brequire\b|\bimport\b/g)?.length ?? 0;
		const unread =
			loads !== specs.length + argv.length || !specs.every((s) => isBuiltin(s));
		return { unread, argv };
	}
	return {
		unread: /\b(?:require|use|do|load|eval)\b/.test(program),
		argv: [],
	};
}

/**
 * @param {string} file
 * @param {string} code
 * @returns {{edges: string[], unread: string[], python: boolean}}
 */
function inlineSpawns(file, code) {
	/** @type {string[]} */
	const edges = [];
	/** @type {string[]} */
	const unread = [];
	let runsPython = false;
	for (const m of code.matchAll(INLINE_ARGV)) {
		const interpreter = interpreterOf(requiredGroup(m, 1, INLINE_ARGV));
		runsPython ||= interpreter === "python";
		const flag = requiredGroup(m, 2, INLINE_ARGV);
		const listed = argvList(code, m, flag);
		const literal = m[3] ?? listed?.program;
		const program =
			literal === undefined || flag === "-" ? null : literalBody(literal);
		const loads = programLoads(interpreter, program);
		const said = `spawns ${m[0].replace(/\s+/g, " ")}`;
		const loaded = loads.argv.map((n) =>
			joinedPath(file, code, listed?.args[n - 1] ?? ""),
		);
		if (loads.unread || loaded.includes(null)) unread.push(said);
		else edges.push(.../** @type {string[]} */ (loaded));
	}
	for (const m of code.matchAll(INLINE_COMMAND)) {
		runsPython ||=
			interpreterOf(requiredGroup(m, 1, INLINE_COMMAND)) === "python";
		unread.push(`spawns ${m[0].replace(/\s+/g, " ")}`);
	}
	return { edges, unread, python: runsPython };
}

/**
 * @param {string} code
 * @param {RegExpMatchArray} m
 * @param {string} flag
 * @returns {{program: string | undefined, args: string[]} | null}
 */
function argvList(code, m, flag) {
	const open = (m.index ?? 0) + m[0].indexOf("[");
	if (
		open < (m.index ?? 0) ||
		!/^\s*,\s*\[/.test(m[0].slice(requiredGroup(m, 1, INLINE_ARGV).length))
	)
		return null;
	const close = closeOf(code, open);
	if (close === -1) return null;
	const elements = topLevelArgs(code.slice(open + 1, close - 1)).map((e) =>
		e.trim(),
	);
	const at = elements.findIndex((e) => e.slice(1, -1) === flag);
	if (at === -1) return null;
	const program = constOrSelf(code, elements[at + 1] ?? "");
	return {
		program: PLAIN_LITERAL_WHOLE.test(program) ? program : undefined,
		args: elements.slice(at + 2),
	};
}

/**
 * @param {string} head
 * @returns {Interpreter}
 */
function interpreterOf(head) {
	if (head === "sys.executable") return "python";
	if (head === "process.execPath") return "node";
	const kind = interpreterNamed(head.replace(/^["'\x60]|["'\x60]$/g, ""))?.kind;
	return kind === "node" || kind === "python" ? kind : "other";
}

/**
 * @typedef {import("./shell-script-lexer.js").ShWord} ShWord
 * @typedef {import("./shell-script-lexer.js").ShCommand} ShCommand
 * @typedef {"caller"|"bare"|"array"|"value"} ShBindingKind
 * @typedef {{name: string, at: number, value: string | null,
 *   kind: ShBindingKind}} ShBinding
 */

const NONE = /(?!)/;
const SH_FLAGS = {
	node: {
		inline: /^(?:-[A-Za-z]*[ep]|--eval|--print)$/,
		load: /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--test-reporter)$/,
		module: NONE,
		value:
			/^(?:-C|--conditions|--title|--input-type|--test-reporter-destination)$/,
	},
	python: {
		inline: /^-[A-Za-z]*c$/,
		load: NONE,
		module: /^-[A-Za-z]*m$/,
		value: /^-[WX]$/,
	},
	other: {
		inline: /^-[A-Za-z]*[eE]$/,
		load: NONE,
		module: /^-[Mmr]/,
		value: /^-[IC]$/,
	},
	shell: {
		inline: /^-[A-Za-z]*c$/,
		load: NONE,
		module: NONE,
		value: /^[-+]o$/,
	},
};
const SH_NAMING_HEAD =
	/^(?:echo|printf|type|hash|which|pgrep|pkill|grep|die|warn)$/;
const SH_INFO_FLAG = /^(?:-v|-V|--version|-h|--help)$/;
const SH_WRAPPERS = new Map([
	["exec", /^-a$/],
	["command", NONE],
	["builtin", NONE],
	["env", /^(?:-u|-C|-S)$/],
	["nohup", NONE],
	["setsid", NONE],
	["nice", /^-n$/],
	["timeout", /^(?:-k|-s)$/],
	["stdbuf", NONE],
	["xargs", /^(?:-[IndPLsaE]|--max-args|--delimiter|--replace)$/],
]);
const SH_REBINDS = new Map([
	["read", "all"],
	["mapfile", "all"],
	["readarray", "all"],
	["for", "first"],
	["select", "first"],
]);
const SH_DECLARES = /^(?:local|export|readonly|declare|typeset)$/;
const SH_BARE_NAME_TEST = /^\[\[ "\$(\w+)" == "\$\{BASH_SOURCE\[0\]\}" \]\]$/;
const SH_ONE_PARAMETER =
	/^"?\$(?:\{(?:[@*]|\d+|(\w+)(?::?-([^}]*))?)\}|([@*]|\d)|(\w+))"?$/;
const SH_PARAMETER =
	/^\$\{?PWD\}?\/(?=\$)|^\$\{(\w+)(?:\[0\])?(%\/\*)?\}|^\$(\w+)(?!\w)/;
const SH_TOKEN = /[^\s]+/g;
const SH_TOKEN_OPEN = /^["'`(]+/;
const SH_TOKEN_CLOSE = "\"'`),.;:";
const SH_CALLER_PRAGMA = pragmaLine("#", CALLER_BODY);
const SH_DEFAULTED = /^\$\{(\w+):?-/;

/**
 * @typedef {{file: string, executed: boolean,
 *   bindings: Map<string, ShBinding[]>, unsets: Map<string, number[]>,
 *   callers: Set<string>}} ShScope
 * @typedef {{scope: ShScope, reach: Reach, said: string}} ShRun
 */

/**
 * @param {string} file
 * @param {string} code
 * @returns {FileReach}
 */
function shReach(file, code) {
	const commands = shCommands(code);
	const scope = shScope(file, commands, code);
	/** @type {FileReach} */
	const reach = {
		edges: [],
		shadows: [],
		reads: [],
		unread: [],
		unknown: [],
		python: false,
		pySearch: null,
	};
	for (const command of commands) {
		for (const word of command.words)
			for (const p of codePathsIn(word, scope))
				if (p !== file) reach.edges.push(p);
		shLoads(command, scope, reach);
	}
	const declared = declaredLoads(file, code);
	reach.edges.push(...declared.edges);
	reach.reads.push(...declared.reads);
	reach.unread.push(...declared.unread);
	reach.edges = [...new Set(reach.edges)];
	return reach;
}

/**
 * @param {ShWord} word
 * @param {ShScope} scope
 * @returns {string[]}
 */
function codePathsIn(word, scope) {
	const tokens = /\s/.test(word.text)
		? [...word.text.matchAll(SH_TOKEN)].map((m) => {
				let end = m[0].length;
				while (end > 0 && SH_TOKEN_CLOSE.includes(m[0].charAt(end - 1))) end--;
				const text = m[0].slice(0, end).replace(SH_TOKEN_OPEN, "");
				return { text, at: word.at + (m.index ?? 0) };
			})
		: [];
	const paths = tokens.filter(
		(t) => isCodeFile(t.text) && !/[()]/.test(t.text),
	);
	return [word, ...paths].flatMap((w) => {
		const p = shPath(w, scope);
		return p !== null && isCodeFile(p) ? [p] : [];
	});
}

/**
 * @param {string} file
 * @param {ShCommand[]} commands
 * @param {string} code
 * @returns {ShScope}
 */
function shScope(file, commands, code) {
	/** @type {ShScope} */
	const scope = {
		file,
		executed: isExecutedScript(file),
		bindings: new Map(),
		unsets: new Map(),
		callers: new Set(
			[...code.matchAll(SH_CALLER_PRAGMA)].flatMap((m) =>
				requiredGroup(m, 1, SH_CALLER_PRAGMA).split(/\s+/),
			),
		),
	};
	for (const command of commands) {
		const words = command.words.slice(
			Math.max(
				0,
				command.words.findIndex((w) => !SH_RESERVED.has(w.text)),
			),
		);
		const [head, ...rest] = words;
		if (head === undefined || SH_RESERVED.has(head.text)) continue;
		if (head.text === "unset")
			for (const w of rest) pushTo(scope.unsets, w.text, w.at);
		for (const w of assignmentWords(words)) bindAssignment(scope, command, w);
		for (const w of reboundNames(head.text, rest))
			bind(scope, unknownBinding(w.text, w.at));
	}
	return scope;
}

/**
 * @param {string} head
 * @param {ShWord[]} rest
 * @returns {ShWord[]}
 */
function reboundNames(head, rest) {
	const rebound = SH_REBINDS.get(head);
	if (rebound === undefined) return [];
	return (rebound === "first" ? rest.slice(0, 1) : rest).filter((w) =>
		/^[A-Za-z_]\w*$/.test(w.text),
	);
}

/**
 * @template T
 * @param {Map<string, T[]>} map
 * @param {string} key
 * @param {T} value
 */
function pushTo(map, key, value) {
	map.set(key, [...(map.get(key) ?? []), value]);
}

/**
 * @param {ShScope} scope
 * @param {ShBinding} binding
 */
const bind = (scope, binding) => pushTo(scope.bindings, binding.name, binding);

/**
 * @param {string} name
 * @param {number} at
 * @returns {ShBinding}
 */
const unknownBinding = (name, at) => ({
	name,
	at,
	value: null,
	kind: "value",
});

/**
 * @param {ShWord[]} command
 * @returns {ShWord[]}
 */
function assignmentWords(command) {
	const [head, ...rest] = command;
	const declares = SH_DECLARES.test(head?.text ?? "");
	const words = declares ? rest : command;
	const skipped = (/** @type {ShWord} */ w) =>
		declares && /^(?:-\w+|[A-Za-z_]\w*)$/.test(w.text);
	const end = words.findIndex((w) => !SH_ASSIGN.test(w.text) && !skipped(w));
	return (end === -1 ? words : words.slice(0, end)).filter((w) =>
		SH_ASSIGN.test(w.text),
	);
}

/**
 * @param {ShScope} scope
 * @param {ShCommand} command
 * @param {ShWord} word
 */
function bindAssignment(scope, command, word) {
	const m = word.text.match(SH_ASSIGN);
	if (!m) return;
	const name = requiredGroup(m, 1, SH_ASSIGN);
	const value = {
		text: word.text.slice(m[0].length),
		at: word.at + m[0].length,
	};
	if (value.text === "." && isBareNameFallback(command, name)) return;
	if (m[2] !== undefined || value.text.startsWith("(")) {
		bind(scope, {
			...unknownBinding(name, word.at),
			kind: m[2] === undefined ? "array" : "value",
		});
		return;
	}
	bind(scope, {
		name,
		at: word.at,
		value: shPath(value, scope),
		kind: bindingKind(value.text, scope),
	});
}

/**
 * @param {string} text
 * @param {ShScope} scope
 * @returns {ShBindingKind}
 */
function bindingKind(text, scope) {
	if (isCallerWord(text, scope)) return "caller";
	return /^(["']?)[\w.+-]+\1$/.test(text) ? "bare" : "value";
}

/**
 * @param {ShCommand} command
 * @param {string} name
 */
function isBareNameFallback(command, name) {
	const test = command.prev?.words.map((w) => w.text).join(" ") ?? "";
	return command.joined === "&&" && test.match(SH_BARE_NAME_TEST)?.[1] === name;
}

/**
 * @param {string} text
 * @param {ShScope} scope
 * @returns {boolean}
 */
function isCallerWord(text, scope) {
	const m = text.match(SH_ONE_PARAMETER);
	if (!m) return false;
	const name = m[1] ?? m[4];
	if (name === undefined || scope.callers.has(name)) return true;
	if (m[2] !== undefined && !/^[\w.+-]+$/.test(m[2])) return false;
	return (scope.bindings.get(name) ?? []).every((b) => b.kind === "caller");
}

/**
 * @param {string} text
 * @param {ShScope} scope
 */
function isCommandName(text, scope) {
	const name = text.match(SH_ONE_PARAMETER)?.[4];
	if (name !== undefined && scope.callers.has(name)) return true;
	const bindings = name === undefined ? [] : (scope.bindings.get(name) ?? []);
	return (
		bindings.length > 0 &&
		bindings.every((b) => b.kind === "bare" || b.kind === "caller")
	);
}

/**
 * @param {string} text
 * @param {ShScope} scope
 */
function isLiteralArray(text, scope) {
	const name = text.match(/^"?\$\{(\w+)\[[@*]\]\}"?$/)?.[1];
	const bindings = name === undefined ? [] : (scope.bindings.get(name) ?? []);
	return bindings.length > 0 && bindings.every((b) => b.kind === "array");
}

/**
 * @param {ShScope} scope
 * @param {string} name
 * @param {number} at
 * @returns {string | null}
 */
function shLookup(scope, name, at) {
	if ((scope.unsets.get(name) ?? []).some((u) => u < at)) return null;
	const values = new Set((scope.bindings.get(name) ?? []).map((b) => b.value));
	const [only] = values;
	return values.size === 1 && only !== undefined ? only : null;
}

/**
 * @param {ShWord} word
 * @param {ShScope} scope
 * @returns {string | null}
 */
function shPath(word, scope) {
	const value = shWordValue(word.text, word.at, scope);
	return value !== null && path.isAbsolute(value)
		? path.normalize(value)
		: null;
}

/**
 * @param {string} text
 * @param {number} at
 * @param {ShScope} scope
 * @returns {string | null}
 */
function shWordValue(text, at, scope) {
	let out = "";
	let i = 0;
	let quoted = false;
	while (i < text.length) {
		const rest = text.slice(i);
		if (rest.startsWith('"')) quoted = !quoted;
		const piece = rest.startsWith('"')
			? { value: "", length: 1 }
			: shPiece(rest, quoted, at, scope);
		if (piece === null) return null;
		out += piece.value;
		i += piece.length;
	}
	return out;
}

/**
 * @param {string} rest
 * @param {boolean} quoted
 * @param {number} at
 * @param {ShScope} scope
 * @returns {{value: string, length: number} | null}
 */
function shPiece(rest, quoted, at, scope) {
	const c = rest.charAt(0);
	if (c === "'" && !quoted) {
		const end = rest.indexOf("'", 1);
		return end === -1 ? null : { value: rest.slice(1, end), length: end + 1 };
	}
	if (c === "\\") return { value: rest.charAt(1), length: 2 };
	if (rest.startsWith("$(") && !rest.startsWith("$((")) {
		const { commands, end } = substitutionAt(rest);
		const value = shSubstitution(commands, at, scope);
		return value === null ? null : { value, length: end };
	}
	if (SH_DEFAULTED.test(rest)) return shDefaulted(rest, at, scope);
	if (c === "$") return shParameter(rest, at, scope);
	if (c === "`" || (/[*?[~]/.test(c) && !quoted)) return null;
	return { value: c, length: 1 };
}

/**
 * @param {string} rest
 * @param {number} at
 * @param {ShScope} scope
 * @returns {{value: string, length: number} | null}
 */
function shDefaulted(rest, at, scope) {
	const end = braceEnd(rest);
	const m = rest.match(SH_DEFAULTED);
	if (!m) return null;
	const name = requiredGroup(m, 1, SH_DEFAULTED);
	const value = scope.bindings.has(name)
		? shLookup(scope, name, at)
		: shWordValue(rest.slice(m[0].length, end - 1), at, scope);
	return value === null ? null : { value, length: end };
}

/**
 * @param {string} rest
 * @param {number} at
 * @param {ShScope} scope
 * @returns {{value: string, length: number} | null}
 */
function shParameter(rest, at, scope) {
	const m = rest.match(SH_PARAMETER);
	if (!m) return null;
	const name = m[1] ?? m[3];
	let value = name === undefined ? "" : shLookup(scope, name, at);
	if (name === "BASH_SOURCE" || (name === "0" && scope.executed))
		value = scope.file;
	if (value === null) return null;
	return {
		value: m[2] === undefined ? value : path.dirname(value),
		length: m[0].length,
	};
}

/**
 * @param {ShCommand[]} commands
 * @param {number} at
 * @param {ShScope} scope
 * @returns {string | null}
 */
function shSubstitution(commands, at, scope) {
	const [first, second] = commands.map((c) => c.words.map((w) => w.text));
	const [head, arg] = first?.filter((w) => !w.startsWith("-")) ?? [];
	if (arg === undefined) return null;
	const value = shWordValue(arg, at, scope);
	if (value === null) return null;
	const shape = `${commands.length} ${head}`;
	if (shape === "1 dirname") return path.dirname(value);
	if (shape === "1 basename") return path.basename(value);
	if (shape === "2 cd" && /^pwd(?: -P)?$/.test(second?.join(" ") ?? ""))
		return value;
	return null;
}

/**
 * @param {ShCommand} command
 * @param {ShScope} scope
 * @param {Reach} reach
 */
function shLoads(command, scope, reach) {
	const words = runWords(command.words, scope);
	const [head, ...args] = words;
	if (head === undefined) return;
	/** @type {ShRun} */
	const run = { scope, reach, said: words.map((w) => w.text).join(" ") };
	const named = interpreterNamed(head.text);
	if (named) {
		shInterpreterLoads(
			run,
			named.kind,
			args.flatMap(splitJoinedFlag(SH_FLAGS[named.kind])),
		);
		return;
	}
	if (command.array) return;
	const nested = args.findIndex((w) => interpreterNamed(w.text));
	const nestedKind = interpreterNamed(args[nested]?.text ?? "")?.kind;
	if (nestedKind && !SH_NAMING_HEAD.test(head.text))
		shInterpreterLoads(
			run,
			nestedKind,
			args.slice(nested + 1).flatMap(splitJoinedFlag(SH_FLAGS[nestedKind])),
		);
	const [first] = args;
	if ((head.text === "source" || head.text === ".") && first)
		load(run, first, { sourced: true });
	else if (/[/$`]/.test(head.text) && !isCommandName(head.text, scope))
		load(run, head);
}

/**
 * @param {ShRun} run
 * @param {ShWord} word
 * @param {{sourced?: boolean}} [how]
 */
function load(run, word, { sourced = false } = {}) {
	const p = shPath(word, run.scope);
	if (p !== null && sourced && isExecutedScript(p))
		run.reach.unread.push(
			`sources ${word.text}, an executed script, in \`${run.said}\``,
		);
	else if (p !== null)
		(isFile(p) ? run.reach.edges : run.reach.shadows).push(p);
	else if (!isCallerWord(word.text, run.scope))
		run.reach.unread.push(`loads ${word.text} in \`${run.said}\``);
}

/**
 * @param {ShWord[]} words
 * @param {ShScope} scope
 * @returns {ShWord[]}
 */
function runWords(words, scope) {
	let k = 0;
	for (;;) {
		const w = words[k]?.text ?? "";
		const valued = SH_WRAPPERS.get(w);
		if (SH_RESERVED.has(w) || SH_ASSIGN.test(w) || isLiteralArray(w, scope))
			k++;
		else if (valued === undefined) break;
		else if (w === "command" && /^-[vV]$/.test(words[k + 1]?.text ?? ""))
			return [];
		else k = wrappedAt(words, k + 1, valued, w === "timeout");
	}
	if (/^(?:case|for|select|function)$/.test(words[k]?.text ?? "")) return [];
	return words.slice(k);
}

/**
 * @param {ShWord[]} words
 * @param {number} k
 * @param {RegExp} valued
 * @param {boolean} timed
 */
function wrappedAt(words, k, valued, timed) {
	let at = k;
	for (let w = words[at]?.text; w !== undefined; w = words[at]?.text) {
		if (!w.startsWith("-") && !SH_ASSIGN.test(w)) break;
		at += valued.test(w) ? 2 : 1;
	}
	return timed ? at + 1 : at;
}

/**
 * @param {ShRun} run
 * @param {InterpreterKind} kind
 * @param {ShWord[]} args
 */
function shInterpreterLoads(run, kind, args) {
	const flags = SH_FLAGS[kind];
	for (let k = 0; k < args.length; k++) {
		const t = args[k]?.text ?? "";
		if (SH_INFO_FLAG.test(t)) return;
		const script = scriptWord(args, k);
		if (script) {
			load(run, script);
			return;
		}
		if (kind !== "shell" && flags.inline.test(t)) {
			shInlineProgram(run, kind, args.slice(k + 1));
			return;
		}
		if (/^--?$/.test(t) || flags.module.test(t) || flags.inline.test(t)) break;
		k += shFlagValue(run, flags, args, k);
	}
	unreadProgram(run);
}

/** @param {{load: RegExp, value: RegExp}} flags @returns {(word: ShWord) => ShWord[]} */
const splitJoinedFlag = (flags) => (word) => {
	const joined = /^(--[\w-]+)=/.exec(word.text);
	const flag = joined?.[1];
	if (!joined || !flag || !(flags.load.test(flag) || flags.value.test(flag)))
		return [word];
	return [
		{ text: flag, at: word.at },
		{ text: word.text.slice(joined[0].length), at: word.at + joined[0].length },
	];
};

/**
 * @param {ShRun} run
 */
const unreadProgram = (run) =>
	run.reach.unread.push(
		`runs \`${run.said}\`, whose program the walk cannot read`,
	);

/**
 * @param {ShWord[]} args
 * @param {number} k
 */
function scriptWord(args, k) {
	const t = args[k]?.text ?? "";
	if (t === "--") return args[k + 1];
	return t.startsWith("-") ? undefined : args[k];
}

/**
 * @param {ShRun} run
 * @param {{load: RegExp, value: RegExp}} flags
 * @param {ShWord[]} args
 * @param {number} k
 */
function shFlagValue(run, flags, args, k) {
	const flag = args[k]?.text ?? "";
	const value = args[k + 1];
	if (
		flags.load.test(flag) &&
		value &&
		/[/$]/.test(value.text) &&
		!/^@[\w.-]+\//.test(value.text)
	)
		load(run, value);
	return flags.load.test(flag) || flags.value.test(flag) ? 1 : 0;
}

/**
 * @param {ShRun} run
 * @param {Interpreter} kind
 * @param {ShWord[]} words
 */
function shInlineProgram(run, kind, words) {
	const [program, ...args] = words;
	run.reach.python ||= kind === "python";
	const text =
		program !== undefined && /^'[^']*'$/.test(program.text)
			? program.text.slice(1, -1)
			: null;
	const { unread, argv } = programLoads(kind, text);
	if (unread) {
		unreadProgram(run);
		return;
	}
	for (const n of argv) {
		const word = args[n - 1];
		const p = word === undefined ? null : shPath(word, run.scope);
		if (p === null)
			run.reach.unread.push(
				`runs \`${run.said}\`, whose program loads argument ${n}, no path it reads`,
			);
		else run.reach.edges.push(p);
	}
}

module.exports = {
	fileReach,
	isFile,
	isScript,
	languageOf,
	parseShebang,
	pythonVersion,
	scriptLanguage,
	JS_SPEC,
	jsSpecifier,
};
