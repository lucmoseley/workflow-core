// @vitest-environment node

/*
 * Pins the run-cost report's lines (#1880): which test files it names over the
 * 10 s budget, new against pre-existing, the summary beside load and memory,
 * its silences, and the program entry an adopter's runner calls.
 *
 * Every case drives an export a real caller uses (#1971): `reportForRun`, as
 * the core's runners call it in-process, or the program entry through
 * runInProcess. Both read one throwaway git repo built once for the file,
 * which no case writes to — each program case's timings file sits in its own
 * temp directory outside it. Load and memory come in through `reportForRun`'s
 * `machine` seam, faked per case, so the lines are exact on any machine.
 *
 * Loosen a case and a slow new test file goes unnamed in every repo that prints
 * this report, or a broken report costs a suite its green.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { reportForRun } from "./run-cost-report.js";
import { runInProcess } from "./run-in-process.js";

const PROGRAM = path.join(__dirname, "run-cost-report.js");
const GB = 1024 ** 3;
const LOADED = {
	platform: "linux",
	loadavg: () => [1.5, 1, 1],
	freemem: () => 4 * GB,
};

let repo: string;
let base: string;

/* No GIT_* from a hook running this suite, and no session root: the program
 * must find the repo from its cwd as an adopter's runner leaves it. */
const cleanEnv = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) =>
				!k.startsWith("GIT_") && k !== "CI" && k !== "CLAUDE_PROJECT_DIR",
		),
	);
const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd: repo,
		encoding: "utf8",
		env: cleanEnv(),
	}).trim();
const put = (rel: string) => fs.writeFileSync(path.join(repo, rel), "x\n");

/* `old` and `same` at the base; `old` edited and `committed`, `a`, `b` added
 * in a commit since; `fresh` untracked. `same` is a file the run only
 * selected as a reader. */
beforeAll(() => {
	repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-cost-")));
	git("init", "-q", "-b", "main");
	put("old.test.ts");
	put("same.test.ts");
	git("add", ".");
	git("commit", "-qm", "base");
	base = git("rev-parse", "HEAD");
	git("update-ref", "refs/remotes/origin/main", base);
	fs.appendFileSync(path.join(repo, "old.test.ts"), "y\n");
	put("committed.test.ts");
	put("a.test.ts");
	put("b.test.ts");
	git("add", ".");
	git("commit", "-qm", "since");
	put("fresh.test.ts");
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("reportForRun", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env))
			if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		vi.stubEnv("CI", "");
	});
	afterEach(() => vi.unstubAllEnvs());

	/** `reportForRun` on the loaded machine; an absent `unit` means seconds. */
	const report = (
		timings: Record<string, number>,
		{
			unit = undefined as "seconds" | "worker-seconds" | undefined,
			machine = {} as Partial<typeof LOADED>,
		} = {},
	) =>
		reportForRun(repo, timings, {
			machine: { ...LOADED, ...machine },
			...(unit ? { unit } : {}),
		});

	it("names a new or changed file over budget and not one at it, with a summary counting both", () => {
		expect(report({ "a.test.ts": 9.96, "b.test.ts": 10.2 })).toEqual([
			`RUN COST: b.test.ts took 10.2 s, over the 10 s budget — new since ${base}: make it cheaper, or say why in its header (base §X8 (5)).`,
			`RUN COST: 1 of 2 new or changed test file(s) over the 10 s budget against ${base}; load 1.50 (1 min), 4.0 GB available. A report, never a refusal (mantahostels#2255).`,
		]);
	});

	it("leaves a file at exactly the budget unnamed", () => {
		expect(report({ "a.test.ts": 10 })).toHaveLength(1);
	});

	it("marks a file present at the base pre-existing, and a file absent from it new", () => {
		const lines = report({ "old.test.ts": 20, "a.test.ts": 12 });
		expect(lines[0]).toBe(
			`RUN COST: old.test.ts took 20.0 s, over the 10 s budget — pre-existing at ${base}, so base §X8 (5) excepts it and its speed-up is its own ticket.`,
		);
		expect(lines[1]).toContain("a.test.ts took 12.0 s");
		expect(lines[1]).toContain(`new since ${base}`);
	});

	it("prints the summary with zero over budget, so none-over reads apart from no report", () => {
		expect(report({ "a.test.ts": 2 })).toEqual([
			`RUN COST: 0 of 1 new or changed test file(s) over the 10 s budget against ${base}; load 1.50 (1 min), 4.0 GB available. A report, never a refusal (mantahostels#2255).`,
		]);
	});

	it("prints nothing where the run timed no new or changed file, however slow a reader of the diff was", () => {
		expect(report({ "same.test.ts": 60 })).toEqual([]);
	});

	it("labels a pytest figure worker-seconds", () => {
		expect(
			report({ "a.test.ts": 11 }, { unit: "worker-seconds" })[0],
		).toContain("a.test.ts took 11.0 worker-seconds, over the 10 s budget");
	});

	it("says load and memory are unknown where the platform gives neither", () => {
		const unknown = "load unknown (1 min), available memory unknown.";
		expect(
			report(
				{ "a.test.ts": 1 },
				{
					machine: {
						platform: "win32",
						loadavg: () => [0, 0, 0],
						freemem: () => Number.NaN,
					},
				},
			)[0],
		).toContain(unknown);
		expect(
			report(
				{ "a.test.ts": 1 },
				{ machine: { loadavg: () => [], freemem: () => 0 } },
			)[0],
		).toContain(unknown);
	});

	it("prints nothing when CI is set (#1797), and does on the same input without it", () => {
		const timings = { "a.test.ts": 30 };
		expect(report(timings)).toHaveLength(2);
		vi.stubEnv("CI", "true");
		expect(report(timings)).toEqual([]);
	});

	it("turns a failure inside into one fail-open line rather than a throw", () => {
		const freemem = () => {
			throw new Error("no meminfo");
		};
		expect(report({ "a.test.ts": 1 }, { machine: { freemem } })).toEqual([
			"RUN COST: the report failed and printed nothing else; the suite's verdict stands (#1880): no meminfo",
		]);
	});
});

