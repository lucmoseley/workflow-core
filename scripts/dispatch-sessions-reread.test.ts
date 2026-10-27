// @vitest-environment node
/*
 * Pins a /pick-next dispatch set's per-member re-read: the memory, CPU-load
 * and CPU-session holds, the force flags, the launch stagger, the roster
 * remedy, and the kernel-stall and scheduler-clock checks.
 *
 * Loosen a test here and a set launches past a memory or CPU gate, which is
 * how the machine freezes.
 *
 * The stagger cases (mantahostels#2553) assert on a `sleep` stubbed onto PATH
 * (#146): bash has no `sleep` builtin, so the script's own bare
 * `sleep "$STAGGER_SECONDS"` resolves through PATH like any other command. Not
 * a wall-clock ceiling: neighbour load breaches one.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from dispatch-sessions.test.ts, whose cost was pre-existing (#2413).
 */
import { spawnSync } from "node:child_process";
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
import { writePsStub } from "./lib/ps-stub";

const fx = dispatchFixture();
const {
	stubClaude,
	baseEnv,
	launchArgv,
	readArgvLines,
	run,
	stubSleep,
	sleepArgs,
} = fx;

describe("the partial launch's edges", () => {
	it("previews the partial set under --dry-run without starting it", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const preview = run([
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

	it("refuses an empty prompt, which would desync the drop list", () => {
		stubClaude({});
		const r = run(["sonnet", "", "opus", "/wayfinder 1114"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("may not be empty");
	});

	it("warns about the advisor for the members that actually launch", () => {
		/* The Sonnet member is dropped, so the set that launches is Opus-only and
		 * wants no advisor. */
		stubClaude({ advisorAttaches: false });
		run(["sonnet", "/implement 341"]);
		const second = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		expect(second.stderr).not.toContain("the advisor is not live here");
	});
});

describe("the per-member admission re-read (mantahostels#2553)", () => {
	it("launches a member when the re-read shows headroom", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("refuses a member when the re-read shows no headroom, and names it", () => {
		// A neighbour already listed, so the always-admit-one guarantee
		// (`admission.js`'s own header) does not mask the low-memory refusal
		// this test is actually about.
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("not launching this member");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("refuses every low-headroom member in a set, not only the first, naming each and launching none", () => {
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("REFUSED: /wayfinder 1114");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("refuses on an unreadable re-read rather than guessing headroom, naming the member and offering --force-memory as the way out", () => {
		stubClaude({});
		fs.rmSync(fx.meminfo);
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("--force-memory skips the memory re-read and launches anyway", () => {
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED: /implement 341");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});

	it("never re-reads under --dry-run", () => {
		stubClaude({});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["--dry-run", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED: /implement 341");
		expect(r.stdout).toContain("would launch");
	});
});

describe("a CPU load hold at the re-read (#830, #834)", () => {
	const overloaded = () =>
		fs.writeFileSync(fx.loadavg, "60.00 50.00 40.00 9/900 1\n");

	it("names the load remedy, and neither the memory one nor the roster", () => {
		stubClaude({});
		overloaded();
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("A CPU load hold");
		expect(r.stderr).toContain("WFC_LOAD_CEILING=0");
		expect(r.stderr).not.toContain("--force-memory overrides a memory one");
		expect(r.stderr).not.toContain("check-ghost-jobs.js");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("names both remedies where memory holds as well", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		overloaded();
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("A CPU load hold");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
	});

	it("keeps the CPU limb armed under --force-memory", () => {
		stubClaude({});
		overloaded();
		const r = run(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("A CPU load hold");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("--force --force-memory still holds on load", () => {
		stubClaude({});
		overloaded();
		const r = run(["--force", "--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("A CPU load hold");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("warns, and launches, where --force-memory cannot read the load, naming the member and the load as unknown", () => {
		stubClaude({});
		fs.rmSync(fx.loadavg);
		const r = run(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("WARNING: /implement 341");
		expect(r.stderr).toMatch(/cpu load\s+unknown/);
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});
});

/* #2876: the admit path's warning match, on the allowance line admission.js
 * prints where its own reading is not fresh, and silent where it is. */
describe("the admit-path allowance warning", () => {
	it("names the member and the stale reading, and launches", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("WARNING: /implement 341");
		expect(r.stderr).toContain(
			"session allowance reading is absent — admitting anyway",
		);
		expect(launchArgv()).toContain("--bg");
	});

	it("says nothing on a fresh reading", () => {
		const configDir = path.join(fx.dir, "fresh-config");
		writeCache(configDir, { session: 40, weeklyAll: 50 });
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], {
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

	it("names the session remedy, and neither the memory one nor the roster", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], full());
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("A CPU session hold");
		expect(r.stderr).toContain("WFC_SESSION_CEILING=0");
		expect(r.stderr).not.toContain("A CPU load hold");
		expect(r.stderr).not.toContain("--force-memory overrides a memory one");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("names both remedies where memory holds as well", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["sonnet", "/implement 341"], full());
		expect(r.stderr).toContain("A CPU session hold");
		expect(r.stderr).toContain("--force-memory overrides a memory one");
	});

	it("keeps the session ceiling armed under --force-memory", () => {
		stubClaude({});
		const r = run(["--force-memory", "sonnet", "/implement 341"], full());
		expect(r.stderr).toContain("A CPU session hold");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("warns, and launches, where --force-memory cannot count the sessions", () => {
		stubClaude({});
		const r = run(["--force-memory", "sonnet", "/implement 341"], {
			WFC_PS: writePsStub(fx.dir, [], { name: "ps-failing", fails: true }),
		});
		expect(r.stderr).toContain("WARNING: /implement 341");
		expect(r.stderr).toMatch(/cpu sessions\s+unknown/);
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});
});

describe("--force and --force-memory split (#299)", () => {
	/** A fresh cache with the session bar full — read by both the pre-set cap
	 * and admission.js's per-spawn 100% backstop, so a refusal from either is
	 * possible. */
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

	it("--force alone leaves the memory re-read armed", () => {
		lowMemory();
		const r = run(["--force", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("--force-memory overrides it");
		expect(readLaunches()).toHaveLength(0);
	});

	it("--force launches every member past a full session bar, not refusing each", () => {
		stubClaude({});
		const r = run(
			["--force", "sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			fullSession(),
		);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED");
		expect(readLaunches()).toHaveLength(2);
	});

	it("--force-memory alone leaves the allowance gate armed", () => {
		stubClaude({});
		const r = run(
			["--force-memory", "sonnet", "/implement 341"],
			fullSession(),
		);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("session allowance 100% used");
		expect(readLaunches()).toHaveLength(0);
	});

	it("--force-memory alone leaves the duplicate drop armed", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const r = run(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.code).toBe(4);
		expect(r.stderr).toContain("dropped: /implement 341");
		expect(r.stderr).toContain(
			"every member of this set is already dispatched",
		);
		expect(readLaunches()).toHaveLength(1);
	});

	it("--force --force-memory together skip all three gates, as the old --force did", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		run(["sonnet", "/implement 341"]);
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(
			["--force", "--force-memory", "sonnet", "/implement 341"],
			fullSession(),
		);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("REFUSED");
		expect(readLaunches()).toHaveLength(2);
	});
});

describe("the launch stagger (mantahostels#2553)", () => {
	/*
	 * THE ONE CASE ON REAL ELAPSED TIME, and the only proof the stagger is a
	 * real sleep rather than a recorded intention — every other case here runs
	 * against the stub. Its bound is a floor, so neighbour load can only push
	 * it further from failing.
	 */
	it("sleeps WFC_DISPATCH_STAGGER_SECONDS between two launches", () => {
		stubClaude({});
		const start = Date.now();
		const r = spawnSync(
			"bash",
			[SCRIPT, "sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				encoding: "utf8",
				env: baseEnv({ WFC_DISPATCH_STAGGER_SECONDS: "1" }),
			},
		);
		const elapsed = Date.now() - start;
		expect(r.status).toBe(0);
		// §X9: the stagger is a real sleep, and this floor is its one proof; load only moves it away from failing.
		expect(elapsed).toBeGreaterThanOrEqual(1000);
		// The wall-clock alone would also pass a run that slept but refused the
		// second member — both launches must actually have happened.
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(2);
	});

	/*
	 * THE DEFAULT IS MEASURED, NOT CHOSEN (mantahostels#2588; the derivation sits on
	 * STAGGER_SECONDS). The recorded argument pins it: any re-pick or a
	 * dropped sleep fails.
	 */
	it("staggers by the measured 2 seconds when nothing overrides it", () => {
		stubClaude({});
		const env = baseEnv(stubSleep());
		delete env.WFC_DISPATCH_STAGGER_SECONDS;
		const r = spawnSync(
			"bash",
			[SCRIPT, "sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{ encoding: "utf8", env },
		);
		expect(r.status).toBe(0);
		expect(sleepArgs()).toEqual(["2"]);
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(2);
	});

	/*
	 * The three cases below assert an EMPTY log, never a sub-second elapsed
	 * time, which a `sleep 0.9` would pass.
	 */
	it("never sleeps before the first launch, or after the last", () => {
		stubClaude({});
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			encoding: "utf8",
			env: baseEnv({ WFC_DISPATCH_STAGGER_SECONDS: "1", ...stubSleep() }),
		});
		expect(r.status).toBe(0);
		// An empty log also describes a run that never launched at all, so the
		// one launch has to be asserted alongside it.
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(1);
		expect(sleepArgs()).toEqual([]);
	});

	it("never sleeps under --dry-run", () => {
		stubClaude({});
		const r = spawnSync(
			"bash",
			[
				SCRIPT,
				"--dry-run",
				"sonnet",
				"/implement 341",
				"opus",
				"/wayfinder 1114",
			],
			{
				encoding: "utf8",
				env: baseEnv({ WFC_DISPATCH_STAGGER_SECONDS: "1", ...stubSleep() }),
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("would launch");
		expect(sleepArgs()).toEqual([]);
	});

	it("does not stagger a member the re-read refused", () => {
		stubClaude({
			agentsJson: agentsListing(true),
		});
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = spawnSync(
			"bash",
			[SCRIPT, "sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{
				encoding: "utf8",
				env: baseEnv({ WFC_DISPATCH_STAGGER_SECONDS: "1", ...stubSleep() }),
			},
		);
		expect(r.status).toBe(0);
		// Both members refused (memory stays low throughout), so neither pays
		// the stagger. Asserted on the refusal itself, not just the empty log:
		// a `claude` that died on launch would leave the same empty log.
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("REFUSED: /wayfinder 1114");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
		expect(sleepArgs()).toEqual([]);
	});
});

/*
 * mantahostels#2588. The re-read charges for the spare pair the daemon warms the moment
 * THIS member's launch claims its own — memory the next member of the same set
 * would otherwise find gone. `admission.js` prints that reserve on its own line,
 * and a refused member relays admission's whole output, which is where the flag
 * having reached it is observable from outside.
 */
describe("the pending-spare charge on the re-read (mantahostels#2588)", () => {
	it("relays the pending-spare reserve in a refusal, so the flag is visibly in force", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    600000 kB\n");
		const r = run(["sonnet", "/implement 341"]);
		expect(r.stderr).toContain("pending spares");
		// No idle pair is resident under the empty `ps` stub, so the measured
		// fallback is what prices it.
		expect(r.stderr).toContain("106 MB");
	});

	it("charges nothing extra under --force-memory, which re-reads the load alone", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    600000 kB\n");
		const r = run(["--force-memory", "sonnet", "/implement 341"]);
		expect(r.stderr).not.toContain("pending spares");
	});
});

/*
 * #2889. admission.js's lander read lists the suite queue under the temp root,
 * which the fixture points at its own directory: a refused member relays the
 * slot arithmetic, which names a lander's reserve only where one is queued.
 */
describe("the lander read on the re-read (#2889)", () => {
	const refused = () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    600000 kB\n");
		return run(["sonnet", "/implement 341"]).stderr;
	};

	it("reads the fixture's queue, never the machine's own landers", () => {
		expect(refused()).not.toMatch(/\d+ lander/);
	});

	it("counts a lander queued in the fixture's queue", () => {
		const queue = path.join(fx.dir, "wfc-suite-queue");
		fs.mkdirSync(queue);
		fs.writeFileSync(
			path.join(queue, `wfc-suite-queue-${process.pid}.json`),
			JSON.stringify({ pid: process.pid, at: 1, role: "lander" }),
		);
		expect(refused()).toMatch(/\d+ lander/);
	});
});

/*
 * mantahostels#2588. Both refusals here have the same likeliest cause — a slot or a ledger
 * entry held by a job that will never finish — so the route that actually
 * retires one travels with the refusal rather than behind a second command.
 */
describe("the roster remedy on a refusal (mantahostels#2588)", () => {
	it("offers the roster SIGTERM route when the re-read refuses a member", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["sonnet", "/implement 341"]);
		expect(r.stderr).toContain("check-ghost-jobs.js");
		expect(r.stderr).toContain("replPid");
		expect(r.stderr).toContain("SIGTERM");
		expect(r.stderr).toContain("roster:");
	});

	it("offers it on the already-dispatched refusal too", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const second = run(["sonnet", "/implement 341"]);
		expect(second.code).toBe(4);
		expect(second.stderr).toContain("check-ghost-jobs.js");
		expect(second.stderr).toContain("replPid");
	});

	it("names the ghost-job checker by its plugin-root path in an install (#1289)", () => {
		stubClaude({});
		const root = path.join(fx.dir, "plugins", "w f c");
		run(["sonnet", "/implement 341"]);
		const second = run(["sonnet", "/implement 341"], {
			WFC_SCRIPT_ROOT: root,
		});
		expect(second.stderr).toContain(
			`    node '${root}/scripts/check-ghost-jobs.js'\n`,
		);
	});

	it("prints it once, however many members a set refuses", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		expect(r.stderr).toContain("REFUSED: /wayfinder 1114");
		expect(r.stderr.split("check-ghost-jobs.js")).toHaveLength(2);
	});

	/*
	 * ONE REFUSAL IS UNPINNED HERE (mantahostels#2588).
	 * `refuse_dispatched` does not print the roster recipe itself; the
	 * already-dispatched call site does, because a job stuck in "working" holds
	 * its ledger entry and its issues then read as already running. The other
	 * caller — an unreadable per-member drop list — gets nothing, and that
	 * branch has no test.
	 */
	it("says nothing about a roster on a launch that is not refused", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.stderr).not.toContain("check-ghost-jobs.js");
	});

	it("names the gap rather than going quiet where no roster file exists", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			encoding: "utf8",
			// A HOME with no .claude* under it at all.
			env: { ...baseEnv(), HOME: fx.dir },
		});
		expect(r.stderr).toContain("none under");
	});

	it("lists the roster of every plan dir, .claude12 included, and of no other dir (#2580)", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const home = path.join(fx.dir, "home");
		const roster = (dir: string) =>
			path.join(home, dir, "daemon", "roster.json");
		for (const dir of [".claude", ".claude3", ".claude12", ".claude-exp-a"]) {
			fs.mkdirSync(path.dirname(roster(dir)), { recursive: true });
			fs.writeFileSync(roster(dir), "{}");
		}
		const r = run(["sonnet", "/implement 341"], { HOME: home });
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("REFUSED: /implement 341");
		for (const dir of [".claude", ".claude3", ".claude12"]) {
			expect(r.stderr).toContain(`    roster: ${roster(dir)}\n`);
		}
		expect(r.stderr).not.toContain(".claude-exp-a");
		expect(r.stderr).not.toContain("none under");
	});

	it("names an unset HOME rather than aborting the refusal (#2580)", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const env = baseEnv();
		delete env.HOME;
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			encoding: "utf8",
			env,
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("HOME unset or unreadable");
	});

	/*
	 * mantahostels#2598: a HUNG-JOB is named INLINE, off `admission.js`'s own oracle read —
	 * no second `check-ghost-jobs.js` invocation. The fixture is a
	 * "working" job listed alive with a pid, past the transcript-less window,
	 * so `lib/hung-jobs.js#findHungJobs` calls it hung rather than a ghost.
	 */
	it("names a HUNG-JOB inline, with its roster path, on a refusal (mantahostels#2598)", () => {
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

		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			encoding: "utf8",
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

	it("falls back to the second command where nothing reads as hung", () => {
		stubClaude({ agentsJson: agentsListing(true) });
		fs.writeFileSync(fx.meminfo, "MemAvailable:    10 kB\n");
		const r = run(["sonnet", "/implement 341"]);
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

	it("refuses the whole call on a stalled boot, naming the first stall's time", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			WFC_KERNEL_LOG: kernelStalled(),
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("RCU stall");
		expect(r.stderr).toContain("2026-10-07T22:43:24+08:00");
		expect(r.stderr).toContain("wsl --shutdown");
		expect(readArgvLines()).toEqual([]);
	});

	it("launches normally on a clean boot", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(launchArgv()).toBeDefined();
	});

	it("launches where the kernel log cannot be read", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], {
			WFC_KERNEL_LOG: path.join(fx.dir, "no-such-log"),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toBeDefined();
	});

	it("re-checks before each member, naming the ones already launched and --force", () => {
		stubClaude({});
		// Clean for the opening check and the first member's, stalled from the
		// second member's on.
		const calls = path.join(fx.dir, "journal-calls");
		const journal = path.join(fx.dir, "journalctl-stalls-later");
		fs.writeFileSync(
			journal,
			[
				"#!/bin/bash",
				`printf 'x' >> "${calls}"`,
				`n=$(wc -c < "${calls}")`,
				'if [ "$n" -le 2 ]; then echo "2026-10-07T22:40:00+08:00 host kernel: ok"; exit 0; fi',
				'echo "2026-10-07T22:43:24+08:00 host kernel: rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:"',
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			WFC_KERNEL_LOG: "",
			WFC_JOURNALCTL: journal,
			WFC_DMESG: path.join(fx.dir, "no-such-dmesg"),
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("1 member(s) HAD already launched");
		expect(r.stderr).toContain("/implement 341");
		expect(r.stderr).toContain("re-run with --force");
		expect(readArgvLines().filter((l) => l.includes("--bg"))).toHaveLength(1);
	});
});

describe("the scheduler-clock check (#2779)", () => {
	it("refuses the whole call on a frozen clock, naming the signal", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			WFC_SCHED_CLOCK: fx.schedClock(0),
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("SCHED-CLOCK-FROZEN");
		expect(r.stderr).not.toContain("RCU stall");
		expect(r.stderr).toContain("wsl --shutdown");
		expect(readArgvLines()).toEqual([]);
	});

	it("launches once the clock moves again", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], {
			WFC_SCHED_CLOCK: fx.schedClock(1),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toBeDefined();
	});
});

/*
 * The interop-bridge wedge (mantahostels#3111). CLAUDE_INTEROP_REG points at an executable
 * that sleeps. The budget is driven to 1s for the behavioural cases; the one
 * case that proves the SHIPPED budget clears the 45s ceiling runs at the real
 * default and pays about 36s for it (docs/environment.md §9).
 */
