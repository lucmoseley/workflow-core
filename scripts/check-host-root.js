#!/usr/bin/env node
/*
 * check-host-root.js — no script in the core computes its own root (#1).
 *
 * Usage:
 *   node scripts/check-host-root.js [--root <dir>] [--json] [--against <rev>]
 *
 * THE RULE IT BACKS. Every script here finds the HOST repository through one
 * seam: `lib/host-root.js`'s `hostRoot()` in JS, `lib/guard-root.sh`'s
 * `gr_root` in shell, `lib/host_root.py`'s `host_root()` in Python — each
 * `CLAUDE_PROJECT_DIR`, else the git top level of the working directory,
 * symlinks dereferenced. A script that instead walks up from its own location
 * roots itself in the PLUGIN CACHE when the core is installed as a plugin, and
 * every host read then lands in the wrong tree. A root with no
 * `.claude-plugin/plugin.json` ships no plugin, so it SKIPs (#83): its scripts
 * run in place. Residual: an adopter shipping a plugin of its own has its
 * whole scripts/ scanned, plugin-bound or not.
 *
 * WHAT FAILS:
 *
 *   SELF-ROOTED-JS      a `path.resolve(__dirname, …)` or `path.join(__dirname,
 *                       …)` whose LITERAL leading segments already climb out of
 *                       `scripts/`, called through `path.`, `nodePath.` or
 *                       bare (`join(`, `resolve(`, as ESM names a `node:path`
 *                       import). `path.join(__dirname, "..", "session-
 *                       arbiter.js")` from `scripts/lib/` lands back inside
 *                       `scripts/` and is fine — it names a sibling that ships
 *                       with the core, which in a plugin install is exactly
 *                       where it should look. ESM's climbs are read the same
 *                       way: from `import.meta.dirname`, `import.meta.filename`
 *                       or `fileURLToPath(import.meta.url)`, and `new URL("..",
 *                       import.meta.url)`.
 *   SELF-ROOTED-SH      `${CLAUDE_PROJECT_DIR:-$(cd "$here/.." && pwd)}` and its
 *                       kin: a second spelling of the seam. Also `git -C
 *                       "$here"` and `git -C "$(dirname "$0")"`, which ask a
 *                       directory that is not a repository at all in a plugin
 *                       install.
 *   SELF-ROOTED-PY      `Path(__file__).resolve().parents[n]` for n ≥ 2, which
 *                       climbs out of `scripts/` the same way.
 *   SECOND-SEAM-JS      `process.env.CLAUDE_PROJECT_DIR` or a `git rev-parse
 *                       --show-toplevel` outside the seam: the JS kin of the
 *                       shell rule's second spelling, which answers
 *                       differently from `hostRoot()` wherever the two limbs
 *                       disagree.
 *   HOST-ROOTED-CORE    the mirror fault: a file that ships WITH the core
 *                       reached THROUGH the host root — `"$(gr_root)/scripts/
 *                       session-arbiter.js"`, `path.join(hostRoot(),
 *                       "scripts", …)`. The host repo has none of the core's
 *                       scripts, so in a plugin install this names a file that
 *                       is not there. Name the sibling from `$here` or
 *                       `__dirname` instead. In JS the root may sit in a
 *                       variable first (`const root = hostRoot()`), and the
 *                       core path in a constant (`"scripts/…"` or
 *                       `path.join("scripts", …)`) — this file's, or one it
 *                       destructures from a `require` or an `await import()`
 *                       of a scanned module or names in an `import {…} from`
 *                       of one.
 *
 * WHAT IS NOT SCANNED. A test, a fixture and a test harness root at the CORE
 * checkout because that checkout is their subject: `__dirname` there is the copy
 * under test, and pointing them at a host root would aim them at whatever tree
 * the suite happened to run in. lib/test-kind.js's `isTestKind` (test and spec
 * files, pytest's tests and `conftest.py`, testkit, harness, fixture, stub and
 * fake modules, and anything under a `test/`, `tests/`, `fixtures/`,
 * `testkits/`, `stubs/` or `fakes/` directory) and the vitest configs are
 * therefore out of scope, by name.
 *
 * WHAT IT CANNOT SEE. A root passed as a parameter rather than assigned from
 * `hostRoot()` in the same file, a read made inside an imported helper, a
 * constant built from anything but literals, a bare `"scripts"` constant joined
 * as its own segment, a shell expansion it cannot read as a literal, and code
 * hidden by JSX text or a regex literal right after `)` (#3634): JSX text's
 * `//` or `/*` reads as a comment, and its backtick, or such a regex, can pair
 * with a later literal's quote. Nor, in ESM (#3635), a `node:path` function
 * reached through an alias (`join as pjoin`) or a namespace import (`import *
 * as p`), a `fileURLToPath(new URL(".", import.meta.url))` base, a template
 * literal in `new URL`, or `import.meta.resolve` — the scan is lexical. It is a
 * gate against the spellings that drifted, not a proof that no script
 * self-roots.
 * `host-root-plugin-cache.test.ts` is the behavioural half: it runs the rooted
 * scripts from a plugin-cache-shaped path and asserts each resolves the host.
 *
 * THE ALLOWLIST is for a file that roots elsewhere on purpose — a measurement
 * run over this checkout, a checker whose subject is the working directory's
 * checkout. Each entry carries its reason.
 *
 * An allowlist entry whose file is ABSENT is silent — the scanned root is
 * simply not this one, which is the ordinary case under `--root`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { isUnder } = require("./lib/is-under.js");
const { requiredGroup } = require("./lib/regex-group");
const { hostRoot } = require("./lib/host-root.js");
const {
	JS_EXT_SOURCE,
	JS_EXTENSIONS,
	isTestKind,
} = require("./lib/test-kind.js");
const { segmentTailMatches } = require("./lib/line-scan.js");
const { blankComments } = require("./lib/strip-comments.js");

const CWD_SUITE_CHECKER = {
	tags: ["SECOND-SEAM-JS"],
	reason:
		"lists the tracked tests of the checkout it runs in; its suite drives it by cwd into fixture repos, where an inherited CLAUDE_PROJECT_DIR would aim it at the live tree",
};

/**
 * Files that root elsewhere deliberately, the tags that exempt, and why. Any
 * other tag the file trips still reports.
 * @type {Record<string, {tags: string[], reason: string}>}
 */
