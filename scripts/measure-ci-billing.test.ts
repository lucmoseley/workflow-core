// @vitest-environment node
/*
 * The CLI's argument validation, its cache-eligibility rule, how it fetches a
 * window a day at a time, and how it ties push runs to this checkout's
 * history. Each exists because of a way this tool could print a confident
 * wrong number: a malformed date makes every projected figure NaN, caching a
 * response whose runs had not finished freezes a partial census as if it were
 * the final one, and a run counted twice inflates the bill (mantahostels#386,
 * which hardened this tool against confident wrong numbers, mantahostels#686,
 * which found the first version of that cache guard unreachable, and
 * mantahostels#676, which split the fetch into days).
 *
 * Built end to end (#1369, §G6: nothing is exported only for its tests): the
 * program runs through lib/run-in-process.js's `runInProcessAsync` against a
 * stub `gh` injected at WFC_GH, which serves each day's runs and each run's
 * jobs from files a case writes and logs every path it was asked for. What a
 * case reads is what a user would: the `--json` envelope, the human lines, the
 * cache directory and the stub's call log. Errors are read off stdout and
 * stderr together and only as non-zero, because in-process a throw out of
 * `main` reaches lib/check.js's crash reporter rather than the script's own
 * `.catch`.
 *
 * What the tool does with what it fetches is covered by ci-billing.test.ts,
 * against the pure seam.
 *
 * CI's vitest step runs this file; the tool itself gates nothing and is run by
 * hand, as `.github/workflows/scheduled-checks.yml`'s cadence notes direct.
 * Loosen a case and the CI bill a cadence ruling is priced from can print as
 * NaN or as a partial census served from cache as final.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHostConfig } from "./lib/config-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "measure-ci-billing.js");

withHostConfig({ tracker: "owner/repo" });

/*
 * `gh api <path> --cache 0 --paginate --slurp`: $2 is the path. A runs listing
 * is answered from runs-<day>.json, a jobs listing from jobs-<run id>.json, and
 * anything not written answers as a day that ran nothing or a run with no jobs.
 * Shell builtins only, so a run making a hundred jobs calls pays one `sh` each.
 */
const stubScript = (stubDir: string) => `#!/bin/sh
p="$2"
printf '%s\\n' "$p" >> "${stubDir}/calls.log"
case "$p" in
*/jobs\\?*)
  id=\${p#*/runs/}; id=\${id%%/jobs*}
  f="${stubDir}/jobs-$id.json"
  if [ -f "$f" ]; then cat "$f"; else echo '[{"jobs":[]}]'; fi
  ;;
*)
  day=\${p#*created=}; day=\${day%%..*}
  f="${stubDir}/runs-$day.json"
  if [ -f "$f" ]; then cat "$f"; else echo '[{"total_count":0,"workflow_runs":[]}]'; fi
  ;;
esac
`;

let dir = "";
let gh = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-ci-billing-"));
	gh = stubGhScript(dir, stubScript(dir)).gh;
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const cacheDir = () => path.join(dir, "cache");

/* GIT_* stripped so a hook's GIT_DIR cannot point the program's `git log` at
 * the repo running the suite rather than the case's own directory. */
const run = (...argv: string[]) =>
	runInProcessAsync(SCRIPT, [...argv, "--cache", cacheDir()], {
		cwd: dir,
		env: {
			...Object.fromEntries(
				Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
			),
			WFC_GH: gh,
		},
	});

/** The `--json` envelope; a clamp note may precede it. */
const envelope = (stdout: string) =>
	JSON.parse(stdout.slice(stdout.indexOf("{")));

const json = async (...argv: string[]) => {
	const r = await run(...argv, "--json");
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return envelope(r.stdout);
};

/** Every path the stub was asked for, in order. */
const calls = () => {
	const log = path.join(dir, "calls.log");
	return fs.existsSync(log)
		? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
		: [];
};
const runsCalls = () => calls().filter((c) => !c.includes("/jobs?"));
const jobsCallIds = () =>
	calls()
		.filter((c) => c.includes("/jobs?"))
		.map((c) => c.replace(/.*\/runs\/([^/]+)\/jobs.*/, "$1"));
