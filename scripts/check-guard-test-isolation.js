#!/usr/bin/env node
/*
 * check-guard-test-isolation.js — a test that runs a guard must send the
 * guard's fail-open log somewhere private.
 *
 * Usage:
 *   node check-guard-test-isolation.js [--json] [--warn]
 *
 * Every bash guard records its fail-opens through lib/guard-log.sh
 * (mantahostels#147), and a Node entry through lib/entry-input.js's logger
 * (#2898, #2899), each appending to `<config dir>/projects/<repo>/guard-errors.log` — the first seat's
 * config dir where CLAUDE_CONFIG_DIR is a seat, CLAUDE_CONFIG_DIR itself where not.
 * A test that provokes a fail-open deliberately and lets the guard inherit the
 * developer's real CLAUDE_CONFIG_DIR writes one record into the live log per
 * suite run (mantahostels#1452). The convention answering it is one line in the test's env:
 * CLAUDE_CONFIG_DIR pointed at the case's temp directory.
 *
 * THE DISCRIMINATOR IS SPAWNING, NOT MENTIONING. A finding needs the path to
 * reach argv[0] of a spawnSync/spawn/execFileSync/execFile call — or the
 * script argument of a node spawn, or a runInProcess call's first — and needs
 * the script it names to log: a `….sh` sourcing lib/guard-log.sh, directly
 * or transitively, or a top-level `scripts/….js`
 * requiring lib/entry-input.js (transitively — lib/guard-entry.js does) or
 * lib/fail-open-logger.js, or calling arbiter-core.js's logError itself.
 * A bare "no CLAUDE_CONFIG_DIR" grep would not do: it flags test files that
 * name a guard in a string without ever executing one (lucmoseley/mantahostels#1468).
 *
 * INDIRECTION IS ASSUMED GUILTY. Some tests copy the guard into a temp tree and
 * spawn a local `guard` variable this file cannot resolve, so where a file binds
 * an identifier to a logging guard AND spawns something that is not a known
 * interpreter, it counts as spawning it — a false positive costing one env line
 * in a test that did not need it.
 *
 * SHARED HELPERS ARE READ TOO (#837). A non-test `scripts/**\/*.ts` that spawns
 * a guard its caller hands it names no guard of its own (#832). So a helper spawning an argv[0] it cannot resolve
 * is blamed for every logging guard named in a tracked test that imports it, and
 * must redirect CLAUDE_CONFIG_DIR itself: a caller passing it through some env
 * option is not something a call-site read can follow. For a helper the redirect
 * must be SET in code — a key or an assignment outside a comment — since a
 * helper that only reads a caller's override mentions the name without setting
 * it.
 *
 * A HELPER'S process.env REDIRECT COUNTS FOR ITS CALLERS. A test calling a
 * helper function that assigns process.env.CLAUDE_CONFIG_DIR — arbiter-testkit.ts's
 * freshSandbox — and spreading process.env into some spawn's env is
 * redirected without naming it.
 *
 * NOT SEEN: a test that spawns a node script which itself invokes a guard, a
 * guard reached through a shell fragment (`sh -c`), a `.js` helper, a helper a
 * test reaches only through another helper (one import hop is followed), and a
 * guard an importing test names other than as a `"….sh"` or `"….js"` literal,
 * and a call or binding spelt inside a string, a template literal (its `${…}`
 * included) or a comment, which is read as a generated file's source; and a
 * lib's own logError call, which charges no entry requiring that lib; and, for
 * a test redirected through a helper, a spawn given a fresh env or run before
 * the helper's redirect takes effect. The first two would need the spawned
 * process traced, not the call site read; the third
 * is excluded because scripts/lib/*.js is production code as much as test
 * support, and its spawns of a caller-supplied argv[0] are not guard runs.
 *
 * FAIL, not WARN: the finding is a one-line fix in the test that caused it, and
 * the damage it prevents is invisible for as long as it takes someone to audit
 * the log by hand.
 *
 * IMPLICIT:  on every commit staging a scripts/ test file, TypeScript or shell file, refuses one where a test runs a fail-open-logging guard without redirecting CLAUDE_CONFIG_DIR.
 * JUSTIFIED: fail-safe — a checker that cannot enumerate or read the tracked set is BROKEN rather than green, since a silent pass here restores exactly the blind spot mantahostels#1452 was.
 * DEFEAT:    --warn caps findings below the gating line; an `isolation-exempt:` comment in the test file drops that file, and nothing validates the reason it gives.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readTrackedScripts } = require("./lib/tracked-scripts.js");
const { isJsTestFile } = require("./lib/test-kind.js");
const { inertSpans } = require("./lib/js-lex.js");
const { blankComments } = require("./lib/strip-comments.js");

const { runCheck, errMessage } = require("./lib/check.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { segmentTailMatches } = require("./lib/line-scan.js");

/** @typedef {import("./lib/check.js").Ctx} Ctx */