const ALLOWED = {
	"scripts/lib/heresy-scan.js": {
		tags: ["HOST-ROOTED-CORE"],
		reason:
			"the heresy checks' subject is the host's own scripts/, which the --against re-run materialises at `root`; __dirname would name the plugin's copies instead (#3555)",
	},
	"scripts/lib/husky-shim.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"holds the shell line install-hooks.js writes husky's shim runs inside each git hook, whose subject is the tree git runs the hook in — CLAUDE_PROJECT_DIR there names the shared checkout, the very copy the hook does not run (#3138)",
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
	"scripts/repo-checks.js": {
		tags: ["SECOND-SEAM-JS"],
		reason:
			"writes the seam, never reads it: it re-points CLAUDE_PROJECT_DIR at the main checkout for itself and every check it launches, so a daily run started in a linked worktree reads and reports for the main one (#1555)",
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
			"readInjectedDocs() prefers the injector already materialised at `root` — every --against re-run and every self-hosted live run has one there, which is what lets a staged growth of the injector's own bytes still be caught — and falls back to INJECTOR_FILE (the core's own __dirname-relative copy) only on ENOENT, which is the plugin-install case this rule exists for (#36)",
	},
	"scripts/check-guard-registry.js": {
		tags: ["SELF-ROOTED-JS", "HOST-ROOTED-CORE"],
		reason:
			"CORE_ROOT is the second root the registry needs: an adopter's rules name the CORE's guards, which ship in the plugin and are never copied into the host repo, so a BROKEN-CLAIM would fire on every one of them (#5). rootIsCore() then joins a core script onto the HOST root deliberately — the absence it tests for is the whole discriminator, and this file is the checker's own example of it",
	},
	"scripts/init-adopter.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"bootstraps a host repo FROM this checkout, so its own tree is the source it copies and the host's is --root (#5)",
	},
	"scripts/cut-mantahostels.js": {
		tags: ["SELF-ROOTED-JS"],
		reason:
			"cuts mantahostels over FROM this checkout, which is left behind and never shipped; under --pin its plan reads this checkout's init-adopter.js and hooks.json before the pinned release is installed (#423)",
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
			"lists the tracked scripts/ files of the checkout it runs in for check-guard-test-isolation.js, check-host-root-test-isolation.js and check-git-fixture-identity.js, whose suites drive them by cwd into fixture repos, where an inherited CLAUDE_PROJECT_DIR would aim them at the live tree (#3131)",
	},
};

