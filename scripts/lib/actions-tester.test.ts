// @vitest-environment node
/*
 * lib/actions-tester.js on canned run listings (#2413).
 *
 * Loosen it and the lander can land a sha whose run it never saw finish
 * green: a missing, unfinished or unreadable run read as a pass.
 *
 * Every case drives the tester through its injected reads and clock, so a
 * 30 min wait bound costs no wall time (§X9); one case crosses the live
 * adapters, `gh` through a WFC_GH stub and git in a temp repo (§X8).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	actionsTester,
	type Job,
	namedRerun,
	queueTester,
	type Run,
} from "./actions-tester.js";
import { stubGhScript } from "./gh-stub.js";
import type { Tester, Verdict } from "./lander.js";
import { markersDir } from "./marker-root.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

let tmp: string | null = null;
const savedGh = process.env.WFC_GH;
afterEach(() => {
	if (savedGh === undefined) delete process.env.WFC_GH;
	else process.env.WFC_GH = savedGh;
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = null;
});

const run = (
	id: number,
	conclusion: string | null,
	{ headSha = SHA, attempt = 1 } = {},
): Run => ({ databaseId: id, headSha, attempt, conclusion });

const shards = (...conclusions: (string | null)[]): Job[] =>
	conclusions.map((conclusion, i) => ({
		name: `Full suite / Vitest (${i + 1}/${conclusions.length})`,
		conclusion,
	}));

const SUITE_PASSED: Job = { name: "Suite passed", conclusion: "success" };

const FAILED_LOG = [
	"Full suite / Vitest (2/6)\tVitest\t2026-10-27T08:30:01.1234567Z \u001b[31m FAIL \u001b[39m scripts/lib/a.test.ts > a > b",
	"Full suite / Vitest (2/6)\tVitest\t2026-10-27T08:30:01.2Z  FAIL  scripts/fixture-only.test.ts > printed by a test",
	"Full suite / Python\tPytest\t2026-10-27T08:30:02.0Z FAILED scripts/test_b.py::test_c - assert 1",
].join("\n");

/** Reads serving each listing in turn, the last one thereafter. */
const reads = (
	listings: (() => Run[])[],
	jobs: Job[] = [...shards("success", "success"), SUITE_PASSED],
	present = ["scripts/lib/a.test.ts", "scripts/test_b.py"],
) => {
	let n = 0;
	const reran: number[] = [];
	return {
		runs: () => {
			const next = listings[Math.min(n, listings.length - 1)];
			n++;
			if (!next) throw new Error("no listing");
			return next();
		},
		mainRuns: (): Run[] => [],
		jobsOf: (_run: number) => jobs,
		failedLogOf: () => FAILED_LOG,
		presentAt: (_: string, files: string[]) =>
			files.filter((f) => present.includes(f)),
		rerun: (id: number) => {
			reran.push(id);
		},
		calls: () => n,
		reran,
	};
};

const clock = () => {
	let t = 0;
	return {
		now: () => t,
		wait: async (ms: number) => {
			t += ms;
		},
	};
};

/** A batch's own test: `files` absent. */
const verdictOf = (
	r: ReturnType<typeof reads>,
	fallback?: Tester,
	files?: string[],
	lands?: boolean,
) =>
	actionsTester({ root: "/", reads: r, fallback, ...clock() }).verdict(
		SHA,
		files,
		lands,
	);

const recording = (verdict: Verdict) => {
	const asked: [string, string[] | undefined][] = [];
	const tester: Tester = {
		verdict: async (sha, files) => {
			asked.push([sha, files]);
			return verdict;
		},
	};
	return { tester, asked };
};

it("retries a run read the network dropped, never reading it as no verdict", async () => {
	const jobs = [{ name: "Full suite / Vitest (1/1)", conclusion: "failure" }];
	const r = reads([() => [run(1, "failure")], () => [run(1, "failure")]], jobs);
	const log = r.failedLogOf;
	let dropped = false;
	r.failedLogOf = () => {
		if (dropped) return log();
		dropped = true;
		throw Object.assign(new Error("gh failed"), {
			stderr:
				"failed to get run log: http2: server sent GOAWAY and closed the connection",
		});
	};
	expect(await verdictOf(r)).toMatchObject({
		kind: "red",
		files: ["scripts/lib/a.test.ts", "scripts/test_b.py"],
	});
});

