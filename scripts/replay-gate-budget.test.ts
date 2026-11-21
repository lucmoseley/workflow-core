// @vitest-environment node

import { execFileSync } from "node:child_process";
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

it("replays a park off its checkout's real gate-run record, config and git, and sweeps it", () => {
	const repo = path.join(dir, "checkout");
	fs.mkdirSync(path.join(repo, ".claude", "tmp", "markers"), {
		recursive: true,
	});
	execFileSync("git", ["init", "-q", repo]);
	fs.writeFileSync(
		path.join(repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, commands: { test: "npm run test" } }),
	);
	const at = (minute: number) =>
		new Date(
			Date.parse("2026-11-21T01:00:00.000Z") + minute * 60_000,
		).toISOString();
	fs.writeFileSync(
		path.join(repo, ".claude", "tmp", "markers", ".gate-runs.jsonl"),
		[1, 2, 3, 4]
			.map((m) =>
				JSON.stringify({
					at: at(m),
					repo: "checkout",
					tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
					command: "npm run test",
					session: "s-thrash-1",
					ticket: 7,
					waitS: 0,
					runS: 200,
					wallS: 200,
					outcome: "red",
					peakTreeMb: 0,
				}),
			)
			.join("\n"),
	);
	fs.writeFileSync(
		record,
		`${JSON.stringify({ at: at(10), repo, event: "budget-park", session: "s-thrash-1", ticket: 7 })}\n`,
	);
	const r = run();
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(
		`checkout #7 s-thrash, parked ${at(10)}: kept at ${at(4)}`,
	);
	expect(r.stdout).toContain("Kept 1, released 0, of 1 parks.");
	const swept = run("--sweep");
	expect(swept.stdout).toContain("4 10 1: checkout #7 s-thrash");
	expect(swept.stdout).toContain("5 10 0: none");
	expect(run("--nope").status).toBe(2);
});
