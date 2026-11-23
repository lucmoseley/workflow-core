// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubLaunch } from "./suite-handoff-testkit";
import {
	attestationOf,
	attestedReading,
	EDGES_FILE,
	FAIL_STORE,
	FULL_REASONS,
	failureRecoveryCommand,
	formatCachedClause,
	formatFilteredRun,
	holdsTestByTree,
	isAdmissibleRun,
	isFullRun,
	KEEP,
	markerFrom,
	readFailures,
	readMarkers,
	record,
	recordFailure,
	storePath,
	suiteOf,
} from "./test-pass-marker.js";

const dirs: string[] = [];

function sandbox() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marker-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const fullScope = (over: Record<string, unknown> = {}) => ({
	modulesRun: 123,
	modulesTotal: 123,
	tests: 900,
	passed: 890,
	skipped: 10,
	failed: 0,
	nameFilter: null,
	fileFilters: [],
	...over,
});

const redScope = (
	failures: { file: string; tests: string[] }[],
	over: Record<string, unknown> = {},
) => ({
	modulesRun: 40,
	modulesTotal: 40,
	tests: 200,
	skipped: 0,
	failures,
	...over,
});

const fresh = () => new Date().toISOString();

const ARCHIVE_REACH_MS = 7 * 24 * 60 * 60 * 1000;

const archivePath = (root: string, store?: string) =>
	storePath(root, store).replace(/\.jsonl$/, ".archive.jsonl");

const readArchivedShas = (root: string, store?: string) =>
	fs
		.readFileSync(archivePath(root, store), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l).sha);

const certificate = (over: Record<string, unknown> = {}) => ({
	sha: "a".repeat(40),
	at: "2026-08-21T08:00:00.000Z",
	dirtyAtStart: false,
	dirtyCount: 0,
	headMovedDuringRun: false,
	foreign: [],
	scope: fullScope(),
	...over,
});

const unscoped = (over: Record<string, unknown> = {}) => {
	const { scope: _scope, ...rest } = certificate(over);
	return rest;
};

const narrowed = (over: Record<string, unknown> = {}) =>
	certificate({
		scope: fullScope({
			modulesRun: 1,
			tests: 8,
			passed: 1,
			skipped: 7,
			nameFilter: "/ref/",
			fileFilters: ["scripts/check-test-marker.test.ts"],
			...over,
		}),
	});

describe("the store", () => {
	it("round-trips a certificate", () => {
		const root = sandbox();
		expect(record(certificate(), { root })).toBe(true);
		expect(readMarkers({ root })).toEqual([certificate()]);
	});

	it("appends rather than replacing, so a second suite's certificate survives", () => {
		const root = sandbox();
		record(certificate(), { root });
		record(certificate({ sha: "b".repeat(40) }), { root });
		expect(readMarkers({ root }).map((m) => m.sha)).toEqual([
			"a".repeat(40),
			"b".repeat(40),
		]);
	});

	it("skips a torn line instead of throwing on it", () => {
		const root = sandbox();
		record(certificate(), { root });
		fs.appendFileSync(storePath(root), '{"sha":"trunc\n');
		record(certificate({ sha: "c".repeat(40) }), { root });
		expect(readMarkers({ root }).map((m) => m.sha)).toEqual([
			"a".repeat(40),
			"c".repeat(40),
		]);
	});

	it("drops a line carrying no sha — a certificate that names no commit attests nothing", () => {
		const root = sandbox();
		fs.writeFileSync(storePath(root), '{"at":"now"}\n[]\nnull\n');
		expect(readMarkers({ root })).toEqual([]);
	});

	it("reads an absent store as no certificates, never as an error", () => {
		expect(readMarkers({ root: sandbox() })).toEqual([]);
		expect(readMarkers({ root: null })).toEqual([]);
	});

	it("refuses to write a certificate with no sha, and never throws on an unwritable store", () => {
		const root = sandbox();
		expect(record(certificate({ sha: null }), { root })).toBe(false);
		expect(record(certificate(), { root: null })).toBe(false);
		const blocked = sandbox();
		fs.mkdirSync(storePath(blocked));
		expect(record(certificate(), { root: blocked })).toBe(false);
	});

	it("prunes to the newest KEEP once past the threshold", () => {
		const root = sandbox();
		for (let i = 0; i < 12; i++)
			record(certificate({ sha: String(i).padStart(40, "0") }), {
				root,
				pruneAt: 10,
				keep: 4,
			});
		const shas = readMarkers({ root }).map((m) => m.sha);
		expect(shas).toEqual(
			[7, 8, 9, 10, 11].map((i) => String(i).padStart(40, "0")),
		);
	});

	it("holds 800 lines by default, and prunes to KEEP as the 801st lands", () => {
		const root = sandbox();
		const line = (i: number) =>
			JSON.stringify(
				certificate({ sha: String(i).padStart(40, "0"), at: fresh() }),
			);
		fs.writeFileSync(
			storePath(root),
			`${Array.from({ length: 799 }, (_, i) => line(i)).join("\n")}\n`,
		);
		record(certificate({ sha: "e".repeat(40), at: fresh() }), { root });
		expect(readMarkers({ root })).toHaveLength(800);
		record(certificate({ sha: "f".repeat(40), at: fresh() }), { root });
		const kept = readMarkers({ root });
		expect(kept).toHaveLength(KEEP);
		expect(kept.at(-1)?.sha).toBe("f".repeat(40));
		expect(KEEP).toBeLessThan(800);
	});

	it("moves what a prune drops into the archive (#1231)", () => {
		const root = sandbox();
		for (let i = 0; i < 12; i++)
			record(certificate({ sha: String(i).padStart(40, "0"), at: fresh() }), {
				root,
				pruneAt: 10,
				keep: 4,
			});
		const archived = readArchivedShas(root);
		expect(archived).toEqual(
			[0, 1, 2, 3, 4, 5, 6].map((i) => String(i).padStart(40, "0")),
		);
	});

	it("drops archived runs older than the archive's reach, and lines with no readable time", () => {
		const root = sandbox();
		const stale = new Date(
			Date.now() - ARCHIVE_REACH_MS - 60_000,
		).toISOString();
		const lastDay = new Date(
			Date.now() - ARCHIVE_REACH_MS + 60_000,
		).toISOString();
		fs.writeFileSync(
			archivePath(root),
			`${JSON.stringify(certificate({ sha: "a".repeat(40), at: stale }))}\nnot json\n${JSON.stringify(certificate({ sha: "9".repeat(40), at: lastDay }))}\n${JSON.stringify(certificate({ sha: "b".repeat(40), at: fresh() }))}\n`,
		);
		for (let i = 0; i < 3; i++)
			record(certificate({ sha: String(i).repeat(40), at: fresh() }), {
				root,
				pruneAt: 2,
				keep: 1,
			});
		const archived = readArchivedShas(root);
		expect(archived).toEqual([
			"9".repeat(40),
			"b".repeat(40),
			"0".repeat(40),
			"1".repeat(40),
		]);
	});

	it("archives the red store under its own name", () => {
		const root = sandbox();
		for (let i = 0; i < 4; i++)
			recordFailure(
				{ sha: String(i).repeat(40), at: fresh() },
				{
					root,
					pruneAt: 3,
					keep: 2,
				},
			);
		expect(readArchivedShas(root, FAIL_STORE)).toEqual([
			"0".repeat(40),
			"1".repeat(40),
		]);
		expect(fs.existsSync(archivePath(root))).toBe(false);
	});

	it("keeps one copy of a run two racing prunes both archive", () => {
		const root = sandbox();
		const line = JSON.stringify(
			certificate({ sha: "c".repeat(40), at: fresh() }),
		);
		fs.writeFileSync(storePath(root), `${line}\n${line}\n`);
		fs.writeFileSync(archivePath(root), `${line}\n`);
		record(certificate({ sha: "d".repeat(40), at: fresh() }), {
			root,
			pruneAt: 2,
			keep: 1,
		});
		expect(readArchivedShas(root)).toEqual(["c".repeat(40)]);
	});

	it("leaves the store unpruned, and still reports the run landed, when the archive cannot be written", () => {
		const root = sandbox();
		fs.mkdirSync(archivePath(root), { recursive: true });
		const landed = [0, 1, 2].map((i) =>
			record(certificate({ sha: String(i).repeat(40), at: fresh() }), {
				root,
				pruneAt: 2,
				keep: 1,
			}),
		);
		expect(landed).toEqual([true, true, true]);
		expect(readMarkers({ root })).toHaveLength(3);
	});
});

const warnsDirty = (marker: Record<string, unknown>) =>
	attestedReading("a".repeat(40), {
		suite: "vitest",
		attested: true,
		members: [{ marker, match: { by: "sha" } }],
		note: null,
	} as unknown as Parameters<typeof attestedReading>[1]).includes("dirty tree");

describe("what counts as a clean certificate", () => {
	it("is a run over a still tree and nothing else", () => {
		expect(warnsDirty(certificate())).toBe(false);
		expect(warnsDirty(certificate({ dirtyAtStart: true }))).toBe(true);
		expect(warnsDirty(certificate({ headMovedDuringRun: true }))).toBe(true);
		expect(
			warnsDirty(certificate({ foreign: [{ path: "a.ts", why: "x" }] })),
		).toBe(true);
		expect(warnsDirty(certificate({ startStateUnknown: true }))).toBe(true);
	});
});

