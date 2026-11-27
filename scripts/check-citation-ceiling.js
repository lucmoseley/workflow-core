#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const { parseGhFailureReason, ghJson, raiseGhFailure } = require("./lib/gh");
const { CITATION_CEILING } = require("./lib/qualify-citations.js");
const {
	UPSTREAM_TRACKER,
	resolveKey,
} = require("./lib/workflow-core-config.js");

// measured ~160 issues a day at the fastest week, workflow-core#5356
const MARGIN = 1000;

runCheck({
	name: "citation-ceiling",
	usage: "node check-citation-ceiling.js [--json] [--require-remote]",
	flags: ["--require-remote"],
	run(ctx) {
		const host = resolveKey("tracker");
		if (host !== UPSTREAM_TRACKER)
			ctx.skip(
				`this host's tracker is ${host ?? "unresolved"}, not ${UPSTREAM_TRACKER}; the ceiling is the core's to raise.`,
			);

		/** @type {{ number: number }[]} */
		let newest = [];
		try {
			newest = ghJson([
				"api",
				`repos/${UPSTREAM_TRACKER}/issues?state=all&sort=created&direction=desc&per_page=1`,
			]);
		} catch (e) {
			if (
				ctx.has("--require-remote") &&
				parseGhFailureReason(e) === "unreachable"
			)
				ctx.broken(
					"GitHub is unreachable and --require-remote is set, so the tracker's top is unknown.",
				);
			raiseGhFailure(e, "No ceiling conclusion drawn.");
		}
		const top = newest[0]?.number;
		if (typeof top !== "number")
			return ctx.broken(
				`${UPSTREAM_TRACKER} answered with no issue number, so its top is unknown.`,
			);

		const left = CITATION_CEILING - top;
		const data = { top, ceiling: CITATION_CEILING, margin: MARGIN };
		const where = `${UPSTREAM_TRACKER} is at #${top}, ${left <= 0 ? `${-left} past` : `${left} short of`} CITATION_CEILING (${CITATION_CEILING})`;
		if (left <= MARGIN) {
			ctx.fail(
				"CITATION-CEILING",
				`${where} — raise it in scripts/lib/qualify-citations.js, with its derivation, before a citation above it ships bare.`,
				data,
				`CITATION-CEILING\t${CITATION_CEILING}`,
			);
		}
		return {
			okLine: `${where}, outside the ${MARGIN} margin.`,
			noun: "ceiling finding",
			data,
		};
	},
});
