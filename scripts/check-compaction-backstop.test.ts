// @vitest-environment node
/*
 * check-compaction-backstop.test.ts — the report the backstop is moved on
 * (#4410). Driven through the CLI over a stub `gh` and a throwaway git repo,
 * since a follow-up cites a unit by a commit sha `git log` must find. Broken,
 * the backstop is moved on wrong bins.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, stubGhRoutes } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "check-compaction-backstop.js");
const SPEC = 900;
const SPEC_URL = `https://api.github.com/repos/o/r/issues/${SPEC}`;

let dir: string;
let repo: string;
let sha101: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-backstop-"));
	repo = path.join(dir, "repo");
	fs.mkdirSync(repo);
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@t", ...args],
			{ cwd: repo, encoding: "utf8" },
		).trim();
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "Build the chunk (#101)");
	sha101 = git("rev-parse", "HEAD");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString();

const unit = (number: number, closedDaysAgo: number) => ({
	number,
	state: "closed",
	closed_at: daysAgo(closedDaysAgo),
	/* Filed with the spec's breakdown, before any sibling closed. */
	created_at: daysAgo(closedDaysAgo + 20),
	parent_issue_url: SPEC_URL,
	labels: [{ name: "kind:ticket" }],
});
const comment = (body: string) => ({ body });
const sub = (number: number, filedDaysAgo: number, body: string) => ({
	number,
	state: "open",
	created_at: daysAgo(filedDaysAgo),
	body,
});

const routesFor = (
	closed: object[],
	comments: Record<number, object[]>,
	subs: object[],
) => ({
	"repos/{owner}/{repo}/issues?state=closed*": page("issuesPage", closed),
	...Object.fromEntries(
		Object.entries(comments).map(([n, rows]) => [
			`repos/{owner}/{repo}/issues/${n}/comments*`,
			page("commentsPage", rows),
		]),
	),
	[`repos/{owner}/{repo}/issues/${SPEC}/sub_issues*`]: page(
		"subIssuesPage",
		subs,
	),
});
const cli = (routes: Parameters<typeof stubGhRoutes>[1], args: string[] = []) =>
	runInProcess(SCRIPT, args, {
		cwd: repo,
		env: { ...process.env, ...stubGhRoutes(dir, routes).env },
	});
/* The spec's sub-issues are its units as well as its follow-ups. */
const run = (
	closed: object[],
	comments: Record<number, object[]>,
	followUps: object[],
	args: string[] = [],
) => {
	const r = cli(routesFor(closed, comments, [...closed, ...followUps]), [
		"--json",
		...args,
	]);
	return { ...r, report: r.stdout ? JSON.parse(r.stdout) : null };
};
const bin = (report: { bins: { bin: string }[] }, label: string) =>
	report.bins.find((b) => b.bin === label);

describe("check-compaction-backstop.js", () => {
	/* #101's first session wrote 5 then 6 (two hand-offs) and a second
	 * session finished on 4 more, its close quoting the first's line; #102
	 * never compacted. */
	const closed = [unit(101, 10), unit(102, 8)];
	const comments = {
		101: [
			comment("Backstop.\n\n**Compactions:** 5 (session s1)\n"),
			comment("Backstop.\n\n- `**Compactions:** 6 (session s1)`\n"),
			comment(
				"Done; s1 left **Compactions:** 6 (session s1)\n\n**Compactions:** 4 (session s2)\n",
			),
		],
		102: [comment("Done.\n\n**Compactions:** 0\n")],
	};

	it("sums a unit built across two sessions into one count", () => {
		const { status, report } = run(closed, comments, []);
		expect(status).toBe(0);
		expect(bin(report, "7–10")).toMatchObject({ units: 1, followUps: 0 });
		expect(bin(report, "0")).toMatchObject({ units: 1, followUps: 0 });
		expect(bin(report, "11+")).toMatchObject({ units: 0, perUnit: null });
	});

	it("gives a follow-up citing one unit to it alone, by number or by a commit citing it", () => {
		const { report } = run(closed, comments, [
			sub(103, 5, "A gap #101 left."),
			sub(104, 5, `Regressed in ${sha101.slice(0, 9)}.`),
		]);
		expect(bin(report, "7–10")).toMatchObject({ followUps: 2, perUnit: 2 });
		expect(bin(report, "0")).toMatchObject({ followUps: 0 });
	});

	it("splits a follow-up citing none evenly across the units closed before it", () => {
		const { report } = run(closed, comments, [
			sub(105, 5, "Something the spec missed."),
			sub(106, 9, "Filed before #102 closed."),
		]);
		expect(bin(report, "7–10")).toMatchObject({ followUps: 1.5 });
		expect(bin(report, "0")).toMatchObject({ followUps: 0.5 });
	});

	it("splits a follow-up with a unit closed before the window, whose share is binned nowhere", () => {
		const old = unit(110, 40);
		const r = cli(
			routesFor(closed, comments, [
				...closed,
				old,
				sub(111, 2, "Something the spec missed."),
			]),
			["--json"],
		);
		const report = JSON.parse(r.stdout);
		expect(bin(report, "7–10")).toMatchObject({ followUps: 1 / 3 });
		expect(bin(report, "0")).toMatchObject({ followUps: 1 / 3 });
	});

	it("counts a unit with no **Compactions:** line apart, never binned", () => {
		const { report } = run(
			[unit(101, 10), unit(107, 3)],
			{ 101: comments[101], 107: [comment("Closed by hand.")] },
			[sub(108, 1, "Fixes #107.")],
		);
		expect(report.unlogged).toBe(1);
		expect(
			report.bins.reduce((s: number, b: { units: number }) => s + b.units, 0),
		).toBe(1);
		expect(bin(report, "7–10")).toMatchObject({ followUps: 0 });
	});

	it("leaves out a ticket closed before the window", () => {
		const { report } = run(
			[unit(101, 40)],
			{ 101: comments[101] },
			[],
			["--days", "30"],
		);
		expect(bin(report, "7–10")).toMatchObject({ units: 0 });
	});

	it("prints the bins as a report, exit 0", () => {
		const r = cli(routesFor(closed, comments, closed));
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("(the backstop is 10)");
		expect(r.stderr).toContain("7–10    1 unit(s), 0 follow-up(s), 0 per unit");
		expect(r.stderr).toContain("11+     0 unit(s), 0 follow-up(s), — per unit");
		expect(r.stderr).toContain("0 unit(s) carry no **Compactions:** line");
	});

	it("skips where the tracker will not answer, saying so", () => {
		const r = cli({});
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/SKIP.*the tracker would not answer/);
	});
});
