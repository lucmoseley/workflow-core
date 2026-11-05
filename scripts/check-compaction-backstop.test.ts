// @vitest-environment node
/*
 * check-compaction-backstop.test.ts — the report the backstop is moved on
 * (#4410): closed build units binned by their **Compactions:** lines, against
 * the follow-ups their spec drew. Driven through the CLI over a stub `gh`.
 */
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
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-backstop-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString();

const unit = (number: number, closedDaysAgo: number, parent = SPEC_URL) => ({
	number,
	state: "closed",
	closed_at: daysAgo(closedDaysAgo),
	created_at: daysAgo(closedDaysAgo + 1),
	parent_issue_url: parent,
});
const comment = (body: string) => ({ body });
const sub = (number: number, filedDaysAgo: number, body: string) => ({
	number,
	state: "open",
	created_at: daysAgo(filedDaysAgo),
	body,
});

const run = (
	closed: object[],
	comments: Record<number, object[]>,
	subs: object[],
	args: string[] = [],
) => {
	const routes = {
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
	};
	const r = runInProcess(SCRIPT, ["--json", ...args], {
		env: { ...process.env, ...stubGhRoutes(dir, routes).env },
	});
	return { ...r, report: r.stdout ? JSON.parse(r.stdout) : null };
};
const bin = (report: { bins: { bin: string }[] }, label: string) =>
	report.bins.find((b) => b.bin === label);

describe("check-compaction-backstop.js", () => {
	/* #101 compacted 6 times, stopped at a hand-off, and a second session
	 * finished it on 4 more; #102 never compacted. */
	const closed = [unit(101, 10), unit(102, 8)];
	const comments = {
		101: [
			comment("Backstop.\n\n**Compactions:** 6\n"),
			comment("Done in `abc1234def`.\n\n**Compactions:** 4\n"),
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

	it("gives a follow-up citing one chunk to that chunk alone, by number or by its sha", () => {
		const { report } = run(closed, comments, [
			sub(103, 5, "A gap #101 left."),
			sub(104, 5, "Regressed in abc1234."),
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
		const routes = {
			"repos/{owner}/{repo}/issues?state=closed*": page("issuesPage", closed),
			"repos/{owner}/{repo}/issues/101/comments*": page(
				"commentsPage",
				comments[101],
			),
			"repos/{owner}/{repo}/issues/102/comments*": page(
				"commentsPage",
				comments[102],
			),
			[`repos/{owner}/{repo}/issues/${SPEC}/sub_issues*`]: page(
				"subIssuesPage",
				[],
			),
		};
		const r = runInProcess(SCRIPT, [], {
			env: { ...process.env, ...stubGhRoutes(dir, routes).env },
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("7–10    1 unit(s), 0 follow-up(s), 0 per unit");
		expect(r.stderr).toContain("11+     0 unit(s), 0 follow-up(s), — per unit");
	});

	it("skips where the tracker will not answer", () => {
		const r = runInProcess(SCRIPT, [], {
			env: { ...process.env, ...stubGhRoutes(dir, {}).env },
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP");
	});
});
