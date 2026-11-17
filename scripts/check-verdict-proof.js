#!/usr/bin/env node
/*
 * check-verdict-proof.js — the state of the declared test command's verdict
 * proof (lib/verdict-probe.js, #5294), for `npm run status`: fresh, so the
 * lander's run is the test gate and commits run none; stale, so the next
 * commit probes; failed, with the clause the command broke, so commits run
 * the suite; or no canary declared. It reads and never probes.
 *
 * IMPLICIT: none — a report; nothing reads its exit but status.
 */

const { runCheck } = require("./lib/check");
const { readConfig } = require("./lib/workflow-core-config.js");
const { worktreeRoot } = require("./lib/host-root.js");
const {
	CONTRACT_AT,
	buildNoProofReason,
	proofState,
	recordPath,
} = require("./lib/verdict-probe.js");

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "verdict-proof",
	usage: "node check-verdict-proof.js [--json]",
	run(ctx) {
		let cfg;
		try {
			cfg = readConfig({ quiet: true });
		} catch (e) {
			return ctx.broken(`the config will not read: ${String(e)}`);
		}
		const command = cfg.commands.test;
		if (command === null)
			return { okLine: "no commands.test declared, so no verdict proof" };
		const state = proofState({
			root: worktreeRoot(),
			command,
			canary: cfg.testCanary,
		});
		if (state.state === "fresh")
			return {
				okLine: `verdict proof fresh: \`${command}\` gives the lander a verdict, so commits run no suite.`,
			};
		if (state.state === "stale")
			return {
				okLine: `verdict proof stale: the next commit probes \`${command}\` on ${cfg.testCanary}.`,
			};
		const until =
			state.state === "failed"
				? ` until the command, its runner or the canary changes — or, its cause fixed outside them, until ${recordPath()} is deleted, so the next commit probes again`
				: "";
		ctx.fail(
			state.state === "none" ? "NO-CANARY" : "PROBE-FAILED",
			`${buildNoProofReason(state)}, so every commit runs \`${command}\`${until}. The verdict contract: ${CONTRACT_AT}.`,
		);
		for (const f of ctx.findings) ctx.say(`  ${f.message}`);
		return {
			okLine: "",
			noun: "verdict proof fault(s)",
			count: ctx.findings.length,
		};
	},
};

runCheck(SPEC);
