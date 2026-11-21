// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "replay-gate-budget.js");

let dir: string;
let record: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-gate-budget-"));
	record = path.join(dir, ".refill-breaker.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) =>
	runInProcess(SCRIPT, ["--record", record, ...args]);

it("replays no park off a record holding none, under the figures it is given", () => {
	fs.writeFileSync(
		record,
		`${JSON.stringify({ at: "2026-11-21T00:00:00.000Z", repo: dir, event: "open" })}\n`,
	);
	const r = run("--streak", "3", "--systemic-hours", "1");
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(
		"park on 3 failed whole-suite runs in a row, or 10 counted; a ceiling is systemic at 2 other sessions in 1 h",
	);
	expect(r.stdout).toContain("Kept 0, released 0, of 0 parks.");
});

it("names a park whose checkout's gate-run record will not read, and replays nothing of it", () => {
	fs.writeFileSync(
		record,
		`${JSON.stringify({ at: "2026-11-21T00:00:00.000Z", repo: dir, event: "budget-park", session: "s-gone-12345", ticket: 7 })}\n`,
	);
	const r = run();
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(
		`${path.basename(dir)} #7 s-gone-1: not replayed, its checkout's gate-run record will not read`,
	);
	expect(r.stdout).toContain("of 0 parks.");
});

it("refuses a figure that is no positive number, and a record that will not read", () => {
	fs.writeFileSync(record, "");
	expect(run("--backstop", "0").status).toBe(2);
	expect(run("--sleep-s", "x").stderr).toContain(
		"--sleep-s x is not a positive number",
	);
	fs.rmSync(record);
	expect(run().stderr).toContain("will not read");
});