it("reads a run read that fails on anything but the network as no verdict", async () => {
	const r = reads([() => [run(1, "failure")]]);
	r.failedLogOf = () => {
		throw Object.assign(new Error("gh failed"), {
			stderr: "HTTP 404: Not Found",
		});
	};
	expect(await verdictOf(r)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/runs unreadable: HTTP 404/),
	});
});

it("reads a successful run at the sha as green, naming the run", async () => {
	expect(await verdictOf(reads([() => [run(1, "success")]]))).toEqual({
		kind: "green",
		run: 1,
	});
});

it("reads a failed run as red, naming its failing jobs and the tree's failing files (#2410)", async () => {
	const jobs = [
		{ name: "Full suite / Vitest (2/6)", conclusion: "failure" },
		{ name: "Full suite / Vitest (1/6)", conclusion: "success" },
		{ name: "Full suite / Python", conclusion: "failure" },
	];
	expect(await verdictOf(reads([() => [run(1, "failure")]], jobs))).toEqual({
		kind: "red",
		files: ["scripts/lib/a.test.ts", "scripts/test_b.py"],
		jobs: ["Full suite / Vitest (2/6)", "Full suite / Python"],
		failures: [
			{ file: "scripts/lib/a.test.ts", test: "a > b" },
			{
				file: "scripts/test_b.py",
				test: "test_c",
				message: "assert 1",
				signature: expect.any(String),
			},
		],
	});
});

it("names a failing file from a log whose colour codes gh printed as literal caret text (#3529)", async () => {
	/* Verbatim from run 40759126911's `--log-failed`, shard 8/8. */
	const log =
		"Full suite / Vitest (8/8)\tUNKNOWN STEP\t2026-10-28T20:01:13.4874989Z ^[[41m^[[1m FAIL ^[[22m^[[49m scripts/refill-loop-run.test.ts^[[2m > ^[[22mrun (#2435)^[[2m > ^[[22mends at the tick whose dispatch a stop landed in, recorded explicit";
	const r = {
		...reads(
			[() => [run(1, "failure")]],
			[{ name: "Full suite / Vitest (8/8)", conclusion: "failure" }],
			["scripts/refill-loop-run.test.ts"],
		),
		failedLogOf: () => log,
	};
	expect(await verdictOf(r)).toMatchObject({
		kind: "red",
		files: ["scripts/refill-loop-run.test.ts"],
	});
});

it("judges the newest run at the sha, never another sha's", async () => {
	const runs = [
		run(3, "success", { headSha: OTHER }),
		run(1, "success"),
		run(2, "failure"),
	];
	expect((await verdictOf(reads([() => runs]))).kind).toBe("red");
});

it.each(["cancelled", "timed_out", "startup_failure", "skipped"])(
	"reads a run that ended %s as unknown, never green",
	async (conclusion) => {
		expect((await verdictOf(reads([() => [run(1, conclusion)]]))).kind).toBe(
			"unknown",
		);
	},
);

it.each([
	["shard jobs are skipped", [...shards("success", "skipped"), SUITE_PASSED]],
	[
		"shard jobs are missing",
		[...shards("success", "success").slice(0, 1), SUITE_PASSED],
	],
	[
		"shard jobs are absent altogether",
		[{ name: "Lint and types", conclusion: "success" }, SUITE_PASSED],
	],
	[
		"Suite passed job is skipped (#3329)",
		[...shards("success"), { name: "Suite passed", conclusion: "skipped" }],
	],
	["Suite passed job is missing (#3329)", shards("success", "success")],
])(
	"reads a successful run whose %s as unknown, never green",
	async (_, jobs) => {
		const v = await verdictOf(reads([() => [run(1, "success")]], jobs));
		expect(v).toMatchObject({ kind: "unknown" });
	},
);

it("waits out an unfinished run and returns its verdict", async () => {
	const r = reads([() => [], () => [run(1, null)], () => [run(1, "success")]]);
	expect(await verdictOf(r)).toEqual({ kind: "green", run: 1 });
	expect(r.calls()).toBe(3);
});

it("reads a run still in progress at the bound as unknown", async () => {
	const v = await verdictOf(reads([() => [run(4, null)]]));
	expect(v).toMatchObject({ kind: "unknown" });
	expect(v.kind === "unknown" && v.reason).toMatch(/run 4 unfinished/);
});

