// @vitest-environment node
/*
 * report-manual-staleness.test.ts — the schedule-only staleness reporter
 * (mantahostels#389, the ticket that moved the manual-freshness gate onto a
 * schedule that files an issue). Break it and a stale manual files nothing,
 * or a fresh one files an issue every day.
 *
 * Driven end to end through `runInProcess` (§X3; #1194). Both of the script's
 * outside dependencies are stubbed: `gh` is a real script injected at WFC_GH
 * that records its own argv, and check-manual-freshness.js's
 * SPEC is a module `WFC_MANUAL_FRESHNESS_MODULE` names, since
 * report-manual-staleness.js's freshness() calls `SPEC.run(ctx)` in-process
 * now rather than spawning the checker as a CLI (mantahostels#2062).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-manual-staleness.js");

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

/**
 * A cwd carrying a stub freshness checker and a stub `gh` for WFC_GH.
 * `ghIssueList` is the JSON the stub answers `gh issue list` with.
 *
 * `freshnessExit` mirrors the checker's own exit alphabet: 0 OK, 1 FAIL
 * (stale), 2 BROKEN, 3 WARN (fresh, but with a real finding to report — the
 * shape a 5-9 MINOR band or a CITED-PATH miss actually takes). The stub calls
 * `ctx.say()` alongside `ctx.fail()`/`ctx.warn()`, as the real checker's
 * `fail()`/`warn()` helpers do (check-manual-freshness.js's `line()`), since
 * freshness() now reads its report off `say()`'s captured text (mantahostels#2062).
 */
function fixture(opts: {
	freshnessExit: number;
	ghIssueList: unknown;
	/** What `gh issue view --json body` answers with, for the refresh path;
	 * absent, an empty body. */
	existingBody?: string;
}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "staleness-"));
	temps.push(root);

	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	/* Present, so the reporter reaches the stub: with no manual it skips first. */
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
	// The sanctioned body writer (mantahostels#131), faked so the refresh path is
	// observable without a network call.
	const issueBody = fakeIssueBody(root, opts.existingBody);

	const argvLog = path.join(root, "gh-argv.log");
	const ghStub = stubGhScript(
		root,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
			`  cat ${JSON.stringify(path.join(root, "issues.json"))}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
			`  cat ${JSON.stringify(issueBody.bodyFile)}`,
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
	// An adopter's manual does not exist before its first sync (#395 Q1).
	it("skips by name, touching gh not at all, where no manual exists yet", () => {
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
		// This is the one script path known to file a bare issue: mantahostels#464 arrived with
		// `manual-finding` alone, so /pick-next could not say which command opens
		// it. scripts/guard-issue-create-label.js cannot see a create from inside a
		// workflow, so the label has to be here (mantahostels#470).
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

	// A body edit costs a write and a notification-free but real API call; when
	// nothing moved, the day's run should do neither.
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

	// Severity, not "any finding", is what drives staleness (mantahostels#2062): a mutant
	// collapsing the FAIL/WARN distinction into "findings exist" would file an
	// issue over a WARN-only (fresh) run.
	it("stays fresh, and files nothing, on a WARN with no FAIL", () => {
		const fx = fixture({ freshnessExit: 3, ghIssueList: [] });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("fresh");
		expect(ghCalls(fx)).toBe("");
	});

	/*
	 * check.js's exit alphabet: 1 is a FAIL finding, 2 is BROKEN — the checker
	 * could not do its job. Filing "the manual is stale" on a BROKEN run asserts
	 * the wrong fact, so it must raise instead of file.
	 */
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

	// The refresh is a whole-body replace that only refuses a write landing
	// during the call itself, so a reader who edits the body is silently
	// overwritten by the next run. The body has to say so.
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

// A stale manual, so any fall-through to the default action would file (#1051).
describe("the command line", () => {
	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const fx = fixture({ freshnessExit: 1, ghIssueList: [] });

			const { code, output } = run(fx, [flag]);
			expect(code).toBe(0);
			expect(output).toContain(
				"usage: node scripts/report-manual-staleness.js",
			);
			expect(ghCalls(fx)).toBe("");
		}
	});

	it("refuses an unknown argument, naming it and the usage, exits non-zero, and calls gh not at all", () => {
		const fx = fixture({ freshnessExit: 1, ghIssueList: [] });

		const { code, output } = run(fx, ["--dry-run"]);
		expect(code).toBe(2);
		expect(output).toContain("unknown flag: --dry-run");
		expect(output).toContain("usage: node scripts/report-manual-staleness.js");
		expect(ghCalls(fx)).toBe("");
	});
});
