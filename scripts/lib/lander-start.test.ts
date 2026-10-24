// @vitest-environment node
/*
 * lib/lander-start.js's startLander (#2405): a lander starts only where none
 * runs and `landing` is ahead of `main`.
 *
 * Loosen it and a second push starts a second lander, or a level `landing`
 * starts one that has nothing to test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launcherName, spawnDetachedRun, startLander } from "./lander-start.js";

const start = (
	holder: number | null,
	landing: string | null,
	relation: "ahead" | "equal" | "behind" | "diverged",
) => {
	let spawns = 0;
	const result = startLander({
		holder: () => holder,
		refs: () => ({ landing, relation }),
		spawnRun: () => {
			spawns++;
			return 4242;
		},
	});
	return { result, spawns };
};

describe("startLander", () => {
	it("starts one lander where none runs and landing is ahead", () => {
		expect(start(null, "abc", "ahead")).toEqual({
			result: { started: 4242, landing: "abc" },
			spawns: 1,
		});
	});

	it("starts none while a lander holds the lock, naming it", () => {
		expect(start(77, "abc", "ahead")).toEqual({
			result: { skipped: "a lander is already running (pid 77)" },
			spawns: 0,
		});
	});

	it.each([
		["equal", "landing equals main"],
		["behind", "landing is behind main"],
		["diverged", "landing and main have diverged"],
	] as const)("starts none where landing is %s", (relation, reason) => {
		expect(start(null, "abc", relation)).toEqual({
			result: { skipped: reason },
			spawns: 0,
		});
	});

	it("starts none where the remote has no landing branch", () => {
		expect(start(null, null, "ahead")).toEqual({
			result: { skipped: "the remote has no landing branch" },
			spawns: 0,
		});
	});
});

describe("launcherName (#2478)", () => {
	const listing = () => ({
		agents: [
			{ sessionId: "aaaaaaaa-1", name: "Implement 2478: Restore the rule" },
			{ sessionId: "bbbbbbbb-2" },
		],
	});
	const noPause = () => undefined;

	it("names the launching session by its claude agents name", () => {
		expect(launcherName(listing, "aaaaaaaa-1", noPause)).toBe(
			"Implement 2478: Restore the rule",
		);
	});

	it("asks again for a session not yet listed, then names it", () => {
		const read = vi
			.fn()
			.mockReturnValueOnce({ agents: [] })
			.mockReturnValueOnce({ why: "down" })
			.mockImplementation(listing);
		const pause = vi.fn();
		expect(launcherName(read, "aaaaaaaa-1", pause)).toBe(
			"Implement 2478: Restore the rule",
		);
		expect(read).toHaveBeenCalledTimes(3);
		expect(pause).toHaveBeenCalledTimes(2);
	});

	it("falls back to the id's first 8 characters once five reads name none", () => {
		const read = vi.fn(listing);
		expect(launcherName(read, "bbbbbbbb-2", noPause)).toBe("session bbbbbbbb");
		expect(read).toHaveBeenCalledTimes(5);
	});

	it("carries the oracle's refusal beside the id where it could not be read", () => {
		expect(launcherName(() => ({ why: "down" }), "dddddddd-4", noPause)).toBe(
			"session dddddddd (down)",
		);
	});

	it("says no session launched it, reading no oracle, outside a session", () => {
		const read = vi.fn(listing);
		expect(launcherName(read, null, noPause)).toBe("no session");
		expect(read).not.toHaveBeenCalled();
	});
});

describe("spawnDetachedRun", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("starts the lander as no session, rooted at the checkout (#2410)", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lander-start-"));
		try {
			const script = path.join(tmp, "probe.js");
			fs.writeFileSync(
				script,
				"const e = process.env; console.log(JSON.stringify([e.CLAUDE_PROJECT_DIR, e.CLAUDE_CODE_SESSION_ID ?? null, e.CLAUDE_JOB_DIR ?? null]));",
			);
			const log = path.join(tmp, "out", "lander.log");
			vi.stubEnv("CLAUDE_PROJECT_DIR", "/the/shared/tree");
			vi.stubEnv("CLAUDE_CODE_SESSION_ID", "starter");
			vi.stubEnv("CLAUDE_JOB_DIR", "/the/job");
			const pid = spawnDetachedRun({ root: tmp, script, log });
			await vi.waitFor(() => {
				expect(() => process.kill(pid, 0)).toThrow();
				expect(fs.readFileSync(log, "utf8")).not.toBe("");
			});
			expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual([
				tmp,
				null,
				null,
			]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
