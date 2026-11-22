#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { readTrackedScripts } = require("./lib/tracked-scripts.js");
const { isJsTestFile } = require("./lib/test-kind.js");
const { runCheck, errMessage } = require("./lib/check.js");

/** @typedef {import("./lib/check.js").Ctx} Ctx */

const ASSIGNMENT =
	/\bprocess\.env(\.\w+|\[[^\]]+\])?\s*(?:\?\?|\|\||&&|\+)?=(?!=)|\bObject\.assign\(\s*process\.env\b/;

const DELETION = /\bdelete\s+process\.env(\.\w+|\[[^\]]+\])/;

const inScope = (/** @type {string} */ rel) =>
	isJsTestFile(rel) || (rel.startsWith("scripts/") && rel.endsWith(".ts"));

function variableOf(/** @type {string | undefined} */ target) {
	if (target === undefined) return "(whole object)";
	if (target.startsWith(".")) return target.slice(1);
	const literal = target.match(/^\[\s*(["'`])(\w+)\1\s*\]$/);
	return literal?.[2] ?? target;
}

function writesIn(/** @type {string} */ source) {
	const lines = source.split("\n");
	const out =
		/** @type {{ line: number, name: string, verb: string }[]} */ ([]);
	lines.forEach((text, i) => {
		const deleted = text.match(DELETION);
		const m = deleted ?? text.match(ASSIGNMENT);
		if (!m) return;
		const verb = deleted ? "deletes" : "assigns";
		out.push({ line: i + 1, name: variableOf(m[1]), verb });
	});
	return out;
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "test-env-writes",
	usage:
		"node check-test-env-writes.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
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
				"  To swap the whole environment around one call: `withOnlyEnv` in scripts/lib/scoped-env.ts. To leave every child of the file untraced by the read audit: `untraceChildren()` in scripts/lib/untraced-children.js (#4982).",
			);
		}
		return {
			okLine: `${files.length} test files and helpers read — none writes process.env directly.`,
			noun: "direct process.env write",
			data: { scanned: files.length },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
