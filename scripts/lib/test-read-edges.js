// `vitest` selects `--changed` on the import graph alone: a file a test reaches through `readFileSync` has no edge there. https://vitest.dev/guide/cli#changed

const fs = require("node:fs");
const path = require("node:path");
const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const { closeOf, inertSpans, topLevelArgs } = require("./js-lex.js");
const { blankComments } = require("./strip-comments.js");
const { parseEdges } = require("./guard-reach.js");
const { shellOperands } = require("./shell-operands.js");
const { escapeRe, requiredGroup } = require("./regex-group.js");
const { byCodeUnit } = require("./by-code-unit.js");
const { LOADS_BODY, pragmaLine } = require("./code-edges-pragmas.js");
const { JS_TEST_FILE, isJsTestFile, isTestKind } = require("./test-kind.js");
const { isUnder } = require("./is-under.js");
const {
	DISPATCH_ENTRY,
	MANIFEST_REL,
	modulePath,
} = require("./guard-cores.js");

const ROOT_NAMES =
	"ROOT|REPO|repoRoot|projectRoot|REPO_ROOT|PROJECT_ROOT|HOST_ROOT";

const ROOT_CALLS = "hostRoot\\(\\)|worktreeRoot\\(\\)|coreRoot\\(\\)";

const CALL_ANCHOR = `__dirname|CORE_SCRIPTS|${ROOT_NAMES}|${ROOT_CALLS}`;

const ANCHOR = new RegExp(
	`\\b(${ROOT_NAMES})\\b|\\b(?:${ROOT_CALLS})|process\\.cwd\\(\\)|__dirname\\s*,\\s*["']\\.\\.`,
);

const DIRNAME = /\b__dirname\b|\bCORE_SCRIPTS\b/;

const DIRNAME_ANCHORS = new Set(["__dirname", "CORE_SCRIPTS"]);