it("reads an unreadable listing as unknown, never green", async () => {
	const v = await verdictOf(
		reads([
			() => {
				throw new Error("HTTP 403: Resource not accessible");
			},
		]),
	);
	expect(v).toMatchObject({ kind: "unknown" });
	expect(v.kind === "unknown" && v.reason).toMatch(/403/);
});

it("reads a batch whose run is never listed as unknown, never handing it to the fallback", async () => {
	const { tester, asked } = recording({ kind: "green" });
	const v = await verdictOf(
		reads([() => [run(1, "success", { headSha: OTHER })]]),
		tester,
	);
	expect(v).toMatchObject({ kind: "unknown" });
	expect(v.kind === "unknown" && v.reason).toMatch(/no scheduled-checks/);
	expect(asked).toEqual([]);
});

it("hands a whole-suite rerun at a sha no push ran to the fallback", async () => {
	const { tester, asked } = recording({ kind: "green" });
	expect(await verdictOf(reads([() => []]), tester, [])).toEqual({
		kind: "green",
	});
	expect(asked).toEqual([[SHA, []]]);
});

it("reruns a failed run's failed jobs for a whole-suite rerun, judging only the new attempt", async () => {
	const failed = run(5, "failure");
	const r = reads([
		() => [failed],
		() => [failed],
		() => [run(5, null, { attempt: 2 })],
		() => [run(5, "success", { attempt: 2 })],
	]);
	expect(await verdictOf(r, undefined, [])).toEqual({ kind: "green", run: 5 });
	expect(r.reran).toEqual([5]);
});

it("reads a passed run again for a whole-suite rerun, starting no attempt", async () => {
	const r = reads([() => [run(6, "success")]]);
	expect(await verdictOf(r, undefined, [])).toEqual({ kind: "green", run: 6 });
	expect(r.reran).toEqual([]);
});

it("reruns a failed run's failed jobs for a rerun of named files that lands, never the fallback, so a passing flake rerun names its run (#3329)", async () => {
	const { tester, asked } = recording({ kind: "green" });
	const failed = run(5, "failure");
	const r = reads([() => [failed], () => [run(5, "success", { attempt: 2 })]]);
	expect(await verdictOf(r, tester, ["x.test.ts"], true)).toEqual({
		kind: "green",
		run: 5,
	});
	expect(r.reran).toEqual([5]);
	expect(asked).toEqual([]);
});

it("declares that main takes only a sha a run passed (#3329)", () => {
	expect(
		actionsTester({ root: "/", reads: reads([() => []]) }).requiresRun,
	).toBe(true);
});

it("hands a rerun of named files that lands nothing to the fallback without reading a run, as its failed jobs judge more than those files", async () => {
	const { tester, asked } = recording({ kind: "green" });
	const r = reads([() => [run(5, "failure")]]);
	expect(await verdictOf(r, tester, ["x.test.ts"])).toEqual({ kind: "green" });
	expect(asked).toEqual([[SHA, ["x.test.ts"]]]);
	expect(r.calls()).toBe(0);
});

it("hands a rerun of named files that lands, at a sha whose run passed, to the fallback", async () => {
	const { tester, asked } = recording({ kind: "red", files: ["x.test.ts"] });
	const r = reads([() => [run(1, "success")]]);
	const v = await actionsTester({
		root: "/",
		fallback: tester,
		reads: r,
		...clock(),
	}).verdict(SHA, ["x.test.ts"], true);
	expect(v).toEqual({ kind: "red", files: ["x.test.ts"] });
	expect(asked).toEqual([[SHA, ["x.test.ts"]]]);
	expect(r.reran).toEqual([]);
});

/* A shard whose runner failed to ready: a download outage at a tool install,
 * its Vitest step run on regardless, on a runner missing the tool. */
const unreadied = (step: string, vitest = "success"): Job[] => [
	{
		name: "Full suite / Vitest (1/2)",
		conclusion: "failure",
		steps: [
			{ name: step, conclusion: "failure" },
			{ name: "Vitest", conclusion: vitest },
		],
	},
	{ name: "Full suite / Vitest (2/2)", conclusion: "success" },
	{ name: "Suite passed", conclusion: "failure" },
];

it("reruns a run whose runner failed to ready, judging the new attempt and never the tests it ran", async () => {
	const r = {
		...reads([
			() => [run(5, "failure")],
			() => [run(5, "success", { attempt: 2 })],
		]),
	};
	let attempt = 0;
	r.jobsOf = () =>
		attempt++ === 0
			? unreadied("Install test tools", "failure")
			: [...shards("success", "success"), SUITE_PASSED];
	expect(await verdictOf(r)).toEqual({ kind: "green", run: 5 });
	expect(r.reran).toEqual([5]);
});

