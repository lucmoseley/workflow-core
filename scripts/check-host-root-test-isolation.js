#!/usr/bin/env node
/*
 * check-host-root-test-isolation.js — a test that spawns a hostRoot()- or
 * gr_root-rooted script must redirect CLAUDE_PROJECT_DIR, or the child reads
 * and writes the developer's live checkout instead of its fixture (#160).
 *
 * Usage:
 *   node check-host-root-test-isolation.js [--json] [--warn]
 *
 * `lib/host-root.js`'s `hostRoot()` answers `CLAUDE_PROJECT_DIR` where it is
 * set, else the git top level of the spawn's cwd — which, uncontained, is the
 * real repo the test itself runs inside. A script rooted through it (directly
 * or via `lib/marker-root.js`) then reads and writes the live
 * `.claude/tmp/markers/` tree: marker latches, counters, the test-log store.
 * #154 was one instance, fixed at 757bfc1f by setting CLAUDE_PROJECT_DIR on
 * the child. `lib/guard-root.sh`'s `gr_root` is the shell twin, sourced
 * directly or through `lib/marker-root.sh` and `lib/guard-log.sh` (#3311).
 *
 * THE DISCRIMINATOR IS SPAWNING, NOT MENTIONING — the same convention
 * `check-guard-test-isolation.js` uses, and this file borrows its call-site
 * read. A finding needs the path to reach argv[0] of a
 * spawnSync/spawn/execFileSync/execFile call, and needs the script it names
 * to require lib/host-root.js, or call `gr_root` (transitively).
 *
 * NOT SEEN: a hook under `.husky/`, or one a spawned `git` fires; a child a
 * shell script runs with `bash "$here/x.sh"` rather than sources; a `source`
 * spelt through a variable (`. "$route_lib"`).
 *
 * FAIL, not WARN: the finding is a one-line fix in the test that caused it,
 * and the damage — a live marker store polluted by a test fixture — is
 * invisible until something reads that store for real (#154).
 *
 * IMPLICIT:  on every commit staging a scripts/ test or script, refuses one where a test spawns a hostRoot()- or gr_root-rooted script without redirecting CLAUDE_PROJECT_DIR.
 * JUSTIFIED: fail-safe — mirrors check-guard-test-isolation.js's rationale: a checker that cannot enumerate or read the tracked set is BROKEN rather than green.
 * DEFEAT:    --warn caps findings below the gating line; an `isolation-exempt:` comment in the test file drops that file, and nothing validates the reason it gives.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readTrackedScripts } = require("./lib/tracked-scripts.js");
const { isJsTestFile } = require("./lib/test-kind.js");

const { runCheck, errMessage } = require("./lib/check.js");
const { requiredGroup } = require("./lib/regex-group.js");

/** The comment that drops a file, with its reason: `isolation-exempt: <why>`. */
const EXEMPT = /isolation-exempt:[ \t]*[A-Za-z0-9]/;

/** argv[0] spellings that are an interpreter, never a script. */
const INTERPRETER =
	/^(process\.execPath|"node"|"bash"|"sh"|"git"|"gh"|"npm"|"npx")$/;

/**
 * `lib/check.js` and `lib/workflow-core-config.js`: pulled in by nearly every
 * checker in the suite, and each requires host-root.js for a config/`--root`
 * read that never touches `.claude/tmp/markers/`. Following a require chain
 * through either would flag most of the suite for a class of damage none of
 * it can cause, so the walk below stops at them rather than following them.
 */
const TRANSITIVITY_STOP = new Set([
	"scripts/lib/check.js",
	"scripts/lib/workflow-core-config.js",
]);

/**
 * Does `rel` require `lib/host-root.js` or `lib/marker-root.js`, directly or
 * transitively through another `scripts/lib/*.js` it requires — `lib/hook-
 * block.js` and `lib/hook-record.js` both reach `markersDir()` this way,
 * without naming `marker-root.js` themselves in whatever spawns them (#160's
 * spec review, F1)? The walk stops at `TRANSITIVITY_STOP` and at anything
 * outside `scripts/lib/`, so a checker's own `require("./lib/check.js")`
 * never pulls in that file's own wide require graph.
 *
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, boolean>} cache accumulator: each file's answer is memoised here, which also breaks a require cycle
 * @param {Set<string>} [seen] accumulator: each file entered is added, so a cycle answers false
 * @returns {boolean}
 */
