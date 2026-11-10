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
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Job, queueTester, type Run } from "./actions-tester.js";
import { stubGhScript } from "./gh-stub.js";
import { markersDir } from "./marker-root.js";
import type { Placement } from "./queue-lander.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
/* The CJS module's own PushRefused, which actions-tester.js tells by
 * `instanceof`: an ESM import would load a second copy. */
const { PushRefused } = createRequire(__filename)("./network-fault.js");

const BATCH0 = { kind: "batch", slot: 0 } as const;
const ISO1 = { kind: "iso", k: 1 } as const;
const BASE = { kind: "iso", k: "base" } as const;

let tmp: string | null = null;
afterEach(() => {
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
	const repushed: string[] = [];
	return {
		runs: () => {
			const next = listings[Math.min(n, listings.length - 1)];
			n++;
			if (!next) throw new Error("no listing");
			return next();
		},
		jobsOf: (_run: number) => jobs,
		failedLogOf: () => FAILED_LOG,
		jobLogOf: (_job: number) => "",
		presentAt: (_: string, files: string[]) =>
			files.filter((f) => present.includes(f)),
		rerun: (id: number) => {
			reran.push(id);
		},
		repush: (branch: string, sha: string) => {
			repushed.push(`${branch}@${sha}`);
			return true;
		},
		calls: () => n,
		reran,
		repushed,
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

/** The whole suite at SHA, read off its push run on `lander/batch-0`. */
const verdictOf = (r: ReturnType<typeof reads>) =>
	queueTester({
		root: "/",
		reads: {
			...r,
			push: () => undefined,
			runsOn: () => r.runs(),
			cancel: () => undefined,
			namedRuns: () => [],
			dispatch: () => undefined,
		},
		...clock(),
	}).verdict(BATCH0, SHA);

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
	const r = reads([() => [run(1, "failure")]], shards("failure"));
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

it("marks a red retried where every failed job failed at its in-job retry, naming only the files it failed again (#4545)", async () => {
	const retry = (step: string): Job => ({
		name: "Full suite / Vitest (1/2)",
		conclusion: "failure",
		steps: [
			{ name: "Vitest", conclusion: "failure" },
			{ name: step, conclusion: "failure" },
		],
	});
	/* The first run failed a.test.ts and test_b.py; the retry cleared the
	 * first. --log-failed prints both steps' lines. */
	const retriedLog = `${FAILED_LOG}
Full suite / Vitest (1/2)\tRetry failed files\t2026-10-27T08:31:00.0Z retry-failed-files: still failing after one retry: scripts/test_b.py`;
	const verdictWith = (job: Job, log = retriedLog, present?: string[]) => {
		/* A failed shard fails `Suite passed`, at a step of its own. */
		const summary: Job = {
			name: "Suite passed",
			conclusion: "failure",
			steps: [{ name: "Run echo", conclusion: "failure" }],
		};
		const r = reads([() => [run(1, "failure")]], [job, summary], present);
		r.failedLogOf = () => log;
		return verdictOf(r);
	};
	expect(await verdictWith(retry("Retry failed files"))).toMatchObject({
		kind: "red",
		files: ["scripts/test_b.py"],
		retried: true,
	});
	expect(await verdictWith(retry("Vitest"))).not.toHaveProperty("retried");
	const crashed = `${FAILED_LOG}
x\tRetry failed files\tT retry-failed-files: still failing after one retry: none`;
	expect(
		await verdictWith(retry("Retry failed files"), crashed),
	).not.toHaveProperty("retried");
});

it("names on a batch's whole-suite green the files its in-job retry cleared, off each retried shard's retry step, as its flakes (#4558)", async () => {
	const shard = (k: number, retry: string | null): Job => ({
		name: `Full suite / Vitest (${k}/2)`,
		conclusion: "success",
		databaseId: 100 + k,
		steps: [
			{ name: "Vitest", conclusion: "success" },
			{ name: "Retry failed files", conclusion: retry },
		],
	});
	const logs: Record<number, string> = {
		101: [
			/* A test printing the line as its fixture, in the Vitest step. */
			"Full suite / Vitest (1/2)\tVitest\t2026-11-09T03:59:00.0Z retry-failed-files: cleared by one retry: scripts/test_b.py",
			"Full suite / Vitest (1/2)\tRetry failed files\t2026-11-09T04:00:00.0Z retry-failed-files: cleared by one retry: scripts/lib/a.test.ts, scripts/fixture-only.test.ts",
		].join("\n"),
	};
	const r = reads(
		[() => [run(1, "success")]],
		[shard(1, "success"), shard(2, "skipped"), SUITE_PASSED],
	);
	const read: number[] = [];
	r.jobLogOf = (job: number) => {
		read.push(job);
		return logs[job] ?? "";
	};
	/* The file the tree lacks is a fixture's text, never a flake. */
	expect(await verdictOf(r)).toEqual({
		kind: "green",
		run: 1,
		cleared: ["scripts/lib/a.test.ts"],
	});
	expect(read).toEqual([101]);
	/* A later ask read off the same run records none: the batch's whole
	 * suite ask did. */
	expect(
		await queueTester({
			root: "/",
			reads: {
				...r,
				push: () => undefined,
				runsOn: () => r.runs(),
				cancel: () => undefined,
				namedRuns: () => [],
				dispatch: () => undefined,
			},
			...clock(),
		}).verdict(BATCH0, SHA, ["scripts/lib/a.test.ts"]),
	).toEqual({ kind: "green", run: 1 });
	r.jobLogOf = () => {
		throw new Error("HTTP 502");
	};
	expect(await verdictOf(r)).toEqual({ kind: "green", run: 1 });
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
	expect((await verdictOf(reads([() => runs], shards("failure")))).kind).toBe(
		"red",
	);
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

it.each([
	["a shard", [...shards("success", ""), SUITE_PASSED]],
	[
		"Suite passed",
		[
			...shards("success", "success"),
			{ name: "Suite passed", conclusion: null },
		],
	],
])(
	"waits out a concluded run whose %s job still runs, never reading it as unknown (#4347)",
	async (_, early) => {
		const r = reads([() => [run(1, "success")]]);
		let n = 0;
		r.jobsOf = () =>
			n++ === 0 ? early : [...shards("success", "success"), SUITE_PASSED];
		expect(await verdictOf(r)).toEqual({ kind: "green", run: 1 });
		expect(n).toBe(2);
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

/* GitHub created 6 of its 12 jobs, all passed, and
 * concluded the run `failure`. */
const partlyCreated = (): Job[] => shards("success", "success", "success");

it("pushes the ref again over a failed run whose created jobs all passed, judging only the newer run and never a red (#4827)", async () => {
	const r = reads([
		() => [run(5, "failure")],
		() => [run(9, "success"), run(5, "failure")],
	]);
	r.jobsOf = (id: number) =>
		id === 5
			? partlyCreated()
			: [...shards("success", "success"), SUITE_PASSED];
	expect(await verdictOf(r)).toEqual({ kind: "green", run: 9 });
	expect(r.repushed).toEqual([`lander/batch-0@${SHA}`]);
	expect(r.reran).toEqual([]);
});

it("is no verdict where the run after the push again also fails listing no failed job (#4827)", async () => {
	const r = reads(
		[() => [run(5, "failure")], () => [run(9, "failure"), run(5, "failure")]],
		partlyCreated(),
	);
	expect(await verdictOf(r)).toEqual({
		kind: "unknown",
		reason:
			"run 9 failed listing no failed job, which judges no code, after lander/batch-0 was pushed again",
	});
	expect(r.repushed).toEqual([`lander/batch-0@${SHA}`]);
});

it("pushes the ref again over a failed run whose only failed job is Suite passed, and reads no run after it as no verdict, never a red (#4827)", async () => {
	const r = reads(
		[() => [run(5, "failure")]],
		[...shards("success"), { name: "Suite passed", conclusion: "failure" }],
	);
	expect(await verdictOf(r)).toEqual({
		kind: "unknown",
		reason:
			"run 5 failed listing no failed job, which judges no code, and no run followed lander/batch-0 pushed again",
	});
	expect(r.repushed).toEqual([`lander/batch-0@${SHA}`]);
});

it("reads a failed run whose job was cancelled as red, a hang being the code's (#4827)", async () => {
	const r = reads(
		[() => [run(5, "failure")]],
		[
			...shards("success", "cancelled"),
			{ name: "Suite passed", conclusion: "failure" },
		],
	);
	expect(await verdictOf(r)).toMatchObject({ kind: "red" });
	expect(r.repushed).toEqual([]);
});

it("reads a failed dependency install as red, a broken lockfile being the code's", async () => {
	const r = reads(
		[() => [run(5, "failure")]],
		unreadied("Install dependencies"),
	);
	expect(await verdictOf(r)).toMatchObject({ kind: "red" });
	expect(r.reran).toEqual([]);
});

it("names on a red that failed the step ci.yml runs the type-check at the first ten tsc errors that step printed, and none on a red that passed it (#4800)", async () => {
	const ci = fs.readFileSync(
		path.join(__dirname, "..", "..", ".github", "workflows", "ci.yml"),
		"utf8",
	);
	const typecheckStep =
		/\n\s+- name: (.+)\n(?:\s+if: .+\n)?\s+run: npm run typecheck\n/.exec(
			ci,
		)?.[1] ?? "no step of ci.yml runs the type-check";
	const lint = (step: string): Job => ({
		name: "Full suite / Lint and types",
		conclusion: "failure",
		steps: [
			{ name: "ESLint", conclusion: "success" },
			{ name: step, conclusion: "failure" },
		],
	});
	const errors = Array.from(
		{ length: 12 },
		(_, i) => `scripts/a.js(${i + 1},5): error TS2304: Cannot find name 'c'.`,
	);
	/* `gh` names a step, or prints UNKNOWN STEP for a job a reusable
	 * workflow calls, as on run 39747307904. */
	const logOf = (step: string) =>
		[
			`Full suite / Vitest (1/2)\t${step}\t2026-11-10T08:30:00.0Z fixture.js(1,1): error TS1: another job's`,
			`Full suite / Lint and types\tESLint\t2026-11-10T08:30:00.5Z fixture.js(2,2): error TS2: another step's`,
			`Full suite / Lint and types\t${step}\t2026-11-10T08:30:01.0Z > workflow-core@0.1.0 typecheck`,
			...errors.map(
				(e) =>
					`Full suite / Lint and types\t${step}\t2026-11-10T08:30:01.5Z ${e}`,
			),
			`Full suite / Lint and types\t${step}\t2026-11-10T08:30:02.0Z ##[error]Process completed with exit code 2.`,
		].join("\n");
	let typedLog = logOf(typecheckStep);
	const verdictWith = (step: string) => {
		const r = reads([() => [run(6, "failure")]], [lint(step)]);
		r.failedLogOf = () => typedLog;
		return verdictOf(r);
	};

	expect(await verdictWith(typecheckStep)).toEqual({
		kind: "red",
		files: [],
		jobs: ["Full suite / Lint and types"],
		typecheck: errors.slice(0, 10),
	});
	typedLog = logOf("UNKNOWN STEP");
	expect(await verdictWith(typecheckStep)).toMatchObject({
		typecheck: errors.slice(0, 10),
	});
	expect(await verdictWith("Biome ci")).toEqual({
		kind: "red",
		files: [],
		jobs: ["Full suite / Lint and types"],
	});
});

it("reads a failed run through gh and the tree through git", async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actions-tester-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: tmp as string, encoding: "utf8" }).trim();
	git("init", "-q");
	/* Its own origin, so the batch ref's push lands somewhere. */
	git("remote", "add", "origin", tmp);
	fs.mkdirSync(path.join(tmp, "scripts", "lib"), { recursive: true });
	fs.writeFileSync(path.join(tmp, "scripts", "lib", "a.test.ts"), "");
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
	const sha = git("rev-parse", "HEAD");
	git("update-ref", "refs/heads/lander/batch-0", sha);
	const answers = {
		list: JSON.stringify([run(7, "failure", { headSha: sha })]),
		jobs: JSON.stringify({
			jobs: [{ name: "Full suite / Vitest (2/6)", conclusion: "failure" }],
		}),
		log: FAILED_LOG,
	};
	vi.stubEnv(
		"WFC_GH",
		stubGhScript(
			tmp,
			`#!/usr/bin/env node
const a = ${JSON.stringify(answers)};
const argv = process.argv.slice(2);
process.stdout.write(argv[1] === "list" ? a.list : argv.includes("--log-failed") ? a.log : a.jobs);
`,
		).gh,
	);
	const v = await queueTester({ root: tmp, ...clock() }).verdict(BATCH0, sha);
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
			jobLogOf: () => "",
			presentAt: (_: string, files: string[]) =>
				files.filter((f) => f !== "scripts/fixture-only.test.ts"),
		},
	};
};

const namedRoot = () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "named-rerun-"));
	return tmp;
};

