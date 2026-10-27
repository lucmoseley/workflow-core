// @vitest-environment node
/*
 * Pins how a /pick-next dispatch set is launched: each member's model and
 * advisor, burn mode, the launcher binary, the allowance, memory and CPU gates,
 * the duplicate drop and the stagger.
 *
 * The fixture is scripts/lib/dispatch-sessions-testkit.ts's. The case that
 * breaks the interop-probe library lives in
 * dispatch-sessions-probe-load.test.ts, as it links every file in scripts/lib
 * and so makes its file a reader of each one (#2423).
 *
 * Loosen a test here and a /pick-next set launches with no advisor attached, or
 * on `--model opus` in place of the configured 1M default, with nothing in
 * either session saying so (mantahostels#1102, which settled both) — or past an
 * allowance, memory or CPU gate, which is how the machine freezes.
 *
 * The stagger cases (mantahostels#2553) assert on a `sleep` stubbed onto PATH
 * (#146): bash has no `sleep` builtin, so the script's own bare
 * `sleep "$STAGGER_SECONDS"` resolves through PATH like any other command. Not
 * a wall-clock ceiling: neighbour load breaches one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	agentsListing,
	dispatchFixture,
	SCRIPT,
	SELF_SESSION_ID,
} from "./lib/dispatch-sessions-testkit";
import { writePsStub } from "./lib/ps-stub";

const fx = dispatchFixture();
const { stubClaude, stubPath, baseEnv, launchArgv, readArgvLines, regWedged } =
	fx;

/**
 * A `sleep` on PATH that records its argument and returns at once (#146).
 * `sleepArgs()` reads the log back, so a stagger case asserts the exact
 * seconds the script asked for instead of an elapsed-time ceiling neighbour
 * load can breach. Returns the env overlay that puts it in front of the real
 * `sleep`.
 *
 * PATH rather than a `WFC_*` injection point like the rest of this file's
 * stubs: #146 forbids adding a seam to the dispatcher for a test's benefit,
 * and the shell's own command resolution is a seam already there. Residual —
 * every `sleep` in the process tree lands in one log with no caller recorded,
 * so a second one anywhere would break `toEqual(["2"])` naming nothing. The
 * script has exactly one.
 */
function stubSleep(): Record<string, string> {
	const binDir = path.join(fx.dir, "stub-bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		path.join(binDir, "sleep"),
		`#!/bin/bash\nprintf '%s\\n' "$*" >> "${path.join(fx.dir, "sleeps")}"\n`,
		{ mode: 0o755 },
	);
	return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
}

/** Every argument the stubbed `sleep` was called with, in order. */
function sleepArgs(): string[] {
	const log = path.join(fx.dir, "sleeps");
	if (!fs.existsSync(log)) return [];
	return fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
}

function run(
	args: string[],
	extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; code: number } {
	const r = spawnSync("bash", [SCRIPT, ...args], {
		encoding: "utf8",
		env: baseEnv(extraEnv),
	});
	return {
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		code: r.status ?? -1,
	};
}

/** A `$CLAUDE_CONFIG_DIR/.claude.json` usage cache (#280, #294) — the allowance
 * gate's primary source, and admission.js's per-spawn re-read's only one. */
function writeCache(
	configDir: string,
	bars: { session?: number; weeklyAll?: number },
	fetchedAtMs = Date.now(),
): void {
	fs.mkdirSync(configDir, { recursive: true });
	const limits = [];
	if (bars.session !== undefined) {
		limits.push({ kind: "session", percent: bars.session });
	}
	if (bars.weeklyAll !== undefined) {
		limits.push({ kind: "weekly_all", percent: bars.weeklyAll });
	}
	fs.writeFileSync(
		path.join(configDir, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: { fetchedAtMs, utilization: { limits } },
		}),
	);
}