describe("what counts as the whole suite (mantahostels#1230)", () => {
	it("accepts a run that collected every module in the corpus", () => {
		expect(isFullRun(certificate())).toBe(true);
	});

	it("ignores skipped tests, which a conditional skip makes normal", () => {
		expect(isFullRun(certificate({ scope: fullScope({ skipped: 400 }) }))).toBe(
			true,
		);
	});

	it("rejects a name filter even where every module was collected", () => {
		expect(
			isFullRun(certificate({ scope: fullScope({ nameFilter: "/ref/" }) })),
		).toBe(false);
	});

	it("rejects a path filter even where every module was collected", () => {
		expect(
			isFullRun(
				certificate({ scope: fullScope({ fileFilters: ["a.test.ts"] }) }),
			),
		).toBe(false);
	});

	it("rejects a run short of the corpus", () => {
		expect(
			isFullRun(certificate({ scope: fullScope({ modulesRun: 122 }) })),
		).toBe(false);
	});

	it("rejects a zero corpus, which means the glob never resolved", () => {
		expect(
			isFullRun(
				certificate({ scope: fullScope({ modulesRun: 0, modulesTotal: 0 }) }),
			),
		).toBe(false);
	});

	it("rejects a certificate that carries no scope (mantahostels#1230)", () => {
		expect(isFullRun(unscoped())).toBe(false);
	});
});

describe("a diff-selected run's certificate (mantahostels#2031)", () => {
	const changedRun = (ref: string | boolean = "HEAD~1") =>
		certificate({
			scope: fullScope({
				modulesRun: 3,
				tests: 40,
				passed: 40,
				skipped: 0,
				changed: ref,
			}),
		});

	it("still fails the full-run check, which mantahostels#2031 does not reverse", () => {
		expect(isFullRun(changedRun())).toBe(false);
	});

	it("rejects a --changed run that reached every module, on provenance", () => {
		expect(
			isFullRun(certificate({ scope: fullScope({ changed: "HEAD~1" }) })),
		).toBe(false);
	});
});

describe("both suites answer for themselves (mantahostels#1256)", () => {
	it("reads a certificate carrying no suite as vitest, so pre-mantahostels#1256 lines still count", () => {
		expect(suiteOf(certificate())).toBe("vitest");
	});
});

describe("what a session reads off an attested suite", () => {
	const attestedSha = "a".repeat(40);
	type Suite = Parameters<typeof attestedReading>[1];
	const attested = (members: unknown[], note: string | null = null) =>
		({ suite: "vitest", attested: true, members, note }) as unknown as Suite;
	const bySha = (over: Record<string, unknown> = {}) => ({
		marker: certificate(over),
		match: { by: "sha" },
	});

	it("names the attesting runs", () => {
		const text = attestedReading(attestedSha, attested([bySha({ at: "T1" })]));
		expect(text).toContain("✓  VITEST: 1 certificate(s) attest the range:");
		expect(text).toContain(`T1 on ${attestedSha.slice(0, 12)} — full run`);
	});

	it("says it judged only what the run would test where narrowed, and calls reds runs on record", () => {
		const text = attestedReading(attestedSha, attested([bySha()]), {
			narrowed: true,
			redsAmongMembers: true,
		});
		expect(text).toContain(
			"✓  VITEST: 1 run(s) on record decide every file this run would test:",
		);
	});

	it("passes a tree match's note through, and warns where a member matched by sha read a dirty tree", () => {
		const note = "ℹ  vitest: attested by tree x\n";
		const tree = attestedReading(
			attestedSha,
			attested(
				[
					{
						marker: certificate({ dirtyAtStart: true }),
						match: { by: "tree", tree: "x", closureSize: "*" },
					},
				],
				note,
			),
		);
		expect(tree).toContain(note);
		expect(tree).not.toContain("dirty tree");
		const dirty = attestedReading(
			attestedSha,
			attested([bySha({ dirtyAtStart: true, dirtyCount: 2 })]),
		);
		expect(dirty).toContain("dirty tree: the vitest certificate on");
	});
});

describe("the line a narrowed run prints for itself (mantahostels#1230)", () => {
	it("prints nothing for a full run", () => {
		expect(formatFilteredRun(fullScope())).toBeNull();
	});

	it("prints nothing where the reporter could not describe the run", () => {
		expect(formatFilteredRun(null)).toBeNull();
	});

	it("calls a zero corpus filtered, agreeing with isFullRun", () => {
		expect(
			formatFilteredRun(fullScope({ modulesRun: 0, modulesTotal: 0 })),
		).toContain("FILTERED RUN");
	});

	it("names the corpus denominator vitest's own summary does not", () => {
		expect(
			formatFilteredRun(
				fullScope({
					modulesRun: 1,
					tests: 8,
					passed: 1,
					skipped: 7,
					nameFilter: "/ref/",
					fileFilters: ["scripts/check-test-marker.test.ts"],
				}),
			),
		).toBe(
			"FILTERED RUN — ran 1 of 8 tests in 1 of 123 files; 7 skipped; -t /ref/; paths: scripts/check-test-marker.test.ts",
		);
	});

	it("speaks for a path-only run, with no name filter to name", () => {
		const line = formatFilteredRun(
			fullScope({
				modulesRun: 2,
				tests: 40,
				skipped: 0,
				fileFilters: ["a.test.ts", "b.test.ts"],
			}),
		) as string;
		expect(line).toContain("in 2 of 123 files");
		expect(line).not.toContain("skipped");
		expect(line).not.toContain("-t ");
	});

	it("names no cached clause where nothing was cached", () => {
		expect(formatCachedClause([])).toBeNull();
	});

	it("names the files the pass store cached, which neither count nor paths carry (#4894)", () => {
		const line = formatFilteredRun(
			fullScope({
				modulesRun: 1,
				tests: 5,
				skipped: 0,
				fileFilters: ["a.test.ts"],
			}),
			["b.test.ts", "c.test.ts"],
		) as string;
		expect(line).toContain("in 1 of 123 files; paths: a.test.ts");
		expect(line).toContain("2 cached, not run");
		expect(line).toContain("b.test.ts, c.test.ts");
	});
});

