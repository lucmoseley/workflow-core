// @vitest-environment node

/*
 * Pins the run-cost report's lines (#1880): which test files it names over the
 * 10 s budget, new against pre-existing, growth past the CI record (#4289,
 * #4579),
 * the summary beside load and memory, its silences, and the program entry an
 * adopter's runner calls.
 *
 * Every case drives an export a real caller uses (#1971): `reportForRun`, as
 * the core's runners call it in-process, or the program entry through
 * runInProcess. Both read one throwaway git repo built once for the file,
 * which no case writes to — each program case's timings file sits in its own
 * temp directory outside it, and the CI record in one more, named by
 * `WFC_SHARD_TIMINGS` as a CI shard names its own. Load and memory come in through `reportForRun`'s
 * `machine` seam, faked per case, so the lines are exact on any machine; the
 * tracker through its `findTicket` seam, or a stub `gh` for the program.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { printed, stubGhRoutes } from "./gh-stub";
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
let record: string;

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
const CI_RUN = "CI run 41 at a21957804bab";

/* `old`, `bare` and `same` at the base, with a CI record holding `old` at 8 s
 * and `same` at 5 s; `old` and `bare` edited and `committed`, `a`, `b` added
 * in a commit since; `fresh` untracked. `same` is a file the run only
 * selected as a reader. */
beforeAll(() => {
	repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-cost-")));
	record = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "run-cost-record-")),
		"timings.csv",
	);
	fs.writeFileSync(
		record,
		"# run: 41\n# sha: a21957804bab1b9a5f2cad86422dda877968fdae\nfile,seconds,tests,status\nold.test.ts,8.00,3,passed\nsame.test.ts,5.00,2,passed\n",
	);
	git("init", "-q", "-b", "main");
	put("old.test.ts");
	put("bare.test.ts");
	put("same.test.ts");
	git("add", ".");
	git("commit", "-qm", "base");
	base = git("rev-parse", "HEAD");
	git("update-ref", "refs/remotes/origin/main", base);
	fs.appendFileSync(path.join(repo, "old.test.ts"), "y\n");
	fs.appendFileSync(path.join(repo, "bare.test.ts"), "y\n");
	put("committed.test.ts");
	put("a.test.ts");
	put("b.test.ts");
	git("add", ".");
	git("commit", "-qm", "since");
	put("fresh.test.ts");
});
afterAll(() => {
	fs.rmSync(repo, { recursive: true, force: true });
	fs.rmSync(path.dirname(record), { recursive: true, force: true });
});

