// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "report-stale-run-stamp.js");
const { TITLE } = require("./report-stale-run-stamp.js");
const DAY_MS = 86_400_000;

let dir: string;
const recordFile = () => path.join(dir, "refill", ".stale-run-record.jsonl");

const writeRow = (ageDays: number) => {
	fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
	const date = new Date(Date.now() - ageDays * DAY_MS).toISOString();
	fs.appendFileSync(recordFile(), `${JSON.stringify({ date })}\n`);
};

function stubs() {
	const issueBody = fakeIssueBody(dir, "");
	const argvLog = path.join(dir, "gh-argv.log");
	const ghStub = path.join(dir, "gh");
	fs.writeFileSync(
		ghStub,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${shellQuote(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then echo "[]";',
			'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
			"  echo https://github.com/o/r/issues/999",
			"fi",
			"exit 0",
		].join("\n"),
	);
	fs.chmodSync(ghStub, 0o755);
	const calls = () =>
		fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";
	return { ghStub, issueBody, calls };
}

function run(args: string[] = []) {
	const fx = stubs();
	const r = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: {
			...process.env,
			WFC_REPO_ROOT: dir,
			WFC_REFILL_DIR: path.join(dir, "refill"),
			WFC_GH: fx.ghStub,
			WFC_ISSUE_BODY: fx.issueBody.script,
		},
	});
	return { code: r.status, output: `${r.stdout}${r.stderr}`, calls: fx.calls };
}

beforeEach(() => {
	dir = mkScratchDir("stale-run-stamp-");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the stale-ticket run's stamp alarm", () => {
	it("files the alarm where no run is recorded", () => {
		const { code, output, calls } = run();
		expect(code).toBe(0);
		expect(output).toContain("no run is recorded in");
		expect(calls()).toContain("issue create");
		expect(calls()).toContain(TITLE);
		expect(calls()).toContain("takes:triage");
	});

	it("files the alarm where the newest row is over 2 days old", () => {
		writeRow(9);
		writeRow(3);
		const { code, output, calls } = run();
		expect(code).toBe(0);
		expect(output).toContain("is 3 days old");
		expect(calls()).toContain("issue create");
	});

	it("files nothing where the newest row is inside 2 days", () => {
		writeRow(9);
		writeRow(1);
		const { code, output, calls } = run();
		expect(code).toBe(0);
		expect(output).toContain("record is current");
		expect(calls()).not.toContain("issue create");
	});

	it("files nothing on a dry run", () => {
		const { code, output, calls } = run(["--dry-run"]);
		expect(code).toBe(0);
		expect(output).toContain("would file or refresh");
		expect(calls()).not.toContain("issue create");
	});
});
