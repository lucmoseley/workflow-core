// @vitest-environment node
/*
 * report-retro-due.test.ts — the weekly retro trigger (#969). Break it and the
 * sweep files a due issue every day, or never, or files in an adopter.
 *
 * Driven end to end through `runInProcess` (§X3; #1055, over #969's
 * subprocess ask) against a throwaway root, with `gh` and the issue-body
 * writer stubbed as files the script spawns. The root is throwaway so each
 * case writes the exact run record and config the due date turns on; the
 * stubs log their argv, so a case reads what would have reached the tracker
 * and no case files a real issue.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";
import { takesRefusal } from "./lib/takes-label";

const SCRIPT = path.join(__dirname, "report-retro-due.js");
const { TITLE, LABEL } = require("./report-retro-due.js");
const TODAY = "2026-10-20";

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

const line = (mode: string, date: string) => JSON.stringify({ date, mode });

function fixture(opts: {
	/** The `retro` value; undefined writes no `retro` key at all. */
	retro?: unknown;
	/** The run record's text; null writes no record file. */
	record?: string | null;
	ghIssueList?: unknown;
	/** The issue's body before the run; absent, an empty one. */
	existingBody?: string;
	ghRefuses?: boolean;
}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "retro-due-"));
	temps.push(root);

	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "F",
			...(opts.retro === undefined ? {} : { retro: opts.retro }),
		}),
	);
	if (opts.record !== null) {
		fs.mkdirSync(path.join(root, "docs", "data"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "docs", "data", "retro-runs.jsonl"),
			opts.record ?? "",
		);
	}

	// The sanctioned body writer (mantahostels#131), faked so the refresh path is
	// observable without a network call.
	const issueBody = fakeIssueBody(root, opts.existingBody);
	fs.writeFileSync(
		path.join(root, "issues.json"),
		JSON.stringify(opts.ghIssueList ?? []),
	);

	const argvLog = path.join(root, "gh-argv.log");
	const ghStub = path.join(root, "gh");
	fs.writeFileSync(
		ghStub,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
			`  cat ${JSON.stringify(path.join(root, "issues.json"))}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
			`  cat ${JSON.stringify(issueBody.bodyFile)}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
			opts.ghRefuses
				? "  echo 'HTTP 403: Resource not accessible' >&2; exit 1"
				: "  echo https://github.com/o/r/issues/999",
			"fi",
			"exit 0",
		].join("\n"),
	);
	fs.chmodSync(ghStub, 0o755);

	return { root, ghStub, argvLog, issueBody };
}

