// @vitest-environment node
/*
 * Pins each /pick-next dispatch member's advisor: which models get one, by
 * the alias the routing file reads a spelling as (the fixture's, by
 * WFC_MODEL_ROUTING), and the advisor-live check.
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
import { describe, expect, it } from "vitest";
import { dispatchFixture, ROUTING } from "./lib/dispatch-sessions-testkit";

const fx = dispatchFixture();
const { stubClaude, launchArgv, readArgvLines, run } = fx;

describe("the advisor flag", () => {
	it("attaches an Opus advisor to a launch the routing runs as Haiku (mantahostels#1102, #4919)", () => {
		stubClaude({});
		const r = run(["haiku", "/implement 341"], ROUTING);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--model haiku");
		expect(launch).toContain("--advisor opus");
	});

	it("attaches no advisor to a launch the routing moves to Opus", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], ROUTING);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--model test-opus-2[1m]");
		expect(launch).not.toContain("--advisor");
	});

	it("attaches no advisor to an Opus launch (mantahostels#1102)", () => {
		stubClaude({});
		run(["opus", "/wayfinder 1114"], ROUTING);
		const launch = launchArgv();
		expect(launch).not.toContain("--advisor");
	});

	it("honours --no-advisor", () => {
		stubClaude({});
		run(["--no-advisor", "haiku", "/implement 341"], ROUTING);
		const launch = launchArgv();
		expect(launch).toContain("--model haiku");
		expect(launch).not.toContain("--advisor");
	});

	it("honours --no-advisor on a spelling only the routing file's other names know (mantahostels#1199)", () => {
		stubClaude({});
		const r = run(["--no-advisor", "test-haiku-0", "/implement 341"], ROUTING);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--model test-haiku-0");
		expect(launch).not.toContain("--advisor");
	});

	it("takes the advisor model from WFC_DISPATCH_ADVISOR", async () => {
		stubClaude({});
		const r = await fx.runCore(["--dry-run", "haiku", "/implement 341"], {
			...ROUTING,
			WFC_DISPATCH_ADVISOR: "fable",
		});
		expect(r.code).toBe(0);
		const probe = readArgvLines().find((l) => l.includes("--debug-file"));
		expect(probe).toContain("--advisor fable");
	});
});

describe("the advisor flag — spellings by the routing file's one spelling rule (mantahostels#1199)", () => {
	it.each(["haiku[1m]", "test-haiku-1", "test-haiku-0[1m]"])(
		"attaches an advisor, and warns of none, to %s",
		(spelling) => {
			stubClaude({});
			const r = run([spelling, "/implement 341"], ROUTING);
			expect(r.code).toBe(0);
			expect(r.stderr).not.toContain("unrecognised model spelling");
			expect(launchArgv()).toContain("--advisor opus");
		},
	);

	it.each(["test-opus-1", "opusish[1m]", "test-opus-2[1m]", "test-fable-1"])(
		"attaches no advisor, and warns of none, to %s",
		(spelling) => {
			stubClaude({});
			const r = run([spelling, "/wayfinder 1114"], ROUTING);
			expect(r.code).toBe(0);
			expect(r.stderr).not.toContain("unrecognised model spelling");
			expect(launchArgv()).not.toContain("--advisor");
		},
	);

	it("attaches an advisor to an unrecognised spelling, and warns with the way out", () => {
		stubClaude({});
		const r = run(["some-future-alias", "/implement 341"], ROUTING);
		expect(r.code).toBe(0);
		const launch = launchArgv();
		expect(launch).toContain("--advisor opus");
		expect(r.stderr).toContain(
			"unrecognised model spelling(s): some-future-alias",
		);
		expect(r.stderr).toContain("`also` list in");
		expect(r.stderr).toContain("model-routing.json");
	});

	it("does not warn on a recognised spelling", () => {
		stubClaude({});
		const r = run(["sonnet", "/implement 341"], ROUTING);
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
