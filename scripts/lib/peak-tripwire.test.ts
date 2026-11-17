// @vitest-environment node
/*
 * The peak tripwire (#5367) through its public API, the journal's incidents,
 * the run store and the clock injected: no case reads the real journal. Break
 * it and a kill under the peak charge leaves part-suites on it, a ladder-only
 * kill or another process's kill sends them back for nothing, or a blind
 * journal leaves the peak charge running unwatched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wire = require("./peak-tripwire.js");

const T0 = Date.parse("2026-11-17T03:00:00Z");
/* peak-tripwire.js's journal throttle. */
const CHECK_MS = 30 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let file: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "peak-tripwire-"));
	file = path.join(dir, "peak-tripwire.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const TEST_RUN = {
	role: "worker",
	session: "s-killed",
	kind: "named",
	argv: ["a.test.ts"],
	files: ["a.test.ts"],
	fileCount: 1,
	repo: "workflow-core",
};

function kill(at: number, over: Record<string, unknown> = {}) {
	return {
		at: iso(at),
		pid: 4242,
		uid: 1000,
		name: "MainThread",
		kind: "test run",
		jobId: null,
		testRun: TEST_RUN,
		gateRun: null,
		badness: 700,
		rssMiB: 900,
		availMiB: 700,
		swapFreeMiB: 0,
		signals: 1,
		...over,
	};
}

const incidents =
	(...kills: ReturnType<typeof kill>[]) =>
	() => ({
		incidents: [
			{ kills, first: kills[0].at, last: kills.at(-1)?.at, unjoined: null },
		],
		why: null,
	});

/** A run file live from `from` to `to`, admitted on `mode`. */
function runFile(mode: string | undefined, from: number, to: number) {
	return {
		session: `s-${mode}`,
		kind: "named",
		argv: [],
		files: [],
		fileCount: 1,
		repo: "workflow-core",
		pids: { wrapper: 10, main: 11, workers: [] },
		peaksMiB: { wrapper: 0, main: 0, worker: 0, sum: 0 },
		workerFile: null,
		at: iso(from),
		bootId: "b",
		sampledAt: iso(to),
		workersSeenAt: {},
		...(mode === undefined ? {} : { mode }),
	};
}
const store =
	(...runs: ReturnType<typeof runFile>[]) =>
	() => ({ runs, why: null });

const NONE = () => ({ incidents: [], why: null });

