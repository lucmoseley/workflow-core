// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callCost } from "./lib/call-cost-harness.js";

const RECORDER = path.resolve(__dirname, "record-divergence.js");

let scratch: string;

beforeEach(() => {
	scratch = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "divergence-load-")),
	);
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

const recorderCall = (output: string, command: string) => {
	const r = callCost(RECORDER, [], {
		stdin: JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
			tool_response: { stdout: output, stderr: "" },
			cwd: scratch,
		}),
		cwd: scratch,
		env: {
			PATH: process.env.PATH,
			HOME: scratch,
			CLAUDE_CONFIG_DIR: path.join(scratch, "config"),
			CLAUDE_PROJECT_DIR: scratch,
		},
	});
	expect(r.stdout).toBe("");
	return r;
};

describe("record-divergence.js's per-call cost (#2899)", () => {
	it("loads only its entry, input and core modules and starts nothing on a call that refused nothing", () => {
		const r = recorderCall("On branch main\nnothing to commit", "git status");
		expect(r.modules).toEqual([
			"lib/caught.js",
			"lib/divergence-row-host.js",
			"lib/divergence-row.js",
			"lib/entry-input.js",
			"lib/read-fd.js",
			"lib/sleep-sync.js",
			"lib/write-fd.js",
			"record-divergence.js",
		]);
		expect(r.children).toEqual([]);
	});

	it("loads the command walk once a refusal reaches it", () => {
		expect(
			recorderCall("fatal: Not possible to fast-forward, aborting.", "git pull")
				.modules,
		).toContain("lib/shell-parse.js");
	});
});