const calledDays = () =>
	runsCalls().map((c) => c.replace(/.*created=([0-9-]+)\.\..*/, "$1"));

const runOf = (id: string, day: string, extra: object = {}) => ({
	id,
	event: "push",
	status: "completed",
	name: "ci",
	created_at: `${day}T10:00:00Z`,
	head_sha: `sha-${id}`,
	...extra,
});

/** Serve one day's runs listing: page objects, or raw text as gh printed it. */
const serveDay = (day: string, pages: unknown[] | string) =>
	fs.writeFileSync(
		path.join(dir, `runs-${day}.json`),
		typeof pages === "string" ? pages : JSON.stringify(pages),
	);
const serveJobs = (runId: string, pages: unknown[]) =>
	fs.writeFileSync(path.join(dir, `jobs-${runId}.json`), JSON.stringify(pages));

/*
 * Pages the way the real listing does: `per_page=100`, so a busy day arrives
 * as several page objects and `total_count` rides on each. `count` is how many
 * runs the day really returns; `total` is what GitHub claims exists, so
 * `total` above `count` is a day capped at 1,000, and null is a response that
 * carried no count.
 */
const serveCount = (
	day: string,
	count: number,
	{ total, event }: { total?: number | null; event?: string } = {},
) => {
	const t = total === undefined ? count : total;
	const counted = t === null ? {} : { total_count: t };
	const runs = Array.from({ length: count }, (_, i) =>
		runOf(`${day}-${i}`, day, event ? { event } : {}),
	);
	const pages = [];
	for (let i = 0; i < runs.length; i += 100)
		pages.push({ ...counted, workflow_runs: runs.slice(i, i + 100) });
	serveDay(day, pages.length > 0 ? pages : [{ ...counted, workflow_runs: [] }]);
};

const cacheEntries = () =>
	fs.existsSync(cacheDir()) ? fs.readdirSync(cacheDir()) : [];
const runsEntries = () => cacheEntries().filter((f) => !f.includes("_jobs_"));
const jobsEntries = () => cacheEntries().filter((f) => f.includes("_jobs_"));

const refuses = async (argv: string[], message: RegExp | string) => {
	const r = await run(...argv);
	expect(r.status).not.toBe(0);
	expect(r.stdout + r.stderr).toMatch(message);
	expect(calls()).toEqual([]);
};

const args = (...extra: string[]) => [
	"--since",
	"2026-08-12",
	"--until",
	"2026-08-13",
	...extra,
];

