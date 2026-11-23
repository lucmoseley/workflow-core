#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { readTrackedScripts } = require("./lib/tracked-scripts.js");
const { isJsTestFile } = require("./lib/test-kind.js");

const { runCheck, errMessage } = require("./lib/check.js");
const { exemptHint, exemptMarker } = require("./lib/exempt-markers.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { segmentTailMatches } = require("./lib/line-scan.js");
const { stripComments } = require("./lib/strip-comments.js");

const EXEMPT = exemptMarker("isolation");

const INTERPRETER =
	/^(process\.execPath|"node"|"bash"|"sh"|"git"|"gh"|"npm"|"npx")$/;

const TRANSITIVITY_STOP = new Set([
	"scripts/lib/check.js",
	"scripts/lib/workflow-core-config.js",
]);

/**
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, boolean>} cache
 * @param {Set<string>} [seen]
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
	const code = shell ? text : stripComments(text);
	let answer = shell
		? callsGrRoot(code)
		: /require\(["'][^"']*\/host-root(?:\.js)?["']\)/.test(code) ||
			/require\(["'][^"']*\/marker-root(?:\.js)?["']\)/.test(code);
	if (!answer)
		answer = (
			shell ? sourcedLibTargets(code) : relativeRequireTargets(rel, code)
		).some(
			(target) =>
				target !== GR_SEAM &&
				fs.existsSync(path.join(root, target)) &&
				rootsThroughHostRoot(root, target, cache, seen),
		);
	cache.set(rel, answer);
	return answer;
}

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

function callsGrRoot(/** @type {string} */ text) {
	return text
		.split("\n")
		.some(
			(line) =>
				!/^\s*#/.test(line) &&
				/\bgr_(?:worktree_)?root\b(?!\s*\(\))/.test(line),
		);
}

const GR_SEAM = "scripts/lib/guard-root.sh";

function sourcedLibTargets(/** @type {string} */ text) {
	const sourced =
		/^[^\S\n\r\u2028\u2029]*(?:source|\.)\s+\S*?(?<![\w-])([\w-]+\.sh)\b/gm;
	return [...text.matchAll(sourced)].map(
		(m) => `scripts/lib/${requiredGroup(m, 1, sourced)}`,
	);
}

function scriptsRel(/** @type {string} */ literal) {
	return literal.startsWith("scripts/")
		? literal
		: `scripts/${path.basename(literal)}`;
}

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

function boundScripts(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = new Map();
	const binding = /\b(?:const|let)\s+(\w+)\s*=\s*(?!\s)/g;
	const pathLiteral = /[^;\n]*["']([\w./-]+\.(?:js|sh))["']/y;
	for (const m of segmentTailMatches(source, binding, pathLiteral, ";\n")) {
		const rel = scriptsRel(requiredGroup(m.tail, 1, pathLiteral));
		if (isHostRooted(root, rel, cache)) {
			bound.set(requiredGroup(m.head, 1, binding), rel);
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

function spawnedScripts(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = boundScripts(root, source, cache);

	const named = new Set();
	const spawnCall =
		/\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*(?!\s)((?:[^,()]|\([^()]*\))*),\s*\[\s*([^,\]]*)/g;
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

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "host-root-test-isolation",
	usage:
		"node check-host-root-test-isolation.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
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
				"  Those scripts root through hostRoot() (lib/host-root.js) or gr_root (lib/guard-root.sh), which answer an inherited CLAUDE_PROJECT_DIR first and fall back to the main checkout owning the spawn's cwd.",
			);
			ctx.say(
				"  Fix: give the spawn env a CLAUDE_PROJECT_DIR under the case's temp directory (scripts/run-vitest.test.ts and similar spawn helpers show the shape).",
			);
			ctx.say(
				`  Genuinely rooted at the real repo on purpose? Record why on an issue and put ${exemptHint("isolation")} in a comment naming it; this check drops the file.`,
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
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
