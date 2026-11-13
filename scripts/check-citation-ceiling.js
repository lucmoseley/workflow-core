#!/usr/bin/env node
/*
 * check-citation-ceiling.js — is the core's tracker within MARGIN of
 * qualify-citations.js's CITATION_CEILING? (workflow-core#726)
 *
 * Usage:  node check-citation-ceiling.js [--json] [--require-remote]
 *         npm run status -- --only citation-ceiling
 *
 * WHAT CROSSING IT COSTS, silently. The release build qualifies a `#N` only up
 * to the ceiling, so a citation above it ships bare and names the adopter's own
 * issue #N; and lib/citation-tracker.js, whose BAND_MAX is the same number,
 * stops judging a mis-prefixed `mantahostels#N` above it.
 *
 * THE TRACKER'S TOP IS ITS NEWEST ISSUE OR PULL REQUEST, the two sharing one
 * number sequence and both being citable.
 *
 * SKIPS in an adopter and where `gh` cannot reach GitHub. The daily repo-checks
 * run judges it, not the sweep, whose token cannot read the private tracker
 * (workflow-core#1963). --require-remote makes an unreachable GitHub BROKEN instead, for a
 * caller nobody reads a SKIP from (workflow-core#263).
 */

const { runCheck } = require("./lib/check");
const { parseGhFailureReason, ghJson, raiseGhFailure } = require("./lib/gh");
const { CITATION_CEILING } = require("./lib/qualify-citations.js");
const {
	UPSTREAM_TRACKER,
	resolveKey,
} = require("./lib/workflow-core-config.js");

/*
 * Ten days at the fastest rate measured, ~100 issues a day (workflow-core#726), against a
 * sweep delivered every ~12 hours.
 */
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
				/* Keyed on the ceiling, not the top, so a reading that moves the top
				 * restates one standing finding rather than adding one (workflow-core#1963). */
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