describe("markerFrom", () => {
	const after = { head: "f".repeat(40), files: {} };

	it("stamps the sha the run finished on and calls a still tree clean", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null);

		expect(m.sha).toBe("f".repeat(40));
		expect(m.suite).toBe("vitest");
		expect(m.dirtyAtStart).toBe(false);
		expect(m.dirtyCount).toBe(0);
		expect(m.headMovedDuringRun).toBe(false);
		expect(m.foreign).toEqual([]);
	});

	it("carries the launching session's id and its full argv (#182)", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			sessionId: "sess-launch",
			argv: ["--full=coverage"],
		});

		expect(m.sessionId).toBe("sess-launch");
		expect(m.argv).toEqual(["--full=coverage"]);
	});

	it("reads no launch argv off the environment, the launch record being the teardown's to pass (#1491)", () => {
		stubLaunch({ argv: ["--full=coverage"] });
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			sessionId: null,
		});
		expect(m).not.toHaveProperty("argv");
	});

	it("carries neither field where neither is known", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			sessionId: null,
			argv: null,
		});

		expect(m).not.toHaveProperty("sessionId");
		expect(m).not.toHaveProperty("argv");
	});

	it("marks a run the lander started, and only that run (#4757)", () => {
		const of = (lander: boolean) =>
			markerFrom({ head: "old", files: {} }, after, null, { lander });
		expect(of(true).lander).toBe(true);
		expect(of(false)).not.toHaveProperty("lander");
	});

	it("carries the run's slowest files where it timed any, and no field where it timed none (#2770)", () => {
		const slowest = [{ file: "scripts/a.test.ts", seconds: 12.5 }];
		expect(
			markerFrom({ head: "old", files: {} }, after, null, { slowest }).slowest,
		).toEqual(slowest);
		expect(
			markerFrom({ head: "old", files: {} }, after, null, { slowest: [] }),
		).not.toHaveProperty("slowest");
	});

	it("counts what was already uncommitted when the run began", () => {
		const m = markerFrom(
			{ head: "old", files: { "a.ts": "h1", "b.ts": "h2" } },
			after,
			null,
		);

		expect(m.dirtyAtStart).toBe(true);
		expect(m.dirtyCount).toBe(2);
	});

	it("records when the run began and how long it took (lucmoseley/mantahostels#1953)", () => {
		const startedAtMs = Date.parse("2026-10-17T06:00:00Z");
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs,
			endedAtMs: startedAtMs + 5000,
			elapsedMs: 5000,
		});

		expect(m.startedAt).toBe(new Date(startedAtMs).toISOString());
		expect(m.durationMs).toBe(5000);
	});

	it("takes the run's duration from its monotonic span, not the wall clocks either side of a suspend (#2829)", () => {
		const startedAtMs = Date.parse("2026-10-24T03:00:28.840Z");
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs,
			endedAtMs: Date.parse("2026-10-24T03:24:05.144Z"),
			elapsedMs: 394_070,
		});

		expect(m.durationMs).toBe(394_070);
		expect(m.at).toBe("2026-10-24T03:24:05.144Z");
	});

	it("leaves BOTH time fields off where the caller had no start time", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null);

		expect(m).not.toHaveProperty("startedAt");
		expect(m).not.toHaveProperty("durationMs");
	});

	it("treats an unreadable start time as unknown rather than as an instant run", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
			const m = markerFrom({ head: "old", files: {} }, after, null, {
				startedAtMs: bad as number | null,
				elapsedMs: 5000,
			});

			expect(m).not.toHaveProperty("startedAt");
			expect(m).not.toHaveProperty("durationMs");
		}
	});

	it("treats an unreadable span as unknown, leaving the start off with it", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
			const m = markerFrom({ head: "old", files: {} }, after, null, {
				startedAtMs: Date.now() - 5000,
				elapsedMs: bad as number | null,
			});

			expect(m).not.toHaveProperty("startedAt");
			expect(m).not.toHaveProperty("durationMs");
		}
	});

	it("records nothing where the wall clock went backwards, whatever the span", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs: Date.now() + 60_000,
			elapsedMs: 5000,
		});

		expect(m).not.toHaveProperty("durationMs");
		expect(m).not.toHaveProperty("startedAt");
	});

	it("records nothing for a negative span", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs: Date.now() - 5000,
			elapsedMs: -1,
		});

		expect(m).not.toHaveProperty("durationMs");
		expect(m).not.toHaveProperty("startedAt");
	});

	const cpuBracket = (jiffies: Record<string, number>, load1 = 3.5) => {
		const fields = [
			"user",
			"nice",
			"system",
			"idle",
			"iowait",
			"irq",
			"softirq",
			"steal",
		];
		const filled: Record<string, number> = {};
		let total = 0;
		for (const f of fields) {
			filled[f] = jiffies[f] ?? 0;
			total += filled[f];
		}
		return { jiffies: filled, total, load1 };
	};

	it("records the CPU the run actually competed for", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs: Date.now() - 5000,
			machineStart: cpuBracket({}),
			machineEnd: cpuBracket(
				{ system: 400, nice: 200, user: 100, idle: 300 },
				27.5,
			),
			endedAtMs: Date.now(),
		});

		const machine = m.machine;
		if (!machine) throw new Error("expected a machine block");
		const ceiling = machine.ceilingPct;
		expect(machine.busyPct).toBeCloseTo(ceiling * 0.7, 1);
		expect(machine.systemPct).toBeCloseTo(ceiling * 0.4, 1);
		expect(machine.nicePct).toBeCloseTo(ceiling * 0.2, 1);
		expect(machine.userPct).toBeCloseTo(ceiling * 0.1, 1);
		expect(machine.load1).toBe(27.5);
	});

	it("leaves the block off where either bracket is missing", () => {
		const startedAtMs = Date.now() - 5000;
		const before = { head: "old", files: {} };

		expect(
			markerFrom(before, after, null, {
				startedAtMs,
				machineEnd: cpuBracket({ idle: 100 }),
				endedAtMs: Date.now(),
			}),
		).not.toHaveProperty("machine");
		expect(
			markerFrom(before, after, null, {
				startedAtMs,
				machineStart: cpuBracket({ idle: 100 }),
				endedAtMs: Date.now(),
			}),
		).not.toHaveProperty("machine");
	});

	it("records absence, not a zero, where the two brackets cannot be differenced", () => {
		const same = cpuBracket({ idle: 500 });
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs: Date.now() - 5000,
			machineStart: same,
			machineEnd: same,
			endedAtMs: Date.now(),
		});

		expect(m).not.toHaveProperty("machine");
	});

	it("times the run the caller ended, not the moment the marker was written", () => {
		const startedAtMs = Date.now() - 600_000;
		const endedAtMs = startedAtMs + 5000;
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs,
			endedAtMs,
			elapsedMs: 5000,
		});

		expect(m.durationMs).toBe(5000);
		expect(m.at).toBe(new Date(endedAtMs).toISOString());
	});

	it("flags a start state git would not answer for, rather than attesting a still tree", () => {
		const m = markerFrom(null, after, null);

		expect(m.dirtyCount).toBe(0);
		expect(m.startStateUnknown).toBe(true);
		expect(warnsDirty(m)).toBe(true);
	});

	it("does not flag an unknown start state where git answered", () => {
		expect(markerFrom({ head: "old", files: {} }, after, null)).toHaveProperty(
			"startStateUnknown",
			false,
		);
	});

	it("names a file that moved under the suite, and a HEAD that moved with it", () => {
		const m = markerFrom(null, after, {
			headMoved: true,
			moved: [{ path: "scripts/z.js", kind: "changed" }],
		});

		expect(m.headMovedDuringRun).toBe(true);
		expect(m.foreign).toEqual([
			{ path: "scripts/z.js", why: "changed while the suite ran" },
		]);
	});

	it("stamps the suite it was told, so pytest's certificate is not read as vitest's", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			suite: "pytest",
		});

		expect(m.suite).toBe("pytest");
	});

	describe("isolated and treeAtEnd (mantahostels#2187)", () => {
		it("records isolated:false by default, never omitting it", () => {
			const m = markerFrom({ head: "old", files: {} }, after, null);

			expect(m.isolated).toBe(false);
		});

		it("records isolated:true where the caller says the run was frozen", () => {
			const m = markerFrom({ head: "old", files: {} }, after, null, {
				isolated: true,
			});

			expect(m.isolated).toBe(true);
		});

		it("carries the end-of-run tree identity where the caller has one", () => {
			const m = markerFrom({ head: "old", files: {} }, after, null, {
				isolated: true,
				treeAtEnd: "t".repeat(40),
			});

			expect(m.treeAtEnd).toBe("t".repeat(40));
		});

		it("omits treeAtEnd rather than writing a null, where git could not answer", () => {
			const m = markerFrom({ head: "old", files: {} }, after, null);

			expect(m).not.toHaveProperty("treeAtEnd");
		});
	});
});

describe("the suites a range is asked about", () => {
	function suitesAskedOf(paths: string[]): string[] {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "suites-")),
		);
		dirs.push(dir);
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
		git("add", "-A");
		git("commit", "-q", "-m", "root");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		for (const p of paths) {
			fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
			fs.writeFileSync(path.join(dir, p), `${p}\n`);
		}
		git("add", "-A");
		git("commit", "-q", "--allow-empty", "-m", "range");
		const r = attestationOf(git("rev-parse", "HEAD"), [], { root: dir });
		if (!r.judged) throw new Error(r.why);
		expect([...r.range].sort()).toEqual([...paths].sort());
		return r.suites.map((s) => s.suite);
	}

	it("asks about exactly the two suites, in print order, where the range touches Python", () => {
		expect(suitesAskedOf(["pipe.py"])).toEqual(["vitest", "pytest"]);
	});

	it("asks about vitest whatever the range touched, it covering the whole repo", () => {
		expect(suitesAskedOf([])).toContain("vitest");
		expect(suitesAskedOf(["docs/doc-map.md"])).toContain("vitest");
	});

	it("drops pytest from a range holding no Python and none of its wiring", () => {
		expect(suitesAskedOf(["docs/doc-map.md", "app/page.tsx"])).not.toContain(
			"pytest",
		);
	});

	it.each([
		"scripts/test_evidence_corpus.py",
		"scripts/measure/conftest.py",
		"pytest.ini",
		"requirements-dev.txt",
		"scripts/run-pytest.js",
	])("keeps pytest where the range touches %s", (file) => {
		expect(suitesAskedOf(["docs/doc-map.md", file])).toContain("pytest");
	});

	it("matches on the whole path, never on a suffix of a longer name", () => {
		expect(
			suitesAskedOf(["notpytest.ini", "vendor/package.json"]),
		).not.toContain("pytest");
	});

	it("drops pytest from a package.json-only diff, selecting vitest alone (lucmoseley/mantahostels#2170)", () => {
		expect(suitesAskedOf(["package.json"])).toEqual(["vitest"]);
	});
});

describe("the red store (mantahostels#1942)", () => {
	it("writes the red run to its own store, never the certificate store", () => {
		const root = sandbox();
		expect(recordFailure({ sha: "a".repeat(40), at: "now" }, { root })).toBe(
			true,
		);

		expect(fs.existsSync(storePath(root, FAIL_STORE))).toBe(true);
		expect(fs.existsSync(storePath(root))).toBe(false);
	});

	it("carries the failing files through to the store", () => {
		const root = sandbox();
		recordFailure(
			{
				sha: "b".repeat(40),
				scope: {
					failures: [
						{ file: "scripts/thing.test.ts", tests: ["does a thing"] },
					],
				},
			} as Parameters<typeof recordFailure>[0],
			{ root },
		);

		const line = JSON.parse(
			fs.readFileSync(storePath(root, FAIL_STORE), "utf8").trim(),
		);
		expect(line.scope.failures).toEqual([
			{ file: "scripts/thing.test.ts", tests: ["does a thing"] },
		]);
	});

	it("refuses a marker with no sha rather than writing a nameless line", () => {
		const root = sandbox();
		expect(recordFailure({} as never, { root })).toBe(false);
		expect(fs.existsSync(storePath(root, FAIL_STORE))).toBe(false);
	});

	it("returns false rather than throwing when the store cannot be written", () => {
		const root = sandbox();
		fs.writeFileSync(path.join(root, ".claude"), "");
		let landed: boolean | undefined;
		expect(() => {
			landed = recordFailure({ sha: "c".repeat(40) }, { root });
		}).not.toThrow();
		expect(landed).toBe(false);
	});

	it("prunes to the newest keep lines once past pruneAt", () => {
		const root = sandbox();
		for (let i = 0; i < 6; i++)
			recordFailure(
				{ sha: String(i).repeat(40) },
				{ root, pruneAt: 3, keep: 2 },
			);

		const lines = fs
			.readFileSync(storePath(root, FAIL_STORE), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines.at(-1) as string).sha).toBe("5".repeat(40));
	});
});

