// @vitest-environment node
/*
 * The run's private temp root (#5083): the globalSetup makes it in vitest's
 * own process, the workers' setup file points `TMPDIR` at it, and teardown
 * removes it with whatever a test left. Loosen a case and fixtures stay in
 * `/tmp`, or the wrapper's hand-off files move into a root the run deletes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { setup, teardown } from "./vitest-temp-root";

const { defaultQueueDir } = require("./lib/suite-queue.js");
const { INFLIGHT_ENV } = require("./lib/test-inflight.js");
const { TIMINGS_ENV } = require("./lib/test-file-timings.js");

afterEach(() => teardown());

describe("this worker", () => {
	it("runs under the root vitest's own process made", () => {
		const root = inject("wfcTempRoot");
		expect(path.basename(root)).toMatch(
			new RegExp(`^wfc-vitest-${process.ppid}-`),
		);
		expect(os.tmpdir()).toBe(root);
		expect(defaultQueueDir()).toBe(path.join(root, "wfc-suite-queue"));
	});

	/* Only a run run-vitest.js launched hands these over. */
	it.runIf(process.env[INFLIGHT_ENV])(
		"reads the wrapper's hand-off files under the real temp root",
		() => {
			const real = path.dirname(inject("wfcTempRoot"));
			expect(path.dirname(String(process.env[INFLIGHT_ENV]))).toBe(real);
			expect(path.dirname(String(process.env[TIMINGS_ENV]))).toBe(real);
		},
	);
});

describe("the globalSetup", () => {
	it("hands the workers a root under the real temp dir, leaving its own TMPDIR", () => {
		const real = fs.mkdtempSync(path.join(os.tmpdir(), "temp-root-real-"));
		vi.stubEnv("TMPDIR", real);
		const provide = vi.fn();
		setup({ provide });
		const root = provide.mock.calls[0][1] as string;
		expect(provide).toHaveBeenCalledWith("wfcTempRoot", root);
		expect(path.dirname(root)).toBe(real);
		expect(path.basename(root)).toMatch(
			new RegExp(`^wfc-vitest-${process.pid}-`),
		);
		expect(process.env.TMPDIR).toBe(real);
		teardown();
		fs.rmSync(real, { recursive: true, force: true });
	});

	it("removes the root at teardown, with every fixture a test left in it", () => {
		const provide = vi.fn();
		setup({ provide });
		const root = provide.mock.calls[0][1] as string;
		const left = fs.mkdtempSync(path.join(root, "named-rerun-"));
		fs.writeFileSync(path.join(left, "f"), "x");
		teardown();
		expect(fs.existsSync(root)).toBe(false);
	});
});
