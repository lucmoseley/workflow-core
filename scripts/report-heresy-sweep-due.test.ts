// @vitest-environment node
/*
 * report-heresy-sweep-due.test.ts — the monthly heresy sweep's filer (#3464,
 * spec #3365). Break it and a sweep is filed early or never, a second due
 * issue piles up beside an open one, two session starts both file, or a
 * tracker failure fails a session start.
 *
 * Driven end to end through `runInProcess` (§X3) against a throwaway git repo
 * per case, the clock pinned through WFC_NOW (§X9). `gh` is a fake reached
 * through WFC_GH, `stubGhRoutes` serving each case its due issues and logging
 * its argv, and the body writer one reached through WFC_ISSUE_BODY.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import { initGitRepo } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-heresy-sweep-due.js");
/* The issue title and the stamp and lock names the script uses, restated so a
 * rename fails here rather than passing unseen. */
const TITLE = "Heresy sweep due";
const STAMP = ".heresy-sweep-read";
const LOCK = ".heresy-sweep-read.lock";
const NOW = "2026-10-29T06:00:00Z";
const DAY = 24 * 3_600_000;

interface Issue {
	number: number;
	title: string;
	labels: never[];
	closedAt: string | null;
	createdAt: string;
}

const closedSweep = (closedAt: string): Issue => ({
	number: 100,
	title: TITLE,
	labels: [],
	closedAt,
	createdAt: "2026-09-01T00:00:00Z",
});
const openSweep = (createdAt: string): Issue => ({
	number: 5,
	title: TITLE,
	labels: [],
	closedAt: null,
	createdAt,
});

let base: string;
let root: string;
let config: string;
let argvLog: string;
let bodyLog: string;
let bodyScript: string;

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "heresy-sweep-"));
	root = path.join(base, "repo");
	const hooks = path.join(base, "hooks");
	fs.mkdirSync(hooks);
	initGitRepo(root, hooks);
	config = path.join(base, "config");
	argvLog = path.join(base, "gh-argv.log");
	bodyLog = path.join(base, "issue-body-argv.log");
	bodyScript = path.join(base, "issue-body.js");
	fs.writeFileSync(
		bodyScript,
		`require("node:fs").appendFileSync(${JSON.stringify(bodyLog)}, process.argv.slice(2).join(" ") + "\\n");`,
	);
});
afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

const tracker = (
	{ closed = [], open = [] }: { closed?: Issue[]; open?: Issue[] } = {},
	failing = false,
) =>
	stubGhRoutes(
		base,
		{
			"issue list --state closed*": printed(JSON.stringify(closed)),
			"issue list --state open*": printed(JSON.stringify(open)),
			"issue view*": printed("an older body"),
			"issue create*": printed("https://github.com/o/r/issues/999"),
		},
		{ log: argvLog, failing },
	).gh;

