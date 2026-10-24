#!/usr/bin/env node
/*
 * check-guard-test-isolation.js — a test that spawns a shell guard must send the
 * guard's fail-open log somewhere private.
 *
 * Usage:
 *   node check-guard-test-isolation.js [--json] [--warn]
 *
 * Every guard records its fail-opens through lib/guard-log.sh (mantahostels#147), which
 * appends to `<config dir>/projects/<repo>/guard-errors.log` — the first seat's
 * config dir where CLAUDE_CONFIG_DIR is a seat, CLAUDE_CONFIG_DIR itself where not.
 * A test that provokes a fail-open deliberately and lets the guard inherit the
 * developer's real CLAUDE_CONFIG_DIR writes one record into the live log per
 * suite run (mantahostels#1452). The convention answering it is one line in the test's env:
 * CLAUDE_CONFIG_DIR pointed at the case's temp directory.
 *
 * THE DISCRIMINATOR IS SPAWNING, NOT MENTIONING. A finding needs the path to
 * reach argv[0] of a spawnSync/spawn/execFileSync/execFile call, and needs the
 * script it names to source lib/guard-log.sh (transitively — guard-parse.sh
 * does). A bare "no CLAUDE_CONFIG_DIR" grep would not do: it flags the eight
 * test files that name a guard in a string without ever executing one.
 *
 * INDIRECTION IS ASSUMED GUILTY. Some tests copy the guard into a temp tree and
 * spawn a local `guard` variable this file cannot resolve, so where a file binds
 * an identifier to a logging guard AND spawns something that is not a known
 * interpreter, it counts as spawning it — a false positive costing one env line
 * in a test that did not need it.
 *
 * SHARED HELPERS ARE READ TOO (workflow-core#837). A non-test `scripts/**\/*.ts` that spawns
 * a guard its caller hands it — scripts/guard-parse-fixture.ts being the case
 * (workflow-core#832) — names no guard of its own. So a helper spawning an argv[0] it cannot resolve
 * is blamed for every logging guard named in a tracked test that imports it, and
 * must redirect CLAUDE_CONFIG_DIR itself: a caller passing it through some env
 * option is not something a call-site read can follow. For a helper the redirect
 * must be SET in code — a key or an assignment outside a comment — since a
 * helper that only reads a caller's override mentions the name without setting
 * it.
 *
 * NOT SEEN: a test that spawns a node script which itself invokes a guard, a
 * guard reached through a shell fragment (`sh -c`), a `.js` helper, a helper a
 * test reaches only through another helper (one import hop is followed), and a
 * guard an importing test names other than as a `"….sh"` literal. The first
 * two would need the spawned process traced, not the call site read; the third
 * is excluded because scripts/lib/*.js is production code as much as test
 * support, and its spawns of a caller-supplied argv[0] are not guard runs.
 *
 * FAIL, not WARN: the finding is a one-line fix in the test that caused it, and
 * the damage it prevents is invisible for as long as it takes someone to audit
 * the log by hand.
 *
 * IMPLICIT:  on every commit staging a scripts/ TypeScript or shell file, refuses one where a test spawns a fail-open-logging guard without redirecting CLAUDE_CONFIG_DIR.
 * JUSTIFIED: fail-safe — a checker that cannot enumerate or read the tracked set is BROKEN rather than green, since a silent pass here restores exactly the blind spot mantahostels#1452 was.
 * DEFEAT:    --warn caps findings below the gating line; an `isolation-exempt:` comment in the test file drops that file, and nothing validates the reason it gives.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { runCheck, errMessage } = require("./lib/check.js");
const { requiredGroup } = require("./lib/regex-group.js");

/** @typedef {import("./lib/check.js").Ctx} Ctx */

const LS_FILES_MAX_BUFFER = 32 * 1024 * 1024;

/** The comment that drops a file, with its reason: `isolation-exempt: <why>`. */
const EXEMPT = /isolation-exempt:[ \t]*[A-Za-z0-9]/;

/** argv[0] spellings that are an interpreter, never a guard. */
const INTERPRETER =
	/^(process\.execPath|"node"|"bash"|"sh"|"git"|"gh"|"npm"|"npx")$/;

/** Tests, and the shared helpers they import (workflow-core#837): every other `.ts`. */
const SCRIPTS_TS = /^scripts\/.*\.ts$/;
const TEST = /\.test\.ts$/;

/**
 * Every `scripts/**\/*.ts` under `root`, walked off the filesystem.
 *
 * Only ever called on a `--root` tree, which is a `git archive HEAD` extraction
 * (mantahostels#1753) — so everything in it is tracked at HEAD by construction, and the walk
 * answers exactly what `git ls-files` would. Not `ls-files` itself: a temp dir
 * is not a git repo.
 */