describe("the command line", () => {
	it("takes a well-formed window", async () => {
		const a = (await json(...args())).args;
		expect(a.since).toBe("2026-08-12");
		expect(a.until).toBe("2026-08-13");
		expect(a.branch).toBe("all");
		expect(a.attempts).toBe("latest");
		expect(calledDays()).toEqual(["2026-08-12", "2026-08-13"]);
	});

	it("requires both ends of the window", async () => {
		await refuses(["--since", "2026-08-01"], /--until/);
		await refuses(["--until", "2026-08-13"], /--since/);
	});

	it("rejects an unpadded date, naming the YYYY-MM-DD form, before any API call, rather than projecting from NaN", async () => {
		await refuses(
			["--since", "2026-8-1", "--until", "2026-08-13"],
			/YYYY-MM-DD/,
		);
	});

	it("rejects a date that is not a real day before making any API call", async () => {
		await refuses(
			["--since", "2026-13-45", "--until", "2026-08-13"],
			/not a real date/,
		);
	});

	it("rejects a reversed window before making any API call", async () => {
		await refuses(
			["--since", "2026-08-13", "--until", "2026-08-01"],
			/is after/,
		);
	});

	it("accepts a single-day window", async () => {
		const out = await json("--since", "2026-08-13", "--until", "2026-08-13");
		expect(out.args.since).toBe("2026-08-13");
		expect(calledDays()).toEqual(["2026-08-13"]);
	});

	it("rejects an --attempts value the jobs API does not have, naming the two it does, before any API call", async () => {
		await refuses(args("--attempts", "newest"), /latest\|all/);
		expect((await json(...args("--attempts", "all"))).args.attempts).toBe(
			"all",
		);
	});

	it("asks the jobs API for the attempts it was given", async () => {
		serveCount("2026-08-13", 1);
		await json(...args("--attempts", "all"));
		expect(calls().find((c) => c.includes("/jobs?"))).toContain("filter=all");
	});

	it("rejects a non-numeric or negative cache age before making any API call", async () => {
		await refuses(args("--max-cache-age", "forever"), /non-negative/);
		await refuses(args("--max-cache-age", "-1"), /non-negative/);
	});

	it("converts the cache age to milliseconds", async () => {
		expect(
			(await json(...args("--max-cache-age", "2"))).args.maxCacheAgeMs,
		).toBe(2 * 86_400_000);
		expect((await json(...args())).args.maxCacheAgeMs).toBe(7 * 86_400_000);
	});

	it("takes the boolean flags without consuming the next argument", async () => {
		const a = (await json(...args("--refresh"))).args;
		expect(a.refresh).toBe(true);
		expect(a.json).toBe(true);
		expect(a.until).toBe("2026-08-13");
	});

	it("takes --branch main, narrowing off the all-branch default", async () => {
		expect((await json(...args("--branch", "main"))).args.branch).toBe("main");
	});

	it("collects a repeated --exclude-event, and excludes nothing by default", async () => {
		expect((await json(...args())).args.excludeEvents).toEqual([]);
		expect(
			(
				await json(
					...args(
						"--exclude-event",
						"pull_request",
						"--exclude-event",
						"schedule",
					),
				)
			).args.excludeEvents,
		).toEqual(["pull_request", "schedule"]);
	});

	it("takes a value joined by =", async () => {
		expect((await json(...args("--branch=all"))).args.branch).toBe("all");
		expect(
			(await json(...args("--exclude-event=pull_request"))).args.excludeEvents,
		).toEqual(["pull_request"]);
	});

	it("refuses to swallow the following flag as a value, naming the flag that needs one, before any API call", async () => {
		await refuses(args("--branch", "--json"), "--branch needs a value");
		await refuses(args("--cache"), "--cache needs a value");
		await refuses(args("--exclude-event"), /needs a value/);
		/* The = form arrives with an empty value rather than no value. */
		await refuses(args("--exclude-event="), /event name/);
	});

	it("takes --no-git without consuming the next argument", async () => {
		const a = (await json(...args("--no-git"))).args;
		expect(a.git).toBe(false);
		expect(a.json).toBe(true);
		expect((await json(...args())).args.git).toBe(true);
	});
});

