// @vitest-environment node
/*
 * admissible-share.test.ts — runs admissible-share.js through `runInProcess`
 * against real `.test-pass-markers.jsonl`/`.test-fail-markers.jsonl` files in
 * a throwaway git dir, never a mock store, reading its figures off `--json`
 * and its prose off the plain run. The script is the reading mantahostels#2308 asked for, run by hand: a
 * wrong figure misreports the share of runs `test:changed` could stand in for,
 * and the full-runs-a-day rate mantahostels#3154's rethink trigger is read against.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { record, recordFailure } from "./lib/test-pass-marker.js";

const SCRIPT = path.join(__dirname, "admissible-share.js");
/** The script's default cutoff, 90f1e5b1's commit time. */
const ROUTE_FIX_AT = "2026-08-31T16:37:50Z";
/** The sample under which the script says no figure should be quoted. */
const MIN_SAMPLE = 20;
const AT = "2026-09-01T00:00:00Z";
const dirs: string[] = [];

function sandbox() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admissible-share-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

function green(
	root: string,
	sha: string,
	at: string,
	scope: Record<string, unknown>,
) {
	record({ sha, at, suite: "vitest", scope: scope as never }, { root });
}

/** A git dir, because `repoRoot()` is what points the CLI at a store. */
function store() {
	const root = sandbox();
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

/** The script's `--json` reading over `root`'s stores. */
function reading(root: string, ...args: string[]) {
	const r = runInProcess(SCRIPT, ["--json", ...args], { cwd: root });
	expect(r.status).toBe(0);
	return JSON.parse(r.stdout.trim());
}

function red(
	root: string,
	sha: string,
	at: string,
	scope: Record<string, unknown>,
) {
	recordFailure({ sha, at, suite: "vitest", scope: scope as never }, { root });
}

describe("which launches the share counts", () => {
	it("keeps only vitest markers carrying viaChanged at or after the cutoff", () => {
		const root = store();
		green(root, "a", ROUTE_FIX_AT, { viaChanged: true, modulesTotal: 5 });
		green(root, "b", "2026-08-31T16:37:49Z", {
			viaChanged: true,
			modulesTotal: 5,
		});
		green(root, "c", AT, { modulesTotal: 5 });
		record(
			{
				sha: "d",
				at: AT,
				suite: "pytest",
				scope: { viaChanged: true, modulesTotal: 5 } as never,
			},
			{ root },
		);
		expect(reading(root, "--since", ROUTE_FIX_AT).routed.perRun.total).toBe(1);
	});

	it("excludes a marker at the pre-90f1e5b1 default cutoff by default (mantahostels#2303, mantahostels#2308: viaChanged predates the route-flag fix by 12 minutes)", () => {
		const root = store();
		green(root, "old", "2026-08-31T16:30:00Z", {
			viaChanged: true,
			modulesTotal: 5,
		});
		expect(reading(root).routed.perRun.total).toBe(0);
	});

	it("counts a red-store launch in the denominator (mantahostels#2308 review: excluding it undercounted the sample 3x)", () => {
		const root = store();
		red(root, "r", AT, {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
		});
		const s = reading(root, "--since", ROUTE_FIX_AT);
		expect(s.gate.perRun).toEqual({ admissible: 0, total: 1 });
		expect(s.routed.perRun).toEqual({ admissible: 1, total: 1 });
	});
});

describe("which runs count as full", () => {
	it("counts a full run from either store, never off viaChanged", () => {
		const root = store();
		green(root, "g", AT, { modulesTotal: 5, modulesRun: 5, full: "flag" });
		red(root, "r", AT, { modulesTotal: 5, modulesRun: 5, full: "flag" });
		expect(reading(root).fullPerDay.total.count).toBe(2);
	});

	it("excludes a narrow run and a run before the cutoff", () => {
		const root = store();
		green(root, "narrow", AT, {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		green(root, "old", "2026-08-31T16:30:00Z", {
			modulesTotal: 5,
			modulesRun: 5,
			full: "flag",
		});
		expect(reading(root).fullPerDay.total.count).toBe(0);
	});

	it("excludes a full pytest run", () => {
		const root = store();
		record(
			{
				sha: "py",
				at: AT,
				suite: "pytest",
				scope: { modulesTotal: 5, modulesRun: 5, full: "flag" } as never,
			},
			{ root },
		);
		expect(reading(root).fullPerDay.total.count).toBe(0);
	});
});

describe("full runs a day", () => {
	/** Full runs at `AT`, one per reason given; `undefined` writes none. */
	const fullRuns = (reasons: (string | undefined)[]) => {
		const root = store();
		for (const [i, full] of reasons.entries())
			green(root, `f${i}`, AT, {
				modulesTotal: 5,
				modulesRun: 5,
				...(full === undefined ? {} : { full }),
			});
		return root;
	};

	it("splits by scope.full, folding an absent or forged reason into unknown (AC-2)", () => {
		const root = fullRuns([
			"flag",
			"flag",
			"stale-manifest",
			undefined,
			"not-a-real-reason",
		]);
		const p = reading(
			root,
			"--since",
			AT,
			"--until",
			"2026-09-03T00:00:00Z",
		).fullPerDay;
		expect(p.days).toBe(2);
		expect(p.total).toEqual({ count: 5, perDay: 2.5 });
		expect(p.byReason.flag).toEqual({ count: 2, perDay: 1 });
		expect(p.byReason["stale-manifest"]).toEqual({ count: 1, perDay: 0.5 });
		expect(p.byReason["dependency-root"]).toEqual({ count: 0, perDay: 0 });
		expect(p.byReason["expansion-failed"]).toEqual({ count: 0, perDay: 0 });
		expect(p.byReason.unknown).toEqual({ count: 2, perDay: 1 });
	});

	it("sums the per-reason split back to the unsplit total (AC-3)", () => {
		const root = fullRuns(["flag", "dependency-root", undefined]);
		const p = reading(
			root,
			"--since",
			AT,
			"--until",
			"2026-09-02T00:00:00Z",
		).fullPerDay;
		const summed = Object.values(
			p.byReason as Record<string, { count: number }>,
		).reduce((n, b) => n + b.count, 0);
		expect(summed).toBe(p.total.count);
	});

	it("floors the window at the store's own earliest surviving marker (mantahostels#3211 spec review F1)", () => {
		const root = store();
		green(root, "f", "2026-09-01T12:00:00Z", {
			modulesTotal: 5,
			modulesRun: 5,
			full: "flag",
		});
		const p = reading(
			root,
			"--since",
			ROUTE_FIX_AT,
			"--until",
			"2026-09-02T12:00:00Z",
		).fullPerDay;
		expect(p.since).toBe("2026-09-01T12:00:00Z");
		expect(p.days).toBe(1);
		expect(p.total).toEqual({ count: 1, perDay: 1 });
	});
});

describe("the gate share", () => {
	it("counts a full run as meeting the gate even though isAdmissibleRun alone would refuse it", () => {
		const root = store();
		green(root, "full", AT, {
			viaChanged: true,
			modulesTotal: 5,
			modulesRun: 5,
		});
		const s = reading(root);
		expect(s.gate.perRun).toEqual({ admissible: 1, total: 1 });
		expect(s.gate.perSha).toEqual({ admissible: 1, total: 1 });
	});

	it("counts an admissible narrow run as meeting the gate", () => {
		const root = store();
		green(root, "adm", AT, {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		const s = reading(root);
		expect(s.gate.perRun).toEqual({ admissible: 1, total: 1 });
		expect(s.gate.perSha).toEqual({ admissible: 1, total: 1 });
		expect(s.routed.perSha).toEqual({ admissible: 1, total: 1 });
	});

	it("does not count a viaChanged launch that failed the freshness check", () => {
		const root = store();
		green(root, "stale", AT, {
			viaChanged: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		const s = reading(root);
		expect(s.gate.perRun).toEqual({ admissible: 0, total: 1 });
		expect(s.routed.perRun).toEqual({ admissible: 0, total: 1 });
	});

	it("never counts a red-store run as meeting the gate, whatever its scope claims", () => {
		const root = store();
		red(root, "r", ROUTE_FIX_AT, {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 5,
		});
		expect(reading(root).gate.perRun).toEqual({ admissible: 0, total: 1 });
	});

	it("counts a red launch as routed-admissible (mantahostels#2332)", () => {
		const root = store();
		red(root, "r", ROUTE_FIX_AT, {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		const s = reading(root);
		expect(s.routed.perRun).toEqual({ admissible: 1, total: 1 });
		expect(s.routed.perSha).toEqual({ admissible: 1, total: 1 });
		expect(s.gate.perSha).toEqual({ admissible: 0, total: 1 });
	});

	it("credits a sha the moment any one of its runs met the gate", () => {
		const root = store();
		green(root, "s", AT, { viaChanged: true, modulesTotal: 5, modulesRun: 2 });
		green(root, "s", AT, {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		const s = reading(root);
		expect(s.gate.perRun).toEqual({ admissible: 1, total: 2 });
		expect(s.gate.perSha).toEqual({ admissible: 1, total: 1 });
	});

	it("bounds the window's end in both stores, not only the full-runs rate denominator (mantahostels#3489)", () => {
		const root = store();
		const narrow = {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		};
		green(root, "early", AT, narrow);
		green(root, "late", "2026-09-05T00:00:00Z", narrow);
		red(root, "redLate", "2026-09-05T00:00:00Z", narrow);
		const s = reading(root, "--until", "2026-09-02T00:00:00Z");
		expect(s.routed.perRun).toEqual({ admissible: 1, total: 1 });
		expect(s.gate.perRun).toEqual({ admissible: 1, total: 1 });
	});
});

describe("main (CLI, run through runInProcess)", () => {
	it("names the below-floor sample rather than headlining a percentage, over a repo-less cwd", () => {
		const cwd = sandbox();
		const r = runInProcess(SCRIPT, [], { cwd });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("0/0");
		expect(r.stdout).toContain(`Below the ${MIN_SAMPLE}-sample floor`);
	});

	it("prints the routed and gate-clearing blocks as separate objects, the routed one named as mantahostels#2099-comparable", () => {
		// A git dir, because `repoRoot()` is what points the CLI at a store —
		// the sibling CLI tests read 0/0 for want of one.
		const root = sandbox();
		execFileSync("git", ["init", "-q"], { cwd: root });
		green(root, "g", "2026-09-01T00:00:00Z", {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		red(root, "r", "2026-09-01T00:00:00Z", {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		const r = runInProcess(SCRIPT, [], { cwd: root });
		expect(r.status).toBe(0);
		const out = r.stdout;
		expect(out).toMatch(
			/ROUTED-ADMISSIBLE[^\n]*87\.8%[^\n]*\n {2}per-sha {2}2\/2 = 100\.0%\n {2}per-run {2}2\/2 = 100\.0%\n/,
		);
		expect(out).toMatch(
			/GATE-CLEARING[^\n]*NOT comparable[^\n]*\n {2}per-sha {2}1\/2 = 50\.0%\n {2}per-run {2}1\/2 = 50\.0%\n/,
		);
	});

	it("prints the full-runs-a-day block, human-readable (AC-1)", () => {
		const root = sandbox();
		execFileSync("git", ["init", "-q"], { cwd: root });
		green(root, "f1", "2026-09-01T00:00:00Z", {
			modulesTotal: 5,
			modulesRun: 5,
			full: "flag",
		});
		green(root, "f2", "2026-09-01T00:00:00Z", {
			modulesTotal: 5,
			modulesRun: 5,
		});
		const r = runInProcess(SCRIPT, [], { cwd: root });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/FULL RUNS A DAY, since 2026-09-01T00:00:00Z/);
		expect(r.stdout).toMatch(/ {2}total {2}2 = /);
		expect(r.stdout).toMatch(/ {4}flag {2}1 = /);
		expect(r.stdout).toMatch(/ {4}unknown {2}1 = /);
	});

	it("--json prints a parseable object and no prose", () => {
		const cwd = sandbox();
		const r = runInProcess(SCRIPT, ["--json"], { cwd });
		expect(r.status).toBe(0);
		const parsed = JSON.parse(r.stdout.trim());
		expect(parsed.routed).toEqual({
			perRun: { admissible: 0, total: 0 },
			perSha: { admissible: 0, total: 0 },
		});
		expect(parsed.gate).toEqual({
			perRun: { admissible: 0, total: 0 },
			perSha: { admissible: 0, total: 0 },
		});
		expect(parsed.since).toBe(ROUTE_FIX_AT);
		// `fullPerDay.days` is real elapsed time, not asserted here.
		expect(parsed.fullPerDay.since).toBe(ROUTE_FIX_AT);
		expect(parsed.fullPerDay.total).toEqual({ count: 0, perDay: 0 });
		expect(parsed.fullPerDay.byReason).toEqual({
			flag: { count: 0, perDay: 0 },
			"stale-manifest": { count: 0, perDay: 0 },
			"dependency-root": { count: 0, perDay: 0 },
			"expansion-failed": { count: 0, perDay: 0 },
			unknown: { count: 0, perDay: 0 },
		});
	});

	it("--since --json does not swallow --json as the cutoff value", () => {
		const cwd = sandbox();
		const r = runInProcess(SCRIPT, ["--since", "--json"], { cwd });
		expect(r.status).toBe(0);
		const parsed = JSON.parse(r.stdout.trim());
		expect(parsed.since).toBe(ROUTE_FIX_AT);
	});

	it("--since with a value overrides the default cutoff, printed in the banner", () => {
		const cwd = sandbox();
		const r = runInProcess(SCRIPT, ["--since", "2026-01-01T00:00:00Z"], {
			cwd,
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("since 2026-01-01T00:00:00Z");
	});

	it("--until bounds the window's end, printed in the banner (mantahostels#3489)", () => {
		const root = sandbox();
		execFileSync("git", ["init", "-q"], { cwd: root });
		green(root, "early", "2026-09-01T00:00:00Z", {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		green(root, "late", "2026-09-05T00:00:00Z", {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		const r = runInProcess(
			SCRIPT,
			["--since", ROUTE_FIX_AT, "--until", "2026-09-02T00:00:00Z"],
			{ cwd: root },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("until 2026-09-02T00:00:00Z");
		expect(r.stdout).toMatch(/ROUTED-ADMISSIBLE[\s\S]*1\/1 = 100\.0%/);
	});

	it("an unparseable --until reads as no end bound, never as excluding every marker", () => {
		const root = sandbox();
		execFileSync("git", ["init", "-q"], { cwd: root });
		green(root, "g", "2026-09-01T00:00:00Z", {
			viaChanged: true,
			admissible: true,
			modulesTotal: 5,
			modulesRun: 2,
		});
		const r = runInProcess(SCRIPT, ["--until", "not-a-date"], { cwd: root });
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("until");
		expect(r.stdout).toMatch(/ROUTED-ADMISSIBLE[\s\S]*1\/1 = 100\.0%/);
	});
});
