// @vitest-environment node
/*
 * arbiter-testkit.ts's own suite: its retrying sandbox teardown (mantahostels#2956),
 * where an ENOTEMPTY is retried within a fixed budget and then thrown and any
 * other error is thrown at once; and freshSandbox's re-pointing of the inherited
 * repo roots (#3119).
 *
 * The remover and sleep are injected as a flaky stub, so a detached child still
 * writing into the sandbox is reproduced on cue rather than raced for; one case
 * removes a real tree through the default remover.
 *
 * Every arbiter suite tears down through this: loosen a case here and a suite
 * whose assertions all passed goes red in CI on a teardown race, or a real
 * teardown fault is swallowed and sandboxes pile up in the temp dir. Loosen the
 * roots case and those suites read and write the real checkout's dispatch ledger
 * from a background job.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	freshSandbox,
	removeSandbox,
	SANDBOX_RM_ATTEMPTS,
	SANDBOX_RM_DELAY_MS,
} from "./arbiter-testkit";
import { ledgerPath } from "./dispatch-ledger.js";

/** An Error carrying a `code`, the shape node's fs throws. */
const errno = (code: string) => Object.assign(new Error(code), { code });

/** A remover that throws `code` for its first `failures` calls, then succeeds. */
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
				sleep: () => {
					/* no real wait between retries */
				},
			}),
		).toThrow(/ENOTEMPTY/);

		expect(stub.calls).toHaveLength(SANDBOX_RM_ATTEMPTS);
	});

	it("actually blocks between attempts when no sleep is injected", () => {
		// The default sleep is the one line that stalls the vitest worker; every
		// other case stubs it out, so without this it never runs under test.
		const stub = flaky(2);
		const started = Date.now();

		removeSandbox("/tmp/arbiter-w", { remove: stub.remove });

		// §X9: the default sleep is a real one, and this floor is its one proof.
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
	// Set before freshSandbox snapshots the environment, as a background job's
	// inherited real-checkout roots are (#3119).
	const Real = "/real/checkout";
	const inherited = {
		WFC_REPO_ROOT: process.env.WFC_REPO_ROOT,
		WFC_DISPATCH_ROOT: process.env.WFC_DISPATCH_ROOT,
	};
	for (const k of Object.keys(inherited)) process.env[k] = Real;
	const sb = freshSandbox();

	afterAll(() => {
		for (const [k, v] of Object.entries(inherited)) {
			expect(process.env[k]).toBe(Real);
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it("points an inherited WFC_REPO_ROOT and WFC_DISPATCH_ROOT at the sandbox repo (#3119)", () => {
		expect(process.env.WFC_REPO_ROOT).toBe(sb.repo);
		expect(process.env.WFC_DISPATCH_ROOT).toBe(sb.repo);
		expect(ledgerPath().startsWith(`${sb.repo}${path.sep}`)).toBe(true);
	});
});