describe("fetching the window", () => {
	const window = ["--since", "2026-08-14", "--until", "2026-08-16", "--no-git"];

	it("asks for one day at a time rather than the whole window", async () => {
		await json(...window);
		const asked = runsCalls();
		expect(asked).toHaveLength(3);
		expect(asked[0]).toContain("created=2026-08-14..2026-08-14");
		expect(asked[1]).toContain("created=2026-08-15..2026-08-15");
		expect(asked[2]).toContain("created=2026-08-16..2026-08-16");
	});

	it("concatenates the days into one run set, oldest day first", async () => {
		serveCount("2026-08-14", 2);
		serveCount("2026-08-15", 1);
		serveCount("2026-08-16", 3);
		const out = await json(...window);
		expect(out.summary.runs).toBe(6);
		/* The jobs calls follow the run set's own order. */
		expect(jobsCallIds()).toEqual([
			"2026-08-14-0",
			"2026-08-14-1",
			"2026-08-15-0",
			"2026-08-16-0",
			"2026-08-16-1",
			"2026-08-16-2",
		]);
		expect(out.totalCount).toBe(6);
	});

	it("keeps every page of a day that needed more than one", async () => {
		serveCount("2026-08-14", 131);
		const out = await json(...window);
		expect(out.summary.runs).toBe(131);
		expect(jobsCallIds().at(-1)).toBe("2026-08-14-130");
		expect(out.totalCount).toBe(131);
	});

	it("reports nothing truncated when every day arrived whole", async () => {
		/* Excluded from the census so the case pays for no jobs calls; truncation
		 * is judged on the fetch, before any exclusion. */
		serveCount("2026-08-14", 250, { event: "schedule" });
		const out = await json(...window, "--exclude-event", "schedule");
		expect(out.truncated).toBe(false);
		expect(out.truncatedDays).toEqual([]);
		expect(out.totalCount).toBe(250);
	});

	it("catches a day one run short, not just one wildly short", async () => {
		serveCount("2026-08-14", 120, { total: 121, event: "schedule" });
		const out = await json(...window, "--exclude-event", "schedule");
		expect(out.truncatedDays).toEqual(["2026-08-14"]);
	});

	it("names the day that hit the cap, not the window", async () => {
		serveCount("2026-08-14", 2, { event: "schedule" });
		serveCount("2026-08-15", 1000, { total: 1400, event: "schedule" });
		serveCount("2026-08-16", 3, { event: "schedule" });
		const r = await run(...window, "--exclude-event", "schedule");
		expect(r.status).toBe(0);
		const line = r.stdout.split("\n").find((l) => l.includes("TRUNCATED"));
		expect(line).toContain("returned 1005 of 1405 runs");
		expect(line).toMatch(/cap on 2026-08-15[;,]/);
	});

	it("counts a run returned on two days once, and says it happened", async () => {
		serveDay("2026-08-14", [
			{ total_count: 1, workflow_runs: [runOf("a", "2026-08-14")] },
		]);
		serveDay("2026-08-15", [
			{ total_count: 1, workflow_runs: [runOf("a", "2026-08-14")] },
		]);
		serveDay("2026-08-16", [
			{ total_count: 1, workflow_runs: [runOf("b", "2026-08-16")] },
		]);
		const out = await json(...window);
		expect(jobsCallIds()).toEqual(["a", "b"]);
		expect(out.summary.runs).toBe(2);
		expect(out.duplicates).toBe(1);
	});

	it("leaves the total null when no response carried one", async () => {
		serveDay("2026-08-14", [{ workflow_runs: [runOf("a", "2026-08-14")] }]);
		serveDay("2026-08-15", [{ workflow_runs: [] }]);
		serveDay("2026-08-16", [{ workflow_runs: [] }]);
		const out = await json(...window);
		expect(out.totalCount).toBeNull();
		expect(out.truncated).toBe(false);
	});

	it("leaves the total null when only SOME days carried one", async () => {
		/* Summing the days that answered and comparing it against runs from all
		 * of them reads as a truncation that did not happen, or covers for one
		 * that did. */
		serveCount("2026-08-14", 200, { event: "schedule" });
		serveCount("2026-08-15", 100, { total: null, event: "schedule" });
		const r = await run(...window, "--exclude-event", "schedule", "--json");
		const out = envelope(r.stdout);
		expect(out.totalCount).toBeNull();
		expect(out.truncated).toBe(false);
	});

	it("scopes to one branch unless the scope is every branch", async () => {
		await json(...window, "--branch", "main");
		expect(runsCalls()[0]).toContain("branch=main&");
		fs.rmSync(path.join(dir, "calls.log"));
		await json(...window);
		expect(runsCalls()[0]).not.toContain("branch=");
	});
});

describe("the window that can be measured today", () => {
	/* Only Date is faked, so the program's own clock reads this noon too and no
	 * run straddles a UTC midnight; its timers and the stub gh run for real. */
	const noon = Date.parse("2026-09-10T12:00:00Z");
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(noon);
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	const isoDay = (offset: number) =>
		new Date(noon + offset * 86_400_000).toISOString().slice(0, 10);

	it("leaves a window that already closed alone", async () => {
		const r = await run(
			"--since",
			isoDay(-3),
			"--until",
			isoDay(-2),
			"--no-git",
		);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("clamped");
		expect(calledDays()).toEqual([isoDay(-3), isoDay(-2)]);
	});

	it("pulls a window running into today back to the last finished day", async () => {
		const r = await run(
			"--since",
			isoDay(-2),
			"--until",
			isoDay(5),
			"--no-git",
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`--until ${isoDay(5)} clamped to ${isoDay(-1)}`);
		expect(calledDays()).toEqual([isoDay(-2), isoDay(-1)]);
	});

	it("refuses a window the clamp empties rather than censusing nothing, naming the last day whose billing is final, before any API call", async () => {
		/* Asking for today alone: every day in it is still accruing minutes. */
		await refuses(
			["--since", isoDay(0), "--until", isoDay(0)],
			/last day whose billing is final/,
		);
	});
});