describe("an admissible filtered run (mantahostels#2146, mantahostels#2207)", () => {
	const admissible = (over: Record<string, unknown> = {}) =>
		certificate({
			scope: fullScope({
				modulesRun: 4,
				tests: 40,
				passed: 40,
				skipped: 0,
				fileFilters: ["scripts/lib/test-pass-marker.test.ts"],
				admissible: true,
				...over,
			}),
		});

	it("is a certificate, distinguishable from a full run", () => {
		expect(isAdmissibleRun(admissible())).toBe(true);
		expect(isFullRun(admissible())).toBe(false);
	});

	it("is not claimable by a filtered run nothing vouched for", () => {
		expect(isAdmissibleRun(narrowed())).toBe(false);
	});

	it("is not claimable by a run that carries the field set false", () => {
		expect(isAdmissibleRun(admissible({ admissible: false }))).toBe(false);
	});

	it("is not claimable by a truthy value that is not the flag", () => {
		for (const value of ["1", 1, "true", {}])
			expect(isAdmissibleRun(admissible({ admissible: value }))).toBe(false);
	});

	it("is not claimable by a run whose corpus never resolved", () => {
		expect(isAdmissibleRun(admissible({ modulesTotal: 0 }))).toBe(false);
	});

	it("is not claimable by a name-filtered run, whatever set the flag", () => {
		expect(isAdmissibleRun(admissible({ nameFilter: "/spawn/" }))).toBe(false);
	});

	it("leaves the full-run definition alone — mantahostels#1230 stands", () => {
		const full = certificate({ scope: fullScope({ admissible: true }) });
		expect(isFullRun(full)).toBe(true);
		expect(isAdmissibleRun(full)).toBe(false);
	});

	it("is not claimable by the route flag, which attests nothing", () => {
		const routed = certificate({
			scope: fullScope({
				modulesRun: 4,
				tests: 40,
				passed: 40,
				skipped: 0,
				fileFilters: ["scripts/lib/test-pass-marker.test.ts"],
				viaChanged: true,
			}),
		});
		expect(isAdmissibleRun(routed)).toBe(false);
		expect(isFullRun(routed)).toBe(false);
	});

	it("does not disturb a real certificate that also carries it", () => {
		expect(isAdmissibleRun(admissible({ viaChanged: true }))).toBe(true);
	});

	it("says so on the line the run prints for itself", () => {
		expect(formatFilteredRun(admissible().scope)).toContain("ADMISSIBLE");
		expect(formatFilteredRun(narrowed().scope)).not.toContain("ADMISSIBLE");
	});
});

describe("why a full run was full (mantahostels#3207)", () => {
	it("leaves isFullRun's verdict unaffected by which reason the scope carries", () => {
		const bare = isFullRun(certificate());
		for (const reason of FULL_REASONS)
			expect(
				isFullRun(certificate({ scope: fullScope({ full: reason }) })),
			).toBe(bare);
	});

	it("carries no full key on a scope built before this change", () => {
		expect("full" in fullScope()).toBe(false);
	});

	it("rejects a scope claiming both full and admissible", () => {
		const scope = fullScope({
			modulesRun: 4,
			fileFilters: ["scripts/lib/test-pass-marker.test.ts"],
			admissible: true,
			full: "flag",
		});
		expect(isAdmissibleRun(certificate({ scope }))).toBe(false);
	});

	it("still lets a full scope's own admissible flag be ignored, unharmed by the new limb", () => {
		expect(
			isFullRun(
				certificate({ scope: fullScope({ admissible: true, full: "flag" }) }),
			),
		).toBe(true);
	});
});

describe("reading the red store back (mantahostels#2205)", () => {
	const red = (
		sha: string,
		files: string[],
		scope: Record<string, unknown> = {},
		rest: Record<string, unknown> = {},
	) => ({
		sha,
		at: new Date().toISOString(),
		scope: redScope(
			files.map((file) => ({ file, tests: ["a case"] })),
			scope,
		),
		...rest,
	});

	it("reads the red store, never the certificate store", () => {
		const root = sandbox();
		record({ sha: "a".repeat(40), at: "now" }, { root });
		recordFailure(red("b".repeat(40), ["one.test.ts"]), { root });

		expect(readFailures({ root }).map((m) => m.sha)).toEqual(["b".repeat(40)]);
		expect(readMarkers({ root }).map((m) => m.sha)).toEqual(["a".repeat(40)]);
	});

	it("answers [] for an absent store, so the caller can fail open", () => {
		expect(readFailures({ root: sandbox() })).toEqual([]);
	});
});

