#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { isUnder } = require("./lib/is-under.js");
const { escapeRe, requiredGroup } = require("./lib/regex-group");
const { worktreeRoot } = require("./lib/host-root.js");
const { readHookCode } = require("./lib/hook-code.js");
const { isJsExt } = require("./lib/test-kind.js");
const { isApparatus } = require("./lib/suite-apparatus.js");
const { segmentTailMatches } = require("./lib/line-scan.js");
const { blankComments } = require("./lib/strip-comments.js");
const { shipsPlugin } = require("./lib/plugin-state.js");
const { ignoreFailure } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");

/** @typedef {Pick<import("./lib/check").Ctx, "fail" | "warn">} Judge */

const CWD_SUITE_CHECKER = {
	tags: ["SECOND-SEAM-JS"],
	reason:
		"lists the tracked tests of the checkout it runs in; its suite drives it by cwd into fixture repos, where an inherited CLAUDE_PROJECT_DIR would aim it at the live tree",
};

/** @type {Record<string, {tags: string[], reason: string}>} */
const ALLOWED = {
	"scripts/lib/heresy-scan.js": {
		tags: ["HOST-ROOTED-CORE"],
		reason:
			"the heresy checks' subject is the host's own scripts/, which the --against re-run materialises at `root`; __dirname would name the plugin's copies instead (#3555)",
	},
	"scripts/lib/husky-shim.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"holds the shell line install-hooks.js writes husky's shim runs inside each git hook, whose subject is the tree git runs the hook in — CLAUDE_PROJECT_DIR there names the main checkout, the very copy the hook does not run (#3138)",
	},
	"scripts/proving-run.ts": {
		tags: ["SELF-ROOTED-JS", "SECOND-SEAM-JS"],
		reason: "a measurement harness whose subject is this checkout",
	},
	"scripts/wayfinder-frontier.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"compares the caller's own checkout with the claim store's tree; the working directory's top level IS the second tree, so it must not be the seam's answer",
	},
	"scripts/lib/resolve-core.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"the adopter's bootstrap, run before the core is found, so it cannot require the seam; it wants the main checkout the plugin was installed for, not a worktree's top level, and must answer with no harness variable set (#461)",
	},
	"scripts/lib/git-tree.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"readTopLevel reads the top level of the tree a command runs in — a linked worktree or another repo, not the host root — for every host port that needs it (#2785, #2883)",
	},
	"scripts/commit-paths.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"names the git processes holding the index lock it waits on, which belongs to the checkout the run is inside — in a linked worktree, not the host root (#585)",
	},
	"scripts/lib/isolated-worktree.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"its `run` CLI checks out the tree of the commit the hook is inside, over that checkout's own HEAD — in a linked worktree, not the host root (#1766)",
	},
	"scripts/check-cli-args.js": {
		tags: ["HOST-ROOTED-CORE"],
		reason:
			"its subject is the host's own scripts/, which the --against re-run materialises at `root`; __dirname would name the plugin's copies instead (#920, #1532)",
	},
	"scripts/check-registrations.js": {
		tags: ["HOST-ROOTED-CORE"],
		reason:
			"its subject is the host's own scripts/guard-* and check-*.js and the caller surfaces beside them, which the --against re-run materialises at `root`; the plugin's copies are the core's, held by its own tests (#1456)",
	},
	"scripts/check-context-budget.js": {
		tags: ["HOST-ROOTED-CORE"],
		reason:
			"readInjection() prefers the text module already materialised at `root` — every --against re-run and every self-hosted live run has one there, which is what lets a staged growth of the injector's own bytes still be caught — and falls back to TRACKER_TEXT_FILE (the core's own __dirname-relative copy) only on ENOENT, which is the plugin-install case this rule exists for (#36)",
	},
	"scripts/check-guard-registry.js": {
		tags: ["SELF-ROOTED-JS", "HOST-ROOTED-CORE"],
		reason:
			"CORE_ROOT is the second root the registry needs: an adopter's rules name the CORE's guards, which ship in the plugin and are never copied into the host repo, so a BROKEN-CLAIM would fire on every one of them (#5). rootIsCore() then joins a core script onto the HOST root deliberately — the absence it tests for is the whole discriminator, and this file is the checker's own example of it",
	},
	"scripts/lib/init-adopter-core.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"bootstraps a host repo FROM this checkout, so its own tree is the source it copies and the host's is --root (#5)",
	},
	"scripts/lib/rule-text.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"the fragment store falls back to the CORE's copy where the host has none — an adopter's rule text lives in the plugin, and a guard firing there must print it rather than an id (#5)",
	},
	"scripts/count-guard-fires.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"reads the plugin's own hooks/hooks.json, which ships at the plugin root beside scripts/ and registers the plugin's hooks, which an adopter's settings do not carry (#940)",
	},
	"scripts/score-session-breaches.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"reads the plugin's own hooks/hooks.json to attribute a deny to a guard the plugin registers, as count-guard-fires.js does (#2042)",
	},
	"scripts/lost-deny-rates.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"reads the plugin's own hooks/hooks.json and the guard sources and needles in its scripts/, none of which an adopter's host carries (#954)",
	},
	"scripts/lib/script-path.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"names a CORE script for a session to run, so it must answer the plugin install the core runs from, never the host, which has none of the core's scripts (#343)",
	},
	"scripts/check-plugin-gap.js": {
		tags: ["HOST-ROOTED-CORE"],
		reason:
			"buildHookRootBlock reads the adopter's own .husky/ hooks at `root` to check the plugin root they name (#1168) — the host's hooks are the subject, not a core file read through the host",
	},
	"scripts/check-suite-size-drift.js": CWD_SUITE_CHECKER,
	"scripts/lib/tracked-scripts.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"lists the tracked scripts/ files of the checkout it runs in for check-guard-test-isolation.js, check-host-root-test-isolation.js, check-git-fixture-identity.js and check-test-env-writes.js, whose suites drive them by cwd into fixture repos, where an inherited CLAUDE_PROJECT_DIR would aim them at the live tree (#3131)",
	},
};

