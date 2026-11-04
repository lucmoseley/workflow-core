// @vitest-environment node
/*
 * Pins that check-suite-margin.js names the latest green whole vitest
 * suite, or the latest green run of any of its shards, over its target —
 * sha, duration, target, ceiling, machine reading and slowest files — and any
 * file at the target in a red run since, with that run's sha (#4291); reads
 * OK on one under it, and on a part-suite or red certificate beside one; reads
 * nothing judged as unjudged, never OK; and exits 0 on a breach (#1797, the
 * report-only ruling).
 *
 * Loosen a case and a suite over its target goes unreported until a push
 * gate is killed at the ceiling, or a slow run starts refusing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const { CEILING_MS, TARGET_MS } = require("./lib/suite-ceiling.js");

const SCRIPT = path.resolve(__dirname, "check-suite-margin.js");
const SHA = "a".repeat(40);

let dir: string;
let store: string;
let failStore: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-margin-"));
	store = path.join(dir, "pass.jsonl");
	failStore = path.join(dir, "fail.jsonl");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const WHOLE = {
	modulesRun: 600,
	modulesTotal: 600,
	tests: 20_000,
	skipped: 0,
	full: "flag",
	fullCause: "push-gate",
};

const MACHINE = {
	ceilingPct: 800,
	busyPct: 377,
	systemPct: 190,
	nicePct: 165.5,
	userPct: 21,
	iowaitPct: 0.5,
	load1: 5.23,
};

const SLOWEST = [
	{ file: "scripts/dispatch-sessions.test.ts", seconds: 200.4 },
	{ file: "scripts/new-repo.test.ts", seconds: 167 },
];

const marker = (fields: Record<string, unknown> = {}) => ({
	sha: SHA,
	at: "2026-10-24T09:00:00.000Z",
	suite: "vitest",
	durationMs: TARGET_MS + 60_000,
	machine: MACHINE,
	scope: WHOLE,
	slowest: SLOWEST,
	...fields,
});

const writeJsonl = (file: string, ...markers: unknown[]) =>
	fs.writeFileSync(file, markers.map((m) => JSON.stringify(m)).join("\n"));

const run = () => {
	const r = runInProcess(
		SCRIPT,
		["--store", store, "--fail-store", failStore],
		{ cwd: dir },
	);
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

describe("a green whole suite over the target", () => {
	it("is named with its sha, duration, target, ceiling, machine reading and slowest files, and exits 0", () => {
		writeJsonl(store, marker());
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain(SHA.slice(0, 12));
		expect(r.out).toContain(secs(TARGET_MS + 60_000));
		expect(r.out).toContain(secs(TARGET_MS));
		expect(r.out).toContain(secs(CEILING_MS));
		expect(r.out).toContain("busy 377% of 800%");
		expect(r.out).toContain("load1 5.23");
		expect(r.out).toContain("200.4 s  scripts/dispatch-sessions.test.ts");
		expect(r.out).toContain("scripts/new-repo.test.ts");
		expect(r.out).toContain("Cut its heavy tail by measured cost");
	});

	it("is named at exactly the target, which is not under it", () => {
		writeJsonl(store, marker({ durationMs: TARGET_MS }));
		expect(run().out).toContain("SUITE-MARGIN");
	});

	it("is judged on the latest run alone", () => {
		writeJsonl(
			store,
			marker(),
			marker({ sha: "b".repeat(40), durationMs: 1000 }),
		);
		expect(run().out).not.toContain("SUITE-MARGIN");
	});
});

describe("a sharded whole suite (#3090)", () => {
	const half = (index: number, fields: Record<string, unknown> = {}) =>
		marker({
			scope: { ...WHOLE, modulesRun: 300, shard: { index, count: 2 } },
			durationMs: TARGET_MS - 1000,
			...fields,
		});

	it("names a shard over the target with its index, even when the latest shard is under it", () => {
		writeJsonl(
			store,
			half(1),
			half(2, { durationMs: TARGET_MS + 60_000 }),
			half(1),
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain("shard 2/2");
		expect(r.out).not.toContain("shard 1/2 of the whole suite, at");
		expect(r.out).toContain(secs(TARGET_MS + 60_000));
	});

	it("stays silent when each shard's latest run is under the target, though an older one was over", () => {
		writeJsonl(
			store,
			half(2, { durationMs: TARGET_MS + 60_000 }),
			half(1),
			half(2),
		);
		const out = run().out;
		expect(out).not.toContain("SUITE-MARGIN");
		expect(out).toContain("shard 1/2 of the whole suite");
		expect(out).toContain("shard 2/2 of the whole suite");
		expect(out).toContain(`inside the ${secs(TARGET_MS)} target`);
	});

	it("names both shards, each on its own line, when both are over", () => {
		const over = { durationMs: TARGET_MS + 60_000 };
		writeJsonl(store, half(1, over), half(2, over));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("shard 1/2 of the whole suite, at");
		expect(r.out).toContain("shard 2/2 of the whole suite, at");
		expect(r.out).toContain("2 run(s) over the target");
	});

	it("judges only shards at the latest run's count", () => {
		const thirds = (index: number, fields: Record<string, unknown> = {}) =>
			marker({
				scope: { ...WHOLE, modulesRun: 200, shard: { index, count: 3 } },
				...fields,
			});
		writeJsonl(store, thirds(1), half(1), half(2));
		expect(run().out).not.toContain("SUITE-MARGIN");
	});

	it("reads a red shard over the target as no run to judge", () => {
		writeJsonl(
			store,
			half(1),
			half(2, {
				durationMs: TARGET_MS + 60_000,
				scope: {
					...WHOLE,
					modulesRun: 300,
					shard: { index: 2, count: 2 },
					failures: [{ file: "x.test.ts", tests: ["t"] }],
				},
			}),
		);
		const out = run().out;
		expect(out).not.toContain("SUITE-MARGIN");
		expect(out).toContain("No green run of shard 2/2 is recorded");
	});

	it("judges a whole suite newer than the shards on its own", () => {
		writeJsonl(
			store,
			half(1, { durationMs: TARGET_MS + 60_000 }),
			half(2),
			marker(),
		);
		const out = run().out;
		expect(out).toContain("green whole suite, at");
		expect(out).not.toContain("shard 1/2");
	});

	it("never judges a shard on a run older than the latest whole suite", () => {
		writeJsonl(
			store,
			half(2, { durationMs: TARGET_MS + 60_000 }),
			marker({ durationMs: 1000 }),
			half(1),
		);
		const out = run().out;
		expect(out).not.toContain("SUITE-MARGIN");
		expect(out).toContain("No green run of shard 2/2 is recorded");
	});

	it("names a shard with no green run as unjudged, a WARN and never OK, with its way out (#3237)", () => {
		writeJsonl(store, half(1));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("No green run of shard 2/2 is recorded");
		expect(r.out).toContain("--shard=<k/n>");
		expect(r.out).toContain("1 shard(s) with no green run");
		expect(r.out).not.toMatch(/^OK/m);
		expect(r.out).toMatch(/^WARN/m);
		expect(r.out).not.toMatch(/ {2}No green run/);
	});

	it("prints the unjudged note with a single space beside a breach, and counts it (#3237)", () => {
		writeJsonl(store, half(1, { durationMs: TARGET_MS + 60_000 }));
		const out = run().out;
		expect(out).toContain("SUITE-MARGIN");
		expect(out).toContain(
			"2 finding(s): 1 run(s) over the target, 1 shard(s) with no green run",
		);
		expect(out).toContain("No green run of shard 2/2 is recorded");
		expect(out).not.toMatch(/ {2}No green run/);
	});

	it("reads a shard recorded before #3090 off its argv (#3237)", () => {
		const old = (index: number, fields: Record<string, unknown> = {}) =>
			marker({
				scope: { ...WHOLE, modulesRun: 300, wholeSlot: true },
				argv: ["--full=push-gate", "--shared", `--shard=${index}/2`],
				durationMs: TARGET_MS - 1000,
				...fields,
			});
		writeJsonl(store, old(1), old(2, { durationMs: TARGET_MS + 60_000 }));
		const r = run();
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain("shard 2/2 of the whole suite, at");
		expect(r.out).not.toContain("No green run");
	});

	it("reads a shard narrowed by a file filter as no shard of the whole suite", () => {
		writeJsonl(
			store,
			half(1, {
				durationMs: TARGET_MS + 60_000,
				scope: {
					...WHOLE,
					modulesRun: 1,
					fileFilters: ["x"],
					shard: { index: 1, count: 2 },
				},
			}),
		);
		expect(run().out).not.toContain("SUITE-MARGIN");
	});
});

describe("a ceiling kill in the fail store (#3237)", () => {
	const killedSha = "c".repeat(40);
	const kill = (fields: Record<string, unknown> = {}) => ({
		sha: killedSha,
		at: "2026-10-24T10:00:00.000Z",
		suite: "vitest",
		durationMs: CEILING_MS + 100,
		ceilingKill: true,
		ceilingMs: CEILING_MS,
		machine: MACHINE,
		inflight: [{ module: "inflight.test.ts", stage: "running its tests" }],
		argv: ["--full=push-gate", "--shared", "--shard=1/2"],
		...fields,
	});
	const half = (index: number) =>
		marker({
			scope: { ...WHOLE, modulesRun: 300, shard: { index, count: 2 } },
			durationMs: TARGET_MS - 1000,
		});

	it("names a shard killed since its green run, with its sha, duration and what was in flight", () => {
		writeJsonl(store, half(1), half(2));
		writeJsonl(failStore, kill());
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain(
			`shard 1/2 of the whole suite killed at the ceiling, at ${killedSha.slice(0, 12)}`,
		);
		expect(r.out).toContain(secs(CEILING_MS + 100));
		expect(r.out).toContain("in flight at the kill:");
		expect(r.out).toContain("inflight.test.ts (running its tests)");
		expect(r.out).not.toContain("shard 2/2 of the whole suite killed");
	});

	it("names every kill of a shard with no green run, and leaves it judged", () => {
		writeJsonl(store, half(1));
		writeJsonl(
			failStore,
			kill({ argv: ["--full=push-gate", "--shared", "--shard=2/2"] }),
			kill({
				at: "2026-10-24T11:00:00.000Z",
				argv: ["--full=push-gate", "--shared", "--shard=2/2"],
			}),
		);
		const r = run();
		expect(r.out).toContain("2 run(s) over the target");
		expect(r.out).not.toContain("No green run of shard 2/2");
	});

	it("names a whole run killed with only its recorded `full` to show it whole", () => {
		writeJsonl(store, marker({ durationMs: 1000 }));
		writeJsonl(failStore, kill({ argv: [], full: "dependency-root" }));
		const out = run().out;
		expect(out).toContain("a whole suite killed at the ceiling");
	});

	it("hides no shard behind a hand whole run killed after them", () => {
		writeJsonl(
			store,
			half(1),
			marker({
				scope: { ...WHOLE, modulesRun: 300, shard: { index: 2, count: 2 } },
				durationMs: TARGET_MS + 60_000,
			}),
		);
		writeJsonl(
			failStore,
			kill({ argv: ["--queue", "--full=other", "--shared", "--logHeapUsage"] }),
		);
		const out = run().out;
		expect(out).toContain("a whole suite killed at the ceiling");
		expect(out).toContain("the latest green shard 2/2 of the whole suite, at");
		expect(out).toContain("2 run(s) over the target");
	});

	it.each([
		["one older than the slot's green run", { at: "2026-10-24T08:00:00.000Z" }],
		[
			"a part-suite's, its argv naming files",
			{
				argv: ["--full=push-gate", "scripts/x.test.ts"],
			},
		],
		["one with no `full` to show it whole", { argv: ["--queue"] }],
		["a stall kill", { ceilingKill: undefined, stalled: true }],
	])("reports nothing on %s", (_name, fields) => {
		writeJsonl(store, half(1), half(2));
		writeJsonl(failStore, kill(fields));
		expect(run().out).not.toContain("SUITE-MARGIN");
	});
});

describe("silence", () => {
	const inside = marker({
		at: "2026-10-24T08:00:00.000Z",
		durationMs: TARGET_MS - 1000,
	});
	it.each([
		["one under the target", marker({ durationMs: TARGET_MS - 1000 })],
		[
			"a part-suite",
			marker({ scope: { ...WHOLE, full: undefined, fileFilters: ["x"] } }),
		],
		[
			"a whole run narrowed to fewer modules",
			marker({ scope: { ...WHOLE, modulesRun: 300 } }),
		],
		[
			"a certificate carrying failures",
			marker({
				scope: { ...WHOLE, failures: [{ file: "x.test.ts", tests: ["t"] }] },
			}),
		],
		["a ceiling kill", marker({ ceilingKill: true })],
	])("%s after a green whole suite under the target reads OK", (_name, m) => {
		writeJsonl(store, inside, m);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("SUITE-MARGIN");
		expect(r.out).toMatch(/^OK/m);
	});
});

describe("nothing judged (#4291)", () => {
	it.each([
		["an absent store", []],
		[
			"a part-suite alone",
			[marker({ scope: { ...WHOLE, fileFilters: ["x"] } })],
		],
	])(
		"%s reads as unjudged, a WARN and never OK, with its way out",
		(_n, ms) => {
			writeJsonl(store, ...ms);
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).not.toMatch(/^OK/m);
			expect(r.out).toMatch(/^WARN: 1 whole suite with no green run/m);
			expect(r.out).toContain("No green whole vitest suite is recorded");
			expect(r.out).toContain("--full=other --queue");
		},
	);
});

describe("a red run's slowest files (#4291)", () => {
	const redSha = "d".repeat(40);
	const red = (fields: Record<string, unknown> = {}) => ({
		sha: redSha,
		at: "2026-10-24T10:00:00.000Z",
		suite: "vitest",
		durationMs: 400_000,
		scope: {
			...WHOLE,
			full: undefined,
			modulesRun: 40,
			fileFilters: ["scripts/x.test.ts"],
			failures: [{ file: "scripts/x.test.ts", tests: ["t"] }],
		},
		slowest: [
			{ file: "scripts/slow-fixture.test.ts", seconds: 311 },
			{ file: "scripts/fast.test.ts", seconds: 12 },
		],
		...fields,
	});

	it("names a file at or over the target with its run's sha, while no green run is recorded", () => {
		writeJsonl(failStore, red());
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).not.toMatch(/^OK/m);
		expect(r.out).toContain(
			`SUITE-MARGIN — scripts/slow-fixture.test.ts took 311.0 s in a red run at ${redSha.slice(0, 12)}`,
		);
		expect(r.out).not.toContain("fast.test.ts");
		expect(r.out).toContain("No green whole vitest suite is recorded");
		expect(r.out).toContain(
			"2 finding(s): 1 red-run file(s) over the target, 1 whole suite with no green run",
		);
		expect(r.out).toContain("cut it by measured cost (#2729)");
	});

	it("names a file at exactly the target", () => {
		writeJsonl(
			failStore,
			red({
				slowest: [{ file: "scripts/edge.test.ts", seconds: TARGET_MS / 1000 }],
			}),
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUITE-MARGIN — scripts/edge.test.ts took");
		expect(r.out).toContain("cut it by measured cost (#2729)");
	});

	it("names one newer than a green whole suite under the target, beside that run's inside line", () => {
		writeJsonl(store, marker({ durationMs: TARGET_MS - 1000 }));
		writeJsonl(failStore, red());
		const r = run();
		expect(r.out).toContain(`inside the ${secs(TARGET_MS)} target`);
		expect(r.out).toContain("scripts/slow-fixture.test.ts took 311.0 s");
		expect(r.out).toMatch(/^WARN: 1 red-run file\(s\) over the target/m);
	});

	it("names one between two shards' green runs, whose later green lists only its own files", () => {
		const half = (index: number, at: string) =>
			marker({
				at,
				scope: { ...WHOLE, modulesRun: 300, shard: { index, count: 2 } },
				durationMs: TARGET_MS - 1000,
				slowest: [],
			});
		writeJsonl(
			store,
			half(1, "2026-10-24T09:00:00.000Z"),
			half(2, "2026-10-24T11:00:00.000Z"),
		);
		writeJsonl(failStore, red());
		expect(run().out).toContain("scripts/slow-fixture.test.ts took 311.0 s");
	});

	it("names one in an undated red run while no green run is recorded", () => {
		writeJsonl(failStore, red({ at: undefined }));
		expect(run().out).toContain("scripts/slow-fixture.test.ts took 311.0 s");
	});

	it.each([
		[
			"one older than the latest green whole suite",
			[red({ at: "2026-10-24T08:00:00.000Z" })],
		],
		[
			"a file whose newest red reading is under the target",
			[
				red(),
				red({
					at: "2026-10-24T11:00:00.000Z",
					slowest: [{ file: "scripts/slow-fixture.test.ts", seconds: 30 }],
				}),
			],
		],
		["another suite's red", [red({ suite: "pytest" })]],
	])("reports nothing on %s", (_n, reds) => {
		writeJsonl(store, marker({ durationMs: TARGET_MS - 1000 }));
		writeJsonl(failStore, ...reds);
		const r = run();
		expect(r.out).not.toContain("SUITE-MARGIN");
		expect(r.out).toMatch(/^OK/m);
	});
});

it("the target sits below the ceiling", () => {
	expect(TARGET_MS).toBeLessThan(CEILING_MS);
});

it("docs/environment.md states the module's target", () => {
	const doc = fs.readFileSync(
		path.resolve(__dirname, "..", "docs/environment.md"),
		"utf8",
	);
	expect(doc).toContain(
		`held to a target of ${TARGET_MS / 1000} s, \`TARGET_MS\` in`,
	);
});
