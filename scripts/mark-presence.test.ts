// @vitest-environment node
/*
 * mark-presence.js records the founder's typed prompts for the refill loop
 * (#2004) — driven through hook stdin, the way the harness runs it at
 * UserPromptSubmit.
 *
 * WHAT BREAKING IT COSTS: a dispatched launch counted as his typing keeps a
 * slot idle for 30 minutes after every launch; a typed prompt missed lets the
 * loop take the slot he would have used; a script's typed line counted as his
 * returns away mode to normal while he sleeps, and every session with a
 * question then waits on him in its seat (#4844).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_PROMPT, IDLE_PROMPT, scriptPrompt } from "./lib/loop-prompts.js";
import { ASK, SCRIPTED_PROMPT } from "./lib/recorder-prompts.js";
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
 * A background job whose launch prompt was `intent`, recorded with `template`
 * (`bg` a dispatcher's, `claude` the agents view's, null none); returns its
 * dir.
 */
function buildJob(intent: string, template: string | null = "bg") {
	const jobDir = path.join(dir, "job");
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "state.json"),
		JSON.stringify({
			state: "working",
			intent,
			...(template ? { template } : {}),
		}),
	);
	return jobDir;
}

function run(
	prompt: string,
	opts: {
		jobDir?: string;
		entrypoint?: string;
		agentId?: string;
		configDir?: string;
	} = {},
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
			CLAUDE_CONFIG_DIR: opts.configDir ?? path.join(dir, "seat"),
		},
	});
	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
}

const isMarked = () => fs.existsSync(marker);

describe("a prompt the founder typed", () => {
	it("writes the time and its session's seat in an interactive session", () => {
		const before = Date.now();
		run("what is left on #2004?", { configDir: `${dir}/seat2/` });
		const [time, seat] = fs.readFileSync(marker, "utf8").split("\n");
		const at = Date.parse(time);
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(Date.now());
		expect(seat).toBe(path.join(dir, "seat2"));
	});

	it("writes it in a background job, past its launch prompt", () => {
		run("go with (A)", { jobDir: buildJob("/implement 2004") });
		expect(isMarked()).toBe(true);
	});

	it("writes it for his launch prompt in a job the agents view launched (#3783)", () => {
		run("/implement 2004", {
			jobDir: buildJob("/implement 2004", "claude"),
			configDir: `${dir}/seat2/`,
		});
		expect(fs.readFileSync(marker, "utf8").split("\n")[1]).toBe(
			path.join(dir, "seat2"),
		);
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

	it("writes nothing for a launch prompt whose record names no template", () => {
		run("/implement 2004", { jobDir: buildJob("/implement 2004", null) });
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
		["the loop's API-error resume", API_PROMPT],
		["the loop's resumed-idle prompt", IDLE_PROMPT],
	])("writes nothing for %s (#3369)", (_, prompt) => {
		run(prompt);
		expect(isMarked()).toBe(false);
	});

	/* record-claude-responses.js's attach step: its question job, typed into
	 * through `claude attach` and pty_type.py. */
	it("writes nothing for the line record-claude-responses.js types into its question job (#4844)", () => {
		run(SCRIPTED_PROMPT, { jobDir: buildJob(ASK) });
		expect(isMarked()).toBe(false);
	});

	it("writes nothing for a script's prompt outside a job", () => {
		run(scriptPrompt("carry on"));
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
