// @vitest-environment node
/*
 * lib/lander-start.js's startLander (#2405, #4458, #4950): a queue lander
 * starts only where none runs and a queue ref waits or a drop is owed a
 * decision; spawnDetachedRun starts it as no
 * session, in a user scope where the machine makes one (#2956).
 *
 * Loosen it and a second push starts a second lander, an empty queue with
 * every drop decided starts one that has nothing to do, or a drop whose
 * owning session stopped waits unticketed for an unrelated push; drop the scope and the lander's suite
 * competes process by process with every session beside it. The cgroup case
 * runs only where `systemd-run --user --scope` works, which CI's runner
 * lacks.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launcherName, spawnDetachedRun, startLander } from "./lander-start.js";

const start = (
	holder: number | null,
	waiting: string[],
	owed: string[] = [],
) => {
	let spawns = 0;
	const result = startLander({
		holder: () => holder,
		waiting: () => waiting,
		owed: () => owed,
		spawnRun: () => {
			spawns++;
			return 4242;
		},
	});
	return { result, spawns };
};

describe("startLander", () => {
	it("starts one queue lander where none runs and a queue ref waits", () => {
		expect(start(null, ["queue/a", "queue/b"])).toEqual({
			result: { started: 4242, waiting: ["queue/a", "queue/b"], owed: [] },
			spawns: 1,
		});
	});

	it("starts one with no queue ref waiting where a drop is owed a decision", () => {
		expect(start(null, [], ["dropped/a"])).toEqual({
			result: { started: 4242, waiting: [], owed: ["dropped/a"] },
			spawns: 1,
		});
	});

	it("starts none while a lander holds the lock, naming it", () => {
		expect(start(77, ["queue/a"])).toEqual({
			result: { skipped: "a lander is already running (pid 77)" },
			spawns: 0,
		});
	});

	it("starts none where no queue ref waits and no drop is owed a decision", () => {
		expect(start(null, [])).toEqual({
			result: { skipped: "no queue ref waits and no drop is owed a decision" },
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

	it("names the session start that launched it as an outliving job, which carries no session id (#4706)", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
		vi.stubEnv("WFC_REPORT_OWNER", "aaaaaaaa-1");
		expect(launcherName(listing, undefined, noPause)).toBe(
			"Implement 2478: Restore the rule",
		);
	});

	it("says no session launched it, reading no oracle, outside a session", () => {
		const read = vi.fn(listing);
		expect(launcherName(read, null, noPause)).toBe("no session");
		expect(read).not.toHaveBeenCalled();
	});
});

/**
 * Runs `probe.js` through spawnDetachedRun, behind `wrap`'s words or, absent
 * them, the user scope the machine makes.
 */
async function probeRun(source: string, wrap?: string[]) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lander-start-"));
	try {
		const script = path.join(tmp, "probe.js");
		fs.writeFileSync(script, source);
		const log = path.join(tmp, "out", "lander.log");
		const pid = spawnDetachedRun({ root: tmp, script, log, wrap });
		await vi.waitFor(() => {
			expect(() => process.kill(pid, 0)).toThrow();
			expect(fs.readFileSync(log, "utf8")).toMatch(/\n$/);
		});
		const text = fs.readFileSync(log, "utf8");
		const last = text.trimEnd().split("\n").at(-1) ?? "";
		return { tmp, pid, text, logged: JSON.parse(last) };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

const scopeWorks =
	spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--", "true"], {
		stdio: "ignore",
	}).status === 0;

describe("spawnDetachedRun", () => {
	it("starts the lander behind the wrapping words, keeping its pid", async () => {
		const { pid, logged } = await probeRun(
			"console.log(JSON.stringify([process.env.WRAPPED ?? null, process.argv.slice(2), process.pid]));",
			["env", "WRAPPED=1"],
		);
		expect(logged).toEqual(["1", ["run"], pid]);
	});

	it("starts the lander unwrapped where no scope is made, and says so in the log", async () => {
		const { pid, text, logged } = await probeRun(
			"console.log(JSON.stringify(process.pid));",
			[],
		);
		expect(logged).toBe(pid);
		expect(text).toMatch(
			/no user scope: the lander shares its starter's cgroup \(#2956\)/,
		);
	});

	it.runIf(scopeWorks)(
		"runs the lander in a cgroup other than its starter's, under the same pid (#2956)",
		async () => {
			const { pid, logged } = await probeRun(
				'console.log(JSON.stringify([require("node:fs").readFileSync("/proc/self/cgroup", "utf8"), process.pid]));',
			);
			expect(logged[0]).toMatch(/\.scope\n$/);
			expect(logged[0]).not.toBe(fs.readFileSync("/proc/self/cgroup", "utf8"));
			expect(logged[1]).toBe(pid);
		},
	);

	it("starts the lander as no session, naming no report owner, rooted at the checkout (#2410, #4706)", async () => {
		vi.stubEnv("CLAUDE_PROJECT_DIR", "/the/shared/tree");
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "starter");
		vi.stubEnv("CLAUDE_JOB_DIR", "/the/job");
		/* What a lander start launched as an outliving job carries. */
		vi.stubEnv("WFC_REPORT_OWNER", "starter");
		const { tmp, logged } = await probeRun(
			"const e = process.env; console.log(JSON.stringify([e.CLAUDE_PROJECT_DIR, e.CLAUDE_CODE_SESSION_ID ?? null, e.CLAUDE_JOB_DIR ?? null, e.WFC_REPORT_OWNER ?? null]));",
		);
		expect(logged).toEqual([tmp, null, null, null]);
	});
});
