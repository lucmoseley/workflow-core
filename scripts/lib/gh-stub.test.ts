// @vitest-environment node
/*
 * stubGhRoutes, the route-table gh stub the issue-reader suites share
 * (#3168). Loosen a case and those suites can pass on a call routed to the
 * wrong answer: a field-filtered read served the unfiltered page, a call no
 * route names answered by accident, or a batched blockers read that skips
 * the REST fallback its reader takes on a null issue. It spawns the
 * generated stub, as a suite's WFC_GH call does, and drives the real
 * blocked-by-batch.js reader, so a routing fault shows as the reader sees it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GH_LOGGED_OUT, GH_NOT_FOUND } from "./gh-fake";
import { page, printed, stubGhRoutes } from "./gh-stub";

const { blockedByMany } = createRequire(__filename)("./blocked-by-batch.js");

let dir: string;
const log = () => path.join(dir, "calls.log");
const calls = () => fs.readFileSync(log(), "utf8").trim().split("\n");

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-routes-test-"));
});
afterEach(() => {
	delete process.env.WFC_GH;
	fs.rmSync(dir, { recursive: true, force: true });
});

const call = (gh: string, ...args: string[]) =>
	spawnSync(gh, args, { encoding: "utf8" });

it("routes an api call on its path and fields as a query string, the first matching key winning", () => {
	const { gh } = stubGhRoutes(
		dir,
		{
			"*/issues?state=closed*": GH_NOT_FOUND,
			"*/issues?*": page("issuesPage", [{ number: 4 }]),
			"*/issues": page("issuesPage", [{ number: 5 }]),
		},
		{ log: log() },
	);
	const closed = call(gh, "api", "x/issues", "-X", "GET", "-f", "state=closed");
	expect(closed.status).toBe(GH_NOT_FOUND.status);
	expect(closed.stderr).toBe(GH_NOT_FOUND.stderr);
	const open = call(
		gh,
		"api",
		"x/issues",
		"-X",
		"GET",
		"-f",
		"state=open",
		"--slurp",
	);
	expect(JSON.parse(open.stdout)).toEqual([[{ number: 4 }]]);
	expect(JSON.parse(call(gh, "api", "x/issues", "--slurp").stdout)).toEqual([
		[{ number: 5 }],
	]);
	expect(calls()).toEqual([
		"api x/issues -X GET -f state=closed",
		"api x/issues -X GET -f state=open --slurp",
		"api x/issues --slurp",
	]);
});

it("keys a field call sent without -X GET as the POST gh makes of it", () => {
	const { gh } = stubGhRoutes(dir, {
		"x/issues?*": page("issuesPage", []),
		"POST x/issues?title=t": printed("{}"),
	});
	expect(call(gh, "api", "x/issues", "-f", "title=t").stdout).toBe("{}");
});

it("routes any other call on its whole argv, and wraps a slurped object", () => {
	const { gh } = stubGhRoutes(dir, {
		"issue view 7 *": {
			kind: "issue",
			value: { number: 7, state: "open" },
			slurp: true,
		},
	});
	const r = call(gh, "issue", "view", "7", "--json", "state");
	expect(JSON.parse(r.stdout)).toEqual([{ number: 7, state: "open" }]);
});

it("fails a call no key matches, naming it", () => {
	const { gh } = stubGhRoutes(dir, { "x/issues": GH_LOGGED_OUT });
	const r = call(gh, "api", "x/pulls");
	expect(r.status).toBe(1);
	expect(r.stderr).toBe("gh route stub: no route for: api x/pulls\n");
});

it("refuses a body holding a key gh's recorded answer lacks", () => {
	expect(() =>
		stubGhRoutes(dir, { "*": page("blockedByPage", [{ nope: 1 }]) }),
	).toThrow("gh never sends blockedByPage[][].nope");
});

it("answers the batched blockers read from each issue's exact blocked_by route, null sending the rest to REST", async () => {
	const at = (n: number) =>
		`repos/{owner}/{repo}/issues/${n}/dependencies/blocked_by`;
	process.env.WFC_GH = stubGhRoutes(
		dir,
		{
			[at(5)]: page("blockedByPage", [{ number: 9, state: "open" }]),
			[at(6)]: GH_NOT_FOUND,
			"*": GH_NOT_FOUND,
		},
		{ log: log() },
	).gh;
	const reads = await blockedByMany(
		[{ number: 5 }, { number: 6 }, { number: 7 }],
		{ repo: "{owner}/{repo}", home: null },
	);
	expect(reads.map((r: { read: { ok: boolean } }) => r.read.ok)).toEqual([
		true,
		false,
		false,
	]);
	expect(reads[0].read.edges.map((e: { number: number }) => e.number)).toEqual([
		9,
	]);
	const rest = calls().filter((c) => !c.startsWith("api graphql"));
	expect(rest.some((c) => c.includes("/issues/5/"))).toBe(false);
	expect(rest.some((c) => c.includes("/issues/6/"))).toBe(true);
	expect(rest.some((c) => c.includes("/issues/7/"))).toBe(true);
});

it("serves a graphql key in place of the derived blockers read", () => {
	const { gh } = stubGhRoutes(dir, { graphql: GH_LOGGED_OUT });
	const r = call(gh, "api", "graphql", "-f", "query=q");
	expect(r.status).toBe(GH_LOGGED_OUT.status);
	expect(r.stderr).toBe(GH_LOGGED_OUT.stderr);
});
