// @vitest-environment node
/*
 * run-ledger.test.ts — the 30-day test run ledger (#2824), whose `kind` and
 * `fullCause` follow #2812's `runs.py` rules.
 *
 * Every case writes through `record`/`recordFailure` under its own temp root,
 * so this checkout's real ledger is never touched.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	record,
	recordFailure,
	storePath,
	readMarkers,
} = require("./test-pass-marker.js");
const { DAY_MS } = require("./retained-jsonl.js");

const dirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const sandbox = () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")));
	dirs.push(d);
	return d;
};
const ledgerOf = (root: string) =>
	path.join(root, ".claude/tmp/markers/.test-runs.jsonl");
const read = (root: string) =>
	fs
		.readFileSync(ledgerOf(root), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

const SHA = "a".repeat(40);
const TREE = "t".repeat(40);
const marker = (over: Record<string, unknown> = {}) => ({
	sha: SHA,
	at: "2026-10-24T10:00:30.000Z",
	startedAt: "2026-10-24T10:00:00.000Z",
	durationMs: 30_000,
	treeAtEnd: TREE,
	sessionId: "s-1",
	suite: "vitest",
	argv: [],
	scope: { modulesRun: 3, modulesTotal: 300, tests: 9, skipped: 0 },
	...over,
});
const lineFor = (over: Record<string, unknown>, green = true) => {
	const root = sandbox();
	(green ? record : recordFailure)(marker(over), { root });
	const [line] = read(root);
	return line;
};

describe("the ledger beside the marker stores (#2824)", () => {
	it("writes one line for a certificate and one for a red marker", () => {
		const root = sandbox();
		expect(record(marker(), { root })).toBe(true);
		expect(recordFailure(marker({ sessionId: null }), { root })).toBe(true);
		expect(read(root)).toEqual([
			{
				startedAt: "2026-10-24T10:00:00.000Z",
				at: "2026-10-24T10:00:30.000Z",
				durationMs: 30_000,
				kind: "bare",
				verdict: "green",
				suite: "vitest",
				session: "s-1",
				sha: SHA,
				treeAtEnd: TREE,
				argv: [],
				resolvedFiles: null,
				wholeSlot: false,
				repo: path.basename(root),
			},
			expect.objectContaining({ verdict: "red", session: null }),
		]);
	});

	it("leaves no line for a refused launch, which ran nothing", () => {
		const root = sandbox();
		recordFailure(marker({ refused: true }), { root });
		expect(fs.existsSync(ledgerOf(root))).toBe(false);
	});

	it("still lands the marker where the ledger cannot be written", () => {
		const root = sandbox();
		fs.mkdirSync(ledgerOf(root), { recursive: true });
		expect(record(marker(), { root })).toBe(true);
		expect(readMarkers({ root })).toHaveLength(1);
	});

	it("still writes the ledger line where the marker store cannot be written", () => {
		const root = sandbox();
		fs.mkdirSync(storePath(root), { recursive: true });
		expect(record(marker(), { root })).toBe(false);
		expect(read(root)).toHaveLength(1);
	});

	it("drops lines past 30 days once the oldest is a day beyond", () => {
		const now = Date.parse("2026-10-24T12:00:00Z");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		const root = sandbox();
		const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();
		fs.mkdirSync(path.dirname(ledgerOf(root)), { recursive: true });
		fs.writeFileSync(
			ledgerOf(root),
			[32, 29]
				.map((d) => `${JSON.stringify({ at: ago(d), sha: SHA })}\n`)
				.join(""),
		);
		record(marker({ at: ago(0) }), { root });
		expect(read(root).map((l) => l.at)).toEqual([ago(29), ago(0)]);
	});
});

describe("a line's kind, cause and verdict (#2812 runs.py rules)", () => {
	it.each([
		["pytest", { suite: "pytest", argv: ["--full"] }],
		["lander", { argv: ["--shared", "--full=push-gate"], sessionId: null }],
		["full", { argv: ["--shared", "--full=push-gate"] }],
		[
			"full",
			{ argv: undefined, scope: { modulesRun: 270, modulesTotal: 300 } },
		],
		["full", { scope: { full: "stale-manifest" } }],
		["adopt", { argv: ["--adopt"] }],
		["changed", { argv: ["--changed"] }],
		["changed", { scope: { viaChanged: true } }],
		["named", { argv: ["--retest"] }],
		["named", { argv: ["-t", "x"] }],
		["named", { argv: ["scripts/lib/foo.test.ts"] }],
		["named", { argv: undefined, scope: { fileFilters: ["foo"] } }],
		["bare", { argv: undefined, scope: { fileFilters: [] } }],
		["bare", { argv: ["--queue"] }],
		[
			"touched",
			{
				argv: [],
				scope: { touched: true, modulesRun: 290, modulesTotal: 300 },
			},
		],
		[
			"touched",
			{
				suite: "pytest",
				scope: { touched: true, resolvedFiles: 2, modulesRun: 2 },
			},
		],
	])("kinds %s from %j", (kind, over) => {
		expect(lineFor(over).kind).toBe(kind);
	});

	it.each([
		["coverage", { argv: ["--full=coverage"] }],
		["rule-edit", { scope: { full: "flag", fullCause: "rule-edit" } }],
		["escalation:stale-manifest", { scope: { full: "stale-manifest" } }],
		["bare --full", { argv: ["--full"] }],
	])("carries the full cause %s from %j", (cause, over) => {
		expect(lineFor(over).fullCause).toBe(cause);
	});

	it("carries no full cause on a run that was not full", () => {
		expect(lineFor({ argv: ["--changed"] })).not.toHaveProperty("fullCause");
	});

	it("records the resolved file count and whether the run took the whole slot (#2931)", () => {
		const scope = { modulesRun: 3, modulesTotal: 300, tests: 9, skipped: 0 };
		expect(lineFor({ scope: { ...scope, resolvedFiles: 3 } })).toMatchObject({
			resolvedFiles: 3,
			wholeSlot: false,
		});
		expect(
			lineFor({ scope: { ...scope, resolvedFiles: 300, wholeSlot: true } }),
		).toMatchObject({ resolvedFiles: 300, wholeSlot: true });
	});

	it("reads a ceiling kill and a stall over the store's verdict", () => {
		expect(lineFor({ ceilingKill: true }, false).verdict).toBe("killed");
		expect(lineFor({ stalled: true }, false).verdict).toBe("stalled");
		expect(lineFor({}, false).verdict).toBe("red");
	});
});
