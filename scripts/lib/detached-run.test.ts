// @vitest-environment node
/*
 * Pins the completion record a detached session-start child leaves, and the
 * death count a later session reads off it (mantahostels#1910, mantahostels#1999).
 *
 * In-process against a temp config dir per test, never the founder's record,
 * which live session starts rewrite under the suite.
 * CLAUDE_CONFIG_DIR IS SET PER TEST, not once at module load: the module reads
 * it at call time, deliberately, so that the proving harness can redirect it.
 *
 * check-hook-liveness.js reports these deaths under `npm run status`, so a loosened
 * case lets a housekeeping sweep that dies every start go unreported again, or
 * cries death over a run still inside its grace.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const mod = require("./detached-run.js");

let cfg: string;
const prior = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
	cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-detached-"));
	process.env.CLAUDE_CONFIG_DIR = cfg;
});

afterEach(() => {
	if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = prior;
	fs.rmSync(cfg, { recursive: true, force: true });
});

const file = () => path.join(cfg, mod.RUN_FILE);
const rows = () => JSON.parse(fs.readFileSync(file(), "utf8"));

/* Long enough ago that openRun reads the row it belongs to as dead.
 *
 * CONSECUTIVE BACKDATED OPENS MUST BE MORE THAN ONE GRACE APART, not exactly
 * one: openRun ages a row on `> INFLIGHT_MS`, so a ladder spaced at exactly
 * INFLIGHT_MS reads every row as still alive and counts nothing. Hence the even
 * multiples below. */
const GRACE = 300_000; // INFLIGHT_MS in lib/detached-run.js
const pastGrace = (ms = GRACE + 60_000) => Date.now() - ms;

describe("the record itself", () => {
	it("writes the start half before the work, so a child that never returns leaves one", () => {
		const record = mod.openRun("prune-markers");
		expect(rows()["prune-markers"].startedAt).toBe(record.startedAt);
		expect(rows()["prune-markers"].finishedAt).toBeUndefined();
	});

	it("closes with ok true and carries the counts through", () => {
		const record = mod.openRun("debt-sweep");
		mod.closeRun(record, { ok: true, counts: { retired: 3 } });
		expect(rows()["debt-sweep"]).toMatchObject({
			ok: true,
			counts: { retired: 3 },
		});
		expect(rows()["debt-sweep"].finishedAt).toEqual(expect.any(String));
	});

	it("records a throw as ok false with its message, and still finishes the row", () => {
		expect(() =>
			mod.recordRun("prune-markers", () => {
				throw new Error("store unopenable");
			}),
		).toThrow("store unopenable");
		expect(rows()["prune-markers"].ok).toBe(false);
		expect(rows()["prune-markers"].error).toContain("store unopenable");
		expect(rows()["prune-markers"].finishedAt).toEqual(expect.any(String));
	});

	it("leaves another job's row alone", () => {
		mod.recordRun("debt-sweep", () => 1);
		mod.recordRun("prune-markers", () => 1);
		expect(Object.keys(rows()).sort()).toEqual(["debt-sweep", "prune-markers"]);
	});

	it("returns what the work returned, unchanged", () => {
		expect(mod.recordRun("debt-sweep", () => ({ status: "swept" }))).toEqual({
			status: "swept",
		});
	});
});