/** The comment that drops a file, with its reason: `isolation-exempt: <why>`. */
const EXEMPT = /isolation-exempt:[ \t]*[A-Za-z0-9]/;

/** argv[0] spellings that are an interpreter, never a guard. */
const INTERPRETER =
	/^(process\.execPath|"node"|"bash"|"sh"|"git"|"gh"|"npm"|"npx")$/;

/** The interpreters whose first argument is the script run, as a Node entry is. */
const NODE_INTERPRETER = /^(process\.execPath|"node")$/;

/** A guard's file name in a string literal: a bash guard or a Node entry. */
const GUARD_LITERAL = /"([\w./-]+\.(?:sh|js))"/;

/** Tests of any JS form, and the shared `.ts` helpers they import (#837). */
const isTestOrTsHelper = (/** @type {string} */ rel) =>
	rel.endsWith(".ts") || isJsTestFile(rel);

/**
 * Does `rel` log its fail-opens? A `….sh` reaches lib/guard-log.sh, a `….js`
 * lib/entry-input.js or lib/fail-open-logger.js, each directly or through a
 * lib it sources or requires. A top-level `….js` also logs where it takes
 * logError from the arbiter libs itself (#3046).
 *
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, boolean>} cache accumulator: each file's answer is memoised here, which also breaks a source cycle
 * @param {Set<string>} [seen] accumulator: each file entered is added, so a cycle answers false
 * @returns {boolean}
 */
function hasFailOpenLogging(root, rel, cache, seen = new Set()) {
	const hit = cache.get(rel);
	if (hit !== undefined) return hit;
	if (seen.has(rel)) return false;
	seen.add(rel);

	let text = "";
	try {
		text = fs.readFileSync(path.join(root, rel), "utf8");
	} catch {
		cache.set(rel, false);
		return false;
	}
	const scan = { root, cache, seen };
	const answer = rel.endsWith(".js")
		? ENTRY_LOGGERS.includes(rel) ||
			(path.posix.dirname(rel) === "scripts" && hasLogErrorCall(text)) ||
			hasLoggingDependency(path.posix.dirname(rel), text, REQUIRED, scan)
		: /^[^\S\n\r\u2028\u2029]*source\s+(?!\s).*guard-log\.sh/m.test(text) ||
			hasLoggingDependency("scripts", text, SOURCED, scan);
	cache.set(rel, answer);
	return answer;
}

/** The loggers a Node entry's fail-opens go through, lib/guard-entry.js's
 * included. */
const ENTRY_LOGGERS = [
	"scripts/lib/entry-input.js",
	"scripts/lib/fail-open-logger.js",
];

/** A require of the arbiter libs that export logError. */
const LOG_ERROR_HOST =
	/\brequire\(\s*"\.\/lib\/arbiter-(?:core|store)(?:\.js)?"\s*\)/;

/** Whether `text` requires an arbiter lib and calls logError outside a
 * comment or string. */