describe("the advisor flag", () => {
	it("attaches an Opus advisor to a Sonnet launch (mantahostels#1102)", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--model sonnet");
		expect(launch).toContain("--advisor opus");
	});

	it("attaches no advisor to an Opus launch (mantahostels#1102)", () => {
		stubClaude({});
		run(["opus", "/wayfinder 1114"]);
		const launch = launchArgv();
		expect(launch).not.toContain("--advisor");
	});

	it("honours --no-advisor", () => {
		stubClaude({});
		run(["--no-advisor", "sonnet", "/implement 341"]);
		const launch = launchArgv();
		expect(launch).toContain("--model sonnet");
		expect(launch).not.toContain("--advisor");
	});

	it("honours --no-advisor on a spelling only reachable through the deny-list (mantahostels#1199)", () => {
		stubClaude({});
		const r = run(["--no-advisor", "opusplan", "/implement 341"]);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--model opusplan");
		expect(launch).not.toContain("--advisor");
	});

	it("takes the advisor model from WFC_DISPATCH_ADVISOR", () => {
		stubClaude({});
		execFileSync("bash", [SCRIPT, "--dry-run", "sonnet", "/implement 341"], {
			encoding: "utf8",
			env: baseEnv({ WFC_DISPATCH_ADVISOR: "fable" }),
		});
		const probe = readArgvLines().find((l) => l.includes("--debug-file"));
		expect(probe).toContain("--advisor fable");
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

describe("the advisor flag — deny-list spellings (mantahostels#1199)", () => {
	it("attaches an advisor to a bracketed sonnet[1m] spelling", () => {
		stubClaude({});
		const r = run(["sonnet[1m]", "/implement 341"]);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--model sonnet[1m]");
		expect(launch).toContain("--advisor opus");
	});

	it("attaches an advisor to opusplan, which runs as Sonnet", () => {
		stubClaude({});
		const r = run(["opusplan", "/implement 341"]);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--model opusplan");
		expect(launch).toContain("--advisor opus");
	});

	it.each(["claude-sonnet-5", "claude-sonnet-5-5"])(
		"attaches an advisor, and warns of none, to a full %s spelling",
		(spelling) => {
			stubClaude({});
			const r = run([spelling, "/implement 341"]);
			expect(r.code).toBe(0);
			expect(r.stderr).not.toContain("unrecognised model spelling");
			const launch = launchArgv();
			expect(launch).toContain("--advisor opus");
		},
	);

	it.each(["claude-opus-5", "claude-opus-5-5", "claude-opus-5-5[1m]"])(
		"attaches no advisor, and warns of none, to a full %s spelling",
		(spelling) => {
			stubClaude({});
			const r = run([spelling, "/wayfinder 1114"]);
			expect(r.code).toBe(0);
			expect(r.stderr).not.toContain("unrecognised model spelling");
			const launch = launchArgv();
			expect(launch).not.toContain("--advisor");
		},
	);

	it("attaches no advisor to fable", () => {
		stubClaude({});
		const r = run(["fable", "/wayfinder 1114"]);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).not.toContain("--advisor");
	});

	it("attaches an advisor to an unrecognised spelling, and warns with the way out", () => {
		stubClaude({});
		const r = run(["some-future-alias", "/implement 341"]);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--advisor opus");
		expect(r.stderr).toContain(
			"unrecognised model spelling(s): some-future-alias",
		);
		expect(r.stderr).toContain("add it to is_known_non_sonnet()");
	});

	it("does not warn on a recognised spelling", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.stderr).not.toContain("unrecognised model spelling");
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
		expect(r.stdout).toContain("would launch: claude ");
		// Both probe calls (the /usage read and the duplicate gate's `agents
		// --json`) actually reached the PATH stub, not a real `claude` — proven
		// by argv content, not merely a file existing.
		expect(readArgvLines().some((l) => l.includes("-p /usage"))).toBe(true);
		expect(readArgvLines().some((l) => l.includes("agents --json"))).toBe(true);
		expect(r.stderr).toContain("WARNING: WFC_CLAUDE_BIN is unset");
		expect(r.stderr).toContain("no-such-union-wrapper");
	});

	/* #275's sibling fix: the ca1/ca2/ca3 aliases export the union wrapper
	 * under the var's OLD name, so a session launched from them arrives with
	 * WFC_CLAUDE_BIN unset and the wrapper unreachable. Where the wrapper is on
	 * disk the script takes it rather than warning about it.
	 *
	 * Stands up a wrapper stub with its OWN argv log, so a case can prove the
	 * duplicate gate's `agents --json` reached the WRAPPER and not the `claude`
	 * on PATH — the union of one shared log cannot tell them apart. */
	function unionStub(): { path: string; argv: string } {
		const union = path.join(fx.dir, "union-wrapper");
		const argv = path.join(fx.dir, "union-argv");
		stubClaude({ at: union, agentsJson: "[]", argvLog: argv });
		return { path: union, argv };
	}

	it("takes the union wrapper when WFC_CLAUDE_BIN is unset and one is on disk", () => {
		const union = unionStub();

		const env = baseEnv({
			PATH: `${shadowDir()}:${process.env.PATH}`,
			WFC_UNION_WRAPPER: union.path,
		});
		delete env.WFC_CLAUDE_BIN;

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{ encoding: "utf8", env },
		);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`would launch: ${union.path} `);
		expect(r.stderr).not.toContain("WARNING: WFC_CLAUDE_BIN is unset");
		expect(r.stderr).toContain("NOTE:");
		expect(
			readArgvLines(union.argv).some((l) => l.includes("agents --json")),
		).toBe(true);
	});

	it("never lets the wrapper override a WFC_CLAUDE_BIN that is set", () => {
		const union = unionStub();
		stubClaude({});

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{
				encoding: "utf8",
				env: baseEnv({ WFC_UNION_WRAPPER: union.path }),
			},
		);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`would launch: ${stubPath()} `);
		expect(r.stdout).not.toContain(union.path);
		expect(r.stderr).not.toContain("NOTE:");
		expect(readArgvLines(union.argv)).toEqual([]);
	});

	/* The selection runs before the force check, so --force must still get the
	 * wrapper AND still be told it did — the announce is deliberately outside
	 * the force-guarded block for exactly this case (#275). */
	it("takes the wrapper under --force too, and still says so", () => {
		const union = unionStub();

		const env = baseEnv({
			PATH: `${shadowDir()}:${process.env.PATH}`,
			WFC_UNION_WRAPPER: union.path,
		});
		delete env.WFC_CLAUDE_BIN;

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "--force", "sonnet", "/implement 341"],
			{ encoding: "utf8", env },
		);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`would launch: ${union.path} `);
		expect(r.stderr).toContain("NOTE:");
	});

	it("warns rather than adopting a wrapper path that is not executable, naming WFC_CLAUDE_BIN as unset", () => {
		const union = path.join(fx.dir, "union-not-executable");
		fs.writeFileSync(union, "#!/bin/bash\nexit 0\n");
		fs.chmodSync(union, 0o644);

		const env = baseEnv({
			PATH: `${shadowDir()}:${process.env.PATH}`,
			WFC_UNION_WRAPPER: union,
		});
		delete env.WFC_CLAUDE_BIN;

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{ encoding: "utf8", env },
		);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("would launch: claude ");
		expect(r.stderr).toContain("WARNING: WFC_CLAUDE_BIN is unset");
	});

	/* `-x` alone is true of a directory, which would be adopted as the launch
	 * binary and break every call downstream instead of falling back (#275). */
	it("warns rather than adopting an executable DIRECTORY at the wrapper path, naming WFC_CLAUDE_BIN as unset", () => {
		const union = path.join(fx.dir, "union-dir");
		fs.mkdirSync(union);

		const env = baseEnv({
			PATH: `${shadowDir()}:${process.env.PATH}`,
			WFC_UNION_WRAPPER: union,
		});
		delete env.WFC_CLAUDE_BIN;

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{ encoding: "utf8", env },
		);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("would launch: claude ");
		expect(r.stderr).toContain("WARNING: WFC_CLAUDE_BIN is unset");
	});

	/* HOME is legitimately unset under cron and systemd. The wrapper probe
	 * dereferences it, and the script runs under `set -u`, so an unguarded
	 * expansion would abort before any gate (#275). */
	it("runs with HOME unset, falling through to the bare CLI", () => {
		const env = baseEnv({ PATH: `${shadowDir()}:${process.env.PATH}` });
		delete env.WFC_CLAUDE_BIN;
		delete env.WFC_UNION_WRAPPER;
		delete env.HOME;

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{ encoding: "utf8", env },
		);

		expect(r.stderr).not.toContain("unbound variable");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("would launch: claude ");
	});

	it("warns nothing when WFC_CLAUDE_BIN is set", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("WFC_CLAUDE_BIN is unset");
	});

	it("warns nothing under --force, which skips the check the warning is about", () => {
		const env = baseEnv({ PATH: `${shadowDir()}:${process.env.PATH}` });
		delete env.WFC_CLAUDE_BIN;

		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "--force", "sonnet", "/implement 341"],
			{ encoding: "utf8", env },
		);

		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("WFC_CLAUDE_BIN is unset");
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
			`#!/bin/bash\nprintf '%s\\n' "$*" >> "${shadowArgv}"\nprintf 'launched\\n'\n`,
			{ mode: 0o755 },
		);
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			encoding: "utf8",
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