describe("attesting a sha by tree (#189)", () => {
	const attestedSha = "a".repeat(40);
	const other = "b".repeat(40);
	const treeSha = "c".repeat(40);
	const baseSha = "d".repeat(40);

	const scripted = ({
		tree = treeSha,
		manifest = JSON.stringify({ edges: {} }) as string | null,
		touched = [] as string[],
		range = [] as string[],
		throws = false,
	} = {}) => {
		const calls: string[][] = [];
		const fn = ((_file: string, args: string[]) => {
			calls.push(args);
			if (throws) throw new Error("no git");
			switch (args[0]) {
				case "merge-base":
					return `${baseSha}\n`;
				case "rev-parse":
					return `${tree}\n`;
				case "show":
					if (manifest === null) throw new Error("no such path");
					return manifest;
				case "diff-tree":
					return `${touched.join("\n")}\n`;
				case "diff":
					return `${range.join("\n")}\n`;
				default:
					throw new Error(`unexpected git ${args.join(" ")}`);
			}
		}) as unknown as typeof execFileSync;
		return { fn, calls };
	};

	const full = (over: Record<string, unknown> = {}) =>
		certificate({ sha: other, treeAtEnd: treeSha, closure: "*", ...over });

	const narrowedRun = (over: Record<string, unknown> = {}) =>
		certificate({
			sha: other,
			treeAtEnd: treeSha,
			scope: fullScope({ modulesRun: 3, changed: baseSha, admissible: true }),
			closure: ["scripts/a.test.ts", "scripts/a.js", "package.json"],
			changedPaths: ["scripts/a.js"],
			base: baseSha,
			...over,
		});

	const at = (
		m: Record<string, unknown>,
		io = scripted(),
		root: string | null = "/repo",
	) =>
		holdsTestByTree(
			m as Parameters<typeof holdsTestByTree>[0],
			"",
			attestedSha,
			{
				root,
				execFn: io.fn,
			},
		);

	const matches = (r: ReturnType<typeof attestationOf>) => {
		const s = r.judged ? r.suites[0] : null;
		return s?.attested ? s.members.map((member) => member.match) : null;
	};

	const attest = (m: Record<string, unknown>, io = scripted()) =>
		matches(
			attestationOf(
				attestedSha,
				[m as Parameters<typeof attestationOf>[1][number]],
				{ root: "/repo", execFn: io.fn },
			),
		);

	it("rule 1: a matching sha attests by sha, asking git nothing past the range", () => {
		const io = scripted();
		const r = attestationOf(attestedSha, [certificate({ sha: attestedSha })], {
			root: "/repo",
			execFn: io.fn,
		});
		expect(r.judged && r.suites[0]).toMatchObject({
			attested: true,
			members: [{ match: { by: "sha" } }],
		});
		expect(io.calls.map((c) => c[0])).toEqual(["merge-base", "diff"]);
	});

	it("rule 2: a certificate lacking treeAtEnd or closure attests no other sha, even over an equal tree", () => {
		expect(at(certificate({ sha: other, closure: "*" }))).toBe(false);
		expect(at(certificate({ sha: other, treeAtEnd: treeSha }))).toBe(false);
		expect(at(unscoped({ sha: other }))).toBe(false);
		expect(at(full({ closure: 42 }))).toBe(false);
		expect(attest(certificate({ sha: other, closure: "*" }))).toBeNull();
		expect(attest(certificate({ sha: other, treeAtEnd: treeSha }))).toBeNull();
		expect(attest(full({ closure: 42 }))).toBeNull();
	});

	it("rule 3, full run: tree equality attests, one rev-parse and no diff", () => {
		const io = scripted({ tree: treeSha });
		expect(at(full(), io)).toBe(true);
		expect(io.calls).toEqual([["rev-parse", `${attestedSha}^{tree}`]]);
		expect(attest(full())).toEqual([
			{ by: "tree", tree: treeSha, closureSize: "*" },
		]);
	});

	it("rule 3, full run: a differing tree refuses", () => {
		expect(at(full(), scripted({ tree: "e".repeat(40) }))).toBe(false);
		expect(attest(full(), scripted({ tree: "e".repeat(40) }))).toBeNull();
	});

	it("rule 3, narrowed: a closure the diff-tree leaves untouched attests, with the closure's size, asking nothing of the range (#814)", () => {
		const io = scripted({
			touched: ["docs/other.md"],
			range: ["scripts/b.js"],
		});
		expect(at(narrowedRun(), io)).toBe(true);
		expect(io.calls.map((c) => c[0])).toEqual(["diff-tree"]);
		expect(io.calls[0]).toContain("--no-renames");
		expect(
			attest(
				narrowedRun(),
				scripted({ touched: ["docs/other.md"], range: ["scripts/a.js"] }),
			),
		).toEqual([{ by: "tree", tree: treeSha, closureSize: 3 }]);
	});

	it("rule 3, narrowed: a touched closure path refuses, reading nothing past the diff-tree", () => {
		const io = scripted({ touched: ["scripts/a.js"], range: ["scripts/a.js"] });
		expect(at(narrowedRun(), io)).toBe(false);
		expect(io.calls.map((c) => c[0])).toEqual(["diff-tree"]);
		expect(
			attest(
				narrowedRun(),
				scripted({ touched: ["scripts/a.js"], range: ["scripts/a.js"] }),
			),
		).toBeNull();
	});

	describe("re-reading the manifest at the sha (#799)", () => {
		const selecting = (over: Record<string, unknown> = {}) =>
			narrowedRun({ selected: ["scripts/a.test.ts"], ...over });
		const edges = (e: Record<string, string[]>) => JSON.stringify({ edges: e });

		it("attests a manifest commit that changed only an unselected test's edges", () => {
			const io = scripted({
				manifest: edges({
					"docs/read-by-a.md": ["scripts/a.test.ts"],
					"docs/read-by-z.md": ["scripts/z.test.ts"],
				}),
				touched: ["docs/test-read-edges.json", "docs/read-by-z.md"],
				range: ["scripts/a.js"],
			});
			expect(at(selecting(), io)).toBe(true);
			expect(io.calls[0]).toEqual([
				"show",
				`${attestedSha}:docs/test-read-edges.json`,
			]);
			expect(io.calls.map((c) => c[0])).toEqual(["show", "diff-tree"]);
			expect(
				attest(
					selecting(),
					scripted({
						manifest: edges({
							"docs/read-by-a.md": ["scripts/a.test.ts"],
							"docs/read-by-z.md": ["scripts/z.test.ts"],
						}),
						touched: ["docs/test-read-edges.json", "docs/read-by-z.md"],
						range: ["scripts/a.js"],
					}),
				),
			).toEqual([{ by: "tree", tree: treeSha, closureSize: 4 }]);
		});

		it("refuses a new edge from a selected test onto a document that also changed", () => {
			const io = scripted({
				manifest: edges({
					"docs/new.md": ["scripts/z.test.ts", "scripts/a.test.ts"],
				}),
				touched: ["docs/test-read-edges.json", "docs/new.md"],
				range: ["scripts/a.js"],
			});
			expect(at(selecting(), io)).toBe(false);
			expect(
				attest(
					selecting(),
					scripted({
						manifest: edges({
							"docs/new.md": ["scripts/z.test.ts", "scripts/a.test.ts"],
						}),
						touched: ["docs/test-read-edges.json", "docs/new.md"],
						range: ["scripts/a.js", "docs/new.md"],
					}),
				),
			).toBeNull();
		});

		it("refuses where the manifest is absent, unparseable or malformed at the sha", () => {
			for (const manifest of [
				null,
				"{",
				"null",
				JSON.stringify({}),
				JSON.stringify({ edges: [] }),
				JSON.stringify({ edges: { "docs/x.md": "scripts/a.test.ts" } }),
			]) {
				expect(at(selecting(), scripted({ manifest }))).toBe(false);
				expect(attest(selecting(), scripted({ manifest }))).toBeNull();
			}
		});

		it("judges a pre-#799 certificate, the manifest in its closure, on that closure alone and never re-reads", () => {
			const old = narrowedRun({
				closure: [
					"scripts/a.test.ts",
					"docs/test-read-edges.json",
					"package.json",
				],
			});
			const moved = scripted({ touched: ["docs/test-read-edges.json"] });
			expect(at(old, moved)).toBe(false);
			const still = scripted({ touched: ["docs/other.md"] });
			expect(at(old, still)).toBe(true);
			expect([...moved.calls, ...still.calls].map((c) => c[0])).not.toContain(
				"show",
			);
			expect(
				attest(old, scripted({ touched: ["docs/test-read-edges.json"] })),
			).toBeNull();
			expect(attest(old, scripted({ touched: ["docs/other.md"] }))).toEqual([
				{ by: "tree", tree: treeSha, closureSize: 3 },
			]);
		});
	});

	it("attests nothing where git will not answer, or there is no root", () => {
		expect(at(full(), scripted({ throws: true }))).toBe(false);
		expect(at(full(), scripted(), null)).toBe(false);
	});

	it("memoises git across certificates through a shared cache", () => {
		const io = scripted();
		const cache = new Map();
		holdsTestByTree(full(), "", attestedSha, {
			root: "/repo",
			execFn: io.fn,
			cache,
		});
		holdsTestByTree(full({ at: "later" }), "", attestedSha, {
			root: "/repo",
			execFn: io.fn,
			cache,
		});
		expect(io.calls).toHaveLength(1);
	});

	describe("what the certificate carries", () => {
		const before = { head: other, files: {} };
		const after = { head: other, files: {} };
		const make = (attestation: unknown) =>
			markerFrom(before, after, null, {
				scope: fullScope(),
				treeAtEnd: treeSha,
				sessionId: null,
				argv: null,
				attestation: attestation as NonNullable<
					Parameters<typeof markerFrom>[3]
				>["attestation"],
			});

		it("writes closure, changedPaths and base for a narrowed run", () => {
			const m = make({
				closure: ["a.test.ts", "a.js"],
				changedPaths: ["a.js"],
				base: baseSha,
			});
			expect(m.closure).toEqual(["a.test.ts", "a.js"]);
			expect(m.changedPaths).toEqual(["a.js"]);
			expect(m.base).toBe(baseSha);
		});

		it("writes the selected tests beside a narrowed closure, dropping a malformed list (#799)", () => {
			const m = make({ closure: ["a.test.ts"], selected: ["a.test.ts"] });
			expect(m.selected).toEqual(["a.test.ts"]);
			const bad = make({ closure: ["a.test.ts"], selected: [1] });
			expect(bad).not.toHaveProperty("selected");
		});

		it("writes closure '*' for a full run with its base beside it, and neither selected nor changedPaths (#3646)", () => {
			const m = make({
				closure: "*",
				selected: ["a.test.ts"],
				changedPaths: ["a.js"],
				base: baseSha,
			});
			expect(m.closure).toBe("*");
			expect(m.base).toBe(baseSha);
			expect(m).not.toHaveProperty("selected");
			expect(m).not.toHaveProperty("changedPaths");
			expect(make({ closure: "*" })).not.toHaveProperty("base");
		});

		it("omits both where the reporter handed nothing, or a malformed closure", () => {
			for (const a of [null, { closure: 7 }, { closure: [1, 2] }]) {
				const m = make(a);
				expect(m).not.toHaveProperty("closure");
				expect(m).not.toHaveProperty("changedPaths");
			}
		});
	});

	describe("over a real repository with a neighbour's dirty file", () => {
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();

		function repo() {
			const dir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "attest-")),
			);
			dirs.push(dir);
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@example.com");
			git(dir, "config", "user.name", "T");
			for (const f of ["lib.js", "lib.test.ts", "other.txt", "package.json"])
				fs.writeFileSync(path.join(dir, f), `${f} v0\n`);
			git(dir, "add", "-A");
			git(dir, "commit", "-q", "-m", "root");
			git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
			return dir;
		}

		function markerOver(
			dir: string,
		): Parameters<typeof holdsTestByTree>[0] & { treeAtEnd: string } {
			const stashed = git(dir, "stash", "create");
			return certificate({
				sha: git(dir, "rev-parse", "HEAD"),
				treeAtEnd: git(dir, "rev-parse", `${stashed}^{tree}`),
				scope: fullScope({ modulesRun: 1, changed: "HEAD", admissible: true }),
				closure: ["lib.test.ts", "lib.js", "package.json"],
				changedPaths: git(dir, "diff", "--name-only", "HEAD").split("\n"),
				base: git(dir, "rev-parse", "HEAD"),
				dirtyAtStart: true,
				dirtyCount: 2,
				foreign: [{ path: "other.txt", why: "changed while the suite ran" }],
			}) as unknown as ReturnType<typeof markerOver>;
		}

		it("attests the commit made from the session's own edit", () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			fs.writeFileSync(path.join(dir, "other.txt"), "neighbour's dirt\n");
			const m = markerOver(dir);
			git(dir, "commit", "-q", "-m", "own edit", "--", "lib.js");
			const sha = git(dir, "rev-parse", "HEAD");

			expect(sha).not.toBe(m.sha);
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(true);
			const r = attestationOf(sha, [m], { root: dir });
			expect(matches(r)).toEqual([
				{ by: "tree", tree: m.treeAtEnd, closureSize: 3 },
			]);
			const s = r.judged ? r.suites[0] : null;
			expect(s?.attested).toBe(true);
			const text = attestedReading(
				sha,
				s as Parameters<typeof attestedReading>[1],
			);
			expect(text).toContain("attested by tree");
			expect(text).toContain("(closure of 3 paths)");
			expect(text).not.toContain("dirty tree");
		});

		it("stops attesting once the closure is edited again, even inside changedPaths", () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			fs.writeFileSync(path.join(dir, "other.txt"), "neighbour's dirt\n");
			const m = markerOver(dir);
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v2 — untested\n");
			git(dir, "commit", "-q", "-m", "second edit", "--", "lib.js");
			const sha = git(dir, "rev-parse", "HEAD");
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(false);
			expect(matches(attestationOf(sha, [m], { root: dir }))).toBeNull();
		});

		it("leaves unattested a path in the commit's range the selection never saw, though the run still holds", () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			const m = markerOver(dir);
			fs.writeFileSync(path.join(dir, "new.test.ts"), "a test nobody ran\n");
			git(dir, "add", "new.test.ts");
			git(
				dir,
				"commit",
				"-q",
				"-m",
				"own edit plus a new test",
				"--",
				"lib.js",
				"new.test.ts",
			);
			const sha = git(dir, "rev-parse", "HEAD");
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(true);
			const r = attestationOf(sha, [m], { root: dir });
			expect(r.judged && r.suites[0]).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [{ path: "new.test.ts" }],
			});
		});

		it("leaves an edit outside changedPaths unattested", () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			const m = markerOver(dir);
			fs.writeFileSync(
				path.join(dir, "other.txt"),
				"edit B, never selected for\n",
			);
			git(dir, "commit", "-q", "-m", "A and B", "--", "lib.js", "other.txt");
			const sha = git(dir, "rev-parse", "HEAD");
			const r = attestationOf(sha, [m], { root: dir });
			expect(r.judged && r.suites[0]).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [{ path: "other.txt" }],
			});
		});

		it("attests an empty selection's certificate — the instruments alone — on the docs-only commit made from it (#189 §6)", () => {
			const dir = repo();
			fs.writeFileSync(
				path.join(dir, "notes.md"),
				"a document no test reads\n",
			);
			git(dir, "add", "notes.md");
			const m = {
				...markerOver(dir),
				closure: ["docs/test-read-edges.json", "package.json"],
				changedPaths: ["notes.md"],
			};
			git(dir, "commit", "-q", "-m", "docs only", "--", "notes.md");
			const sha = git(dir, "rev-parse", "HEAD");
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(true);
			expect(matches(attestationOf(sha, [m], { root: dir }))).toEqual([
				{ by: "tree", tree: m.treeAtEnd, closureSize: 2 },
			]);
		});

		function manifestRun(dir: string) {
			const write = (e: Record<string, string[]>) => {
				fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
				fs.writeFileSync(
					path.join(dir, "docs", "test-read-edges.json"),
					JSON.stringify({ edges: e }),
				);
			};
			write({ "notes.md": ["lib.test.ts"] });
			fs.writeFileSync(path.join(dir, "notes.md"), "read by lib.test.ts\n");
			git(dir, "add", "-A");
			git(dir, "commit", "-q", "-m", "manifest");
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			fs.writeFileSync(path.join(dir, "other.txt"), "other.txt v1\n");
			const m = {
				...markerOver(dir),
				closure: ["lib.js", "lib.test.ts", "notes.md", "package.json"],
				selected: ["lib.test.ts"],
				changedPaths: ["docs/test-read-edges.json", "lib.js", "other.txt"],
			};
			return { m, write };
		}
		const commitAll = (dir: string) => {
			git(dir, "add", "-A");
			git(dir, "commit", "-q", "-m", "own edits");
			return git(dir, "rev-parse", "HEAD");
		};

		it("attests the commit regenerating the manifest for a test the run never selected (#799)", () => {
			const dir = repo();
			const { m, write } = manifestRun(dir);
			write({ "notes.md": ["lib.test.ts"], "other.txt": ["z.test.ts"] });
			const sha = commitAll(dir);
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(true);
			expect(
				matches(attestationOf(sha, [m], { root: dir, within: m.changedPaths })),
			).toEqual([{ by: "tree", tree: m.treeAtEnd, closureSize: 4 }]);
		});

		it("refuses the commit whose manifest maps a selected test onto a document edited since the run (#799)", () => {
			const dir = repo();
			const { m, write } = manifestRun(dir);
			write({ "notes.md": ["lib.test.ts"], "other.txt": ["lib.test.ts"] });
			fs.writeFileSync(path.join(dir, "other.txt"), "other.txt v2\n");
			const sha = commitAll(dir);
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(false);
			expect(
				matches(attestationOf(sha, [m], { root: dir, within: m.changedPaths })),
			).toBeNull();
		});

		it("refuses where the sha carries no manifest (#799)", () => {
			const dir = repo();
			const { m } = manifestRun(dir);
			fs.rmSync(path.join(dir, "docs", "test-read-edges.json"));
			const sha = commitAll(dir);
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(false);
			expect(
				matches(attestationOf(sha, [m], { root: dir, within: m.changedPaths })),
			).toBeNull();
		});

		it("attests a still tree's full run on the commit that reproduces it exactly", () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			const m = {
				...markerOver(dir),
				closure: "*" as const,
				scope: fullScope(),
			};
			git(dir, "commit", "-q", "-m", "everything", "--", "lib.js");
			const sha = git(dir, "rev-parse", "HEAD");
			expect(holdsTestByTree(m, "", sha, { root: dir })).toBe(true);
			expect(matches(attestationOf(sha, [m], { root: dir }))).toEqual([
				{ by: "tree", tree: m.treeAtEnd, closureSize: "*" },
			]);
			git(dir, "commit", "-q", "--allow-empty", "-m", "moved sha, same tree");
			expect(
				holdsTestByTree(m, "", git(dir, "rev-parse", "HEAD"), { root: dir }),
			).toBe(true);
		});
	});
});

