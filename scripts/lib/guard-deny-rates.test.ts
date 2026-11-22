// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isDenyCapableIn, isDenyingCore } from "./deny-capable";
import { corePath, readManifest } from "./guard-cores";
import { RATES } from "./guard-deny-rates";

const SCRIPTS = path.join(__dirname, "..");
const isDenyCapable = isDenyCapableIn([SCRIPTS]);

const CORES = new Map(
	readManifest(path.join(__dirname, "guard-cores.json")).PreToolUse.map((r) => [
		r.name,
		r,
	]),
);

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

const RATE_CELL = /^([\d.]+)%\s*\[([\d.]+)-([\d.]+)%\]$/;

function portedName(guard: string): string {
	const core = guard.replace(/\.sh$/, "");
	if (CORES.has(core)) return core;
	const js = guard.replace(/\.sh$/, ".js");
	return !fs.existsSync(path.join(SCRIPTS, guard)) &&
		fs.existsSync(path.join(SCRIPTS, js))
		? js
		: guard;
}

function isLiveDenier(name: string): boolean {
	const core = CORES.get(name);
	return core ? isDenyingCore(corePath(core.core)) : isDenyCapable(name);
}

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

function readLiveRows(): Record<string, Row> {
	return Object.fromEntries(
		Object.entries(readCensusRows()).filter(([g]) => isLiveDenier(g)),
	);
}

describe("the pinned table against the census it was copied from", () => {
	it("reads every row of the census table", () => {
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