it("is no verdict where the runner fails to ready on every attempt, naming the step", async () => {
	const r = reads(
		[
			() => [run(5, "failure")],
			() => [run(5, "failure", { attempt: 2 })],
			() => [run(5, "failure", { attempt: 3 })],
		],
		unreadied("Install test tools"),
	);
	expect(await verdictOf(r)).toEqual({
		kind: "unknown",
		reason:
			"run 5's Full suite / Vitest (1/2) job failed at its 'Install test tools' step, which judges no code, on 3 attempts",
	});
	expect(r.reran).toEqual([5, 5]);
});

it("reads a failed dependency install as red, a broken lockfile being the code's", async () => {
	const r = reads(
		[() => [run(5, "failure")]],
		unreadied("Install dependencies"),
	);
	expect(await verdictOf(r)).toMatchObject({ kind: "red" });
	expect(r.reran).toEqual([]);
});

const LINT = "Full suite / Lint and types";
const DOCS = "Full suite / Document guards";

/** Reads whose `main` runs are `runs`, the jobs of run n being `jobsByRun[n]`. */
const mainReads = (runs: Run[], jobsByRun: Record<number, Job[]>) => ({
	...reads([() => []]),
	mainRuns: () => runs,
	jobsOf: (id: number) => jobsByRun[id] ?? [],
});

const readJobsOnMain = (r: ReturnType<typeof reads>, jobs: string[]) =>
	actionsTester({ root: "/", reads: r, ...clock() }).readJobsOnMain?.(jobs);

it("reads a job red in main's newest finished run as red there (#3526)", async () => {
	const swept = "7".repeat(40);
	const r = mainReads(
		[run(1, "success"), run(2, "failure", { headSha: swept }), run(3, null)],
		{
			1: [{ name: LINT, conclusion: "success" }],
			2: [{ name: LINT, conclusion: "failure" }],
			3: [{ name: LINT, conclusion: "success" }],
		},
	);
	expect(await readJobsOnMain(r, [LINT])).toEqual({
		kind: "read",
		red: [LINT],
		notRed: [],
		shas: [swept],
	});
});

it("reads a job green in main's newest finished run as not red there", async () => {
	const r = mainReads([run(1, "failure"), run(2, "success")], {
		1: [{ name: LINT, conclusion: "failure" }],
		2: [{ name: LINT, conclusion: "success" }],
	});
	expect(await readJobsOnMain(r, [LINT])).toEqual({
		kind: "read",
		red: [],
		notRed: [LINT],
		shas: [],
	});
});

it("takes each job from the newest run that passed or failed it", async () => {
	const r = mainReads([run(1, "failure"), run(2, "cancelled")], {
		1: [{ name: DOCS, conclusion: "failure" }],
		2: [
			{ name: LINT, conclusion: "success" },
			{ name: DOCS, conclusion: "skipped" },
		],
	});
	expect(await readJobsOnMain(r, [LINT, DOCS])).toEqual({
		kind: "read",
		red: [DOCS],
		notRed: [LINT],
		shas: [SHA],
	});
});

it("reads a job no run on main settled as unread", async () => {
	const r = mainReads([run(1, "success")], { 1: [] });
	expect(await readJobsOnMain(r, [LINT])).toEqual({
		kind: "unread",
		reason: `no finished scheduled-checks.yml run on main passed or failed '${LINT}'`,
	});
});

it("reads an unreadable main listing as unread", async () => {
	const r = {
		...mainReads([], {}),
		mainRuns: (): Run[] => {
			throw new Error("HTTP 403");
		},
	};
	const v = await readJobsOnMain(r, [LINT]);
	expect(v).toMatchObject({
		kind: "unread",
		reason: expect.stringContaining("runs unreadable: HTTP 403"),
	});
});

it("never reads Suite passed on main, which fails with any job there", async () => {
	const r = mainReads([run(1, "failure")], {
		1: [
			{ name: LINT, conclusion: "success" },
			{ name: DOCS, conclusion: "failure" },
			{ name: "Suite passed", conclusion: "failure" },
		],
	});
	expect(await readJobsOnMain(r, [LINT, "Suite passed"])).toEqual({
		kind: "read",
		red: [],
		notRed: [LINT],
		shas: [],
	});
});