const SCANNED = ["scripts"];

const buildPathCall = (/** @type {string} */ names) =>
	String.raw`(?:\b(?:path|nodePath)\.|(?<![\w$.]))(?:${names})\(\s*`;

const FILE_URL = String.raw`(?:\burl\.)?fileURLToPath\(\s*import\.meta\.url\s*\)`;

const JS_FILE = String.raw`import\.meta\.filename\b|${FILE_URL}`;

const JS_DIR = String.raw`__dirname\b|import\.meta\.dirname\b|${buildPathCall("dirname")}(?:${JS_FILE})\s*\)`;

const JS_CALL = new RegExp(
	String.raw`${buildPathCall("resolve|join")}(?:(${JS_DIR})|(${JS_FILE}))\s*((?:,\s*(?:"[^"\n]*"|'[^'\n]*'))*)`,
	"g",
);

const JS_DIRNAME = new RegExp(
	String.raw`${buildPathCall("dirname")}(?:${JS_DIR})\s*\)`,
	"g",
);

const JS_URL_CALL =
	/new\s+URL\(\s*(?:"([^"\n]*)"|'([^'\n]*)')\s*,\s*import\.meta\.url\s*\)/g;

const CORE_LITERAL = String.raw`["'\x60](?:scripts|\.husky)(?:["'\x60]|/)`;

/** @param {string} root */
const hostCoreJoin = (root) =>
	new RegExp(
		String.raw`${buildPathCall("resolve|join")}${root}\s*,\s*(?:${CORE_LITERAL}|([A-Za-z_$][\w$]*)\s*[,)])`,
		"g",
	);

const hostCoreTemplate = (/** @type {string} */ root) =>
	new RegExp(String.raw`\$\{\s*${root}\s*\}/(?:scripts|\.husky)/`, "g");

