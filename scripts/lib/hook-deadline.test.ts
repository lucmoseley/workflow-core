// @vitest-environment node
/*
 * hook-deadline.js caps each git and gh call in the dispatcher's process at
 * what its event's entry budget leaves (#2792, #3268). Module cases with an
 * injected `now`; the clock is module state, so each case reloads the module
 * and the two seams that read it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Event = "PreToolUse" | "PostToolUse";

interface Deadline {
	budgetMs: (cap: number, now?: number) => number;
	ENTRY_BUDGET_MS: Record<Event, number>;
	startEntryClock: (event: Event, now?: number) => void;
}

const MODULES = ["./hook-deadline.js", "./git.js", "./gh.js"];

let d: Deadline;

const drop = () => {
	for (const m of MODULES) delete require.cache[require.resolve(m)];
};

beforeEach(() => {
	drop();
	d = require("./hook-deadline.js") as Deadline;
});

afterEach(() => {
	vi.restoreAllMocks();
	drop();
});

describe("budgetMs", () => {
	it("gives the cap alone where no entry started the clock", () => {
		expect(d.budgetMs(3000, 1e12)).toBe(3000);
	});

	it("cuts the cap to what the event's budget leaves since the process started", () => {
		vi.spyOn(process, "uptime").mockReturnValue(1);
		d.startEntryClock("PostToolUse", 10_000);
		expect(d.budgetMs(3000, 10_000)).toBe(3000);
		expect(d.budgetMs(8000, 10_000)).toBe(d.ENTRY_BUDGET_MS.PostToolUse - 1000);
		expect(d.budgetMs(3000, 15_500)).toBe(d.ENTRY_BUDGET_MS.PostToolUse - 6500);
	});

	it("gives a PreToolUse entry its own, longer budget", () => {
		vi.spyOn(process, "uptime").mockReturnValue(0);
		d.startEntryClock("PreToolUse", 0);
		expect(d.budgetMs(60_000, 10_000)).toBe(
			d.ENTRY_BUDGET_MS.PreToolUse - 10_000,
		);
	});

	it("never answers 0, which child_process reads as no timeout", () => {
		vi.spyOn(process, "uptime").mockReturnValue(0);
		d.startEntryClock("PostToolUse", 0);
		expect(d.budgetMs(3000, 8000)).toBe(1);
		expect(d.budgetMs(3000, 60_000)).toBe(1);
	});
});

describe("ENTRY_BUDGET_MS", () => {
	it("is half each dispatcher registration's timeout", () => {
		const hooks = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "..", "..", "self-plugin", "hooks", "hooks.json"),
				"utf8",
			),
		).hooks as Record<
			string,
			{ hooks: { command: string; timeout: number }[] }[]
		>;
		const timeouts = Object.fromEntries(
			Object.entries(hooks).flatMap(([event, groups]) =>
				groups
					.flatMap((g) => g.hooks)
					.filter((h) => h.command.includes("guard-dispatch.js"))
					.map((h) => [event, (h.timeout * 1000) / 2]),
			),
		);
		expect(d.ENTRY_BUDGET_MS).toEqual(timeouts);
	});
});

describe("the git and gh seams", () => {
	let dir: string;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(100_000);
		vi.spyOn(process, "uptime").mockReturnValue(0);
		d.startEntryClock("PostToolUse", 100_000 - 7000);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-deadline-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("cut a git call's timeout, or its lack of one, to what is left", () => {
		const { gitSpawnOptions } = require("./git.js");
		expect(gitSpawnOptions({ timeout: 3000 }).timeout).toBe(500);
		expect(gitSpawnOptions({}).timeout).toBe(500);
	});

	it("cut a gh call's timeout to what is left", () => {
		/* The real clock, crossed: only a spawn's own kill shows the timeout
		 * child_process got. */
		const stub = path.join(dir, "gh");
		fs.writeFileSync(stub, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
		vi.stubEnv("WFC_GH", stub);
		expect(() =>
			require("./gh.js").gh(["api", "user"], { timeout: 3000 }),
		).toThrow(expect.objectContaining({ code: "ETIMEDOUT" }));
	});
});