it("reads a job's state on main through gh", async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actions-tester-"));
	const answers = {
		list: JSON.stringify([run(9, "failure")]),
		jobs: JSON.stringify({ jobs: [{ name: LINT, conclusion: "failure" }] }),
	};
	process.env.WFC_GH = stubGhScript(
		tmp,
		`#!/usr/bin/env node
const a = ${JSON.stringify(answers)};
const argv = process.argv.slice(2);
if (argv[1] === "list" && argv[argv.indexOf("--branch") + 1] !== "main") process.exit(1);
process.stdout.write(argv[1] === "list" ? a.list : a.jobs);
`,
	).gh;
	expect(
		await actionsTester({ root: tmp, ...clock() }).readJobsOnMain?.([LINT]),
	).toEqual({ kind: "read", red: [LINT], notRed: [], shas: [SHA] });
});

it("reads a failed run through gh and the tree through git", async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actions-tester-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: tmp as string, encoding: "utf8" }).trim();
	git("init", "-q");
	fs.mkdirSync(path.join(tmp, "scripts", "lib"), { recursive: true });
	fs.writeFileSync(path.join(tmp, "scripts", "lib", "a.test.ts"), "");
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
	const sha = git("rev-parse", "HEAD");
	const answers = {
		list: JSON.stringify([run(7, "failure", { headSha: sha })]),
		jobs: JSON.stringify({
			jobs: [{ name: "Full suite / Vitest (2/6)", conclusion: "failure" }],
		}),
		log: FAILED_LOG,
	};
	process.env.WFC_GH = stubGhScript(
		tmp,
		`#!/usr/bin/env node
const a = ${JSON.stringify(answers)};
const argv = process.argv.slice(2);
process.stdout.write(argv[1] === "list" ? a.list : argv.includes("--log-failed") ? a.log : a.jobs);
`,
	).gh;
	const v = await actionsTester({ root: tmp, ...clock() }).verdict(sha);
	expect(v).toEqual({
		kind: "red",
		files: ["scripts/lib/a.test.ts"],
		jobs: ["Full suite / Vitest (2/6)"],
		failures: [{ file: "scripts/lib/a.test.ts", test: "a > b" }],
	});
});

const fakeNamedReads = (
	outcome: { conclusion: string | null } | "unlisted",
	{
		jobs = [{ name: "Named files", conclusion: "success" }] as Job[],
		log = FAILED_LOG,
		dispatch = () => undefined,
	}: { jobs?: Job[]; log?: string; dispatch?: () => void } = {},
) => {
	const dispatched: { sha: string; files: string[]; nonce: string }[] = [];
	const decoy = {
		databaseId: 1,
		displayTitle: `named-rerun ${SHA} another-dispatch`,
		conclusion: "failure",
	};
	return {
		dispatched,
		reads: {
			dispatch: (d: { sha: string; files: string[]; nonce: string }) => {
				dispatch();
				dispatched.push(d);
			},
			namedRuns: () =>
				outcome === "unlisted"
					? [decoy]
					: [
							decoy,
							{
								databaseId: 7,
								displayTitle: `named-rerun ${SHA} ${dispatched[0]?.nonce}`,
								conclusion: outcome.conclusion,
							},
						],
			jobsOf: () => jobs,
			failedLogOf: () => log,
			presentAt: (_: string, files: string[]) =>
				files.filter((f) => f !== "scripts/fixture-only.test.ts"),
		},
	};
};

const namedRoot = () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "named-rerun-"));
	return tmp;
};

const askNamed = (r: ReturnType<typeof fakeNamedReads>, root = namedRoot()) =>
	namedRerun({ root, reads: r.reads, ...clock() })(
		SHA,
		["scripts/lib/a.test.ts"],
		"no suite slot by the ceiling",
	);

it("dispatches the named files at the sha and reads its own run's green, naming no run so it can land nothing (#3764)", async () => {
	const r = fakeNamedReads({ conclusion: "success" });
	expect(await askNamed(r)).toEqual({ kind: "green" });
	expect(r.dispatched).toEqual([
		{
			sha: SHA,
			files: ["scripts/lib/a.test.ts"],
			nonce: expect.any(String),
		},
	]);
});

