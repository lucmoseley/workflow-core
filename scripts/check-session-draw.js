#!/usr/bin/env node
/*
 * check-session-draw.js — warn on each served repo whose tests are gated at
 * commit and that declares no session draw, so admission charges its sessions
 * the pooled default (#5274, spec #5273 §2).
 *
 * Usage:  node scripts/check-session-draw.js [--notify] [--json]
 *
 * A served repo is one in the refill loop's `repos` list. A commit-gated repo's
 * sessions each run a gate seat, whose memory the session sampler leaves out,
 * so the repo's own `sessionMeanMb`/`sessionSigmaMb` is what prices the rest;
 * undeclared, it is the pooled 587/304 MB.
 *
 * WFC_REFILL_DIR injects the loop's control file.
 *
 * IMPLICIT:  on `npm run status`, reads the refill loop's served repos and each one's config, and warns on each commit-gated repo declaring no session draw; prints nothing on a served repo that declares one.
 * JUSTIFIED: fail-safe — otherwise a commit-gated repo's sessions are priced at a pooled draw measured on other repos, with nothing saying so (#5273).
 * DEFEAT:    none; declaring both keys in the repo's .claude/workflow-core.json clears it.
 * TREE:      host — reads the machine's loop control and each served checkout's config
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { readSessionDraw } = require("./lib/admission.js");
const { DEFAULT_SESSION_DRAW } = require("./lib/admission-figures.js");
const { caught } = require("./lib/caught.js");
const { readControlChecked } = require("./lib/refill-files.js");
const { testGate } = require("./lib/test-gate.js");

/**
 * The served repos that owe a declared session draw: commit-gated, with
 * neither key read. A repo whose config will not read is named with why.
 * @param {string[]} roots
 * @returns {{ root: string, why: string | null }[]}
 */
function readUndeclared(roots) {
	/** @type {{ root: string, why: string | null }[]} */
	const owed = [];
	for (const root of roots) {
		/** @type {string | null} */
		let gate;
		try {
			gate = testGate({ root }).gate;
		} catch (e) {
			owed.push({ root, why: caught(e).message });
			continue;
		}
		if (gate !== "commit") continue;
		const draw = readSessionDraw(root);
		if (!draw.declared) owed.push({ root, why: draw.problem ?? null });
	}
	return owed;
}

runCheck({
	name: "session-draw",
	usage: "node check-session-draw.js [--notify] [--json]",
	run(ctx) {
		const { control, damaged } = readControlChecked(() => undefined);
		if (damaged) return ctx.broken(damaged);
		const roots = control?.scope.repos ?? [];
		if (roots.length === 0) return ctx.skip("the refill loop serves no repo.");
		const owed = readUndeclared(roots);
		const pooled = `${DEFAULT_SESSION_DRAW.meanMb}/${DEFAULT_SESSION_DRAW.sigmaMb} MB`;
		if (owed.length === 0)
			return {
				okLine: `every commit-gated repo of ${roots.length} served declares its session draw`,
			};
		for (const { root, why } of owed) {
			const repo = path.basename(root);
			const line = `${repo} gates its tests at commit and declares no sessionMeanMb/sessionSigmaMb, so admission charges each of its sessions the pooled ${pooled}${why ? ` (${why})` : ""}; measure it and declare both in ${path.join(root, ".claude", "workflow-core.json")}`;
			ctx.warn("UNDECLARED-DRAW", line, { repo }, repo);
			ctx.say(`UNDECLARED-DRAW — ${line}`);
		}
		return { noun: "undeclared session draw(s)" };
	},
});
