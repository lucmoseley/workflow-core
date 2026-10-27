// @vitest-environment node
/*
 * Pins what record-divergence.js loads on a Bash call that refused nothing
 * (#2899). It runs on every `git` call, and each module past its own costs
 * that call start-up time, so a later top-level require would bring back what
 * #2899 cut.
 *
 * Program cases (base §X3), run through lib/run-in-process.js, which purges
 * repo modules only before a call: what is in require.cache after it is that
 * call's load set. A built-in (node:child_process) is loaded already in a
 * test process and is not seen here.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const RECORDER = path.resolve(__dirname, "record-divergence.js");
const cache = createRequire(import.meta.url).cache;

let scratch: string;

beforeEach(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "divergence-load-"));
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

/** The repo modules under scripts/ a recorder call left loaded, harness aside. */
const loadedAfter = (output: string, command: string) => {
	const r = runInProcess(RECORDER, [], {
		stdin: JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
			tool_response: { stdout: output, stderr: "" },
			cwd: scratch,
		}),
		cwd: scratch,
		env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(scratch, "config") },
	});
	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
	expect(r.stderr).toBe("");
	return Object.keys(cache)
		.filter(
			(k) =>
				k.startsWith(`${__dirname}${path.sep}`) &&
				!k.includes(`${path.sep}node_modules${path.sep}`) &&
				!k.endsWith("run-in-process.js"),
		)
		.map((k) => path.relative(__dirname, k))
		.sort();
};

describe("record-divergence.js's load set (#2899)", () => {
	it("loads only its entry, input and core modules on a call that refused nothing", () => {
		// The module set is an internal, asserted because no output shows the
		// start-up cost it guards (base §X6, #1497).
		expect(
			loadedAfter("On branch main\nnothing to commit", "git status"),
		).toEqual([
			"lib/divergence-row-host.js",
			"lib/divergence-row.js",
			"lib/entry-input.js",
			"record-divergence.js",
		]);
	});

	it("loads the command walk once a refusal reaches it", () => {
		expect(
			loadedAfter("fatal: Not possible to fast-forward, aborting.", "git pull"),
		).toContain("lib/shell-parse.js");
	});
});
