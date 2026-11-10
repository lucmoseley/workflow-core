#!/usr/bin/env node
/*
 * check-pass-store.js — how many test files the per-file pass store kept
 * from running in the last WINDOW_DAYS, against how many the runs that
 * looked it up still ran (#4790), on `npm run status`.
 *
 * Usage:  node scripts/check-pass-store.js [--json]
 *
 * READ-ONLY: it reads the run ledger (lib/run-ledger.js) under the canonical
 * checkout's markers, whose `cachedFiles` is null on a run that looked
 * nothing up — a full run, `--retest`, `--fresh`, the lander — and so
 * counts toward neither figure. A reading, never a finding.
 */

const path = require("node:path");
const { now, runCheck } = require("./lib/check");
const { readJsonl } = require("./lib/jsonl.js");
const { markersDir } = require("./lib/marker-root.js");
const { DAY_MS } = require("./lib/retained-jsonl.js");
const { RUN_LEDGER } = require("./lib/run-ledger.js");
const { ARCHIVE_MS, repoRoot } = require("./lib/test-pass-marker.js");

/* The store's own retention. */
const WINDOW_DAYS = ARCHIVE_MS / DAY_MS;

runCheck({
	name: "pass-store",
	usage: "node check-pass-store.js [--json]",
	run(ctx) {
		const canonical =
			repoRoot() ?? ctx.skip("git names no canonical checkout.");
		const since = now() - WINDOW_DAYS * DAY_MS;
		const looked = (
			readJsonl(path.join(markersDir(canonical), RUN_LEDGER))?.rows ?? []
		).filter(
			(r) =>
				typeof r.at === "string" &&
				Date.parse(r.at) >= since &&
				typeof r.cachedFiles === "number",
		);
		const hits = looked.reduce((n, r) => n + Number(r.cachedFiles), 0);
		const misses = looked.reduce(
			(n, r) => n + (typeof r.ranFiles === "number" ? r.ranFiles : 0),
			0,
		);
		const rate =
			hits + misses > 0
				? `, ${Math.round((100 * hits) / (hits + misses))}% cached`
				: "";
		return {
			okLine: `pass store, last ${WINDOW_DAYS} days: ${hits} file(s) cached, ${misses} run, over ${looked.length} run(s) that looked it up${rate}.`,
			data: { runs: looked.length, hits, misses },
		};
	},
});