function walkScriptsTs(/** @type {string} */ root) {
	const out = /** @type {string[]} */ ([]);
	const walk = (/** @type {string} */ rel) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const child = `${rel}/${e.name}`;
			if (e.isDirectory()) walk(child);
			else if (SCRIPTS_TS.test(child)) out.push(child);
		}
	};
	walk("scripts");
	return out;
}

function trackedScriptsTs(/** @type {any} */ ctx) {
	const rootFlag = ctx.value("--root");
	if (rootFlag) {
		const root = path.resolve(rootFlag);
		return { root, files: walkScriptsTs(root) };
	}
	const git = (/** @type {string[]} */ args, /** @type {string} */ what) => {
		try {
			return execFileSync("git", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: LS_FILES_MAX_BUFFER,
			});
		} catch (e) {
			return ctx.broken(
				`git ${args[0]} failed while ${what}: ${errMessage(e)}. No test files read.`,
			);
		}
	};
	const root = git(
		["rev-parse", "--show-toplevel"],
		"locating the repo root",
	).trim();
	const files = git(["-C", root, "ls-files", "-z"], "listing tracked files")
		.split("\0")
		.filter(Boolean)
		.filter((/** @type {string} */ p) => SCRIPTS_TS.test(p));
	return { root, files };
}

/**
 * Does `rel` reach lib/guard-log.sh, directly or through another sourced lib?
 *
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, boolean>} cache accumulator: each file's answer is memoised here, which also breaks a source cycle
 * @param {Set<string>} [seen] accumulator: each file entered is added, so a cycle answers false
 * @returns {boolean}
 */
function logsFailOpens(root, rel, cache, seen = new Set()) {
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
	let answer = /^\s*source\s+.*guard-log\.sh/m.test(text);
	if (!answer) {
		const sourced = /^\s*source\s+"?\$\{?here\}?"?\/([\w./-]+\.sh)/gm;
		for (const m of text.matchAll(sourced)) {
			if (
				logsFailOpens(
					root,
					path.join("scripts", requiredGroup(m, 1, sourced)),
					cache,
					seen,
				)
			) {
				answer = true;
				break;
			}
		}
	}
	cache.set(rel, answer);
	return answer;
}

/** `guard-branch.sh` → `scripts/guard-branch.sh`, or null where no such file. */
function resolveShell(/** @type {string} */ root, /** @type {string} */ name) {
	const base = path.basename(name);
	return (
		[`scripts/${base}`, `scripts/lib/${base}`].find((rel) =>
			fs.existsSync(path.join(root, rel)),
		) ?? null
	);
}

/**
 * The logging guards `source` spawns, read off the call sites rather than run.
 * `guards` holds the guards named outright or, where an unresolvable argv[0] was
 * spawned while such a guard was in scope, every guard in scope. `opaque` is
 * whether any argv[0] was neither an interpreter nor a quoted literal — what
 * makes a helper answer for its importers' guards. A bound identifier still
 * counts: `opts.guard` matches a local `guard` without being it. A literal such
 * as "/bin/true" is a fixed program, never one a caller hands in, so it is
 * neither opaque nor indirection.
 */
function spawnedGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = boundGuards(root, source, cache);

	const named = new Set();
	let indirect = false;
	let opaque = false;
	/* argv[0] only: everything up to the first comma outside parentheses. */
	const call =
		/\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*((?:[^,()]|\([^()]*\))*)/g;
	for (const m of source.matchAll(call)) {
		const read = readCall(requiredGroup(m, 1, call).trim(), {
			root,
			bound,
			cache,
		});
		for (const rel of read.named) named.add(rel);
		if (read.opaque) opaque = true;
		if (read.indirect) indirect = true;
	}

	if (named.size > 0) return { guards: [...named].sort(), opaque };
	if (indirect) return { guards: [...new Set(bound.values())].sort(), opaque };
	return { guards: [], opaque };
}

/** What one spawn's argv[0] `arg` says — see spawnedGuards. */
function readCall(
	/** @type {string} */ arg,
	/** @type {{root: string, bound: Map<string, string>, cache: Map<string, boolean>}} */ scan,
) {
	const literal = literalGuards(scan.root, arg, scan.cache);
	if (literal) return { named: literal, opaque: false, indirect: false };
	const fixed = INTERPRETER.test(arg) || /^"[^"]*"$/.test(arg);
	const hits = boundHits(arg, scan.bound);
	return {
		named: hits,
		opaque: !fixed,
		indirect: hits.length === 0 && scan.bound.size > 0 && !fixed,
	};
}

