#!/usr/bin/env node

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
