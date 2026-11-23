// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildStartedLine,
	launcherName,
	parseStartedCode,
	readCodeRef,
	spawnDetachedRun,
	startLander,
} from "./lander-start.js";
import { noop } from "./noop.js";
import { spawnOutliving } from "./user-scope.js";

const start = (
	holder: number | null,
	waiting: string[],
	owed: string[] = [],
	working: string[] = [],
) => {
	let spawns = 0;
	const result = startLander({
		holder: () => holder,
		waiting: () => waiting,
		owed: () => owed,
		isDeferred: (ref) => working.includes(ref),
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

	it("starts none where no queue ref waits and the only owed drop's owning session works (#5611)", () => {
		expect(start(null, [], ["dropped/a"], ["dropped/a"])).toEqual({
			result: {
				skipped:
					"no queue ref waits and each owed drop's owning session works: dropped/a",
			},
			spawns: 0,
		});
	});

	it("starts one where no queue ref waits and one of two owed drops' owning sessions has stopped (#5611)", () => {
		expect(start(null, [], ["dropped/a", "dropped/b"], ["dropped/a"])).toEqual({
			result: { started: 4242, waiting: [], owed: ["dropped/a", "dropped/b"] },
			spawns: 1,
		});
	});

	it("starts one where a queue ref waits and the only owed drop's owning session works (#5611)", () => {
		expect(start(null, ["queue/a"], ["dropped/a"], ["dropped/a"])).toEqual({
			result: { started: 4242, waiting: ["queue/a"], owed: ["dropped/a"] },
			spawns: 1,
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

async function probeRun(
	source: string,
	wrap?: string[],
	pause?: (ms: number) => void,
) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lander-start-"));
	try {
		const script = path.join(tmp, "probe.js");
		fs.writeFileSync(script, source);
		const log = path.join(tmp, "out", "lander.log");
		const before = performance.now();
		const pid = spawnDetachedRun({ root: tmp, script, log, wrap, pause });
		const startMs = performance.now() - before;
		await vi.waitFor(() => {
			expect(() => process.kill(pid, 0)).toThrow();
			expect(fs.readFileSync(log, "utf8")).toMatch(/\n$/);
		});
		const text = fs.readFileSync(log, "utf8");
		const last = text.trimEnd().split("\n").at(-1) ?? "";
		return { tmp, pid, startMs, text, logged: JSON.parse(last) };
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

	it("starts the lander unwrapped where the wrap ends without running it, logging the refusal, where a wrap that runs it keeps its pid (#5613)", async () => {
		const { pid, text, logged } = await probeRun(
			"console.log(JSON.stringify(process.pid));",
			["sh", "-c", "exit 3", "--"],
		);
		expect(logged).toBe(pid);
		expect(text).toMatch(
			/the user scope was refused: sh it ended 3 \(#5613\)\n.*no user scope: the lander shares its starter's cgroup \(#2956\)/,
		);
	});

	it("kills a wrap that has not started the lander within the bound, and starts it unwrapped, where a wrap that runs it keeps its pid (#5613)", async () => {
		const { pid, text, logged } = await probeRun(
			"console.log(JSON.stringify(process.pid));",
			["sh", "-c", "sleep 30", "--"],
			noop,
		);
		expect(logged).toBe(pid);
		expect(text).toMatch(
			/the user scope was refused: sh it had not started the lander in \d+ ms \(#5613\)/,
		);
	});

	it("throws, logging the refusal, where the wrap ends and the unwrapped start cannot run, where an unwrapped start that runs returns its pid (#5613)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lander-start-"));
		try {
			const log = path.join(tmp, "lander.log");
			const spawn: typeof spawnOutliving = (command, args, options) =>
				options.wrap?.length
					? spawnOutliving(command, args, options)
					: ({ pid: undefined, unref: noop } as ReturnType<
							typeof spawnOutliving
						>);
			expect(() =>
				spawnDetachedRun({
					root: tmp,
					script: path.join(tmp, "probe.js"),
					log,
					wrap: ["sh", "-c", "exit 1", "--"],
					spawn,
				}),
			).toThrow(/could not start .*probe\.js/);
			expect(fs.readFileSync(log, "utf8")).toMatch(
				/the user scope was refused: sh it ended 1/,
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it.runIf(scopeWorks)(
		"runs the lander in a cgroup other than its starter's, under the same pid, confirmed within a few hundred ms (#2956, #5613)",
		async () => {
			const { pid, startMs, logged } = await probeRun(
				'console.log(JSON.stringify([require("node:fs").readFileSync("/proc/self/cgroup", "utf8"), process.pid]));',
			);
			expect(logged[0]).toMatch(/\.scope\n$/);
			expect(logged[0]).not.toBe(fs.readFileSync("/proc/self/cgroup", "utf8"));
			expect(startMs).toBeLessThan(500);
			expect(logged[1]).toBe(pid);
		},
	);

	it("starts the lander as no session, naming no report owner, rooted at the checkout (#2410, #4706)", async () => {
		vi.stubEnv("CLAUDE_PROJECT_DIR", "/the/shared/tree");
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "starter");
		vi.stubEnv("CLAUDE_JOB_DIR", "/the/job");
		vi.stubEnv("WFC_REPORT_OWNER", "starter");
		const { tmp, logged } = await probeRun(
			"const e = process.env; console.log(JSON.stringify([e.CLAUDE_PROJECT_DIR, e.CLAUDE_CODE_SESSION_ID ?? null, e.CLAUDE_JOB_DIR ?? null, e.WFC_REPORT_OWNER ?? null]));",
		);
		expect(logged).toEqual([tmp, null, null, null]);
	});

	it("starts the lander on the wall clock, whatever WFC_NOW its starter carries (#5568)", async () => {
		vi.stubEnv("WFC_NOW", "2020-01-01T00:00:00Z");
		const { logged } = await probeRun(
			"console.log(JSON.stringify(process.env.WFC_NOW ?? null));",
		);
		expect(logged).toBeNull();
	});
});

describe("readCodeRef (#5174)", () => {
	it("names a git checkout's HEAD, a plugin install's release tag, and neither as unread", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-ref-"));
		try {
			const checkout = path.join(tmp, "checkout");
			fs.mkdirSync(checkout);
			const git = (...args: string[]) =>
				spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
			git("init", "-q");
			git(
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"x",
			);
			expect(readCodeRef(checkout)).toBe(
				git("rev-parse", "HEAD").stdout.trim(),
			);
			const plugin = path.join(tmp, "plugin");
			fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
			fs.writeFileSync(
				path.join(plugin, ".claude-plugin", "plugin.json"),
				JSON.stringify({ name: "workflow-core", version: "2.2.0" }),
			);
			expect(readCodeRef(plugin)).toBe("v2.2.0");
			expect(readCodeRef(path.join(tmp, "neither"))).toBe("unread");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("parses back the code a started line names, and none from an older line or an unread code", () => {
		const line = buildStartedLine(
			{ started: 7, waiting: ["queue/a"], owed: [] },
			{
				at: "2026-11-13T00:00:00.000Z",
				by: "the refill loop",
				log: "x",
				code: "v2.3.0",
			},
		);
		expect(parseStartedCode(line)).toBe("v2.3.0");
		expect(parseStartedCode(line.replace("; code v2.3.0", ""))).toBeNull();
		expect(parseStartedCode(line.replace("v2.3.0", "unread"))).toBeNull();
	});
});