it("reads a failed named run as red on the tree's failing files, and one naming none as no verdict (#3764)", async () => {
	expect(await askNamed(fakeNamedReads({ conclusion: "failure" }))).toEqual({
		kind: "red",
		files: ["scripts/lib/a.test.ts", "scripts/test_b.py"],
		failures: [
			{ file: "scripts/lib/a.test.ts", test: "a > b" },
			{
				file: "scripts/test_b.py",
				test: "test_c",
				message: "assert 1",
				signature: expect.any(String),
			},
		],
	});
	expect(
		await askNamed(
			fakeNamedReads({ conclusion: "failure" }, { log: "npm ci failed" }),
		),
	).toEqual({
		kind: "unknown",
		reason:
			"no suite slot by the ceiling; off the machine, run 7 failed naming no failing file in the tree",
	});
});

it.each([
	[
		"a job its `if:` skipped",
		fakeNamedReads(
			{ conclusion: "success" },
			{ jobs: [{ name: "Named files", conclusion: "skipped" }] },
		),
		/run 7 passed, but its Named files job is skipped/,
	],
	[
		"a cancelled run",
		fakeNamedReads({ conclusion: "cancelled" }),
		/run 7 ended cancelled/,
	],
	[
		"a run never finished",
		fakeNamedReads({ conclusion: null }),
		/run 7 unfinished/,
	],
	[
		"only another dispatch's run",
		fakeNamedReads("unlisted"),
		/listed no run titled/,
	],
	[
		"a refused dispatch",
		fakeNamedReads(
			{ conclusion: "success" },
			{
				dispatch: () => {
					throw new Error("HTTP 404: workflow not found");
				},
			},
		),
		/named-rerun\.yml did not dispatch: HTTP 404/,
	],
])(
	"reads %s as no verdict, keeping the slot's refusal (#3764)",
	async (_, r, why) => {
		const v = await askNamed(r);
		expect(v).toMatchObject({
			kind: "unknown",
			reason: expect.stringMatching(why),
		});
		expect(v).toMatchObject({
			reason: expect.stringMatching(/^no suite slot by the ceiling; /),
		});
	},
);

it("stops dispatching at the cap for a UTC day, and a new day has its own (#3764)", async () => {
	const root = namedRoot();
	const r = fakeNamedReads({ conclusion: "success" });
	const DayOne = Date.parse("2026-11-01T23:00:00Z");
	const ask = (nowMs: number) =>
		namedRerun({
			root,
			reads: r.reads,
			wait: async () => undefined,
			now: () => nowMs,
		})(SHA, ["scripts/lib/a.test.ts"], "shut");
	for (let i = 0; i < 12; i++) {
		r.dispatched.length = 0;
		expect(await ask(DayOne)).toEqual({ kind: "green" });
	}
	r.dispatched.length = 0;
	expect(await ask(DayOne)).toEqual({
		kind: "unknown",
		reason: "shut; off the machine, named-rerun.yml's 12-a-day cap is spent",
	});
	expect(r.dispatched).toEqual([]);
	expect(await ask(DayOne + 2 * 60 * 60 * 1000)).toEqual({ kind: "green" });
	expect(r.dispatched).toHaveLength(1);
});

it("finds its run by the title named-rerun.yml gives it, and reads the job it names (#3764)", () => {
	const workflow = fs.readFileSync(
		path.join(import.meta.dirname, "../../.github/workflows/named-rerun.yml"),
		"utf8",
	);
	expect(workflow).toContain(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's own expression, quoted
		"run-name: named-rerun ${{ inputs.sha }} ${{ inputs.nonce }}\n",
	);
	expect(workflow).toContain("    name: Named files\n");
});

/* The queue lander's tester (#4458): whole runs read on `lander/batch`,
 * named files dispatched to named-rerun.yml. */
const NAMED_OK: Job = { name: "Named files", conclusion: "success" };
const ISO = "c".repeat(40);

const queueReads = (
	listings: (() => Run[])[],
	{
		iso = (): string[] => [],
		named = "success" as string | null,
		listed = true,
	} = {},
) => {
	const r = reads(listings, [
		...shards("success", "success"),
		SUITE_PASSED,
		NAMED_OK,
	]);
	const dispatched: { sha: string; files: string[]; nonce: string }[] = [];
	return {
		...r,
		dispatched,
		isoShas: iso,
		dispatch: (d: { sha: string; files: string[]; nonce: string }) => {
			dispatched.push(d);
		},
		namedRuns: () =>
			listed
				? dispatched.map((d, i) => ({
						databaseId: 100 + i,
						displayTitle: `named-rerun ${d.sha} ${d.nonce}`,
						conclusion: named,
					}))
				: [],
	};
};

