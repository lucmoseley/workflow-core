// @vitest-environment node
/*
 * Pins how a /pick-next dispatch member is launched: its directory, its model
 * flag, burn mode, the launcher binary, the seat kind and the launch's auth,
 * and the usage refusals.
 *
 * The fixture is scripts/lib/dispatch-sessions-testkit.ts's. The dispatch's
 * cases are split by subject across dispatch-sessions.test.ts (the advisor),
 * -launch (model, burn mode, launcher binary, seat, auth, usage), -allowance,
 * -duplicate, -drop (a set with one member already dispatched), -reread (the
 * per-member re-read, CPU holds, stagger, roster remedy), -overflow, -bridge
 * and -bridge-budget (the interop-bridge probe), so the forks pool runs them
 * side by side and no file holds the suite to its own length (#2413, #4299). The case that breaks the interop-probe library lives in
 * dispatch-sessions-probe-load.test.ts, as it links every file in scripts/lib
 * and so makes its file a reader of each one (#2423).
 *
 * Loosen a test here and a /pick-next set launches on `--model opus` in place
 * of the configured 1M default (mantahostels#1093), through the founder's real
 * CLI, or billed per token rather than to the seat.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from dispatch-sessions.test.ts, whose cost was pre-existing (#2413).
 * The no-build case (#4318) adds two dispatcher runs and a warm pass: it drives
 * the dispatcher against a real origin and a stub `npm`, seam 1's fixture
 * (#4229), which no in-process call reaches.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ADMITTED_AUTH,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./lib/auth-status-fake";
import {
	dispatchFixture,
	LANDING_MODULES,
	SCRIPT,
	seedLandingCheckout,
} from "./lib/dispatch-sessions-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const fx = dispatchFixture();
const {
	stubClaude,
	stubPath,
	baseEnv,
	launchArgv,
	launchCwds,
	readArgvLines,
	run,
} = fx;

describe("the session's directory (#4245)", () => {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

	it("starts each member in a fresh worktree detached at origin/main", () => {
		const main = seedLandingCheckout(fx.dir);
		stubClaude({});
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			WFC_MODULES: LANDING_MODULES,
		});
		expect(r.code).toBe(0);
		const cwds = launchCwds();
		expect(cwds).toHaveLength(2);
		expect(new Set(cwds).size).toBe(2);
		const worktrees = fs.realpathSync(
			path.join(fx.dir, ".claude", "worktrees"),
		);
		for (const [cwd, name] of [
			[cwds[0], /^implement-341-[0-9a-f]{6}$/],
			[cwds[1], /^wayfinder-1114-[0-9a-f]{6}$/],
		] as const) {
			expect(path.dirname(cwd)).toBe(worktrees);
			expect(path.basename(cwd)).toMatch(name);
			expect(git(cwd, "rev-parse", "HEAD")).toBe(main);
			expect(() => git(cwd, "symbolic-ref", "-q", "HEAD")).toThrow();
		}
		expect(git(fx.dir, "status", "--porcelain", "-uno")).toBe("");
	});

	it("starts a one-member set --into an existing session worktree, cutting none (#4385)", () => {
		seedLandingCheckout(fx.dir);
		stubClaude({});
		const env = { WFC_MODULES: LANDING_MODULES };
		const cut = runInProcess(
			path.join(path.dirname(SCRIPT), "session-checkout.js"),
			["cut", "dead-341"],
			{ cwd: fx.dir, env: baseEnv(env) },
		);
		expect(cut.status, cut.stderr).toBe(0);
		const dead = cut.stdout.trim();

		const r = run(["--into", dead, "opus", "/implement 343"], env);

		expect(r.code, r.stderr).toBe(0);
		expect(launchCwds()).toEqual([dead]);
		expect(
			fs
				.readdirSync(path.join(fx.dir, ".claude", "worktrees"))
				.filter((d) => !d.startsWith(".")),
		).toEqual([path.basename(dead)]);
	});

	it("refuses --into for a set of more than one member, naming the member count", () => {
		stubClaude({});
		const r = run([
			"--into",
			fx.dir,
			"sonnet",
			"/implement 341",
			"opus",
			"/implement 342",
		]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(
			"--into starts one session in one worktree; this set has 2 members",
		);
		expect(launchCwds()).toEqual([]);
	});

	it("refuses a refill-loop member whose lockfile has no store at once, running no install, then launches it once warmed (#4318)", () => {
		seedLandingCheckout(fx.dir);
		git(fx.dir, "checkout", "-q", "--detach", "origin/main");
		fs.writeFileSync(path.join(fx.dir, "package-lock.json"), "lock-1\n");
		git(fx.dir, "add", "package-lock.json");
		git(fx.dir, "commit", "-qm", "lockfile");
		git(fx.dir, "push", "-q", "origin", "HEAD:main");
		const installs = path.join(fx.dir, "npm-installs");
		const npm = path.join(fx.dir, "npm-stub");
		fs.writeFileSync(
			npm,
			`#!/bin/sh\nmkdir node_modules && pwd >> ${shellQuote(installs)}\n`,
		);
		fs.chmodSync(npm, 0o755);
		const env = {
			WFC_MODULES: LANDING_MODULES,
			WFC_NPM: npm,
			WFC_DISPATCH_NO_BUILD: "1",
		};
		const readInstalls = () => readArgvLines(installs);
		stubClaude({});

		const cold = run(["sonnet", "/implement 341"], env);

		expect(cold.code).toBe(0);
		expect(cold.stderr).toContain(
			"REFUSED: /implement 341 — not launching this member.\n  session checkout: no dependency store stands for this lockfile yet",
		);
		expect(readInstalls()).toEqual([]);
		expect(launchCwds()).toEqual([]);

		const warm = runInProcess(
			path.join(path.dirname(SCRIPT), "session-checkout.js"),
			["warm"],
			{ cwd: fx.dir, env: baseEnv(env) },
		);
		expect(warm.status, warm.stderr).toBe(0);
		expect(readInstalls()).toHaveLength(1);

		const warmed = run(["sonnet", "/implement 341"], env);

		expect(warmed.code).toBe(0);
		expect(launchCwds()).toHaveLength(1);
		expect(readInstalls()).toHaveLength(1);
	});

	it("leaves the loop's no-build switch out of a launched session's environment (#4318)", () => {
		const envLog = path.join(fx.dir, "launch-env");
		stubClaude({ envLog });
		run(["sonnet", "/implement 342"], { WFC_DISPATCH_NO_BUILD: "1" });
		const env = fs.readFileSync(envLog, "utf8");
		expect(env).toContain("WFC_CLAUDE_BIN=");
		expect(env).not.toContain("WFC_DISPATCH_NO_BUILD");
	});

	it("leaves the dispatcher's root out of a launched session's environment, so a daemon it starts cannot hand that root to jobs in other repositories (#4595)", () => {
		const envLog = path.join(fx.dir, "launch-env");
		stubClaude({ envLog });
		run(["sonnet", "/implement 342"], {
			WFC_REPO_ROOT: fx.dir,
			CLAUDE_PROJECT_DIR: fx.dir,
			WFC_DISPATCH_ROOT: fx.dir,
		});
		const env = fs.readFileSync(envLog, "utf8");
		expect(env).toContain("WFC_CLAUDE_BIN=");
		for (const v of [
			"WFC_REPO_ROOT",
			"CLAUDE_PROJECT_DIR",
			"WFC_DISPATCH_ROOT",
		])
			expect(env).not.toMatch(new RegExp(`^${v}=`, "m"));
	});

	it("starts the member in the checkout itself where the repository has no landing module", () => {
		stubClaude({});
		expect(run(["sonnet", "/implement 341"]).code).toBe(0);
		expect(launchCwds()).toEqual([fs.realpathSync(fx.dir)]);
	});

	it("refuses a member it finds no directory for, naming why", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		stubClaude({});
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			cwd: outside,
			encoding: "utf8",
			env: baseEnv(),
		});
		fs.rmSync(outside, { recursive: true });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			`REFUSED: /implement 341 — not launching this member.\n  session checkout: ${outside} is in no main checkout git can name — run this from inside the repository\n`,
		);
		expect(launchCwds()).toEqual([]);
	});
});

describe("burn mode (scripts/burn-mode.sh) — Sonnet launches up to Opus", () => {
	const burnOn = () => fs.writeFileSync(path.join(fx.dir, "burn-mode"), "");

	it("launches a sonnet member as the pinned Opus default, with no advisor", () => {
		stubClaude({});
		burnOn();
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("burn mode: sonnet -> claude-opus-5-5[1m]");
		const launch = launchArgv();
		expect(launch).toContain("--model claude-opus-5-5[1m]");
		expect(launch).not.toContain("--advisor");
	});

	it("says so when a spelling the table does not know launches as written", () => {
		stubClaude({});
		burnOn();
		const r = run(["claude-sonnet-4-5", "/implement 341"]);
		expect(r.stderr).toContain("burn mode: claude-sonnet-4-5 unmapped");
		expect(launchArgv()).toContain("--model claude-sonnet-4-5");
	});

	it("still passes no flag for a bare opus — the default carries the change", () => {
		stubClaude({});
		burnOn();
		run(["opus", "/wayfinder 341"]);
		expect(launchArgv()).not.toContain("--model");
	});

	it("leaves an explicit opus[1m] on Opus", () => {
		stubClaude({});
		burnOn();
		run(["opus[1m]", "/wayfinder 341"]);
		expect(launchArgv()).toContain("--model opus[1m]");
	});

	it("is inert while the marker is absent", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.stderr).not.toContain("burn mode");
		expect(launchArgv()).toContain("--model sonnet");
	});
});

describe("the WFC_CLAUDE_BIN fallback (mantahostels#1401)", () => {
	/* WFC_CLAUDE_BIN unset — every other case sets it deliberately because an
	 * unset run launches whatever `claude` PATH finds. Here that is made safe by
	 * putting a stub named exactly `claude` first on PATH, so the fallback is
	 * exercised without ever touching a real session. */
	function shadowDir(): string {
		const shadow = path.join(fx.dir, "shadow");
		fs.mkdirSync(shadow);
		stubClaude({ at: path.join(shadow, "claude"), agentsJson: "[]" });
		return shadow;
	}

	it("resolves the bare `claude` default through PATH, never the founder's real CLI", () => {
		const env = baseEnv({ PATH: `${shadowDir()}:${process.env.PATH}` });
		delete env.WFC_CLAUDE_BIN;

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{ encoding: "utf8", env },
		);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"would launch: env -u WFC_REPO_ROOT -u CLAUDE_PROJECT_DIR -u WFC_DISPATCH_ROOT claude ",
		);
		// Both probe calls (the /usage read and the duplicate gate's `agents
		// --json`) actually reached the PATH stub, not a real `claude` — proven
		// by argv content, not merely a file existing.
		expect(readArgvLines().some((l) => l.includes("-p /usage"))).toBe(true);
		expect(readArgvLines().some((l) => l.includes("agents --json"))).toBe(true);
	});
});