describe("the death count — what a later session reads", () => {
	it("stays at zero while every run closes", () => {
		for (let i = 0; i < 5; i++) mod.recordRun("prune-markers", () => 1);
		expect(rows()["prune-markers"].deaths).toBe(0);
	});

	it("counts a previous run that opened past its grace and never closed", () => {
		mod.openRun("prune-markers", pastGrace());
		mod.openRun("prune-markers");
		expect(rows()["prune-markers"].deaths).toBe(1);
	});

	it("accumulates across consecutive deaths", () => {
		mod.openRun("prune-markers", pastGrace(GRACE * 6));
		mod.openRun("prune-markers", pastGrace(GRACE * 4));
		mod.openRun("prune-markers", pastGrace(GRACE * 2));
		mod.openRun("prune-markers");
		expect(rows()["prune-markers"].deaths).toBe(3);
	});

	it("does NOT count a run still inside its grace — the concurrency case", () => {
		mod.openRun("debt-sweep");
		mod.openRun("debt-sweep");
		mod.openRun("debt-sweep");
		mod.openRun("debt-sweep");
		expect(rows()["debt-sweep"].deaths).toBe(0);
	});

	it("counts a death from consecutive restarts each inside the grace of the one before it — the busy-machine case (mantahostels#1999)", () => {
		/* Each reopen is closer to its predecessor than INFLIGHT_MS, so ageing
		 * against the latest `startedAt` alone would read
		 * every one of these as still within grace and never count a death. Ageing
		 * against `openedSince` — fixed at the first open of this unbroken run —
		 * lets the total elapsed time win once it passes the grace. */
		const step = GRACE / 3;
		const start = Date.now() - GRACE * 2;
		mod.openRun("prune-markers", start);
		mod.openRun("prune-markers", start + step);
		mod.openRun("prune-markers", start + step * 2);
		mod.openRun("prune-markers", start + step * 3);
		mod.openRun("prune-markers", start + step * 4);
		expect(rows()["prune-markers"].deaths).toBe(1);
	});

	it("counts one death from a burst of concurrent starts against an already-stale row, never one per opener", () => {
		/* mantahostels#1999: resetting `openedSince` only on CLOSE, never on a counted death,
		 * made every further open past the first stale one count its own death —
		 * three starts 2s apart against a row already well past grace would each
		 * add one, reaching DEATHS_TO_REPORT on concurrency alone. */
		mod.openRun("prune-markers", pastGrace(GRACE * 3));
		const burstStart = Date.now();
		mod.openRun("prune-markers", burstStart);
		mod.openRun("prune-markers", burstStart + 2000);
		mod.openRun("prune-markers", burstStart + 4000);
		expect(rows()["prune-markers"].deaths).toBe(1);
	});

	it("clears the count as soon as one run closes", () => {
		mod.openRun("prune-markers", pastGrace(GRACE * 4));
		mod.openRun("prune-markers", pastGrace(GRACE * 2));
		const open = mod.openRun("prune-markers");
		expect(rows()["prune-markers"].deaths).toBe(2);
		mod.closeRun(open, { ok: true });
		mod.openRun("prune-markers");
		expect(rows()["prune-markers"].deaths).toBe(0);
	});

	it("leaves the count alone on a stamp it cannot age", () => {
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(
			file(),
			JSON.stringify({
				"debt-sweep": {
					job: "debt-sweep",
					startedAt: "not a date",
					openedSince: "not a date",
					deaths: 2,
				},
			}),
		);
		mod.openRun("debt-sweep");
		expect(rows()["debt-sweep"].deaths).toBe(2);
	});

	it("carries the last completion forward, so a healthy job is legible mid-run", () => {
		const first = mod.openRun("debt-sweep");
		mod.closeRun(first, { ok: true });
		const finishedAt = rows()["debt-sweep"].finishedAt;
		mod.openRun("debt-sweep");
		expect(rows()["debt-sweep"].lastFinishedAt).toBe(finishedAt);
		expect(rows()["debt-sweep"].finishedAt).toBeUndefined();
	});
});

describe("it never throws on the session-start path", () => {
	/* THE UNWRITABLE PARENT IS A REGULAR FILE, NEVER A PATH UNDER /proc. On this
	 * machine's WSL2 kernel `fs.mkdirSync(p, { recursive: true })` under /proc
	 * never returns, so a /proc path here hangs the whole run with no output and
	 * reads as a broken test suite rather than a failing test. A file standing
	 * where a directory is wanted refuses at once. */
	it("survives a config dir it cannot write to", () => {
		const blocked = path.join(cfg, "not-a-dir");
		fs.writeFileSync(blocked, "x");
		process.env.CLAUDE_CONFIG_DIR = path.join(blocked, "cfg");
		expect(() => mod.recordRun("prune-markers", () => 1)).not.toThrow();
	});

	it("reads a corrupt record file as no record at all", () => {
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(file(), "{ not json");
		expect(() => mod.openRun("prune-markers")).not.toThrow();
		expect(Object.keys(rows())).toEqual(["prune-markers"]);
		expect(rows()["prune-markers"].deaths).toBe(0);
	});

	it("reads an array as no record at all rather than indexing it", () => {
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(file(), "[]");
		mod.openRun("prune-markers");
		expect(Object.keys(rows())).toEqual(["prune-markers"]);
	});
});

describe("the job list", () => {
	it("names exactly the three children that record themselves", () => {
		expect(mod.JOBS).toEqual([
			"prune-markers",
			"debt-sweep",
			"retire-stale-containers",
		]);
	});
});