/*
 * Where the core's own scripts live, relative to the root being scanned.
 *
 * `.husky/` IS NOT SCANNED. A husky hook is never plugin-shipped: it lives in
 * the host repo's own `.husky/`, git runs it from the host's working tree, and
 * a plugin install rewrites its `scripts/` references at bootstrap. So a hook
 * resolving its own worktree is right, and the rule here does not reach it.
 */
const SCANNED = ["scripts"];

const JS_EXT = new Set(JS_EXTENSIONS.map((ext) => `.${ext}`));

/* The suite and its apparatus — see WHAT IS NOT SCANNED above. */
const VITEST_CONFIG = new RegExp(
	String.raw`^vitest\.(?:config|setup)${JS_EXT_SOURCE}$`,
);
const isTestFile = (/** @type {string} */ rel) =>
	isTestKind(rel) || VITEST_CONFIG.test(path.basename(rel));

/** A call to one of `names`, through `path.` or `nodePath.`, or bare as ESM
 * names a `node:path` import — any bare call of that name, imported or not. */
const buildPathCall = (/** @type {string} */ names) =>
	String.raw`(?:\b(?:path|nodePath)\.|(?<![\w$.]))(?:${names})\(\s*`;

const FILE_URL = String.raw`(?:\burl\.)?fileURLToPath\(\s*import\.meta\.url\s*\)`;

/** The file's own path, which a `..` segment climbs out of to its directory. */
const JS_FILE = String.raw`import\.meta\.filename\b|${FILE_URL}`;

/** The file's own directory: CommonJS `__dirname` or its ESM spellings. */
const JS_DIR = String.raw`__dirname\b|import\.meta\.dirname\b|${buildPathCall("dirname")}(?:${JS_FILE})\s*\)`;

/**
 * `path.resolve` / `path.join` from the file's directory (group 1) or its own
 * path (group 2), followed by a run of string literals (group 3). The run may
 * be empty (a dynamic first segment), which is skipped: nothing can be said
 * about where it lands.
 */
const JS_CALL = new RegExp(
	String.raw`${buildPathCall("resolve|join")}(?:(${JS_DIR})|(${JS_FILE}))\s*((?:,\s*(?:"[^"\n]*"|'[^'\n]*'))*)`,
	"g",
);

/** `path.dirname` of the file's own directory — the same climb, spelled
 * without a literal. */
const JS_DIRNAME = new RegExp(
	String.raw`${buildPathCall("dirname")}(?:${JS_DIR})\s*\)`,
	"g",
);

/** `new URL("..", import.meta.url)`: ESM's climb, resolved against the file. */
const JS_URL_CALL =
	/new\s+URL\(\s*(?:"([^"\n]*)"|'([^'\n]*)')\s*,\s*import\.meta\.url\s*\)/g;

/** A string literal naming a core directory, alone or as a path prefix. */
const CORE_LITERAL = String.raw`["'\x60](?:scripts|\.husky)(?:["'\x60]|/)`;