function run(args: string[], gh = tracker(), at = NOW) {
	const out = runInProcess(SCRIPT, args, {
		cwd: root,
		env: {
			...process.env,
			WFC_GH: gh,
			WFC_ISSUE_BODY: bodyScript,
			CLAUDE_PROJECT_DIR: root,
			CLAUDE_CONFIG_DIR: config,
			WFC_CLAUDE_CONFIG_A: config,
			WFC_CLAUDE_CONFIG_B: config,
			WFC_CLAUDE_CONFIG_C: config,
			WFC_NOW: at,
		},
	});
	return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

const read = (f: string) =>
	fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
const ghCalls = () => read(argvLog);
/** Each `gh issue create` call whole, its multi-line body included. */
const readCreates = () =>
	ghCalls()
		.split(/\n(?=issue (?:list|view|create|edit) )/)
		.filter((l) => l.startsWith("issue create"));

describe("the daily filing run", () => {
	it("files the due issue where none was ever filed, pointing at the heresy-sweep skill", () => {
		const { code, stdout } = run([]);
		expect(code).toBe(0);
		expect(stdout).toContain(
			"Last sweep: none; no *Heresy sweep due* issue was ever filed. Filed https://github.com/o/r/issues/999",
		);
		const creates = readCreates();
		expect(creates).toHaveLength(1);
		expect(creates[0]).toContain(`--title ${TITLE}`);
		expect(creates[0]).toContain("--label takes:implement");
		expect(creates[0]).toContain("run the `heresy-sweep` skill");
	});

	it("files nothing under 30 days after the last sweep's close", () => {
		const closedAt = new Date(Date.parse(NOW) - 30 * DAY + 60_000);
		const gh = tracker({ closed: [closedSweep(closedAt.toISOString())] });

		const { code, stdout } = run([], gh);
		expect(code).toBe(0);
		expect(stdout).toContain(
			"Last sweep: #100, closed 2026-09-29; under 30 days since 2026-09-29: nothing filed.",
		);
		expect(readCreates()).toEqual([]);
	});

	it("files 30 days after the last sweep's close, with that sweep in the body", () => {
		const closedAt = new Date(Date.parse(NOW) - 30 * DAY);
		const gh = tracker({ closed: [closedSweep(closedAt.toISOString())] });

		const { stdout } = run([], gh);
		expect(stdout).toContain("30 days have passed since 2026-09-29.");
		expect(stdout).toContain("Filed https://github.com/o/r/issues/999");
		expect(readCreates()[0]).toContain("Last sweep: #100, closed 2026-09-29.");
	});

	it("refreshes the open due issue's body and files nothing new", () => {
		const gh = tracker({
			closed: [closedSweep("2026-09-01T00:00:00Z")],
			open: [openSweep("2026-10-01T00:00:00Z")],
		});

		const { code, stdout } = run([], gh);
		expect(code).toBe(0);
		expect(stdout).toContain("Refreshed #5.");
		expect(readCreates()).toEqual([]);
		expect(read(bodyLog)).toMatch(/^replace 5 --file /);
	});

	it("counts from the open one's creation where none has closed", () => {
		const gh = tracker({ open: [openSweep("2026-10-10T00:00:00Z")] });

		const { stdout } = run([], gh);
		expect(stdout).toContain(
			"Last sweep: none closed; #5 open since 2026-10-10; under 30 days since 2026-10-10: nothing filed.",
		);
		expect(read(bodyLog)).toBe("");
	});

	it("reads at most once a day", () => {
		const gh = tracker();
		run([], gh);
		expect(fs.existsSync(path.join(root, ".git", STAMP))).toBe(true);
		const calls = ghCalls();

		const again = run(
			[],
			gh,
			new Date(Date.parse(NOW) + DAY - 60_000).toISOString(),
		);
		expect(again.stdout).toContain("under a day ago; nothing read");
		expect(ghCalls()).toBe(calls);
	});

	it("reads nothing while another run holds a live lock", () => {
		fs.writeFileSync(path.join(root, ".git", LOCK), "1");

		const { code, stdout } = run([]);
		expect(code).toBe(0);
		expect(stdout).toContain("Another run is reading; nothing read.");
		expect(ghCalls()).toBe("");
	});

	it("fails open on a gh failure: one line in the error log, exit 0", () => {
		const { code, stderr } = run([], tracker({}, true));
		expect(code).toBe(0);
		expect(stderr).toContain("FAILED OPEN: ");
		expect(stderr).toContain("gh auth login");
		expect(stderr).toContain("the next day's reading retries");
		expect(readGuardErrorsLog(config)).toContain("report-heresy-sweep-due");
		expect(readCreates()).toEqual([]);
	});
});

describe("--dry-run", () => {
	it("prints the last sweep, the next due date and why, and writes nothing", () => {
		const gh = tracker({ closed: [closedSweep("2026-10-15T12:00:00Z")] });

		const { code, stdout } = run(["--dry-run"], gh);
		expect(code).toBe(0);
		expect(stdout).toBe(
			[
				"Last sweep: #100, closed 2026-10-15",
				"Next due: 2026-11-14",
				"Why: under 30 days since 2026-10-15",
				"Not due: a filing run would file nothing.",
				"Dry run: nothing filed.",
				"",
			].join("\n"),
		);
		expect(ghCalls()).not.toMatch(/issue (?:create|edit)/);
		expect(read(bodyLog)).toBe("");
		expect(fs.existsSync(path.join(root, ".git", STAMP))).toBe(false);
	});

	it("says a filing run would file where none was ever filed", () => {
		const { stdout } = run(["--dry-run"]);
		expect(stdout).toContain("Next due: now");
		expect(stdout).toContain(
			"Due: a filing run would file or refresh the due issue.",
		);
		expect(readCreates()).toEqual([]);
	});

	it("is BROKEN, exit 2, naming gh's reason, on a gh failure", () => {
		const { code, stderr } = run(["--dry-run"], tracker({}, true));
		expect(code).toBe(2);
		expect(stderr).toContain("BROKEN: ");
		expect(stderr).toContain("gh auth login");
	});
});
