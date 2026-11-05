// @vitest-environment node
/*
 * selection-marker.js's own suite: the marker a /pick-next run mints so that
 * guard-selection-sum.js can check the sum a session states against what the
 * run measured (mantahostels#844, mantahostels#1321).
 *
 * Each case writes under a fresh temp root, and passes its environment to
 * recordFromEnv rather than reading this process's own.
 *
 * Loosen a case and the guard compares a stated sum against a guessed slot
 * count, or a run with no session id mints a marker no session can own.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { read, record, recordFromEnv } = require("./selection-marker.js");

let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-marker-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("record", () => {
	it("records no slot count where the machine could not be read, never a guess", () => {
		expect(record(root, { sessionId: "s1", frontier: 1, slots: null })).toBe(
			true,
		);
		expect(read(root, "s1")).toMatchObject({ frontier: 1, slots: null });
	});
});

describe("recordFromEnv", () => {
	it("mints nothing where the run has no session id to key on", () => {
		const run = { frontier: 1, slots: 2 };
		expect(recordFromEnv(root, run, { CLAUDE_CODE_SESSION_ID: "" })).toBe(
			false,
		);
		expect(fs.readdirSync(root)).toEqual([]);
		expect(recordFromEnv(root, run, { CLAUDE_CODE_SESSION_ID: "s1" })).toBe(
			true,
		);
		expect(read(root, "s1")).toMatchObject({ frontier: 1, slots: 2 });
	});
});
