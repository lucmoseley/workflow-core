// @vitest-environment node
/*
 * The store and the warnings behind mantahostels#987's warn-only pre-push gate.
 *
 * Two properties carry mantahostels#908's ruling and are asserted hardest: the gate never
 * DENIES anything — every degraded store reads as "no marker" rather than as an
 * error — and a green it cannot vouch for is never presented as clean.
 *
 * In-process, with every store in its own temp sandbox, so no case reads or
 * writes this checkout's real markers.
 *
 * `.husky/pre-push` reads the store through `check-test-marker.js` on every
 * push, and `npm run push:check` on the same records; loosen a case and a push
 * of untested commits reads as covered, or a store fault blocks a push the
 * ruling says may only be warned on.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubLaunch } from "./suite-handoff-testkit";
import {
	attestationOf,
	attestationReading,
	EDGES_FILE,
	FAIL_STORE,
	FULL_REASONS,
	formatFilteredRun,
	holdsAt,
	isAdmissibleRun,
	isFullRun,
	KEEP,
	lastFullRed,
	markerFrom,
	readFailures,
	readMarkers,
	record,
	recordFailure,
	sessionAttestation,
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

/* `skipped: 10` on a full run: skips do not make a run partial (mantahostels#1230). */
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

/** Inside the archive's reach, which the fixed `green().at` is not. */
const fresh = () => new Date().toISOString();

/** How long a pruned run stays in the archive (#1231), spelled here rather
 *  than imported. */
const ARCHIVE_REACH_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a store's pruned lines go: `<store>.archive.jsonl` beside it. */
const archivePath = (root: string, store?: string) =>
	storePath(root, store).replace(/\.jsonl$/, ".archive.jsonl");

/**
 * The shas in `store`'s archive, the default marker store's when `store` is
 * absent.
 */
const archivedShas = (root: string, store?: string) =>
	fs
		.readFileSync(archivePath(root, store), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l).sha);

const green = (over: Record<string, unknown> = {}) => ({
	sha: "a".repeat(40),
	at: "2026-08-21T08:00:00.000Z",
	dirtyAtStart: false,
	dirtyCount: 0,
	headMovedDuringRun: false,
	foreign: [],
	scope: fullScope(),
	...over,
});

/** A green whose scope nobody recorded (mantahostels#1230). */
const unscoped = (over: Record<string, unknown> = {}) => {
	const { scope: _scope, ...rest } = green(over);
	return rest;
};

/** A green from `vitest run <file> -t <name>`. */
const narrowed = (over: Record<string, unknown> = {}) =>
	green({
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
	it("round-trips a marker", () => {
		const root = sandbox();
		expect(record(green(), { root })).toBe(true);
		expect(readMarkers({ root })).toEqual([green()]);
	});

	it("appends rather than replacing, so a second suite's green survives", () => {
		const root = sandbox();
		record(green(), { root });
		record(green({ sha: "b".repeat(40) }), { root });
		expect(readMarkers({ root }).map((m) => m.sha)).toEqual([
			"a".repeat(40),
			"b".repeat(40),
		]);
	});

	it("skips a torn line instead of throwing on it", () => {
		const root = sandbox();
		record(green(), { root });
		fs.appendFileSync(storePath(root), '{"sha":"trunc\n');
		record(green({ sha: "c".repeat(40) }), { root });
		expect(readMarkers({ root }).map((m) => m.sha)).toEqual([
			"a".repeat(40),
			"c".repeat(40),
		]);
	});

	it("drops a line carrying no sha — a marker that names no commit attests nothing", () => {
		const root = sandbox();
		fs.writeFileSync(storePath(root), '{"at":"now"}\n[]\nnull\n');
		expect(readMarkers({ root })).toEqual([]);
	});

	it("reads an absent store as no markers, never as an error", () => {
		expect(readMarkers({ root: sandbox() })).toEqual([]);
		expect(readMarkers({ root: null })).toEqual([]);
	});

	it("refuses to write a marker with no sha, and never throws on an unwritable store", () => {
		const root = sandbox();
		expect(record(green({ sha: null }), { root })).toBe(false);
		expect(record(green(), { root: null })).toBe(false);
		// A directory where the store file goes: the append fails, the caller does not.
		const blocked = sandbox();
		fs.mkdirSync(storePath(blocked));
		expect(record(green(), { root: blocked })).toBe(false);
	});

	it("prunes to the newest KEEP once past the threshold", () => {
		const root = sandbox();
		for (let i = 0; i < 12; i++)
			record(green({ sha: String(i).padStart(40, "0") }), {
				root,
				pruneAt: 10,
				keep: 4,
			});
		const shas = readMarkers({ root }).map((m) => m.sha);
		// Pruned to the newest 4 as the 11th line landed; the 12th then appended.
		expect(shas).toEqual(
			[7, 8, 9, 10, 11].map((i) => String(i).padStart(40, "0")),
		);
	});

	it("holds 800 lines by default, and prunes to KEEP as the 801st lands", () => {
		const root = sandbox();
		const line = (i: number) =>
			JSON.stringify(green({ sha: String(i).padStart(40, "0"), at: fresh() }));
		fs.writeFileSync(
			storePath(root),
			`${Array.from({ length: 799 }, (_, i) => line(i)).join("\n")}\n`,
		);
		record(green({ sha: "e".repeat(40), at: fresh() }), { root });
		expect(readMarkers({ root })).toHaveLength(800);
		record(green({ sha: "f".repeat(40), at: fresh() }), { root });
		const kept = readMarkers({ root });
		expect(kept).toHaveLength(KEEP);
		expect(kept.at(-1)?.sha).toBe("f".repeat(40));
		expect(KEEP).toBeLessThan(800);
	});

	it("moves what a prune drops into the archive (#1231)", () => {
		const root = sandbox();
		for (let i = 0; i < 12; i++)
			record(green({ sha: String(i).padStart(40, "0"), at: fresh() }), {
				root,
				pruneAt: 10,
				keep: 4,
			});
		const archived = archivedShas(root);
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
			`${JSON.stringify(green({ sha: "a".repeat(40), at: stale }))}\nnot json\n${JSON.stringify(green({ sha: "9".repeat(40), at: lastDay }))}\n${JSON.stringify(green({ sha: "b".repeat(40), at: fresh() }))}\n`,
		);
		for (let i = 0; i < 3; i++)
			record(green({ sha: String(i).repeat(40), at: fresh() }), {
				root,
				pruneAt: 2,
				keep: 1,
			});
		const archived = archivedShas(root);
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
			recordFailure(green({ sha: String(i).repeat(40), at: fresh() }), {
				root,
				pruneAt: 3,
				keep: 2,
			});
		expect(archivedShas(root, FAIL_STORE)).toEqual([
			"0".repeat(40),
			"1".repeat(40),
		]);
		expect(fs.existsSync(archivePath(root))).toBe(false);
	});

	it("keeps one copy of a run two racing prunes both archive", () => {
		const root = sandbox();
		const line = JSON.stringify(green({ sha: "c".repeat(40), at: fresh() }));
		fs.writeFileSync(storePath(root), `${line}\n${line}\n`);
		fs.writeFileSync(archivePath(root), `${line}\n`);
		record(green({ sha: "d".repeat(40), at: fresh() }), {
			root,
			pruneAt: 2,
			keep: 1,
		});
		expect(archivedShas(root)).toEqual(["c".repeat(40)]);
	});

	it("leaves the store unpruned, and still reports the run landed, when the archive cannot be written", () => {
		const root = sandbox();
		fs.mkdirSync(archivePath(root), { recursive: true });
		const landed = [0, 1, 2].map((i) =>
			record(green({ sha: String(i).repeat(40), at: fresh() }), {
				root,
				pruneAt: 2,
				keep: 1,
			}),
		);
		expect(landed).toEqual([true, true, true]);
		expect(readMarkers({ root })).toHaveLength(3);
	});
});