const JS_ROOT_VAR = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?:\s*\n)?/g;
const ROOT_CALLS = [
	String.raw`hostRoot\(\)`,
	String.raw`sessionTree\([^()]*\)`,
];
const HOOK_ROOT_CALLS = [
	String.raw`process\.cwd\(\)`,
	String.raw`process\.env\.PWD\b`,
	String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.cwd\b(?![\w$(])`,
];
/** @param {string[]} calls */
const buildJsRootCall = (calls) =>
	new RegExp(String.raw`[^;\n]*\b(?:${calls.join("|")})`, "y");
const JS_ROOT_CALL = buildJsRootCall(ROOT_CALLS);
const JS_HOOK_ROOT_CALL = buildJsRootCall([...ROOT_CALLS, ...HOOK_ROOT_CALLS]);
const JS_DESTRUCTURE =
	/(?:\b(?:const|let|var)\s*\{([^{}]*)\}\s*=|\bfunction\b[\w$\s]*\(\s*\{([^{}]*)\}|\(\s*\{([^{}]*)\}\s*\)\s*=>)/g;
const JS_CWD_KEY =
	/(?:^|,)\s*cwd(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*(?:=[^,]*)?(?=,|$)/;
const JS_CWD_DEFAULT = /[(,]\s*([A-Za-z_$][\w$]*)\s*=\s*process\.cwd\(\)/g;
const HOOK_ROOT_ANY = /\bcwd\b|\bprocess\.env\.PWD\b/;

const JS_CORE_CONST = new RegExp(
	String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${buildPathCall("join")}${CORE_LITERAL}|["'\x60](?:scripts|\.husky)/)`,
	"g",
);

const JS_BOUND_NAMES =
	/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:require|(?:await\s+)?import)\(|\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\b/g;

const JS_SECOND_SEAM = [
	{
		re: /process\.env(?:\.CLAUDE_PROJECT_DIR\b|\[\s*["']CLAUDE_PROJECT_DIR["']\s*\])/g,
		what: "process.env.CLAUDE_PROJECT_DIR read directly",
	},
	{
		re: /--show-toplevel\b/g,
		what: "git rev-parse --show-toplevel called directly",
	},
];

const PY_PARENTS = /Path\(\s*__file__\s*\)\.resolve\(\)\.parents\[(\d+)\]/g;

/** @param {string} body */
const shellParam = (body) => `\${${body}}`;

/** @type {{re: RegExp, what: string}[]} */
const SH_PATTERNS = [
	{
		re: /\$\{CLAUDE_PROJECT_DIR:-\$\(cd "\$here\/\.\." && pwd\)\}/,
		what: `${shellParam('CLAUDE_PROJECT_DIR:-$(cd "$here/.." && pwd)')} — a second spelling of the seam`,
	},
	{
		re: /git -C "\$here"/,
		what: 'git -C "$here" — the script\'s own directory, not a repository in a plugin install',
	},
	{
		re: /git -C "\$\(dirname "\$0"\)"/,
		what: 'git -C "$(dirname "$0")" — the same climb',
	},
	{
		re: /\$\{CLAUDE_PROJECT_DIR:-\.\}/,
		what: `${shellParam("CLAUDE_PROJECT_DIR:-.")} — the cwd is not the host root off a wired path`,
	},
];

const SH_CORE_DIR = String.raw`\/(?:scripts|\.husky)\/`;

/** @type {{re: RegExp, what: string}[]} */
const MIRROR_PATTERNS = [
	{
		re: new RegExp(String.raw`\$\(gr_root\)${SH_CORE_DIR}`),
		what: 'a file that ships with the core, reached through the HOST root — the host repo has no scripts/ of the core\'s. Name it from "$here" instead',
	},
];

const SH_TREE = String.raw`(?:\$\{?PWD\b\}?|\$\(pwd\)|\$\(git\b[^)]*--show-toplevel[^)]*\))`;
const SH_TREE_CORE = new RegExp(`${SH_TREE}${SH_CORE_DIR}`);
const SH_TREE_VAR = new RegExp(
	String.raw`^\s*(?:(?:local|export|readonly)\s+)?([A-Za-z_]\w*)=["']?${SH_TREE}`,
);
const SH_TREE_ANY = new RegExp(SH_TREE);

const SEAM_FILES = new Set([
	"scripts/lib/guard-root.sh",
	"scripts/lib/host-root.js",
	"scripts/lib/host_root.py",
	"scripts/check-host-root.js",
]);

/**
 * @param {string} root
 * @returns {string[]}
 */
function files(root) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} dir */
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === "node_modules" || e.name === "__pycache__") continue;
				walk(full);
			} else if (e.isFile()) {
				out.push(path.relative(root, full));
			}
		}
	};
	for (const d of SCANNED) walk(path.join(root, d));
	return out.sort();
}

