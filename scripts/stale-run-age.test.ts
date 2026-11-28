// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "stale-run-age.js");
const { parseVerdict } = require("./lib/gate-check.js");
const DAY_MS = 86_400_000;
const NOW = "2026-11-28T06:00:00.000Z";

let dir: string;
const run = (args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd: dir,
		env: {
			...process.env,
			WFC_NOW: NOW,
			WFC_REFILL_DIR: path.join(dir, "refill"),
		},
	});
const writeRows = (...ages: number[]) => {
	fs.mkdirSync(path.join(dir, "refill"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "refill", ".stale-run-record.jsonl"),
		ages
			.map(
				(a) =>
					`${JSON.stringify({ date: new Date(Date.parse(NOW) - a * DAY_MS).toISOString() })}\n`,
			)
			.join(""),
	);
};

beforeEach(() => {
	dir = mkScratchDir("stale-run-age-");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("stale-run-age", () => {
	it("reads the first row's age as a count the gate judge parses", () => {
		writeRows(22, 3, 0);
		const r = run(["21"]);
		expect(r.stdout).toMatch(/^22 of 21 days since/);
		expect(parseVerdict(r.stdout)).toBe("met");
		expect(parseVerdict(run(["42"]).stdout)).toBe("unmet");
	});

	it("reads 0 where no run is recorded", () => {
		const r = run(["21"]);
		expect(r.stdout).toBe(
			"0 of 21 days: no stale-ticket run is recorded yet\n",
		);
		expect(parseVerdict(r.stdout)).toBe("unmet");
	});

	it("refuses a missing day count", () => {
		expect(run([]).status).toBe(2);
	});
});
