// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	agentsListing,
	dispatchFixture,
	SCRIPT,
	SELF_SESSION_ID,
	writeCache,
} from "./lib/dispatch-sessions-testkit";
import { keptSpawn } from "./lib/kept-spawn.js";
import { buildLoadavgLine } from "./lib/proc-fake";
import { writePsStub } from "./lib/ps-stub";
import { shellQuote } from "./lib/sh-quote.js";

const fx = dispatchFixture();
const { stubClaude, baseEnv, launchArgv, readArgvLines, runCore, sleepArgs } =
	fx;

describe("the partial launch's edges", () => {
	it("previews the partial set under --dry-run without starting it", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const preview = await runCore([
			"--dry-run",
			"sonnet",
			"/implement 341",
			"opus",
			"/wayfinder 1114",
		]);
		expect(preview.code).toBe(0);
		expect(preview.stderr).toContain("dropped: /implement 341");
		expect(preview.stdout).toContain("would launch");
		expect(preview.stdout).not.toContain("/implement 341");
	});

	it("refuses an empty prompt, which would desync the drop list", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "", "opus", "/wayfinder 1114"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("may not be empty");
	});

	it("warns about the advisor for the members that actually launch", async () => {
		stubClaude({ advisorAttaches: false });
		await runCore(["sonnet", "/implement 341"]);
		const second = await runCore([
			"sonnet",
			"/implement 341",
			"opus",
			"/wayfinder 1114",
		]);
		expect(second.stderr).not.toContain("the advisor is not live here");
	});
});

