// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coreFile } from "./lib/core-path-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "report-manual-staleness.js");

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

function fixture(opts: {
	freshnessExit: number;
	ghIssueList: unknown;
	existingBody?: string;
}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "staleness-"));
	temps.push(root);

	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(root, "docs"));
	fs.writeFileSync(path.join(root, "docs", "operating-manual.md"), "stub\n");
	const freshnessStub = path.join(root, "scripts", "manual-freshness-stub.js");
	const report =
		"manual is 16 roadmap MINOR versions behind (v5.124 vs v5.140)";
	fs.writeFileSync(
		freshnessStub,
		[
			"module.exports = { SPEC: { name: 'manual-freshness', usage: 'stub', valueFlags: [], run(ctx) {",
			`  if (${opts.freshnessExit} === 1) { ctx.fail('FRESHNESS', ${JSON.stringify(report)}); ctx.say(${JSON.stringify(report)}); }`,
			`  if (${opts.freshnessExit} === 2) ctx.broken('stub is BROKEN');`,
			`  if (${opts.freshnessExit} === 3) { ctx.warn('CITED-PATH', ${JSON.stringify(report)}); ctx.say(${JSON.stringify(report)}); }`,
			"} } };",
		].join("\n"),
	);
	const issueBody = fakeIssueBody(root, opts.existingBody);

	const argvLog = path.join(root, "gh-argv.log");
	const ghStub = stubGhScript(
		root,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${shellQuote(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
			`  cat ${shellQuote(path.join(root, "issues.json"))}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
			`  cat ${shellQuote(issueBody.bodyFile)}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
			"  echo https://github.com/o/r/issues/999",
			"fi",
			"exit 0",
		].join("\n"),
	).gh;
	fs.writeFileSync(
		path.join(root, "issues.json"),
		JSON.stringify(opts.ghIssueList),
	);

	return { root, ghStub, argvLog, issueBody, freshnessStub };
}

function run(fx: ReturnType<typeof fixture>, args: string[] = []) {
	const r = runInProcess(SCRIPT, args, {
		cwd: fx.root,
		env: {
			...process.env,
			WFC_GH: fx.ghStub,
			WFC_MANUAL_FRESHNESS_MODULE: fx.freshnessStub,
			WFC_ISSUE_BODY: fx.issueBody.script,
		},
	});
	return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

const ghCalls = (fx: ReturnType<typeof fixture>): string =>
	fs.existsSync(fx.argvLog) ? fs.readFileSync(fx.argvLog, "utf8") : "";

const TITLE = "Operating manual is stale against the roadmap";

describe("the scheduled manual-staleness reporter", () => {
	it("skips by name, touching gh not at all, where no manual exists yet (#395)", () => {
		const fx = fixture({ freshnessExit: 1, ghIssueList: [] });
		fs.rmSync(path.join(fx.root, "docs", "operating-manual.md"));

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain(
			"SKIP: no operating manual at docs/operating-manual.md yet",
		);
		expect(ghCalls(fx)).toBe("");
	});

	it("files nothing, and touches gh not at all, when the manual is fresh", () => {
		const fx = fixture({ freshnessExit: 0, ghIssueList: [] });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("fresh");
		expect(ghCalls(fx)).toBe("");
	});

	it("files one issue when the manual is stale and none is open", () => {
		const fx = fixture({ freshnessExit: 1, ghIssueList: [] });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		const calls = ghCalls(fx);
		expect(calls).toContain("issue create");
		expect(calls).toContain(TITLE);
		expect(calls).toContain("manual-finding");
		expect(output).toContain("issues/999");
	});

	it("labels the issue it files with a takes: value", () => {
		const fx = fixture({ freshnessExit: 1, ghIssueList: [] });

		run(fx);
		expect(ghCalls(fx)).toContain("takes:");
	});

	it("carries the checker's own report into the issue body", () => {
		const fx = fixture({ freshnessExit: 1, ghIssueList: [] });

		run(fx);
		expect(ghCalls(fx)).toContain("16 roadmap MINOR versions behind");
	});

	it("does not re-file while a tracking issue is already open", () => {
		const fx = fixture({
			freshnessExit: 1,
			ghIssueList: [{ number: 42, title: TITLE }],
		});

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(ghCalls(fx)).not.toContain("issue create");
		expect(output).toContain("#42");
	});

	it("refreshes the open issue's body through issue-body.js", () => {
		const fx = fixture({
			freshnessExit: 1,
			ghIssueList: [{ number: 42, title: TITLE }],
			existingBody: "a body from an earlier day",
		});

		run(fx);
		expect(fx.issueBody.calls()).toEqual([
			expect.stringContaining("replace 42"),
		]);
	});

	it("leaves the body alone when it already says the right thing", () => {
		const fx = fixture({
			freshnessExit: 1,
			ghIssueList: [{ number: 42, title: TITLE }],
			existingBody: "a body from an earlier day",
		});
		run(fx);
		fx.issueBody.clearCalls();

		const { output } = run(fx);
		expect(fx.issueBody.calls()).toEqual([]);
		expect(output).toContain("current");
	});

	it("stays fresh, and files nothing, on a WARN with no FAIL (lucmoseley/mantahostels#2062)", () => {
		const fx = fixture({ freshnessExit: 3, ghIssueList: [] });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("fresh");
		expect(ghCalls(fx)).toBe("");
	});

	it("raises rather than filing when the checker is BROKEN", () => {
		const fx = fixture({ freshnessExit: 2, ghIssueList: [] });

		const { code, output } = run(fx);
		expect(code).not.toBe(0);
		expect(ghCalls(fx)).not.toContain("issue create");
		expect(output).toContain("could not run");
	});

	it("files anyway when the only open manual-finding is a different issue", () => {
		const fx = fixture({
			freshnessExit: 1,
			ghIssueList: [{ number: 7, title: "Something else entirely" }],
		});

		run(fx);
		expect(ghCalls(fx)).toContain("issue create");
	});

	it("exits 0 whether or not the manual is stale", () => {
		expect(run(fixture({ freshnessExit: 1, ghIssueList: [] })).code).toBe(0);
		expect(run(fixture({ freshnessExit: 0, ghIssueList: [] })).code).toBe(0);
	});

	it("warns in the body that a hand edit is silently overwritten", () => {
		const fx = fixture({
			freshnessExit: 1,
			ghIssueList: [{ number: 42, title: TITLE }],
			existingBody: "a body from an earlier day",
		});

		run(fx);
		const written = fx.issueBody.body();
		expect(written).toContain(
			"Edit it by hand and the next daily refresh silently overwrites it",
		);
		expect(written).toContain("manual-sync");
	});
});

describe("the command line", () => {
	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const fx = fixture({ freshnessExit: 1, ghIssueList: [] });

			const { code, output } = run(fx, [flag]);
			expect(code).toBe(0);
			expect(output).toContain(
				`usage: node ${coreFile("scripts/report-manual-staleness.js")}`,
			);
			expect(ghCalls(fx)).toBe("");
		}
	});

	it("refuses an unknown argument, naming it and the usage, exits non-zero, and calls gh not at all", () => {
		const fx = fixture({ freshnessExit: 1, ghIssueList: [] });

		const { code, output } = run(fx, ["--dry-run"]);
		expect(code).toBe(2);
		expect(output).toContain("unknown flag: --dry-run");
		expect(output).toContain(
			`usage: node ${coreFile("scripts/report-manual-staleness.js")}`,
		);
		expect(ghCalls(fx)).toBe("");
	});
});
