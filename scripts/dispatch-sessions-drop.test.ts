// @vitest-environment node
/*
 * Pins the duplicate gate's per-member drop (mantahostels#1337): a set with one
 * member already dispatched launches the rest, naming the one it dropped.
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
 * Loosen a test here and a set launches an issue already dispatched, or one
 * dispatched member refuses the whole set.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from dispatch-sessions.test.ts, whose cost was pre-existing (#2413).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchFixture } from "./lib/dispatch-sessions-testkit";

const fx = dispatchFixture();
const { stubClaude, readArgvLines, run } = fx;

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