const LITERAL = /["'`]([A-Za-z0-9_./-]+)["'`]/g;

const COMPOSED_CALL = new RegExp(
	`\\bpath\\.(?:resolve|join)\\(\\s*(${CALL_ANCHOR})\\s*,\\s*((?:["'\`][A-Za-z0-9_./-]+["'\`]\\s*,\\s*)*["'\`][A-Za-z0-9_./-]+["'\`])\\s*(?:,\\s*)?\\)`,
	"g",
);

const DIR_CLASS = new RegExp(
	`\\bpath\\.(?:resolve|join)\\(\\s*(${CALL_ANCHOR})\\s*,\\s*((?:["'][A-Za-z0-9_./-]+["']\\s*,\\s*)+)\`[A-Za-z0-9_./-]*\\$\\{[^}\`]+\\}[A-Za-z0-9_./-]*\`\\s*(?:,\\s*)?\\)`,
	"g",
);

const IMPORT = /\b(?:from|require\(|import\()\s*["'`](\.\.?\/[^"'`]+)["'`]/g;

const ESM_IMPORT =
	/(?:\b(?:from|import\()|^[ \t]*import)\s*["'`](\.\.?\/[^"'`]+)["'`]/gm;

const TYPE_ONLY = /^[ \t]*(?:import|export)[ \t]+type\b[^;]*;?/gm;

const TYPE_QUERY = /\btypeof\s+import\(\s*["'`][^"'`]+["'`]\s*\)/g;

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

const OWN_MODULE_EXTENSIONS = [".js", ".sh", ".cjs", ".mjs", ".ts"];

/**
 * @typedef {{ tracked: Set<string>, self: string, root: boolean,
 *  sibling: boolean, imported: Set<string>, found: Set<string> }} EdgeScan
 */

/** @param {EdgeScan} scan @param {string} p */
const isCandidate = (scan, p) => p !== scan.self && !scan.imported.has(p);

/** @param {string} test @param {Set<string>} tracked @returns {string[]} */
function ownModules(test, tracked) {
	const stem = test.replace(JS_TEST_FILE, "");
	return OWN_MODULE_EXTENSIONS.map((e) => stem + e).filter((p) =>
		tracked.has(p),
	);
}

/** @param {string} fromFile @param {string} spec @returns {string} */
function resolveRelative(fromFile, spec) {
	const stack = fromFile.split("/").slice(0, -1);
	for (const part of spec.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return stack.join("/");
}

/** @param {string[]} base @param {string} spec @returns {string | null} */
function resolveDirPath(base, spec) {
	const stack = [...base];
	for (const part of spec.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (stack.length === 0) return null;
			stack.pop();
		} else stack.push(part);
	}
	return stack.join("/");
}

/**
 * @param {string} fromFile
 * @param {string} spec
 * @param {Set<string>} tracked
 * @returns {string | null}
 */
function resolveImport(fromFile, spec, tracked) {
	const base = resolveRelative(fromFile, spec);
	const stripped = base.replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "");
	const candidates = [
		base,
		...EXTENSIONS.map((e) => base + e),
		...EXTENSIONS.map((e) => `${base}/index${e}`),
		...EXTENSIONS.map((e) => stripped + e),
	];
	for (const c of candidates) if (tracked.has(c)) return c;
	return null;
}

/**
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @param {RegExp} [re]
 * @returns {Set<string>}
 */
function importedHelpers(source, self, tracked, re = IMPORT) {
	const out = new Set();
	for (const m of source.matchAll(re)) {
		const resolved = resolveImport(self, requiredGroup(m, 1, re), tracked);
		if (resolved && resolved !== self) out.add(resolved);
	}
	return out;
}

/**
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @returns {Set<string>}
 */
const vitestImports = (source, self, tracked) =>
	importedHelpers(
		source.replace(TYPE_ONLY, "").replace(TYPE_QUERY, ""),
		self,
		tracked,
		ESM_IMPORT,
	);

/** @param {string} args @returns {string[]} */
const literalsIn = (args) =>
	[...args.matchAll(LITERAL)].map((x) => requiredGroup(x, 1, LITERAL));

/** @param {EdgeScan} scan @param {string} raw @returns {void} */
function addSiblingEdge(scan, raw) {
	const q = resolveRelative(scan.self, raw);
	if (isCandidate(scan, q) && scan.tracked.has(q)) scan.found.add(q);
}

/** @param {EdgeScan} scan @param {string} raw @returns {void} */
function addLiteralEdges(scan, raw) {
	const p = raw.replace(/^\.\//, "");
	if (scan.root && p !== scan.self && scan.tracked.has(p)) scan.found.add(p);
	if (scan.sibling) addSiblingEdge(scan, p);
}

/** @param {EdgeScan} scan @param {string} source @returns {void} */
function addComposedEdges(scan, source) {
	for (const m of source.matchAll(COMPOSED_CALL)) {
		const pieces = literalsIn(requiredGroup(m, 2, COMPOSED_CALL));
		const joined = pieces.join("/").replace(/^\.\//, "");
		if (DIRNAME_ANCHORS.has(requiredGroup(m, 1, COMPOSED_CALL))) {
			if (scan.sibling) addSiblingEdge(scan, joined);
		} else if (scan.root && joined !== scan.self && scan.tracked.has(joined)) {
			scan.found.add(joined);
		}
	}
}

/** @param {EdgeScan} scan @param {RegExpMatchArray} m @returns {string | null} */
function dirClassPath(scan, m) {
	const dirAnchor = DIRNAME_ANCHORS.has(requiredGroup(m, 1, DIR_CLASS));
	if (dirAnchor && !scan.sibling) return null;
	if (!dirAnchor && !scan.root) return null;
	const pieces = literalsIn(requiredGroup(m, 2, DIR_CLASS));
	const joined = pieces.join("/").replace(/^\.\//, "");
	const base = dirAnchor ? scan.self.split("/").slice(0, -1) : [];
	return resolveDirPath(base, joined);
}

/** @param {EdgeScan} scan @param {string} source @returns {void} */
function addDirClassEdges(scan, source) {
	for (const m of source.matchAll(DIR_CLASS)) {
		const dirPath = dirClassPath(scan, m);
		if (!dirPath) continue;
		for (const p of scan.tracked)
			if (isCandidate(scan, p) && isUnder(p, [dirPath])) scan.found.add(p);
	}
}

const QUOTED = /^(["'])([^"'`\n\\]+)\1$/;

const IDENT_SRC = "[A-Za-z_$][\\w$]*";
const IDENT = new RegExp(`^${IDENT_SRC}$`);
const IDENT_HEAD = new RegExp(`^${IDENT_SRC}`);

// #1770 guess: the deepest `dirsOf` chain the tests held on 16 Oct 2026 was two
const TRACE_HOPS = 4;

const ROOT_NAME = new RegExp(
	`^(?:${ROOT_NAMES}|${ROOT_CALLS}|process\\.cwd\\(\\))$`,
);

const ROOT_CALL = new RegExp(`^(?:${ROOT_CALLS}|process\\.cwd\\(\\))$`);

const literalArg = (/** @type {string} */ arg) =>
	/^["'`]([A-Za-z0-9_./-]+)["'`]$/.exec(arg)?.[1] ?? null;

/**
 * @param {EdgeScan} scan
 * @param {string} source
 * @param {string} expr
 * @param {number} [hops]
 * @returns {string[]}
 */
function dirsOf(scan, source, expr, hops = TRACE_HOPS) {
	const e = expr.trim();
	if (/^path\.(?:resolve|join)\(/.test(e))
		return joinedDirs(scan, source, e, hops);
	if (DIRNAME_ANCHORS.has(e))
		return scan.sibling ? [scan.self.split("/").slice(0, -1).join("/")] : [];
	if (!IDENT.test(e) && !ROOT_NAME.test(e)) return [];
	const found = hops > 0 ? declaredDirs(scan, source, e, hops - 1) : [];
	if (found.length > 0) return found;
	return ROOT_NAME.test(e) && scan.root ? [""] : [];
}

/**
 * @param {EdgeScan} scan
 * @param {string} source
 * @param {string} call
 * @param {number} hops
 * @returns {string[]}
 */
function joinedDirs(scan, source, call, hops) {
	const open = call.indexOf("(");
	if (closeOf(call, open) !== call.length) return [];
	const [base, ...rest] = topLevelArgs(call.slice(open + 1, -1));
	const pieces = rest.map(literalArg);
	if (base === undefined || pieces.includes(null)) return [];
	return dirsOf(scan, source, base, hops).flatMap((d) => {
		const r = resolveDirPath(d ? d.split("/") : [], pieces.join("/"));
		return r === null ? [] : [r];
	});
}

const INITIALISER = new RegExp(
	`^path\\.(?:resolve|join)\\(|^${IDENT_SRC}(?=\\s*[;,)\\n])`,
);

/**
 * @param {EdgeScan} scan
 * @param {string} source
 * @param {string} name
 * @param {number} hops
 * @returns {string[]}
 */
function declaredDirs(scan, source, name, hops) {
	const decl = new RegExp(
		`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=]+)?=\\s*`,
		"g",
	);
	const found = [];
	for (const m of source.matchAll(decl)) {
		const at = (m.index ?? 0) + m[0].length;
		const head = INITIALISER.exec(source.slice(at));
		if (!head) continue;
		const end = head[0].endsWith("(")
			? closeOf(source, at + head[0].length - 1)
			: at + head[0].length;
		if (end > at)
			found.push(...dirsOf(scan, source, source.slice(at, end), hops));
	}
	return found;
}

const FILTER_TAIL = /([dgimsuy]*)\.test\(\s*([\w$.]+)\s*\)/y;

const LINE_BREAKS = "\n\r\u2028\u2029";

/** @param {string} body */
function classCloses(body) {
	const n = body.length;
	const close = new Int32Array(n + 2).fill(-1);
	for (let i = n - 1; i >= 0; i--) {
		const ch = body.charAt(i);
		if (ch === "]") close[i] = i;
		else if (ch !== "\\") close[i] = close[i + 1] ?? -1;
		else if (escapes(body, i)) close[i] = close[i + 2] ?? -1;
	}
	return close;
}

const escapes = (/** @type {string} */ body, /** @type {number} */ i) =>
	i + 1 < body.length && !LINE_BREAKS.includes(body.charAt(i + 1));

/** @param {string} body */
function sourceStops(body) {
	const n = body.length;
	const classClose = classCloses(body);
	const pieceEnd = (/** @type {number} */ i) => {
		const ch = body.charAt(i);
		if (ch === "\\") return escapes(body, i) ? i + 2 : -1;
		if (ch !== "[") return ch === "/" || ch === "\n" ? -1 : i + 1;
		const close = classClose[i + 1] ?? -1;
		return close >= 0 ? close + 1 : -1;
	};
	const stop = new Int32Array(n + 1).fill(n);
	for (let i = n - 1; i >= 0; i--) {
		const end = pieceEnd(i);
		stop[i] = end < 0 ? i : (stop[end] ?? n);
	}
	return stop;
}

/**
 * @param {string} body
 * @returns {{negated: boolean, source: string, flags: string, name: string}[]}
 */
function regexFilters(body) {
	const n = body.length;
	const stop = sourceStops(body);
	/** @type {Map<number, RegExpExecArray | null>} */
	const tails = new Map();
	const tailAt = (/** @type {number} */ close) => {
		if (!tails.has(close)) {
			FILTER_TAIL.lastIndex = close + 1;
			tails.set(close, FILTER_TAIL.exec(body));
		}
		return tails.get(close) ?? null;
	};
	/** @param {number} from @param {boolean} negated */
	const literalAt = (from, negated) => {
		let open = from;
		while (open < n && /\s/.test(body.charAt(open))) open++;
		if (body.charAt(open) !== "/") return null;
		const close = stop[open + 1] ?? n;
		if (close === open + 1 || body.charAt(close) !== "/") return null;
		const tail = tailAt(close);
		if (!tail) return null;
		const end = close + 1 + tail[0].length;
		const source = body.slice(open + 1, close);
		const flags = requiredGroup(tail, 1, FILTER_TAIL);
		const name = requiredGroup(tail, 2, FILTER_TAIL);
		return { end, filter: { negated, source, flags, name } };
	};
	const found = [];
	for (let at = 0; at < n; ) {
		const hit =
			(body.charAt(at) === "!" ? literalAt(at + 1, true) : null) ??
			(at === 0 || !/\s/.test(body.charAt(at - 1))
				? literalAt(at, false)
				: null);
		if (hit) {
			found.push(hit.filter);
			at = hit.end;
		} else at++;
	}
	return found;
}

const FILTER_STR =
	/(!?)(?:(?<!\s)\s+|(?<![\s\w$.]))([\w$.]+)\.(endsWith|startsWith|includes)\(\s*["']([^"'\n]*)["']\s*\)/g;

const UNREAD_FILTER =
	/\|\||\?(?![.?])|!\s*\(|[!=]==?\s*(?:true|false)\b|\b(?:true|false)\s*[!=]==?|\breturn\b|\{/;

/** @type {Record<string, (n: string, lit: string) => boolean>} */
const STRING_TESTS = {
	endsWith: (n, lit) => n.endsWith(lit),
	startsWith: (n, lit) => n.startsWith(lit),
	includes: (n, lit) => n.includes(lit),
};

/** @param {string} body @param {string} v @returns {((name: string) => boolean)[] | null} */
function nameChecks(body, v) {
	const onName = (/** @type {string} */ r) => r === v || r === `${v}.name`;
	const checks = [];
	for (const f of regexFilters(body)) {
		if (f.negated || !onName(f.name)) continue;
		try {
			const re = new RegExp(f.source, f.flags.replace(/[gy]/g, ""));
			checks.push((/** @type {string} */ n) => re.test(n));
		} catch {
			return null;
		}
	}
	for (const m of body.matchAll(FILTER_STR)) {
		const test = STRING_TESTS[requiredGroup(m, 3, FILTER_STR)];
		const lit = requiredGroup(m, 4, FILTER_STR);
		if (!m[1] && test && onName(requiredGroup(m, 2, FILTER_STR)))
			checks.push((/** @type {string} */ n) => test(n, lit));
	}
	return checks;
}

/** @param {string} body @param {string} v @returns {((name: string) => boolean) | null} */
function filterPredicate(body, v) {
	if (UNREAD_FILTER.test(body)) return null;
	const checks = nameChecks(body, v);
	if (!checks || checks.length === 0) return null;
	return (n) => checks.every((c) => c(n));
}

const ARROW = new RegExp(
	`^(?:\\(\\s*(${IDENT_SRC})\\s*(?::[^)]*)?\\)|(${IDENT_SRC}))\\s*=>([\\s\\S]*)$`,
);

/**
 * @param {string} source
 * @param {number} end
 * @param {string | undefined} loopVar
 * @returns {((name: string) => boolean) | null}
 */
function listingFilter(source, end, loopVar) {
	const chain = /^(?:\s*\.sort\(\))?\s*\.filter\(|^\s*\)\s*\{\s*if\s*\(/.exec(
		source.slice(end),
	);
	if (!chain) return null;
	const open = end + chain[0].length - 1;
	const close = closeOf(source, open);
	if (close === -1) return null;
	const body = source.slice(open + 1, close - 1).trim();
	if (chain[0].endsWith(".filter(")) {
		const arrow = ARROW.exec(body);
		const v = arrow?.[1] ?? arrow?.[2];
		return v ? filterPredicate(arrow?.[3] ?? "", v) : null;
	}
	const skips = /^\s*continue\b/.test(source.slice(close));
	return loopVar && skips && /^!(?!.*(?:&&|\|\||!))/.test(body)
		? filterPredicate(body.slice(1), loopVar)
		: null;
}

/**
 * @param {EdgeScan} scan
 * @param {string} dir
 * @param {boolean} recursive
 * @param {((name: string) => boolean) | null} keep
 * @returns {void}
 */
function addListedEdges(scan, dir, recursive, keep) {
	const prefix = dir ? `${dir}/` : "";
	for (const p of scan.tracked) {
		if (!p.startsWith(prefix) || !isCandidate(scan, p)) continue;
		const rel = p.slice(prefix.length);
		if (!recursive && rel.includes("/")) continue;
		if (!keep || keep(rel)) scan.found.add(p);
	}
}

const LOOP_HEAD = new RegExp(
	`for\\s*\\(\\s*(?:const|let|var)\\s+(${IDENT_SRC})\\s+of\\s+[\\w$.]*$`,
);

/** @param {EdgeScan} scan @param {string} source @returns {void} */
function addReaddirEdges(scan, source) {
	for (const m of source.matchAll(/\breaddirSync\(/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = closeOf(source, open);
		if (close === -1) continue;
		const [dirArg, opts = ""] = topLevelArgs(source.slice(open + 1, close - 1));
		if (!dirArg) continue;
		const recursive = /\brecursive\s*:\s*true\b/.test(opts);
		const loopVar = LOOP_HEAD.exec(source.slice(0, m.index))?.[1];
		const keep = listingFilter(source, close, loopVar);
		for (const dir of new Set(dirsOf(scan, source, dirArg)))
			addListedEdges(scan, dir, recursive, keep);
	}
}

/** @type {Record<string, string>} */
const GLOB_CHARS = { "*": ".*", "?": "." };

/**
 * Git's pathspec without magic: a glob's `*` crosses `/`, and a plain spec
 * matches itself or anything under it. https://git-scm.com/docs/gitglossary
 * @param {string} spec
 * @returns {(p: string) => boolean}
 */
function pathspecMatcher(spec) {
	const s = spec.replace(/^\.\//, "").replace(/\/$/, "");
	if (!/[*?]/.test(s)) return (p) => isUnder(p, [s]);
	const glob = s
		.split("")
		.map((c) => GLOB_CHARS[c] ?? escapeRe(c))
		.join("");
	const re = new RegExp(`^${glob}(?:/|$)`);
	return (p) => re.test(p);
}

/**
 * @param {string} source
 * @param {string[]} elements
 * @returns {{ specs: string[], unreadable: boolean }}
 */
function parsePathspecs(source, elements) {
	const specs = [];
	let unreadable = false;
	for (const el of splitListing(elements).pathspecs) {
		const lit = PATHSPEC.exec(el)?.[1];
		const filled =
			lit === undefined && IDENT.test(el) ? argsFor(source, el) : [];
		if (lit !== undefined) {
			if (!lit.startsWith("-")) specs.push(lit);
		} else if (filled.length > 0) specs.push(...filled);
		else unreadable = true;
	}
	return { specs, unreadable };
}

const GREP_PATTERN_FILE = /^["'`]-[A-Za-z]*f/;

/** @param {string[]} elements @returns {boolean} */
function isGrepReadingFlagFile(elements) {
	return splitListing(elements).flags.some(
		(el) => GREP_PATTERN_FILE.test(el) || !QUOTED_ELEMENT.test(el),
	);
}

const GREP_UNTRACKED = /^["'](?:--untracked|--no-index)["']$/;

const QUOTED_ELEMENT = /^(["'`])[^"'`]*\1$/;

const GIT_LISTER = /^["'](?:ls-files|grep)["']$/;

const GIT_LISTING = /\[\s*["'](?:ls-files|grep|-[^"']*)["']/g;

const OPTION_ELEMENT = /^["']-/;

const GIT_CONFIG_OPTION = /^["']-c["']$/;

/**
 * @param {string} source
 * @param {number} open
 * @returns {{ dirArgs: string[], unread: boolean, elements: string[], close: number } | null}
 */
function parseGitListing(source, open) {
	const close = closeOf(source, open);
	if (close === -1) return null;
	const elements = topLevelArgs(source.slice(open + 1, close - 1));
	const { dirArgs, at, unread } = parseGlobalOptions(elements);
	const sub = elements[at];
	return sub !== undefined && GIT_LISTER.test(sub)
		? { dirArgs, unread, elements: elements.slice(at), close }
		: null;
}

/** @param {string[]} elements @returns {{ dirArgs: string[], at: number, unread: boolean }} */
function parseGlobalOptions(elements) {
	const dirArgs = [];
	let at = 0;
	for (let el = elements[at]; el !== undefined; el = elements[at]) {
		const value = elements[at + 1];
		if (el === '"-C"' || el === "'-C'") {
			if (value !== undefined) dirArgs.push(value);
		} else if (!GIT_CONFIG_OPTION.test(el)) break;
		at += 2;
	}
	const el = elements[at];
	if (el === undefined || !OPTION_ELEMENT.test(el))
		return { dirArgs, at, unread: false };
	const from = at;
	const sub = elements.findIndex((e, i) => i > from && GIT_LISTER.test(e));
	return { dirArgs, at: sub, unread: true };
}

/**
 * @param {string[]} start
 * @param {string[]} dirArgs
 * @param {(expr: string) => string[] | null} trace
 * @returns {string[] | null}
 */
function foldDirArgs(start, dirArgs, trace) {
	/** @type {string[] | null} */
	let dirs = start;
	for (const v of dirArgs) {
		const lit = literalArg(v);
		dirs =
			lit === null ? trace(v) : dirs.flatMap((d) => literalDir(d, lit) ?? []);
		if (dirs === null) return null;
	}
	return dirs;
}

/** @param {string} base @param {string} lit @returns {string | null} */
const literalDir = (base, lit) =>
	lit.startsWith("/") ? null : resolveDirPath(base ? base.split("/") : [], lit);

/** @param {string[]} specs @param {string} dir @returns {(p: string) => boolean} */
function listingMatcher(specs, dir) {
	const under = (/** @type {string} */ s) =>
		dir ? resolveDirPath(dir.split("/"), s) : s.replace(/^\.\//, "");
	const matchers = (/** @type {boolean} */ exclude) =>
		specs
			.filter((s) => EXCLUDE.test(s) === exclude)
			.flatMap((s) => {
				const spec = under(s.replace(EXCLUDE, ""));
				return spec === null ? [] : [pathspecMatcher(spec)];
			});
	const included = matchers(false);
	const excluded = matchers(true);
	return (p) => included.some((t) => t(p)) && !excluded.some((t) => t(p));
}

/** @param {string[]} elements @returns {{ pathspecs: string[], flags: string[] }} */
function splitListing(elements) {
	const [subcommand, ...rest] = elements;
	if (!/^["']grep["']$/.test(subcommand ?? ""))
		return { pathspecs: rest, flags: [] };
	const dashes = rest.findIndex((el) => /^["']--["']$/.test(el));
	return dashes === -1
		? { pathspecs: [], flags: rest }
		: { pathspecs: rest.slice(dashes + 1), flags: rest.slice(0, dashes) };
}

const PATHSPEC = /^["'`]((?::!|:\^|:\(exclude\))?[A-Za-z0-9_./*?-]+)["'`]$/;

const EXCLUDE = /^:(?:!|\^|\(exclude\))/;

const FUNCTION_HEAD = new RegExp(
	`\\b(?:function\\s+(${IDENT_SRC})\\s*|(?:const|let)\\s+(${IDENT_SRC})\\s*=\\s*(?:async\\s*)?)\\(`,
	"g",
);

/** @param {string} source @param {number} open @param {string} param @returns {number} */
function paramIndex(source, open, param) {
	return paramsOf(source, open).findIndex(
		(p) => IDENT_HEAD.exec(p.replace(/^\.\.\.\s*/, ""))?.[0] === param,
	);
}

/** @param {string} source @param {number} open @returns {string[]} */
function paramsOf(source, open) {
	const close = closeOf(source, open);
	return close === -1 ? [] : topLevelArgs(source.slice(open + 1, close - 1));
}

/**
 * @param {string} source
 * @param {string} name
 * @param {number} declared
 * @returns {{ at: number, args: string[] }[]}
 */
function callArgs(source, name, declared) {
	const out = [];
	const call = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\(`, "g");
	for (const c of source.matchAll(call)) {
		const open = (c.index ?? 0) + c[0].length - 1;
		const close = open === declared ? -1 : closeOf(source, open);
		if (close !== -1)
			out.push({
				at: open,
				args: topLevelArgs(source.slice(open + 1, close - 1)),
			});
	}
	return out;
}

/**
 * @param {string} source
 * @param {string} name
 * @param {number} at
 * @param {number} declared
 * @returns {string[]}
 */
const callLiterals = (source, name, at, declared) =>
	callArgs(source, name, declared).flatMap(({ args }) => {
		const lit = PATHSPEC.exec(args[at] ?? "")?.[1];
		return lit === undefined ? [] : [lit];
	});

/** @param {string} source @param {string} param @returns {string[]} */
function argsFor(source, param) {
	const out = [];
	for (const h of source.matchAll(FUNCTION_HEAD)) {
		const name = h[1] ?? h[2];
		const open = (h.index ?? 0) + h[0].length - 1;
		const at = name ? paramIndex(source, open, param) : -1;
		if (name && at !== -1) out.push(...callLiterals(source, name, at, open));
	}
	return out;
}

/** @param {EdgeScan} scan @param {string} source @returns {void} */
function addListingEdges(scan, source) {
	for (const m of source.matchAll(GIT_LISTING)) {
		const listing = parseGitListing(source, m.index ?? 0);
		if (!listing) continue;
		const { specs } = parsePathspecs(source, listing.elements);
		const dirs = foldDirArgs(scan.root ? [""] : [], listing.dirArgs, (v) =>
			dirsOf(scan, source, v),
		);
		for (const dir of dirs ?? []) addPathspecEdges(scan, specs, dir);
	}
}

/** @param {EdgeScan} scan @param {string[]} specs @param {string} dir @returns {void} */
function addPathspecEdges(scan, specs, dir) {
	const lists = listingMatcher(specs, dir);
	for (const p of scan.tracked)
		if (isCandidate(scan, p) && lists(p)) scan.found.add(p);
}

/**
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {string} self
 * @returns {string[]}
 */
function edgesFor(source, tracked, self) {
	const declared = declaredReads(source, tracked, self);
	const root = ANCHOR.test(source);
	const sibling = DIRNAME.test(source);
	if (!root && !sibling) return declared;
	const imported = sibling ? vitestImports(source, self, tracked) : new Set();
	/** @type {EdgeScan} */
	const scan = { tracked, self, root, sibling, imported, found: new Set() };
	for (const p of literalsIn(source)) addLiteralEdges(scan, p);
	addComposedEdges(scan, source);
	addDirClassEdges(scan, source);
	addReaddirEdges(scan, source);
	addListingEdges(scan, source);
	for (const p of declared) scan.found.add(p);
	return [...scan.found].sort();
}

const LOADS_PRAGMA = pragmaLine(String.raw`\/\/|\/?\*`, LOADS_BODY);

/**
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {string} self
 * @returns {string[]}
 */
function declaredReads(source, tracked, self) {
	return declaredPaths(source, self).filter((p) => tracked.has(p));
}

/** @param {string} source @param {Set<string>} tracked @param {string} self @returns {string[]} */
function untrackedLoads(source, tracked, self) {
	return declaredPaths(source, self)
		.filter((p) => !tracked.has(p))
		.map((p) => `${self}: code-edges loads: ${p} names no tracked file`);
}

/** @param {string} source @param {string} self @returns {string[]} */
function declaredPaths(source, self) {
	return [...source.matchAll(LOADS_PRAGMA)]
		.map((m) => resolveRelative(self, requiredGroup(m, 1, LOADS_PRAGMA)))
		.filter((p) => p !== self);
}

const RULE_TEXT_MODULE = "scripts/lib/rule-text.js";

const RULES_DIR = "docs/agents/rules/";

const SPECIFIER = /["'`](\.\.?\/[^"'`]+)["'`]/g;

const RULE_ID = /["'`](?:rule:)?([a-z0-9][a-z0-9-]*)["'`]/g;

/**
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {string} self
 * @returns {string[]}
 */
function ruleEdgesFor(source, tracked, self) {
	const loads = [...source.matchAll(SPECIFIER)].some(
		(m) =>
			resolveImport(self, requiredGroup(m, 1, SPECIFIER), tracked) ===
			RULE_TEXT_MODULE,
	);
	if (!loads) return [];
	const found = new Set();
	for (const m of source.matchAll(RULE_ID)) {
		const p = `${RULES_DIR}${m[1]}.txt`;
		if (tracked.has(p)) found.add(p);
	}
	return [...found].sort();
}

const DISPATCHERS = [
	DISPATCH_ENTRY,
	"scripts/lib/guard-core-testkit.ts",
	"scripts/lib/pretool-guard-testkit.ts",
];

const QUOTED_NAME = /["'`]([a-z0-9][a-z0-9-]*)["'`]/g;

/**
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {Map<string, string>}
 */
function readCoresByName(tracked, read) {
	/** @type {Map<string, string>} */
	const out = new Map();
	if (!tracked.has(MANIFEST_REL)) return out;
	/** @type {import("./guard-cores.js").Manifest} */
	const manifest = JSON.parse(read(MANIFEST_REL));
	for (const { name, core } of Object.values(manifest).flat()) {
		const p = modulePath(core);
		if (tracked.has(p)) out.set(name, p);
	}
	return out;
}

/**
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {(t: string, source: string, found: Set<string>) => string[]}
 */
function buildCoreEdges(tracked, read) {
	const cores = readCoresByName(tracked, read);
	/** @param {string} source @param {Set<string>} reached */
	const named = (source, reached) => {
		if (!DISPATCHERS.some((d) => reached.has(d))) return [];
		return [...source.matchAll(QUOTED_NAME)].flatMap((m) => {
			const p = cores.get(requiredGroup(m, 1, QUOTED_NAME));
			return p ? [p] : [];
		});
	};
	const helperNames = once((h) => {
		const code = blankComments(read(h));
		const imports = directImports(code, h, tracked);
		return named(code, new Set([...edgesFor(code, tracked, h), ...imports]));
	});
	return (t, source, found) => {
		if (cores.size === 0) return [];
		const imports = directImports(source, t, tracked);
		const out = new Set(named(source, new Set([...found, ...imports])));
		for (const h of imports)
			if (isTestSupport(h) && !DISPATCHERS.includes(h))
				for (const p of helperNames(h)) out.add(p);
		return [...out];
	};
}

const NODE_SCRIPT = /\.[mc]?js$/;

const isScript = (/** @type {string} */ p) =>
	NODE_SCRIPT.test(p) || /\.sh$/.test(p) || /^\.husky\/[^/.]+$/.test(p);

const SOURCE_LINE = /(?<=^|\|\||&&|;)[ \t]*(?:source|\.)[ \t]+(\S.*)$/gm;

// guess: the hooks' deepest chain, lib through here, is two hops; four leaves slack (#5817)
const MAX_ASSIGN_HOPS = 4;

const TOPLEVEL = /^"?\$\(git rev-parse --show-toplevel\b[^)]*\)"?(?:\s|$)/;

const SOURCE_ARG =
	/^["']?(?<dirVar>\$\(dirname\s+"?\$(?:\{BASH_SOURCE\[0\]\}|BASH_SOURCE|0)"?\)|\$\{BASH_SOURCE\[0\]%\/\*\}|\$\{?[A-Za-z_](?:(?=(?<whole>[A-Za-z0-9_]*))\k<whole>\}?|(?=(?<lessLast>[A-Za-z0-9_]*)[A-Za-z0-9_])\k<lessLast>))?(?<tail>\/?[A-Za-z0-9_./-]+)["']?(?:\s|;|$)/;

/**
 * @param {string} s
 * @returns {string}
 */
function expandDefaults(s) {
	let out = s;
	for (;;) {
		const m = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-/.exec(out);
		if (!m) return out;
		let depth = 1;
		let i = m.index + m[0].length;
		for (; i < out.length && depth > 0; i++)
			if (out[i] === "{") depth++;
			else if (out[i] === "}") depth--;
		if (depth > 0) return out;
		out =
			out.slice(0, m.index) +
			out.slice(m.index + m[0].length, i - 1) +
			out.slice(i);
	}
}

/**
 * @param {string} s
 * @returns {string}
 */
function unquotedDefaults(s) {
	return expandDefaults(s).replace(/["']/g, "");
}

/**
 * @param {string} prefix
 * @returns {boolean}
 */
function opensCommand(prefix) {
	/** @type {string | null} */
	let quote = null;
	for (let i = 0; i < prefix.length; i++) {
		const c = prefix[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "#" && (i === 0 || /\s/.test(prefix[i - 1] ?? "")))
			return false;
	}
	return quote === null;
}

/**
 * @param {string} sourced
 * @param {string} source
 * @returns {string}
 */
function expandSourced(sourced, source) {
	let arg = unquotedDefaults(sourced);
	for (let hop = 0; hop < MAX_ASSIGN_HOPS; hop++) {
		const lead =
			/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(arg);
		const name = lead?.[1] ?? lead?.[2];
		if (!lead || !name) break;
		const bare = escapeRe(name);
		const assign = new RegExp(
			`^[ \\t]*(?:(?:export|local|readonly|declare)[ \\t]+)?${bare}=(\\S.*)$`,
			"gm",
		);
		const [only, ...more] = source.matchAll(assign);
		if (!only || more.length > 0) break;
		const elsewhere = new RegExp(
			`\\b${bare}=|\\b(?:for|read)\\b[^\\n]*\\b${bare}\\b`,
			"g",
		);
		if ([...source.matchAll(elsewhere)].length > 1) break;
		const raw = requiredGroup(only, 1, assign);
		const value = TOPLEVEL.test(raw) ? "." : unquotedDefaults(raw);
		arg = value + arg.slice(lead[0].length);
	}
	return arg;
}

/**
 * @param {string} sourced
 * @param {string[]} dir
 * @returns {{ tail: string, candidates: (string | null)[] }}
 */
function sourceCandidates(sourced, dir) {
	const arg = SOURCE_ARG.exec(sourced);
	const argTail = arg?.groups?.tail;
	if (arg && argTail === undefined)
		throw new Error(`SOURCE_ARG matched ${sourced} with no tail group`);
	const tail = argTail === undefined ? "" : argTail.replace(/^\//, "");
	/** @type {(string | null)[]} */
	const candidates = [];
	if (arg) {
		candidates.push(resolveDirPath(dir, tail));
		if (!/^\$(?:\(|\{BASH_SOURCE)/.test(arg.groups?.dirVar ?? ""))
			candidates.push(resolveDirPath([], tail));
	}
	return { tail, candidates };
}

/**
 * @param {string} source
 * @param {number | undefined} at
 * @param {string} tail
 * @returns {boolean}
 */
function isExcusedSource(source, at, tail) {
	if (/[\\(]$/.test(source.slice(0, at).trimEnd())) return true;
	const bare = escapeRe(tail.replace(/^\.\//, ""));
	const guard = `(?:\\[|\\btest)\\s+-f\\s+["']?(?:\\./)?${bare}["']?\\s`;
	return !!tail && new RegExp(guard).test(source);
}

/**
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} tracked
 * @returns {{ deps: string[], warnings: string[] }}
 */
function scriptDeps(file, source, tracked) {
	if (NODE_SCRIPT.test(file))
		return { deps: [...importedHelpers(source, file, tracked)], warnings: [] };
	const deps = [];
	const warnings = [];
	const dir = file.split("/").slice(0, -1);
	for (const m of source.matchAll(SOURCE_LINE)) {
		const lineStart = source.lastIndexOf("\n", m.index - 1) + 1;
		if (!opensCommand(source.slice(lineStart, m.index))) continue;
		const sourced = requiredGroup(m, 1, SOURCE_LINE);
		const { tail, candidates } = sourceCandidates(sourced, dir);
		const expanded = sourceCandidates(expandSourced(sourced, source), dir);
		const hit = [...expanded.candidates, ...candidates].find(
			(c) => c && tracked.has(c),
		);
		if (hit) {
			deps.push(hit);
			continue;
		}
		if (isExcusedSource(source, m.index, tail)) continue;
		warnings.push(
			`${file}: source ${sourced.trim()} resolves to no tracked file`,
		);
	}
	return { deps, warnings };
}

const SHAPE = {
	variable: (/** @type {string} */ name) =>
		`a path segment held in \`${name}\``,
	template: "a template literal with an interpolation it cannot resolve",
	spread: "a spread argument",
	computed: "a computed path argument",
	otherCall: "a path run spread across an array `join` or `+`",
	composed: "a path composed through a declared name",
	listing: "a listing whose directory it cannot trace",
	pathspec: "a `git ls-files` or `git grep` pathspec that is not a literal",
	grepFlags:
		"a `git grep` flag reading a pattern file, or one that is not a literal",
	wholeTree:
		"a `git ls-files` naming no pathspec, or a `git grep` none after `--` or reading untracked files, the whole tree",
	gitDir:
		"a `git -C` directory it cannot trace, or whose listing mints no edge",
	gitOption:
		"a git global option it does not read: `--git-dir`, `--work-tree`, or one but `-C` and `-c`",
};

/** @typedef {{ line: number, shape: string }} Site */

/** @typedef {{ path: string } | { unseen: string }} Resolution */

/**
 * @typedef {{ source: string, spans: [number, number][], dir: string,
 *  tracked: Set<string>, seen: (p: string) => boolean, site: number,
 *  decls: Map<string, string[]> }} SiteScan
 */

const PATH_CALL = /^path\.(?:resolve|join)\(/;

const FILE_READS = "readFileSync|readFile|readJsonl";

const FILE_READ = new RegExp(`\\b(?:${FILE_READS})\\(`);

const READ_CALL = new RegExp(`\\b(${FILE_READS}|readdirSync|readdir)\\(`, "g");

const READ_OR_LIST = new RegExp(
	`${READ_CALL.source}|["'](?:ls-files|grep)["']`,
);

const FULL_SWEEP_ONLY = /^(?:[^\S\n\r\u2028\u2029]|[/*])*full-sweep-only:/m;

// #1881 guess: the most any test held on 17 Oct 2026 was a handful
const MAX_ALTERNATIVES = 256;

const DIR_CLASS_CALL = new RegExp(`^${DIR_CLASS.source}$`);

/** @param {[number, number][]} spans @param {number} i */
function isCode(spans, i) {
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [first, last] = /** @type {[number, number]} */ (spans[mid]);
		if (i < first) hi = mid - 1;
		else if (i > last) lo = mid + 1;
		else return false;
	}
	return true;
}

/**
 * @param {string} source
 * @param {[number, number][]} spans
 */
function headerOf(source, spans) {
	let i = 0;
	for (const [first, last] of spans) {
		while (/\s/.test(source.charAt(i))) i++;
		if (first !== i || source.charAt(i) !== "/") break;
		i = last + 1;
	}
	return source.slice(0, i);
}

/** @param {SiteScan} scan @param {string} name @returns {string[]} */
function declInits(scan, name) {
	const known = scan.decls.get(name);
	if (known) return known;
	const decl = new RegExp(
		`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]+)?=\\s*`,
		"g",
	);
	const out = [];
	for (const m of scan.source.matchAll(decl)) {
		if (!isCode(scan.spans, m.index ?? 0)) continue;
		const at = (m.index ?? 0) + m[0].length;
		const rest = scan.source.slice(at);
		const head = PATH_CALL.exec(rest) ?? /^\[/.exec(rest);
		const quoted = /^(["'`])[^"'`\n]*\1/.exec(rest);
		const bare = new RegExp(
			`^(?:${IDENT_SRC}|${ROOT_CALLS}|process\\.cwd\\(\\))(?=\\s*[;,)\\n])`,
		).exec(rest);
		if (head) {
			const end = closeOf(scan.source, at + head[0].length - 1);
			out.push(end === -1 ? "" : scan.source.slice(at, end));
		} else out.push(quoted?.[0] ?? bare?.[0] ?? "");
	}
	scan.decls.set(name, out);
	return out;
}

/** @typedef {{ lits: string[] } | { listed: string[] }} Elements */

const KEEPS_ELEMENTS = /^\.\s*(?:filter|sort|toSorted|slice|reverse)\(/;

const DIRENT_NAMES =
	/^\.\s*map\(\s*(?:\(\s*)?([\w$]+)\s*(?:\)\s*)?=>\s*\1\.name\s*\)/;

const LS_FILES_CALL =
	/^(?:execFileSync|spawnSync)\(\s*["']git["']\s*,\s*\[\s*["']ls-files["']/;

const WALKS = "filter|map|flatMap|find|findIndex|some|every|forEach";

/** @param {SiteScan} scan @param {number} close */
function openOf(scan, close) {
	let depth = 0;
	for (let i = close; i >= 0; i--) {
		if (!isCode(scan.spans, i)) continue;
		const c = scan.source.charAt(i);
		if (")]}".includes(c)) depth++;
		else if ("([{".includes(c) && --depth === 0) return i;
	}
	return -1;
}

/** @param {SiteScan} scan @param {number} dot */
function receiverOf(scan, dot) {
	const src = scan.source;
	let at = dot;
	for (;;) {
		const head = linkStart(scan, lastNonSpace(src, at - 1));
		if (head === -1) return null;
		const k = lastNonSpace(src, head - 1);
		if (src.charAt(k) !== "." || src.slice(k - 2, k + 1) === "...")
			return src.slice(head, dot).trim();
		at = k;
	}
}

/**
 * @param {string} src
 * @param {number} i
 */
function lastNonSpace(src, i) {
	let j = i;
	while (j >= 0 && /\s/.test(src.charAt(j))) j--;
	return j;
}

/** @param {SiteScan} scan @param {number} end */
function linkStart(scan, end) {
	let j = end;
	let head = -1;
	if (")]".includes(scan.source.charAt(j))) {
		head = openOf(scan, j);
		if (head === -1) return -1;
		j = head - 1;
	}
	const ident = /(?<![\w$])[\w$]+$/.exec(scan.source.slice(0, j + 1));
	return ident ? ident.index : head;
}

/** @param {SiteScan} scan @param {string} name @returns {string[]} */
function declExprs(scan, name) {
	const decl = new RegExp(
		`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]+)?=\\s*`,
		"g",
	);
	const out = [];
	for (const m of scan.source.matchAll(decl)) {
		if (!isCode(scan.spans, m.index ?? 0)) continue;
		const at = (m.index ?? 0) + m[0].length;
		out.push(scan.source.slice(at, statementEnd(scan, at)).trim());
	}
	return out;
}

/** @param {SiteScan} scan @param {string} name */
function isChangedAfter(scan, name) {
	const n = escapeRe(name);
	const member = "(?:\\s*(?:\\.\\s*[\\w$]+|\\[[^\\]]*\\]))*";
	const change = new RegExp(
		`(?<![\\w$.]|(?:const|let|var)\\s+)${n}${member}\\s*(?:[-+*/|&?]{0,3}=(?![=>])|\\.\\s*(?:push|unshift|splice|fill|copyWithin|add)\\()|Object\\s*\\.\\s*assign\\(\\s*${n}\\b`,
		"g",
	);
	for (const m of scan.source.matchAll(change))
		if (isCode(scan.spans, m.index ?? 0)) return true;
	return false;
}

/** @param {SiteScan} scan @param {number} at */
function statementEnd(scan, at) {
	let end = at;
	while (end < scan.source.length) {
		const c = scan.source.charAt(end);
		if (!isCode(scan.spans, end)) end++;
		else if ("([{".includes(c)) {
			const close = closeOf(scan.source, end);
			if (close === -1) break;
			end = close;
		} else if (c === ";") break;
		else end++;
	}
	return end;
}

/**
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} hops
 * @returns {Elements | null}
 */
function elementsOfExpr(scan, expr, hops) {
	const e = expr.trim();
	const head = /^(?:fs\s*\.\s*)?readdirSync\(/.exec(e) ?? LS_FILES_CALL.exec(e);
	let found = null;
	const wrap = WRAPS_ELEMENTS.exec(e);
	if (head) found = listingHead(scan, e, head[0].includes("ls-files"));
	else if (e.startsWith("[")) found = arrayHead(scan, e, hops);
	else if (wrap) found = wrappedHead(scan, e, wrap, hops);
	else found = declaredHead(scan, e, hops);
	if (!found) return null;
	return isElementKeeping(found.rest, found.held) ? found.held : null;
}

/**
 * @param {SiteScan} scan
 * @param {string} e
 * @param {boolean} listsFiles
 * @returns {{ held: Elements, rest: string } | null}
 */
function listingHead(scan, e, listsFiles) {
	const open = e.indexOf("(");
	const close = closeOf(e, open);
	if (close === -1) return null;
	const args = topLevelArgs(e.slice(open + 1, close - 1));
	const cwd = listsFiles ? optionCwd(args[2] ?? "") : (args[0] ?? "");
	const reached = cwd === null ? [{ path: "" }] : resolveExpr(scan, cwd);
	const dirs = reached.flatMap((r) => ("path" in r ? [r.path] : []));
	if (dirs.length === 0) return null;
	if (!listsFiles) return { held: { listed: dirs }, rest: e.slice(close) };
	const out = e
		.slice(close)
		.replace(/^\s*\.\s*stdout\b/, "")
		.replace(/^\s*\.\s*trim\(\)/, "");
	const split = /^\s*\.\s*split\(/.exec(out);
	if (!split) return null;
	const end = closeOf(out, split[0].length - 1);
	return end === -1 ? null : { held: { listed: [""] }, rest: out.slice(end) };
}

/**
 * @param {SiteScan} scan
 * @param {string} e
 * @param {number} hops
 * @returns {{ held: Elements, rest: string } | null}
 */
function arrayHead(scan, e, hops) {
	const close = closeOf(e, 0);
	const lits =
		close === -1 ? null : arrayElements(scan, e.slice(0, close), hops);
	return lits && { held: { lits }, rest: e.slice(close) };
}

/**
 * @param {SiteScan} scan
 * @param {string} text
 * @param {number} hops
 * @returns {string[] | null}
 */
function arrayElements(scan, text, hops) {
	if (!text.startsWith("[") || closeOf(text, 0) !== text.length) return null;
	const lits = [];
	for (const el of topLevelArgs(text.slice(1, -1))) {
		const lit = literalArg(el);
		const spread = el.startsWith("...")
			? elementsOfExpr(scan, el.slice(3), hops)
			: null;
		if (lit !== null) lits.push(lit);
		else if (spread && "lits" in spread) lits.push(...spread.lits);
		else return null;
	}
	return lits;
}

const WRAPS_ELEMENTS =
	/^(?:(?<copy>new\s+Set|Array\s*\.\s*from)|Object\s*\.\s*values)\(/;

/**
 * @param {SiteScan} scan
 * @param {string} e
 * @param {RegExpExecArray} call
 * @param {number} hops
 * @returns {{ held: Elements, rest: string } | null}
 */
function wrappedHead(scan, e, call, hops) {
	const close = closeOf(e, call[0].length - 1);
	if (close === -1) return null;
	const arg = e.slice(call[0].length, close - 1).trim();
	const rest = e.slice(close);
	if (call.groups?.copy) {
		const held = elementsOfExpr(scan, arg, hops);
		return held && { held, rest };
	}
	const vals = objectValues(scan, arg, hops);
	if (!vals) return null;
	if (!vals.nested) return { held: { lits: vals.lits }, rest };
	const flat = /^\s*\.\s*flat\(\s*\)/.exec(rest);
	return (
		flat && { held: { lits: vals.lits }, rest: rest.slice(flat[0].length) }
	);
}

/** @typedef {{ lits: string[], nested: boolean }} ObjectValues */

/**
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} hops
 * @returns {ObjectValues | null}
 */
function objectValues(scan, expr, hops) {
	if (!IDENT.test(expr)) return objectLiteralValues(scan, expr, hops);
	const inits = declaredAs(scan, expr, hops, objectValues);
	if (!inits || inits.length === 0 || inits.includes(null)) return null;
	const all = /** @type {ObjectValues[]} */ (inits);
	return {
		lits: all.flatMap((v) => v.lits),
		nested: all.some((v) => v.nested),
	};
}

/**
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} hops
 * @returns {ObjectValues | null}
 */
function objectLiteralValues(scan, expr, hops) {
	if (!expr.startsWith("{") || closeOf(expr, 0) !== expr.length) return null;
	const out = { lits: /** @type {string[]} */ ([]), nested: false };
	for (const entry of topLevelArgs(expr.slice(1, -1))) {
		const key = /^(?:"[^"]*"|'[^']*'|[\w$]+)\s*:\s*/.exec(entry);
		if (!key) return null;
		const value = entry.slice(key[0].length);
		const lit = literalArg(value);
		const arr = lit === null ? arrayElements(scan, value, hops) : null;
		if (lit !== null) out.lits.push(lit);
		else if (arr) {
			out.lits.push(...arr);
			out.nested = true;
		} else return null;
	}
	return out;
}

/**
 * @template T
 * @param {SiteScan} scan
 * @param {string} name
 * @param {number} hops
 * @param {(scan: SiteScan, init: string, hops: number) => T} read
 * @returns {T[] | null}
 */
function declaredAs(scan, name, hops, read) {
	if (hops <= 0 || isChangedAfter(scan, name)) return null;
	return declExprs(scan, name).map((i) => read(scan, i, hops - 1));
}

/**
 * @param {SiteScan} scan
 * @param {string} e
 * @param {number} hops
 * @returns {{ held: Elements, rest: string } | null}
 */
function declaredHead(scan, e, hops) {
	const ident = IDENT_HEAD.exec(e)?.[0];
	if (!ident) return null;
	const inits = declaredAs(scan, ident, hops, elementsOfExpr);
	const held = inits && mergeElements(inits);
	return held && { held, rest: e.slice(ident.length) };
}

/** @param {(Elements | null)[]} parts @returns {Elements | null} */
function mergeElements(parts) {
	if (parts.length === 0 || parts.includes(null)) return null;
	const all = /** @type {Elements[]} */ (parts);
	if (all.every((p) => "lits" in p))
		return { lits: all.flatMap((p) => ("lits" in p ? p.lits : [])) };
	if (all.every((p) => "listed" in p))
		return { listed: all.flatMap((p) => ("listed" in p ? p.listed : [])) };
	return null;
}

/** @param {string} rest @param {Elements} held */
function isElementKeeping(rest, held) {
	let t = rest.trimStart();
	while (t) {
		const names = "listed" in held ? DIRENT_NAMES.exec(t) : null;
		const keep = names ? null : KEEPS_ELEMENTS.exec(t);
		if (!names && !keep) return false;
		const end = names
			? names[0].length
			: closeOf(t, /** @type {RegExpExecArray} */ (keep)[0].length - 1);
		if (end === -1) return false;
		t = t.slice(end).trimStart();
	}
	return true;
}

/** @param {SiteScan} scan @param {string} name @returns {Binding[]} */
function elementBindings(scan, name) {
	const n = escapeRe(name);
	const param = `(?:async\\s+)?(?:\\(\\s*${n}\\s*(?::[^,)=]+)?(?:,[^)]*)?\\)(?:\\s*:[^=()]*?)?|${n})\\s*=>`;
	return [
		...loopBindings(scan, n),
		...callbackBindings(scan, param),
		...eachBindings(scan, param),
	];
}

/**
 * @typedef {{ collection: string, from: number, to: number }} Binding
 */

/** @param {SiteScan} scan @param {string} n @returns {Binding[]} */
function loopBindings(scan, n) {
	const src = scan.source;
	const out = [];
	const loop = new RegExp(
		`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+of\\s+`,
		"g",
	);
	for (const m of src.matchAll(loop)) {
		const from = m.index ?? 0;
		const close = closeOf(src, src.indexOf("(", from));
		if (close === -1 || !isCode(scan.spans, from)) continue;
		const body = close + (/^\s*/.exec(src.slice(close))?.[0].length ?? 0);
		const to =
			src.charAt(body) === "{" ? closeOf(src, body) : statementEnd(scan, body);
		out.push({
			collection: src.slice(from + m[0].length, close - 1),
			from,
			to,
		});
	}
	return out;
}

/** @param {SiteScan} scan @param {string} param @returns {Binding[]} */
function callbackBindings(scan, param) {
	const src = scan.source;
	const out = [];
	for (const m of src.matchAll(
		new RegExp(`\\.\\s*(?:${WALKS})\\(\\s*${param}`, "g"),
	)) {
		const dot = m.index ?? 0;
		const open = src.indexOf("(", dot);
		const collection = isCode(scan.spans, dot) ? receiverOf(scan, dot) : null;
		if (collection)
			out.push({ collection, from: open, to: closeOf(src, open) });
	}
	return out;
}

/** @param {SiteScan} scan @param {string} param @returns {Binding[]} */
function eachBindings(scan, param) {
	const src = scan.source;
	const out = [];
	for (const m of src.matchAll(/\b(?:it|test|describe)\.each\(/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = closeOf(src, open);
		const call = close === -1 ? null : /^\s*\(/.exec(src.slice(close));
		if (!call || !isCode(scan.spans, open)) continue;
		const from = close + call[0].length - 1;
		const to = closeOf(src, from);
		const [, cb] = topLevelArgs(src.slice(from + 1, to - 1));
		if (cb && new RegExp(`^${param}`).test(cb))
			out.push({ collection: src.slice(open + 1, close - 1), from, to });
	}
	return out;
}

/** @param {SiteScan} scan @param {string} name @returns {Elements | null} */
function boundElements(scan, name) {
	const near = elementBindings(scan, name)
		.filter((b) => b.from < scan.site && scan.site < b.to)
		.sort((a, b) => b.from - a.from)[0];
	return near ? elementsOfExpr(scan, near.collection, TRACE_HOPS) : null;
}

/** @param {SiteScan} scan @param {string} name @returns {Elements | null} */
function paramValues(scan, name) {
	const nearest = nearestDeclaring(scan, name);
	if (!nearest) return null;
	const { fn, open, at } = nearest;
	const rest = paramsOf(scan.source, open)[at]?.startsWith("...") ?? false;
	const passed = callArgs(scan.source, fn, open).map((call) =>
		passedValue(scan, call, at, rest),
	);
	return mergeElements(passed);
}

/**
 * @param {SiteScan} scan
 * @param {{ at: number, args: string[] }} call
 * @param {number} at
 * @param {boolean} rest
 * @returns {Elements | null}
 */
function passedValue(scan, call, at, rest) {
	const passed = call.args.slice(at, rest ? undefined : at + 1);
	const run = passed.map(literalArg);
	if (run.length > 0 && !run.includes(null)) return { lits: [run.join("/")] };
	const [only] = passed;
	if (passed.length !== 1 || !only || !IDENT.test(only)) return null;
	return boundElements({ ...scan, site: call.at }, only);
}

/**
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {{ fn: string, open: number, at: number } | undefined}
 */
function nearestDeclaring(scan, name) {
	let nearest;
	for (const h of scan.source.matchAll(FUNCTION_HEAD)) {
		const fn = h[1] ?? h[2];
		const open = (h.index ?? 0) + h[0].length - 1;
		if (open > scan.site) break;
		const at = fn ? paramIndex(scan.source, open, name) : -1;
		if (fn && at !== -1) nearest = { fn, open, at };
	}
	return nearest;
}

/** @param {SiteScan} scan @param {string} name @returns {Elements | null} */
function boundValues(scan, name) {
	const walked = boundElements(scan, name);
	if (walked) return walked;
	return paramValues(scan, name);
}

/** @param {string} init @returns {string | null} */
function initSegment(init) {
	const lit = literalArg(init);
	if (lit !== null || !PATH_CALL.test(init)) return lit;
	const open = init.indexOf("(");
	if (closeOf(init, open) !== init.length) return null;
	const lits = topLevelArgs(init.slice(open + 1, -1)).map(literalArg);
	return lits.length === 0 || lits.includes(null) ? null : lits.join("/");
}

/**
 * @param {SiteScan} scan
 * @param {string} arg
 * @param {number} hops
 * @returns {string[] | { unseen: string } | { listed: string[], name: string }}
 */
function segmentsOf(scan, arg, hops) {
	const lit = literalArg(arg) ?? QUOTED.exec(arg)?.[2] ?? null;
	if (lit !== null) return [lit];
	const spread = /^\.\.\.\s*(\S+)$/.exec(arg)?.[1];
	if (spread !== undefined) {
		const bound = IDENT.test(spread) ? boundValues(scan, spread) : null;
		return bound && "lits" in bound ? bound.lits : { unseen: SHAPE.spread };
	}
	if (arg.startsWith("`")) return { unseen: SHAPE.template };
	if (!IDENT.test(arg)) return { unseen: SHAPE.computed };
	const inits = hops > 0 ? declInits(scan, arg).map(initSegment) : [];
	if (inits.length > 0 && !inits.includes(null))
		return /** @type {string[]} */ (inits);
	const bound = boundValues(scan, arg);
	if (!bound) return { unseen: SHAPE.variable(arg) };
	return "lits" in bound ? bound.lits : { listed: bound.listed, name: arg };
}

/** @param {Resolution[]} bases @param {string[]} tails @returns {Resolution[]} */
function joinAll(bases, tails) {
	return bases.flatMap((b) => {
		if ("unseen" in b) return [b];
		return tails.flatMap((t) => {
			const r = resolveDirPath(b.path ? b.path.split("/") : [], t);
			return r === null ? [] : [/** @type {Resolution} */ ({ path: r })];
		});
	});
}

/** @param {SiteScan} scan @param {string} call @param {number} hops @returns {Resolution[]} */
function resolveJoin(scan, call, hops) {
	const open = call.indexOf("(");
	if (closeOf(call, open) !== call.length) return [];
	const [base, ...rest] = topLevelArgs(call.slice(open + 1, -1));
	const bases = base === undefined ? [] : resolveExpr(scan, base, hops);
	if (bases.length === 0 || DIR_CLASS_CALL.test(call)) return [];
	let tails = [""];
	for (const [i, arg] of rest.entries()) {
		const segs = segmentsOf(scan, arg, hops);
		if ("listed" in segs) {
			const unseen = { unseen: SHAPE.variable(segs.name) };
			if (i < rest.length - 1)
				return bases.map((b) => ("unseen" in b ? b : unseen));
			return joinAll(bases, tails).flatMap((p) => {
				if ("unseen" in p) return [p];
				return segs.listed.includes(p.path) ? [] : [unseen];
			});
		}
		if (!Array.isArray(segs))
			return bases.map((b) => ("unseen" in b ? b : segs));
		tails = tails
			.flatMap((t) => segs.map((s) => (t ? `${t}/${s}` : s)))
			.slice(0, MAX_ALTERNATIVES);
	}
	return joinAll(bases, tails);
}

const TEMPLATE_HEAD = /^`\$\{([^}`]+)\}([^`]*)`$/;

/** @param {SiteScan} scan @param {string} tpl @param {number} hops @returns {Resolution[]} */
function resolveTemplate(scan, tpl, hops) {
	const m = TEMPLATE_HEAD.exec(tpl);
	if (!m) return [];
	const bases = resolveExpr(scan, requiredGroup(m, 1, TEMPLATE_HEAD), hops);
	const tail = requiredGroup(m, 2, TEMPLATE_HEAD);
	if (/^[A-Za-z0-9_./-]*$/.test(tail)) return joinAll(bases, [tail]);
	return bases.length > 0 ? [{ unseen: SHAPE.template }] : [];
}

/** @param {string} e @returns {string | null} */
function spreadRunHead(e) {
	if (e.startsWith("[") && /^\]\s*\.join\(/.test(e.slice(closeOf(e, 0) - 1)))
		return topLevelArgs(e.slice(1, closeOf(e, 0) - 1))[0] ?? null;
	return (
		new RegExp(`^(${IDENT_SRC}|${ROOT_CALLS}|process\\.cwd\\(\\))\\s*\\+`).exec(
			e,
		)?.[1] ?? null
	);
}

/**
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} [hops]
 * @returns {Resolution[]}
 */
function resolveExpr(scan, expr, hops = TRACE_HOPS) {
	const e = expr.trim();
	if (PATH_CALL.test(e)) return resolveJoin(scan, e, hops);
	if (e.startsWith("`")) return resolveTemplate(scan, e, hops);
	if (DIRNAME_ANCHORS.has(e)) return [{ path: scan.dir }];
	if (ROOT_CALL.test(e)) return [{ path: "" }];
	const run = spreadRunHead(e);
	if (run !== null)
		return resolveExpr(scan, run, hops).length > 0
			? [{ unseen: SHAPE.otherCall }]
			: [];
	if (!IDENT.test(e)) return [];
	const inits = declInits(scan, e);
	if (inits.length === 0) return ROOT_NAME.test(e) ? [{ path: "" }] : [];
	return hops > 0 ? inits.flatMap((i) => resolveExpr(scan, i, hops - 1)) : [];
}

/**
 * @param {SiteScan} scan
 * @param {string} arg
 * @param {boolean} listing
 * @returns {string | null}
 */
function readShape(scan, arg, listing) {
	for (const r of resolveExpr(scan, arg)) {
		if ("unseen" in r) return r.unseen;
		if (!listing) {
			if (scan.tracked.has(r.path) && !scan.seen(r.path)) return SHAPE.composed;
			continue;
		}
		const prefix = r.path ? `${r.path}/` : "";
		const under = [...scan.tracked].filter((p) => p.startsWith(prefix));
		if (under.length > 0 && !under.some(scan.seen)) return SHAPE.listing;
	}
	return null;
}

const GIT_CALL =
	/\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*["']git["']\s*,\s*$/;

/** @param {SiteScan} scan @param {number} after */
function isRunInRepo(scan, after) {
	const opts = /^\s*,\s*\{/.exec(scan.source.slice(after));
	if (!opts) return true;
	const open = after + opts[0].length - 1;
	const close = closeOf(scan.source, open);
	if (close === -1) return false;
	const cwd = optionCwd(scan.source.slice(open, close));
	return cwd === null || resolveExpr(scan, cwd).length > 0;
}

/** @param {string} opts */
function optionCwd(opts) {
	if (!opts.startsWith("{")) return null;
	for (const entry of topLevelArgs(opts.slice(1, -1))) {
		const cwd = /^cwd\b\s*(?::\s*(\S[\s\S]*))?$/.exec(entry);
		if (cwd) return cwd[1] ?? "cwd";
	}
	return null;
}

/** @param {SiteScan} scan @param {string[]} elements @returns {string | null} */
function listingShape(scan, elements) {
	if (isGrepReadingFlagFile(elements)) return SHAPE.grepFlags;
	if (splitListing(elements).flags.some((el) => GREP_UNTRACKED.test(el)))
		return SHAPE.wholeTree;
	const { specs, unreadable } = parsePathspecs(scan.source, elements);
	if (unreadable) return SHAPE.pathspec;
	const isRoot = (/** @type {string} */ sp) => resolveDirPath([], sp) === "";
	return specs.length === 0 || specs.some(isRoot) ? SHAPE.wholeTree : null;
}

/**
 * @param {SiteScan} scan
 * @param {string[]} dirArgs
 * @param {string[]} specs
 * @returns {boolean}
 */
function isDirUnseen(scan, dirArgs, specs) {
	const dirs = foldDirArgs([""], dirArgs, (v) => {
		const found = resolveExpr(scan, v);
		if (found.length === 0 || found.some((r) => "unseen" in r)) return null;
		return found.flatMap((r) => ("path" in r ? [r.path] : []));
	});
	if (dirs === null) return true;
	return dirs.some((dir) => {
		const listed = [...scan.tracked].filter(listingMatcher(specs, dir));
		return listed.length > 0 && !listed.some(scan.seen);
	});
}

/** @typedef {{ at: number, shape: string } | null} Found */

/** @param {SiteScan} test @param {RegExpExecArray} m @returns {Found} */
function readCallShape(test, m) {
	const call = readCallArg(test, m);
	if (!call) return null;
	const scan = { ...test, site: call.site };
	const listing = requiredGroup(m, 1, READ_CALL).startsWith("readdir");
	const shape = readShape(scan, call.arg, listing);
	return shape ? { at: call.site, shape } : null;
}

/**
 * @param {SiteScan} scan
 * @param {RegExpExecArray} m
 * @returns {{ site: number, arg: string } | null}
 */
function readCallArg(scan, m) {
	const site = m.index ?? 0;
	if (!isCode(scan.spans, site)) return null;
	const open = site + m[0].length - 1;
	const close = closeOf(scan.source, open);
	if (close === -1) return null;
	const [arg] = topLevelArgs(scan.source.slice(open + 1, close - 1));
	return arg === undefined ? null : { site, arg };
}

/** @param {SiteScan} test @param {RegExpExecArray} m @returns {Found} */
function listingCallShape(test, m) {
	const scan = { ...test, site: m.index ?? 0 };
	const listing = parseGitListing(scan.source, scan.site);
	if (!isCode(scan.spans, scan.site) || !listing) return null;
	if (!GIT_CALL.test(scan.source.slice(0, scan.site))) return null;
	const { elements, dirArgs, unread } = listing;
	const rooted = dirArgs.length > 0 && literalArg(dirArgs[0] ?? "") === null;
	if (!rooted && !isRunInRepo(scan, listing.close)) return null;
	const unseenDir = () =>
		isDirUnseen(scan, dirArgs, parsePathspecs(scan.source, elements).specs);
	const shape =
		(unread ? SHAPE.gitOption : null) ??
		listingShape(scan, elements) ??
		(dirArgs.length > 0 && unseenDir() ? SHAPE.gitDir : null);
	return shape ? { at: scan.site, shape } : null;
}

/**
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {string} self
 * @param {(p: string) => boolean} seen
 * @returns {Site[]}
 */
function unseenSitesFor(source, tracked, self, seen) {
	if (!READ_OR_LIST.test(source)) return [];
	if (!ANCHOR.test(source) && !DIRNAME.test(source)) return [];
	const spans = inertSpans(source);
	const dir = self.split("/").slice(0, -1).join("/");
	/** @type {SiteScan} */
	const scan = { source, spans, dir, tracked, seen, site: 0, decls: new Map() };
	const found = [
		...[...source.matchAll(READ_CALL)].map((m) => readCallShape(scan, m)),
		...[...source.matchAll(GIT_LISTING)].map((m) => listingCallShape(scan, m)),
	];
	return found
		.filter((f) => f !== null)
		.map(({ at, shape }) => ({
			line: source.slice(0, at).split("\n").length,
			shape,
		}))
		.sort((a, b) => a.line - b.line);
}

/** @param {string} source */
const isFullSweepOnly = (source) =>
	FULL_SWEEP_ONLY.test(headerOf(source, inertSpans(source)));

/**
 * @param {Map<string, Set<string>>} byDoc
 * @param {string} p
 * @param {string} t
 * @returns {void}
 */
function addReader(byDoc, p, t) {
	const readers = byDoc.get(p) ?? new Set();
	readers.add(t);
	byDoc.set(p, readers);
}

/** #5575 @param {string} p */
const isTestSupport = (p) => isTestKind(p) && !isJsTestFile(p);

/**
 * @param {string} t
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {Set<string>}
 */
function helperReads(t, source, tracked, read) {
	const found = new Set();
	const seen = new Set([t]);
	const queue = [...importedHelpers(source, t, tracked)];
	while (queue.length > 0) {
		const helper = /** @type {string} */ (queue.pop());
		if (seen.has(helper)) continue;
		seen.add(helper);
		const code = blankComments(read(helper));
		for (const p of edgesFor(code, tracked, helper)) found.add(p);
		if (isTestSupport(helper))
			queue.push(...importedHelpers(code, helper, tracked));
	}
	return found;
}

/**
 * @param {string} t
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {Set<string>}
 */
function testReads(t, source, tracked, read) {
	const found = new Set(edgesFor(source, tracked, t));
	for (const p of ruleEdgesFor(source, tracked, t)) found.add(p);
	for (const p of helperReads(t, source, tracked, read))
		if (p !== t) found.add(p);
	for (const p of readPatchTargets(found, tracked, read))
		if (p !== t) found.add(p);
	return found;
}

/**
 * @param {Set<string>} found
 * @param {string} t
 * @param {(p: string) => string[]} launches
 * @returns {void}
 */
function addLaunches(found, t, launches) {
	for (const sh of [...found].filter((p) => p.endsWith(".sh")))
		for (const p of launches(sh)) if (p !== t) found.add(p);
}

const PATCH_TARGET = /^(?:---|\+\+\+) [ab]\/([^\t\n]+)/gm;

/**
 * @param {Set<string>} reads
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {string[]}
 */
const readPatchTargets = (reads, tracked, read) =>
	[...reads]
		.filter((p) => p.endsWith(".patch"))
		.flatMap((p) => [...read(p).matchAll(PATCH_TARGET)])
		.map((m) => requiredGroup(m, 1, PATCH_TARGET))
		.filter((p) => tracked.has(p));

const SHELL_PATH =
	/(?:^|[\s="'(:<>|;])(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)?(?:\.\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]|[A-Za-z0-9_-]+\.[A-Za-z0-9]+)/g;

/** @param {string} source @param {Set<string>} tracked @returns {string[]} */
function shellReadsOf(source, tracked) {
	const out = new Set();
	for (const m of shellOperands(source).matchAll(SHELL_PATH)) {
		const p = requiredGroup(m, 1, SHELL_PATH);
		if (tracked.has(p)) out.add(p);
	}
	return [...out].sort();
}

/**
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} tracked
 * @returns {string[]}
 */
function fileReadsOf(file, source, tracked) {
	if (!NODE_SCRIPT.test(file)) return shellReadsOf(source, tracked);
	if (!FILE_READ.test(source)) return [];
	return nodeReadsOf(file, source, tracked);
}

/**
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} tracked
 * @returns {string[]}
 */
function nodeReadsOf(file, source, tracked) {
	const spans = inertSpans(source);
	const dir = file.split("/").slice(0, -1).join("/");
	/** @type {SiteScan} */
	const scan = {
		source,
		spans,
		dir,
		tracked,
		seen: () => true,
		site: 0,
		decls: new Map(),
	};
	const out = new Set();
	for (const m of source.matchAll(READ_CALL)) {
		if (requiredGroup(m, 1, READ_CALL).startsWith("readdir")) continue;
		const call = readCallArg(scan, m);
		if (!call) continue;
		const bare = literalArg(call.arg)?.replace(/^\.\//, "");
		if (bare !== undefined && tracked.has(bare)) out.add(bare);
		for (const r of resolveExpr({ ...scan, site: call.site }, call.arg))
			if ("path" in r && r.path !== file && tracked.has(r.path))
				out.add(r.path);
	}
	return [...out].sort();
}

/**
 * @param {Map<string, Map<string, number>>} byClosure
 * @param {string} t
 * @param {Map<string, number>} depths
 * @returns {void}
 */
function addClosure(byClosure, t, depths) {
	for (const [d, depth] of depths) {
		const readers = byClosure.get(d) ?? new Map();
		readers.set(t, depth);
		byClosure.set(d, readers);
	}
}

/** @param {(p: string) => string[]} fn @returns {(p: string) => string[]} */
function once(fn) {
	/** @type {Map<string, string[]>} */
	const kept = new Map();
	return (p) => {
		let answer = kept.get(p);
		if (!answer) {
			answer = fn(p);
			kept.set(p, answer);
		}
		return answer;
	};
}

/**
 * @param {Map<string, Set<string>>} byDoc
 * @param {Map<string, Map<string, number>>} byClosure
 * @param {Set<string>} esm
 * @returns {void}
 */
function addNearestReaders(byDoc, byClosure, esm) {
	for (const [p, readers] of byClosure) {
		if (byDoc.has(p) || esm.has(p) || isJsTestFile(p)) continue;
		const nearest = Math.min(...readers.values());
		for (const [t, depth] of readers)
			if (depth === nearest) addReader(byDoc, p, t);
	}
}

/**
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @param {{ sites?: boolean }} [opts]
 * @returns {{ edges: Record<string, string[]>, anchored: number, tests: number, warnings: string[], unseen: Record<string, Site[]> }}
 */
function buildManifest(tracked, read, { sites: findSites = false } = {}) {
	const tests = [...tracked].filter(isJsTestFile).sort();
	/** @type {Map<string, Set<string>>} */
	const byDoc = new Map();
	/** @type {Map<string, Map<string, number>>} */
	const byClosure = new Map();
	/** @type {string[]} */
	const warnings = [];
	const loadsOnce = once((p) => {
		const found = scriptDeps(p, read(p), tracked);
		warnings.push(...found.warnings);
		return found.deps;
	});
	const readsOnce = once((p) => {
		const loaded = new Set(loadsOnce(p));
		return fileReadsOf(p, read(p), tracked).filter((r) => !loaded.has(r));
	});
	const launchesOnce = once((p) =>
		parseEdges(p, read(p), {
			kinds: ["launch"],
			isFile: (c) => tracked.has(c),
		}).flatMap((e) => [e.to, ...loadsOnce(e.to)]),
	);
	const coreEdges = buildCoreEdges(tracked, read);
	/** @type {Record<string, Site[]>} */
	const unseen = {};
	for (const t of tests) {
		const source = read(t);
		warnings.push(...untrackedLoads(source, tracked, t));
		const found = testReads(t, source, tracked, read);
		for (const p of coreEdges(t, source, found)) found.add(p);
		addLaunches(found, t, launchesOnce);
		addClosure(byClosure, t, closureDepths(t, found, loadsOnce, readsOnce));
		for (const p of ownModules(t, tracked)) found.add(p);
		for (const p of found) addReader(byDoc, p, t);
		if (!findSites || isFullSweepOnly(source)) continue;
		/** @type {Set<string> | undefined} */
		let imports;
		const sites = unseenSitesFor(source, tracked, t, (p) => {
			if (found.has(p)) return true;
			imports ??= vitestImports(source, t, tracked);
			return imports.has(p);
		});
		if (sites.length > 0) unseen[t] = sites;
	}
	addNearestReaders(byDoc, byClosure, esmReach(tests, tracked, read));
	/** @type {Record<string, string[]>} */
	const edges = {};
	for (const [p, readers] of [...byDoc].sort(([a], [b]) => byCodeUnit(a, b)))
		edges[p] = [...readers].sort();
	const anchored = new Set([...byDoc.values()].flatMap((r) => [...r])).size;
	return { edges, anchored, tests: tests.length, warnings, unseen };
}

/**
 * @param {string} test
 * @param {Set<string>} reads
 * @param {(p: string) => string[]} loads
 * @param {(p: string) => string[]} scriptReads
 * @returns {Map<string, number>}
 */
function closureDepths(test, reads, loads, scriptReads) {
	/** @type {Map<string, number>} */
	const depths = new Map();
	/** @param {string} d @param {number} depth */
	const record = (d, depth) => {
		if (d === test || reads.has(d) || depths.has(d)) return false;
		depths.set(d, depth);
		return true;
	};
	let frontier = [...reads].filter(isScript);
	for (let depth = 1; frontier.length > 0; depth++) {
		/** @type {string[]} */
		const next = [];
		for (const s of frontier) {
			for (const d of loads(s))
				if (record(d, depth) && isScript(d)) next.push(d);
			for (const d of scriptReads(s)) record(d, depth);
		}
		frontier = next;
	}
	return depths;
}

/**
 * @param {string[]} tests
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {Set<string>}
 */
function esmReach(tests, tracked, read) {
	const reached = new Set();
	const queue = [...tests];
	while (queue.length > 0) {
		const p = /** @type {string} */ (queue.pop());
		if (!/\.(?:tsx?|[mc]?js)$/.test(p)) continue;
		for (const d of vitestImports(read(p), p, tracked))
			if (!reached.has(d)) {
				reached.add(d);
				queue.push(d);
			}
	}
	return reached;
}

/** @param {string[]} changed @param {Record<string, string[]>} edges @returns {string[]} */
function testsReading(changed, edges) {
	const out = new Set();
	for (const p of changed) for (const t of edges[p] ?? []) out.add(t);
	return [...out].sort();
}

/**
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @returns {Set<string>}
 */
const directImports = (source, self, tracked) =>
	new Set([
		...importedHelpers(source, self, tracked),
		...importedHelpers(source, self, tracked, ESM_IMPORT),
	]);

/**
 * @param {string} root
 * @param {string[]} args
 */
const gitOut = (root, args) =>
	execGit(args, {
		cwd: root,
		timeout: GIT_TIMEOUT_MS,
	});

/** @param {string} root @param {string[]} args */
const gitList = (root, args) =>
	gitOut(root, args).toString("utf8").split("\0").filter(Boolean);

/** @param {string} root */
function readWorkingTree(root) {
	const gone = new Set([
		...gitList(root, ["ls-files", "-z", "--deleted"]),
		// #5887
		...gitList(root, [
			"diff",
			"--name-only",
			"--no-renames",
			"--diff-filter=A",
			"-z",
		]),
	]);
	return {
		tracked: new Set(
			gitList(root, ["ls-files", "-z"]).filter((p) => !gone.has(p)),
		),
		read: (/** @type {string} */ p) =>
			fs.readFileSync(path.join(root, p), "utf8"),
	};
}

module.exports = {
	ANCHOR,
	LITERAL,
	buildManifest,
	directImports,
	gitList,
	gitOut,
	testsReading,
	readWorkingTree,
};
