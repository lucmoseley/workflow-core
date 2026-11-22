#!/usr/bin/env node

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { readSessionDraw } = require("./lib/admission.js");
const { DEFAULT_SESSION_DRAW } = require("./lib/admission-figures.js");
const { caught } = require("./lib/caught.js");
const { readControlChecked } = require("./lib/refill-files.js");
const { testGate } = require("./lib/test-gate.js");

/**
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
