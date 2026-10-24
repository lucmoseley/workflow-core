#!/usr/bin/env node
/*
 * check-marker-integrity.js — how many lines of the two test-pass-marker
 * stores could not be read back as a marker (#182 acceptance criterion: "A
 * malformed store line is counted and reported through `npm run status`,
 * and still never fails a push").
 *
 * WHY THIS EXISTS. `readMarkers` (scripts/lib/test-pass-marker.js) skips a
 * malformed line silently, by design — a store this hook cannot parse must
 * degrade to "no marker", never to a failed push. That silence is also how a
 * real record disappears with nothing said: #182 found
 * `.test-fail-markers.jsonl:45` as 738 NUL bytes followed by a complete,
 * valid marker — a torn append, not the whitespace #149 reported — and the
 * same tearing mechanism can drop a full-run record just as easily.
 *
 * WARN, NEVER FAIL (#182's own words), same as every marker-store reader in
 * this family: a session's push is never blocked on this. `npm run status`
 * is the one channel it speaks on — never a Husky hook, never CI.
 *
 * NO ROTATION AND NO REPAIR. This reports a count; it moves, deletes and
 * rewrites nothing. #156 Q3 declined rotating either store while #148 is
 * still being priced off its history.
 */

const { runCheck } = require("./lib/check");
const {
	STORE,
	FAIL_STORE,
	repoRoot,
	countMalformed,
} = require("./lib/test-pass-marker.js");
const { MARKERS_REL } = require("./lib/marker-root.js");

runCheck({
	name: "marker-integrity",
	usage: "node check-marker-integrity.js [--root <dir>] [--notify] [--json]",
	valueFlags: ["--root"],
	run(ctx) {
		const root = ctx.value("--root") ?? repoRoot();
		if (!root)
			return ctx.skip("git would not say where the marker stores live.");

		const stores = [
			{ id: "green", name: STORE },
			{ id: "red", name: FAIL_STORE },
		];
		const counts = stores.map(({ id, name }) => ({
			id,
			name,
			...countMalformed({ root, store: name }),
		}));

		for (const c of counts) {
			if (!c.malformed) continue;
			const message = `${c.malformed} of ${c.total} line(s) in ${MARKERS_REL}/${c.name} could not be read back as a marker — a real record, silently dropped.`;
			ctx.warn("MARKER-TORN", message, {
				store: c.name,
				malformed: c.malformed,
				total: c.total,
			});
			ctx.say(`MARKER-TORN — ${message}`);
		}

		const totalMalformed = counts.reduce((n, c) => n + c.malformed, 0);
		const totalLines = counts.reduce((n, c) => n + c.total, 0);

		return {
			okLine: totalLines
				? `every line in both marker stores (${totalLines} total) reads back as a marker.`
				: "neither marker store exists yet — nothing to check.",
			noun: "malformed marker line(s)",
			data: {
				totalMalformed,
				totalLines,
				stores: Object.fromEntries(
					counts.map((c) => [
						c.id,
						{ store: c.name, malformed: c.malformed, total: c.total },
					]),
				),
			},
		};
	},
});