const hasLogErrorCall = (/** @type {string} */ text) => {
	const inert = inertSpans(text);
	const calls = [...text.matchAll(/\blogError\s*\(/g)];
	return (
		LOG_ERROR_HOST.test(blankComments(text)) &&
		calls.some((m) => !isInert(inert, m.index))
	);
};

/** A relative require, its group 1 the path. */
const REQUIRED = /\brequire\(\s*"(\.{1,2}\/[\w./-]+)"\s*\)/g;
/** A lib sourced off the guard's own directory, its group 1 the path. Leading
 * blanks stop at a line break, where `^` re-anchors anyway (#3383). */
const SOURCED =
	/^[^\S\n\r\u2028\u2029]*source\s+"?\$\{?here\}?"?\/([\w./-]+\.sh)/gm;

/**
 * Whether a file `pattern` names in `text`, resolved against `dir`, logs its
 * fail-opens (hasFailOpenLogging). An extensionless path is a require, so
 * `.js` is added.
 * @param {string} dir
 * @param {string} text
 * @param {RegExp} pattern its group 1 the path, relative to `dir`
 * @param {{ root: string, cache: Map<string, boolean>, seen: Set<string> }} scan
 *   accumulator: `cache` and `seen` are hasFailOpenLogging's, filled as it goes
 */
function hasLoggingDependency(dir, text, pattern, { root, cache, seen }) {
	for (const m of text.matchAll(pattern)) {
		let rel = path.posix.join(dir, requiredGroup(m, 1, pattern));
		if (!/\.\w+$/.test(rel)) rel = `${rel}.js`;
		if (hasFailOpenLogging(root, rel, cache, seen)) return true;
	}
	return false;
}

/**
 * `review-hold-gate.sh` → `scripts/review-hold-gate.sh`, or null where
 * no such file. A `….js` resolves only to a top-level entry: a name with a
 * directory other than scripts/ is a library, required rather than run.
 */
function resolveGuard(/** @type {string} */ root, /** @type {string} */ name) {
	const base = path.basename(name);
	const dir = path.posix.dirname(name);
	let candidates = [`scripts/${base}`, `scripts/lib/${base}`];
	if (name.endsWith(".js"))
		candidates =
			["", ".", "..", "scripts"].includes(dir) || dir.endsWith("/scripts")
				? [`scripts/${base}`]
				: [];
	return candidates.find((rel) => fs.existsSync(path.join(root, rel))) ?? null;
}

/**
 * The logging guards `source` spawns, read off the call sites rather than run.
 * `guards` holds the guards named outright or, where an unresolvable argv[0] was
 * spawned while such a guard was in scope, every guard in scope. `opaque` is
 * whether any argv[0] was neither an interpreter nor a quoted literal — what
 * makes a helper answer for its importers' guards — and `opaqueNode` whether
 * every such argv[0] was a node run, which only a Node entry can be. A bound
 * identifier still counts: `opts.guard` matches a local `guard` without being
 * it. A literal such as "/bin/true" is a fixed program, never one a caller
 * hands in, so it is neither opaque nor indirection.
 */
function spawnedGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = boundGuards(root, source, cache);
	const inert = inertSpans(source);

	const named = new Set();
	const indirect = new Set();
	let opaque = false;
	let opaqueDirect = false;
	for (const m of source.matchAll(CALL)) {
		/* A call spelt inside a string is a generated file's source, not a run. */
		if (isInert(inert, m.index)) continue;
		const { node, read } = readSpawn(m, { root, bound, cache });
		for (const rel of read.named) named.add(rel);
		for (const rel of read.indirect) indirect.add(rel);
		opaque ||= read.opaque;
		opaqueDirect ||= read.opaque && !node;
	}

	const guards = [...(named.size > 0 ? named : indirect)].sort();
	return { guards, opaque, opaqueNode: opaque && !opaqueDirect };
}

/** Whether `index` falls inside one of `spans`, inertSpans's output. */
const isInert = (
	/** @type {[number, number][]} */ spans,
	/** @type {number} */ index,
) => spans.some(([first, last]) => first <= index && index <= last);

/* A spawn or in-process run: group 1 the callee; group 2 argv[0], everything
 * up to the first comma outside parentheses; group 3 a literal args array's
 * first element past any node flags but `-e`/`-p`, which for a node spawn is
 * the script run. */
