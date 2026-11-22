// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	freshSandbox,
	removeSandbox,
	SANDBOX_RM_ATTEMPTS,
	SANDBOX_RM_DELAY_MS,
} from "./arbiter-testkit";
import { ledgerPath } from "./dispatch-ledger.js";
import { noop } from "./noop.js";

const errno = (code: string) => Object.assign(new Error(code), { code });

function flaky(failures: number, code = "ENOTEMPTY") {
	const calls: string[] = [];
	return {
		calls,
		remove(target: string) {
			calls.push(target);
			if (calls.length <= failures) throw errno(code);
		},
	};
}

describe("removeSandbox", () => {
	it("retries an ENOTEMPTY and returns once the remove succeeds", () => {
		const stub = flaky(2);
		const slept: number[] = [];

		expect(() =>
			removeSandbox("/tmp/arbiter-x", {
				remove: stub.remove,
				sleep: (ms) => slept.push(ms),
			}),
		).not.toThrow();

		expect(stub.calls).toEqual([
			"/tmp/arbiter-x",
			"/tmp/arbiter-x",
			"/tmp/arbiter-x",
		]);
		expect(slept).toEqual([SANDBOX_RM_DELAY_MS, SANDBOX_RM_DELAY_MS]);
	});

	it("throws rather than swallowing when ENOTEMPTY never clears", () => {
		const stub = flaky(Number.POSITIVE_INFINITY);
		const slept: number[] = [];

		expect(() =>
			removeSandbox("/tmp/arbiter-y", {
				remove: stub.remove,
				sleep: (ms) => slept.push(ms),
				attempts: 3,
				delayMs: 7,
			}),
		).toThrow(/ENOTEMPTY/);

		expect(stub.calls).toHaveLength(3);
		expect(slept).toEqual([7, 7]);
	});

	it("defaults to the whole SANDBOX_RM_ATTEMPTS budget", () => {
		const stub = flaky(Number.POSITIVE_INFINITY);

		expect(() =>
			removeSandbox("/tmp/arbiter-y2", {
				remove: stub.remove,
				sleep: noop,
			}),
		).toThrow(/ENOTEMPTY/);

		expect(stub.calls).toHaveLength(SANDBOX_RM_ATTEMPTS);
	});

	it("actually blocks between attempts when no sleep is injected", () => {
		const stub = flaky(2);
		const started = Date.now();

		removeSandbox("/tmp/arbiter-w", { remove: stub.remove });

		expect(Date.now() - started).toBeGreaterThanOrEqual(
			2 * SANDBOX_RM_DELAY_MS,
		);
	});

	it("rethrows any other code on the first attempt, without retrying", () => {
		const stub = flaky(Number.POSITIVE_INFINITY, "EACCES");
		const slept: number[] = [];

		expect(() =>
			removeSandbox("/tmp/arbiter-z", {
				remove: stub.remove,
				sleep: (ms) => slept.push(ms),
			}),
		).toThrow(/EACCES/);

		expect(stub.calls).toHaveLength(1);
		expect(slept).toEqual([]);
	});

	it("removes a real directory tree through its default remover", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-rm-"));
		fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
		fs.writeFileSync(path.join(dir, "a", "b", "c.txt"), "x");

		removeSandbox(dir);

		expect(fs.existsSync(dir)).toBe(false);
	});
});

describe("freshSandbox", () => {
	beforeEach(() => {
		for (const k of ["WFC_REPO_ROOT", "WFC_DISPATCH_ROOT"])
			vi.stubEnv(k, "/real/checkout");
	});
	const sb = freshSandbox();

	it("points an inherited WFC_REPO_ROOT and WFC_DISPATCH_ROOT at the sandbox repo (#3119)", () => {
		expect(process.env.WFC_REPO_ROOT).toBe(sb.repo);
		expect(process.env.WFC_DISPATCH_ROOT).toBe(sb.repo);
		expect(ledgerPath().startsWith(`${sb.repo}${path.sep}`)).toBe(true);
	});
});