/** Named files at SHA asked at `place`, on a clock from `start`. */
const askNamed = (
	r: ReturnType<typeof fakeNamedReads>,
	{ root = namedRoot(), start = 0, place = ISO1 as Placement } = {},
) => {
	const time = clock(start);
	return queueTester({
		root,
		reads: {
			...r.reads,
			rerun: () => undefined,
			repush: () => true,
			push: () => undefined,
			runsOn: () => [],
			cancel: () => undefined,
		},
		wait: time.wait,
		now: time.now,
	}).verdict(place, SHA, ["scripts/lib/a.test.ts"]);
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

it("waits out a named run concluded with its job still running (#4347)", async () => {
	const r = fakeNamedReads({ conclusion: "success" });
	let n = 0;
	r.reads.jobsOf = () => [
		{ name: "Named files", conclusion: n++ === 0 ? "" : "success" },
	];
	expect(await askNamed(r)).toEqual({ kind: "green" });
	expect(n).toBe(2);
});

it("judges only the files the tree at the sha holds, green with no dispatch where it holds none (#4347)", async () => {
	const absent = fakeNamedReads({ conclusion: "failure" });
	absent.reads.presentAt = () => [];
	expect(await askNamed(absent)).toEqual({ kind: "green" });
	expect(absent.dispatched).toEqual([]);
	const some = fakeNamedReads({ conclusion: "success" });
	const ask = queueTester({
		root: namedRoot(),
		reads: {
			...some.reads,
			presentAt: (_: string, files: string[]) =>
				files.filter((f) => f === "scripts/lib/a.test.ts"),
			rerun: () => undefined,
			repush: () => true,
			push: () => undefined,
			runsOn: () => [],
			cancel: () => undefined,
		},
		...clock(),
	}).verdict(ISO1, SHA, ["scripts/lib/a.test.ts", "scripts/new.test.ts"]);
	expect(await ask).toEqual({ kind: "green" });
	expect(some.dispatched.map((d) => d.files)).toEqual([
		["scripts/lib/a.test.ts"],
	]);
	const unread = fakeNamedReads({ conclusion: "success" });
	unread.reads.presentAt = () => {
		throw new Error("fatal: not a tree object");
	};
	const v = await askNamed(unread);
	expect(v).toMatchObject({ kind: "unknown" });
	expect(v.kind === "unknown" && v.reason).toMatch(/tree at a+ unread/);
	expect(unread.dispatched).toEqual([]);
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
	/* At a batch sha no run covers. */
	const ask = (nowMs: number) =>
		askNamed(r, { root, start: nowMs, place: BATCH0 });
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

/* The queue lander's tester (#4458): whole runs read on `lander/batch-<k>` or
 * a `lander/iso-suite-*` ref, named files dispatched to named-rerun.yml. */
const NAMED_OK: Job = { name: "Named files", conclusion: "success" };
const ISO = "c".repeat(40);

/**
 * Queue reads whose `lander/batch-0` serves `listings`, every other ref
 * `runsOn`; each push recorded as `<branch>@<sha>`.
 */
const queueReads = (
	listings: (() => Run[])[],
	{
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
	const cancelled: number[] = [];
	const pushed: string[] = [];
	return {
		...r,
		dispatched,
		cancelled,
		pushed,
		push: (branch: string, sha: string) => {
			pushed.push(`${branch}@${sha}`);
		},
		runsOn: (branch: string) =>
			branch === "lander/batch-0" ? r.runs() : runsOn(branch),
		cancel: (id: number) => {
			cancelled.push(id);
		},
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

it("reads the whole suite at a batch slot off the push run on its lander/batch-<k> ref, pushing the sha there first, a file list empty or absent (#4458, #4556, #4910)", async () => {
	const r = queueReads([() => [run(1, "success")]]);
	const tester = queueOf(r);
	expect(await tester.verdict(BATCH0, SHA)).toEqual({ kind: "green", run: 1 });
	expect(await tester.verdict(BATCH0, SHA, [])).toEqual({
		kind: "green",
		run: 1,
	});
	expect(r.pushed).toEqual([`lander/batch-0@${SHA}`, `lander/batch-0@${SHA}`]);
	expect(tester.requiresRun).toBe(true);
	expect(tester.repeatsGates).toBe(true);
	expect(r.dispatched).toEqual([]);
});

it("reads the whole suite of a run alone off the lander/iso-suite-<k> ref it pushes, never the batch's run at the same sha (#4485, #4910)", async () => {
	const r = queueReads([() => [run(1, "success")]], {
		runsOn: () => [run(7, "success")],
	});
	expect(await queueOf(r).verdict(BASE, SHA)).toEqual({
		kind: "green",
		run: 7,
	});
	expect(await queueOf(r).verdict({ kind: "iso", k: 2 }, SHA)).toEqual({
		kind: "green",
		run: 7,
	});
	expect(r.pushed).toEqual([
		`lander/iso-suite-base@${SHA}`,
		`lander/iso-suite-2@${SHA}`,
	]);
	expect(r.calls()).toBe(0);
});

it("starts a batch's run by pushing its sha to the slot's ref, pushes named files alone to lander/iso-<k> before dispatching them, and pushes nothing for a batch's named files (#4573, #4910)", async () => {
	const r = queueReads([() => [run(1, "success")]]);
	const tester = queueOf(r);
	tester.start?.({ kind: "batch", slot: 3 }, SHA);
	expect(r.pushed).toEqual([`lander/batch-3@${SHA}`]);
	/* named-rerun.yml fetches the sha from the remote, which a local
	 * isolation merge reaches only by this push. */
	expect(await tester.verdict(ISO1, ISO, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "green",
	});
	expect(await tester.verdict(BATCH0, SHA, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "green",
		run: 1,
	});
	expect(r.pushed).toEqual([`lander/batch-3@${SHA}`, `lander/iso-1@${ISO}`]);
	const unpushed = queueReads([() => []]);
	unpushed.push = () => {
		throw new Error("pre-receive hook declined");
	};
	expect(
		await queueOf(unpushed).verdict(ISO1, ISO, ["scripts/lib/a.test.ts"]),
	).toEqual({
		kind: "unknown",
		reason: `lander/iso-1 not pushed at ${ISO.slice(0, 9)}: pre-receive hook declined`,
	});
	expect(unpushed.dispatched).toEqual([]);
	const failing = queueReads([() => []]);
	failing.push = () => {
		throw new Error("network down");
	};
	expect(() => queueOf(failing).start?.(BATCH0, SHA)).toThrow("network down");
});

it("reads a whole-suite push the remote refuses as no verdict, transient only for the network, reading no run (#4910)", async () => {
	const at = (fault: Error) => {
		const r = queueReads([() => [run(1, "success")]]);
		r.push = () => {
			throw fault;
		};
		return { r, v: queueOf(r).verdict(BATCH0, SHA) };
	};
	const refused = at(
		new PushRefused("push", {
			cause: Object.assign(new Error("push"), {
				status: 1,
				stderr: "test said: Connection reset\nerror: failed to push some refs",
			}),
		}),
	);
	const v = await refused.v;
	expect(v).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(
			/^lander\/batch-0 not pushed at aaaaaaaaa: .*failed to push some refs/s,
		),
	});
	expect(v).not.toHaveProperty("transient");
	expect(refused.r.calls()).toBe(0);
	expect(
		await at(Object.assign(new Error("push"), { code: "ETIMEDOUT" })).v,
	).toMatchObject({ kind: "unknown", transient: true });
});

it("reads a batch run never listed on lander/batch-<k> as a red naming no file, its tree firing no run, and a listing it cannot read as unknown (#4458, #4571)", async () => {
	expect(await queueOf(queueReads([() => []])).verdict(BATCH0, SHA)).toEqual({
		kind: "red",
		files: [],
		noRun: true,
	});
	expect(await queueOf(queueReads([])).verdict(BATCH0, SHA)).toMatchObject({
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
	expect(await queueOf(r).verdict(BATCH0, SHA)).toEqual({
		kind: "green",
		run: 5,
	});
	expect(r.reran).toEqual([5]);
});

it("reruns a failed batch run's failed jobs for named files at its sha, so a green names the run main takes (#3329, #4458)", async () => {
	const r = queueReads([
		() => [run(1, "failure")],
		() => [run(1, "success", { attempt: 2 })],
	]);
	expect(
		await queueOf(r).verdict(BATCH0, SHA, ["scripts/lib/a.test.ts"]),
	).toEqual({
		kind: "green",
		run: 1,
	});
	expect(r.reran).toEqual([1]);
	expect(r.dispatched).toEqual([]);
	expect(r.pushed).toEqual([]);
});

it("dispatches named files at an isolation sha to named-rerun.yml, red naming the tree's failing files (#4458)", async () => {
	const r = queueReads([() => []], { named: "failure" });
	expect(
		await queueOf(r).verdict(ISO1, ISO, ["scripts/lib/a.test.ts"]),
	).toEqual({
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
	const r = queueReads([() => []]);
	const tester = queueOf(r);
	const files = ["scripts/lib/a.test.ts"];
	/* A batch slot whose ref lists no run at OTHER. */
	const Batch1 = { kind: "batch", slot: 1 } as const;
	for (let i = 0; i < 3; i++)
		expect(await tester.verdict(ISO1, ISO, files)).toEqual({ kind: "green" });
	for (let i = 0; i < 12; i++)
		expect(await tester.verdict(Batch1, OTHER, files)).toEqual({
			kind: "green",
		});
	expect(await tester.verdict(Batch1, OTHER, files)).toEqual({
		kind: "unknown",
		reason: "named-rerun.yml's 12-a-day cap is spent",
	});
	expect(await tester.verdict(ISO1, ISO, files)).toEqual({ kind: "green" });
	expect(r.dispatched.filter((d) => d.sha === ISO)).toHaveLength(4);
	expect(r.dispatched.filter((d) => d.sha === OTHER)).toHaveLength(12);
});

it("reads a named run never listed as unknown (#4458)", async () => {
	expect(
		await queueOf(queueReads([() => []], { listed: false })).verdict(
			ISO1,
			ISO,
			["scripts/lib/a.test.ts"],
		),
	).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/^named-rerun\.yml listed no run titled /),
	});
});

it("runs named files at main's sha for its base check anew, cap-exempt, never reading the batch run that landed it (#4485)", async () => {
	const r = queueReads([() => [run(1, "success")]], { named: "failure" });
	const files = ["scripts/lib/a.test.ts"];
	expect(await queueOf(r).verdict(BASE, SHA, files)).toMatchObject({
		kind: "red",
		files: ["scripts/lib/a.test.ts", "scripts/test_b.py"],
	});
	expect(r.dispatched).toEqual([
		{ sha: SHA, files, nonce: expect.any(String) },
	]);
	expect(r.calls()).toBe(0);
});

it("reads the whole suite of a run alone off its lander/iso-suite-* ref's push run, rerunning its failed jobs asked again (#4485)", async () => {
	let listed = 0;
	const branches: string[] = [];
	const r = queueReads([() => [run(1, "success")]], {
		runsOn: (branch) => {
			branches.push(branch);
			return listed++ === 0
				? [run(7, "failure")]
				: [run(7, "success", { attempt: 2 })];
		},
	});
	expect(
		await queueOf(r).verdict({ kind: "iso", k: 0 }, SHA, [], true),
	).toEqual({
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
	expect(await queueOf(again).verdict(BATCH0, SHA, [], true)).toEqual({
		kind: "green",
		run: 4,
	});
	expect(again.reran).toEqual([4]);
	const first = queueReads([() => [run(4, "failure")]]);
	first.jobsOf = () => shards("failure");
	expect(await queueOf(first).verdict(BATCH0, SHA, [])).toMatchObject({
		kind: "red",
	});
	expect(first.reran).toEqual([]);
});

it("pushes the ref again over a failed run GitHub will not retry, judging only a newer run: asked again, for named files, or a runner that failed to ready (#4823)", async () => {
	const refusal = (runnerFault: boolean) => {
		const failed = run(4, "failure");
		const r = queueReads([
			() => (r.repushed.length === 0 ? [failed] : [run(5, "success"), failed]),
		]);
		r.jobsOf = (id: number) =>
			runnerFault && id === 4
				? unreadied("Install test tools", "failure")
				: [...shards("success", "success"), SUITE_PASSED];
		r.rerun = () => {
			throw Object.assign(new Error("gh failed"), {
				stderr: "run 4 cannot be rerun; This workflow run cannot be retried",
			});
		};
		return r;
	};
	const asks: [
		boolean,
		(r: ReturnType<typeof queueReads>) => Promise<unknown>,
	][] = [
		[false, (r) => queueOf(r).verdict(BATCH0, SHA, [], true)],
		[false, (r) => queueOf(r).verdict(BATCH0, SHA, ["scripts/lib/a.test.ts"])],
		[true, (r) => queueOf(r).verdict(BATCH0, SHA)],
	];
	for (const [runnerFault, ask] of asks) {
		const r = refusal(runnerFault);
		expect(await ask(r)).toEqual({ kind: "green", run: 5 });
		expect(r.repushed).toEqual([`lander/batch-0@${SHA}`]);
		expect(r.dispatched).toEqual([]);
	}
});

it("counts each push again for a runner GitHub will not retry against the runner's rerun bound (#4823)", async () => {
	const r = queueReads([() => [run(10 + r.repushed.length, "failure")]]);
	r.jobsOf = () => unreadied("Install test tools", "failure");
	r.rerun = () => {
		throw Object.assign(new Error("gh failed"), {
			stderr: "run 10 cannot be rerun; This workflow run cannot be retried",
		});
	};
	expect(await queueOf(r).verdict(BATCH0, SHA)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/on 3 attempts$/),
	});
	expect(r.repushed).toHaveLength(2);
});

it("pushes the ref again for the whole suite asked again over a run at the sha that did not fail, judging only a newer run (#4524)", async () => {
	const SuiteBase = "lander/iso-suite-base";
	const earlier = run(7, "success");
	const fresh = queueReads([], {
		runsOn: () =>
			fresh.repushed.length === 0 ? [earlier] : [run(9, "success"), earlier],
	});
	expect(await queueOf(fresh).verdict(BASE, SHA, [], true)).toEqual({
		kind: "green",
		run: 9,
	});
	expect(fresh.repushed).toEqual([`${SuiteBase}@${SHA}`]);
	expect(fresh.reran).toEqual([]);

	const none = queueReads([], { runsOn: () => [earlier] });
	expect(await queueOf(none).verdict(BASE, SHA, [], true)).toEqual({
		kind: "red",
		files: [],
		noRun: true,
	});
	expect(none.repushed).toEqual([`${SuiteBase}@${SHA}`]);
});

it("never reads the whole suite asked again off a run older than the branch's newest at the ask, though none was at the sha (#4524)", async () => {
	const atAsk = run(8, "success", { headSha: OTHER });
	const listing = (after: Run) => {
		let n = 0;
		return queueReads([], {
			runsOn: () => (n++ === 0 ? [atAsk] : [after, atAsk]),
		});
	};
	const stale = listing(run(7, "success"));
	expect(await queueOf(stale).verdict(BASE, SHA, [], true)).toEqual({
		kind: "red",
		files: [],
		noRun: true,
	});
	const pushed = listing(run(9, "success"));
	expect(await queueOf(pushed).verdict(BASE, SHA, [], true)).toEqual({
		kind: "green",
		run: 9,
	});
	expect(pushed.repushed).toEqual([]);
	expect(stale.repushed).toEqual([`lander/iso-suite-base@${SHA}`]);
});

it("pushes the ref again once for the whole suite asked again where no run at the sha was ever listed, judging the run that push starts (#4572)", async () => {
	const SuiteBase = "lander/iso-suite-base";
	const atAsk = run(8, "success", { headSha: OTHER });
	const recovered = queueReads([], {
		runsOn: () =>
			recovered.repushed.length === 0 ? [atAsk] : [run(9, "success"), atAsk],
	});
	expect(await queueOf(recovered).verdict(BASE, SHA, [], true)).toEqual({
		kind: "green",
		run: 9,
	});
	expect(recovered.repushed).toEqual([`${SuiteBase}@${SHA}`]);

	const outage = queueReads([], {
		runsOn: () => [atAsk],
	});
	expect(await queueOf(outage).verdict(BASE, SHA, [], true)).toEqual({
		kind: "red",
		files: [],
		noRun: true,
	});
	expect(outage.repushed).toEqual([`${SuiteBase}@${SHA}`]);
});

it("reads a ref moved, refused or cut off by the network on pushing it again as no verdict, transient only for the network (#4524)", async () => {
	const SuiteBase = "lander/iso-suite-base";
	const at = (repush: () => boolean) => {
		const r = queueReads([], {
			runsOn: () => [run(7, "success")],
		});
		r.repush = repush;
		return queueOf(r).verdict(BASE, SHA, [], true);
	};
	expect(await at(() => false)).toEqual({
		kind: "unknown",
		reason: `${SuiteBase} moved off ${SHA.slice(0, 9)} before it was pushed again`,
	});
	expect(
		await at(() => {
			throw new Error("pre-receive hook declined");
		}),
	).toEqual({
		kind: "unknown",
		reason: `${SuiteBase} not pushed again at ${SHA.slice(0, 9)}: pre-receive hook declined`,
	});
	expect(
		await at(() => {
			throw Object.assign(new Error("push"), { code: "ETIMEDOUT" });
		}),
	).toMatchObject({ kind: "unknown", transient: true });
});

const REFUSED =
	"run 42671573799 cannot be rerun; This workflow run cannot be retried";

it("pushes the ref again where GitHub refuses to rerun a failed batch run, judging only the newer run that push starts (#4822)", async () => {
	for (const files of [[], ["scripts/lib/a.test.ts"]]) {
		const failed = run(4, "failure");
		const r = queueReads([]);
		r.runsOn = () =>
			r.repushed.length === 0 ? [failed] : [run(9, "success"), failed];
		r.rerun = () => {
			throw new Error(REFUSED);
		};
		expect(await queueOf(r).verdict(BATCH0, SHA, files, true)).toEqual({
			kind: "green",
			run: 9,
		});
		expect(r.repushed).toEqual([`lander/batch-0@${SHA}`]);
		expect(r.dispatched).toEqual([]);
	}
});

it("pushes the ref again where GitHub refuses to rerun a run whose runner failed to ready, counting it an attempt, and reads any other rerun fault as no verdict (#4822)", async () => {
	const r = queueReads([]);
	r.runsOn = () =>
		r.repushed.length === 0
			? [run(5, "failure")]
			: [run(9, "success"), run(5, "failure")];
	r.jobsOf = (id: number) =>
		id === 5
			? unreadied("Install test tools", "failure")
			: [...shards("success", "success"), SUITE_PASSED];
	r.rerun = () => {
		throw new Error(REFUSED);
	};
	expect(await queueOf(r).verdict(BATCH0, SHA)).toEqual({
		kind: "green",
		run: 9,
	});
	expect(r.repushed).toEqual([`lander/batch-0@${SHA}`]);

	const stuck = queueReads([]);
	let newest = 5;
	stuck.runsOn = () => [run(newest, "failure")];
	stuck.jobsOf = () => unreadied("Install test tools", "failure");
	stuck.repush = (branch: string, sha: string) => {
		stuck.repushed.push(`${branch}@${sha}`);
		newest++;
		return true;
	};
	stuck.rerun = () => {
		throw new Error(REFUSED);
	};
	expect(await queueOf(stuck).verdict(BATCH0, SHA)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/Install test tools.*on 3 attempts/),
	});
	expect(stuck.repushed).toHaveLength(2);

	const forbidden = queueReads([() => [run(5, "failure")]]);
	forbidden.jobsOf = () => unreadied("Install test tools", "failure");
	forbidden.rerun = () => {
		throw new Error("failed to rerun: HTTP 500");
	};
	expect(await queueOf(forbidden).verdict(BATCH0, SHA)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/HTTP 500/),
	});
	expect(forbidden.repushed).toEqual([]);
});

it("waits on an unfinished batch run for named files at its sha, and reads one ended any other way as unknown, dispatching neither (#4458)", async () => {
	const files = ["scripts/lib/a.test.ts"];
	const r = queueReads([() => [run(1, null)], () => [run(1, "success")]]);
	expect(await queueOf(r).verdict(BATCH0, SHA, files)).toEqual({
		kind: "green",
		run: 1,
	});
	const cancelled = queueReads([() => [run(2, "cancelled")]]);
	expect(await queueOf(cancelled).verdict(BATCH0, SHA, files)).toMatchObject({
		kind: "unknown",
	});
	expect([...r.dispatched, ...cancelled.dispatched]).toEqual([]);
	expect([...r.reran, ...cancelled.reran]).toEqual([]);
});

it("reads a named-run listing or a rerun it cannot make as unknown (#4458)", async () => {
	const files = ["scripts/lib/a.test.ts"];
	const r = queueReads([() => []]);
	r.namedRuns = () => {
		throw new Error("HTTP 502");
	};
	expect(await queueOf(r).verdict(ISO1, ISO, files)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(
			/^named-rerun\.yml runs unreadable: .*HTTP 502/,
		),
	});
	const failed = queueReads([() => [run(1, "failure")]]);
	failed.rerun = () => {
		throw new Error("HTTP 403");
	};
	expect(await queueOf(failed).verdict(BATCH0, SHA, files)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/HTTP 403/),
	});
	expect(failed.dispatched).toEqual([]);
});