describe("reportForRun", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env))
			if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		vi.stubEnv("CI", "");
		vi.stubEnv("WFC_SHARD_TIMINGS", record);
	});

	type Found =
		| { tickets: { number: number; title: string }[] }
		| { failed: string };
	const None: Found = { tickets: [] };

	/** `reportForRun` on the loaded machine; an absent `unit` means seconds,
	 * and an absent `found` a tracker with no open ticket. */
	const report = (
		timings: Record<string, number>,
		{
			unit = undefined as "seconds" | "worker-seconds" | undefined,
			machine = {} as Partial<typeof LOADED>,
			found = None as Found,
		} = {},
	) =>
		reportForRun(repo, timings, {
			machine: { ...LOADED, ...machine },
			findTicket: () => found,
			...(unit ? { unit } : {}),
		});

	it("names a new or changed file over budget and not one at it, with a summary counting both", () => {
		expect(report({ "a.test.ts": 9.96, "b.test.ts": 10.2 })).toEqual([
			`RUN COST: b.test.ts took 10.2 s, over the 10 s budget — new since ${base}: make it cheaper, or say why in its header (base §X8 (5)).`,
			`RUN COST: 1 of 2 new or changed test file(s) over the 10 s budget, 0 grown past 2.5x their CI record and 0 pre-existing without one, against ${base}; load 1.50 (1 min), 4.0 GB available. A report, never a refusal (mantahostels#2255).`,
		]);
	});

	it("leaves a file at exactly the budget unnamed", () => {
		expect(report({ "a.test.ts": 10 })).toHaveLength(1);
	});

	it("excepts a pre-existing file at exactly 2.5x its CI record, naming its open ticket, and marks a file absent from the base new", () => {
		const lines = report(
			{ "old.test.ts": 20, "a.test.ts": 12 },
			{
				found: {
					tickets: [{ number: 7, title: "Cut old.test.ts" }],
				},
			},
		);
		expect(lines[0]).toBe(
			`RUN COST: old.test.ts took 20.0 s, over the 10 s budget — pre-existing at ${base}, within 2.5x of its 8.0 s on ${CI_RUN}, so base §X8 (5) excepts it; its speed-up's open ticket: #7 (Cut old.test.ts).`,
		);
		expect(lines[1]).toContain("a.test.ts took 12.0 s");
		expect(lines[1]).toContain(`new since ${base}`);
	});

	it("names a pre-existing file past 2.5x its CI record as grown, with both times, and counts it", () => {
		const lines = report({ "old.test.ts": 20.1 });
		expect(lines).toEqual([
			`RUN COST: old.test.ts took 20.1 s, 2.51x its 8.0 s on ${CI_RUN} — grown past the 2.5x noise band: make it cheaper, or say why in its header (base §X8 (5)).`,
			`RUN COST: 1 of 1 new or changed test file(s) over the 10 s budget, 1 grown past 2.5x their CI record and 0 pre-existing without one, against ${base}; load 1.50 (1 min), 4.0 GB available. A report, never a refusal (mantahostels#2255).`,
		]);
	});

	it("never calls a file under the budget grown, however far past its record", () => {
		expect(report({ "old.test.ts": 9.9 })[0]).toContain(
			"0 of 1 new or changed test file(s) over the 10 s budget, 0 grown",
		);
	});

	it("calls a pre-existing file with no record unjudged, never excepted, and says no open ticket's title names it", () => {
		expect(report({ "bare.test.ts": 15 })[0]).toBe(
			`RUN COST: bare.test.ts took 15.0 s, over the 10 s budget — pre-existing at ${base}, unjudged, ${CI_RUN} holding no row for it; its speed-up's open ticket: none: no open issue's title names it.`,
		);
	});

	it("calls a pre-existing file unjudged, saying no record was read, where none can be", () => {
		vi.stubEnv("WFC_SHARD_TIMINGS", path.join(repo, "absent.csv"));
		expect(report({ "old.test.ts": 25 })[0]).toBe(
			`RUN COST: old.test.ts took 25.0 s, over the 10 s budget — pre-existing at ${base}, unjudged, no CI record read; its speed-up's open ticket: none: no open issue's title names it.`,
		);
	});

	it("names every open ticket, and says so where the lookup failed", () => {
		const two = {
			tickets: [
				{ number: 3, title: "Cut old.test.ts" },
				{ number: 9, title: "Split old.test.ts" },
			],
		};
		expect(report({ "old.test.ts": 15 }, { found: two })[0]).toMatch(
			/open ticket: #3 \(Cut old\.test\.ts\), #9 \(Split old\.test\.ts\)\.$/,
		);
		expect(
			report({ "old.test.ts": 15 }, { found: { failed: "gh: offline" } })[0],
		).toMatch(
			/open ticket: unknown: the open-ticket lookup failed \(gh: offline\)\.$/,
		);
	});

	it("prints the summary with zero over budget, so none-over reads apart from no report", () => {
		expect(report({ "a.test.ts": 2 })).toEqual([
			`RUN COST: 0 of 1 new or changed test file(s) over the 10 s budget, 0 grown past 2.5x their CI record and 0 pre-existing without one, against ${base}; load 1.50 (1 min), 4.0 GB available. A report, never a refusal (mantahostels#2255).`,
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

	it("under CI judges every file the record holds, changed or not, printing only the grown ones and never a ticket", () => {
		vi.stubEnv("CI", "true");
		const findTicket = vi.fn(() => None);
		const lines = reportForRun(
			repo,
			{
				"same.test.ts": 12.6,
				"old.test.ts": 15,
				"a.test.ts": 30,
				"b.test.ts": 1,
			},
			{ machine: LOADED, findTicket },
		);
		expect(lines).toEqual([
			`RUN COST: same.test.ts took 12.6 s, 2.52x its 5.0 s on ${CI_RUN} — grown past the 2.5x noise band: make it cheaper, or say why in its header (base §X8 (5)).`,
			`RUN COST: 1 of 2 test file(s) in ${CI_RUN} grown past 2.5x their row, against ${base}; load 1.50 (1 min), 4.0 GB available. A report, never a refusal (mantahostels#2255).`,
		]);
		expect(findTicket).not.toHaveBeenCalled();
	});

	it("under CI prints nothing where the run timed no file the record holds", () => {
		vi.stubEnv("CI", "true");
		expect(report({ "a.test.ts": 30 })).toEqual([]);
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

	/* The tracker answers only the open-issue title search for `old.test.ts`:
	 * one issue naming it, one naming a file whose name only contains it, one
	 * naming neither. Any other query fails, so a broken query reads unknown. */
	const routes = {
		'issue list --state open --search "old.test.ts" in:title --json number,title':
			printed(
				JSON.stringify([
					{ number: 12, title: "Cut old.test.ts" },
					{ number: 13, title: "Cut bold.test.tsx" },
					{ number: 14, title: "Something else" },
				]),
			),
	};

	const run = (
		body: string,
		argv?: string[],
		{ extraEnv = {} as Record<string, string>, ghFailing = false } = {},
	) => {
		const file = path.join(scratch, "timings.json");
		fs.writeFileSync(file, body);
		const stub = stubGhRoutes(scratch, routes, { failing: ghFailing });
		return runInProcess(PROGRAM, argv ?? [file], {
			cwd: repo,
			env: {
				...cleanEnv(),
				...stub.env,
				WFC_SHARD_TIMINGS: record,
				...extraEnv,
			},
		});
	};

	it("names new, committed and untracked files against the merge-base, marks the changed one pre-existing, and skips an unchanged reader", () => {
		const r = run(
			JSON.stringify({
				"old.test.ts": 20,
				"committed.test.ts": 15,
				[path.join(repo, "fresh.test.ts")]: 12,
				"same.test.ts": 99,
			}),
		);
		expect(r.status).toBe(0);
		const lines = r.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain(
			`old.test.ts took 20.0 s, over the 10 s budget — pre-existing at ${base}`,
		);
		expect(lines[0]).toContain("open ticket: #12 (Cut old.test.ts).");
		expect(lines[1]).toContain(
			`committed.test.ts took 15.0 s, over the 10 s budget — new since ${base}`,
		);
		expect(lines[2]).toContain(
			`fresh.test.ts took 12.0 s, over the 10 s budget — new since ${base}`,
		);
		expect(lines[3]).toMatch(
			new RegExp(
				`^RUN COST: 3 of 3 new or changed test file\\(s\\) over the 10 s budget, 0 grown past 2\\.5x their CI record and 0 pre-existing without one, against ${base}; `,
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

	it("prints its fail-open line under CI too, and still exits 0", () => {
		const r = run("{not json", undefined, { extraEnv: { CI: "true" } });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^RUN COST: the report failed/);
	});

	it("says the ticket lookup failed where gh cannot answer, and still exits 0", () => {
		const r = run(JSON.stringify({ "bare.test.ts": 15 }), undefined, {
			ghFailing: true,
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"open ticket: unknown: the open-ticket lookup failed (",
		);
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