describe("the per-member admission re-read (mantahostels#2553)", () => {
	it("launches a member when the re-read shows headroom", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("refuses a member when the re-read shows no headroom, and names it", async () => {
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("not launching this member");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("refuses every low-headroom member in a set, not only the first, naming each and launching none", async () => {
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore([
			"sonnet",
			"/implement 341",
			"opus",
			"/wayfinder 1114",
		]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("REFUSED: /wayfinder 1114");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("refuses on an unreadable re-read rather than guessing headroom, naming the member and offering --force-memory as the way out", async () => {
		stubClaude({});
		fs.rmSync(fx.meminfo);
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("--force-memory skips the memory re-read and launches anyway", async () => {
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED: /implement 341");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});

	it("never re-reads under --dry-run", async () => {
		stubClaude({});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(["--dry-run", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED: /implement 341");
		expect(r.stdout).toContain("would launch");
	});
});

describe("a CPU load hold at the re-read (#830, #834)", () => {
	const WellOverLoadCeiling = 60;
	const overloaded = () =>
		fs.writeFileSync(fx.loadavg, buildLoadavgLine(WellOverLoadCeiling));

	it("names the load remedy, and neither the memory one nor the roster", async () => {
		stubClaude({});
		overloaded();
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("A CPU load hold");
		expect(r.stderr).toContain("WFC_LOAD_CEILING=0");
		expect(r.stderr).toContain(
			"re-run this member later with the same command",
		);
		expect(r.stderr).toContain("rule:load-wait");
		expect(r.stderr).not.toContain("/proc/loadavg");
		expect(r.stderr).not.toContain("--force-memory overrides a memory one");
		expect(r.stderr).not.toContain("check-ghost-jobs.js");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("names both remedies where memory holds as well", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		overloaded();
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("A CPU load hold");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
	});

	it("keeps the CPU limb armed under --force-memory", async () => {
		stubClaude({});
		overloaded();
		const r = await runCore(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("A CPU load hold");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("--force --force-memory still holds on load", async () => {
		stubClaude({});
		overloaded();
		const r = await runCore([
			"--force",
			"--force-memory",
			"sonnet",
			"/implement 341",
		]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("A CPU load hold");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("warns, and launches, where --force-memory cannot read the load, naming the member and the load as unknown", async () => {
		stubClaude({});
		fs.rmSync(fx.loadavg);
		const r = await runCore(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("WARNING: /implement 341");
		expect(r.stderr).toMatch(/cpu load\s+unknown/);
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});
});

describe("the admit-path allowance warning", () => {
	it("names the member and the stale reading, and launches", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("WARNING: /implement 341");
		expect(r.stderr).toContain(
			"session allowance reading is absent — admitting anyway",
		);
		expect(launchArgv()).toContain("--bg");
	});

	it("says nothing on a fresh reading", async () => {
		const configDir = path.join(fx.dir, "fresh-config");
		writeCache(configDir, { session: 40, weeklyAll: 50 });
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("WARNING: /implement 341");
		expect(launchArgv()).toContain("--bg");
	});
});

describe("a CPU session hold at the re-read (#2141)", () => {
	const full = () => ({
		WFC_PS: writePsStub(fx.dir, ["900 1000 claude bg-pty-host --session x"], {
			name: "ps-one-host",
		}),
		WFC_SESSION_CEILING: "1",
	});

	it("names the session remedy, and neither the memory one nor the roster", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], full());
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("A CPU session hold");
		expect(r.stderr).toContain("WFC_SESSION_CEILING=0");
		expect(r.stderr).not.toContain("A CPU load hold");
		expect(r.stderr).not.toContain("--force-memory overrides a memory one");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("names both remedies where memory holds as well", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(["sonnet", "/implement 341"], full());
		expect(r.stderr).toContain("A CPU session hold");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
	});

	it("keeps the session ceiling armed under --force-memory", async () => {
		stubClaude({});
		const r = await runCore(
			["--force-memory", "sonnet", "/implement 341"],
			full(),
		);
		expect(r.stderr).toContain("A CPU session hold");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("warns, and launches, where --force-memory cannot count the sessions", async () => {
		stubClaude({});
		const r = await runCore(["--force-memory", "sonnet", "/implement 341"], {
			WFC_PS: writePsStub(fx.dir, [], { name: "ps-failing", fails: true }),
		});
		expect(r.stderr).toContain("WARNING: /implement 341");
		expect(r.stderr).toMatch(/cpu sessions\s+unknown/);
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});
});

describe("--force and --force-memory split (#299)", () => {
	const fullSession = (): Record<string, string> => {
		const configDir = path.join(fx.dir, "full-session-config");
		writeCache(configDir, { session: 100, weeklyAll: 12 });
		return { CLAUDE_CONFIG_DIR: configDir };
	};
	const lowMemory = () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
	};
	const readLaunches = () => readArgvLines().filter((l) => l.includes("--bg"));

	it("--force alone leaves the memory re-read armed", async () => {
		lowMemory();
		const r = await runCore(["--force", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("--force-memory overrides it");
		expect(readLaunches()).toHaveLength(0);
	});

	it("--force launches every member past a full session bar, not refusing each", async () => {
		stubClaude({});
		const r = await runCore(
			["--force", "sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			fullSession(),
		);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED");
		expect(readLaunches()).toHaveLength(2);
	});

	it("--force-memory alone leaves the allowance gate armed", async () => {
		stubClaude({});
		const r = await runCore(
			["--force-memory", "sonnet", "/implement 341"],
			fullSession(),
		);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("session allowance 100% used");
		expect(readLaunches()).toHaveLength(0);
	});

	it("--force-memory alone leaves the duplicate drop armed", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const r = await runCore(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(4);
		expect(r.stderr).toContain("dropped: /implement 341");
		expect(r.stderr).toContain(
			"every member of this set is already dispatched",
		);
		expect(readLaunches()).toHaveLength(1);
	});

	it("--force --force-memory together skip all three gates, as the old --force did", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		await runCore(["sonnet", "/implement 341"]);
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(
			["--force", "--force-memory", "sonnet", "/implement 341"],
			fullSession(),
		);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED");
		expect(readLaunches()).toHaveLength(2);
	});
});

describe("the launch stagger (mantahostels#2553)", () => {
	it("sleeps WFC_DISPATCH_STAGGER_SECONDS between two launches", () => {
		stubClaude({});
		const start = Date.now();
		const r = keptSpawn("timeout").spawnSync(
			process.execPath,
			[SCRIPT, "sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				cwd: fx.dir,
				encoding: "utf8",
				env: baseEnv({ WFC_DISPATCH_STAGGER_SECONDS: "1" }),
			},
		);
		const elapsed = Date.now() - start;
		expect(r.status).toBe(0);
		expect(elapsed).toBeGreaterThanOrEqual(1000);
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(2);
	});

	it("staggers by the measured 2 seconds when nothing overrides it", async () => {
		stubClaude({});
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{ WFC_DISPATCH_STAGGER_SECONDS: "" },
		);
		expect(r.code).toBe(0);
		expect(sleepArgs()).toEqual(["2"]);
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(2);
	});

	it("never sleeps before the first launch, or after the last", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], {
			WFC_DISPATCH_STAGGER_SECONDS: "1",
		});
		expect(r.code).toBe(0);
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(1);
		expect(sleepArgs()).toEqual([]);
	});

	it("never sleeps under --dry-run", async () => {
		stubClaude({});
		const r = await runCore(
			["--dry-run", "sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{ WFC_DISPATCH_STAGGER_SECONDS: "1" },
		);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("would launch");
		expect(sleepArgs()).toEqual([]);
	});

	it("does not stagger after a launch that failed", async () => {
		stubClaude({ launchFails: true });
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{ WFC_DISPATCH_STAGGER_SECONDS: "1" },
		);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("(claude exited 1; not recorded as launched.)");
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(2);
		expect(sleepArgs()).toEqual([]);
	});

	it("does not stagger a member the re-read refused", async () => {
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{ WFC_DISPATCH_STAGGER_SECONDS: "1" },
		);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("REFUSED: /wayfinder 1114");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
		expect(sleepArgs()).toEqual([]);
	});
});

describe("the lander read on the re-read (#2889)", () => {
	const refused = async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    600000 kB\n");
		return (await runCore(["sonnet", "/implement 341"])).stderr;
	};

	it("reads the fixture's queue, never the machine's own landers", async () => {
		expect(await refused()).not.toMatch(/\d+ lander/);
	});

	it("counts a lander queued in the fixture's queue", async () => {
		const queue = path.join(fx.dir, "wfc-suite-queue");
		fs.mkdirSync(queue);
		fs.writeFileSync(
			path.join(queue, `wfc-suite-queue-${process.pid}.json`),
			JSON.stringify({ pid: process.pid, at: 1, role: "lander" }),
		);
		expect(await refused()).toMatch(/\d+ lander/);
	});
});

describe("the roster remedy on a refusal (mantahostels#2588)", () => {
	it("offers the roster SIGTERM route when the re-read refuses a member", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.stderr).toContain("check-ghost-jobs.js");
		expect(r.stderr).toContain("replPid");
		expect(r.stderr).toContain("SIGTERM");
		expect(r.stderr).toContain("roster:");
	});

	it("offers it on the already-dispatched refusal too", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const second = await runCore(["sonnet", "/implement 341"]);
		expect(second.code).toBe(4);
		expect(second.stderr).toContain("check-ghost-jobs.js");
		expect(second.stderr).toContain("replPid");
	});

	it("names the ghost-job checker by its plugin-root path in an install (#1289)", async () => {
		stubClaude({});
		const root = path.join(fx.dir, "plugins", "w f c");
		await runCore(["sonnet", "/implement 341"]);
		const second = await runCore(["sonnet", "/implement 341"], {
			WFC_SCRIPT_ROOT: root,
		});
		expect(second.stderr).toContain(
			`    node '${root}/scripts/check-ghost-jobs.js'\n`,
		);
	});

	it("prints it once, however many members a set refuses", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore([
			"sonnet",
			"/implement 341",
			"opus",
			"/wayfinder 1114",
		]);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("REFUSED: /wayfinder 1114");
		expect(r.stderr.split("check-ghost-jobs.js")).toHaveLength(2);
	});

	it("says nothing about a roster on a launch that is not refused", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.stderr).not.toContain("check-ghost-jobs.js");
	});

	it("names the gap rather than going quiet where no roster file exists", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await fx.runCoreUnder(["sonnet", "/implement 341"], {
			cwd: fx.dir,
			env: { ...baseEnv(), HOME: fx.dir },
		});
		expect(r.stderr).toContain("none under");
	});

	it("lists the roster of every plan dir, .claude12 included, and of no other dir (#2580)", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const home = path.join(fx.dir, "home");
		const roster = (dir: string) =>
			path.join(home, dir, "daemon", "roster.json");
		for (const dir of [".claude", ".claude3", ".claude12", ".claude-exp-a"]) {
			fs.mkdirSync(path.dirname(roster(dir)), { recursive: true });
			fs.writeFileSync(roster(dir), "{}");
		}
		const r = await runCore(["sonnet", "/implement 341"], { HOME: home });
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		for (const dir of [".claude", ".claude3", ".claude12"]) {
			expect(r.stderr).toContain(`    roster: ${roster(dir)}\n`);
		}
		expect(r.stderr).not.toContain(".claude-exp-a");
		expect(r.stderr).not.toContain("none under");
	});

	it("names an unset HOME rather than aborting the refusal (#2580)", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const env = baseEnv();
		delete env.HOME;
		const r = await fx.runCoreUnder(["sonnet", "/implement 341"], {
			cwd: fx.dir,
			env,
		});
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("HOME unset or unreadable");
	});

	it("names a HUNG-JOB inline, with its roster path, on a refusal (mantahostels#2598)", async () => {
		const hungSessionId = "hung-0000-0000-0000-000000000000";
		stubClaude({
			agentsJson: JSON.stringify([
				{ sessionId: SELF_SESSION_ID, pid: 1 },
				{ sessionId: hungSessionId, pid: 4242 },
			]),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");

		const configDir = path.join(fx.dir, "hung-config");
		fs.mkdirSync(path.join(configDir, "jobs", "job1"), { recursive: true });
		const at = new Date(Date.now() - 60 * 60_000).toISOString();
		fs.writeFileSync(
			path.join(configDir, "jobs", "job1", "state.json"),
			JSON.stringify({
				state: "working",
				sessionId: hungSessionId,
				intent: "/implement 9999",
				createdAt: at,
				updatedAt: at,
			}),
		);

		const r = await fx.runCoreUnder(["sonnet", "/implement 341"], {
			cwd: fx.dir,
			env: baseEnv({
				CLAUDE_CONFIG_DIR: configDir,
				WFC_CLAUDE_CONFIG_A: configDir,
				WFC_CLAUDE_CONFIG_B: configDir,
				WFC_CLAUDE_CONFIG_C: configDir,
			}),
		});

		expect(r.stderr).toContain("/implement 9999");
		expect(r.stderr).toContain(`session ${hungSessionId}`);
		expect(r.stderr).toContain("roster:");
		expect(r.stderr).not.toContain("check-ghost-jobs.js");
	});

	it("falls back to the second command where nothing reads as hung", async () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.stderr).toContain("check-ghost-jobs.js");
	});
});

describe("the kernel-stall check (#867)", () => {
	function kernelStalled(): string {
		const at = path.join(fx.dir, "kernel-stalled.log");
		fs.writeFileSync(
			at,
			"2026-10-07T22:43:24+08:00 host kernel: rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:\n",
		);
		return at;
	}

	it("refuses the whole call on a stalled boot, naming the first stall's time", async () => {
		stubClaude({});
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				WFC_KERNEL_LOG: kernelStalled(),
			},
		);
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("RCU stall");
		expect(r.stderr).toContain("2026-10-07T22:43:24+08:00");
		expect(r.stderr).toContain("wsl --shutdown");
		expect(readArgvLines()).toEqual([]);
	});

	it("launches normally on a clean boot", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(launchArgv()).toBeDefined();
	});

	it("launches where the kernel log cannot be read", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], {
			WFC_KERNEL_LOG: path.join(fx.dir, "no-such-log"),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toBeDefined();
	});

	it("re-checks before each member, naming the ones already launched and --force", async () => {
		stubClaude({});
		const calls = path.join(fx.dir, "journal-calls");
		const journal = path.join(fx.dir, "journalctl-stalls-later");
		fs.writeFileSync(
			journal,
			[
				"#!/bin/bash",
				`printf 'x' >> ${shellQuote(calls)}`,
				`n=$(wc -c < ${shellQuote(calls)})`,
				'if [ "$n" -le 2 ]; then echo "2026-10-07T22:40:00+08:00 host kernel: ok"; exit 0; fi',
				'echo "2026-10-07T22:43:24+08:00 host kernel: rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:"',
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				WFC_KERNEL_LOG: "",
				WFC_JOURNALCTL: journal,
				WFC_DMESG: path.join(fx.dir, "no-such-dmesg"),
			},
		);
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("1 member(s) HAD already launched");
		expect(r.stderr).toContain("/implement 341");
		expect(r.stderr).toContain("re-run with --force");
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(1);
	});
});

describe("the scheduler-clock check (#2779)", () => {
	it("refuses the whole call on a frozen clock, naming the signal", async () => {
		stubClaude({});
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				WFC_SCHED_CLOCK: fx.schedClock(0),
			},
		);
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("SCHED-CLOCK-FROZEN");
		expect(r.stderr).not.toContain("RCU stall");
		expect(r.stderr).toContain("wsl --shutdown");
		expect(readArgvLines()).toEqual([]);
	});

	it("launches on a clock it cannot read (#4092)", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], {
			WFC_SCHED_CLOCK: path.join(fx.dir, "no-clock"),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toBeDefined();
	});

	it("launches once the clock moves again", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], {
			WFC_SCHED_CLOCK: fx.schedClock(1),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toBeDefined();
	});
});
