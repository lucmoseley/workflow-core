#!/usr/bin/env node
/*
 * check-test-env-writes.js — a JS test file sets or unsets an environment
 * variable through `vi.stubEnv`, never by writing `process.env` directly
 * (#4019).
 *
 * Usage:
 *   node check-test-env-writes.js [--json] [--warn] [--root <dir>] [--against <rev>]
 *
 * vitest.config.ts sets `unstubEnvs: true` (#3448), so every `vi.stubEnv` is
 * undone before the next test. A direct `process.env.X = …` or
 * `delete process.env.X` is not: it outlives its case, so a later case in the
 * file reads a value it never set.
 *
 * A finding is a source line assigning `process.env.NAME` or
 * `process.env[expr]` with `=`, `??=`, `||=`, `&&=` or `+=`, deleting one,
 * replacing `process.env` whole, or `Object.assign`ing into it. A replaced object is the
 * worst: vitest's stub reads and writes the object it captured, so after it no
 * stub reaches the live environment. Every tracked file vitest collects is
 * read, `.claude/skills/` and the root included, and every `scripts/` `.ts`
 * helper a test imports.
 *
 * The scan is lexical, so a string literal holding that text reads as an
 * assignment: split the literal so the line no longer matches.
 *
 * IMPLICIT:  on every commit staging a JS test file or scripts/ .ts helper, refuses one that adds a direct `process.env` write.
 * JUSTIFIED: fail-safe — a checker that cannot enumerate or read the tracked set is BROKEN rather than green, since a silent pass lets a leaking write land.
 * DEFEAT:    --warn caps findings below the gating line; an `env-write-kept: <why>` comment on the line or the one above drops that line, and nothing validates the reason it gives.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readTrackedScripts } = require("./lib/tracked-scripts.js");
const { isJsTestFile } = require("./lib/test-kind.js");
const { runCheck, errMessage } = require("./lib/check.js");

/** @typedef {import("./lib/check.js").Ctx} Ctx */

/** `process.env`, `.NAME` or `[expr]` after it or nothing, then an assignment
 * operator that is no comparison; or `Object.assign(process.env`. Group 1 is
 * the target after `process.env`, absent for a whole-object write. */
const ASSIGNMENT =
	/\bprocess\.env(\.\w+|\[[^\]]+\])?\s*(?:\?\?|\|\||&&|\+)?=(?!=)|\bObject\.assign\(\s*process\.env\b/;

/** `delete process.env.NAME` or `delete process.env[expr]`; group 1 the target. */
const DELETION = /\bdelete\s+process\.env(\.\w+|\[[^\]]+\])/;

/** A JS test file, or a `scripts/` `.ts` helper one imports. */
const inScope = (/** @type {string} */ rel) =>
	isJsTestFile(rel) || (rel.startsWith("scripts/") && rel.endsWith(".ts"));

const KEPT = /env-write-kept:[ \t]*[A-Za-z0-9]/;

/** The variable an assignment target names: `.X` gives `X`, `["X"]` gives
 * `X`, a computed `[name]` gives `[name]`, and none gives `(whole object)`. */
function variableOf(/** @type {string | undefined} */ target) {
	if (target === undefined) return "(whole object)";
	if (target.startsWith(".")) return target.slice(1);
	const literal = target.match(/^\[\s*(["'`])(\w+)\1\s*\]$/);
	return literal?.[2] ?? target;
}

/** Each direct write in `source` no `env-write-kept:` comment keeps. */
function writesIn(/** @type {string} */ source) {
	const lines = source.split("\n");
	const out =
		/** @type {{ line: number, name: string, verb: string }[]} */ ([]);
	lines.forEach((text, i) => {
		const deleted = text.match(DELETION);
		const m = deleted ?? text.match(ASSIGNMENT);
		if (!m) return;
		if (KEPT.test(text) || KEPT.test(lines[i - 1] ?? "")) return;
		const verb = deleted ? "deletes" : "assigns";
		out.push({ line: i + 1, name: variableOf(m[1]), verb });
	});
	return out;
}

runCheck({
	name: "test-env-writes",
	usage:
		"node check-test-env-writes.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
	/* Whole-tree: the finding is a property of one test file read on its own,
	 * which the set --against materialises holds (scripts/lib/check.js
	 * §--against). */
	against: { profile: "test-env-writes", materialise: "tree" },
	run(/** @type {Ctx} */ ctx) {
		const { root, files } = readTrackedScripts(ctx, inScope, "");
		let writes = 0;
		for (const rel of files) {
			let source = "";
			try {
				source = fs.readFileSync(path.join(root, rel), "utf8");
			} catch (e) {
				return ctx.broken(
					`could not read the tracked file ${rel}: ${errMessage(e)}.`,
				);
			}
			for (const { line, name, verb } of writesIn(source)) {
				writes++;
				ctx.fail(
					"TEST-ENV-WRITE",
					`${rel}:${line} ${verb} process.env ${name} directly, which unstubEnvs never restores, so the change outlives its case (#4019).`,
					{ file: rel, name, line },
				);
				ctx.say(`${rel}:${line} ${verb} process.env ${name} directly.`);
			}
		}
		if (writes > 0) {
			ctx.say(
				'  Fix: `vi.stubEnv("NAME", value)`, or `vi.stubEnv("NAME", undefined)` to unset, and delete any hand-written save and restore of it. A stub is undone before each test, so one at module scope or in beforeAll moves into a beforeEach.',
			);
			ctx.say(
				"  A line that genuinely cannot stub? Put `env-write-kept: <why>` on it or the line above and this check drops it.",
			);
		}
		return {
			okLine: `${files.length} test files and helpers read — none writes process.env directly.`,
			noun: "direct process.env write",
			data: { scanned: files.length },
		};
	},
});