/**
 * The mirror fault: a core file joined onto the host root, or onto an
 * identifier holding it. The capture is the second argument when it is a bare
 * identifier, judged against the core-path constants.
 * @param {string} root the root's spelling, regex-escaped
 */
const hostCoreJoin = (root) =>
	new RegExp(
		String.raw`${buildPathCall("resolve|join")}${root}\s*,\s*(?:${CORE_LITERAL}|([A-Za-z_$][\w$]*)\s*[,)])`,
		"g",
	);

/** `${root}/scripts/` in a template literal. */
const hostCoreTemplate = (/** @type {string} */ root) =>
	new RegExp(String.raw`\$\{\s*${root}\s*\}/(?:scripts|\.husky)/`, "g");

/** An identifier assigned from an expression calling `hostRoot()`: the
 * assignment, then the rest of its statement's line naming the call. Only the
 * head's first reading can reach the call: a shorter `(?:\s*\n)?` leaves the
 * call's search on a line of blanks. */
const JS_ROOT_VAR = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?:\s*\n)?/g;
const JS_ROOT_CALL = /[^;\n]*\bhostRoot\(\)/y;

/** A constant naming a core path: `"scripts/…"` or `path.join("scripts", …)`. */
const JS_CORE_CONST = new RegExp(
	String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${buildPathCall("join")}${CORE_LITERAL}|["'\x60](?:scripts|\.husky)/)`,
	"g",
);

/** The names a file destructures out of a `require` or a dynamic `import()`,
 * or imports by name. */
const JS_BOUND_NAMES =
	/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:require|(?:await\s+)?import)\(|\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\b/g;

/** The seam's two limbs, spelled again outside it. */
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

/** `Path(__file__).resolve().parents[n]`. */
const PY_PARENTS = /Path\(\s*__file__\s*\)\.resolve\(\)\.parents\[(\d+)\]/g;

/** @type {{re: RegExp, what: string}[]} */
const SH_PATTERNS = [
	{
		re: /\$\{CLAUDE_PROJECT_DIR:-\$\(cd "\$here\/\.\." && pwd\)\}/,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion quoted for a reader, not a JS template
		what: '${CLAUDE_PROJECT_DIR:-$(cd "$here/.." && pwd)} — a second spelling of the seam',
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
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion quoted for a reader, not a JS template
		what: "${CLAUDE_PROJECT_DIR:-.} — the cwd is not the host root off a wired path",
	},
];

/** @type {{re: RegExp, what: string}[]} */
const MIRROR_PATTERNS = [
	{
		/* `$(gr_root)` only, never a bare `$root`, which names different things
		 * in different files. */
		re: /\$\(gr_root\)\/(?:scripts|\.husky)\//,
		what: 'a file that ships with the core, reached through the HOST root — the host repo has no scripts/ of the core\'s. Name it from "$here" instead',
	},
];

/** Files the seam itself lives in, which state the contract rather than break it. */
const SEAM_FILES = new Set([
	"scripts/lib/guard-root.sh",
	"scripts/lib/host-root.js",
	"scripts/lib/host_root.py",
	"scripts/check-host-root.js",
]);

/**
 * Every file under the scanned directories, repo-relative, sorted.
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
 * The literal segments of a matched call, in order.
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
 * The 1-based line a byte offset falls on.
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * The name of every core-path constant a JS source declares.
 * @param {string} text comment-blanked source
 * @returns {Set<string>}
 */
const coreConstants = (text) =>
	new Set(
		[...text.matchAll(JS_CORE_CONST)].map((m) =>
			requiredGroup(m, 1, JS_CORE_CONST),
		),
	);

/**
 * Each value name a file binds from a `require` or an `import`, local name to the
 * name it was exported under: `{ CAP: LOG }` and `{ CAP as LOG }` bind LOG to CAP.
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
			/* A type-only binding feeds no runtime join. */
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

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * HOST-ROOTED-CORE: a core directory or core-path constant joined or
 * templated onto the host root. `text` is comment-blanked.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} rel
 * @param {string} text
 * @param {Set<string>} importable
 * @returns {boolean} whether anything was reported
 */