it("fires the suite workflow on a push to lander/batch-* and lander/iso-suite-*, and none to landing (#4458, #4485, #4556)", () => {
	const workflow = fs.readFileSync(
		path.join(
			import.meta.dirname,
			"../../.github/workflows/scheduled-checks.yml",
		),
		"utf8",
	);
	expect(workflow).toContain(
		'  push:\n    branches: ["lander/batch*", "lander/iso-suite-*"]\n',
	);
});

it("pushes and reads lander/batch-<k> and lander/iso-suite-* runs through git and gh, pushes named files alone to lander/iso-<k>, and cancels a run through gh (#4458, #4556, #4910)", async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-tester-"));
	const remote = path.join(tmp, "remote.git");
	const work = path.join(tmp, "work");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git(tmp, "init", "-q", "--bare", remote);
	git(tmp, "clone", "-q", remote, work);
	fs.mkdirSync(path.join(work, "scripts/lib"), { recursive: true });
	fs.writeFileSync(path.join(work, "scripts/lib/a.test.ts"), "");
	git(work, "add", ".");
	const commit = (m: string) =>
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
			m,
		);
	commit("a");
	const iso = git(work, "rev-parse", "HEAD");
	commit("b");
	const batch = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/lander/batch-1");
	commit("c");
	const unheld = git(work, "rev-parse", "HEAD");
	const cancelFile = path.join(tmp, "cancelled");
	const nonceFile = path.join(tmp, "nonce");
	const answers = {
		list: [
			{ ...run(3, "success"), headSha: batch },
			{ ...run(4, null), headSha: OTHER },
		],
		suite: [{ ...run(9, "success"), headSha: iso }],
		jobs: { jobs: [...shards("success"), SUITE_PASSED, NAMED_OK] },
	};
	vi.stubEnv(
		"WFC_GH",
		stubGhScript(
			tmp,
			`#!/usr/bin/env node
const fs = require("node:fs");
const a = ${JSON.stringify(answers)};
const argv = process.argv.slice(2);
const out = (v) => process.stdout.write(JSON.stringify(v));
if (argv[0] === "run" && argv[1] === "cancel") {
	fs.writeFileSync(${JSON.stringify(cancelFile)}, argv[2]);
} else if (argv[0] === "workflow") {
	const field = (k) => argv.find((x) => x.startsWith(k + "=")).slice(k.length + 1);
	fs.writeFileSync(${JSON.stringify(nonceFile)}, field("sha") + " " + field("nonce"));
} else if (argv[1] === "list" && argv.includes("named-rerun.yml")) {
	out([{ databaseId: 8, conclusion: "success",
		displayTitle: "named-rerun " + fs.readFileSync(${JSON.stringify(nonceFile)}, "utf8") }]);
} else if (argv[1] === "list") {
	const branch = argv[argv.indexOf("--branch") + 1];
	if (branch === "lander/iso-suite-0") out(a.suite);
	else if (branch !== "lander/batch-1") process.exit(1);
	else out(a.list);
} else out(a.jobs);
`,
		).gh,
	);
	const record = path.join(markersDir(work), ".lander-named-runs.jsonl");
	fs.writeFileSync(
		record,
		`${JSON.stringify({ at: new Date().toISOString() })}\n`.repeat(12),
	);
	const tester = queueTester({ root: work, ...wallClock() });
	const Batch1 = { kind: "batch", slot: 1 } as const;
	const Iso0 = { kind: "iso", k: 0 } as const;
	const heads = () => git(work, "ls-remote", "origin", "refs/heads/lander/*");
	const pushedBefore = heads();
	/* The batch ref already holds its sha: the push leaves it as it was. */
	expect(await tester.verdict(Batch1, batch)).toEqual({
		kind: "green",
		run: 3,
	});
	expect(heads()).toBe(pushedBefore);
	expect(await tester.verdict(Iso0, iso)).toEqual({ kind: "green", run: 9 });
	expect(
		git(work, "ls-remote", "origin", "refs/heads/lander/iso-suite-0"),
	).toBe(`${iso}\trefs/heads/lander/iso-suite-0`);
	/* An isolation commit no pushed ref reaches, as a local merge is. */
	git(work, "checkout", "-q", "-b", "side", iso);
	commit("alone");
	const alone = git(work, "rev-parse", "HEAD");
	git(work, "checkout", "-q", "-");
	expect(await tester.verdict(ISO1, alone, ["scripts/lib/a.test.ts"])).toEqual({
		kind: "green",
	});
	expect(git(work, "ls-remote", "origin", "refs/heads/lander/iso-1")).toBe(
		`${alone}\trefs/heads/lander/iso-1`,
	);
	expect(
		await tester.verdict(Batch1, batch, ["scripts/lib/a.test.ts"]),
	).toEqual({
		kind: "green",
		run: 3,
	});
	expect(
		await tester.verdict(Batch1, unheld, ["scripts/lib/a.test.ts"]),
	).toEqual({
		kind: "unknown",
		reason: "named-rerun.yml's 12-a-day cap is spent",
	});
	/* Asked again over the passed run 9, the ref is pushed again and no run
	 * newer than 9 is listed. */
	expect(await tester.verdict(Iso0, iso, [], true)).toEqual({
		kind: "red",
		files: [],
		noRun: true,
	});
	expect(
		git(work, "ls-remote", "origin", "refs/heads/lander/iso-suite-0"),
	).toBe(`${iso}\trefs/heads/lander/iso-suite-0`);
	expect(tester.cancel?.(Batch1, batch)).toEqual([batch, OTHER]);
	expect(fs.readFileSync(cancelFile, "utf8")).toBe("4");
	tester.start?.({ kind: "batch", slot: 2 }, unheld);
	expect(git(work, "ls-remote", "origin", "refs/heads/lander/batch-2")).toBe(
		`${unheld}\trefs/heads/lander/batch-2`,
	);
});