/**
 * @param {string} captured
 * @returns {string[]}
 */
function segments(captured) {
	const out = [];
	for (const m of captured.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
		const seg = m[1] ?? m[2];
		if (seg === undefined)
			throw new Error(`a quoted segment took neither quote's group: ${m[0]}`);
		out.push(seg);
	}
	return out;
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * @param {string} text
 * @returns {Set<string>}
 */
const coreConstants = (text) =>
	new Set(
		[...text.matchAll(JS_CORE_CONST)].map((m) =>
			requiredGroup(m, 1, JS_CORE_CONST),
		),
	);

/**
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseBoundNames(text) {
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const m of text.matchAll(JS_BOUND_NAMES))
		for (const part of (m[1] ?? requiredGroup(m, 2, JS_BOUND_NAMES)).split(
			",",
		)) {
			if (/^\s*type\s+[A-Za-z_$]/.test(part)) continue;
			const [exported, alias] = part
				.replace(/[=].*/s, "")
				.split(/:|\bas\b/)
				.map((n) => n.trim());
			const local = alias ?? exported;
			if (local && exported) out.set(local, exported);
		}
	return out;
}

/**
 * @param {string} text
 * @param {boolean} hook
 * @returns {string[]}
 */
function parseRoots(text, hook) {
	return [
		...ROOT_CALLS,
		...(hook ? HOOK_ROOT_CALLS : []),
		...new Set(
			segmentTailMatches(
				text,
				JS_ROOT_VAR,
				hook ? JS_HOOK_ROOT_CALL : JS_ROOT_CALL,
				";\n",
			).map((m) => escapeRe(requiredGroup(m.head, 1, JS_ROOT_VAR))),
		),
		...(hook ? parseCwdBindings(text) : []),
	];
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function parseCwdBindings(text) {
	/** @type {Set<string>} */
	const names = new Set();
	for (const m of text.matchAll(JS_DESTRUCTURE)) {
		const key = (m[1] ?? m[2] ?? m[3] ?? "").match(JS_CWD_KEY);
		if (key) names.add(key[1] ?? "cwd");
	}
	for (const m of text.matchAll(JS_CWD_DEFAULT))
		names.add(requiredGroup(m, 1, JS_CWD_DEFAULT));
	return [...names].map(
		(name) => String.raw`(?<![\w$.])${escapeRe(name)}\b(?![\w$(])`,
	);
}

/**
 * @param {Judge} ctx
 * @param {string} rel
 * @param {string} text
 * @param {{importable: Set<string>, hook: boolean}} scope
 * @returns {boolean}
 */
function judgeHostRootedCore(ctx, rel, text, { importable, hook }) {
	let found = false;
	const local = coreConstants(text);
	const imported = parseBoundNames(text);
	const isCoreConst = (/** @type {string} */ name) => {
		if (local.has(name)) return true;
		const exported = imported.get(name);
		return exported !== undefined && importable.has(exported);
	};
	const roots = parseRoots(text, hook);
	/** @param {number} index @param {string} spelling */
	const mirror = (index, spelling) => {
		found = true;
		const line = lineOf(text, index);
		ctx.fail(
			"HOST-ROOTED-CORE",
			`${rel}:${line} — ${spelling}: a file that ships with the core, reached through the host root or the session's tree. Neither holds the copy that ships with this file; name the sibling from __dirname (import.meta.dirname in ESM) instead.`,
			{ file: rel, line },
			`${rel}:${line}`,
		);
	};
	for (const r of roots) {
		for (const m of text.matchAll(hostCoreJoin(r))) {
			if (m[1] !== undefined && !isCoreConst(m[1])) continue;
			mirror(
				m.index ?? 0,
				m[1]
					? `${m[1]} joined onto the root`
					: "a core directory joined onto the root",
			);
		}
		for (const m of text.matchAll(hostCoreTemplate(r)))
			mirror(m.index ?? 0, "a core directory templated onto the root");
	}
	return found;
}

/**
 * @param {Judge} ctx
 * @param {string} rel
 * @param {string} text
 * @returns {boolean}
 */
function judgeSecondSeam(ctx, rel, text) {
	let found = false;
	for (const { re, what } of JS_SECOND_SEAM)
		for (const m of text.matchAll(re)) {
			found = true;
			const line = lineOf(text, m.index ?? 0);
			ctx.fail(
				"SECOND-SEAM-JS",
				`${rel}:${line} — ${what}, a second spelling of the seam. Use hostRoot() from lib/host-root.js.`,
				{ file: rel, line },
				`${rel}:${line}`,
			);
		}
	return found;
}

/**
 * @param {Judge} ctx
 * @param {string} root
 * @param {{rel: string, source: string, importable: Set<string>, hook: boolean}} file
 * @returns {boolean}
 */
function judgeJs(ctx, root, { rel, source, importable, hook }) {
	const text = blankComments(source);
	const dir = path.dirname(path.join(root, rel));
	const scriptsDir = path.join(root, "scripts");
	let found = false;
	/** @param {string} landing @param {number} line @param {string} spelling */
	const report = (landing, line, spelling) => {
		if (isUnder(landing, [scriptsDir], path.sep)) return;
		found = true;
		ctx.fail(
			"SELF-ROOTED-JS",
			`${rel}:${line} — ${spelling} lands at ${path.relative(root, landing) || "the repo root"}, outside scripts/. Use hostRoot() from lib/host-root.js, or keep __dirname (import.meta.dirname in ESM) only where the path names a file that ships beside this one.`,
			{ file: rel, line },
			`${rel}:${line}`,
		);
	};
	for (const m of text.matchAll(JS_CALL)) {
		const segs = segments(requiredGroup(m, 3, JS_CALL));
		if (segs.length === 0) continue;
		const base = m[1] ?? requiredGroup(m, 2, JS_CALL);
		report(
			path.resolve(m[1] === undefined ? path.join(root, rel) : dir, ...segs),
			lineOf(text, m.index ?? 0),
			`path walk from ${base} through ${segs.map((s) => JSON.stringify(s)).join(", ")}`,
		);
	}
	for (const m of text.matchAll(JS_URL_CALL)) {
		const target = m[1] ?? requiredGroup(m, 2, JS_URL_CALL);
		report(
			path.resolve(dir, target),
			lineOf(text, m.index ?? 0),
			`new URL(${JSON.stringify(target)}, import.meta.url)`,
		);
	}
	if (judgeHostRootedCore(ctx, rel, text, { importable, hook })) found = true;
	if (judgeSecondSeam(ctx, rel, text)) found = true;
	for (const m of text.matchAll(JS_DIRNAME)) {
		report(path.resolve(dir, ".."), lineOf(text, m.index ?? 0), m[0]);
	}
	return found;
}

/**
 * @param {Judge} ctx
 * @param {string} rel
 * @param {string} text
 * @param {boolean} hook
 * @returns {boolean}
 */
function judgeSh(ctx, rel, text, hook) {
	let found = false;
	const lines = text.split("\n");
	const mirrors = hook
		? [...MIRROR_PATTERNS, ...buildShTreePatterns(lines)]
		: MIRROR_PATTERNS;
	for (const [i, line] of lines.entries()) {
		if (line.trimStart().startsWith("#")) continue;
		for (const { re, what } of SH_PATTERNS) {
			if (!re.test(line)) continue;
			found = true;
			ctx.fail(
				"SELF-ROOTED-SH",
				`${rel}:${i + 1} — ${what}. Source lib/guard-root.sh and call gr_root.`,
				{ file: rel, line: i + 1 },
				`${rel}:${i + 1}`,
			);
		}
		for (const { re, what } of mirrors) {
			if (!re.test(line)) continue;
			found = true;
			ctx.fail(
				"HOST-ROOTED-CORE",
				`${rel}:${i + 1} — ${what}.`,
				{ file: rel, line: i + 1 },
				`${rel}:${i + 1}`,
			);
		}
	}
	return found;
}

/**
 * @param {string[]} lines
 * @returns {{re: RegExp, what: string}[]}
 */
function buildShTreePatterns(lines) {
	const what =
		"a file that ships with the core, reached through the session's tree — in a linked worktree that is a copy of another version than the hook's own. Name it from \"$here\" instead";
	const vars = new Set();
	for (const line of lines) {
		const m = line.match(SH_TREE_VAR);
		if (m?.[1] !== undefined) vars.add(m[1]);
	}
	return [
		{ re: SH_TREE_CORE, what },
		...[...vars].map((v) => ({
			re: new RegExp(String.raw`\$(?:${v}\b|\{${v}\})${SH_CORE_DIR}`),
			what,
		})),
	];
}

/**
 * @param {Judge} ctx
 * @param {string} rel
 * @param {string} text
 * @returns {boolean}
 */
function judgePy(ctx, rel, text) {
	let found = false;
	for (const m of text.matchAll(PY_PARENTS)) {
		if (Number(m[1]) < 2) continue;
		found = true;
		const line = lineOf(text, m.index ?? 0);
		ctx.fail(
			"SELF-ROOTED-PY",
			`${rel}:${line} — Path(__file__).resolve().parents[${m[1]}] climbs out of scripts/. Use host_root() from lib/host_root.py.`,
			{ file: rel, line },
			`${rel}:${line}`,
		);
	}
	return found;
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
function isJudged(rel) {
	const ext = path.extname(rel);
	return (
		!SEAM_FILES.has(rel) &&
		(ext === ".sh" || ext === ".py" || isJsExt(ext)) &&
		!isApparatus(rel)
	);
}

/**
 * @param {Judge} ctx
 * @param {string} root
 * @param {{rel: string, text: string, importable: Set<string>, hook: boolean, seen: (tag: string) => void}} file
 */
function judgeFile(ctx, root, { rel, text, importable, hook, seen }) {
	const entry = Object.hasOwn(ALLOWED, rel) ? ALLOWED[rel] : undefined;
	const sink = entry ? exemptingCtx(ctx, entry.tags, seen) : ctx;
	const ext = path.extname(rel);
	if (isJsExt(ext))
		judgeJs(sink, root, { rel, source: text, importable, hook });
	if (ext === ".sh") judgeSh(sink, rel, text, hook);
	if (ext === ".py") judgePy(sink, rel, text);
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function fileFaults(root, rel) {
	if (!rel.startsWith("scripts/") || !isJudged(rel) || !shipsPlugin(root))
		return [];
	/** @type {string[]} */
	const out = [];
	const text = fs.readFileSync(path.join(root, rel), "utf8");
	const collect = (/** @type {string} */ _tag, /** @type {string} */ msg) =>
		out.push(msg);
	judgeFile(
		{
			fail: collect,
			warn: noop,
		},
		root,
		{
			rel,
			text,
			importable: new Set(),
			hook:
				(HOOK_ROOT_ANY.test(text) || SH_TREE_ANY.test(text)) &&
				readHookCode(root).has(rel),
			seen: noop,
		},
	);
	return out;
}

/**
 * @param {string} root
 * @param {string[]} scanned
 * @returns {Set<string>}
 */
function readImportableConstants(root, scanned) {
	/** @type {Set<string>} */
	const importable = new Set();
	for (const rel of scanned) {
		if (!isJsExt(path.extname(rel)) || isApparatus(rel)) continue;
		ignoreFailure(() => {
			const text = blankComments(fs.readFileSync(path.join(root, rel), "utf8"));
			for (const name of coreConstants(text)) importable.add(name);
		});
	}
	return importable;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 * @param {string[]} scanned
 * @param {{importable: Set<string>, hooked: Set<string>}} scope
 * @returns {{ tripped: Set<string>, inspected: number }}
 */
function judgeScanned(ctx, root, scanned, { importable, hooked }) {
	/** @type {Set<string>} */
	const tripped = new Set();
	let inspected = 0;
	for (const rel of scanned) {
		if (!isJudged(rel)) continue;
		inspected += 1;
		let text;
		try {
			text = fs.readFileSync(path.join(root, rel), "utf8");
		} catch {
			continue;
		}
		judgeFile(ctx, root, {
			rel,
			text,
			importable,
			hook: hooked.has(rel),
			seen: (tag) => tripped.add(`${rel}\0${tag}`),
		});
	}
	return { tripped, inspected };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 * @param {Set<string>} tripped
 */
function warnStaleAllowlist(ctx, root, tripped) {
	for (const [rel, { tags, reason }] of Object.entries(ALLOWED)) {
		if (!fs.existsSync(path.join(root, rel))) continue;
		for (const tag of tags) {
			if (tripped.has(`${rel}\0${tag}`)) continue;
			ctx.warn(
				"STALE-ALLOWLIST",
				`${rel} is allowlisted in check-host-root.js for ${tag} and no longer trips it — drop the tag, whose entry reads: ${reason}`,
				{ file: rel },
				`${rel}:${tag}`,
			);
		}
	}
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "host-root",
	usage: "node check-host-root.js [--root <dir>] [--json] [--against <rev>]",
	valueFlags: ["--root"],
	against: { profile: "host-root", materialise: "tree" },
	/** @returns {import("./lib/check").CheckResult} */
	run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
		if (!shipsPlugin(root))
			ctx.skip(
				`${root} ships no plugin (.claude-plugin/plugin.json is absent) — its scripts run in place`,
			);
		const scanned = files(root);
		if (scanned.length === 0) {
			if (!fs.existsSync(path.join(root, "scripts")))
				ctx.skip(`${root} has no scripts/ of its own — nothing to scan`);
			ctx.broken(`nothing to scan under ${root} — no scripts/`);
		}

		const importable = readImportableConstants(root, scanned);

		const { tripped, inspected } = judgeScanned(ctx, root, scanned, {
			importable,
			hooked: readHookCode(root),
		});

		warnStaleAllowlist(ctx, root, tripped);

		if (inspected === 0) ctx.broken(`no script files under ${root}/scripts`);
		return {
			okLine: `${inspected} script(s) find the host repo through the seam`,
			noun: "self-rooting script",
		};
	},
};

/**
 * @param {Judge} ctx
 * @param {string[]} tags
 * @param {(tag: string) => void} seen
 * @returns {Judge}
 */
function exemptingCtx(ctx, tags, seen) {
	/**
	 * @param {"fail" | "warn"} kind
	 * @returns {Judge["fail"]}
	 */
	const route = (kind) => (tag, message, data, key) => {
		if (tags.includes(tag)) seen(tag);
		else ctx[kind](tag, message, data, key);
	};
	return { fail: route("fail"), warn: route("warn") };
}

if (require.main === module) runCheck(SPEC);

module.exports = { SPEC, fileFaults };