describe("pushes against this checkout's history", () => {
	const day = "2026-08-14";
	const git = (gitArgs: string[], date = "2020-01-01T00:00:00Z") =>
		execFileSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@example.com", ...gitArgs],
			{
				cwd: dir,
				encoding: "utf8",
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
					),
					GIT_AUTHOR_DATE: date,
					GIT_COMMITTER_DATE: date,
				},
			},
		).trim();
	/** A commit touching `file`, made at `date`; its sha. */
	const commit = (file: string, date: string) => {
		fs.writeFileSync(path.join(dir, file), date);
		git(["add", file], date);
		git(["commit", "-q", "-m", file], date);
		return git(["rev-parse", "HEAD"], date);
	};
	beforeEach(() => {
		git(["init", "-q"]);
		/* Outside every window below, so the log over the window starts empty. */
		git(["commit", "-q", "--allow-empty", "-m", "seed"]);
	});

	it("takes each push run's head commit, once, and no other event's", async () => {
		/* No commit falls inside the window, so every push head is missing from
		 * this checkout: the count is the distinct push heads. */
		serveDay(day, [
			{
				total_count: 4,
				workflow_runs: [
					runOf("1", day, { head_sha: "aaa" }),
					runOf("2", day, { head_sha: "aaa" }),
					runOf("3", day, { event: "schedule", head_sha: "sss" }),
					runOf("4", day, { head_sha: "bbb" }),
				],
			},
		]);
		const out = await json("--since", day, "--until", day);
		expect(out.gitError).toBeNull();
		expect(out.pushCommits.missingHeads).toBe(2);
	});

	it("skips a push run with no head commit rather than counting undefined", async () => {
		serveDay(day, [
			{
				total_count: 1,
				workflow_runs: [runOf("1", day, { head_sha: undefined })],
			},
		]);
		const out = await json("--since", day, "--until", day);
		expect(out.pushCommits.missingHeads).toBe(0);
	});

	it("folds the window's commits into the pushes whose heads they reach", async () => {
		const first = commit("a.md", `${day}T09:00:00Z`);
		commit("b.js", `${day}T10:00:00Z`);
		const third = commit("c.md", `${day}T11:00:00Z`);
		serveDay(day, [
			{
				total_count: 2,
				workflow_runs: [
					runOf("1", day, { head_sha: first }),
					runOf("2", day, { head_sha: third }),
				],
			},
		]);
		const out = await json("--since", day, "--until", day);
		/* The first push is cut by the window and dropped; the second carries the
		 * two commits after it, one of them code. */
		expect(out.pushCommits).toMatchObject({
			pushes: 1,
			commits: 2,
			truncatedFirstPush: 1,
			missingHeads: 0,
			unpushedCommits: 0,
			docsOnlyShare: 0,
		});
	});
});

