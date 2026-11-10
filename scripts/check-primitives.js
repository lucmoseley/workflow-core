#!/usr/bin/env node
/*
 * check-primitives.js — every path and § id the primitives tables name is
 * real, no local row takes a base row's job, and the count line says whether
 * the primitives are holding (workflow-core#3451, spec workflow-core#3365).
 *
 * Usage:
 *   node scripts/check-primitives.js [--root <dir>] [--paths-only] [--json] [--warn]
 *
 * A BASE ROW'S FAULT ONLY WARNS IN AN ADOPTER. In the core the two roots are
 * one, and it FAILs.
 *
 * THE COUNTS. `--paths-only` is the pre-commit run, stat calls alone, and
 * prints no count line. A bare run counts:
 *   enforced  rows whose Enforcing check names a program
 *   breaches  the FAIL-severity findings each such program reports, run once
 *             over the whole tree with `--json --warn` at the host root; one
 *             answering SKIP adds 0
 *   heresies  the `**Filed:**` figure on the newest comment carrying one, on
 *             the most recently closed *Heresy sweep due* issue in the host's
 *             tracker
 * A count it cannot read prints as unknown with the reason, never as 0.
 *
 * IMPLICIT:  on every commit, refuses one leaving a primitives row whose exemplar or enforcing check path is missing, whose Rule cell cites a § id no standards file defines, or a local row naming a base row's job, naming the row.
 * JUSTIFIED: fail-safe — the table is where a session learns which file to copy; a row naming a renamed file sends it to a stray copy instead, silently.
 * DEFEAT:    --warn caps findings below the gating line; a path outside backticks in the Exemplar or Enforcing check cell goes unread, as does any path in the Primitive cell; a local row rewording a base row's job passes as a job of its own.
 */

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

/* How many breach-count checks run at once (workflow-core#4311). A guess, not a
 * measurement: each is a node start of some 50 MB, against the 10 GB cap every
 * session shares (CLAUDE.md §Machine limits), and `npm run status` runs this
 * beside three other checkers. Neither the 50 MB nor the width was measured. */
const COUNT_WIDTH = 4;

/**
 * The FAIL findings `script` reports over the whole tree.
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
 * What the most recently closed sweep issue says it filed. Sweeps run one at a
 * time, the open one refreshed rather than filed again.
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

const main = () =>
	runCheck({
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
						/* Absent is no table; any other failure is the reading
						 * apparatus's, never "no table" (base §N5). */
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
	});

module.exports = { main };
if (require.main === module) main();