/**
 * Whether the push warns that a green matched by sha read a dirty tree —
 * what a clean green means to `attestationReading`, its one reader.
 */
const warnsDirty = (marker: Record<string, unknown>) =>
	attestationReading(
		"a".repeat(40),
		{
			judged: true,
			base: "b".repeat(40),
			range: [],
			suites: [
				{
					suite: "vitest",
					attested: true,
					members: [{ marker, match: { by: "sha" } }],
					note: null,
				},
			],
		} as unknown as Parameters<typeof attestationReading>[1],
		{ pushing: true },
	).text.includes("dirty tree");

describe("what counts as a clean green", () => {
	it("is a run over a still tree and nothing else", () => {
		expect(warnsDirty(green())).toBe(false);
		expect(warnsDirty(green({ dirtyAtStart: true }))).toBe(true);
		expect(warnsDirty(green({ headMovedDuringRun: true }))).toBe(true);
		expect(warnsDirty(green({ foreign: [{ path: "a.ts", why: "x" }] }))).toBe(
			true,
		);
		expect(warnsDirty(green({ startStateUnknown: true }))).toBe(true);
	});
});

describe("what counts as the whole suite (mantahostels#1230)", () => {
	it("accepts a run that collected every module in the corpus", () => {
		expect(isFullRun(green())).toBe(true);
	});

	it("ignores skipped tests, which a conditional skip makes normal", () => {
		expect(isFullRun(green({ scope: fullScope({ skipped: 400 }) }))).toBe(true);
	});

	it("rejects a name filter even where every module was collected", () => {
		expect(
			isFullRun(green({ scope: fullScope({ nameFilter: "/ref/" }) })),
		).toBe(false);
	});

	it("rejects a path filter even where every module was collected", () => {
		expect(
			isFullRun(green({ scope: fullScope({ fileFilters: ["a.test.ts"] }) })),
		).toBe(false);
	});

	it("rejects a run short of the corpus", () => {
		expect(isFullRun(green({ scope: fullScope({ modulesRun: 122 }) }))).toBe(
			false,
		);
	});

	it("rejects a zero corpus, which means the glob never resolved", () => {
		expect(
			isFullRun(
				green({ scope: fullScope({ modulesRun: 0, modulesTotal: 0 }) }),
			),
		).toBe(false);
	});

	it("rejects a marker that carries no scope (mantahostels#1230)", () => {
		expect(isFullRun(unscoped())).toBe(false);
	});
});

