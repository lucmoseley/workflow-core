#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { coreRoot, scriptPath } = require("./lib/script-path.js");
const { isCoreRoot } = require("./lib/core-hooks.js");
const { caught } = require("./lib/caught.js");
const { ghJson } = require("./lib/gh.js");
const { findTrackingIssue } = require("./lib/tracking-issue.js");
const { pool } = require("./lib/pool.js");
const {
	STANDARDS_DOCS: DOCS,
	countPrimitives,
	judgePrimitives,
	parseBreaches,
	primitivesOutcome,
	buildFindingReports,
} = require("./lib/primitives-table.js");
const { SWEEP_TITLE, parseFiledHeresies } = require("./lib/heresy-sweep.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/primitives-table.js").Count} Count */
/** @typedef {import("./lib/primitives-table.js").Side} Side */
const { runCheck } = require("./lib/check");

// guess, #4311
const COUNT_WIDTH = 4;

/**
 * @param {string} script
 * @param {string} root
 * @returns {Promise<Count>}
 */
function countBreaches(script, root) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, "--json", "--warn"], {
			cwd: root,
			env: { ...process.env, CLAUDE_PROJECT_DIR: root, GITHUB_ACTIONS: "" },
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.on("error", (e) =>
			resolve({ unknown: `it did not run (${e.message})` }),
		);
		child.on("close", (status) => resolve(parseBreaches(out, status)));
	});
}

/**
 * @param {string} root
 * @returns {Count}
 */
function readNewHeresies(root) {
	try {
		const closed = findTrackingIssue({ title: SWEEP_TITLE }, "closed", {
			cwd: root,
		});
		if (!closed) return { unknown: `no *${SWEEP_TITLE}* issue has closed yet` };
		const { comments } = ghJson(
			["issue", "view", String(closed.number), "--json", "comments"],
			{ cwd: root },
		);
		return parseFiledHeresies(closed.number, comments);
	} catch (e) {
		const { message } = caught(e);
		return {
			unknown: `the tracker did not answer (${message.split("\n")[0]})`,
		};
	}
}

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "primitives",
	usage: `node ${scriptPath("check-primitives.js")} [--root <dir>] [--paths-only] [--json] [--warn]`,
	valueFlags: ["--root"],
	flags: ["--paths-only"],
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const plugin = coreRoot();
		/** @type {Record<Side, string>} */
		const roots = { base: plugin, local: root };
		const inAdopter = !isCoreRoot(root, { core: plugin });
		const result = judgePrimitives({
			read: (side) => {
				const at = path.join(roots[side], DOCS[side]);
				try {
					return fs.readFileSync(at, "utf8");
				} catch (e) {
					if (caught(e).code === "ENOENT") return null;
					return ctx.broken(
						`${at} could not be read (${caught(e).message}) — nothing was judged`,
					);
				}
			},
			exists: (side, rel) => fs.existsSync(path.join(roots[side], rel)),
		});
		if (result.broken)
			return ctx.broken(
				`${result.broken} (${path.join(plugin, DOCS.base)}) — nothing was judged`,
			);
		for (const { message, file, gates } of buildFindingReports(
			result.findings,
			inAdopter,
		)) {
			ctx.say(`  ${message}`);
			if (gates) ctx.fail("PRIMITIVES", message, { file });
			else ctx.warn("PRIMITIVES", message, { file });
		}
		/** @param {string | null} countLine */
		const outcome = (countLine) => {
			const { okLine, extraLine } = primitivesOutcome({
				rows: result.rows.length,
				line: countLine,
				findings: ctx.findings.length,
			});
			if (extraLine) ctx.say(`  ${extraLine}`);
			return {
				okLine,
				noun: "primitives table fault(s)",
				count: ctx.findings.length,
				data: { rows: result.rows.length, countLine },
			};
		};
		if (ctx.has("--paths-only")) return outcome(null);
		return countPrimitives(result, {
			countBreaches: (checks) =>
				pool(checks, COUNT_WIDTH, ({ side, rel }) =>
					countBreaches(path.join(roots[side], rel), root),
				),
			readNewHeresies: () => readNewHeresies(root),
		}).then(outcome);
	},
};

const main = () => runCheck(SPEC);

module.exports = { main, SPEC };
if (require.main === module) main();