describe("the program entry", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "run-cost-timings-"));
		return () => fs.rmSync(scratch, { recursive: true, force: true });
	});

	const run = (
		body: string,
		argv?: string[],
		extraEnv: Record<string, string> = {},
	) => {
		const file = path.join(scratch, "timings.json");
		fs.writeFileSync(file, body);
		return runInProcess(PROGRAM, argv ?? [file], {
			cwd: repo,
			env: { ...cleanEnv(), ...extraEnv },
		});
	};

	it("names new, committed and untracked files against the merge-base, marks the changed one pre-existing, and skips an unchanged reader", () => {
		const r = run(
			JSON.stringify({
				"old.test.ts": 21,
				"committed.test.ts": 15,
				[path.join(repo, "fresh.test.ts")]: 12,
				"same.test.ts": 99,
			}),
		);
		expect(r.status).toBe(0);
		const lines = r.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain(
			`old.test.ts took 21.0 s, over the 10 s budget — pre-existing at ${base}`,
		);
		expect(lines[1]).toContain(
			`committed.test.ts took 15.0 s, over the 10 s budget — new since ${base}`,
		);
		expect(lines[2]).toContain(
			`fresh.test.ts took 12.0 s, over the 10 s budget — new since ${base}`,
		);
		expect(lines[3]).toMatch(
			new RegExp(
				`^RUN COST: 3 of 3 new or changed test file\\(s\\) over the 10 s budget against ${base}; `,
			),
		);
		expect(r.stdout).not.toContain("same.test.ts");
	});

	it("fails open on malformed JSON with one line and exit 0", () => {
		const r = run("{not json");
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/^RUN COST: the report failed and printed nothing else; the suite's verdict stands \(#1880\): the timings are not JSON/,
		);
		expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
	});

	it("prints nothing under CI, malformed input included, and still exits 0", () => {
		const r = run("{not json", undefined, { CI: "true" });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("fails open on a figure that is not a number, naming the file", () => {
		const r = run(JSON.stringify({ "old.test.ts": "slow" }));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("old.test.ts's seconds are not a number");
	});

	it("fails open with its usage on a missing argument, still exiting 0", () => {
		const r = run("{}", []);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"usage: node scripts/lib/run-cost-report.js <timings.json>",
		);
	});
});