describe("a diff-selected run's certificate (mantahostels#2031)", () => {
	/** A green from `npm run test:changed` — narrowed, and carrying NO path filter. */
	const changedRun = (ref: string | boolean = "HEAD~1") =>
		green({
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

	/* The case above passes on the module count alone, so it would survive
	 * `changed` being dropped from Scope entirely. This one cannot: every other
	 * limb is satisfied, and `--changed` is the only thing disqualifying it. */
	it("rejects a --changed run that reached every module, on provenance", () => {
		expect(isFullRun(green({ scope: fullScope({ changed: "HEAD~1" }) }))).toBe(
			false,
		);
	});
});

describe("both suites answer for themselves (mantahostels#1256)", () => {
	it("reads a marker carrying no suite as vitest, so pre-mantahostels#1256 lines still count", () => {
		expect(suiteOf(green())).toBe("vitest");
	});
});

/* `attestationOf`'s verdict as a session reads it (#814), driven over hand-built
 * verdicts: the reading is pure, and `attestationOf` has its own real-repo block. */
describe("what a session reads off the cover (#814)", () => {
	const attestedSha = "a".repeat(40);
	const baseSha = "b".repeat(40);
	const C1 = "c".repeat(40);
	const pushCheckCommand = "npm run push:check";
	type Verdict = Parameters<typeof attestationReading>[1];
	const judged = (suites: unknown[]) =>
		({ judged: true, base: baseSha, range: [], suites }) as unknown as Verdict;
	const owed = (suite = "vitest", paths = ["scripts/a.js"]) => ({
		suite,
		attested: false,
		unattested: paths.map((p) => ({ path: p, commit: C1 })),
	});
	const attested = (members: unknown[], note: string | null = null) => ({
		suite: "vitest",
		attested: true,
		members,
		note,
	});
	const bySha = (over: Record<string, unknown> = {}) => ({
		marker: green(over),
		match: { by: "sha" },
	});

	it("names each uncovered file and its commit, says they are public, and asks for a run and a push:check — never a push again", () => {
		const { state, text } = attestationReading(attestedSha, judged([owed()]), {
			pushing: true,
			pushCheck: pushCheckCommand,
		});
		expect(state).toBe("owed");
		expect(text).toContain(
			`NO GREEN VITEST RUN COVERS 1 FILE(S) IN ${baseSha.slice(0, 12)}..${attestedSha.slice(0, 12)}`,
		);
		expect(text).toContain(`scripts/a.js — commit ${C1.slice(0, 12)}`);
		expect(text).toContain("Those commits are already public.");
		expect(text).toContain(
			"Run `npm run test` now, report any red, and run `npm run push:check` before your next push.",
		);
		expect(text).toContain("never refuses a push");
		expect(text).not.toMatch(/push again/i);
	});

	it("tells push:check's reader to run for what it names, then push", () => {
		const { state, text } = attestationReading(attestedSha, judged([owed()]));
		expect(state).toBe("owed");
		expect(text).toContain("Run `npm run test` for that, then push.");
		expect(text).not.toContain("already public");
	});

	it("says why where a suite names no file — an empty range nothing holds at", () => {
		const { text } = attestationReading(
			attestedSha,
			judged([
				{
					suite: "vitest",
					attested: false,
					unattested: [],
					why: "no green vitest run holds at aaaaaaaaaaaa",
				},
			]),
		);
		expect(text).toContain("⚠  no green vitest run holds at aaaaaaaaaaaa.");
	});

	it("lists twenty files and counts the rest", () => {
		const paths = Array.from({ length: 23 }, (_, i) => `f${i}.js`);
		const { text } = attestationReading(
			attestedSha,
			judged([owed("vitest", paths)]),
		);
		expect(text).toContain("f19.js");
		expect(text).not.toContain("f20.js");
		expect(text).toContain("…and 3 more");
	});

	it("is silent at the push on a clean cover by sha, and names the covering runs to push:check", () => {
		const verdict = judged([attested([bySha({ at: "T1" })])]);
		expect(attestationReading(attestedSha, verdict, { pushing: true })).toEqual(
			{
				state: "attested",
				text: "",
			},
		);
		const { text } = attestationReading(attestedSha, verdict);
		expect(text).toContain("✓  VITEST: every file in the range is covered");
		expect(text).toContain(`T1 on ${attestedSha.slice(0, 12)} — full run`);
	});

	it("passes a tree match's note through, and warns where a member matched by sha read a dirty tree", () => {
		const note = "ℹ  vitest: attested by tree x\n";
		const tree = attestationReading(
			attestedSha,
			judged([
				attested(
					[
						{
							marker: green({ dirtyAtStart: true }),
							match: { by: "tree", tree: "x", closureSize: "*" },
						},
					],
					note,
				),
			]),
			{ pushing: true },
		);
		expect(tree.text).toBe(note);
		const dirty = attestationReading(
			attestedSha,
			judged([attested([bySha({ dirtyAtStart: true, dirtyCount: 2 })])]),
			{ pushing: true },
		);
		expect(dirty.text).toContain("dirty tree: the green vitest run");
	});

	it("answers each suite for itself", () => {
		const { state, text } = attestationReading(
			attestedSha,
			judged([attested([bySha()]), owed("pytest", ["pipe.py"])]),
		);
		expect(state).toBe("owed");
		expect(text).toContain("✓  VITEST");
		expect(text).toContain("NO GREEN PYTEST RUN COVERS 1 FILE(S)");
		expect(text).toContain("Run `npm run test:py` for that");
	});

	it("says it could not judge, and why", () => {
		const { state, text } = attestationReading(
			attestedSha,
			{ judged: false, why: "git could not diff x..y" },
			{ pushing: true },
		);
		expect(state).toBe("unjudged");
		expect(text).toContain("could not judge whether green runs cover");
		expect(text).toContain("git could not diff x..y");
		expect(text).toContain("never refuses a push");
	});
});

describe("the line a narrowed run prints for itself (mantahostels#1230)", () => {
	it("prints nothing for a full run", () => {
		expect(formatFilteredRun(fullScope())).toBeNull();
	});

	it("prints nothing where the reporter could not describe the run", () => {
		expect(formatFilteredRun(null)).toBeNull();
	});

	it("calls a zero corpus filtered, agreeing with the push-time predicate", () => {
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
});

/*
 * What a green run tells the pre-push gate (mantahostels#987). Asserted as a pure function
 * over the two tree-drift results, so the record's contents can be checked
 * without a suite run to produce them.
 */
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
		try {
			const m = markerFrom({ head: "old", files: {} }, after, null, {
				sessionId: null,
			});
			expect(m).not.toHaveProperty("argv");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("carries neither field where neither is known", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			sessionId: null,
			argv: null,
		});

		expect(m).not.toHaveProperty("sessionId");
		expect(m).not.toHaveProperty("argv");
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

	// mantahostels#1953 (why a run's elapsed time is recorded).
	it("records when the run began and how long it took", () => {
		const startedAtMs = Date.parse("2026-10-17T06:00:00Z");
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs,
			endedAtMs: startedAtMs + 5000,
		});

		expect(m.startedAt).toBe(new Date(startedAtMs).toISOString());
		expect(m.durationMs).toBe(5000);
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
			});

			expect(m).not.toHaveProperty("startedAt");
			expect(m).not.toHaveProperty("durationMs");
		}
	});

	/*
	 * Absence, not a clamp to zero: a `durationMs: 0` beside a `startedAt` that
	 * postdates the marker's own `at` attests an instant run, which is the
	 * reading these fields exist to make trustworthy.
	 */
	it("records nothing at all where the clock went backwards, rather than a zero", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs: Date.now() + 60_000,
		});

		expect(m).not.toHaveProperty("durationMs");
		expect(m).not.toHaveProperty("startedAt");
	});

	/*
	 * The `machine` block (mantahostels#1953). A `busyPct: 0` where nothing was measured
	 * is the one reading the block exists to prevent — it looks like a MEASURED
	 * idle machine rather than an absent one.
	 *
	 * Brackets are fabricated rather than sampled, so the arithmetic is asserted
	 * against a known answer and the cases run identically off /proc.
	 */
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

		/*
		 * Asserted as a share of the ceiling this machine reports, never as an
		 * absolute: `delta` defaults its core count to `os.cpus()`, so a literal
		 * here would pin the test to an 8-core box. 700 busy jiffies of a
		 * 1000-jiffie span is 70% of whatever the ceiling is.
		 */
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

	/*
	 * `markerFrom` runs from a globalSetup teardown firing once per PROCESS, so
	 * passing the run's end in is what keeps a watch session's idle minutes out
	 * of both the duration and the CPU delta (mantahostels#1953's review).
	 */
	it("times the run the caller ended, not the moment the marker was written", () => {
		const startedAtMs = Date.now() - 600_000;
		const endedAtMs = startedAtMs + 5000;
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			startedAtMs,
			endedAtMs,
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

	it("names a neighbour's claimed file, and says when its holder is gone", () => {
		const m = markerFrom(null, after, null, {
			held: [
				{ path: "docs/x.md", sessionId: "sess-1", dead: false },
				{ path: "scripts/y.js", sessionId: "sess-2", dead: true },
			],
		});

		expect(m.foreign[0]).toEqual({
			path: "docs/x.md",
			why: "held by sess-1, dirty before this run began",
		});
		expect(m.foreign[1].why).toContain("GONE");
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

	it("stamps the suite it was told, so pytest's green is not read as vitest's", () => {
		const m = markerFrom({ head: "old", files: {} }, after, null, {
			suite: "pytest",
		});

		expect(m.suite).toBe("pytest");
	});

	/*
	 * mantahostels#2187: an end-of-run tree identity and an `--isolated` flag, added
	 * alongside the three tree fields that already describe the START of a run.
	 */
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

/*
 * Which suites a push is asked about (mantahostels#1256). The pytest suite covers the
 * Python data-pipeline seam alone, so a docs-only push it cannot have broken
 * must not warn about it.
 */
describe("the suites a range is asked about", () => {
	/**
	 * The suites `attestationOf` judges for a range of one commit touching `paths`
	 * on top of `origin/main`.
	 */
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

	// mantahostels#2170 took `package.json` out of the touches regex.
	it("drops pytest from a package.json-only diff, selecting vitest alone", () => {
		expect(suitesAskedOf(["package.json"])).toEqual(["vitest"]);
	});
});

describe("the red store (mantahostels#1942)", () => {
	it("writes the red run to its own store, never the green one", () => {
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

	/* Neither store's writer throws: the suite has ALREADY reported its verdict
	 * by the time this runs. */
	it("returns false rather than throwing when the store cannot be written", () => {
		const root = sandbox();
		// A file where the markers directory's parent goes.
		fs.writeFileSync(path.join(root, ".claude"), "");
		let landed: boolean | undefined;
		expect(() => {
			landed = recordFailure({ sha: "c".repeat(40) }, { root });
		}).not.toThrow();
		// A swallowed write must report itself, or a caller reads it as landed.
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

describe("a filtered run that meets the push gate (mantahostels#2146, mantahostels#2207)", () => {
	/** `npm run test:changed` over a tree whose manifest was fresh. */
	const admissible = (over: Record<string, unknown> = {}) =>
		green({
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

	/* The field crosses a process boundary as an env var, so the value that
	 * arrives is whatever a caller exported. Truthy is not the test. */
	it("is not claimable by a truthy value that is not the flag", () => {
		for (const value of ["1", 1, "true", {}])
			expect(isAdmissibleRun(admissible({ admissible: value }))).toBe(false);
	});

	it("is not claimable by a run whose corpus never resolved", () => {
		expect(isAdmissibleRun(admissible({ modulesTotal: 0 }))).toBe(false);
	});

	/* The launcher refuses `-t`, so this marker never came from the gate
	 * command however the flag reached it (mantahostels#2172). */
	it("is not claimable by a name-filtered run, whatever set the flag", () => {
		expect(isAdmissibleRun(admissible({ nameFilter: "/spawn/" }))).toBe(false);
	});

	it("leaves the full-run definition alone — mantahostels#1230 stands", () => {
		const full = green({ scope: fullScope({ admissible: true }) });
		expect(isFullRun(full)).toBe(true);
		expect(isAdmissibleRun(full)).toBe(false);
	});

	/* `viaChanged` is a denominator and not a certificate (mantahostels#2303): it says the
	 * run came from `npm run test:changed`, which is exactly the claim a run
	 * that FAILED the freshness check can also make. A predicate reading it
	 * would hand the gate to the runs it exists to count. */
	it("is not claimable by the route flag, which certifies nothing", () => {
		/* The key is ABSENT on a failed launch, not present-and-undefined: the
		 * reporter spreads it in only when the flag was set. */
		const routed = green({
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
		expect(formatFilteredRun(admissible().scope)).toContain(
			"MEETS the push gate",
		);
		expect(formatFilteredRun(narrowed().scope)).not.toContain(
			"MEETS the push gate",
		);
	});
});

describe("why a full run was full (mantahostels#3207)", () => {
	it("leaves isFullRun's verdict unaffected by which reason the scope carries", () => {
		const bare = isFullRun(green());
		for (const reason of FULL_REASONS)
			expect(isFullRun(green({ scope: fullScope({ full: reason }) }))).toBe(
				bare,
			);
	});

	/* A marker predating mantahostels#3207 carries no reader for `full` at all — only
	 * `isAdmissibleScope`'s presence check (`!scope.full`, tested below) reads
	 * the field, and that reads absence and a bad value alike. */
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
		expect(isAdmissibleRun(green({ scope }))).toBe(false);
	});

	it("still lets a full scope's own admissible flag be ignored, unharmed by the new limb", () => {
		expect(
			isFullRun(
				green({ scope: fullScope({ admissible: true, full: "flag" }) }),
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
		scope: {
			modulesRun: 40,
			modulesTotal: 40,
			tests: 200,
			skipped: 0,
			failures: files.map((file) => ({ file, tests: ["a case"] })),
			...scope,
		},
		...rest,
	});

	it("reads the red store, never the green one", () => {
		const root = sandbox();
		record({ sha: "a".repeat(40), at: "now" }, { root });
		recordFailure(red("b".repeat(40), ["one.test.ts"]), { root });

		expect(readFailures({ root }).map((m) => m.sha)).toEqual(["b".repeat(40)]);
		expect(readMarkers({ root }).map((m) => m.sha)).toEqual(["a".repeat(40)]);
	});

	it("answers [] for an absent store, so the caller can fail open", () => {
		expect(readFailures({ root: sandbox() })).toEqual([]);
	});

	it("takes the newest red that collected at least 90% of the corpus", () => {
		expect(
			lastFullRed([
				red("a".repeat(40), ["old.test.ts"]),
				red("b".repeat(40), ["wide.test.ts"], {
					modulesRun: 36,
					modulesTotal: 40,
				}),
				red("c".repeat(40), ["narrow.test.ts"], { modulesRun: 35 }),
			])?.sha,
		).toBe("b".repeat(40));
	});

	it("answers null when every red is narrower than that", () => {
		expect(
			lastFullRed([red("a".repeat(40), ["one.test.ts"], { modulesRun: 1 })]),
		).toBeNull();
	});

	it("answers null for a red that names no failing file", () => {
		expect(lastFullRed([red("a".repeat(40), [])])).toBeNull();
	});

	it("skips another suite's red", () => {
		expect(
			lastFullRed([
				red("a".repeat(40), ["py.test.ts"], {}, { suite: "pytest" }),
			]),
		).toBeNull();
	});

	it("answers null for a scopeless marker, rather than throwing", () => {
		expect(lastFullRed([{ sha: "a".repeat(40), at: "now" }])).toBeNull();
	});

	it("skips a red narrowed by a name filter, whatever its module ratio", () => {
		/* `-t <pattern>` collects every module and runs a handful of tests, so
		 * the ratio alone cannot see the narrowing. */
		expect(
			lastFullRed([
				red("a".repeat(40), ["named.test.ts"], { nameFilter: "x" }),
			]),
		).toBeNull();
	});

	it("still offers a file-filtered or --changed red the ratio admits", () => {
		/* Both narrow what is COLLECTED, so `modulesRun` already carries them. */
		expect(
			lastFullRed([
				red("a".repeat(40), ["wide.test.ts"], {
					fileFilters: ["wide.test.ts"],
					changed: "HEAD~1",
					modulesRun: 38,
				}),
			])?.sha,
		).toBe("a".repeat(40));
	});

	it("walks back past a skipped red rather than answering null", () => {
		expect(
			lastFullRed([
				red("a".repeat(40), ["older.test.ts"]),
				red("b".repeat(40), [], {}),
				red("c".repeat(40), ["py.test.ts"], {}, { suite: "pytest" }),
			])?.sha,
		).toBe("a".repeat(40));
	});

	it("reports the failing files once each, deduped", () => {
		expect(
			lastFullRed([red("a".repeat(40), ["one.test.ts", "one.test.ts"])])?.files,
		).toEqual(["one.test.ts"]);
	});
});

/*
 * #189: a certificate attests a tree plus a read closure, so a sha other than
 * the one stamped can be cleared by content.
 */
describe("attesting a sha by tree (#189)", () => {
	const attestedSha = "a".repeat(40);
	const other = "b".repeat(40);
	const treeSha = "c".repeat(40);
	const baseSha = "d".repeat(40);

	/**
	 * A git that answers each of the four calls from a table: the sha's tree,
	 * the manifest at the sha (`null`: absent there), the paths differing
	 * between the marker's tree and the sha's, and the paths in the sha's
	 * range from the marker's base.
	 */
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
		green({ sha: other, treeAtEnd: treeSha, closure: "*", ...over });

	const narrowedRun = (over: Record<string, unknown> = {}) =>
		green({
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
		holdsAt(m as Parameters<typeof holdsAt>[0], attestedSha, {
			root,
			execFn: io.fn,
		});

	it("rule 1: a matching sha attests by sha, asking git nothing", () => {
		const io = scripted();
		expect(at(green({ sha: attestedSha }), io)).toEqual({ by: "sha" });
		expect(at(unscoped({ sha: attestedSha }), io)).toEqual({ by: "sha" });
		expect(io.calls).toEqual([]);
	});

	it("rule 2: a marker lacking treeAtEnd or closure attests no other sha, even over an equal tree", () => {
		expect(at(green({ sha: other, closure: "*" }))).toBeNull();
		expect(at(green({ sha: other, treeAtEnd: treeSha }))).toBeNull();
		expect(at(unscoped({ sha: other }))).toBeNull();
		expect(at(full({ closure: 42 }))).toBeNull();
	});

	it("rule 3, full run: tree equality attests, one rev-parse and no diff", () => {
		const io = scripted({ tree: treeSha });
		expect(at(full(), io)).toEqual({
			by: "tree",
			tree: treeSha,
			closureSize: "*",
		});
		expect(io.calls).toEqual([["rev-parse", `${attestedSha}^{tree}`]]);
	});

	it("rule 3, full run: a differing tree refuses", () => {
		expect(at(full(), scripted({ tree: "e".repeat(40) }))).toBeNull();
	});

	it("rule 3, narrowed: a closure the diff-tree leaves untouched attests, with the closure's size, asking nothing of the range (#814)", () => {
		const io = scripted({
			touched: ["docs/other.md"],
			range: ["scripts/b.js"],
		});
		expect(at(narrowedRun(), io)).toEqual({
			by: "tree",
			tree: treeSha,
			closureSize: 3,
		});
		expect(io.calls.map((c) => c[0])).toEqual(["diff-tree"]);
		expect(io.calls[0]).toContain("--no-renames");
	});

	it("rule 3, narrowed: a touched closure path refuses, reading nothing past the diff-tree", () => {
		const io = scripted({ touched: ["scripts/a.js"], range: ["scripts/a.js"] });
		expect(at(narrowedRun(), io)).toBeNull();
		expect(io.calls.map((c) => c[0])).toEqual(["diff-tree"]);
	});

	/*
	 * #799: the manifest is no closure root. A marker carrying `selected`
	 * re-reads it at the sha judged and covers what it maps to those tests.
	 */
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
			expect(at(selecting(), io)).toEqual({
				by: "tree",
				tree: treeSha,
				closureSize: 4,
			});
			expect(io.calls[0]).toEqual([
				"show",
				`${attestedSha}:docs/test-read-edges.json`,
			]);
			expect(io.calls.map((c) => c[0])).toEqual(["show", "diff-tree"]);
		});

		it("refuses a new edge from a selected test onto a document that also changed", () => {
			const io = scripted({
				manifest: edges({
					"docs/new.md": ["scripts/z.test.ts", "scripts/a.test.ts"],
				}),
				touched: ["docs/test-read-edges.json", "docs/new.md"],
				range: ["scripts/a.js"],
			});
			expect(at(selecting(), io)).toBeNull();
		});

		it("refuses where the manifest is absent, unparseable or malformed at the sha", () => {
			for (const manifest of [
				null,
				"{",
				"null",
				JSON.stringify({}),
				JSON.stringify({ edges: [] }),
				JSON.stringify({ edges: { "docs/x.md": "scripts/a.test.ts" } }),
			])
				expect(at(selecting(), scripted({ manifest }))).toBeNull();
		});

		it("judges a pre-#799 marker, the manifest in its closure, on that closure alone and never re-reads", () => {
			const old = narrowedRun({
				closure: [
					"scripts/a.test.ts",
					"docs/test-read-edges.json",
					"package.json",
				],
			});
			const moved = scripted({ touched: ["docs/test-read-edges.json"] });
			expect(at(old, moved)).toBeNull();
			const still = scripted({ touched: ["docs/other.md"] });
			expect(at(old, still)).not.toBeNull();
			expect([...moved.calls, ...still.calls].map((c) => c[0])).not.toContain(
				"show",
			);
		});
	});

	it("attests nothing where git will not answer, or there is no root", () => {
		expect(at(full(), scripted({ throws: true }))).toBeNull();
		expect(at(full(), scripted(), null)).toBeNull();
	});

	it("memoises git across markers through a shared cache", () => {
		const io = scripted();
		const cache = new Map();
		holdsAt(full(), attestedSha, { root: "/repo", execFn: io.fn, cache });
		holdsAt(full({ at: "later" }), attestedSha, {
			root: "/repo",
			execFn: io.fn,
			cache,
		});
		expect(io.calls).toHaveLength(1);
	});

	describe("what the marker carries", () => {
		const before = { head: other, files: {} };
		const after = { head: other, files: {} };
		const make = (attestation: unknown) =>
			markerFrom(before, after, null, {
				held: [],
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

		it("writes closure '*' for a full run and neither selected, changedPaths nor base beside it", () => {
			const m = make({
				closure: "*",
				selected: ["a.test.ts"],
				changedPaths: ["a.js"],
				base: baseSha,
			});
			expect(m.closure).toBe("*");
			expect(m).not.toHaveProperty("selected");
			expect(m).not.toHaveProperty("changedPaths");
			expect(m).not.toHaveProperty("base");
		});

		it("omits both where the reporter handed nothing, or a malformed closure", () => {
			for (const a of [null, { closure: 7 }, { closure: [1, 2] }]) {
				const m = make(a);
				expect(m).not.toHaveProperty("closure");
				expect(m).not.toHaveProperty("changedPaths");
			}
		});
	});

	/*
	 * #150 Q6, over real git: a narrowed run over a tree holding a neighbour's
	 * dirty file, whose dirt lies outside the closure, attests the commit made
	 * from the session's own part of that tree.
	 */
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

		/** The marker a narrowed green over the CURRENT dirty tree would leave. */
		function markerOver(
			dir: string,
		): Parameters<typeof holdsAt>[0] & { treeAtEnd: string } {
			const stashed = git(dir, "stash", "create");
			return green({
				sha: git(dir, "rev-parse", "HEAD"),
				treeAtEnd: git(dir, "rev-parse", `${stashed}^{tree}`),
				scope: fullScope({ modulesRun: 1, changed: "HEAD", admissible: true }),
				closure: ["lib.test.ts", "lib.js", "package.json"],
				changedPaths: git(dir, "diff", "--name-only", "HEAD").split("\n"),
				base: git(dir, "rev-parse", "HEAD"),
				dirtyAtStart: true,
				dirtyCount: 2,
				foreign: [{ path: "other.txt", why: "held by a neighbour" }],
			}) as unknown as ReturnType<typeof markerOver>;
		}

		it("attests the commit made from the session's own edit, and clears the push", () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			fs.writeFileSync(path.join(dir, "other.txt"), "neighbour's dirt\n");
			const m = markerOver(dir);
			git(dir, "commit", "-q", "-m", "own edit", "--", "lib.js");
			const sha = git(dir, "rev-parse", "HEAD");

			expect(sha).not.toBe(m.sha);
			expect(holdsAt(m, sha, { root: dir })).toEqual({
				by: "tree",
				tree: m.treeAtEnd,
				closureSize: 3,
			});
			const { state, text } = attestationReading(
				sha,
				attestationOf(sha, [m], { root: dir }),
				{ pushing: true },
			);
			expect(state).toBe("attested");
			expect(text).toContain("attested by tree");
			expect(text).not.toContain("dirty tree");
		});

		it("stops attesting once the closure is edited again, even inside changedPaths", () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			fs.writeFileSync(path.join(dir, "other.txt"), "neighbour's dirt\n");
			const m = markerOver(dir);
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v2 — untested\n");
			git(dir, "commit", "-q", "-m", "second edit", "--", "lib.js");
			expect(
				holdsAt(m, git(dir, "rev-parse", "HEAD"), { root: dir }),
			).toBeNull();
		});

		it("leaves uncovered a path in the commit's range the selection never saw, though the run still holds", () => {
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
			expect(holdsAt(m, sha, { root: dir })).not.toBeNull();
			const r = attestationOf(sha, [m], { root: dir });
			expect(r.judged && r.suites[0]).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [{ path: "new.test.ts", commit: sha }],
			});
		});

		it("leaves an edit outside changedPaths uncovered at the push, the range read from the remote sha the push names", () => {
			const dir = repo();
			const published = git(dir, "rev-parse", "HEAD");
			fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
			const m = markerOver(dir);
			fs.writeFileSync(
				path.join(dir, "other.txt"),
				"edit B, never selected for\n",
			);
			git(dir, "commit", "-q", "-m", "A and B", "--", "lib.js", "other.txt");
			const sha = git(dir, "rev-parse", "HEAD");
			const r = attestationOf(sha, [m], { root: dir, remoteSha: published });
			expect(r.judged && r.suites[0]).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [{ path: "other.txt", commit: sha }],
			});
		});

		it("attests an empty selection's marker — the instruments alone — on the docs-only commit made from it (#189 §6)", () => {
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
			expect(holdsAt(m, git(dir, "rev-parse", "HEAD"), { root: dir })).toEqual({
				by: "tree",
				tree: m.treeAtEnd,
				closureSize: 2,
			});
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
			expect(holdsAt(m, commitAll(dir), { root: dir })).toEqual({
				by: "tree",
				tree: m.treeAtEnd,
				closureSize: 4,
			});
		});

		it("refuses the commit whose manifest maps a selected test onto a document edited since the run (#799)", () => {
			const dir = repo();
			const { m, write } = manifestRun(dir);
			write({ "notes.md": ["lib.test.ts"], "other.txt": ["lib.test.ts"] });
			fs.writeFileSync(path.join(dir, "other.txt"), "other.txt v2\n");
			expect(holdsAt(m, commitAll(dir), { root: dir })).toBeNull();
		});

		it("refuses where the sha carries no manifest (#799)", () => {
			const dir = repo();
			const { m } = manifestRun(dir);
			fs.rmSync(path.join(dir, "docs", "test-read-edges.json"));
			expect(holdsAt(m, commitAll(dir), { root: dir })).toBeNull();
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
			expect(holdsAt(m, sha, { root: dir })).toEqual({
				by: "tree",
				tree: m.treeAtEnd,
				closureSize: "*",
			});
			git(dir, "commit", "-q", "--allow-empty", "-m", "moved sha, same tree");
			expect(
				holdsAt(m, git(dir, "rev-parse", "HEAD"), { root: dir }),
			).not.toBeNull();
		});
	});
});

describe("certificates composed across sessions (#811, ADR-0009)", () => {
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

	/** The tree `base` would be with `files` written over it, built off an index of its own. */
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

	/** An admissible narrowed green over `root` plus `files`, selected for them alone. */
	const run = (
		dir: string,
		root: string,
		files: Record<string, string>,
		{ closure, at }: { closure: string[]; at: string },
	) =>
		green({
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

	/** Session A and session B each run green on its own edit, then both commit. */
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

	it("covers a two-commit range with two sessions' greens neither of which covers it alone", () => {
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

	it("judges only the paths `within` names, so one session's green covers its own part of the range (#1218)", () => {
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

	it("voids a member whose closure a neighbour's later commit changed, naming what it no longer covers", () => {
		const { dir, root, a, b, c1, c2 } = twoSessions();
		const edit = { "a.test.ts": "a.test.ts v1\n" };
		const n = green({
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
			unattested: [{ path: "a.js", commit: c1 }],
		});
	});

	it("leaves a hand commit no member selected for uncovered, named with its commit", () => {
		const { dir, a, b } = twoSessions();
		const c3 = commit(dir, { "other.txt": "by hand\n" }, "hand commit");
		expect(vitest(attestationOf(c3, [a, b], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "other.txt", commit: c3 }],
		});
	});

	it("names the newest commit in the range touching an uncovered path", () => {
		const { dir } = twoSessions();
		commit(dir, { "other.txt": "first\n" }, "hand 1");
		const c4 = commit(dir, { "other.txt": "second\n" }, "hand 2");
		const v = vitest(attestationOf(c4, [], { root: dir }));
		expect(v?.attested === false && v.unattested).toEqual(
			expect.arrayContaining([{ path: "other.txt", commit: c4 }]),
		);
	});

	it("lets one full-run member cover every path in the range", () => {
		const { dir, a, b, c1 } = twoSessions();
		const c3 = commit(dir, { "other.txt": "by hand\n" }, "hand commit");
		const full = green({
			sha: c1,
			at: "F",
			treeAtEnd: git(dir, "rev-parse", `${c3}^{tree}`),
			closure: "*",
		});
		const v = vitest(attestationOf(c3, [a, b, full], { root: dir }));
		expect(v?.attested && v.members.map((m) => m.marker.at)).toEqual(["F"]);
		expect(v?.attested && v.note).toContain("closure: the whole tree");
	});

	it("never counts a run too narrow to answer the gate", () => {
		const { dir, root, b, c2 } = twoSessions();
		const handTyped = {
			...run(dir, root, aEdit, { closure: ["a.js", "a.test.ts"], at: "A" }),
			scope: fullScope({ modulesRun: 1, fileFilters: ["a.test.ts"] }),
		};
		expect(
			vitest(attestationOf(c2, [handTyped, b], { root: dir }))?.attested,
		).toBe(false);
	});

	it("answers each suite for itself: a vitest green never covers a pytest gap", () => {
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
		expect(py && !py.attested && py.unattested).toEqual([
			{ path: "pipe.py", commit: c1 },
		]);
		const pyGreen = green({ sha: c1, suite: "pytest", at: "P" });
		const both = attestationOf(c1, [v, pyGreen], { root: dir });
		expect(both.judged && both.suites.every((s) => s.attested)).toBe(true);
	});

	/*
	 * The `result:` gate's walk (#807, #814): the session's commit, HEAD, and
	 * any full or admissible run's sha between them.
	 */
	describe("a session's commit, or a later one containing it", () => {
		/** A full green whose tree is `sha`'s, keyed to `sha`. */
		const fullAt = (dir: string, sha: string, at: string) =>
			green({
				sha,
				at,
				treeAtEnd: git(dir, "rev-parse", `${sha}^{tree}`),
				closure: "*",
			});

		it("answers at the session's own commit where that is covered", () => {
			const { dir, a, c1 } = twoSessions();
			commit(dir, { "other.txt": "neighbour, untested\n" }, "neighbour");
			const r = sessionAttestation(c1, [a], { root: dir });
			expect(r.judged && r.attested && r.at).toBe(c1);
		});

		it("answers at HEAD where only a green on HEAD covers the session's commit", () => {
			const { dir, c1, c2 } = twoSessions();
			const r = sessionAttestation(c1, [fullAt(dir, c2, "H")], { root: dir });
			expect(r.judged && r.attested && r.at).toBe(c2);
		});

		it("answers at a run's sha between the two where neither end is covered", () => {
			const { dir, c1, c2 } = twoSessions();
			commit(dir, { "other.txt": "neighbour, untested\n" }, "neighbour");
			const mid = { ...fullAt(dir, c2, "M"), treeAtEnd: undefined };
			const r = sessionAttestation(c1, [mid], { root: dir });
			expect(r.judged && r.attested && r.at).toBe(c2);
		});

		it("returns HEAD's miss where nothing covers any commit tried", () => {
			const { dir, c1 } = twoSessions();
			const c3 = commit(dir, { "other.txt": "by hand\n" }, "hand");
			const r = sessionAttestation(c1, [], { root: dir });
			expect(r.judged && !r.attested && r.at).toBe(c3);
			expect(
				r.judged &&
					r.verdict.judged &&
					r.verdict.suites[0].attested === false &&
					r.verdict.suites[0].unattested.map((u) => u.path).sort(),
			).toEqual(["a.js", "b.js", "other.txt"]);
		});

		it("judges nothing where no commit tried can be judged", () => {
			const { dir, c1 } = twoSessions();
			git(dir, "update-ref", "-d", "refs/remotes/origin/main");
			const r = sessionAttestation(c1, [], { root: dir });
			expect(r.judged).toBe(false);
			expect(!r.judged && r.why).toContain("origin/main");
		});
	});

	describe("the range", () => {
		it("runs from the remote sha the push names", () => {
			const { dir, b, c1, c2 } = twoSessions();
			const r = attestationOf(c2, [b], { root: dir, remoteSha: c1 });
			expect(r.judged && r.base).toBe(c1);
			expect(r.judged && r.range).toEqual(["b.js"]);
			expect(vitest(r)?.attested).toBe(true);
		});

		it("runs from the merge-base with origin/main where there is no remote sha, or it is zero — never from origin/main's own tip", () => {
			const { dir, root, b, c1, c2 } = twoSessions();
			git(dir, "checkout", "-q", "-b", "upstream", root);
			const ahead = commit(dir, { "other.txt": "upstream only\n" }, "upstream");
			git(dir, "update-ref", "refs/remotes/origin/main", ahead);
			git(dir, "checkout", "-q", "main");
			for (const remoteSha of [undefined, null, "0".repeat(40)]) {
				const r = attestationOf(c2, [b], { root: dir, remoteSha });
				expect(r.judged && r.base).toBe(root);
				expect(r.judged && r.range.sort()).toEqual(["a.js", "b.js"]);
				expect(vitest(r)).toEqual({
					suite: "vitest",
					attested: false,
					unattested: [{ path: "a.js", commit: c1 }],
				});
			}
		});

		it("runs from the merge-base with origin/landing where the landing module is on, and names it when it is missing (#2408)", () => {
			const { dir, root, b, c1, c2 } = twoSessions();
			git(dir, "update-ref", "refs/remotes/origin/main", c2);
			vi.stubEnv("WFC_MODULES", "landing");
			try {
				const missing = attestationOf(c2, [b], { root: dir });
				expect(!missing.judged && missing.why).toContain("origin/landing");
				git(dir, "update-ref", "refs/remotes/origin/landing", root);
				const r = attestationOf(c2, [b], { root: dir });
				expect(r.judged && r.base).toBe(root);
				expect(vitest(r)).toEqual({
					suite: "vitest",
					attested: false,
					unattested: [{ path: "a.js", commit: c1 }],
				});
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("judges nothing where git cannot name the range", () => {
			const { dir, a, b, c2 } = twoSessions();
			git(dir, "update-ref", "-d", "refs/remotes/origin/main");
			const r = attestationOf(c2, [a, b], { root: dir });
			expect(r.judged).toBe(false);
			expect(!r.judged && r.why).toContain("origin/main");
			const zero = attestationOf(c2, [a, b], {
				root: dir,
				remoteSha: "0".repeat(40),
			});
			expect(!zero.judged && zero.why).toContain("origin/main");
			const gone = attestationOf(c2, [a, b], {
				root: dir,
				remoteSha: "f".repeat(40),
			});
			expect(!gone.judged && gone.why).toContain("could not diff");
			const none = attestationOf(c2, [a, b], { root: null });
			expect(!none.judged && none.why).toContain("no git repository");
		});

		/*
		 * A's green, then a `landing` commit to a path A's closure reads,
		 * merged into A's `main` — cleanly, or with a.js resolved by hand.
		 */
		function reconciled(resolved?: string) {
			const { dir, root } = repo();
			const a = run(dir, root, aEdit, {
				closure: ["a.js", "a.test.ts", "package.json"],
				at: "A",
			});
			const c1 = commit(dir, aEdit, "A's edit");
			const full = green({
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
				"a landing commit",
			);
			git(dir, "update-ref", "refs/remotes/origin/landing", landed);
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

		it("lets a narrowed or full certificate hold over a clean merge of origin/landing where the landing module is on, and not where it is off (#2517)", () => {
			const { dir, a, full, c1, merge } = reconciled();
			for (const m of [a, full])
				expect(vitest(attestationOf(merge, [m], { root: dir }))).toEqual({
					suite: "vitest",
					attested: false,
					unattested: [{ path: "a.js", commit: c1 }],
				});
			vi.stubEnv("WFC_MODULES", "landing");
			try {
				for (const m of [a, full]) {
					const r = attestationOf(merge, [m], { root: dir });
					expect(r.judged && r.range).toEqual(["a.js"]);
					expect(vitest(r)?.attested).toBe(true);
				}
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("voids a certificate over a merge whose conflict was resolved by hand, with the landing module on (#2517)", () => {
			const { dir, a, full, c1, merge } = reconciled("a.js resolved\n");
			vi.stubEnv("WFC_MODULES", "landing");
			try {
				for (const m of [a, full])
					expect(vitest(attestationOf(merge, [m], { root: dir }))).toEqual({
						suite: "vitest",
						attested: false,
						unattested: [{ path: "a.js", commit: c1 }],
					});
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("covers an empty range only where some member still holds", () => {
			const { dir, b, c2 } = twoSessions();
			git(dir, "update-ref", "refs/remotes/origin/main", c2);
			expect(vitest(attestationOf(c2, [], { root: dir }))).toEqual({
				suite: "vitest",
				attested: false,
				unattested: [],
				why: `no green vitest run holds at ${c2.slice(0, 12)}`,
			});
			expect(vitest(attestationOf(c2, [b], { root: dir }))?.attested).toBe(
				true,
			);
		});

		it("refuses a stale certificate over an empty range with the landing module on, naming no path (#2517)", () => {
			const { dir, root, c2 } = twoSessions();
			git(dir, "update-ref", "refs/remotes/origin/landing", c2);
			const stale = run(dir, root, aEdit, {
				closure: ["a.js", "b.js", "package.json"],
				at: "V",
			});
			vi.stubEnv("WFC_MODULES", "landing");
			try {
				expect(vitest(attestationOf(c2, [stale], { root: dir }))).toEqual({
					suite: "vitest",
					attested: false,
					unattested: [],
					why: `no green vitest run holds at ${c2.slice(0, 12)}`,
				});
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});
});

/*
 * The shape #1860 replays: one wide test and one narrow test go green
 * together, a neighbour commits a file only the wide test reads, and the
 * session commits the narrow test's subject. The wide test alone is owed.
 */
describe("a narrowed green judged test by test (#1860)", () => {
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

	const treeOf = (dir: string, sha: string) =>
		git(dir, "rev-parse", `${sha}^{tree}`);

	/** An admissible green reading `treeAtEnd`, recorded test by test. */
	const perTest = (over: {
		sha: string;
		at: string;
		treeAtEnd: string;
		selected: string[];
		changedPaths: string[];
	}) =>
		green({
			scope: fullScope({ modulesRun: 2, changed: "x", admissible: true }),
			closure: ["package.json", ...over.selected],
			imports: Object.fromEntries(
				over.selected.map((t) => [t, ["vitest.setup.ts"]]),
			),
			roots: ["package.json"],
			...over,
		});

	const narrowEdit = { "narrow.js": "narrow.js v1\n" };

	/** The session's green over its edit, a neighbour's commit, then the session's. */
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
			treeAtEnd: treeOf(dir, scratch),
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

	it("owes only the test whose own reads a neighbour's commit changed", () => {
		const { dir, own, session } = replay();
		expect(vitest(attestationOf(own, [session], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "narrow.js", commit: own, tests: ["wide.test.ts"] }],
		});
	});

	it("owes no test for a change already on origin/landing where the landing module is on, and still owes one for a change it has not taken (#2517)", () => {
		const { dir, root, neighbour, own, session } = replay();
		vi.stubEnv("WFC_MODULES", "landing");
		try {
			git(dir, "update-ref", "refs/remotes/origin/landing", neighbour);
			expect(
				vitest(attestationOf(own, [session], { root: dir }))?.attested,
			).toBe(true);
			git(dir, "update-ref", "refs/remotes/origin/landing", root);
			const v = vitest(attestationOf(own, [session], { root: dir }));
			expect(v?.attested === false && v.unattested).toContainEqual({
				path: "narrow.js",
				commit: own,
				tests: ["wide.test.ts"],
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("owes no test origin/landing added where the landing module is on, and owes it where it is off (#2517)", () => {
		const { dir, neighbour, own, session } = replay({
			"late.test.ts": "late.test.ts v0\n",
			[EDGES_FILE]: JSON.stringify({
				edges: {
					...edges,
					"narrow.js": [...edges["narrow.js"], "late.test.ts"],
				},
			}),
		});
		expect(vitest(attestationOf(own, [session], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "narrow.js", commit: own, tests: ["late.test.ts"] }],
		});
		vi.stubEnv("WFC_MODULES", "landing");
		try {
			git(dir, "update-ref", "refs/remotes/origin/landing", neighbour);
			expect(
				vitest(attestationOf(own, [session], { root: dir }))?.attested,
			).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("is covered by the original green plus a re-run of the owed test alone", () => {
		const { dir, own, session } = replay();
		const retest = perTest({
			sha: own,
			at: "R",
			treeAtEnd: treeOf(dir, own),
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

	it("takes the owed test from a neighbour's green whatever its diff, where it read this commit's tree", () => {
		const { dir, own, session } = replay();
		const theirs = perTest({
			sha: own,
			at: "N",
			treeAtEnd: treeOf(dir, own),
			selected: ["wide.test.ts"],
			changedPaths: ["docs/wide-only.md"],
		});
		expect(
			vitest(attestationOf(own, [session, theirs], { root: dir }))?.attested,
		).toBe(true);
	});

	it("never takes a re-run for the witness: a path no run's diff names stays owed (ADR-0009)", () => {
		const { dir, own } = replay();
		const retest = perTest({
			sha: own,
			at: "R",
			treeAtEnd: treeOf(dir, own),
			selected: ["narrow.test.ts", "wide.test.ts"],
			changedPaths: [],
		});
		expect(vitest(attestationOf(own, [retest], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "narrow.js", commit: own }],
		});
	});

	it("judges a marker with no per-test field on its whole closure, as before", () => {
		const { dir, own, session } = replay();
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
		expect(holdsAt(before, own, { root: dir })).toBeNull();
		expect(vitest(attestationOf(own, [before], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "narrow.js", commit: own }],
		});
	});

	it("takes no witness whose tests' own imports changed, since the graph its selection was computed over did", () => {
		const { dir, own, session } = replay({ "vitest.setup.ts": "v1\n" });
		expect(vitest(attestationOf(own, [session], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [{ path: "narrow.js", commit: own }],
		});
	});

	it("still takes that witness for a document, whose readers the manifest at the sha names, owing its voided readers", () => {
		const { dir, root } = repo();
		const docEdit = { "docs/wide-only.md": "session's edit\n" };
		const scratch = commit(dir, docEdit, "the session's tree");
		const session = perTest({
			sha: root,
			at: "S",
			treeAtEnd: treeOf(dir, scratch),
			selected: ["wide.test.ts"],
			changedPaths: ["docs/wide-only.md"],
		});
		git(dir, "reset", "-q", "--hard", root);
		const neighbour = commit(dir, { "vitest.setup.ts": "v1\n" }, "neighbour");
		git(dir, "update-ref", "refs/remotes/origin/main", neighbour);
		const own = commit(dir, docEdit, "the session's commit");
		expect(vitest(attestationOf(own, [session], { root: dir }))).toEqual({
			suite: "vitest",
			attested: false,
			unattested: [
				{ path: "docs/wide-only.md", commit: own, tests: ["wide.test.ts"] },
			],
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
			treeAtEnd: treeOf(dir, own),
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
			unattested: [{ path: "package.json", commit: bumped }],
		});
	});

	it("covers a path no test reads by a witness naming it", () => {
		const { dir, root } = repo();
		const own = commit(dir, { "unread.md": "edited\n" }, "unread");
		const session = perTest({
			sha: root,
			at: "S",
			treeAtEnd: treeOf(dir, own),
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
			treeAtEnd: treeOf(dir, own),
			selected: ["narrow.test.ts"],
			changedPaths: [EDGES_FILE, "narrow.js", "wide.test.ts"],
		});
		expect(vitest(attestationOf(own, [session], { root: dir }))?.attested).toBe(
			true,
		);
	});
});
