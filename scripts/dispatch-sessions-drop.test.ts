// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchFixture } from "./lib/dispatch-sessions-testkit";

const fx = dispatchFixture();
const { stubClaude, readArgvLines, runCore, run } = fx;

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

	it("launches the clean members instead of refusing the whole set", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const second = await runCore([
			"sonnet",
			"/implement 341",
			"opus",
			"/wayfinder 1114",
		]);
		expect(second.code).toBe(0);
		expect(readBgLaunches().filter((l) => l.includes("1114"))).toHaveLength(1);
		expect(readBgLaunches().filter((l) => l.includes("341"))).toHaveLength(1);
	});

	it("names the member it dropped, so a quieter launch is still visible", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const second = await runCore([
			"sonnet",
			"/implement 341",
			"opus",
			"/wayfinder 1114",
		]);
		expect(second.stderr).toContain("dropped: /implement 341");
		expect(second.stdout).toContain("Launching 1 of 2 set(s)");
	});

	it("records only the members it actually launched", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		await runCore(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		const issues = fs
			.readFileSync(ledgerFile(), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).issues);
		expect(issues).toEqual([[341], [1114]]);
	});

	it("drops by member, so an unrelated issue in the same prompt goes too", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const second = await runCore([
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

	it("refuses a launch prompt containing a newline, which would desync the drop list", async () => {
		stubClaude({});
		const r = await runCore(["sonnet", "/implement 341\n/wayfinder 1114"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("may not contain a newline");
	});
});
