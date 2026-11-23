// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mod = require("./detached-run.js");

let cfg: string;
beforeEach(() => {
	cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-detached-"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", cfg);
});

afterEach(() => {
	fs.rmSync(cfg, { recursive: true, force: true });
});

const file = () => path.join(cfg, mod.RUN_FILE);
const readRows = () => JSON.parse(fs.readFileSync(file(), "utf8"));

const GRACE = 300_000;
const pastGrace = (ms = GRACE + 60_000) => Date.now() - ms;

describe("the record itself", () => {
	it("writes the start half before the work, so a child that never returns leaves one", () => {
		const record = mod.openRun("prune-markers");
		expect(readRows()["prune-markers"].startedAt).toBe(record.startedAt);
		expect(readRows()["prune-markers"].finishedAt).toBeUndefined();
	});

	it("closes with ok true once the work returns", () => {
		mod.recordRun("retire-stale-containers", () => 1);
		expect(readRows()["retire-stale-containers"].ok).toBe(true);
		expect(readRows()["retire-stale-containers"].finishedAt).toEqual(
			expect.any(String),
		);
	});

	it("records a throw as ok false with its message, and still finishes the row", () => {
		expect(() =>
			mod.recordRun("prune-markers", () => {
				throw new Error("store unopenable");
			}),
		).toThrow("store unopenable");
		expect(readRows()["prune-markers"].ok).toBe(false);
		expect(readRows()["prune-markers"].error).toContain("store unopenable");
		expect(readRows()["prune-markers"].finishedAt).toEqual(expect.any(String));
	});

	it("leaves another job's row alone", () => {
		mod.recordRun("retire-stale-containers", () => 1);
		mod.recordRun("prune-markers", () => 1);
		expect(Object.keys(readRows()).sort()).toEqual([
			"prune-markers",
			"retire-stale-containers",
		]);
	});

	it("returns what the work returned, unchanged", () => {
		expect(
			mod.recordRun("retire-stale-containers", () => ({ status: "swept" })),
		).toEqual({
			status: "swept",
		});
	});
});

describe("the death count — what a later session reads", () => {
	it("stays at zero while every run closes", () => {
		for (let i = 0; i < 5; i++) mod.recordRun("prune-markers", () => 1);
		expect(readRows()["prune-markers"].deaths).toBe(0);
	});

	it("counts a previous run that opened past its grace and never closed", () => {
		mod.openRun("prune-markers", pastGrace());
		mod.openRun("prune-markers");
		expect(readRows()["prune-markers"].deaths).toBe(1);
	});

	it("accumulates across consecutive deaths", () => {
		mod.openRun("prune-markers", pastGrace(GRACE * 6));
		mod.openRun("prune-markers", pastGrace(GRACE * 4));
		mod.openRun("prune-markers", pastGrace(GRACE * 2));
		mod.openRun("prune-markers");
		expect(readRows()["prune-markers"].deaths).toBe(3);
	});

	it("does NOT count a run still inside its grace — the concurrency case", () => {
		mod.openRun("retire-stale-containers");
		mod.openRun("retire-stale-containers");
		mod.openRun("retire-stale-containers");
		mod.openRun("retire-stale-containers");
		expect(readRows()["retire-stale-containers"].deaths).toBe(0);
	});

	it("counts a death from consecutive restarts each inside the grace of the one before it — the busy-machine case (mantahostels#1999)", () => {
		const step = GRACE / 3;
		const start = Date.now() - GRACE * 2;
		mod.openRun("prune-markers", start);
		mod.openRun("prune-markers", start + step);
		mod.openRun("prune-markers", start + step * 2);
		mod.openRun("prune-markers", start + step * 3);
		mod.openRun("prune-markers", start + step * 4);
		expect(readRows()["prune-markers"].deaths).toBe(1);
	});

	it("counts one death from a burst of concurrent starts against an already-stale row, never one per opener", () => {
		mod.openRun("prune-markers", pastGrace(GRACE * 3));
		const burstStart = Date.now();
		mod.openRun("prune-markers", burstStart);
		mod.openRun("prune-markers", burstStart + 2000);
		mod.openRun("prune-markers", burstStart + 4000);
		expect(readRows()["prune-markers"].deaths).toBe(1);
	});

	it("clears the count as soon as one run closes", () => {
		mod.openRun("prune-markers", pastGrace(GRACE * 4));
		mod.openRun("prune-markers", pastGrace(GRACE * 2));
		mod.recordRun("prune-markers", () => {
			expect(readRows()["prune-markers"].deaths).toBe(2);
		});
		mod.openRun("prune-markers");
		expect(readRows()["prune-markers"].deaths).toBe(0);
	});

	it("leaves the count alone on a stamp it cannot age", () => {
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(
			file(),
			JSON.stringify({
				"retire-stale-containers": {
					job: "retire-stale-containers",
					startedAt: "not a date",
					openedSince: "not a date",
					deaths: 2,
				},
			}),
		);
		mod.openRun("retire-stale-containers");
		expect(readRows()["retire-stale-containers"].deaths).toBe(2);
	});

	it("carries the last completion forward, so a healthy job is legible mid-run", () => {
		mod.recordRun("retire-stale-containers", () => 1);
		const finishedAt = readRows()["retire-stale-containers"].finishedAt;
		mod.openRun("retire-stale-containers");
		expect(readRows()["retire-stale-containers"].lastFinishedAt).toBe(
			finishedAt,
		);
		expect(readRows()["retire-stale-containers"].finishedAt).toBeUndefined();
	});
});

describe("it never throws on the session-start path", () => {
	it("survives a config dir it cannot write to", () => {
		const blocked = path.join(cfg, "not-a-dir");
		fs.writeFileSync(blocked, "x");
		vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(blocked, "cfg"));
		expect(() => mod.recordRun("prune-markers", () => 1)).not.toThrow();
	});

	it("leaves a config dir that is gone unmade, filing no record (#2889)", () => {
		const gone = path.join(cfg, "removed");
		vi.stubEnv("CLAUDE_CONFIG_DIR", gone);
		expect(() => mod.recordRun("prune-markers", () => 1)).not.toThrow();
		expect(fs.existsSync(gone)).toBe(false);
	});

	it("reads a corrupt record file as no record at all", () => {
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(file(), "{ not json");
		expect(() => mod.openRun("prune-markers")).not.toThrow();
		expect(Object.keys(readRows())).toEqual(["prune-markers"]);
		expect(readRows()["prune-markers"].deaths).toBe(0);
	});

	it("reads an array as no record at all rather than indexing it", () => {
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(file(), "[]");
		mod.openRun("prune-markers");
		expect(Object.keys(readRows())).toEqual(["prune-markers"]);
	});
});

describe("the job list", () => {
	it("names exactly the two children that record themselves", () => {
		expect(mod.JOBS).toEqual(["prune-markers", "retire-stale-containers"]);
	});
});