function run(
	fx: ReturnType<typeof fixture>,
	today = TODAY,
	args: string[] = [],
) {
	const r = runInProcess(SCRIPT, args, {
		cwd: fx.root,
		env: {
			...process.env,
			WFC_GH: fx.ghStub,
			WFC_ISSUE_BODY: fx.issueBody.script,
			RETRO_TODAY: today,
			CLAUDE_PROJECT_DIR: fx.root,
		},
	});
	return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

const ghCalls = (fx: ReturnType<typeof fixture>): string =>
	fs.existsSync(fx.argvLog) ? fs.readFileSync(fx.argvLog, "utf8") : "";

describe("the weekly retro trigger", () => {
	it("files the due issue, labelled takes:implement, where no weekly run is recorded", () => {
		const fx = fixture({ retro: { weeklyCount: 3 } });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		const calls = ghCalls(fx);
		expect(calls).toContain("issue create");
		expect(calls).toContain(TITLE);
		expect(calls).toContain("--label takes:implement");
		expect(calls).toContain("retro-sweep");
		expect(calls).toContain("weekly");
		expect(calls).toContain("plain Opus");
		expect(output).toContain("issues/999");
	});

	it("files once the newest weekly run is 7 days old", () => {
		const fx = fixture({
			retro: { weeklyCount: 3 },
			record: `${line("weekly", "2026-10-06")}\n${line("weekly", "2026-10-13")}\n`,
		});

		expect(run(fx).code).toBe(0);
		expect(ghCalls(fx)).toContain("issue create");
	});

	it("files nothing, and touches gh not at all, within 7 days of the last weekly run", () => {
		const fx = fixture({
			retro: { weeklyCount: 3 },
			record: `${line("weekly", "2026-10-14")}\n`,
		});

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("2026-10-14, 6 day(s) before 2026-10-20");
		expect(ghCalls(fx)).toBe("");
	});

	it("does not count a calibrate-mode line as a weekly run", () => {
		const fx = fixture({
			retro: { weeklyCount: 3 },
			record: `${line("calibrate", "2026-10-19")}\n`,
		});

		expect(run(fx).code).toBe(0);
		const calls = ghCalls(fx);
		expect(calls).toContain("issue create");
		expect(calls).toContain("holds no `weekly` run yet");
	});

	it("refreshes the open due issue rather than filing a second", () => {
		const fx = fixture({
			retro: { weeklyCount: 3 },
			ghIssueList: [{ number: 42, title: TITLE, labels: [] }],
			existingBody: "a body from an earlier sweep",
		});

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(ghCalls(fx)).not.toContain("issue create");
		expect(output).toContain("#42");
		expect(fx.issueBody.calls()).toEqual([
			expect.stringContaining("replace 42"),
		]);
	});

	it("leaves an open due issue alone on a later sweep the same week", () => {
		const fx = fixture({
			retro: { weeklyCount: 3 },
			ghIssueList: [{ number: 42, title: TITLE, labels: [] }],
			existingBody: "a body from an earlier sweep",
		});
		run(fx);
		fx.issueBody.clearCalls();

		const { output } = run(fx, "2026-10-23");
		expect(output).toContain("#42 is open and current");
		expect(fx.issueBody.calls()).toEqual([]);
	});

	it("skips by name, filing nothing, where weeklyCount is unset", () => {
		const fx = fixture({ retro: {} });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("SKIP: retro.weeklyCount is unset");
		expect(ghCalls(fx)).toBe("");
	});

	// An adopter has no `retro` key, so this is the reporter in every adopter.
	it("skips by name, filing nothing and reading no record, where the config has no retro key", () => {
		const fx = fixture({ record: null });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain('SKIP: no "retro" key');
		expect(ghCalls(fx)).toBe("");
	});

	it("exits non-zero, filing nothing, when the run record is missing, naming it and offering git checkout as the way out", () => {
		const fx = fixture({ retro: { weeklyCount: 3 }, record: null });

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain("BROKEN: docs/data/retro-runs.jsonl is missing");
		expect(output).toContain("git checkout -- docs/data/retro-runs.jsonl");
		expect(ghCalls(fx)).toBe("");
	});

	// Read as "never run", a corrupt record would file on every run.
	it("exits non-zero, filing nothing, on a record line it cannot parse, naming its file and line", () => {
		const fx = fixture({
			retro: { weeklyCount: 3 },
			record: `${line("weekly", "2026-10-14")}\n{not json\n`,
		});

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain("retro-runs.jsonl:2 is not JSON");
		expect(ghCalls(fx)).toBe("");
	});

	it("exits 2 when gh refuses the create, naming the way out", () => {
		const fx = fixture({ retro: { weeklyCount: 3 }, ghRefuses: true });

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain(`BROKEN: could not file or refresh "${TITLE}"`);
		expect(output).toContain("403");
		expect(output).toContain("`issues: write`");
		expect(output).toContain("the next day's run retries");
		expect(output).not.toContain("## What to do");
	});

	// A typo must not read as "not yet calibrated", the SKIP that hides it.
	it("exits non-zero on a malformed weeklyCount, naming the file and key and filing nothing, rather than skipping", () => {
		const fx = fixture({ retro: { weeklyCount: "three" } });

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain(
			`BROKEN: ${path.join(fx.root, ".claude", "workflow-core.json")}: "retro.weeklyCount" is not a positive integer`,
		);
		expect(output).not.toContain("read as its default");
		expect(ghCalls(fx)).toBe("");
	});

	it("exits non-zero on a config that does not parse, naming the file and filing nothing", () => {
		const fx = fixture({ retro: { weeklyCount: 3 } });
		fs.writeFileSync(path.join(fx.root, ".claude", "workflow-core.json"), "{");

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain("workflow-core.json does not parse");
		expect(ghCalls(fx)).toBe("");
	});

	// No PreToolUse hook sees a script's gh call; the reporter's own check is
	// the create guard's takes: test, so what it files must pass it.
	it("files a takes: value and body the create guard's takes: test passes", () => {
		expect(LABEL).toBe("takes:implement");
		for (const record of [`${line("weekly", "2026-10-06")}\n`, ""]) {
			const fx = fixture({
				retro: { weeklyCount: 3 },
				record,
				ghIssueList: [{ number: 42, title: TITLE, labels: [] }],
			});
			run(fx);
			const filed = fx.issueBody.body();
			expect(filed).toContain("## A weekly retro is due");
			expect(takesRefusal([LABEL], filed)).toBeNull();
		}
	});
});

// A due week, so any fall-through to the default action would file (#1051).
describe("the command line", () => {
	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const fx = fixture({ retro: { weeklyCount: 3 } });

			const { code, output } = run(fx, TODAY, [flag]);
			expect(code).toBe(0);
			expect(output).toContain("usage: node scripts/report-retro-due.js");
			expect(ghCalls(fx)).toBe("");
		}
	});

	it("refuses an unknown argument, naming it and the usage, exits non-zero, and calls gh not at all", () => {
		const fx = fixture({ retro: { weeklyCount: 3 } });

		const { code, output } = run(fx, TODAY, ["--dry-run"]);
		expect(code).toBe(2);
		expect(output).toContain("unknown flag: --dry-run");
		expect(output).toContain("usage: node scripts/report-retro-due.js");
		expect(ghCalls(fx)).toBe("");
	});
});
