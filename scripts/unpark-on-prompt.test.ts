// @vitest-environment node
/*
 * unpark-on-prompt.js takes `parked` off the issues this session parked when
 * the founder types in it (#2000) — driven through hook stdin, the way the
 * harness runs it at UserPromptSubmit.
 *
 * WHAT BREAKING IT COSTS: an answered ticket stays off the frontier until a
 * session happens to claim it; one firing on every prompt spends a GitHub
 * call per prompt.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const HOOK = path.join(__dirname, "unpark-on-prompt.js");

let dir: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "unpark-on-prompt-"));
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
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

const markerPath = () =>
	path.join(dir, ".claude", "tmp", "markers", `.parked-${sid}`);

function park(...numbers: number[]) {
	fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
	fs.writeFileSync(markerPath(), `${numbers.join("\n")}\n`);
}

/** Run the hook on one prompt; `failOn` names an issue whose edit fails. */
function run(failOn?: number) {
	const { gh } = stubGhScript(
		dir,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >>${dir}/calls`,
			failOn
				? `case "$*" in "issue edit ${failOn} "*) echo "HTTP 502" >&2; exit 1 ;; esac`
				: "",
		].join("\n"),
	);
	const r = runInProcess(HOOK, [], {
		stdin: JSON.stringify({
			session_id: sid,
			hook_event_name: "UserPromptSubmit",
			prompt: "go with (A)",
		}),
		cwd: dir,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			WFC_REPO_ROOT: dir,
			WFC_GH: gh,
		},
	});
	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
}

const calls = () => {
	const at = path.join(dir, "calls");
	return fs.existsSync(at)
		? fs.readFileSync(at, "utf8").split("\n").filter(Boolean)
		: [];
};

describe("a prompt in a session that parked its issue", () => {
	it("removes the label and deletes the marker", () => {
		park(31);
		run();
		expect(calls()).toEqual([
			"issue edit 31 --repo o/here --remove-label parked",
		]);
		expect(fs.existsSync(markerPath())).toBe(false);
	});

	it("keeps an issue whose removal failed, for the next prompt to retry", () => {
		park(31, 32);
		run(32);
		expect(calls()).toHaveLength(2);
		expect(fs.readFileSync(markerPath(), "utf8").trim()).toBe("32");
	});
});

describe("a prompt that unparks nothing", () => {
	it("makes no GitHub call in a session that parked nothing", () => {
		run();
		expect(calls()).toEqual([]);
	});

	it("stands down where the host disables it", () => {
		config({ tracker: "o/here", disabled: ["unpark-on-prompt.js"] });
		park(31);
		run();
		expect(calls()).toEqual([]);
		expect(fs.existsSync(markerPath())).toBe(true);
	});
});