/* From the wall clock: the dispatch record keeps rows by their age then. */
const wallClock = () => {
	let t = Date.now();
	return {
		now: () => t,
		wait: async (ms: number) => {
			t += ms;
		},
	};
};

const queueOf = (r: ReturnType<typeof queueReads>, root = namedRoot()) =>
	queueTester({ root, reads: r, ...wallClock() });

it("reads the whole suite at a sha off its push run on lander/batch, a file list empty or absent (#4458)", async () => {
	const r = queueReads([() => [run(1, "success")]]);
	const tester = queueOf(r);
	expect(await tester.verdict(SHA)).toEqual({ kind: "green", run: 1 });
	expect(await tester.verdict(SHA, [])).toEqual({ kind: "green", run: 1 });
	expect(tester.requiresRun).toBe(true);
	expect(r.dispatched).toEqual([]);
});

it("reads a batch run missing on lander/batch, or a listing it cannot read, as unknown (#4458)", async () => {
	expect(await queueOf(queueReads([() => []])).verdict(SHA)).toEqual({
		kind: "unknown",
		reason: `no scheduled-checks.yml push run on lander/batch at ${SHA.slice(0, 9)}`,
	});
	expect(await queueOf(queueReads([])).verdict(SHA)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/runs unreadable: no listing/),
	});
});

it("reruns a batch run whose runner failed to ready, never reading it red (#4458)", async () => {
	const r = queueReads([
		() => [run(5, "failure")],
		() => [run(5, "success", { attempt: 2 })],
	]);
	let attempt = 0;
	r.jobsOf = () =>
		attempt++ === 0
			? unreadied("Install test tools", "failure")
			: [...shards("success", "success"), SUITE_PASSED];
	expect(await queueOf(r).verdict(SHA)).toEqual({ kind: "green", run: 5 });
	expect(r.reran).toEqual([5]);
});

it("reruns a failed batch run's failed jobs for named files at its sha, so a green names the run main takes (#3329, #4458)", async () => {
	const r = queueReads([
		() => [run(1, "failure")],
		() => [run(1, "success", { attempt: 2 })],
	]);
	expect(await queueOf(r).verdict(SHA, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "green",
		run: 1,
	});
	expect(r.reran).toEqual([1]);
	expect(r.dispatched).toEqual([]);
});

it("dispatches named files at an isolation sha to named-rerun.yml, red naming the tree's failing files (#4458)", async () => {
	const r = queueReads([() => []], { iso: () => [ISO], named: "failure" });
	expect(await queueOf(r).verdict(ISO, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "red",
		files: ["scripts/lib/a.test.ts", "scripts/test_b.py"],
		failures: [
			{ file: "scripts/lib/a.test.ts", test: "a > b" },
			{
				file: "scripts/test_b.py",
				test: "test_c",
				message: "assert 1",
				signature: expect.any(String),
			},
		],
	});
	expect(r.dispatched).toEqual([
		{ sha: ISO, files: ["scripts/lib/a.test.ts"], nonce: expect.any(String) },
	]);
	expect(r.reran).toEqual([]);
});

it("exempts isolation dispatches from the daily cap, and counts a dispatch at main against it (#4458)", async () => {
	const r = queueReads([() => []], { iso: () => [ISO] });
	const tester = queueOf(r);
	const files = ["scripts/lib/a.test.ts"];
	for (let i = 0; i < 3; i++)
		expect(await tester.verdict(ISO, files)).toEqual({ kind: "green" });
	for (let i = 0; i < 12; i++)
		expect(await tester.verdict(OTHER, files)).toEqual({ kind: "green" });
	expect(await tester.verdict(OTHER, files)).toEqual({
		kind: "unknown",
		reason: "named-rerun.yml's 12-a-day cap is spent",
	});
	expect(await tester.verdict(ISO, files)).toEqual({ kind: "green" });
	expect(r.dispatched.filter((d) => d.sha === ISO)).toHaveLength(4);
	expect(r.dispatched.filter((d) => d.sha === OTHER)).toHaveLength(12);
});

