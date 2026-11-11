// @vitest-environment node
/*
 * check-time-to-land.js and time-to-land.js (#4951), each run once
 * for real over a queue log and a lander log written into a fixture
 * checkout's markers directory.
 *
 * Loosen it and a queue landing in many times the suite's own time reports
 * OK on `npm run status`, a repo with the `landing` module off hears of a
 * queue it never ran, or the report prints another window's batches.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const CHECK = path.resolve(__dirname, "check-time-to-land.js");
const REPORT = path.resolve(__dirname, "time-to-land.js");
const S = 1000;

let work: string;

beforeEach(() => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), "time-to-land-check-"));
	execFileSync("git", ["init", "-q", "-b", "main", work]);
});

afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

/**
 * The logs of 100 queue refs landed in the last hour, a green run of 180 s
 * among them: the first `over` took `slow` s from take to land, the rest
 * 200 s. 16 of 100 is the fewest over a 540 s target that calls it over.
 */
const writeLogs = (slow: number, over = 16) => {
	const now = Date.now();
	const iso = (t: number) => new Date(t).toISOString();
	const dir = path.join(work, ".claude", "tmp", "markers");
	fs.mkdirSync(dir, { recursive: true });
	const rows = Array.from({ length: 100 }, (_, k) => {
		const ref = `refs/heads/queue/r${k}`;
		const sha = String(k).padStart(40, "0");
		const at = now - 3600 * S + k * S;
		const took = (k < over ? slow : 200) * S;
		return [
			{ at: iso(at - took), event: "take", ref, sha },
			{ at: iso(at), event: "land", ref, sha },
		];
	})
		.flat()
		.sort((a, b) => a.at.localeCompare(b.at));
	fs.writeFileSync(
		path.join(dir, ".queue-log.jsonl"),
		`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	fs.writeFileSync(
		path.join(dir, ".lander.log"),
		[
			`${iso(now - 1000 * S)} take-batch onto m0 as lander/batch-0: queue/r0@000000000`,
			`${iso(now - 999 * S)} merge-members onto m0: queue/r0`,
			`${iso(now - 990 * S)} test-sha abc`,
			`${iso(now - 810 * S)} fast-forward-main abc`,
			"",
		].join("\n"),
	);
};

const run = (script: string, args: string[], modules = "landing") => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_MODULES: modules,
		CLAUDE_PROJECT_DIR: work,
	};
	delete env.WFC_NOTIFY_PERSIST;
	return runInProcess(script, args, { cwd: work, env });
};

it("warns where enough of the week's stays are over 3 times the green suite's p50, naming both and the report", () => {
	writeLogs(541);

	const r = run(CHECK, ["--notify"]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain(
		"SLOW-LANDING — take-to-land p90 541 s, p50 200 s, over 100 queue ref(s) taken and landed or dropped in 7 days; target 540 s, 3 times the green suite's p50 of 180 s over 1 run(s); 16 of 100 over the target, 16 calling it over",
	);
	expect(r.stdout).toContain("node scripts/time-to-land.js");
});

it("warns of nothing one stay short of the count, however slow the stays over", () => {
	writeLogs(5000, 15);

	const r = run(CHECK, ["--json"]);

	expect(r.status, r.stderr).toBe(0);
	expect(JSON.parse(r.stdout)).toMatchObject({
		overTarget: 15,
		needed: 16,
		over: false,
	});
});

it("warns of nothing at the target, nor with the landing module off", () => {
	writeLogs(540);
	const at = run(CHECK, ["--notify"]);
	writeLogs(5000);
	const off = run(CHECK, ["--notify"], "");

	expect(at.status, at.stderr).toBe(0);
	expect(at.stdout).not.toContain("SLOW-LANDING");
	expect(off.status, off.stderr).toBe(0);
	expect(off.stdout).toBe("");
});

it("reads only the stays begun and ended in the window it is given, counting those over the target, and refuses a time that is none", () => {
	writeLogs(5000);
	const now = Date.now();
	const iso = (t: number) => new Date(t).toISOString();
	// Ref k lands at now - 3600 s + k s; refs 0-15 took 5000 s, the rest 200 s.
	// Every take, to ref 50's land: refs 0-50, and no green run, which ends
	// at now - 810 s, so no target to count against.
	const early = run(CHECK, [
		"--since",
		iso(now - 8700 * S),
		"--until",
		iso(now - 3600 * S + 50.5 * S),
		"--json",
	]);
	// From now - 3794.5 s: the slow refs' takes fall before it, so refs 16-99
	// stay.
	const late = run(CHECK, ["--since", iso(now - 3800 * S + 5.5 * S), "--json"]);
	const zoneless = run(CHECK, ["--since", "2026-11-10T16:13:04"]);
	const future = run(CHECK, ["--since", iso(now + 3600 * S)]);

	expect(early.status, early.stderr).toBe(0);
	const e = JSON.parse(early.stdout);
	expect([e.stays, e.overTarget]).toEqual([51, null]);
	expect(e.summary).toMatch(/unjudged: no green run .* 51 queue ref/);
	expect(JSON.parse(late.stdout)).toMatchObject({ stays: 84, overTarget: 0 });
	expect([zoneless.status, future.status]).toEqual([2, 2]);
	expect(zoneless.stdout + zoneless.stderr).toContain(
		"--since takes an ISO time with its zone",
	);
	expect(future.stdout + future.stderr).toContain("--since must fall before");
});

it("reports the window's batches and queue refs against the target, and refuses a time that is none", () => {
	writeLogs(541);

	const r = run(REPORT, []);
	const bad = run(REPORT, ["--since", "yesterday"]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("batches taken 1: green 1, red path 0");
	expect(r.stdout).toMatch(
		/first take -> land or drop\s+n= 100\s+p50=\s+200\s+p90=\s+541/,
	);
	expect(r.stdout).toContain(
		"target: p90 first take -> land or drop at or under 3 x the green suite's p50 = 540 s",
	);
	expect(bad.status).toBe(2);
});