const CALL =
	/\b(spawnSync|spawn|execFileSync|execFile|runInProcess|runInProcessAsync)\(\s*((?:[^,()]|\([^()]*\))*)(?:,\s*\[\s*(?:"-(?!e"|p"|-eval"|-print")[^"]*"\s*,\s*)*((?:[^,()\]]|\([^()]*\))*))?/g;

/* What a node spawn runs where its args are no literal array: unknown, so
 * read as indirection. */
const UNREAD_SCRIPT = "args";

/**
 * One CALL match read as readCall reads it, and `node` where it runs node on a
 * script, so only a Node entry can be what it runs. `scan.cache` is an
 * accumulator, hasFailOpenLogging's.
 */
function readSpawn(
	/** @type {RegExpMatchArray} */ m,
	/** @type {{root: string, bound: Map<string, string>, cache: Map<string, boolean>}} */ scan,
) {
	const argv0 = requiredGroup(m, 2, CALL).trim();
	const script = m[3]?.trim();
	const nodeSpawn = NODE_INTERPRETER.test(argv0);
	const node = nodeSpawn || requiredGroup(m, 1, CALL).startsWith("run");
	const read = readCall(nodeSpawn ? script || UNREAD_SCRIPT : argv0, {
		...scan,
		bound: node ? onlyEntries(scan.bound) : scan.bound,
	});
	return { node, read };
}

/** `bound` cut to its Node entries: all a node run can be running. */
const onlyEntries = (/** @type {Map<string, string>} */ bound) =>
	new Map([...bound].filter(([, rel]) => rel.endsWith(".js")));

/** What one spawn's argv[0] `arg` says — see spawnedGuards. */
function readCall(
	/** @type {string} */ arg,
	/** @type {{root: string, bound: Map<string, string>, cache: Map<string, boolean>}} */ scan,
) {
	const literal = literalGuards(scan.root, arg, scan.cache);
	if (literal) return { named: literal, opaque: false, indirect: [] };
	const fixed = INTERPRETER.test(arg) || /^"[^"]*"$/.test(arg);
	const hits = boundHits(arg, scan.bound);
	return {
		named: hits,
		opaque: !fixed,
		indirect: hits.length === 0 && !fixed ? [...scan.bound.values()] : [],
	};
}

/**
 * Identifier -> the logging guard a `const`/`let` in `source` binds it to. A
 * name used as a subscript key, `x["guard-y.js"]`, binds nothing.
 */
function boundGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = new Map();
	const binding = /\b(?:const|let)\s+(\w+)\s*=\s*(?!\s)/g;
	const guardLiteral = /[^;\n]*(?<!\[)"([\w./-]+\.(?:sh|js))"/y;
	const inert = inertSpans(source);
	for (const m of segmentTailMatches(source, binding, guardLiteral, ";\n")) {
		if (isInert(inert, m.index)) continue;
		const rel = resolveGuard(root, requiredGroup(m.tail, 1, guardLiteral));
		if (rel && hasFailOpenLogging(root, rel, cache))
			bound.set(requiredGroup(m.head, 1, binding), rel);
	}
	return bound;
}

/**
 * Null where argv[0] `arg` carries no guard-file literal; otherwise the logging
 * guard it names, as a list of one, or none.
 */
function literalGuards(
	/** @type {string} */ root,
	/** @type {string} */ arg,
	/** @type {Map<string, boolean>} */ cache,
) {
	const literal = arg.match(GUARD_LITERAL);
	if (!literal) return null;
	const rel = resolveGuard(root, requiredGroup(literal, 1, GUARD_LITERAL));
	return rel && hasFailOpenLogging(root, rel, cache) ? [rel] : [];
}

/** The bound guards whose identifier argv[0] `arg` mentions. */
function boundHits(
	/** @type {string} */ arg,
	/** @type {Map<string, string>} */ bound,
) {
	const hits = /** @type {string[]} */ ([]);
	for (const [id, rel] of bound) {
		if (new RegExp(`\\b${id}\\b`).test(arg)) hits.push(rel);
	}
	return hits;
}

/**
 * Every logging guard `source` names in a `"….sh"` or `"….js"` literal,
 * spawned or not.
 * scripts/lib/ is left out: a library there is sourced, never handed over to run.
 */
function namedGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const out = new Set();
	const literals = new RegExp(GUARD_LITERAL.source, "g");
	for (const m of source.matchAll(literals)) {
		const rel = resolveGuard(root, requiredGroup(m, 1, literals));
		if (rel?.startsWith("scripts/lib/")) continue;
		if (rel && hasFailOpenLogging(root, rel, cache)) out.add(rel);
	}
	return out;
}

/**
 * The tracked `.ts` files in `known` that `rel`'s relative imports reach.
 * Residual: only a double-quoted specifier resolving as written or with `.ts`
 * appended is followed, so an `index.ts` directory import or a `.js`-suffixed
 * one leaves its helper unblamed.
 */
function importsOf(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {Set<string>} */ known,
) {
	const out = /** @type {string[]} */ ([]);
	const specifier =
		/(?:\bfrom\s*|\b(?:require|import)\(\s*)"(\.{1,2}\/[^"]+)"/g;
	for (const m of source.matchAll(specifier)) {
		const base = path.posix.join(
			path.posix.dirname(rel),
			requiredGroup(m, 1, specifier),
		);
		const hit = [base, `${base}.ts`].find((c) => known.has(c));
		if (hit) out.push(hit);
	}
	return out;
}

