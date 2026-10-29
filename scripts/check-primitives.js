#!/usr/bin/env node
/*
 * check-primitives.js — every path and § id the primitives tables name is
 * real, no local row takes a base row's job, and the count line says whether
 * the primitives are holding (#3451, spec #3365).
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
 *             over the whole tree with `--json --warn` at the host root
 *   heresies  the sub-issues of the most recently closed *Heresy sweep due*
 *             issue in the host's tracker
 * A count it cannot read prints as unknown with the reason, never as 0.
 *
 * IMPLICIT:  on every commit, refuses one leaving a primitives row whose exemplar or enforcing check path is missing, whose Rule cell cites a § id no standards file defines, or a local row naming a base row's job, naming the row.
 * JUSTIFIED: fail-safe — the table is where a session learns which file to copy; a row naming a renamed file sends it to a stray copy instead, silently.
 * DEFEAT:    --warn caps findings below the gating line; a path outside backticks in the Exemplar or Enforcing check cell goes unread, as does any path in the Primitive cell; a local row rewording a base row's job passes as a job of its own.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { coreRoot } = require("./lib/script-path.js");
const { isCoreRoot } = require("./lib/core-hooks.js");
const { caught } = require("./lib/caught.js");
const { ghApiSlurp } = require("./lib/gh.js");
const { findTrackingIssue } = require("./lib/tracking-issue.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const {
	STANDARDS_DOCS: DOCS,
	judgePrimitives,
} = require("./lib/primitives-table.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/** @typedef {import("./lib/primitives-table.js").Count} Count */
/** @typedef {import("./lib/primitives-table.js").Side} Side */
const { runCheck } = require("./lib/check");

const SWEEP_TITLE = "Heresy sweep due";

/**
 * The FAIL findings `script` reports over the whole tree.
 * @param {string} script
 * @param {string} root
 * @returns {Count}
 */
function countBreaches(script, root) {
	const r = spawnSync(process.execPath, [script, "--json", "--warn"], {
		cwd: root,
		env: { ...process.env, CLAUDE_PROJECT_DIR: root, GITHUB_ACTIONS: "" },
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error) return { unknown: `it did not run (${r.error.message})` };
	/** @type {{ outcome?: unknown, findings?: unknown }} */
	let envelope;
	try {
		envelope = JSON.parse(r.stdout);
	} catch {
		return { unknown: `it printed no --json envelope (exit ${r.status})` };
	}
	if (envelope.outcome === "BROKEN" || envelope.outcome === "SKIP")
		return { unknown: `it answered ${envelope.outcome}` };
	/* A breach is a FAIL-severity finding: a WARN, such as check-host-root's
	 * stale-allowlist note, is about the check, not a caller off the
	 * primitive. --warn caps the outcome, never a finding's severity. */
	return Array.isArray(envelope.findings)
		? {
				count: envelope.findings.filter((f) => f?.severity === "FAIL").length,
			}
		: { unknown: "its envelope carries no findings array" };
}

/**
 * The sub-issues of the most recently closed sweep issue. Sweeps run one at a
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
		const children = ghApiSlurp(
			[`repos/{owner}/{repo}/issues/${closed.number}/sub_issues`],
			{ cwd: root },
		);
		return { count: children.length };
	} catch (e) {
		const { message } = caught(e);
		return {
			unknown: `the tracker did not answer (${message.split("\n")[0]})`,
		};
	}
}

/**
 * Print and record each finding.
 * @param {Ctx} ctx
 * @param {import("./lib/primitives-table.js").Finding[]} findings
 * @param {boolean} inAdopter
 */
function report(ctx, findings, inAdopter) {
	for (const f of findings) {
		const at = `${DOCS[f.side]}${f.line > 0 ? `:${f.line}` : ""}`;
		const row = f.job ? ` (row "${f.job}")` : "";
		const pluginsToFix = f.side === "base" && inAdopter;
		const message = `${at}${row}: ${f.message}${pluginsToFix ? " — the plugin's to fix" : ""}`;
		ctx.say(`  ${message}`);
		if (pluginsToFix) ctx.warn("PRIMITIVES", message, { file: DOCS[f.side] });
		else ctx.fail("PRIMITIVES", message, { file: DOCS[f.side] });
	}
}

runCheck({
	name: "primitives",
	usage:
		"node scripts/check-primitives.js [--root <dir>] [--paths-only] [--json] [--warn]",
	valueFlags: ["--root"],
	flags: ["--paths-only"],
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const plugin = coreRoot();
		/** @type {Record<Side, string>} */
		const roots = { base: plugin, local: root };
		const inAdopter = !isCoreRoot(root, { core: plugin });
		const result = judgePrimitives(
			{
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
				countBreaches: (side, rel) =>
					countBreaches(path.join(roots[side], rel), root),
				readNewHeresies: () => readNewHeresies(root),
			},
			{ counts: !ctx.has("--paths-only") },
		);
		if (result.broken)
			return ctx.broken(
				`${result.broken} (${path.join(plugin, DOCS.base)}) — nothing was judged`,
			);
		report(ctx, result.findings, inAdopter);
		/* The OK line carries it on a clean run; with findings, nothing would. */
		if (result.countLine && ctx.findings.length > 0)
			ctx.say(`  ${result.countLine}.`);
		const table = `${result.rows.length} primitives row(s), every path and § id real`;
		return {
			okLine: result.countLine ? `${table}. ${result.countLine}.` : `${table}.`,
			noun: "primitives table fault(s)",
			count: ctx.findings.length,
			data: { rows: result.rows.length, countLine: result.countLine },
		};
	},
});