describe("the WFC_CLAUDE_BIN seam (mantahostels#1374)", () => {
	it("launches through the binary WFC_CLAUDE_BIN names", () => {
		stubClaude({});
		expect(run(["sonnet", "/implement 341"]).code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("ignores a `claude` found on PATH when WFC_CLAUDE_BIN names another", () => {
		stubClaude({});
		/* A launcher still resolving the bare name would record to this stub
		 * instead. Under `fx.dir`, so afterEach takes it even when an expectation
		 * below fails. */
		const shadowDir = path.join(fx.dir, "shadow");
		fs.mkdirSync(shadowDir);
		const shadowArgv = path.join(shadowDir, "argv");
		fs.writeFileSync(
			path.join(shadowDir, "claude"),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(shadowArgv)}\nprintf 'launched\\n'\n`,
			{ mode: 0o755 },
		);
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			cwd: fx.dir,
			encoding: "utf8",
			// claude-route-exempt: asserts a bare `claude` on PATH goes unread
			env: baseEnv({ PATH: `${shadowDir}:${process.env.PATH}` }),
		});
		expect(r.status).toBe(0);
		expect(fs.existsSync(shadowArgv)).toBe(false);
		expect(launchArgv()).toContain("--bg");
	});

	it("passes the seam down to the duplicate check it shells out to", () => {
		// Non-JSON here, on purpose: that is what makes the duplicate check's
		// warning echo the binary it called, which is what this case proves
		// reached the stub rather than a real `claude` (mantahostels#2553's per-member
		// re-read needs a real self-listing, so every OTHER case in this file
		// gets one from stubClaude()'s default instead).
		stubClaude({ agentsJson: "" });
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(readArgvLines().some((l) => l.includes("agents --json"))).toBe(true);
		expect(r.stderr).toContain(`${stubPath()} agents --json`);
	});
});

describe("the model flag", () => {
	it("passes no --model for a bare opus, keeping the configured default (mantahostels#1093)", () => {
		stubClaude({});
		run(["opus", "/wayfinder 1114"]);
		const launch = launchArgv();
		expect(launch).not.toContain("--model");
	});

	it("passes an explicit opus[1m] through verbatim", () => {
		stubClaude({});
		run(["opus[1m]", "/wayfinder 1114"]);
		const launch = launchArgv();
		expect(launch).toContain("--model opus[1m]");
	});
});

describe("the seat kind (#2605)", () => {
	const seatFile = (text: string) => {
		fs.mkdirSync(path.join(fx.dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(fx.dir, ".claude", "refill-seats"), text);
	};

	it("refuses a malformed overflow line, naming it, even on a plan seat", () => {
		stubClaude({ session: "10" });
		seatFile("~/.claude2\n~/.claude2 api key=K grant=200\n");
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: path.join(fx.dir, ".claude2"),
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("REFUSED: the seat file refuses");
		expect(r.stderr).toContain(
			`${path.join(fx.dir, ".claude", "refill-seats")}:2: missing cycle-day=`,
		);
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});
});

describe("the launch's auth (#2236)", () => {
	const launchedBg = () => readArgvLines().some((l) => l.includes("--bg"));

	it.each(REFUSED_AUTH)("refuses under %s, launching nothing", (name, env) => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], env);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(`${name} is set`);
		expect(r.stderr).toContain("#2236");
		expect(launchedBg()).toBe(false);
	});

	it("refuses an apiKeyHelper in the seat's settings", () => {
		stubClaude({});
		const seat = path.join(fx.dir, "helped-seat");
		writeSeatHelper(seat);
		const r = run(["sonnet", "/implement 341"], { CLAUDE_CONFIG_DIR: seat });
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("apiKeyHelper");
		expect(launchedBg()).toBe(false);
	});

	it.each(ADMITTED_AUTH)("launches on %s", (_name, env) => {
		stubClaude({});
		expect(run(["sonnet", "/implement 341"], env).code).toBe(0);
		expect(launchedBg()).toBe(true);
	});
});

describe("usage", () => {
	it("refuses an odd number of arguments, printing usage", () => {
		stubClaude({});
		const r = run(["sonnet"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("usage:");
	});
});

describe("an unknown option", () => {
	it("is refused, naming the flag, launching nothing", () => {
		stubClaude({});
		const r = run(["--no-such-flag", "341", "sonnet", "/implement 341"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("unknown option: --no-such-flag");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});
});