/**
 * Comments out, so a helper explaining CLAUDE_CONFIG_DIR is not read as setting
 * it. Residual: a `//` inside a string survives unless a quote or colon sits
 * right before it, so a URL-bearing string can swallow the rest of its line.
 */
const stripComments = (/** @type {string} */ s) =>
	s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** `CLAUDE_CONFIG_DIR` set as an env key, assigned or stubbed — never merely read or typed. */
const SETS_CONFIG_DIR =
	/(?:\bCLAUDE_CONFIG_DIR|["']CLAUDE_CONFIG_DIR["'])\s*(?::(?!\s*(?:string|undefined)\b)|=(?!=))|\[\s*["']CLAUDE_CONFIG_DIR["']\s*\]\s*=(?!=)|\bstubEnv\(\s*["']CLAUDE_CONFIG_DIR["']\s*,/;

/** `process.env.CLAUDE_CONFIG_DIR` assigned. */
const SETS_PROCESS_CONFIG_DIR =
	/\bprocess\.env(?:\.CLAUDE_CONFIG_DIR|\[\s*["']CLAUDE_CONFIG_DIR["']\s*\])\s*=(?!=)/g;

/** A function's name at its definition, group 1 or 2. */
const DEFINED = /\bfunction\s+(\w+)|\bconst\s+(\w+)\s*=\s*(?:async\s*)?\(/g;

/** The functions in helper `source` that assign process.env.CLAUDE_CONFIG_DIR:
 * each assignment's nearest enclosing definition, read as the last before it. */
function processRedirectors(/** @type {string} */ source) {
	const code = stripComments(source);
	const defs = [...code.matchAll(DEFINED)];
	const out = new Set();
	for (const m of code.matchAll(SETS_PROCESS_CONFIG_DIR)) {
		const def = defs.filter((d) => d.index < m.index).at(-1);
		const name = def?.[1] ?? def?.[2];
		if (name) out.add(name);
	}
	return out;
}

/** Whether test `source` calls a function a helper it imports redirects
 * process.env through, and spreads process.env into a spawn's env. */
function redirectsThroughHelper(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {{helpers: Set<string>, sources: Map<string, string>}} */ scan,
) {
	if (!/\.\.\.process\.env\b|\benv:\s*process\.env\b/.test(source))
		return false;
	return importsOf(rel, source, scan.helpers).some((h) => {
		const helper = scan.sources.get(h);
		if (helper === undefined) return false;
		return [...processRedirectors(helper)].some((name) =>
			new RegExp(`\\b${name}\\s*\\(`).test(stripComments(source)),
		);
	});
}

/** Every tracked file's text, by path — BROKEN where one will not read. */
function readSources(
	/** @type {Ctx} */ ctx,
	/** @type {string} */ root,
	/** @type {string[]} */ files,
) {
	const sources = /** @type {Map<string, string>} */ (new Map());
	for (const rel of files) {
		try {
			sources.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
		} catch (e) {
			return ctx.broken(
				`could not read the tracked file ${rel}: ${errMessage(e)}.`,
			);
		}
	}
	return sources;
}

/* helper -> the logging guards named by the tests importing it. */
function handedGuards(
	/** @type {{root: string, sources: Map<string, string>, helpers: Set<string>, cache: Map<string, boolean>}} */ scan,
) {
	const { root, sources, helpers, cache } = scan;
	const handed = new Map();
	for (const [rel, source] of sources) {
		if (helpers.has(rel)) continue;
		const imported = importsOf(rel, source, helpers);
		if (imported.length === 0) continue;
		const guards = namedGuards(root, source, cache);
		if (guards.size === 0) continue;
		for (const h of imported) {
			const set = handed.get(h) ?? new Set();
			for (const g of guards) set.add(g);
			handed.set(h, set);
		}
	}
	return handed;
}

/** The logging guards `rel` answers for, spawned or — for a helper — handed. */
function guardsOf(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {{root: string, helpers: Set<string>, handed: Map<string, Set<string>>, cache: Map<string, boolean>}} */ scan,
) {
	const spawned = spawnedGuards(scan.root, source, scan.cache);
	const isHelper = scan.helpers.has(rel);
	/* A helper binding a scripts/lib/ path is copying a library, not running it. */
	const guards = new Set(
		isHelper
			? spawned.guards.filter(
					(/** @type {string} */ g) => !g.startsWith("scripts/lib/"),
				)
			: spawned.guards,
	);
	if (isHelper && spawned.opaque) {
		for (const g of scan.handed.get(rel) ?? [])
			if (!spawned.opaqueNode || g.endsWith(".js")) guards.add(g);
	}
	return guards;
}

/** How `rel` is judged and reported — a shared helper is held to more. */
function shapeOf(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {{helpers: Set<string>, sources: Map<string, string>}} */ scan,
	/** @type {string[]} */ names,
) {
	return scan.helpers.has(rel)
		? {
				redirects: SETS_CONFIG_DIR.test(stripComments(source)),
				what: `${rel}, a shared test helper, spawns ${names.join(", ")}`,
				hint: "  The guards are the ones its importing tests hand it (#837); a helper must set CLAUDE_CONFIG_DIR in its own spawn env, since a value read from a caller's override is never set by a caller that passes none (#832).",
			}
		: {
				redirects:
					/CLAUDE_CONFIG_DIR/.test(source) ||
					redirectsThroughHelper(rel, source, scan),
				what: `${rel} spawns ${names.join(", ")}`,
				hint: null,
			};
}

/** Fails `rel` and says why and how to fix it. */
function reportUnisolated(
	/** @type {Ctx} */ ctx,
	/** @type {string} */ rel,
	/** @type {{what: string, hint: string | null}} */ shape,
	/** @type {string[]} */ names,
) {
	ctx.fail(
		"GUARD-TEST-ISOLATION",
		`${shape.what} without setting CLAUDE_CONFIG_DIR, so a fail-open it provokes is written to the developer's live guard-errors.log (mantahostels#1452).`,
		{ file: rel, guards: names },
	);
	ctx.say(`${shape.what}.`);
	if (shape.hint) ctx.say(shape.hint);
	ctx.say(
		"  Those guards record every fail-open under CLAUDE_CONFIG_DIR (mantahostels#147), so the case's records land in the real log and read there as a guard failing in production.",
	);
	ctx.say(
		"  Fix: give the spawn env a CLAUDE_CONFIG_DIR under the case's temp directory. lib/pretool-guard-testkit.ts's `guardDirs` is the worked shape.",
	);
	ctx.say(
		"  Genuinely unable to log? Say so in a comment reading `isolation-exempt: <why>` and this check drops the file.",
	);
}

runCheck({
	name: "guard-test-isolation",
	usage:
		"node check-guard-test-isolation.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
	/* Whole-tree, not a pathspec: the finding is a relationship between a test
	 * file and whatever guard it spawns, and spawnedGuards follows `source`
	 * chains through scripts/lib — so the scan discovers its own scope
	 * (scripts/lib/check.js §--against, mantahostels#1833). */
	against: { profile: "guard-test-isolation", materialise: "tree" },
	run(/** @type {any} */ ctx) {
		const { root, files } = readTrackedScripts(ctx, isTestOrTsHelper);
		const cache = /** @type {Map<string, boolean>} */ (new Map());
		const checked = /** @type {string[]} */ ([]);
		const exempt = /** @type {string[]} */ ([]);

		const sources = readSources(ctx, root, files);
		const helpers = new Set(
			files.filter((/** @type {string} */ rel) => !isJsTestFile(rel)),
		);

		const handed = handedGuards({ root, sources, helpers, cache });

		for (const [rel, source] of sources) {
			const guards = guardsOf(rel, source, { root, helpers, handed, cache });
			if (guards.size === 0) continue;
			checked.push(rel);
			if (EXEMPT.test(source)) {
				exempt.push(rel);
				continue;
			}
			const names = [...guards].sort();
			const shape = shapeOf(rel, source, { helpers, sources }, names);
			if (shape.redirects) continue;
			reportUnisolated(ctx, rel, shape, names);
		}

		const data = {
			/* Counts helpers too (#837); the key is shared with
			 * check-host-root-test-isolation.js's envelope, so it keeps its name. */
			spawningTests: checked.length,
			exempt: exempt.length,
			scanned: files.length,
		};
		/* The exempt are named rather than folded into the claim: "all redirecting"
		 * must not cover a file this check dropped. */
		const tail =
			exempt.length > 0
				? `${exempt.length} exempt, the rest redirecting CLAUDE_CONFIG_DIR.`
				: "all redirecting CLAUDE_CONFIG_DIR.";
		return {
			okLine: `${checked.length} of ${files.length} scripts/ test files and helpers spawn a fail-open-logging guard — ${tail}`,
			noun: "unisolated guard test",
			data,
		};
	},
});
