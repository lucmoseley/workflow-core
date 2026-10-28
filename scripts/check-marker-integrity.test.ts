// @vitest-environment node
/*
 * Pins that check-marker-integrity.js counts the test-pass-marker store lines
 * that will not read back as a marker, at WARN, and never rewrites the store
 * (#182, #156 Q3).
 *
 * Drives the real script as a subprocess, `--root` pointed at a sandbox so a
 * real machine's own marker stores are never read (matches
 * check-stale-suite-queue.test.ts, this family's model).
 *
 * It speaks only through `npm run status`: loosen a case and a torn append
 * drops a full-run record in silence, or the check starts repairing a store
 * still being priced off its history.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-marker-integrity.js");
const { STORE, FAIL_STORE } = require("./lib/test-pass-marker.js");
const { markersDir } = require("./lib/marker-root.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-marker-integrity-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes raw lines to one of the two stores under `dir`'s marker root. */
function writeStore(store: string, lines: string[]) {
	const file = path.join(markersDir(dir), store);
	fs.writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
	return file;
}

const marker = (sha: string) =>
	JSON.stringify({ sha, at: new Date().toISOString() });

const run = (args: string[] = []) =>
	runInProcess(SCRIPT, ["--root", dir, ...args], {
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});

const report = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("what it reports", () => {
	it("says OK on two stores holding only readable markers", () => {
		writeStore(STORE, [marker("a"), marker("b")]);
		writeStore(FAIL_STORE, [marker("c")]);

		const r = run();
		expect(report(r)).toContain("OK:");
		expect(r.status).toBe(0);
	});

	it("says OK where neither store exists yet", () => {
		const r = run();
		expect(report(r)).toContain("OK:");
		expect(r.status).toBe(0);
	});

	it("counts a line that will not parse as JSON", () => {
		writeStore(STORE, [marker("a"), "not json"]);

		const out = report(run());
		expect(out).toContain("MARKER-TORN");
		expect(out).toContain(STORE);
		expect(out).toContain("1 of 2");
	});

	it("counts a NUL-prefixed torn line — a real record with garbage ahead of it (#182)", () => {
		const file = path.join(markersDir(dir), FAIL_STORE);
		fs.writeFileSync(file, `${marker("a")}\n${"\0".repeat(8)}${marker("b")}\n`);

		const out = report(run());
		expect(out).toContain("MARKER-TORN");
		expect(out).toContain(FAIL_STORE);
	});

	it("counts a parsed object carrying no `sha`", () => {
		writeStore(STORE, [JSON.stringify({ at: "now" })]);

		const out = report(run());
		expect(out).toContain("MARKER-TORN");
		expect(out).toContain("1 of 1");
	});

	it("ignores blank lines — they are not malformed, just absent", () => {
		writeStore(STORE, [marker("a"), "", marker("b")]);

		const out = report(run());
		expect(out).not.toContain("MARKER-TORN");
		expect(out).toContain("OK:");
	});

	it("reports each store separately when both are torn", () => {
		writeStore(STORE, [marker("a"), "garbage"]);
		writeStore(FAIL_STORE, [marker("b"), "garbage-too"]);

		const out = report(run());
		expect((out.match(/MARKER-TORN/g) ?? []).length).toBe(2);
	});

	it("is WARN, never FAIL — exit 0 even with malformed lines counted as MARKER-TORN", () => {
		writeStore(STORE, ["garbage"]);

		const r = run();
		expect(report(r)).toContain("MARKER-TORN");
		expect(r.status).toBe(0);
	});
});

describe("it never rewrites the store (#156 Q3 — no rotation, no repair)", () => {
	it("leaves a malformed line on disk byte-for-byte", () => {
		const file = writeStore(STORE, [marker("a"), "garbage"]);
		const before = fs.readFileSync(file, "utf8");

		run();

		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});
});

describe("--json", () => {
	it("carries the per-store malformed and total counts", () => {
		writeStore(STORE, [marker("a"), "garbage"]);
		writeStore(FAIL_STORE, [marker("b")]);

		const r = run(["--json"]);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.stores.green).toEqual({
			store: STORE,
			malformed: 1,
			total: 2,
		});
		expect(envelope.stores.red).toEqual({
			store: FAIL_STORE,
			malformed: 0,
			total: 1,
		});
		expect(envelope.totalMalformed).toBe(1);
	});
});
