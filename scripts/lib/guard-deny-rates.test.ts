// @vitest-environment node
/*
 * Pins guard-deny-rates.js's table to the census it was copied from.
 *
 * The table is transcribed by hand from a landed census, so the failure it can
 * have is a copying error — a digit, a band, a guard put against the wrong row.
 * This reads the census back out of `main` and diffs it, which also serves as
 * the staleness check mantahostels#3261 left optional: the day the census is re-run, this
 * fails until the table is brought up to it.
 *
 * It cannot see the OTHER staleness — a guard that joined the deny-capable set
 * after the census and so appears in neither. Nothing can; that one surfaces as
 * the block's own "deny rate UNKNOWN" line.
 *
 * A census row whose guard no longer denies — removed, or downgraded to a warn
 * (#497) — is dropped from the table, never edited, so only the rows of guards
 * still deny-capable are compared.
 *
 * guard-lost-deny.js, a `Stop` hook, prints these rates so a session can
 * decide whether re-running a guard that failed open is worth a turn; a
 * loosened case lets a mistyped rate tell it to skip a loss that mattered.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isDenyCapableIn } from "./deny-capable";
import { RATES } from "./guard-deny-rates";

const SCRIPTS = path.join(__dirname, "..");
const isDenyCapable = isDenyCapableIn([SCRIPTS]);

const CENSUS = path.join(
	__dirname,
	"..",
	"..",
	"docs",
	"data",
	"lost-deny-census-2026-09-05",
	"rates.md",
);

interface Row {
	denies: number;
	population: number;
	pct: number;
	lowPct: number;
	highPct: number;
}

/** `1.588% [1.41-1.79%]` and `0% [0-0.02%]` both. */
const RATE_CELL = /^([\d.]+)%\s*\[([\d.]+)-([\d.]+)%\]$/;

/** A census row's guard under the Node entry it was ported to, if it was. */
function portedName(guard: string): string {
	const js = guard.replace(/\.sh$/, ".js");
	return !fs.existsSync(path.join(SCRIPTS, guard)) &&
		fs.existsSync(path.join(SCRIPTS, js))
		? js
		: guard;
}

/**
 * The census table, keyed by guard. Its columns are
 * `guard | lost (Q1) | deny events | true population | true deny rate | …`.
 */
function readCensusRows(): Record<string, Row> {
	const out: Record<string, Row> = {};
	for (const line of fs.readFileSync(CENSUS, "utf8").split("\n")) {
		const cells = line
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean);
		if (cells.length !== 6 || !cells[0].startsWith("guard-")) continue;
		const rate = RATE_CELL.exec(cells[4]);
		if (!rate) continue;
		out[portedName(cells[0])] = {
			denies: Number(cells[2].replace(/,/g, "")),
			population: Number(cells[3].replace(/,/g, "")),
			pct: Number(rate[1]),
			lowPct: Number(rate[2]),
			highPct: Number(rate[3]),
		};
	}
	return out;
}

/** The census rows whose guard can still deny. */
function readLiveRows(): Record<string, Row> {
	return Object.fromEntries(
		Object.entries(readCensusRows()).filter(([g]) => isDenyCapable(g)),
	);
}

describe("the pinned table against the census it was copied from", () => {
	it("finds the census table where the module says it is", () => {
		expect(Object.keys(readCensusRows()).length).toBe(19);
	});

	it("carries every measured guard that still denies, and no other", () => {
		expect(Object.keys(RATES).sort()).toEqual(
			Object.keys(readLiveRows()).sort(),
		);
	});

	it("states every figure as the census states it", () => {
		expect(RATES).toEqual(readLiveRows());
	});
});
