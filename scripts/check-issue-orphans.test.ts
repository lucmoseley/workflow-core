// @vitest-environment node
/*
 * Pins that check-issue-orphans.js reports an issue whose body names the issue
 * it came out of but which was never linked as its sub-issue, and nothing
 * correctly standalone — including an issue whose body carries a `Standalone:`
 * line (#1615). No ticket found for the check itself: its first commit and its
 * subject's header cite only the fixture issues below.
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth,
 * and no dependence on this repo's own issue state — which is what the script
 * reports on and so cannot also be its fixture.
 *
 * The fixtures are the real cases. mantahostels#88 ("Split out of mantahostels#63", unlinked) is one of
 * the eight the 2 August 2026 sweep found; mantahostels#2 and mantahostels#80 are two of the four
 * correctly left standalone, and are here to hold the false-positive rate at
 * zero — a check that flagged them would be turned off.
 *
 * It runs daily in the repo-checks run as the backstop to place-new-issue.sh:
 * loosen a case and an unlinked issue sits outside every map, never offered by
 * /wayfinder's frontier and never scheduled.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catFixture, type StubGh, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-issue-orphans.js");

let dir: string;

interface Issue {
	number: number;
	body?: string;
	title?: string;
	parent_issue_url?: string | null;
	pull_request?: object;
}

/** Stub `gh` returning these issues as one --slurp page. */
const stubGh = (issues: Issue[], { failing = false } = {}) => {
	const fixture = path.join(dir, "issues.json");
	fs.writeFileSync(
		fixture,
		JSON.stringify([
			issues.map((i) => ({
				title: `t${i.number}`,
				body: "",
				parent_issue_url: null,
				html_url: `http://example/${i.number}`,
				...i,
			})),
		]),
	);
	return stubGhScript(dir, catFixture(fixture), { failing });
};

const run = (args: string[] = [], stub?: StubGh) => {
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, ...stub?.env },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphans-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("unplaced provenance", () => {
	it("flags an issue naming its origin with no parent", () => {
		const r = run([], stubGh([{ number: 88, body: "Split out of #63." }]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("UNPLACED");
		expect(r.out).toContain("#88");
		expect(r.out).toContain("claims #63");
	});

	it.each([
		["Part of #8.", 48],
		["Surfaced during #62, deliberately left alone.", 87],
		["Surfaced while implementing #63.", 90],
		["Found while implementing #63.", 91],
		["Parent map: #40.", 83],
	])("recognises %j", (body, number) => {
		expect(run([], stubGh([{ number, body }])).status).toBe(1);
	});

	it("stays silent once the link exists", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 88,
					body: "Split out of #63.",
					parent_issue_url: "https://api.github.com/repos/o/r/issues/63",
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("stays silent on issues that merely cite others", () => {
		const r = run(
			[],
			stubGh([
				{ number: 2, title: "id-match — Build the ID layer", body: "See #22." },
				{ number: 80, body: "Generalises #77. Cites #33 and #49 as symptoms." },
			]),
		);
		expect(r.status).toBe(0);
	});

	it("stays silent once the body records why it stands alone (#1615)", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 88,
					body: "Split out of #63.\n\nStandalone: a symptom of #63, owned by nobody.\n",
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("still flags a Standalone: mention that does not start a line", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 88,
					body: "Split out of #63. Not yet Standalone: undecided.",
				},
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("#88");
		expect(r.out).toContain("add a `Standalone: <why>` line");
	});

	it("ignores a self-reference", () => {
		expect(run([], stubGh([{ number: 63, body: "Part of #63." }])).status).toBe(
			0,
		);
	});

	it("ignores pull requests, which share the number space", () => {
		const r = run(
			[],
			stubGh([{ number: 99, body: "Part of #8.", pull_request: {} }]),
		);
		expect(r.status).toBe(0);
	});
});

describe("modes", () => {
	it("--warn reports without failing", () => {
		const r = run(
			["--warn"],
			stubGh([{ number: 88, body: "Split out of #63." }]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});

	it("--json emits the claims", () => {
		const r = run(
			["--json"],
			stubGh([{ number: 88, body: "Split out of #63." }]),
		);
		expect(r.status).toBe(1);
		expect(JSON.parse(r.out)).toMatchObject({
			unplacedCount: 1,
			unplaced: [{ number: 88, claims: [63] }],
		});
	});

	it("SKIPs rather than passing when gh is unavailable", () => {
		const r = run([], stubGh([], { failing: true }));
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("OK:");
	});
});