describe("certificates composed across sessions (#811, #789)", () => {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();

	function repo() {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "compose-")),
		);
		dirs.push(dir);
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		for (const f of [
			"a.js",
			"a.test.ts",
			"b.js",
			"b.test.ts",
			"other.txt",
			"package.json",
		])
			fs.writeFileSync(path.join(dir, f), `${f} v0\n`);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "root");
		git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
		return { dir, root: git(dir, "rev-parse", "HEAD") };
	}

	function treeWith(dir: string, base: string, files: Record<string, string>) {
		const env = {
			...process.env,
			GIT_INDEX_FILE: path.join(dir, ".git", "compose-index"),
		};
		const indexGit = (args: string[], input?: string) =>
			execFileSync("git", args, { cwd: dir, encoding: "utf8", env, input })
				.toString()
				.trim();
		indexGit(["read-tree", base]);
		for (const [f, body] of Object.entries(files))
			indexGit([
				"update-index",
				"--add",
				"--cacheinfo",
				`100644,${indexGit(["hash-object", "-w", "--stdin"], body)},${f}`,
			]);
		return indexGit(["write-tree"]);
	}

	const commit = (dir: string, files: Record<string, string>, msg: string) => {
		for (const [f, body] of Object.entries(files))
			fs.writeFileSync(path.join(dir, f), body);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", msg);
		return git(dir, "rev-parse", "HEAD");
	};

	const run = (
		dir: string,
		root: string,
		files: Record<string, string>,
		{ closure, at }: { closure: string[]; at: string },
	) =>
		certificate({
			sha: root,
			at,
			treeAtEnd: treeWith(dir, root, files),
			scope: fullScope({ modulesRun: 2, changed: root, admissible: true }),
			closure,
			changedPaths: Object.keys(files),
			base: root,
		});

	const aEdit = { "a.js": "a.js v1\n" };
	const bEdit = { "b.js": "b.js v1\n" };

	function twoSessions() {
		const { dir, root } = repo();
		const a = run(dir, root, aEdit, {
			closure: ["a.js", "a.test.ts", "package.json"],
			at: "A",
		});
		const b = run(dir, root, bEdit, {
			closure: ["b.js", "b.test.ts", "package.json"],
			at: "B",
		});
		const c1 = commit(dir, aEdit, "A's edit");
		const c2 = commit(dir, bEdit, "B's edit");
		return { dir, root, a, b, c1, c2 };
	}

	const vitest = (r: ReturnType<typeof attestationOf>) => {
		if (!r.judged) throw new Error(r.why);
		return r.suites.find((s) => s.suite === "vitest");
	};

	it("attests a two-commit range with two sessions' certificates neither of which attests it alone", () => {
		const { dir, a, b, c2 } = twoSessions();
		expect(vitest(attestationOf(c2, [a], { root: dir }))?.attested).toBe(false);
		expect(vitest(attestationOf(c2, [b], { root: dir }))?.attested).toBe(false);
		const r = attestationOf(c2, [a, b], { root: dir });
		expect(r.judged && r.range.sort()).toEqual(["a.js", "b.js"]);
		const v = vitest(r);
		expect(v?.attested).toBe(true);
		expect(v?.attested && v.members.map((m) => m.marker.at).sort()).toEqual([
			"A",
			"B",
		]);
	});

	it("judges only the paths `within` names, so one session's certificate attests its own part of the range (#1218)", () => {
		const { dir, a, c2 } = twoSessions();
		const r = attestationOf(c2, [a], { root: dir, within: ["a.js"] });
		expect(r.judged && r.range).toEqual(["a.js"]);
		const v = vitest(r);
		expect(v?.attested && v.members.map((m) => m.marker.at)).toEqual(["A"]);
		expect(
			vitest(attestationOf(c2, [a], { root: dir, within: ["b.js"] }))?.attested,
		).toBe(false);
	});

	it("names every tree-matched member in the note", () => {
		const { dir, a, b, c2 } = twoSessions();
		const v = vitest(attestationOf(c2, [a, b], { root: dir }));
		const note = (v?.attested && v.note) || "";
		expect(note).toContain("from run at A");
		expect(note).toContain("from run at B");
		expect(note).toContain("a content match, not a sha match");
	});

	it("voids a member whose closure a neighbour's later commit changed, naming what it no longer attests", () => {
		const { dir, root, a, b, c2 } = twoSessions();
		const edit = { "a.test.ts": "a.test.ts v1\n" };
		const n = certificate({
			sha: c2,
			at: "N",
			treeAtEnd: treeWith(dir, c2, edit),
			scope: fullScope({ modulesRun: 1, changed: root, admissible: true }),
			closure: ["a.test.ts", "package.json"],
			changedPaths: ["a.test.ts"],
			base: root,
		});
		const c3 = commit(dir, edit, "neighbour edits A's test");
		const v = vitest(attestationOf(c3, [a, b, n], { root: dir }));
		expect(v).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "a.js" }],
		});
	});

	it("leaves a hand commit no member selected for unattested", () => {
		const { dir, a, b } = twoSessions();
		const c3 = commit(dir, { "other.txt": "by hand\n" }, "hand commit");
		expect(vitest(attestationOf(c3, [a, b], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "other.txt" }],
		});
	});

	it("lets one full-run member attest every path in the range", () => {
		const { dir, a, b, c1 } = twoSessions();
		const c3 = commit(dir, { "other.txt": "by hand\n" }, "hand commit");
		const full = certificate({
			sha: c1,
			at: "F",
			treeAtEnd: git(dir, "rev-parse", `${c3}^{tree}`),
			closure: "*",
		});
		const v = vitest(attestationOf(c3, [a, b, full], { root: dir }));
		expect(v?.attested && v.members.map((m) => m.marker.at)).toEqual(["F"]);
		expect(v?.attested && v.note).toContain("closure: the whole tree");
	});

	it("never counts a run too narrow to attest", () => {
		const { dir, root, b, c2 } = twoSessions();
		const handTyped = {
			...run(dir, root, aEdit, { closure: ["a.js", "a.test.ts"], at: "A" }),
			scope: fullScope({ modulesRun: 1, fileFilters: ["a.test.ts"] }),
		};
		expect(
			vitest(attestationOf(c2, [handTyped, b], { root: dir }))?.attested,
		).toBe(false);
	});

	it("answers each suite for itself: a vitest certificate never attests a pytest gap", () => {
		const { dir, root } = repo();
		const edit = { "pipe.py": "x = 1\n" };
		const v = run(dir, root, edit, {
			closure: ["pipe.py", "package.json"],
			at: "V",
		});
		const c1 = commit(dir, edit, "python edit");
		const r = attestationOf(c1, [v], { root: dir });
		expect(r.judged && r.suites.map((s) => [s.suite, s.attested])).toEqual([
			["vitest", true],
			["pytest", false],
		]);
		const py = r.judged && r.suites.find((s) => s.suite === "pytest");
		expect(py && !py.attested && py.unattested).toEqual([{ path: "pipe.py" }]);
		const pyCertificate = certificate({ sha: c1, suite: "pytest", at: "P" });
		const both = attestationOf(c1, [v, pyCertificate], { root: dir });
		expect(both.judged && both.suites.every((s) => s.attested)).toBe(true);
	});

	describe("the range", () => {
		it("runs from the merge-base with origin/main, never from origin/main's own tip", () => {
			const { dir, root, b, c2 } = twoSessions();
			git(dir, "checkout", "-q", "-b", "upstream", root);
			const ahead = commit(dir, { "other.txt": "upstream only\n" }, "upstream");
			git(dir, "update-ref", "refs/remotes/origin/main", ahead);
			git(dir, "checkout", "-q", "main");
			const r = attestationOf(c2, [b], { root: dir });
			expect(r.judged && r.base).toBe(root);
			expect(r.judged && r.range.sort()).toEqual(["a.js", "b.js"]);
			expect(vitest(r)).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [{ path: "a.js" }],
			});
		});

		it("runs from the merge-base with origin/main, never a queue ref (#4458)", () => {
			const { dir, root, b, c2 } = twoSessions();
			git(dir, "update-ref", "refs/remotes/origin/queue/s1", c2);
			git(dir, "update-ref", "refs/remotes/origin/main", root);
			const r = attestationOf(c2, [b], { root: dir });
			expect(r.judged && r.base).toBe(root);
			expect(vitest(r)).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [{ path: "a.js" }],
			});
		});

		it("judges nothing where git cannot name the range", () => {
			const { dir, a, b, c2 } = twoSessions();
			git(dir, "update-ref", "-d", "refs/remotes/origin/main");
			const r = attestationOf(c2, [a, b], { root: dir });
			expect(r.judged).toBe(false);
			expect(!r.judged && r.why).toContain("origin/main");
			const none = attestationOf(c2, [a, b], { root: null });
			expect(!none.judged && none.why).toContain("no git repository");
		});

		function reconciled(resolved?: string) {
			const { dir, root } = repo();
			const a = run(dir, root, aEdit, {
				closure: ["a.js", "a.test.ts", "package.json"],
				at: "A",
			});
			const c1 = commit(dir, aEdit, "A's edit");
			const full = certificate({
				sha: c1,
				at: "F",
				treeAtEnd: git(dir, "rev-parse", `${c1}^{tree}`),
				closure: "*",
			});
			git(dir, "checkout", "-q", "-b", "upstream", root);
			const landed = commit(
				dir,
				{
					"a.test.ts": "a.test.ts v1\n",
					...(resolved ? { "a.js": "a.js upstream\n" } : {}),
				},
				"a main commit",
			);
			git(dir, "update-ref", "refs/remotes/origin/main", landed);
			git(dir, "checkout", "-q", "main");
			if (resolved) {
				expect(() => git(dir, "merge", "-q", "upstream")).toThrow();
				fs.writeFileSync(path.join(dir, "a.js"), resolved);
				git(dir, "add", "a.js");
				git(dir, "commit", "-q", "--no-edit");
			} else git(dir, "merge", "-q", "--no-edit", "upstream");
			return { dir, a, full, c1, merge: git(dir, "rev-parse", "HEAD") };
		}

		it("lets a narrowed or full certificate hold over a clean merge of origin/main (#2517)", () => {
			const { dir, a, full, merge } = reconciled();
			for (const m of [a, full]) {
				const r = attestationOf(merge, [m], { root: dir });
				expect(r.judged && r.range).toEqual(["a.js"]);
				expect(vitest(r)?.attested).toBe(true);
			}
		});

		it("voids a certificate over a merge whose conflict was resolved by hand (#2517)", () => {
			const { dir, a, full, merge } = reconciled("a.js resolved\n");
			for (const m of [a, full])
				expect(vitest(attestationOf(merge, [m], { root: dir }))).toEqual({
					suite: "vitest",
					attested: false,
					unattested: [{ path: "a.js" }],
				});
		});

		it("attests an empty range only where some member still holds", () => {
			const { dir, b, c2 } = twoSessions();
			git(dir, "update-ref", "refs/remotes/origin/main", c2);
			expect(vitest(attestationOf(c2, [], { root: dir }))).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [],
				why: `no vitest certificate holds at ${c2.slice(0, 12)}`,
			});
			expect(vitest(attestationOf(c2, [b], { root: dir }))?.attested).toBe(
				true,
			);
		});

		it("refuses a stale certificate over an empty range, naming no path (#2517)", () => {
			const { dir, root, c2 } = twoSessions();
			git(dir, "update-ref", "refs/remotes/origin/main", c2);
			const stale = run(dir, root, aEdit, {
				closure: ["a.js", "b.js", "package.json"],
				at: "V",
			});
			expect(vitest(attestationOf(c2, [stale], { root: dir }))).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [],
				why: `no vitest certificate holds at ${c2.slice(0, 12)}`,
			});
		});
	});
});

