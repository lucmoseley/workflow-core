// @vitest-environment node
/*
 * Pins the dispatch's allowance gate: its refusal, the cap that cuts a set to
 * what fits, its JSON source and the cheap /usage probe.
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
 * Loosen a test here and a /pick-next set launches past an allowance gate,
 * which is how the machine freezes.
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
	writeCache,
} from "./lib/dispatch-sessions-testkit";
import { printedResets } from "./lib/usage-probe-fake";

const fx = dispatchFixture();
const { stubClaude, launchArgv, readArgvLines, run } = fx;

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
			`weekly allowance 100% used (threshold 99%), resets ${printedResets.week} — the bar is full`,
		);
		expect(readLaunches()).toHaveLength(0);
	});

	it("caps on the weekly bar at its own 99% threshold", () => {
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
		stubClaude({ week: "98", session: "89" });
		const r = run(set, table());
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Allowance OK: week 98%, session 89%.");
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

	/* #3758: a plan with no 5-hour bar caches `five_hour: null` and prints no
	 * `Current session:` line; the cap runs on the weekly bar alone. */
	it("launches without --force on a fresh weekly bar where the account reports no session bar", () => {
		const configDir = path.join(fx.dir, "weekly-only-config");
		writeCache(configDir, { weeklyAll: 0 });
		stubClaude({ session: null });
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Allowance OK: week 0%, session not reported.");
		expect(launchArgv()).toBeDefined();
	});

	it("still refuses a stale weekly bar where the account reports no session bar", () => {
		const configDir = path.join(fx.dir, "weekly-only-stale-config");
		writeCache(configDir, { weeklyAll: 0 }, Date.now() - 10 * 60 * 1000);
		stubClaude({ session: null, week: "not a number" });
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_CONFIG_DIR: configDir,
		});
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("no trustworthy allowance reading");
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
