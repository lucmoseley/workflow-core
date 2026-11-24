// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	markerFrom,
	record,
	recordFailure,
	storePath,
	readMarkers,
} = require("./test-pass-marker.js");
const runMemory = require("./run-memory.js");
const { DAY_MS } = require("./retained-jsonl.js");

// #5722
const NOW = Date.parse("2026-10-24T12:00:00Z");
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
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
	it("carries the tests a touched run left to the lander (#4967)", () => {
		const scope = { touched: true, resolvedFiles: 2, modulesRun: 2 };
		expect(
			lineFor({ scope: { ...scope, leftOut: ["lib/b.test.ts"] } }).leftOut,
		).toEqual(["lib/b.test.ts"]);
		expect(lineFor({ scope: { ...scope, leftOut: [] } }).leftOut).toEqual([]);
		expect(lineFor({ scope }).leftOut).toBeNull();
	});

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
				lander: false,
				sha: SHA,
				treeAtEnd: TREE,
				argv: [],
				resolvedFiles: null,
				leftOut: null,
				touchedBase: null,
				wholeSlot: false,
				cachedFiles: null,
				ranFiles: 3,
				memory: null,
				repo: path.basename(root),
			},
			expect.objectContaining({ verdict: "red", session: null }),
		]);
	});

	it("carries the lander's mark, which runs.py reads its reruns off (#4757)", () => {
		expect(lineFor({ argv: ["--retest"], lander: true })).toMatchObject({
			kind: "named",
			lander: true,
		});
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
		const root = sandbox();
		const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
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
		[
			"lander",
			{ argv: ["--shared", "--full=push-gate"], sessionId: null, lander: true },
		],
		["full", { argv: ["--shared", "--full=push-gate"] }],
		["full", { argv: ["--full=other", "--shared"], sessionId: null }],
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

	it("counts the files the pass store cached and those the run ran (#4790)", () => {
		const scope = { modulesRun: 2, modulesTotal: 300, tests: 9, skipped: 0 };
		const cached = [
			{ file: "a.test.ts", sha: SHA, at: "2026-10-24T09:00:00.000Z" },
		];
		expect(lineFor({ scope, cached })).toMatchObject({
			cachedFiles: 1,
			ranFiles: 2,
		});
		expect(lineFor({ scope })).toMatchObject({
			cachedFiles: null,
			ranFiles: 2,
		});
	});

	it("reads a ceiling kill and a stall over the store's verdict", () => {
		expect(lineFor({ ceilingKill: true }, false).verdict).toBe("killed");
		expect(lineFor({ stalled: true }, false).verdict).toBe("stalled");
		expect(lineFor({}, false).verdict).toBe("red");
	});
	it("carries how the gate admitted a part-suite from the run file, peak and ladder alike (#5366)", () => {
		const store = sandbox();
		const peak = {
			mode: "peak",
			kind: "named",
			bucket: "1",
			p99Mb: 609,
			rungMb: 1750,
			climbMb: 120,
			samples: 683,
		} as const;
		const ladder = {
			mode: "ladder",
			cause: "thin",
			kind: "touched",
			bucket: "5-20",
			rungMb: 3650,
			climbMb: 0,
		} as const;
		for (const admission of [peak, ladder]) {
			const sampler = runMemory.startSampler(
				{
					session: "s-1",
					kind: admission.kind,
					argv: [],
					files: [],
					fileCount: 0,
					repo: "r",
					mode: admission.mode,
					admission,
				},
				{ dir: store, intervalMs: 60_000, bootId: null },
			);
			const env = { [runMemory.MEMORY_ENV]: sampler.file };
			const file = JSON.parse(fs.readFileSync(sampler.file, "utf8"));
			sampler.stop();
			expect(file.mode).toBe(admission.mode);
			const built = markerFrom(null, { head: SHA }, null, {
				admission: runMemory.readRunAdmission(env),
			});
			expect(lineFor(built).admission).toEqual(admission);
		}
		expect(
			lineFor(markerFrom(null, { head: SHA }, null, {})),
		).not.toHaveProperty("admission");
	});

	it("carries the run's pids and four peaks from the wrapper's run file, null where none was sampled (#5183)", () => {
		const store = sandbox();
		const sampler = runMemory.startSampler(
			{
				session: "s-1",
				kind: "named",
				argv: [],
				files: [],
				fileCount: 0,
				repo: "r",
			},
			{ dir: store, intervalMs: 60_000, bootId: null },
		);
		sampler.setMain(process.ppid);
		sampler.sample();
		const memory = runMemory.readRunMemory({
			[runMemory.MEMORY_ENV]: sampler.file,
		});
		sampler.stop();
		const built = markerFrom(null, { head: SHA }, null, { memory });
		const line = lineFor(built);
		expect(line.memory).toEqual(memory);
		expect(Object.keys(line.memory.peaksMiB)).toEqual([
			"wrapper",
			"main",
			"worker",
			"sum",
		]);
		expect(line.memory.pids).toMatchObject({
			wrapper: process.pid,
			main: process.ppid,
		});
		expect(line.memory.peaksMiB.wrapper).toBeGreaterThan(0);
		expect(lineFor({}).memory).toBeNull();
	});
});