function judgeHostRootedCore(ctx, rel, text, importable) {
	let found = false;
	const local = coreConstants(text);
	const imported = parseBoundNames(text);
	const isCoreConst = (/** @type {string} */ name) => {
		if (local.has(name)) return true;
		const exported = imported.get(name);
		return exported !== undefined && importable.has(exported);
	};
	const roots = [
		"hostRoot\\(\\)",
		...new Set(
			segmentTailMatches(text, JS_ROOT_VAR, JS_ROOT_CALL, ";\n").map((m) =>
				escapeRe(requiredGroup(m.head, 1, JS_ROOT_VAR)),
			),
		),
	];
	/** @param {number} index @param {string} spelling */
	const mirror = (index, spelling) => {
		found = true;
		const line = lineOf(text, index);
		ctx.fail(
			"HOST-ROOTED-CORE",
			`${rel}:${line} — ${spelling}: a file that ships with the core, reached through the host root. The host repo has none of the core's scripts; name the sibling from __dirname (import.meta.dirname in ESM) instead.`,
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
 * SECOND-SEAM-JS: a second spelling of the host-root seam. `text` is
 * comment-blanked.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} rel
 * @param {string} text
 * @returns {boolean} whether anything was reported
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
 * `importable` is the core-path constants any scanned module declares.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 * @param {{rel: string, source: string, importable: Set<string>}} file
 * @returns {boolean} whether anything was reported
 */
function judgeJs(ctx, root, { rel, source, importable }) {
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
	if (judgeHostRootedCore(ctx, rel, text, importable)) found = true;
	if (judgeSecondSeam(ctx, rel, text)) found = true;
	for (const m of text.matchAll(JS_DIRNAME)) {
		report(path.resolve(dir, ".."), lineOf(text, m.index ?? 0), m[0]);
	}
	return found;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} rel
 * @param {string} text
 * @returns {boolean}
 */
function judgeSh(ctx, rel, text) {
	let found = false;
	const lines = text.split("\n");
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
		for (const { re, what } of MIRROR_PATTERNS) {
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
 * @param {import("./lib/check").Ctx} ctx
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
 * Whether `root` ships a plugin.
 * @param {string} root
 * @returns {boolean}
 */
const shipsPlugin = (root) =>
	fs.existsSync(path.join(root, ".claude-plugin", "plugin.json"));

/**
 * Whether a scanned path is judged at all: a script file, neither the seam
 * itself nor the suite's apparatus.
 * @param {string} rel
 * @returns {boolean}
 */
function isJudged(rel) {
	const ext = path.extname(rel);
	return (
		!SEAM_FILES.has(rel) &&
		(ext === ".sh" || ext === ".py" || JS_EXT.has(ext)) &&
		!isTestFile(rel)
	);
}

/**
 * Judges one file, its allowlist entry applied. Judged first, then
 * suppressed: an allowlisted file must still be SEEN to trip its tag, or its
 * entry is stale.
 *
 * `seen` is called with each allowlisted tag tripped.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 * @param {{rel: string, text: string, importable: Set<string>,
 *   seen: (tag: string) => void}} file
 */
function judgeFile(ctx, root, { rel, text, importable, seen }) {
	const entry = Object.hasOwn(ALLOWED, rel) ? ALLOWED[rel] : undefined;
	const sink = entry ? exemptingCtx(ctx, entry.tags, seen) : ctx;
	const ext = path.extname(rel);
	if (JS_EXT.has(ext)) judgeJs(sink, root, { rel, source: text, importable });
	if (ext === ".sh") judgeSh(sink, rel, text);
	if (ext === ".py") judgePy(sink, rel, text);
}

/**
 * The faults one file carries (#1151). No other file is read, so a core-path
 * constant `rel` imports from a sibling module is not known to be one: the
 * commit gate still judges that HOST-ROOTED-CORE spelling.
 * @param {string} root
 * @param {string} rel repo-relative
 * @returns {string[]} one message per fault; none where `root` ships no plugin
 */
function fileFaults(root, rel) {
	if (!rel.startsWith("scripts/") || !isJudged(rel) || !shipsPlugin(root))
		return [];
	/** @type {string[]} */
	const out = [];
	const collect = (/** @type {string} */ _tag, /** @type {string} */ msg) =>
		out.push(msg);
	judgeFile(
		// @ts-expect-error judgeFile's judges call fail alone
		{
			fail: collect,
			warn: () => {
				/* judgeFile's judges never warn */
			},
		},
		root,
		{
			rel,
			text: fs.readFileSync(path.join(root, rel), "utf8"),
			importable: new Set(),
			seen: () => {
				/* the allowlist still applies; whether an entry went stale is the whole-repo pass's call */
			},
		},
	);
	return out;
}

/**
 * The core-path constants every scanned, non-test JS module declares.
 * @param {string} root
 * @param {string[]} scanned
 * @returns {Set<string>}
 */
function readImportableConstants(root, scanned) {
	/** @type {Set<string>} */
	const importable = new Set();
	for (const rel of scanned) {
		if (!JS_EXT.has(path.extname(rel)) || isTestFile(rel)) continue;
		try {
			const text = blankComments(fs.readFileSync(path.join(root, rel), "utf8"));
			for (const name of coreConstants(text)) importable.add(name);
		} catch {
			/* Unreadable here is unreadable below, where it is skipped too. */
		}
	}
	return importable;
}

/**
 * Judge every judged file in `scanned`, collecting the `rel\0tag` pairs an
 * allowlist swallowed and counting the files inspected.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} root
 * @param {string[]} scanned
 * @param {Set<string>} importable
 * @returns {{ tripped: Set<string>, inspected: number }}
 */
function judgeScanned(ctx, root, scanned, importable) {
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
			seen: (tag) => tripped.add(`${rel}\0${tag}`),
		});
	}
	return { tripped, inspected };
}

/**
 * STALE-ALLOWLIST: an allowlisted tag on a present file that no longer trips.
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
	/* `tree`, not `blobs`: the scan finds its scope by walking scripts/, and
	 * the plugin-presence SKIP reads .claude-plugin/plugin.json from the
	 * scanned root (scripts/lib/check.js §--against, #917). */
	against: { profile: "host-root", materialise: "tree" },
	/** @returns {import("./lib/check").CheckResult} */
	run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		/* A repo shipping no plugin SKIPs, not BROKEN or FAIL, which would refuse
		 * every commit it makes (#5, #83). */
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

		/* Every scanned JS module's core-path constants, so a site joining one it
		 * destructured from a require is judged as if the literal were local. */
		const importable = readImportableConstants(root, scanned);

		const { tripped, inspected } = judgeScanned(ctx, root, scanned, importable);

		warnStaleAllowlist(ctx, root, tripped);

		if (inspected === 0) ctx.broken(`no script files under ${root}/scripts`);
		return {
			okLine: `${inspected} script(s) find the host repo through the seam`,
			noun: "self-rooting script",
		};
	},
};

/**
 * `ctx` with the exempt tags swallowed — how an allowlisted file is judged without its
 * exempt finding being reported.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string[]} tags
 * @param {(tag: string) => void} seen
 * @returns {any}
 */
function exemptingCtx(ctx, tags, seen) {
	/** @param {"fail" | "warn"} kind */
	const route =
		(kind) =>
		(/** @type {string} */ t, /** @type {any[]} */ ...rest) => {
			if (tags.includes(t)) seen(t);
			// @ts-expect-error forwarding the checker's own variadic signature
			else ctx[kind](t, ...rest);
		};
	return { fail: route("fail"), warn: route("warn"), broken: ctx.broken };
}

if (require.main === module) runCheck(SPEC);

module.exports = { fileFaults, shipsPlugin };