function rootsThroughHostRoot(root, rel, cache, seen = new Set()) {
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
	const shell = rel.endsWith(".sh");
	let answer = shell
		? callsGrRoot(text)
		: /require\(["'][^"']*\/host-root(?:\.js)?["']\)/.test(text) ||
			/require\(["'][^"']*\/marker-root(?:\.js)?["']\)/.test(text);
	if (!answer)
		answer = (
			shell ? sourcedLibTargets(text) : relativeRequireTargets(rel, text)
		).some(
			(target) =>
				fs.existsSync(path.join(root, target)) &&
				rootsThroughHostRoot(root, target, cache, seen),
		);
	cache.set(rel, answer);
	return answer;
}

/**
 * The `.js` files `rel`'s relative `require`s name (`text` is its source),
 * less `TRANSITIVITY_STOP`, in source order.
 */
function relativeRequireTargets(
	/** @type {string} */ rel,
	/** @type {string} */ text,
) {
	const targets = [];
	const relRequire = /require\(["'](\.[\w./-]+)["']\)/g;
	for (const m of text.matchAll(relRequire)) {
		let target = path.join(path.dirname(rel), requiredGroup(m, 1, relRequire));
		if (!target.endsWith(".js")) target += ".js";
		if (TRANSITIVITY_STOP.has(target)) continue;
		targets.push(target);
	}
	return targets;
}

/**
 * Does shell `text` call `gr_root`, outside a comment and its own definition?
 * Calling, not sourcing: a script that sources lib/guard-root.sh for
 * `gr_config_dir` alone never roots itself in the repo. A `gr_root` inside a
 * string or a trailing comment still counts: a false FAIL, never a false OK.
 */
function callsGrRoot(/** @type {string} */ text) {
	return text
		.split("\n")
		.some((line) => !/^\s*#/.test(line) && /\bgr_root\b(?!\s*\(\))/.test(line));
}

/**
 * The `scripts/lib/*.sh` files a shell script's `source`/`.` lines name, by
 * basename: the sourced path is spelt through a `$here`-style variable, so
 * the basename is all that can be read. Residual: a sourced file outside
 * `scripts/lib/`, or in a subdirectory of it, resolves to no file and is not
 * walked.
 */
function sourcedLibTargets(/** @type {string} */ text) {
	const sourced = /^\s*(?:source|\.)\s+\S*?([\w-]+\.sh)\b/gm;
	return [...text.matchAll(sourced)].map(
		(m) => `scripts/lib/${requiredGroup(m, 1, sourced)}`,
	);
}

/** A script path as written, anchored under `scripts/`. */
function scriptsRel(/** @type {string} */ literal) {
	return literal.startsWith("scripts/")
		? literal
		: `scripts/${path.basename(literal)}`;
}

/** Does `rel` exist and root itself through hostRoot() or gr_root? */
function isHostRooted(
	/** @type {string} */ root,
	/** @type {string} */ rel,
	/** @type {Map<string, boolean>} */ cache,
) {
	return (
		fs.existsSync(path.join(root, rel)) &&
		rootsThroughHostRoot(root, rel, cache)
	);
}

/**
 * The `const`/`let` bindings in `source` naming a host-root-rooted script,
 * identifier to script path — through one more binding where the path sits
 * in a constant (`const SCRIPT = path.join(ROOT, CHECKER)`, #3311).
 */
function boundScripts(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = new Map();
	const binding =
		/\b(?:const|let)\s+(\w+)\s*=\s*[^;\n]*["']([\w./-]+\.(?:js|sh))["']/g;
	for (const m of source.matchAll(binding)) {
		const rel = scriptsRel(requiredGroup(m, 2, binding));
		if (isHostRooted(root, rel, cache)) {
			bound.set(requiredGroup(m, 1, binding), rel);
		}
	}
	const rebinding = /\b(?:const|let)\s+(\w+)\s*=\s*([^;\n]*)/g;
	for (const m of source.matchAll(rebinding)) {
		const id = requiredGroup(m, 1, rebinding);
		if (bound.has(id)) continue;
		const rhs = requiredGroup(m, 2, rebinding);
		for (const [name, rel] of [...bound]) {
			if (new RegExp(`\\b${name}\\b`).test(rhs)) bound.set(id, rel);
		}
	}
	return bound;
}

/**
 * The host-root-rooted scripts a test's spawn call sites name, read off the
 * call sites rather than run.
 */
function spawnedScripts(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = boundScripts(root, source, cache);

	const named = new Set();
	/* argv[0] and the first array element only: the two-token spawn shape
	 * `spawn("node", [SCRIPT, ...])` / `spawn(process.execPath, [SCRIPT, ...])`.
	 * No indirection-assumed-guilty limb here (unlike
	 * check-guard-test-isolation.js's twin): this shape's argv[0] is near
	 * always a plain interpreter, so a first array element this file cannot
	 * resolve is routinely an unrelated command's own argument (`git`,
	 * `["add", rel]`) rather than a disguised script path — flagging it would
	 * cost a false positive on every such call, not just the guilty one. */
	const spawnCall =
		/\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*((?:[^,()]|\([^()]*\))*),\s*\[\s*([^,\]]*)/g;
	const scriptLiteral = /"([\w./-]+\.(?:js|sh))"/;
	for (const m of source.matchAll(spawnCall)) {
		const interp = requiredGroup(m, 1, spawnCall).trim();
		const first = requiredGroup(m, 2, spawnCall).trim();
		if (!INTERPRETER.test(interp)) continue;
		const literal = first.match(scriptLiteral);
		if (literal) {
			const rel = scriptsRel(requiredGroup(literal, 1, scriptLiteral));
			if (isHostRooted(root, rel, cache)) {
				named.add(rel);
			}
			continue;
		}
		for (const [id, rel] of bound) {
			if (new RegExp(`\\b${id}\\b`).test(first)) named.add(rel);
		}
	}

	return [...named].sort();
}

runCheck({
	name: "host-root-test-isolation",
	usage:
		"node check-host-root-test-isolation.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
	/* Whole-tree, not a pathspec: the finding is a relationship between a test
	 * file and whatever script it spawns, and spawnedScripts follows `require`
	 * chains through scripts/lib — so the scan discovers its own scope
	 * (scripts/lib/check.js §--against, mantahostels#1833). */
	against: { profile: "host-root-test-isolation", materialise: "tree" },
	run(/** @type {any} */ ctx) {
		const { root, files } = readTrackedScripts(ctx, isJsTestFile);
		const cache = /** @type {Map<string, boolean>} */ (new Map());
		const checked = /** @type {string[]} */ ([]);
		const exempt = /** @type {string[]} */ ([]);

		for (const rel of files) {
			let source = "";
			try {
				source = fs.readFileSync(path.join(root, rel), "utf8");
			} catch (e) {
				return ctx.broken(
					`could not read the tracked file ${rel}: ${errMessage(e)}.`,
				);
			}
			const scripts = spawnedScripts(root, source, cache);
			if (scripts.length === 0) continue;
			checked.push(rel);
			if (EXEMPT.test(source)) {
				exempt.push(rel);
				continue;
			}
			if (/CLAUDE_PROJECT_DIR/.test(source)) continue;

			ctx.fail(
				"HOST-ROOT-TEST-ISOLATION",
				`${rel} spawns ${scripts.join(", ")} without setting CLAUDE_PROJECT_DIR, so the child roots itself in the real repo: it reads the live checkout and writes into the developer's .claude/tmp/markers/ (#160).`,
				{ file: rel, scripts },
			);
			ctx.say(`${rel} spawns ${scripts.join(", ")}.`);
			ctx.say(
				"  Those scripts root through hostRoot() (lib/host-root.js) or gr_root (lib/guard-root.sh), which answer an inherited CLAUDE_PROJECT_DIR first and fall back to the git top level of the spawn's cwd.",
			);
			ctx.say(
				"  Fix: give the spawn env a CLAUDE_PROJECT_DIR under the case's temp directory (scripts/run-vitest.test.ts and similar spawn helpers show the shape).",
			);
			ctx.say(
				"  Genuinely rooted at the real repo on purpose? Say so in a comment reading `isolation-exempt: <why>` and this check drops the file.",
			);
		}

		const data = {
			spawningTests: checked.length,
			exempt: exempt.length,
			scanned: files.length,
		};
		const tail =
			exempt.length > 0
				? `${exempt.length} exempt, the rest redirecting CLAUDE_PROJECT_DIR.`
				: "all redirecting CLAUDE_PROJECT_DIR.";
		return {
			okLine: `${checked.length} of ${files.length} scripts/ test files spawn a hostRoot()- or gr_root-rooted script — ${tail}`,
			noun: "unisolated host-root test",
			data,
		};
	},
});
