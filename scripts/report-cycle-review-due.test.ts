// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "report-cycle-review-due.js");
const TITLE = "90-day cycle review due";

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

function cycle(n: number, start: string, end: string, status: string) {
	return [
		`## Cycle ${n} — ${start} → ${end}`,
		"",
		`**Status:** ${status}`,
		"",
		"**Traction goal:** ship the thing",
		"",
	].join("\n");
}

function fixture(opts: {
	log: string;
	ghIssueList: unknown;
	existingBody?: string;
	logPath?: string;
}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-log-"));
	temps.push(root);

	const logFile = path.join(root, opts.logPath ?? "docs/cycle-log.md");
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.writeFileSync(logFile, opts.log);
	if (opts.logPath) {
		fs.mkdirSync(path.join(root, ".claude"));
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ cycleLogPath: opts.logPath }),
		);
	}

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

	return { root, ghStub, argvLog, issueBody };
}

function run(
	fx: ReturnType<typeof fixture>,
	today: string,
	args: string[] = [],
) {
	const r = runInProcess(SCRIPT, args, {
		cwd: fx.root,
		env: {
			...process.env,
			WFC_GH: fx.ghStub,
			WFC_ISSUE_BODY: fx.issueBody.script,
			CYCLE_TODAY: today,
			CLAUDE_PROJECT_DIR: fx.root,
		},
	});
	return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

const ghCalls = (fx: ReturnType<typeof fixture>): string =>
	fs.existsSync(fx.argvLog) ? fs.readFileSync(fx.argvLog, "utf8") : "";

describe("the scheduled 90-day cycle trigger", () => {
	it("files nothing, and touches gh not at all, while the cycle is still running", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [],
		});

		const { code, output } = run(fx, "2026-09-15");
		expect(code).toBe(0);
		expect(output).toContain("runs to 2026-10-30");
		expect(ghCalls(fx)).toBe("");
	});

	it("stays silent on the cycle's final day", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [],
		});

		expect(ghCalls(fx)).toBe("");
		expect(run(fx, "2026-10-30").code).toBe(0);
		expect(ghCalls(fx)).toBe("");
	});

	it("files the review issue once the end date has passed", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [],
		});

		const { code, output } = run(fx, "2026-10-31");
		expect(code).toBe(0);
		const calls = ghCalls(fx);
		expect(calls).toContain("issue create");
		expect(calls).toContain(TITLE);
		expect(calls).toContain("Cycle 3 ended 2026-10-30");
		expect(output).toContain("issues/999");
	});

	it("labels the issue it files takes:wayfinder (lucmoseley/mantahostels#470)", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [],
		});

		run(fx, "2026-10-31");
		expect(ghCalls(fx)).toContain("takes:wayfinder");
	});

	it("skips by name, filing nothing, on a log that declares no cycle yet (#395)", () => {
		const fx = fixture({
			log: "# Cycle log\n\nNothing declared yet.\n",
			ghIssueList: [],
		});

		const { code, output } = run(fx, "2026-10-31");
		expect(code).toBe(0);
		expect(output).toContain("SKIP: docs/cycle-log.md declares no cycle yet");
		expect(output).not.toContain("No cycle declared");
		expect(ghCalls(fx)).toBe("");
	});

	it("files when every declared cycle is closed, rather than staying silent (lucmoseley/mantahostels#1034)", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "closed"),
			ghIssueList: [],
		});

		run(fx, "2026-09-15");
		expect(ghCalls(fx)).toContain("No 90-day cycle is declared");
	});

	it("names both when two cycles are marked open", () => {
		const fx = fixture({
			log: `${cycle(4, "2026-11-01", "2027-01-30", "open")}\n${cycle(3, "2026-08-01", "2026-10-30", "open")}`,
			ghIssueList: [],
		});

		const { output } = run(fx, "2026-09-15");
		expect(output).toContain("ambiguous");
		const calls = ghCalls(fx);
		expect(calls).toContain("Cycle 4");
		expect(calls).toContain("Cycle 3");
	});

	it("does not re-file while a tracking issue is already open", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [{ number: 42, title: TITLE }],
		});

		const { code, output } = run(fx, "2026-10-31");
		expect(code).toBe(0);
		expect(ghCalls(fx)).not.toContain("issue create");
		expect(output).toContain("#42");
	});

	it("refreshes the open issue's body through issue-body.js", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [{ number: 42, title: TITLE }],
			existingBody: "a body from an earlier sweep",
		});

		run(fx, "2026-10-31");
		expect(fx.issueBody.calls()).toEqual([
			expect.stringContaining("replace 42"),
		]);
	});

	it("leaves the body alone when it already says the right thing", () => {
		const fx = fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [{ number: 42, title: TITLE }],
			existingBody: "a body from an earlier sweep",
		});
		run(fx, "2026-10-31");
		fx.issueBody.clearCalls();

		const { output } = run(fx, "2026-10-31");
		expect(fx.issueBody.calls()).toEqual([]);
		expect(output).toContain("current");
	});

	it("raises rather than filing when a cycle carries no status line", () => {
		const fx = fixture({
			log: "## Cycle 3 — 2026-08-01 → 2026-10-30\n\n**Traction goal:** ship it\n",
			ghIssueList: [],
		});

		const { code, output } = run(fx, "2026-10-31");
		expect(code).not.toBe(0);
		expect(output).toContain("**Status:**");
		expect(ghCalls(fx)).toBe("");
	});

	it("raises on a cycle heading it cannot read, and makes no gh call", () => {
		const fx = fixture({
			log: "## Cycle 3 -- 2026-08-01 to 2026-10-30\n\n**Status:** open\n",
			ghIssueList: [],
		});

		const { code, output } = run(fx, "2026-10-31");
		expect(code).not.toBe(0);
		expect(output).toContain("not a readable cycle heading");
		expect(ghCalls(fx)).toBe("");
	});

	it("reads the log at the host's declared cycleLogPath (#438)", () => {
		const fx = fixture({
			log: cycle(1, "2026-09-01", "2026-11-29", "open"),
			ghIssueList: [],
			logPath: "docs/machinery/cycle-log.md",
		});

		const { code, output } = run(fx, "2026-09-26");
		expect(code).toBe(0);
		expect(output).not.toContain("SKIP");
		expect(output).toContain("Cycle 1 runs to 2026-11-29");
		expect(ghCalls(fx)).toBe("");
	});

	it("names the declared cycleLogPath when the log there is missing (#438)", () => {
		const fx = fixture({
			log: "",
			ghIssueList: [],
			logPath: "docs/machinery/cycle-log.md",
		});
		fs.rmSync(path.join(fx.root, "docs", "machinery", "cycle-log.md"));

		const { code, output } = run(fx, "2026-10-31");
		expect(code).toBe(0);
		expect(output).toContain(
			"SKIP: no cycle log at docs/machinery/cycle-log.md yet",
		);
		expect(ghCalls(fx)).toBe("");
	});

	it("skips by name, filing nothing, when there is no log at all", () => {
		const fx = fixture({ log: "", ghIssueList: [] });
		fs.rmSync(path.join(fx.root, "docs", "cycle-log.md"));

		const { code, output } = run(fx, "2026-10-31");
		expect(code).toBe(0);
		expect(output).toContain("SKIP: no cycle log at docs/cycle-log.md yet");
		expect(ghCalls(fx)).toBe("");
	});
});

describe("the command line", () => {
	const overdue = () =>
		fixture({
			log: cycle(3, "2026-08-01", "2026-10-30", "open"),
			ghIssueList: [],
		});

	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const fx = overdue();

			const { code, output } = run(fx, "2026-11-15", [flag]);
			expect(code).toBe(0);
			expect(output).toContain(
				"usage: node scripts/report-cycle-review-due.js",
			);
			expect(ghCalls(fx)).toBe("");
		}
	});

	it("refuses an unknown argument, naming it and the usage, exits non-zero, and calls gh not at all", () => {
		const fx = overdue();

		const { code, output } = run(fx, "2026-11-15", ["--dry-run"]);
		expect(code).toBe(2);
		expect(output).toContain("unknown flag: --dry-run");
		expect(output).toContain("usage: node scripts/report-cycle-review-due.js");
		expect(ghCalls(fx)).toBe("");
	});
});
