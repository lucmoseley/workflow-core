// @vitest-environment node
/*
 * Pins that check-suite-margin.js names the latest green whole vitest
 * suite, or the latest green run of any of its shards, over its target —
 * sha, duration, target, ceiling, machine reading and slowest files — stays
 * silent on one under it, on a part-suite and on a red run, and exits 0 on a breach (#1797, the report-only ruling).
 *
 * Loosen a case and the suite outgrows its margin unreported until a push
 * gate is killed at the ceiling, or a slow run starts refusing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const {
	CEILING_MS,
	TARGET_FRACTION,
	TARGET_MS,
} = require("./lib/suite-ceiling.js");

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

const write = (...markers: unknown[]) =>
	fs.writeFileSync(store, markers.map((m) => JSON.stringify(m)).join("\n"));

const writeFailures = (...markers: unknown[]) =>
	fs.writeFileSync(failStore, markers.map((m) => JSON.stringify(m)).join("\n"));

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
		write(marker());
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

	it("is judged on the latest run alone", () => {
		write(marker(), marker({ sha: "b".repeat(40), durationMs: 1000 }));
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
		write(half(1), half(2, { durationMs: TARGET_MS + 60_000 }), half(1));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain("shard 2/2");
		expect(r.out).not.toContain("shard 1/2 of the whole suite, at");
		expect(r.out).toContain(secs(TARGET_MS + 60_000));
	});

	it("stays silent when each shard's latest run is under the target, though an older one was over", () => {
		write(half(2, { durationMs: TARGET_MS + 60_000 }), half(1), half(2));
		const out = run().out;
		expect(out).not.toContain("SUITE-MARGIN");
		expect(out).toContain("shard 1/2 of the whole suite");
		expect(out).toContain("shard 2/2 of the whole suite");
		expect(out).toContain(`inside the ${secs(TARGET_MS)} target`);
	});

	it("names both shards, each on its own line, when both are over", () => {
		const over = { durationMs: TARGET_MS + 60_000 };
		write(half(1, over), half(2, over));
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
		write(thirds(1), half(1), half(2));
		expect(run().out).not.toContain("SUITE-MARGIN");
	});

	it("reads a red shard over the target as no run to judge", () => {
		write(
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
		write(half(1, { durationMs: TARGET_MS + 60_000 }), half(2), marker());
		const out = run().out;
		expect(out).toContain("green whole suite, at");
		expect(out).not.toContain("shard 1/2");
	});

	it("never judges a shard on a run older than the latest whole suite", () => {
		write(
			half(2, { durationMs: TARGET_MS + 60_000 }),
			marker({ durationMs: 1000 }),
			half(1),
		);
		const out = run().out;
		expect(out).not.toContain("SUITE-MARGIN");
		expect(out).toContain("No green run of shard 2/2 is recorded");
	});

	it("names a shard with no green run as unjudged, a WARN and never OK, with its way out (#3237)", () => {
		write(half(1));
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
		write(half(1, { durationMs: TARGET_MS + 60_000 }));
		const out = run().out;
		expect(out).toContain("SUITE-MARGIN");
		expect(out).toContain("2 run(s) over the target or shard(s) unjudged");
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
		write(old(1), old(2, { durationMs: TARGET_MS + 60_000 }));
		const r = run();
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain("shard 2/2 of the whole suite, at");
		expect(r.out).not.toContain("No green run");
	});

	it("reads a shard narrowed by a file filter as no shard of the whole suite", () => {
		write(
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
	const Killed = "c".repeat(40);
	const kill = (fields: Record<string, unknown> = {}) => ({
		sha: Killed,
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
		write(half(1), half(2));
		writeFailures(kill());
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain(
			`shard 1/2 of the whole suite killed at the ceiling, at ${Killed.slice(0, 12)}`,
		);
		expect(r.out).toContain(secs(CEILING_MS + 100));
		expect(r.out).toContain("in flight at the kill:");
		expect(r.out).toContain("inflight.test.ts (running its tests)");
		expect(r.out).not.toContain("shard 2/2 of the whole suite killed");
	});

	it("names every kill of a shard with no green run, and leaves it judged", () => {
		write(half(1));
		writeFailures(
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
		write(marker({ durationMs: 1000 }));
		writeFailures(kill({ argv: [], full: "dependency-root" }));
		const out = run().out;
		expect(out).toContain("a whole suite killed at the ceiling");
	});

	it("hides no shard behind a hand whole run killed after them", () => {
		write(
			half(1),
			marker({
				scope: { ...WHOLE, modulesRun: 300, shard: { index: 2, count: 2 } },
				durationMs: TARGET_MS + 60_000,
			}),
		);
		writeFailures(
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
		write(half(1), half(2));
		writeFailures(kill(fields));
		expect(run().out).not.toContain("SUITE-MARGIN");
	});
});

describe("silence", () => {
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
	])("%s reports nothing", (_name, m) => {
		write(m);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("SUITE-MARGIN");
	});

	it("an absent store reports nothing", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("SUITE-MARGIN");
	});
});

it("docs/environment.md states the module's target", () => {
	const doc = fs.readFileSync(
		path.resolve(__dirname, "..", "docs/environment.md"),
		"utf8",
	);
	expect(doc).toContain(
		`${Math.round(TARGET_FRACTION * 100)}% of that ceiling (${TARGET_MS / 1000} s)`,
	);
});
