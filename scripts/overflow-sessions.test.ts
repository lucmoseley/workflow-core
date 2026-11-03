// @vitest-environment node
/*
 * overflow-sessions.js end to end (#3696): which ids on stdin the launch record
 * marks overflow, whichever checkout's ledger recorded them.
 *
 * `HOME` is a temp dir per test, so no live ledger is read. Break this and
 * scan_burn.py books a key's spend as plan burn with no error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeOverflowCheckout } from "./lib/overflow-launch-fake";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "overflow-sessions.js");
const OVERFLOW = "aaaaaaaa-0000-4000-8000-000000000000";
const PLAN = "bbbbbbbb-0000-4000-8000-000000000000";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-sessions-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (env: Record<string, string>) =>
	runInProcess(SCRIPT, [], {
		stdin: `${PLAN}\n${OVERFLOW}\n`,
		env: { ...process.env, ...env },
	});

describe("overflow-sessions.js", () => {
	it("prints only the ids another checkout's launch record marks overflow", () => {
		writeOverflowCheckout(home, "launcher", [OVERFLOW]);
		const r = run({ HOME: home });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(`${OVERFLOW}\n`);
	});

	it("prints nothing with no overflow launch recorded", () => {
		const r = run({ HOME: home });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("exits 1 with why where the checkouts cannot be listed", () => {
		const r = run({ HOME: path.join(home, "absent") });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(path.join(home, "absent"));
		expect(r.stderr).toContain("fix that read and re-run");
	});
});