describe("the peak tripwire", () => {
	it("starts armed where no state file exists", () => {
		expect(wire.readTripwire({ file }).tripwire.state).toBe("armed");
		expect(
			wire.gateTripwire({
				file,
				now: T0,
				readIncidents: NONE,
				readRunFiles: store(),
			}),
		).toBeNull();
	});

	it("trips on a test-run kill while a peak run is live, recording the kill and the runs", () => {
		wire.armTripwire({ session: "s0", now: T0 - 60_000, file });
		const log = vi.fn();
		const got = wire.gateTripwire({
			file,
			now: T0 + 10_000,
			readIncidents: incidents(kill(T0)),
			readRunFiles: store(
				runFile("peak", T0 - 30_000, T0 + 5000),
				runFile("ladder", T0 - 30_000, T0 + 5000),
			),
			log,
		});
		expect(got).toMatchObject({ cause: "tripped" });
		expect(got.why).toContain("pid 4242");
		const { tripwire } = wire.readTripwire({ file });
		expect(tripwire).toMatchObject({
			state: "tripped",
			trip: { pid: 4242, name: "MainThread", rssMiB: 900, testRun: TEST_RUN },
			trippedAt: iso(T0 + 10_000),
		});
		expect(tripwire.liveRuns).toEqual([
			{
				at: iso(T0 - 30_000),
				session: "s-peak",
				kind: "named",
				fileCount: 1,
				repo: "workflow-core",
			},
		]);
		expect(log).toHaveBeenCalled();
	});

	it("counts a peak run live only from its start to its last sample plus the store's slack", () => {
		wire.armTripwire({ session: "s0", now: T0 - 600_000, file });
		const at = (from: number, to: number) => {
			fs.rmSync(file, { force: true });
			wire.armTripwire({ session: "s0", now: T0 - 600_000, file });
			return wire.gateTripwire({
				file,
				now: T0 + 10_000,
				readIncidents: incidents(kill(T0)),
				readRunFiles: store(runFile("peak", from, to)),
			});
		};
		expect(at(T0 - 60_000, T0 - 1000)).toMatchObject({ cause: "tripped" });
		expect(at(T0 - 60_000, T0 - 30_000)).toBeNull();
		expect(at(T0 + 2000, T0 + 9000)).toBeNull();
	});

	it("stays armed on a kill with only ladder runs live, and on a kill that is no test run", () => {
		wire.armTripwire({ session: "s0", now: T0 - 60_000, file });
		expect(
			wire.gateTripwire({
				file,
				now: T0 + 10_000,
				readIncidents: incidents(kill(T0)),
				readRunFiles: store(
					runFile("ladder", T0 - 30_000, T0 + 5000),
					runFile(undefined, T0 - 30_000, T0 + 5000),
				),
			}),
		).toBeNull();
		expect(
			wire.gateTripwire({
				file,
				now: T0 + 50_000,
				readIncidents: incidents(
					kill(T0 + 40_000, {
						kind: "node or python process",
						testRun: null,
					}),
				),
				readRunFiles: store(runFile("peak", T0, T0 + 45_000)),
			}),
		).toBeNull();
		expect(wire.readTripwire({ file }).tripwire.state).toBe("armed");
	});

	it("persists a trip across reads, and a later clean journal does not clear it", () => {
		wire.armTripwire({ session: "s0", now: T0 - 60_000, file });
		wire.gateTripwire({
			file,
			now: T0 + 10_000,
			readIncidents: incidents(kill(T0)),
			readRunFiles: store(runFile("peak", T0 - 30_000, T0 + 5000)),
		});
		const later = wire.gateTripwire({
			file,
			now: T0 + 3_600_000,
			readIncidents: NONE,
			readRunFiles: store(),
		});
		expect(later).toMatchObject({ cause: "tripped" });
		expect(wire.readTripwire({ file }).tripwire.trip.pid).toBe(4242);
	});

	it("re-arming resets the state and advances the cursor past the old kill", () => {
		wire.armTripwire({ session: "s0", now: T0 - 60_000, file });
		const tripping = {
			readIncidents: incidents(kill(T0)),
			readRunFiles: store(runFile("peak", T0 - 30_000, T0 + 5000)),
		};
		wire.gateTripwire({ file, now: T0 + 10_000, ...tripping });
		const armed = wire.armTripwire({
			session: "s-reader",
			now: T0 + 20_000,
			file,
		});
		expect(armed).toMatchObject({
			state: "armed",
			trip: null,
			liveRuns: [],
			trippedAt: null,
			checkedThrough: iso(T0 + 20_000),
			armedBy: "s-reader",
			armedAt: iso(T0 + 20_000),
		});
		expect(
			wire.gateTripwire({ file, now: T0 + 60_000, ...tripping }),
		).toBeNull();
	});

	it("reads the journal at most once per 30 s, by the last check", () => {
		wire.armTripwire({ session: "s0", now: T0 - 60_000, file });
		const readIncidents = vi.fn(NONE);
		const ports = { file, readIncidents, readRunFiles: store() };
		wire.gateTripwire({ ...ports, now: T0 });
		wire.gateTripwire({ ...ports, now: T0 + CHECK_MS - 1 });
		expect(readIncidents).toHaveBeenCalledTimes(1);
		wire.gateTripwire({ ...ports, now: T0 + CHECK_MS });
		expect(readIncidents).toHaveBeenCalledTimes(2);
		expect(readIncidents).toHaveBeenLastCalledWith(T0);
	});

	it("reports blind on an unreadable journal, keeps the cursor, and clears on a readable check", () => {
		wire.armTripwire({ session: "s0", now: T0 - 60_000, file });
		const log = vi.fn();
		const blind = wire.gateTripwire({
			file,
			now: T0,
			readIncidents: () => ({
				incidents: [],
				why: "journalctl -u earlyoom: denied",
			}),
			readRunFiles: store(),
			log,
		});
		expect(blind).toEqual({
			cause: "journal-unread",
			why: "journalctl -u earlyoom: denied",
		});
		expect(log).toHaveBeenCalled();
		const between = wire.gateTripwire({
			file,
			now: T0 + 1000,
			readIncidents: NONE,
			readRunFiles: store(),
		});
		expect(between).toMatchObject({ cause: "journal-unread" });
		const { tripwire } = wire.readTripwire({ file });
		expect(tripwire.checkedThrough).toBe(iso(T0 - 60_000));
		expect(tripwire.unread).toEqual({
			at: iso(T0),
			why: "journalctl -u earlyoom: denied",
		});
		const readIncidents = vi.fn(NONE);
		expect(
			wire.gateTripwire({
				file,
				now: T0 + CHECK_MS,
				readIncidents,
				readRunFiles: store(),
			}),
		).toBeNull();
		expect(readIncidents).toHaveBeenCalledWith(T0 - 60_000);
		expect(wire.readTripwire({ file }).tripwire.unread).toBeNull();
	});

	it("reads blind where a test-run kill meets a run store that will not read", () => {
		wire.armTripwire({ session: "s0", now: T0 - 60_000, file });
		expect(
			wire.gateTripwire({
				file,
				now: T0 + 10_000,
				readIncidents: incidents(kill(T0)),
				readRunFiles: () => ({ runs: [], why: "the test run store: EIO" }),
			}),
		).toEqual({ cause: "journal-unread", why: "the test run store: EIO" });
	});

	it("reads a corrupt state file as blind, leaves it for `arm`, and never throws", () => {
		fs.writeFileSync(file, "{ torn");
		const readIncidents = vi.fn(NONE);
		const got = wire.gateTripwire({
			file,
			now: T0,
			readIncidents,
			readRunFiles: store(),
		});
		expect(got?.cause).toBe("journal-unread");
		expect(got?.why).toContain("peak-tripwire.json");
		expect(readIncidents).not.toHaveBeenCalled();
		expect(fs.readFileSync(file, "utf8")).toBe("{ torn");
		wire.armTripwire({ session: "s-reader", now: T0, file });
		expect(
			wire.gateTripwire({
				file,
				now: T0 + 1000,
				readIncidents,
				readRunFiles: store(),
			}),
		).toBeNull();
		expect(
			wire.gateTripwire({
				file,
				now: T0 + 1000 + CHECK_MS,
				readIncidents: () => {
					throw new Error("boom");
				},
				readRunFiles: store(),
			}),
		).toEqual({
			cause: "journal-unread",
			why: "peak tripwire check failed: boom",
		});
	});
});