describe("a narrowed certificate judged test by test (#1860)", () => {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();

	const edges = {
		"docs/wide-only.md": ["wide.test.ts"],
		"narrow.js": ["narrow.test.ts", "wide.test.ts"],
		"unread.md": [],
	};

	function repo() {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "per-test-")),
		);
		dirs.push(dir);
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		fs.mkdirSync(path.join(dir, "docs"));
		for (const f of [
			"narrow.js",
			"narrow.test.ts",
			"wide.test.ts",
			"docs/wide-only.md",
			"unread.md",
			"vitest.setup.ts",
			"package.json",
		])
			fs.writeFileSync(path.join(dir, f), `${f} v0\n`);
		fs.writeFileSync(path.join(dir, EDGES_FILE), JSON.stringify({ edges }));
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "root");
		git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
		return { dir, root: git(dir, "rev-parse", "HEAD") };
	}

	const commit = (dir: string, files: Record<string, string>, msg: string) => {
		for (const [f, body] of Object.entries(files))
			fs.writeFileSync(path.join(dir, f), body);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", msg);
		return git(dir, "rev-parse", "HEAD");
	};

	const readTree = (dir: string, sha: string) =>
		git(dir, "rev-parse", `${sha}^{tree}`);

	const perTest = (over: {
		sha: string;
		at: string;
		treeAtEnd: string;
		selected: string[];
		changedPaths: string[];
	}) =>
		certificate({
			scope: fullScope({ modulesRun: 2, changed: "x", admissible: true }),
			closure: ["package.json", ...over.selected],
			imports: Object.fromEntries(
				over.selected.map((t) => [t, ["vitest.setup.ts"]]),
			),
			roots: ["package.json"],
			...over,
		});

	const narrowEdit = { "narrow.js": "narrow.js v1\n" };

	function replay(
		theirs: Record<string, string> = {
			"docs/wide-only.md": "neighbour's edit\n",
		},
	) {
		const { dir, root } = repo();
		const scratch = commit(dir, narrowEdit, "the session's tree");
		const session = perTest({
			sha: root,
			at: "S",
			treeAtEnd: readTree(dir, scratch),
			selected: ["narrow.test.ts", "wide.test.ts"],
			changedPaths: ["narrow.js"],
		});
		git(dir, "reset", "-q", "--hard", root);
		const neighbour = commit(dir, theirs, "neighbour");
		git(dir, "update-ref", "refs/remotes/origin/main", neighbour);
		const own = commit(dir, narrowEdit, "the session's commit");
		return { dir, root, neighbour, own, session };
	}

	const vitest = (r: ReturnType<typeof attestationOf>) => {
		if (!r.judged) throw new Error(r.why);
		return r.suites.find((s) => s.suite === "vitest");
	};

	it("owes no test for a change already on origin/main, and still owes one for a change it has not taken (#2517)", () => {
		const { dir, root, neighbour, own, session } = replay();
		git(dir, "update-ref", "refs/remotes/origin/main", neighbour);
		expect(vitest(attestationOf(own, [session], { root: dir }))?.attested).toBe(
			true,
		);
		git(dir, "update-ref", "refs/remotes/origin/main", root);
		const v = vitest(attestationOf(own, [session], { root: dir }));
		expect(v?.attested === false && v.unattested).toContainEqual({
			path: "narrow.js",
			tests: ["wide.test.ts"],
		});
	});

	it("owes no test origin/main added (#2517)", () => {
		const { dir, neighbour, own, session } = replay({
			"late.test.ts": "late.test.ts v0\n",
			[EDGES_FILE]: JSON.stringify({
				edges: {
					...edges,
					"narrow.js": [...edges["narrow.js"], "late.test.ts"],
				},
			}),
		});
		git(dir, "update-ref", "refs/remotes/origin/main", neighbour);
		expect(vitest(attestationOf(own, [session], { root: dir }))?.attested).toBe(
			true,
		);
	});

	it("is attested by the original certificate plus a re-run of the owed test alone", () => {
		const { dir, own, session } = replay();
		const retest = perTest({
			sha: own,
			at: "R",
			treeAtEnd: readTree(dir, own),
			selected: ["wide.test.ts"],
			changedPaths: [],
		});
		const v = vitest(attestationOf(own, [session, retest], { root: dir }));
		expect(v?.attested).toBe(true);
		expect(v?.attested && v.members.map((m) => m.marker.at).sort()).toEqual([
			"R",
			"S",
		]);
	});

	it("takes the owed test from a neighbour's certificate whatever its diff, where it read this commit's tree", () => {
		const { dir, own, session } = replay();
		const theirs = perTest({
			sha: own,
			at: "N",
			treeAtEnd: readTree(dir, own),
			selected: ["wide.test.ts"],
			changedPaths: ["docs/wide-only.md"],
		});
		expect(
			vitest(attestationOf(own, [session, theirs], { root: dir }))?.attested,
		).toBe(true);
	});

	it("never takes a re-run for the witness: a path no run's diff names stays owed (#789)", () => {
		const { dir, own } = replay();
		const retest = perTest({
			sha: own,
			at: "R",
			treeAtEnd: readTree(dir, own),
			selected: ["narrow.test.ts", "wide.test.ts"],
			changedPaths: [],
		});
		expect(vitest(attestationOf(own, [retest], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "narrow.js" }],
		});
	});

	it("judges a certificate with no per-test field on its whole closure, as before", () => {
		const { dir, root, own, session } = replay();
		git(dir, "update-ref", "refs/remotes/origin/main", root);
		const before = {
			...session,
			imports: undefined,
			roots: undefined,
			closure: [
				"docs/wide-only.md",
				"narrow.js",
				"narrow.test.ts",
				"package.json",
				"wide.test.ts",
			],
		};
		expect(holdsTestByTree(before, "", own, { root: dir })).toBe(false);
		const v = vitest(attestationOf(own, [before], { root: dir }));
		expect(v?.attested === false && v.unattested).toContainEqual({
			path: "narrow.js",
		});
	});

	it("takes no witness whose tests' own imports changed, since the graph its selection was computed over did", () => {
		const { dir, root, own, session } = replay({ "vitest.setup.ts": "v1\n" });
		git(dir, "update-ref", "refs/remotes/origin/main", root);
		const v = vitest(attestationOf(own, [session], { root: dir }));
		expect(v?.attested === false && v.unattested).toContainEqual({
			path: "narrow.js",
		});
	});

	it("still takes that witness for a document, whose readers the manifest at the sha names, owing its voided readers", () => {
		const { dir, root } = repo();
		const docEdit = { "docs/wide-only.md": "session's edit\n" };
		const scratch = commit(dir, docEdit, "the session's tree");
		const session = perTest({
			sha: root,
			at: "S",
			treeAtEnd: readTree(dir, scratch),
			selected: ["wide.test.ts"],
			changedPaths: ["docs/wide-only.md"],
		});
		git(dir, "reset", "-q", "--hard", root);
		commit(dir, { "vitest.setup.ts": "v1\n" }, "neighbour");
		const own = commit(dir, docEdit, "the session's commit");
		const v = vitest(attestationOf(own, [session], { root: dir }));
		expect(v?.attested === false && v.unattested).toContainEqual({
			path: "docs/wide-only.md",
			tests: ["wide.test.ts"],
		});
	});

	it("answers an empty range alone only where every test it selected holds", () => {
		const { dir, own, session } = replay();
		git(dir, "update-ref", "refs/remotes/origin/main", own);
		expect(vitest(attestationOf(own, [session], { root: dir }))?.attested).toBe(
			false,
		);
		const whole = perTest({
			sha: own,
			at: "W",
			treeAtEnd: readTree(dir, own),
			selected: ["narrow.test.ts"],
			changedPaths: [],
		});
		expect(vitest(attestationOf(own, [whole], { root: dir }))?.attested).toBe(
			true,
		);
	});

	it("voids every test where a root changed, naming no test to re-run", () => {
		const { dir, own, session } = replay();
		const bumped = commit(dir, { "package.json": "v1\n" }, "root bump");
		git(dir, "update-ref", "refs/remotes/origin/main", own);
		expect(vitest(attestationOf(bumped, [session], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "package.json" }],
		});
	});

	it("attests a path no test reads by a witness naming it", () => {
		const { dir, root } = repo();
		const own = commit(dir, { "unread.md": "edited\n" }, "unread");
		const session = perTest({
			sha: root,
			at: "S",
			treeAtEnd: readTree(dir, own),
			selected: [],
			changedPaths: ["unread.md"],
		});
		expect(vitest(attestationOf(own, [session], { root: dir }))?.attested).toBe(
			true,
		);
	});

	it("owes nothing for a reader the commit deletes", () => {
		const { dir, root } = repo();
		fs.rmSync(path.join(dir, "wide.test.ts"));
		fs.writeFileSync(
			path.join(dir, EDGES_FILE),
			JSON.stringify({ edges: { "narrow.js": ["narrow.test.ts"] } }),
		);
		const own = commit(dir, narrowEdit, "drop the wide test");
		const session = perTest({
			sha: root,
			at: "S",
			treeAtEnd: readTree(dir, own),
			selected: ["narrow.test.ts"],
			changedPaths: [EDGES_FILE, "narrow.js", "wide.test.ts"],
		});
		expect(vitest(attestationOf(own, [session], { root: dir }))?.attested).toBe(
			true,
		);
	});
});