describe("the response cache", () => {
	const day = "2026-08-14";
	const window = ["--since", day, "--until", day, "--no-git"];
	const completed = [{ total_count: 1, workflow_runs: [runOf("1", day)] }];
	const inFlight = [
		{
			total_count: 1,
			workflow_runs: [runOf("1", day, { status: "in_progress" })],
		},
	];

	describe("caches only a response whose every item has finished", () => {
		it("caches a runs response whose every run has completed", async () => {
			serveDay(day, completed);
			const out = await json(...window);
			expect(runsEntries()).toHaveLength(1);
			expect(out.inFlightSkipped).toBe(0);
		});

		it("refuses a runs response carrying one run still in progress, but still counts it", async () => {
			serveDay(day, inFlight);
			const out = await json(...window);
			expect(runsEntries()).toEqual([]);
			expect(out.inFlightSkipped).toBe(1);
			expect(out.summary.runs).toBe(1);
		});

		it("refuses a queued run on a later page, not just the first", async () => {
			serveDay(day, [
				{ total_count: 2, workflow_runs: [runOf("1", day)] },
				{
					total_count: 2,
					workflow_runs: [runOf("2", day, { status: "queued" })],
				},
			]);
			await json(...window);
			expect(runsEntries()).toEqual([]);
		});

		it("caches a jobs response whose every job has completed", async () => {
			serveDay(day, completed);
			serveJobs("1", [{ jobs: [{ status: "completed" }] }]);
			await json(...window);
			expect(jobsEntries()).toHaveLength(1);
		});

		it("refuses a jobs response carrying one job still queued", async () => {
			serveDay(day, completed);
			serveJobs("1", [
				{ jobs: [{ status: "completed" }, { status: "queued" }] },
			]);
			const out = await json(...window);
			expect(jobsEntries()).toEqual([]);
			expect(out.inFlightSkipped).toBe(1);
		});

		it("caches a day that ran nothing", async () => {
			await json(...window);
			expect(runsEntries()).toHaveLength(1);
		});

		it("refuses an error body, which says nothing about finality", async () => {
			serveDay(day, [{ message: "Not Found" }]);
			await json(...window);
			expect(runsEntries()).toEqual([]);
		});

		it("refuses a slurp that returned no pages at all", async () => {
			serveDay(day, "");
			await json(...window);
			expect(runsEntries()).toEqual([]);
		});
	});

	it("counts each uncached in-flight response, and warns of the floor", async () => {
		serveDay("2026-08-14", inFlight);
		serveDay("2026-08-15", [
			{
				total_count: 1,
				workflow_runs: [runOf("2", "2026-08-15", { status: "queued" })],
			},
		]);
		const r = await run(
			"--since",
			"2026-08-14",
			"--until",
			"2026-08-15",
			"--no-git",
		);
		expect(r.stdout).toContain(
			"2 response(s) covered runs that had not finished",
		);
	});

	it("serves a fresh cache entry without fetching again", async () => {
		serveDay(day, completed);
		const first = await json(...window);
		const fetched = calls().length;
		const second = await json(...window);
		expect(calls()).toHaveLength(fetched);
		expect(second.summary).toEqual(first.summary);
	});

	/** Overwrite the cached runs entry the first run wrote. */
	const corruptRunsEntry = (content: string) => {
		const [entry] = runsEntries();
		fs.writeFileSync(path.join(cacheDir(), entry), content);
	};

	it("refetches an entry left by an older build that cached a partial answer", async () => {
		serveDay(day, completed);
		await json(...window);
		corruptRunsEntry(JSON.stringify(inFlight));
		const out = await json(...window);
		expect(runsCalls()).toHaveLength(2);
		expect(out.inFlightSkipped).toBe(0);
	});

	it("refetches an entry whose pages are not page objects, rather than serving it", async () => {
		/* The cache file is read as written — gh's --slurp flattening never
		 * reaches it — so a null or an array where a page belongs is judged as
		 * it stands. */
		serveDay(day, completed);
		await json(...window);
		corruptRunsEntry("[null]");
		await json(...window);
		corruptRunsEntry(JSON.stringify([[{ status: "completed" }]]));
		await json(...window);
		expect(runsCalls()).toHaveLength(3);
	});

	it("never caches a fresh answer whose page is not a page object", async () => {
		/* The read side refetches on a throw as well, so only the write side
		 * shows the page-shape check: an array where a page belongs has no
		 * unfinished item, yet must not be judged final. */
		serveDay(day, [[{ status: "completed" }]]);
		const out = await json(...window);
		expect(out.inFlightSkipped).toBe(1);
		expect(runsEntries()).toEqual([]);
	});

	it("refetches past --max-cache-age rather than serving a stale entry", async () => {
		serveDay(day, completed);
		await json(...window);
		/* Age the entries rather than passing a negative max-cache-age, which the
		 * command line rejects outright. */
		const yesterday = Date.now() / 1000 - 86_400;
		for (const f of cacheEntries())
			fs.utimesSync(path.join(cacheDir(), f), yesterday, yesterday);
		await json(...window, "--max-cache-age", "0.04");
		expect(runsCalls()).toHaveLength(2);
	});

	it("--refresh bypasses the entry it then overwrites", async () => {
		serveDay(day, completed);
		await json(...window);
		const entries = cacheEntries();
		await json(...window, "--refresh");
		expect(runsCalls()).toHaveLength(2);
		expect(cacheEntries()).toEqual(entries);
	});
});
