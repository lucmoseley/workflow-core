// @vitest-environment node
/*
 * hook-deadline.js caps each dispatcher adapter's timeout at what the
 * entry's 8 s budget leaves (#2792). Module cases with an injected `now`; the
 * clock is module state, so each case reloads the module.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Deadline {
	budgetMs: (cap: number, now?: number) => number;
	ENTRY_BUDGET_MS: number;
	startEntryClock: (now?: number) => void;
}

let d: Deadline;

beforeEach(() => {
	vi.resetModules();
	d = require("./hook-deadline.js") as Deadline;
	delete require.cache[require.resolve("./hook-deadline.js")];
});

describe("budgetMs", () => {
	it("gives the cap alone where no entry started the clock", () => {
		expect(d.budgetMs(3000, 1e12)).toBe(3000);
	});

	it("cuts the cap to what the budget leaves since the process started", () => {
		vi.spyOn(process, "uptime").mockReturnValue(1);
		d.startEntryClock(10_000);
		expect(d.budgetMs(3000, 10_000)).toBe(3000);
		expect(d.budgetMs(8000, 10_000)).toBe(d.ENTRY_BUDGET_MS - 1000);
		expect(d.budgetMs(3000, 15_500)).toBe(1500);
		vi.restoreAllMocks();
	});

	it("never answers 0, which child_process reads as no timeout", () => {
		vi.spyOn(process, "uptime").mockReturnValue(0);
		d.startEntryClock(0);
		expect(d.budgetMs(3000, 8000)).toBe(1);
		expect(d.budgetMs(3000, 60_000)).toBe(1);
		vi.restoreAllMocks();
	});
});
