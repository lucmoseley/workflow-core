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
import { actionsTester, type Job, type Run } from "./actions-tester.js";
import { stubGhScript } from "./gh-stub.js";
import type { Tester, Verdict } from "./lander.js";

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

const FAILED_LOG = [
	"Full suite / Vitest (2/6)\tVitest\t2026-10-27T08:30:01.1234567Z \u001b[31m FAIL \u001b[39m scripts/lib/a.test.ts > a > b",
	"Full suite / Vitest (2/6)\tVitest\t2026-10-27T08:30:01.2Z  FAIL  scripts/fixture-only.test.ts > printed by a test",
	"Full suite / Python\tPytest\t2026-10-27T08:30:02.0Z FAILED scripts/test_b.py::test_c - assert 1",
].join("\n");

/** Reads serving each listing in turn, the last one thereafter. */
const reads = (
	listings: (() => Run[])[],
	jobs: Job[] = shards("success", "success"),
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
		jobsOf: () => jobs,
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
) =>
	actionsTester({ root: "/", reads: r, fallback, ...clock() }).verdict(
		SHA,
		files,
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

it("reads a successful run at the sha as green", async () => {
	expect(await verdictOf(reads([() => [run(1, "success")]]))).toEqual({
		kind: "green",
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
	["skipped", shards("success", "skipped")],
	["missing", shards("success", "success").slice(0, 1)],
	["absent altogether", [{ name: "Lint and types", conclusion: "success" }]],
])(
	"reads a successful run whose shard jobs are %s as unknown, never green",
	async (_, jobs) => {
		const v = await verdictOf(reads([() => [run(1, "success")]], jobs));
		expect(v).toMatchObject({ kind: "unknown" });
	},
);

it("waits out an unfinished run and returns its verdict", async () => {
	const r = reads([() => [], () => [run(1, null)], () => [run(1, "success")]]);
	expect(await verdictOf(r)).toEqual({ kind: "green" });
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
	expect(await verdictOf(r, undefined, [])).toEqual({ kind: "green" });
	expect(r.reran).toEqual([5]);
});

it("reads a passed run again for a whole-suite rerun, starting no attempt", async () => {
	const r = reads([() => [run(6, "success")]]);
	expect(await verdictOf(r, undefined, [])).toEqual({ kind: "green" });
	expect(r.reran).toEqual([]);
});

it("hands a rerun of named files to the fallback without reading a run", async () => {
	const { tester, asked } = recording({ kind: "red", files: ["x.test.ts"] });
	const r = reads([() => [run(1, "success")]]);
	const v = await actionsTester({
		root: "/",
		fallback: tester,
		reads: r,
		...clock(),
	}).verdict(SHA, ["x.test.ts"]);
	expect(v).toEqual({ kind: "red", files: ["x.test.ts"] });
	expect(asked).toEqual([[SHA, ["x.test.ts"]]]);
	expect(r.calls()).toBe(0);
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
	});
});