it("reads a lander ref push its hook refuses, quoting a network fault, as a non-transient no verdict, never retried (#4513, #4910)", async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-tester-refused-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: tmp as string, encoding: "utf8" }).trim();
	git("init", "-q");
	git("remote", "add", "origin", tmp);
	git(
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
	const sha = git("rev-parse", "HEAD");
	fs.writeFileSync(
		path.join(tmp, ".git", "hooks", "pre-push"),
		"#!/bin/sh\necho 'test said: Connection reset' >&2\nexit 1\n",
		{ mode: 0o755 },
	);
	const v = await queueTester({ root: tmp, ...clock() }).verdict(BATCH0, sha);
	expect(v).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/^lander\/batch-0 not pushed at /),
	});
	expect(v).not.toHaveProperty("transient");
});

it("cancels every unfinished run on a batch ref but those at the sha kept, naming every sha it lists a run at (#4556, #4576)", () => {
	const third = "c".repeat(40);
	const r = queueReads([
		() => [
			run(1, "success", { headSha: OTHER }),
			run(2, null),
			run(3, null, { headSha: OTHER }),
			run(4, null, { headSha: OTHER, attempt: 2 }),
			run(5, null, { headSha: third }),
		],
	]);
	expect(queueOf(r).cancel?.(BATCH0, SHA)).toEqual([OTHER, SHA, third]);
	expect(r.cancelled).toEqual([3, 4, 5]);
	const all = queueReads([() => [run(1, "failure"), run(2, null)]]);
	expect(queueOf(all).cancel?.(BATCH0, null)).toEqual([SHA]);
	expect(all.cancelled).toEqual([2]);
});
