// @vitest-environment node
/*
 * Pins how a /pick-next dispatch set is launched: each member's model and
 * advisor, burn mode, the launcher binary, and the allowance and duplicate
 * gates.
 *
 * The fixture is scripts/lib/dispatch-sessions-testkit.ts's. The launch's
 * per-member re-read, CPU holds, stagger and roster remedy are pinned in
 * dispatch-sessions-reread.test.ts, the interop-bridge probe in
 * dispatch-sessions-bridge.test.ts: three files so a sharded run can put
 * them on different shards (#2413). The case that breaks the interop-probe
 * library lives in dispatch-sessions-probe-load.test.ts, as it links every
 * file in scripts/lib and so makes its file a reader of each one (#2423).
 *
 * Loosen a test here and a /pick-next set launches with no advisor attached, or
 * on `--model opus` in place of the configured 1M default, with nothing in
 * either session saying so (mantahostels#1102) — or past an
 * allowance gate, which is how the machine freezes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ADMITTED_AUTH,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./lib/auth-status-fake";
import {
	agentsListing,
	dispatchFixture,
	SCRIPT,
	writeCache,
} from "./lib/dispatch-sessions-testkit";
import { printedResets } from "./lib/usage-probe-fake";

const fx = dispatchFixture();
const { stubClaude, stubPath, baseEnv, launchArgv, readArgvLines, run } = fx;

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

describe("the allowance gate", () => {
	it("refuses once the session bar reads 100%, naming the threshold and reset time and offering --force, and launches nothing", () => {
		stubClaude({ session: "100" });
		const r = run(["sonnet", "/implement 341"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain(
			`session allowance 100% used (threshold 90%), resets ${printedResets.session} — the bar is full`,
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
			`weekly allowance 100% used (threshold 97%), resets ${printedResets.week} — the bar is full`,
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
			`session allowance 100% used (threshold 90%), resets ${printedResets.session} — the bar is full`,
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