describe("a red run's recovery command (#3625)", () => {
	const at = (i: number) =>
		new Date(Date.now() - 10_000 + i * 1000).toISOString();
	const red = (i: number, file: string) => ({
		sha: "a".repeat(40),
		at: at(i),
		scope: redScope([{ file, tests: ["fails"] }]),
	});
	const mine = red(0, "scripts/mine.test.ts");
	const run = (root: string) =>
		execFileSync("sh", ["-c", failureRecoveryCommand(root, mine)], {
			cwd: sandbox(),
			encoding: "utf8",
		});

	it("prints this run's failures, not a neighbour's written after it", () => {
		const root = sandbox();
		recordFailure(mine, { root });
		recordFailure(red(1, "scripts/theirs.test.ts"), {
			root,
		});

		expect(run(root)).toBe("scripts/mine.test.ts — fails\n");
	});

	it("finds the line a prune moved to the archive", () => {
		const root = sandbox();
		recordFailure(mine, { root });
		for (let i = 1; i <= 3; i++)
			recordFailure(red(i, "scripts/theirs.test.ts"), {
				root,
				pruneAt: 3,
				keep: 2,
			});

		expect(run(root)).toBe("scripts/mine.test.ts — fails\n");
	});

	it("says so where neither store holds the line", () => {
		expect(run(sandbox())).toBe("no line for this run in either store\n");
	});
});
