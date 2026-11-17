// @vitest-environment node
/*
 * The pin helper's own tests (base §G13 (5), #5338): a pin built on it cannot
 * pass blind, so each spawn route, each lazy load and each broken call is
 * shown here to be seen.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callCost, callCostAsync, shellCallCost } from "./call-cost-harness.js";

const FIXTURES = path.resolve(__dirname, "fixtures");
const STARTS = path.join(FIXTURES, "call-cost-starts.js");
const LAZY = path.join(FIXTURES, "call-cost-lazy.js");
const SHELL = path.join(FIXTURES, "call-cost-starts.sh");
const WRAPPED = path.join(FIXTURES, "call-cost-wrapped.sh");
const UNGUARDED = path.join(FIXTURES, "in-process-unguarded-probe.js");

const STARTERS = [
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
	"fork",
] as const;

const starters = () =>
	STARTERS.map((route) => (childProcess as Record<string, unknown>)[route]);

const dirs: string[] = [];
const tmpdir = () => {
	const d = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "call-cost-")),
	);
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

describe("callCostAsync's children", () => {
	it("records each spawn route once, in start order", async () => {
		const r = await callCostAsync(STARTS, [], { cwd: tmpdir() });
		expect(r.children).toEqual([
			"node --version",
			"node -v",
			"node -e",
			"node --eval",
			"node -p",
			"node --print",
			"node -pe",
			"node lib/fixtures/call-cost-child.js",
		]);
	});
});

describe("callCost's modules", () => {
	it("leaves a lazy load out of the common call", () => {
		const r = callCost(LAZY, [], { cwd: tmpdir() });
		expect(r.modules).toEqual(["lib/fixtures/call-cost-lazy.js"]);
		expect(r.children).toEqual([]);
	});

	it("shows the lazy load on the rare call", () => {
		const r = callCost(LAZY, ["rare"], { cwd: tmpdir() });
		expect(r.modules).toEqual([
			"lib/fixtures/call-cost-lazy.js",
			"lib/fixtures/call-cost-rare.js",
		]);
	});

	it("reads each call's load set from a purged registry", () => {
		callCost(LAZY, ["rare"], { cwd: tmpdir() });
		expect(callCost(LAZY, [], { cwd: tmpdir() }).modules).toEqual([
			"lib/fixtures/call-cost-lazy.js",
		]);
	});
});

describe("callCost on a broken call", () => {
	it("throws on a non-zero exit, naming it", () => {
		expect(() => callCost(LAZY, ["fail"], { cwd: tmpdir() })).toThrow(
			/exited 3, not 0/,
		);
	});

	it("throws on stray stderr", () => {
		expect(() => callCost(LAZY, ["noisy"], { cwd: tmpdir() })).toThrow(
			/wrote to stderr/,
		);
	});

	it("admits the exit and stderr a pin names", () => {
		const r = callCost(LAZY, ["fail"], { cwd: tmpdir(), expectStatus: 3 });
		expect(r.status).toBe(3);
		expect(
			callCost(LAZY, ["noisy"], { cwd: tmpdir(), allowStderr: true }).stderr,
		).toBe("stray\n");
	});
});

describe("node:child_process after a call", () => {
	it("is restored after an ordinary call", () => {
		const before = starters();
		callCost(LAZY, [], { cwd: tmpdir() });
		expect(starters()).toEqual(before);
	});

	it("is restored after a call that throws", async () => {
		const before = starters();
		expect(() => callCost(LAZY, ["throw"], { cwd: tmpdir() })).toThrow(
			/exited 1/,
		);
		expect(starters()).toEqual(before);
		await expect(
			callCostAsync(UNGUARDED, [], { cwd: tmpdir() }),
		).rejects.toThrow(/require\.main/);
		expect(starters()).toEqual(before);
	});
});

describe("shellCallCost", () => {
	it("records the watched binaries the program itself starts, in order", () => {
		const r = shellCallCost(SHELL, [], { cwd: tmpdir(), watch: ["cat"] });
		expect(r.children).toEqual([
			"git --version",
			"git rev-parse",
			"node -e",
			"cat",
		]);
	});

	it("records a run-budgeted.js start with the command it runs (#5361)", () => {
		const r = shellCallCost(WRAPPED, [], { cwd: tmpdir() });
		expect(r.children).toEqual([
			"node lib/run-budgeted.js node lib/fixtures/call-cost-child.js",
			"node lib/run-budgeted.js git --version",
		]);
	});

	it("leaves an unwatched binary out", () => {
		const r = shellCallCost(SHELL, [], { cwd: tmpdir() });
		expect(r.children).not.toContain("cat");
	});

	it("throws on a non-zero exit or stray stderr unless the pin names it", () => {
		expect(() => shellCallCost(SHELL, ["fail"], { cwd: tmpdir() })).toThrow(
			/exited 4, not 0/,
		);
		expect(() => shellCallCost(SHELL, ["noisy"], { cwd: tmpdir() })).toThrow(
			/wrote to stderr/,
		);
		expect(
			shellCallCost(SHELL, ["fail"], { cwd: tmpdir(), expectStatus: 4 }).status,
		).toBe(4);
	});
});