/** Identifier -> the logging guard a `const`/`let` in `source` binds it to. */
function boundGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = new Map();
	const binding = /\b(?:const|let)\s+(\w+)\s*=\s*[^;\n]*"([\w./-]+\.sh)"/g;
	for (const m of source.matchAll(binding)) {
		const rel = resolveShell(root, requiredGroup(m, 2, binding));
		if (rel && logsFailOpens(root, rel, cache))
			bound.set(requiredGroup(m, 1, binding), rel);
	}
	return bound;
}

/**
 * Null where argv[0] `arg` carries no `"….sh"` literal; otherwise the logging
 * guard it names, as a list of one, or none.
 */
function literalGuards(
	/** @type {string} */ root,
	/** @type {string} */ arg,
	/** @type {Map<string, boolean>} */ cache,
) {
	const shLiteral = /"([\w./-]+\.sh)"/;
	const literal = arg.match(shLiteral);
	if (!literal) return null;
	const rel = resolveShell(root, requiredGroup(literal, 1, shLiteral));
	return rel && logsFailOpens(root, rel, cache) ? [rel] : [];
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
 * Every logging guard `source` names in a `"….sh"` literal, spawned or not.
 * scripts/lib/ is left out: a library there is sourced, never handed over to run.
 */
function namedGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const out = new Set();
	const shLiteral = /"([\w./-]+\.sh)"/g;
	for (const m of source.matchAll(shLiteral)) {
		const rel = resolveShell(root, requiredGroup(m, 1, shLiteral));
		if (rel?.startsWith("scripts/lib/")) continue;
		if (rel && logsFailOpens(root, rel, cache)) out.add(rel);
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

/** `CLAUDE_CONFIG_DIR` set as an env key or assigned — never merely read or typed. */
const SETS_CONFIG_DIR =
	/(?:\bCLAUDE_CONFIG_DIR|["']CLAUDE_CONFIG_DIR["'])\s*(?::(?!\s*(?:string|undefined)\b)|=(?!=))|\[\s*["']CLAUDE_CONFIG_DIR["']\s*\]\s*=(?!=)/;

/** Every tracked file's text, by path — BROKEN where one will not read. */
function readSources(
	/** @type {Ctx} */ ctx,
	/** @type {string} */ root,
	/** @type {string[]} */ files,
) {
	const sources = new Map();
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
	/** @type {{root: string, tests: string[], sources: Map<string, string>, helpers: Set<string>, cache: Map<string, boolean>}} */ scan,
) {
	const { root, tests, sources, helpers, cache } = scan;
	const handed = new Map();
	for (const rel of tests) {
		// Every tracked file was read into `sources`, so this test's is there.
		const source = /** @type {string} */ (sources.get(rel));
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
		for (const g of scan.handed.get(rel) ?? []) guards.add(g);
	}
	return guards;
}

/** How `rel` is judged and reported — a shared helper is held to more. */
function shapeOf(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {boolean} */ isHelper,
	/** @type {string[]} */ names,
) {
	return isHelper
		? {
				redirects: SETS_CONFIG_DIR.test(stripComments(source)),
				what: `${rel}, a shared test helper, spawns ${names.join(", ")}`,
				hint: "  The guards are the ones its importing tests hand it (workflow-core#837); a helper must set CLAUDE_CONFIG_DIR in its own spawn env, since a value read from a caller's override is never set by a caller that passes none (workflow-core#832).",
			}
		: {
				redirects: /CLAUDE_CONFIG_DIR/.test(source),
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
		"  Fix: give the spawn env a CLAUDE_CONFIG_DIR under the case's temp directory. scripts/guard-suite-concurrency.test.ts's `env()` helper is the worked shape.",
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
		const { root, files } = trackedScriptsTs(ctx);
		const cache = /** @type {Map<string, boolean>} */ (new Map());
		const checked = /** @type {string[]} */ ([]);
		const exempt = /** @type {string[]} */ ([]);

		const sources = readSources(ctx, root, files);
		const tests = files.filter((/** @type {string} */ rel) => TEST.test(rel));
		const helpers = new Set(
			files.filter((/** @type {string} */ rel) => !TEST.test(rel)),
		);

		const handed = handedGuards({ root, tests, sources, helpers, cache });

		for (const rel of files) {
			const source = sources.get(rel);
			const guards = guardsOf(rel, source, { root, helpers, handed, cache });
			if (guards.size === 0) continue;
			checked.push(rel);
			if (EXEMPT.test(source)) {
				exempt.push(rel);
				continue;
			}
			const names = [...guards].sort();
			const shape = shapeOf(rel, source, helpers.has(rel), names);
			if (shape.redirects) continue;
			reportUnisolated(ctx, rel, shape, names);
		}

		const data = {
			/* Counts helpers too (workflow-core#837); the key is shared with
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
