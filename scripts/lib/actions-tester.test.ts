// @vitest-environment node
/*
 * lib/actions-tester.js on canned run listings (#2413).
 *
 * Loosen it and the queue lander can land a sha whose run it never saw
 * finish green: a missing, unfinished or unreadable run read as a pass.
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
import { type Job, queueTester, type Run } from "./actions-tester.js";
import { stubGhScript } from "./gh-stub.js";
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

/** A clock from `start` ms, which only its `wait` moves. */
const clock = (start = 0) => {
	let t = start;
	return {
		now: () => t,
		wait: async (ms: number) => {
			t += ms;
		},
	};
};

/** The whole suite at SHA, read off its push run on `lander/batch`. */
const verdictOf = (r: ReturnType<typeof reads>) =>
	queueTester({
		root: "/",
		reads: {
			...r,
			isoRefs: () => [],
			runsOn: () => [],
			namedRuns: () => [],
			dispatch: () => undefined,
		},
		...clock(),
	}).verdict(SHA);

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

it("reads a failed run through gh and the tree through git", async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actions-tester-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: tmp as string, encoding: "utf8" }).trim();
	git("init", "-q");
	/* Its own origin, so the isolation refs read through git ls-remote. */
	git("remote", "add", "origin", tmp);
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
	const v = await queueTester({ root: tmp, ...clock() }).verdict(sha);
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

/**
 * Named files at SHA, which `iso` names a `lander/iso-*` ref's head, on a
 * clock from `start`.
 */
const askNamed = (
	r: ReturnType<typeof fakeNamedReads>,
	{
		root = namedRoot(),
		start = 0,
		iso = [{ branch: "lander/iso-1", sha: SHA }],
	} = {},
) => {
	const time = clock(start);
	return queueTester({
		root,
		reads: {
			...r.reads,
			runs: () => [],
			rerun: () => undefined,
			isoRefs: () => iso,
			runsOn: () => [],
		},
		wait: time.wait,
		now: time.now,
	}).verdict(SHA, ["scripts/lib/a.test.ts"]);
};

it("dispatches the named files at the sha and reads its own run's green, naming no run (#3764)", async () => {
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
		reason: "run 7 failed naming no failing file in the tree",
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
])("reads %s as no verdict (#3764)", async (_, r, why) => {
	expect(await askNamed(r)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(why),
	});
});

it("stops dispatching at the cap for a UTC day, and a new day has its own (#3764)", async () => {
	const root = namedRoot();
	const r = fakeNamedReads({ conclusion: "success" });
	const DayOne = Date.parse("2026-11-01T23:00:00Z");
	/* At a sha no isolation ref holds and no batch run covers. */
	const ask = (nowMs: number) => askNamed(r, { root, start: nowMs, iso: [] });
	for (let i = 0; i < 12; i++) {
		r.dispatched.length = 0;
		expect(await ask(DayOne)).toEqual({ kind: "green" });
	}
	r.dispatched.length = 0;
	expect(await ask(DayOne)).toEqual({
		kind: "unknown",
		reason: "named-rerun.yml's 12-a-day cap is spent",
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

/* The queue lander's tester (#4458): whole runs read on `lander/batch` or
 * a `lander/iso-suite-*` ref, named files dispatched to named-rerun.yml. */
const NAMED_OK: Job = { name: "Named files", conclusion: "success" };
const ISO = "c".repeat(40);
const atIso = () => [{ branch: "lander/iso-1", sha: ISO }];

const queueReads = (
	listings: (() => Run[])[],
	{
		iso = (): { branch: string; sha: string }[] => [],
		runsOn = (_: string): Run[] => [],
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
		isoRefs: iso,
		runsOn,
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
	const r = queueReads([() => []], { iso: atIso, named: "failure" });
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
	const r = queueReads([() => []], { iso: atIso });
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

it("reads a named run never listed as unknown, and isolation refs it cannot read as a transient no verdict (#4458)", async () => {
	expect(
		await queueOf(
			queueReads([() => []], { iso: atIso, listed: false }),
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
	expect(await queueOf(r).verdict(ISO, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "unknown",
		reason: "lander/iso-* refs unread: ls-remote failed",
		transient: true,
	});
	expect(r.dispatched).toEqual([]);
});

it("runs named files at main's sha on lander/iso-base anew, cap-exempt, never reading the batch run that landed it (#4485)", async () => {
	const r = queueReads([() => [run(1, "success")]], {
		iso: () => [{ branch: "lander/iso-base", sha: SHA }],
		named: "failure",
	});
	const files = ["scripts/lib/a.test.ts"];
	expect(await queueOf(r).verdict(SHA, files)).toMatchObject({
		kind: "red",
		files: ["scripts/lib/a.test.ts", "scripts/test_b.py"],
	});
	expect(r.dispatched).toEqual([
		{ sha: SHA, files, nonce: expect.any(String) },
	]);
	expect(r.calls()).toBe(0);
});

it("reads the whole suite at a sha a lander/iso-suite-* ref holds off that ref's push run, rerunning its failed jobs asked again (#4485)", async () => {
	let listed = 0;
	const branches: string[] = [];
	const r = queueReads([() => [run(1, "success")]], {
		iso: () => [{ branch: "lander/iso-suite-0", sha: SHA }],
		runsOn: (branch) => {
			branches.push(branch);
			return listed++ === 0
				? [run(7, "failure")]
				: [run(7, "success", { attempt: 2 })];
		},
	});
	expect(await queueOf(r).verdict(SHA, [], true)).toEqual({
		kind: "green",
		run: 7,
	});
	expect(r.reran).toEqual([7]);
	expect(new Set(branches)).toEqual(new Set(["lander/iso-suite-0"]));
	expect(r.calls()).toBe(0);
});

it("reruns the failed jobs of the whole suite's batch run asked again, and reads a first ask as it stands (#4485)", async () => {
	const again = queueReads([
		() => [run(4, "failure")],
		() => [run(4, "success", { attempt: 2 })],
	]);
	expect(await queueOf(again).verdict(SHA, [], true)).toEqual({
		kind: "green",
		run: 4,
	});
	expect(again.reran).toEqual([4]);
	const first = queueReads([() => [run(4, "failure")]]);
	expect(await queueOf(first).verdict(SHA, [])).toMatchObject({ kind: "red" });
	expect(first.reran).toEqual([]);
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
	const r = queueReads([() => []], { iso: atIso });
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

it("fires the suite workflow on a push to lander/batch and lander/iso-suite-*, and none to landing (#4458, #4485)", () => {
	const workflow = fs.readFileSync(
		path.join(
			import.meta.dirname,
			"../../.github/workflows/scheduled-checks.yml",
		),
		"utf8",
	);
	expect(workflow).toContain(
		'  push:\n    branches: [lander/batch, "lander/iso-suite-*"]\n',
	);
});

it("reads lander/batch and lander/iso-suite-* runs through gh and the isolation refs through git ls-remote (#4458)", async () => {
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
	git(work, "push", "-q", "origin", "HEAD:refs/heads/lander/iso-suite-0");
	const nonceFile = path.join(tmp, "nonce");
	const answers = {
		list: [run(3, "success")],
		suite: [{ ...run(9, "success"), headSha: iso }],
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
	const branch = argv[argv.indexOf("--branch") + 1];
	if (branch === "lander/iso-suite-0") out(a.suite);
	else if (branch !== "lander/batch") process.exit(1);
	else out(a.list);
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
	expect(await tester.verdict(iso)).toEqual({ kind: "green", run: 9 });
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
