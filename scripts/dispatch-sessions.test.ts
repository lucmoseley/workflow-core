// @vitest-environment node
/*
 * Pins each /pick-next dispatch member's advisor: which models get one, the
 * deny-list spellings, and the advisor-live check.
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
 * Loosen a test here and a /pick-next set launches with no advisor attached,
 * with nothing in either session saying so (mantahostels#1102).
 *
 * Over the run-cost budget (base §X8 (5)): its cases are pre-existing and
 * unchanged by #4299's split, each a real dispatcher run (#2413).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dispatchFixture, SCRIPT } from "./lib/dispatch-sessions-testkit";

const fx = dispatchFixture();
const { stubClaude, baseEnv, launchArgv, readArgvLines, run } = fx;

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
			cwd: fx.dir,
			encoding: "utf8",
			env: baseEnv({ WFC_DISPATCH_ADVISOR: "fable" }),
		});
		const probe = readArgvLines().find((l) => l.includes("--debug-file"));
		expect(probe).toContain("--advisor fable");
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
