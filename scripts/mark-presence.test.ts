// @vitest-environment node
/*
 * mark-presence.js records the founder's typed prompts for the refill loop
 * (#2004) — driven through hook stdin, the way the harness runs it at
 * UserPromptSubmit.
 *
 * WHAT BREAKING IT COSTS: a dispatched launch counted as his typing keeps a
 * slot idle for 30 minutes after every launch; a typed prompt missed lets the
 * loop take the slot he would have used.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const HOOK = path.join(__dirname, "mark-presence.js");

let dir: string;
let marker: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-presence-"));
	marker = path.join(dir, "founder-presence");
	config({ tracker: "o/here" });
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function config(c: object) {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify(c),
	);
}

/**
 * A background job whose launch prompt was `intent`; returns its dir.
 */
function buildJob(intent: string) {
	const jobDir = path.join(dir, "job");
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "state.json"),
		JSON.stringify({ state: "working", template: "bg", intent }),
	);
	return jobDir;
}

function run(
	prompt: string,
	opts: { jobDir?: string; entrypoint?: string; agentId?: string } = {},
) {
	const r = runInProcess(HOOK, [], {
		stdin: JSON.stringify({
			session_id: "test-session",
			hook_event_name: "UserPromptSubmit",
			prompt,
			...(opts.agentId ? { agent_id: opts.agentId } : {}),
		}),
		cwd: dir,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			WFC_REPO_ROOT: dir,
			WFC_PRESENCE_MARKER: marker,
			CLAUDE_JOB_DIR: opts.jobDir,
			CLAUDE_CODE_ENTRYPOINT: opts.entrypoint ?? "cli",
		},
	});
	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
}

const isMarked = () => fs.existsSync(marker);

describe("a prompt the founder typed", () => {
	it("writes the time in an interactive session", () => {
		const before = Date.now();
		run("what is left on #2004?");
		const at = Date.parse(fs.readFileSync(marker, "utf8").trim());
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(Date.now());
	});

	it("writes it in a background job, past its launch prompt", () => {
		run("go with (A)", { jobDir: buildJob("/implement 2004") });
		expect(isMarked()).toBe(true);
	});

	it("writes it where the job's record is unreadable", () => {
		run("go with (A)", { jobDir: path.join(dir, "no-such-job") });
		expect(isMarked()).toBe(true);
	});
});

describe("a prompt nobody typed", () => {
	it("writes nothing for a dispatched job's launch prompt", () => {
		run("/implement 2004", { jobDir: buildJob("/implement 2004") });
		expect(isMarked()).toBe(false);
	});

	it("writes nothing for a print-mode run inside a job", () => {
		run("Run this command", {
			jobDir: buildJob("/implement 2004"),
			entrypoint: "sdk-cli",
		});
		expect(isMarked()).toBe(false);
	});

	it.each([
		[
			"a subagent's hand-back",
			'<agent-message from="a772b04c">\n[Subagent hand-back] done',
		],
		["a task notification", "<task-notification>\n<task-id>b1</task-id>"],
		["a mod's delivery", "Delivered by the wfc-delivery mod: a report"],
	])("writes nothing for %s", (_, prompt) => {
		run(prompt);
		expect(isMarked()).toBe(false);
	});

	it("writes nothing for a subagent's payload", () => {
		run("Search the tracker", { agentId: "a1" });
		expect(isMarked()).toBe(false);
	});

	it("leaves an earlier time in place", () => {
		fs.writeFileSync(marker, "2026-10-18T08:00:00.000Z\n");
		run("/implement 2004", { jobDir: buildJob("/implement 2004") });
		expect(fs.readFileSync(marker, "utf8")).toBe("2026-10-18T08:00:00.000Z\n");
	});
});

it("stands down where the host disables it", () => {
	config({ tracker: "o/here", disabled: ["mark-presence.js"] });
	run("what is left on #2004?");
	expect(isMarked()).toBe(false);
});