it("reads a named run never listed as unknown, and counts a dispatch whose isolation refs it cannot read (#4458)", async () => {
	expect(
		await queueOf(
			queueReads([() => []], { iso: () => [ISO], listed: false }),
		).verdict(ISO, ["scripts/lib/a.test.ts"]),
	).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/^named-rerun\.yml listed no run titled /),
	});
	const r = queueReads([() => []], {
		iso: () => {
			throw new Error("ls-remote failed");
		},
	});
	const tester = queueOf(r);
	for (let i = 0; i < 12; i++)
		await tester.verdict(ISO, ["scripts/lib/a.test.ts"]);
	expect(await tester.verdict(ISO, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "unknown",
		reason: "named-rerun.yml's 12-a-day cap is spent",
	});
});

it("waits on an unfinished batch run for named files at its sha, and reads one ended any other way as unknown, dispatching neither (#4458)", async () => {
	const files = ["scripts/lib/a.test.ts"];
	const r = queueReads([() => [run(1, null)], () => [run(1, "success")]]);
	expect(await queueOf(r).verdict(SHA, files)).toEqual({
		kind: "green",
		run: 1,
	});
	const cancelled = queueReads([() => [run(2, "cancelled")]]);
	expect(await queueOf(cancelled).verdict(SHA, files)).toMatchObject({
		kind: "unknown",
	});
	expect([...r.dispatched, ...cancelled.dispatched]).toEqual([]);
	expect([...r.reran, ...cancelled.reran]).toEqual([]);
});

it("reads a named-run listing or a rerun it cannot make as unknown (#4458)", async () => {
	const files = ["scripts/lib/a.test.ts"];
	const r = queueReads([() => []], { iso: () => [ISO] });
	r.namedRuns = () => {
		throw new Error("HTTP 502");
	};
	expect(await queueOf(r).verdict(ISO, files)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(
			/^named-rerun\.yml runs unreadable: .*HTTP 502/,
		),
	});
	const failed = queueReads([() => [run(1, "failure")]]);
	failed.rerun = () => {
		throw new Error("HTTP 403");
	};
	expect(await queueOf(failed).verdict(SHA, files)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/HTTP 403/),
	});
	expect(failed.dispatched).toEqual([]);
});

it("fires the suite workflow on a push to lander/batch as well as landing (#4458)", () => {
	const workflow = fs.readFileSync(
		path.join(
			import.meta.dirname,
			"../../.github/workflows/scheduled-checks.yml",
		),
		"utf8",
	);
	expect(workflow).toContain(
		"  push:\n    branches: [landing, lander/batch]\n",
	);
});

it("reads lander/batch runs through gh and the isolation refs through git ls-remote (#4458)", async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-tester-"));
	const remote = path.join(tmp, "remote.git");
	const work = path.join(tmp, "work");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git(tmp, "init", "-q", "--bare", remote);
	git(tmp, "clone", "-q", remote, work);
	git(
		work,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"a",
	);
	const iso = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/lander/iso-1");
	const nonceFile = path.join(tmp, "nonce");
	const answers = {
		list: [run(3, "success")],
		jobs: { jobs: [...shards("success"), SUITE_PASSED, NAMED_OK] },
	};
	process.env.WFC_GH = stubGhScript(
		tmp,
		`#!/usr/bin/env node
const fs = require("node:fs");
const a = ${JSON.stringify(answers)};
const argv = process.argv.slice(2);
const out = (v) => process.stdout.write(JSON.stringify(v));
if (argv[0] === "workflow") {
	fs.writeFileSync(${JSON.stringify(nonceFile)}, argv.find((x) => x.startsWith("nonce=")).slice(6));
} else if (argv[1] === "list" && argv.includes("named-rerun.yml")) {
	out([{ databaseId: 8, conclusion: "success",
		displayTitle: "named-rerun ${iso} " + fs.readFileSync(${JSON.stringify(nonceFile)}, "utf8") }]);
} else if (argv[1] === "list") {
	if (argv[argv.indexOf("--branch") + 1] !== "lander/batch") process.exit(1);
	out(a.list);
} else out(a.jobs);
`,
	).gh;
	const record = path.join(markersDir(work), ".lander-named-runs.jsonl");
	fs.writeFileSync(
		record,
		`${JSON.stringify({ at: new Date().toISOString() })}\n`.repeat(12),
	);
	const tester = queueTester({ root: work, ...wallClock() });
	expect(await tester.verdict(SHA)).toEqual({ kind: "green", run: 3 });
	expect(await tester.verdict(iso, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "green",
	});
	expect(await tester.verdict(SHA, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "green",
		run: 3,
	});
	expect(await tester.verdict(OTHER, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "unknown",
		reason: "named-rerun.yml's 12-a-day cap is spent",
	});
});
