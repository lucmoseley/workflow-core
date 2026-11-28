// @vitest-environment node
import { execFileSync } from "node:child_process";
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
	ROUTING,
	SCRIPT,
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
	runCore,
	run,
} = fx;

describe("the session's directory (#4245)", () => {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

	it("starts each member in a fresh worktree detached at origin/main", async () => {
		const { main } = fx;
		stubClaude({});
		const r = await runCore([
			"sonnet",
			"/implement 341",
			"opus",
			"/wayfinder 1114",
		]);
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

	it("starts a one-member set --into an existing session worktree, cutting none (#4385)", async () => {
		stubClaude({});
		const cut = runInProcess(
			path.join(path.dirname(SCRIPT), "session-checkout.js"),
			["cut", "dead-341"],
			{ cwd: fx.dir, env: baseEnv() },
		);
		expect(cut.status, cut.stderr).toBe(0);
		const dead = cut.stdout.trim();

		const r = await runCore(["--into", dead, "opus", "/implement 343"]);

		expect(r.code, r.stderr).toBe(0);
		expect(launchCwds()).toEqual([dead]);
		expect(
			fs
				.readdirSync(path.join(fx.dir, ".claude", "worktrees"))
				.filter((d) => !d.startsWith(".")),
		).toEqual([path.basename(dead)]);
	});

	it("refuses --into for a set of more than one member, naming the member count", async () => {
		stubClaude({});
		const r = await runCore([
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

	it("refuses a refill-loop member whose lockfile has no store at once, running no install, then launches it once warmed (#4318)", async () => {
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
			WFC_NPM: npm,
			WFC_DISPATCH_NO_BUILD: "1",
		};
		const readInstalls = () => readArgvLines(installs);
		stubClaude({});

		const cold = await runCore(["sonnet", "/implement 341"], env);

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

		const warmed = await runCore(["sonnet", "/implement 341"], env);

		expect(warmed.code).toBe(0);
		expect(launchCwds()).toHaveLength(1);
		expect(readInstalls()).toHaveLength(1);
	});

	it("leaves the loop's no-build switch out of a launched session's environment (#4318)", async () => {
		const envLog = path.join(fx.dir, "launch-env");
		stubClaude({ envLog });
		await runCore(["sonnet", "/implement 342"], { WFC_DISPATCH_NO_BUILD: "1" });
		const env = fs.readFileSync(envLog, "utf8");
		expect(env).toContain("WFC_CLAUDE_BIN=");
		expect(env).not.toContain("WFC_DISPATCH_NO_BUILD");
	});

	it("leaves the dispatcher's root out of a launched session's environment, so a daemon it starts cannot hand that root to jobs in other repositories (#4595)", async () => {
		const envLog = path.join(fx.dir, "launch-env");
		stubClaude({ envLog });
		await runCore(["sonnet", "/implement 342"], {
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

	it("refuses a member it finds no directory for, naming why", async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		stubClaude({});
		const r = await fx.runCoreUnder(["sonnet", "/implement 341"], {
			cwd: outside,
			env: baseEnv(),
		});
		fs.rmSync(outside, { recursive: true });
		expect(r.code).toBe(0);
		expect(r.stderr).toContain(
			`REFUSED: /implement 341 — not launching this member.\n  session checkout: ${outside} is in no main checkout git can name — run this from inside the repository\n`,
		);
		expect(launchCwds()).toEqual([]);
	});
});

describe("the model table (lib/model-table.js, #4919), on the fixture routing file", () => {
	const burnOn = () => fs.writeFileSync(path.join(fx.dir, "burn-mode"), "");

	it("launches a member the standard row moves as the target's id with [1m], naming the remap", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341"], ROUTING);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("model table: sonnet -> test-opus-2[1m]");
		expect(launchArgv()).toContain("--model test-opus-2[1m]");
	});

	it.each([
		["opus[1m]", "opus[1m]"],
		["sonnet", "test-opus-2[1m]"],
	])(
		"launches %s by the standard row with burn mode on",
		async (spelling, to) => {
			stubClaude({});
			burnOn();
			const r = await runCore([spelling, "/wayfinder 341"], ROUTING);
			expect(r.code).toBe(0);
			expect(r.stderr).not.toContain("burn mode");
			expect(launchArgv()).toContain(`--model ${to}`);
		},
	);

	it("launches a spelling the routing file does not know as written, naming no remap", async () => {
		stubClaude({});
		burnOn();
		const r = await runCore(["claude-sonnet-4-5", "/implement 341"], ROUTING);
		expect(r.stderr).not.toContain("claude-sonnet-4-5 ->");
		expect(launchArgv()).toContain("--model claude-sonnet-4-5");
	});

	it("launches a spelling its row keeps on its own alias as written", async () => {
		stubClaude({});
		const r = await runCore(["opus[1m]", "/wayfinder 341"], ROUTING);
		expect(r.stderr).not.toContain("model table");
		expect(launchArgv()).toContain("--model opus[1m]");
	});

	it("refuses every launch where the routing file will not load", async () => {
		stubClaude({});
		const broken = path.join(fx.dir, "routing.json");
		fs.writeFileSync(broken, "{");
		const r = await runCore(["haiku", "/implement 341"], {
			WFC_MODEL_ROUTING: broken,
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("cannot read the routing file");
		expect(launchArgv()).toBe(undefined);
	});
});

describe("the WFC_CLAUDE_BIN fallback (mantahostels#1401)", () => {
	function shadowDir(): string {
		const shadow = path.join(fx.dir, "shadow");
		fs.mkdirSync(shadow);
		stubClaude({ at: path.join(shadow, "claude"), agentsJson: "[]" });
		return shadow;
	}

	it("resolves the bare `claude` default through PATH, never the founder's real CLI", async () => {
		const env = baseEnv({ PATH: `${shadowDir()}:${process.env.PATH}` });
		delete env.WFC_CLAUDE_BIN;

		const r = await fx.runCoreUnder(["--dry-run", "sonnet", "/implement 341"], {
			cwd: process.cwd(),
			env,
		});

		expect(r.code).toBe(0);
		expect(r.stdout).toContain(
			"would launch: env -u WFC_REPO_ROOT -u CLAUDE_PROJECT_DIR -u WFC_DISPATCH_ROOT claude ",
		);
		expect(readArgvLines().some((l) => l.includes("-p /usage"))).toBe(true);
		expect(readArgvLines().some((l) => l.includes("agents --json"))).toBe(true);
	});
});

describe("a launch killed from outside (#5145)", () => {
	it("reports the kill, records nothing for it, and goes on to the next member", async () => {
		stubClaude({});
		const killed = path.join(fx.dir, "killed-claude");
		fs.writeFileSync(
			killed,
			`#!/bin/bash\n[[ " $* " == *" --bg "* ]] && [[ "$*" == *"/implement 341"* ]] && kill -9 $$\nexec ${shellQuote(stubPath())} "$@"\n`,
			{ mode: 0o755 },
		);
		const r = await runCore(
			["sonnet", "/implement 341", "opus", "/wayfinder 1114"],
			{ WFC_CLAUDE_BIN: killed },
		);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain(
			"REFUSED: /implement 341 — not launching this member.\n  (claude exited 137; not recorded as launched.)",
		);
		expect(r.stderr).not.toContain("did not return within");
		expect(launchArgv()).toContain("/wayfinder 1114");
	});
});

describe("a launch the launcher refuses (#5918)", () => {
	it("carries the launcher's own line under the member's REFUSED header", async () => {
		stubClaude({});
		const refusing = path.join(fx.dir, "refusing-claude");
		fs.writeFileSync(
			refusing,
			`#!/bin/bash\n[[ " $* " == *" --bg "* ]] && { echo "Workspace not trusted."; exit 1; }\nexec ${shellQuote(stubPath())} "$@"\n`,
			{ mode: 0o755 },
		);
		const r = await runCore(["opus", "/implement 341"], {
			WFC_CLAUDE_BIN: refusing,
		});
		expect(r.stderr).toContain(
			"REFUSED: /implement 341 — not launching this member.\n  Workspace not trusted.\n  (claude exited 1; not recorded as launched.)",
		);
	});
});

describe("the WFC_CLAUDE_BIN seam (mantahostels#1374)", () => {
	it("launches through the binary WFC_CLAUDE_BIN names", async () => {
		stubClaude({});
		expect((await runCore(["sonnet", "/implement 341"])).code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("ignores a `claude` found on PATH when WFC_CLAUDE_BIN names another", async () => {
		stubClaude({});
		const shadowDir = path.join(fx.dir, "shadow");
		fs.mkdirSync(shadowDir);
		const shadowArgv = path.join(shadowDir, "argv");
		fs.writeFileSync(
			path.join(shadowDir, "claude"),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(shadowArgv)}\nprintf 'launched\\n'\n`,
			{ mode: 0o755 },
		);
		const r = await fx.runCore(
			["sonnet", "/implement 341"],
			// claude-route-exempt: #3559
			{ PATH: `${shadowDir}:${process.env.PATH}` },
		);
		expect(r.code).toBe(0);
		expect(fs.existsSync(shadowArgv)).toBe(false);
		expect(launchArgv()).toContain("--bg");
	});

	it("passes the seam down to the duplicate check it shells out to", async () => {
		stubClaude({ agentsJson: "" });
		const r = await runCore(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(readArgvLines().some((l) => l.includes("agents --json"))).toBe(true);
		expect(r.stderr).toContain(`${stubPath()} agents --json`);
	});
});

describe("the model flag", () => {
	it("passes no --model for a bare opus, keeping the configured default (mantahostels#1093)", async () => {
		stubClaude({});
		await runCore(["opus", "/wayfinder 1114"]);
		const launch = launchArgv();
		expect(launch).not.toContain("--model");
	});

	it("passes an explicit opus[1m] through verbatim", async () => {
		stubClaude({});
		await runCore(["opus[1m]", "/wayfinder 1114"]);
		const launch = launchArgv();
		expect(launch).toContain("--model opus[1m]");
	});
});

describe("the seat kind (#2605)", () => {
	const seatFile = (text: string) => {
		fs.mkdirSync(path.join(fx.dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(fx.dir, ".claude", "refill-seats"), text);
	};

	it("refuses a malformed overflow line, naming it, even on a plan seat", async () => {
		stubClaude({ session: "10" });
		seatFile("~/.claude2\n~/.claude2 api key=K grant=200\n");
		const r = await runCore(["sonnet", "/implement 341"], {
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

	it.each(REFUSED_AUTH)(
		"refuses under %s, launching nothing",
		async (name, env) => {
			stubClaude({});
			const r = await runCore(["sonnet", "/implement 341"], env);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain(`${name} is set`);
			expect(r.stderr).toContain("#2236");
			expect(launchedBg()).toBe(false);
		},
	);

	it("refuses an apiKeyHelper in the seat's settings", async () => {
		stubClaude({});
		const seat = path.join(fx.dir, "helped-seat");
		writeSeatHelper(seat);
		const r = await runCore(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: seat,
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("apiKeyHelper");
		expect(launchedBg()).toBe(false);
	});

	it.each(ADMITTED_AUTH)("launches on %s", async (_name, env) => {
		stubClaude({});
		expect((await runCore(["sonnet", "/implement 341"], env)).code).toBe(0);
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
