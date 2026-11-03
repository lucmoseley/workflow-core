// @vitest-environment node
/*
 * Pins lib/console-credit.js and scripts/read-console-credit.js: what a Chrome
 * child's report must hold to become a reading, the failed reads that leave the
 * last reading held, the cadence, and the figure the budget gate then gives.
 *
 * Loosen one and a sign-in page, another account's Console or a misread row
 * becomes the figure the gate spends against (#4071).
 *
 * The child is injected through main's deps, bar one run of the real entry, which
 * claude-child.js refuses for a seat that is none of this machine's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../read-console-credit.js";
import { buildAgentsBranch, buildJobRow } from "./agents-stop-fake";
import { writeClaudeStub } from "./claude-stub";
import {
	isConsoleReadDue,
	parseConsoleRead,
	planSeatOf,
	readConsoleLog,
} from "./console-credit.js";
import { writeCostTable } from "./cost-table-testkit";
import { seatBudget } from "./overflow-budget.js";
import { runInProcess } from "./run-in-process.js";

const ACCOUNT = "seat@example.com";
const ROW = {
	remainingUsd: 170.02,
	grantUsd: 200,
	grantedOn: "2026-10-28",
	expiresOn: "2099-12-01",
};
const PAGE = { page: "billing", signedInAs: ACCOUNT, credits: [ROW] };
const childSaid = (result: unknown, subtype = "success") =>
	JSON.stringify({ subtype, result });
const report = (page: object) => childSaid(JSON.stringify(page));

describe("parseConsoleRead", () => {
	it("takes the rows of a Billing page signed in to the seat's account", () => {
		expect(parseConsoleRead(report(PAGE), ACCOUNT)).toEqual({ credits: [ROW] });
	});

	it("takes the report in a fence, and any case of the email", () => {
		const fenced = childSaid(
			`\`\`\`json\n${JSON.stringify({ ...PAGE, signedInAs: "SEAT@example.com" })}\n\`\`\``,
		);
		expect(parseConsoleRead(fenced, ACCOUNT)).toEqual({ credits: [ROW] });
	});

	it("keeps only the row's four fields", () => {
		const page = { ...PAGE, credits: [{ ...ROW, note: "page text" }] };
		expect(parseConsoleRead(report(page), ACCOUNT)).toEqual({ credits: [ROW] });
	});

	it("takes a section with no rows as no credit", () => {
		expect(parseConsoleRead(report({ ...PAGE, credits: [] }), ACCOUNT)).toEqual(
			{ credits: [] },
		);
	});

	it.each<[string, string, string]>([
		["output that is no JSON", "not json", "no finished result"],
		[
			"a child stopped at its turn limit",
			childSaid("x", "error_max_turns"),
			"no finished result",
		],
		["prose around the report", childSaid("Here: {}"), "no JSON object"],
		[
			"a sign-in page",
			report({ ...PAGE, page: "sign-in" }),
			"asked for a sign-in",
		],
		[
			"a browser that will not connect",
			report({ ...PAGE, page: "no-browser" }),
			"Chrome is closed",
		],
		[
			"another page",
			report({ ...PAGE, page: "other" }),
			"did not reach the Billing page",
		],
		[
			"another account",
			report({ ...PAGE, signedInAs: "other@example.com" }),
			"another account",
		],
		[
			"no account shown",
			report({ ...PAGE, signedInAs: null }),
			"another account",
		],
		[
			"no rows field",
			report({ page: "billing", signedInAs: ACCOUNT }),
			"do not parse",
		],
		...(
			[
				["a text amount", { remainingUsd: "$170.02" }],
				["more left than granted", { remainingUsd: 201 }],
				["a negative amount", { remainingUsd: -1 }],
				["a page-format date", { expiresOn: "12/1/2026" }],
				["a date no calendar holds", { expiresOn: "2026-02-31" }],
				["an expiry before its grant", { expiresOn: "2026-10-01" }],
			] as const
		).map(
			([name, over]) =>
				[
					name,
					report({ ...PAGE, credits: [{ ...ROW, ...over }] }),
					"do not parse",
				] as [string, string, string],
		),
	])("refuses %s", (_, stdout, says) => {
		const read = parseConsoleRead(stdout, ACCOUNT);
		expect(read).toEqual({ why: expect.stringContaining(says) });
	});

	it("refuses where the seat records no account", () => {
		expect(parseConsoleRead(report(PAGE), null)).toEqual({
			why: expect.stringContaining("names no account"),
		});
	});
});

describe("isConsoleReadDue", () => {
	const Now = 1_800_000_000_000;
	const Day = 24 * 3600 * 1000;
	const key = {
		dir: "/h/.claude3-api",
		kind: "overflow" as const,
		keyVar: "K",
		grantUsd: 200,
		cycleDay: 1,
	};
	const idle = {
		fit: 40,
		headroomUsd: 170,
		settledUsd: 0,
		reservedUsd: 0,
		creditUsd: 170,
		grantUsd: 200,
		readAt: Now - Day,
		qUsd: 4,
		running: 0,
		cycleStart: 0,
		nextCycleStart: Now + Day,
		exhausted: false,
		readFailure: null,
		lastAttemptAt: null,
	};
	const seat = (over: object = {}) =>
		({
			seat: "/h/.claude3",
			weekFull: false,
			sessionFull: false,
			...over,
		}) as Parameters<typeof isConsoleReadDue>[2][number];
	const due = (over: object, plan = [seat()]) =>
		isConsoleReadDue(key, { ...idle, ...over }, plan, Now);

	it("holds off on a key out of use with credit left", () => {
		expect(due({})).toBe(false);
	});

	it.each([
		["a run is on the key", { running: 1 }],
		["the key has spent since the reading", { settledUsd: 0.5 }],
		["a credit refusal has marked it", { exhausted: true }],
		["what it holds will not fit a launch", { creditUsd: 3 }],
	])("reads where %s", (_, over) => {
		expect(due(over)).toBe(true);
	});

	it.each([
		["weekly-full", { weekFull: true }],
		["5-hour-full", { sessionFull: true }],
	])("holds off while the key's own plan seat is %s", (_, over) => {
		expect(due({ running: 1 }, [seat(over)])).toBe(false);
	});

	it("holds off where the key's plan seat is not read", () => {
		expect(due({ running: 1 }, [seat({ seat: "/h/.claude2" })])).toBe(false);
	});

	it("reads at most once in 24 hours", () => {
		expect(due({ running: 1, lastAttemptAt: Now - Day + 1 })).toBe(false);
		expect(due({ running: 1, lastAttemptAt: Now - Day })).toBe(true);
	});
});

describe("planSeatOf", () => {
	const seat = (dir: string) => ({
		dir,
		kind: "overflow" as const,
		keyVar: "K",
		grantUsd: 200,
		cycleDay: 1,
	});

	it("drops the key dir's -api", () => {
		expect(planSeatOf(seat("/h/.claude3-api"), { seats: [], errors: [] })).toBe(
			"/h/.claude3",
		);
	});

	it("names no plan for a key dir named otherwise", () => {
		expect(planSeatOf(seat("/h/.spare"), { seats: [], errors: [] })).toBeNull();
		expect(
			planSeatOf(seat("/h/.claude3"), {
				seats: [{ dir: "/h/.claude3", kind: "plan" }],
				errors: [],
			}),
		).toBe("/h/.claude3");
	});
});

describe("read-console-credit.js", () => {
	let tmp: string;
	let keyDir: string;
	let planDir: string;
	const saved = {
		home: process.env.HOME,
		refill: process.env.WFC_REFILL_DIR,
	};
	const seat = () => ({
		dir: keyDir,
		kind: "overflow" as const,
		keyVar: "WFC_TEST_KEY",
		grantUsd: 200,
		cycleDay: 1,
	});
	const logFile = () =>
		path.join(tmp, "refill", ".overflow-ledger", "WFC_TEST_KEY.console.jsonl");
	const succeeded = (stdout: string) => () => ({
		status: 0,
		stdout,
		stderr: "",
	});

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-credit-"));
		const home = path.join(tmp, "home");
		keyDir = path.join(home, ".claude3-api");
		planDir = path.join(home, ".claude3");
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.mkdirSync(keyDir);
		fs.mkdirSync(planDir);
		fs.writeFileSync(
			path.join(planDir, ".claude.json"),
			JSON.stringify({ oauthAccount: { emailAddress: ACCOUNT } }),
		);
		fs.writeFileSync(
			path.join(home, ".claude", "refill-seats"),
			`${planDir}\n~/.claude3-api api key=WFC_TEST_KEY grant=200 cycle-day=1\n`,
		);
		process.env.HOME = home;
		process.env.WFC_REFILL_DIR = path.join(tmp, "refill");
	});

	afterEach(() => {
		process.env.HOME = saved.home;
		if (saved.refill === undefined) delete process.env.WFC_REFILL_DIR;
		else process.env.WFC_REFILL_DIR = saved.refill;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("logs a good read as the key's reading, on its plan seat", () => {
		const seen: string[] = [];
		const code = main(["WFC_TEST_KEY"], {
			runChild: (dir: string) => {
				seen.push(dir);
				return succeeded(report(PAGE))();
			},
		});
		expect(code).toBe(0);
		expect(seen).toEqual([planDir]);
		const log = readConsoleLog(seat());
		expect(log.reading?.credits).toEqual([ROW]);
		expect(log.failure).toBeNull();
	});

	it.each([
		[
			"a child that fails",
			() => ({ status: 1, stdout: "", stderr: "Chrome is closed\nmore" }),
			"Chrome is closed",
		],
		[
			"a sign-in page",
			succeeded(report({ ...PAGE, page: "sign-in" })),
			"asked for a sign-in",
		],
	])("keeps the last reading through %s, and says why", (_, runChild, says) => {
		main(["WFC_TEST_KEY"], { runChild: succeeded(report(PAGE)) });
		const held = readConsoleLog(seat()).reading;
		expect(main(["WFC_TEST_KEY"], { runChild })).toBe(1);
		const log = readConsoleLog(seat());
		expect(log.reading).toEqual(held);
		expect(log.failure).toContain(says);
	});

	it("clears the failure at the next good read", () => {
		main(["WFC_TEST_KEY"], {
			runChild: () => ({ status: 1, stdout: "", stderr: "no" }),
		});
		main(["WFC_TEST_KEY"], { runChild: succeeded(report(PAGE)) });
		expect(readConsoleLog(seat()).failure).toBeNull();
	});

	it("skips a log row that holds no valid reading", () => {
		main(["WFC_TEST_KEY"], { runChild: succeeded(report(PAGE)) });
		fs.appendFileSync(
			logFile(),
			`${JSON.stringify({ at: 1, credits: [{ remainingUsd: "lots" }] })}\n`,
		);
		expect(readConsoleLog(seat()).reading?.credits).toEqual([ROW]);
	});

	it("takes a started row as an attempt, not a reading", () => {
		fs.mkdirSync(path.dirname(logFile()), { recursive: true });
		fs.writeFileSync(
			logFile(),
			`${JSON.stringify({ at: 5, started: true })}\n`,
		);
		expect(readConsoleLog(seat())).toEqual({
			reading: null,
			lastAttemptAt: 5,
			failure: null,
		});
	});

	it("refuses an unknown flag, reading nothing", () => {
		const runChild = () => {
			throw new Error("launched");
		};
		expect(main(["WFC_TEST_KEY", "--force"], { runChild })).toBe(2);
		expect(fs.existsSync(logFile())).toBe(false);
	});

	it("refuses a seat that is no overflow key, logging nothing", () => {
		const r = runInProcess(
			path.join(__dirname, "..", "read-console-credit.js"),
			[planDir],
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no overflow seat");
		expect(fs.existsSync(logFile())).toBe(false);
	});

	it("gives the gate the anchored figure, and the failure, through seatBudget", () => {
		const root = path.join(tmp, "checkout");
		writeCostTable(root);
		main(["WFC_TEST_KEY"], { runChild: succeeded(report(PAGE)) });
		main(["WFC_TEST_KEY"], {
			runChild: () => ({ status: 1, stdout: "", stderr: "Chrome is closed" }),
		});
		const claude = path.join(tmp, "claude");
		writeClaudeStub(claude, [
			buildAgentsBranch([buildJobRow("a-neighbour", "working")]),
		]);
		vi.stubEnv("WFC_CLAUDE_BIN", claude);
		vi.stubEnv("WFC_DISPATCH_ROOT", root);
		const budget = seatBudget(seat(), root);
		vi.unstubAllEnvs();
		expect(budget).toMatchObject({
			creditUsd: 170.02,
			headroomUsd: 170.02,
			readFailure: expect.stringContaining("Chrome is closed"),
		});
	});

	it("logs the real child's failure as a failed read", () => {
		const r = runInProcess(
			path.join(__dirname, "..", "read-console-credit.js"),
			["WFC_TEST_KEY"],
			{
				env: {
					...process.env,
					CLAUDE_CONFIG_DIR: planDir,
					WFC_CLAUDE_BIN: path.join(tmp, "no-such-claude"),
				},
			},
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Chrome child failed");
		expect(readConsoleLog(seat()).failure).toContain("Chrome child failed");
	});
});