describe("the advisor check", () => {
	it("reports the advisor live on this machine (mantahostels#1102)", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.stdout).toContain("Advisor available");
	});

	it("warns, and still launches, when the advisor did not attach (mantahostels#1102)", () => {
		stubClaude({ advisorAttaches: false });
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("the advisor is not live here");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});

	it("relays the CLI's own reason when it gave one", () => {
		stubClaude({
			advisorAttaches: false,
			advisorReason: "The model X does not support the advisor tool.",
		});
		const r = run(["sonnet", "/implement 341"]);
		expect(r.stderr).toContain("does not support the advisor tool");
	});

	it("says nothing about the advisor when no Sonnet session is in the set", () => {
		stubClaude({ advisorAttaches: false });
		const r = run(["opus", "/wayfinder 1114"]);
		expect(r.stdout).not.toContain("Advisor");
		expect(r.stderr).not.toContain("advisor");
	});
});

describe("the seat kind (#2605)", () => {
	const seatFile = (text: string) => {
		fs.mkdirSync(path.join(fx.dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(fx.dir, ".claude", "refill-seats"), text);
	};

	it("refuses a malformed overflow line, naming it, even on a plan seat", () => {
		stubClaude({ session: "10" });
		seatFile("~/.claude2\n~/.claude2-api api key=K grant=200\n");
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

describe("the allowance gate", () => {
	it("refuses once the session bar reads 100%, naming the threshold and reset time and offering --force, and launches nothing", () => {
		stubClaude({ session: "100" });
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain(
			"session allowance 100% used (threshold 90%), resets Aug 23, 11:49pm — the bar is full",
		);
		expect(r.stderr).toContain("--force to override");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});

	it("--force silences the refusal but keeps the advisor report (mantahostels#1102)", () => {
		stubClaude({ session: "99" });
		const r = run(["--force", "sonnet", "/implement 341"]);
		expect(r.code).toBe(0);
		expect(r.stdout).not.toContain("Allowance OK");
		expect(r.stdout).toContain("Advisor available");
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(true);
	});

	it("reports an unrecognised spelling even on a refused run (mantahostels#1199)", () => {
		stubClaude({ session: "100" });
		const r = run(["some-future-alias", "/implement 341"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain(
			"unrecognised model spelling(s): some-future-alias",
		);
		expect(readArgvLines().some((l) => l.includes("--bg"))).toBe(false);
	});
});

/* #371: past a threshold the set is cut to the prefix that just reaches 100%
 * of the warned bar (X, not X−1, since the reversal recorded on #371), at least one
 * while the bar reads under 100%. A $10-mean table makes a new session 4.7
 * points of the 5-hour bar and 0.25 of the week; the stub lists only this session, with no
 * transcript under the test's config dir, so it is charged that full mean. */
describe("the allowance cap (#371)", () => {
	const table = (): Record<string, string> => {
		const file = path.join(fx.dir, "cost-table.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				n: 1,
				meanUsd: 10,
				quantilesUsd: [1, 10, 30],
				tailRemainderUsd: 20,
				landedByHours: [[1, 1]],
			}),
		);
		return { WFC_SESSION_COST_TABLE: file };
	};
	const set = [
		"sonnet",
		"/implement 341",
		"opus",
		"/wayfinder 1114",
		"sonnet",
		"/implement 353",
	];
	const readLaunches = () => readArgvLines().filter((l) => l.includes("--bg"));

	it("launches the prefix that fits and names the cut tail", () => {
		// Headroom 100 − 90 − 4.7 = 5.3: two 4.7-point members reach it, so the
		// third is cut.
		stubClaude({ session: "90" });
		const r = run(set, table());
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("CAPPED: launching 2 of 3 on the session bar");
		expect(r.stderr).not.toContain("dropped: /wayfinder 1114");
		expect(r.stderr).toContain("dropped: /implement 353");
		expect(r.stdout).not.toContain("Allowance OK");
		expect(readLaunches()).toHaveLength(2);
		expect(readLaunches()[0]).toContain("/implement 341");
	});

	/* #2876: every figure on the CAPPED line comes off one jq read of the
	 * allowance JSON. A neighbour makes the running projection differ from one
	 * new session's, so a swap of the two shows. */
	it("names the binding bar's reading, the running sessions and both projections on the CAPPED line", () => {
		stubClaude({ session: "90", agentsJson: agentsListing(true) });
		const r = run(set, table());
		expect(r.stderr).toContain(
			"CAPPED: launching 1 of 3 on the session bar (90% used, 2 running session(s)\n" +
				"  projected at 9.4 more points, ~4.7 a new session).",
		);
	});

	it("refuses, exit 3, naming the weekly bar's own reset once it reads 100%", () => {
		stubClaude({ week: "100" });
		const r = run(set, table());
		expect(r.code).toBe(3);
		expect(r.stderr).toContain(
			"weekly allowance 100% used (threshold 97%), resets Aug 30, 7:59pm — the bar is full",
		);
		expect(readLaunches()).toHaveLength(0);
	});

	it("caps on the weekly bar at its own 97% threshold", () => {
		// Headroom 100 − 99 − 0.54 = 0.46: one 0.54-point member reaches it.
		stubClaude({ week: "99", session: "12" });
		const r = run(set, table());
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("CAPPED: launching 1 of 3 on the weekly bar");
		expect(r.stderr).toContain("dropped: /wayfinder 1114");
		expect(r.stderr).toContain("dropped: /implement 353");
		expect(readLaunches()).toHaveLength(1);
	});

	it("launches the whole set below both thresholds", () => {
		stubClaude({ week: "96", session: "89" });
		const r = run(set, table());
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Allowance OK: week 96%, session 89%.");
		expect(readLaunches()).toHaveLength(3);
	});

	it("launches one where the running session's projection alone passes 100% but the bar does not", () => {
		// Headroom 100 − 96 − 4.7 < 0, yet a bar at 96% still has room.
		stubClaude({ session: "96" });
		const r = run(set, table());
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("CAPPED: launching 1 of 3 on the session bar");
		expect(readLaunches()).toHaveLength(1);
	});

	it("refuses, exit 3, naming the full bar once it reads 100%", () => {
		stubClaude({ session: "100" });
		const r = run(set, table());
		expect(r.code).toBe(3);
		expect(r.stderr).toContain(
			"session allowance 100% used (threshold 90%), resets Aug 23, 11:49pm — the bar is full",
		);
		expect(r.stderr).not.toContain("projected to spend");
		expect(readLaunches()).toHaveLength(0);
	});

	it("refuses rather than guessing where the cost table is unreadable, saying the allowance cap cannot be sized and launching nothing", () => {
		stubClaude({ session: "92" });
		const r = run(set, {
			WFC_SESSION_COST_TABLE: path.join(fx.dir, "no-such-table.json"),
		});
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("the allowance cap cannot be sized");
		// #1734: an adopter has no table until it builds one, so the refusal says how.
		expect(r.stderr).toContain(
			"the session cost table is unreadable — build it: node scripts/measure-session-cost.js --write",
		);
		expect(readLaunches()).toHaveLength(0);
	});

	it("refuses rather than guessing where the running sessions cannot be listed, and launches nothing", () => {
		stubClaude({ session: "92", agentsJson: "not json" });
		const r = run(set, table());
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("running sessions unreadable");
		expect(readLaunches()).toHaveLength(0);
	});

	it("--force skips the cap and launches the whole set", () => {
		stubClaude({ session: "90" });
		const r = run(["--force", ...set], table());
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("CAPPED");
		expect(readLaunches()).toHaveLength(3);
	});
});

/* #294: the gate re-pointed at `cachedUsageUtilization` (#280), primary over
 * the printed bars. */
describe("the allowance gate's JSON source (#280, #294)", () => {
	it("reads the JSON cache over the printed bars when both are fresh", () => {
		const configDir = path.join(fx.dir, "fresh-config");
		writeCache(configDir, { session: 40, weeklyAll: 50 });
		// The stub's printed bars say 99% — if the gate used them the run would
		// refuse. The JSON cache says 40/50, so it should not.
		stubClaude({ week: "99", session: "99" });
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Allowance OK: week 50%, session 40%.");
	});

	it("falls back to the printed bars when the JSON cache is stale", () => {
		const configDir = path.join(fx.dir, "stale-config");
		writeCache(
			configDir,
			{ session: 40, weeklyAll: 50 },
			Date.now() - 10 * 60 * 1000,
		);
		stubClaude({ week: "3", session: "12" });
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Allowance OK: week 3%, session 12%.");
	});

	it("refuses with a 'transient' reading where neither source is trustworthy", () => {
		stubClaude({ week: "not a number", session: "not a number" });
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("no trustworthy allowance reading");
		expect(r.stderr).toContain("likely transient");
	});

	/* #294 "also in scope": a failed mktemp for the debug log must not turn
	 * into an allowance refusal unrelated to allowance — the JSON read is
	 * attempted whether or not the `/usage` probe ran. */
	it("still reads the JSON cache when the debug-log mktemp fails, so /usage never runs", () => {
		const fakeMktemp = path.join(fx.dir, "mktemp");
		fs.writeFileSync(
			fakeMktemp,
			'#!/bin/bash\ncase "$*" in\n  *dispatch-sessions-debug*) exit 1 ;;\n  *) exec /usr/bin/mktemp "$@" ;;\nesac\n',
			{ mode: 0o755 },
		);
		const configDir = path.join(fx.dir, "no-probe-config");
		writeCache(configDir, { session: 40, weeklyAll: 50 });
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
			PATH: `${fx.dir}:${process.env.PATH}`,
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Allowance OK: week 50%, session 40%.");
		expect(readArgvLines().some((l) => l.includes("--debug-file"))).toBe(false);
	});
});

describe("the cheap allowance probe (#2306)", () => {
	const probed = () => readArgvLines().some((l) => l.includes("-p /usage"));
	const readFileText = (name: string) =>
		fs.existsSync(path.join(fx.dir, name))
			? fs.readFileSync(path.join(fx.dir, name), "utf8").trim()
			: null;

	it("launches without probing while both cached bars are fresh", () => {
		const configDir = path.join(fx.dir, "fresh-config");
		writeCache(configDir, { session: 40, weeklyAll: 50 });
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(probed()).toBe(false);
		expect(r.stdout).toContain("Allowance OK: week 50%, session 40%.");
		expect(r.stdout).toContain("Advisor not checked: no /usage probe ran");
		expect(launchArgv()).toBeDefined();
	});

	it.each([
		["a stale", Date.now() - 10 * 60 * 1000],
		["an absent", null],
	])(
		"stops a probe on %s cache once its stamp moves, then reads the refreshed bars and the advisor line",
		(_, fetchedAtMs) => {
			const configDir = path.join(fx.dir, "refreshed-config");
			if (fetchedAtMs !== null)
				writeCache(configDir, { session: 70, weeklyAll: 80 }, fetchedAtMs);
			stubClaude({
				probeRefreshes: { configDir, session: 41, week: 51 },
				probeHangs: true,
			});
			const r = run(["sonnet", "/implement 341"], {
				CLAUDE_CONFIG_DIR: configDir,
			});
			expect(r.code).toBe(0);
			expect(probed()).toBe(true);
			expect(readFileText("probe-ended")).toBeNull();
			expect(r.stdout).toContain("Allowance OK: week 51%, session 41%.");
			expect(r.stdout).toContain("Advisor available");
		},
	);

	it("runs a probe whose stamp never moves to its end and reads its printed bars", () => {
		const configDir = path.join(fx.dir, "stuck-config");
		writeCache(
			configDir,
			{ session: 70, weeklyAll: 80 },
			Date.now() - 10 * 60 * 1000,
		);
		stubClaude({ week: "3", session: "12" });
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(readFileText("probe-ended")).toBe("ended");
		expect(r.stdout).toContain("Allowance OK: week 3%, session 12%.");
	});

	it("runs the probe with stdin at EOF and from a directory outside any repo", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		expect(readFileText("probe-stdin")).toBe("eof 1");
		const cwd = readFileText("probe-cwd") ?? "";
		const git = spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir"]);
		expect(git.status).not.toBe(0);
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

describe("the duplicate gate (mantahostels#1337)", () => {
	it("records nothing when claude refuses to start", () => {
		stubClaude({ launchFails: true });
		const r = run(["opus", "/implement 341"]);
		expect(fs.existsSync(ledger())).toBe(false);
		expect(r.stderr).toContain("not recorded as launched");
	});

	it("records the launch when claude starts", () => {
		stubClaude({});
		run(["opus", "/implement 341"]);
		expect(fs.readFileSync(ledger(), "utf8")).toContain("341");
	});

	/* mantahostels#3488: the launched job's own id, not the launcher's — the field
	 * pick-next.js reads to say whether the launch is still alive. */
	it("records the job id claude --bg printed as the ledger's jobId", () => {
		stubClaude({ launchOutput: "efbb4e5e" });
		run(["opus", "/implement 341"]);
		const rec = JSON.parse(fs.readFileSync(ledger(), "utf8").trim());
		expect(rec.jobId).toBe("efbb4e5e");
	});

	/* #27: the real line is not a bare id — `claude --bg` prints
	 * `backgrounded·<ESC>[36m<id><ESC>[39m`. */
	it("strips the colour codes and prefix real claude --bg output carries", () => {
		stubClaude({ launchOutput: "backgrounded·[36m7fb75db3[39m" });
		run(["opus", "/implement 341"]);
		const rec = JSON.parse(fs.readFileSync(ledger(), "utf8").trim());
		expect(rec.jobId).toBe("7fb75db3");
	});

	it("records the last of two id-shaped runs on the line", () => {
		stubClaude({ launchOutput: "0123abcd then 89abcdef" });
		run(["opus", "/implement 341"]);
		const rec = JSON.parse(fs.readFileSync(ledger(), "utf8").trim());
		expect(rec.jobId).toBe("89abcdef");
	});

	it("records jobId: null where the launch printed nothing on its first line", () => {
		stubClaude({ launchOutput: "" });
		run(["opus", "/implement 341"]);
		const rec = JSON.parse(fs.readFileSync(ledger(), "utf8").trim());
		expect(rec.jobId).toBeNull();
	});

	/* The stub answers `agents --json` with plain text, so the live limb fails
	 * open with a warning and these cases exercise the ledger limb alone. */
	const ledger = () =>
		path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);

	it("records each launch, so a later run can tell a plan from a launch", () => {
		stubClaude({});
		run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		const lines = fs
			.readFileSync(ledger(), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.issues)).toEqual([[341], [1114]]);
		expect(lines[0].model).toBe("sonnet");
	});

	it("refuses a second launch of an issue it already launched, naming the issue", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const again = run(["sonnet", "/implement 341"]);
		expect(again.code).toBe(4);
		expect(again.stderr).toContain("already dispatched");
		expect(again.stderr).toContain("#341");
	});

	it("launches nothing on that refusal", () => {
		/* Counts `--bg` lines, not every `claude` call: the gate's own live-oracle
		 * probe (`claude agents --json`) reaches the stub too and is recorded. */
		const launches = () =>
			fs
				.readFileSync(path.join(fx.dir, "argv"), "utf8")
				.split("\n")
				.filter((l) => l.includes("--bg")).length;
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		expect(launches()).toBe(1);
		run(["sonnet", "/implement 341"]);
		expect(launches()).toBe(1);
	});

	it("leaves an unrelated issue alone", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		expect(run(["sonnet", "/implement 999"]).code).toBe(0);
	});

	it("honours --force, which is the way back in", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		expect(run(["--force", "sonnet", "/implement 341"]).code).toBe(0);
	});

	it("reports under --dry-run but does not refuse — a preview must not hide it", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const preview = run(["--dry-run", "sonnet", "/implement 341"]);
		expect(preview.code).toBe(0);
		expect(preview.stderr).toContain("a real run would have exited 4");
		expect(preview.stdout).toContain("would launch");
	});

	it("writes no ledger entry for a --dry-run", () => {
		stubClaude({});
		run(["--dry-run", "sonnet", "/implement 341"]);
		expect(fs.existsSync(ledger())).toBe(false);
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

/* Refusal is per member, not per set — the follow-up to mantahostels#1337. */
describe("a set with one member already dispatched", () => {
	const ledgerFile = () =>
		path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);

	function readBgLaunches(): string[] {
		return readArgvLines().filter((l) => l.includes("--bg"));
	}

	it("launches the clean members instead of refusing the whole set", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const second = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		expect(second.code).toBe(0);
		expect(readBgLaunches().filter((l) => l.includes("1114"))).toHaveLength(1);
		expect(readBgLaunches().filter((l) => l.includes("341"))).toHaveLength(1);
	});

	it("names the member it dropped, so a quieter launch is still visible", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const second = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		expect(second.stderr).toContain("dropped: /implement 341");
		expect(second.stdout).toContain("Launching 1 of 2 set(s)");
	});

	it("records only the members it actually launched", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		const issues = fs
			.readFileSync(ledgerFile(), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).issues);
		expect(issues).toEqual([[341], [1114]]);
	});

	it("drops by member, so an unrelated issue in the same prompt goes too", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"]);
		const second = run([
			"sonnet",
			"/implement 341 353",
			"opus",
			"/wayfinder 1114",
		]);
		expect(second.stderr).toContain("dropped: /implement 341 353");
		expect(readBgLaunches().filter((l) => l.includes("353"))).toHaveLength(0);
	});

	it("still exits 4 when every member is already dispatched", () => {
		stubClaude({});
		run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		const again = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		expect(again.code).toBe(4);
		expect(again.stderr).toContain("every member of this set");
	});

	it("refuses a launch prompt containing a newline, which would desync the drop list", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341\n/wayfinder 1114"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("may not contain a newline");
	});
});

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
describe("the interop-bridge probe (mantahostels#3111)", () => {
	/** A reg.exe that never answers. */
	it("refuses the whole call, with the recovery text, and launches nothing", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			CLAUDE_INTEROP_REG: regWedged(),
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(r.stderr).toContain("wsl --shutdown");
		// Not one `claude` call of any kind — the probe precedes even the
		// `/usage` read, whose own 120s ceiling would otherwise set the wait.
		expect(readArgvLines()).toEqual([]);
	});

	it("records nothing to the dispatch ledger", () => {
		stubClaude({});
		run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: regWedged(),
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.existsSync(ledger)).toBe(false);
	});

	it("re-probes before each member, catching a bridge that wedges mid-set", () => {
		stubClaude({});
		// Healthy for the run's opening probe, wedged from the next call on.
		const at = path.join(fx.dir, "reg-wedges-later");
		const counter = path.join(fx.dir, "reg-calls");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> "${counter}"`,
				`n=$(wc -c < "${counter}")`,
				'if [ "$n" -le 1 ]; then exit 1; fi',
				"sleep 600",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(launchArgv()).toBeUndefined();
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.existsSync(ledger)).toBe(false);
	});

	it("refuses inside 45s at the shipped probe budget", {
		timeout: 90_000,
	}, () => {
		stubClaude({});
		const started = Date.now();
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: regWedged(),
		});
		expect(r.code).toBe(5);
		// §X9: a process timeout: the shipped probe budget is the guarantee, and it bounds a real hung child.
		expect(Date.now() - started).toBeLessThan(45_000);
	});

	// The fault mantahostels#3306 fixed: the bridge's vsock accept times out per call at
	// about 10s and the NEXT call answers normally.
	it("launches through a transient stall rather than calling it a wedge", () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-stalls-once");
		const counter = path.join(fx.dir, "reg-stall-calls");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> "${counter}"`,
				`n=$(wc -c < "${counter}")`,
				// Attempts 1 and 2 stall past the budget; attempt 3 answers.
				'if [ "$n" -le 2 ]; then sleep 600; fi',
				"exit 1",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("interop bridge is wedged");
		expect(launchArgv()).toContain("--bg");
	});

	it("launches as before on a healthy bridge, saying nothing extra", () => {
		stubClaude({});
		// A fresh allowance cache, so the per-spawn re-read (#294) has nothing
		// to warn about here — this case pins what the interop probe adds, not
		// the allowance warning line, which has its own coverage above.
		const configDir = path.join(fx.dir, "fresh-config");
		writeCache(configDir, { session: 12, weeklyAll: 3 });
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
		// Whole output, not a `not.toContain("interop")`: the probe must add
		// NOTHING to what this script already prints, and a new line worded
		// around the word would pass a substring check (mantahostels#3127). The cost is that
		// this pins the allowance and advisor lines, which nothing else pins
		// exactly — reword either and this case fails from over here.
		expect(r.stdout).toBe(
			"Allowance OK: week 3%, session 12%.\n" +
				"Advisor not checked: no /usage probe ran to report it.\n" +
				"sonnet  launched\n",
		);
		expect(r.stderr).toBe("OK: no issue in this set is already dispatched\n");
	});

	it("fails open where the probe cannot run at all", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], {
			// No such file — a non-WSL machine.
			CLAUDE_INTEROP_REG: path.join(fx.dir, "no-such-reg"),
		});
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("reads a TERM-ignoring wedge as a wedge, not as a healthy answer", () => {
		stubClaude({});
		// `timeout -k` escalates to KILL when the target ignores the TERM, and
		// that exits 137 rather than 124 — the shape a wedged bridge takes if it
		// is stuck in the kernel rather than merely slow (mantahostels#3111).
		const at = path.join(fx.dir, "reg-ignores-term");
		fs.writeFileSync(at, '#!/bin/bash\ntrap "" TERM\nsleep 600\n', {
			mode: 0o755,
		});
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("interop bridge is wedged");
		expect(readArgvLines()).toEqual([]);
	});

	it("names the members already launched when the bridge wedges mid-set", () => {
		stubClaude({});
		// Healthy for the opening probe and the first member's, wedged from the
		// third call on. The first member is launched AND recorded, so telling the
		// founder nothing was recorded would walk them into the duplicate gate on
		// a re-run (mantahostels#3111).
		const at = path.join(fx.dir, "reg-wedges-after-one");
		const counter = path.join(fx.dir, "reg-calls-2");
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf 'x' >> "${counter}"`,
				`n=$(wc -c < "${counter}")`,
				'if [ "$n" -le 2 ]; then exit 1; fi',
				"sleep 600",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341", "opus", "/wayfinder 1114"], {
			CLAUDE_INTEROP_REG: at,
			CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("1 member(s) HAD already launched");
		expect(r.stderr).toContain("/implement 341");
		expect(r.stderr).not.toContain("Nothing was recorded as dispatched");
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.readFileSync(ledger, "utf8")).toContain("/implement 341");
	});

	it("fails open where reg.exe exists but is not executable", () => {
		stubClaude({});
		const at = path.join(fx.dir, "reg-not-executable");
		fs.writeFileSync(at, "#!/bin/bash\nsleep 600\n", { mode: 0o644 });
		const r = run(["sonnet", "/implement 341"], { CLAUDE_INTEROP_REG: at });
		expect(r.code).toBe(0);
		expect(launchArgv()).toContain("--bg");
	});

	it("leaves the interactive guard a pass-through on a library that will not load", () => {
		// scripts/claude-interop-guard.sh sources the same library and defines the
		// `claude` shell function around it. A broken library must degrade it to
		// `command claude "$@"`, never to a refusal (mantahostels#3111).
		const shadow = path.join(fx.dir, "guard");
		fs.mkdirSync(path.join(shadow, "lib"), { recursive: true });
		fs.copyFileSync(
			path.resolve(__dirname, "claude-interop-guard.sh"),
			path.join(shadow, "claude-interop-guard.sh"),
		);
		fs.writeFileSync(
			path.join(shadow, "lib", "interop-probe.sh"),
			"if then fi\n",
		);
		const onPath = path.join(fx.dir, "onpath");
		fs.mkdirSync(onPath, { recursive: true });
		fs.writeFileSync(
			path.join(onPath, "claude"),
			"#!/bin/bash\nprintf 'real binary ran\\n'\n",
			{ mode: 0o755 },
		);
		const r = spawnSync(
			"bash",
			[
				"-c",
				`source "${path.join(shadow, "claude-interop-guard.sh")}"; claude --version`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: `${onPath}:${process.env.PATH}` },
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("real binary ran");
	});

	it("kills and reports a launch that hangs past the ceiling", () => {
		// Answers the `/usage` probe normally and hangs only on the spawn, so the
		// case exercises the launch ceiling rather than the 120s usage timeout.
		const at = stubPath();
		fs.writeFileSync(
			at,
			[
				"#!/bin/bash",
				`printf '%s\\n' "$*" >> "${path.join(fx.dir, "argv")}"`,
				'for a in "$@"; do',
				'  if [ "$a" = "--bg" ]; then sleep 600; fi',
				"done",
				'log=""',
				'prev=""',
				'for a in "$@"; do',
				'  if [ "$prev" = "--debug-file" ]; then log="$a"; fi',
				'  prev="$a"',
				"done",
				'if [ -n "$log" ]; then',
				'  printf "[DEBUG] [AdvisorTool] Advisor model: opus\\n" > "$log"',
				"  printf 'Current session: 12%% used · resets Aug 23, 11:49pm\\n'",
				"  printf 'Current week (all models): 3%% used · resets Aug 30, 7:59pm\\n'",
				"  exit 0",
				"fi",
				`if [ "$1" = "agents" ]; then printf '%s\\n' '${agentsListing()}'; exit 0; fi`,
				"printf 'launched\\n'",
			].join("\n"),
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341"], {
			WFC_DISPATCH_LAUNCH_TIMEOUT: "1",
		});
		expect(r.code).toBe(5);
		expect(r.stderr).toContain("did not return within 1s");
		const ledger = path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		expect(fs.existsSync(ledger)).toBe(false);
	});
});
