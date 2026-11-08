// @vitest-environment node
/*
 * The quiet bench route's writes through the real control file (#3852), in a
 * sandbox WFC_REFILL_DIR. Loosen one and a pause set since the tick read the
 * control is overwritten or lifted, or a run's rows never reach the issue.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GH_FAILING_SCRIPT, stubGhScript } from "./gh-stub";
import { buildMeminfo } from "./meminfo-fake";
import { writePsStub } from "./ps-stub";
import { LADDER_BENCH } from "./quiet-bench.js";
import {
	createRun,
	quietBenchFiles,
	readUnpostedRuns,
} from "./quiet-bench-runs.js";
import { tendQuietBench } from "./quiet-bench-tick.js";
import { QUIET_BENCH_PAUSE } from "./refill-decide.js";
import { loopFiles, writeControlFile } from "./refill-files.js";
import { parseControl } from "./refill-loop.js";

const NOW = 1_800_000_000_000;
const OURS = { by: QUIET_BENCH_PAUSE, at: NOW - 1000, why: "held" };
const RUN_STATE = { attemptAt: NOW - 7e6, phase: "run", since: NOW - 7e6 };

let dir: string;
let checkout: string;

const baseControl = {
	noProgressFrom: 1,
	stopRequested: false,
	seats: [],
	scope: { mode: "away" as const, repos: [], goal: null },
};

const readStored = () =>
	parseControl(JSON.parse(fs.readFileSync(loopFiles().control, "utf8")));

const readState = () =>
	JSON.parse(fs.readFileSync(quietBenchFiles().state, "utf8"));

const writeState = (state: object) =>
	fs.writeFileSync(quietBenchFiles().state, JSON.stringify(state));

const tend = (
	control: NonNullable<ReturnType<typeof parseControl>>,
	served = [checkout],
) => {
	const start = vi.fn();
	const lines: string[] = [];
	const next = tendQuietBench({
		control,
		lastTypedAt: null,
		served,
		now: NOW,
		log: (l: string) => lines.push(l),
		start,
	});
	return { next, start, lines };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-bench-tick-"));
	checkout = path.join(dir, "checkout");
	fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(checkout, LADDER_BENCH.script), "");
	vi.stubEnv("WFC_REFILL_DIR", dir);
	vi.stubEnv("WFC_PRESENCE_MARKER", path.join(dir, "presence"));
	vi.stubEnv("WFC_GH", stubGhScript(dir, "#!/bin/sh\nexit 0\n").gh);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

it("lifts its own pause when its runner is dead, across a restart", () => {
	const control = { ...baseControl, paused: OURS };
	writeControlFile(control);
	writeState(RUN_STATE);
	const { next, lines } = tend(control);
	expect(next.paused).toBeUndefined();
	expect(readStored()?.paused).toBeUndefined();
	expect(lines.join()).toContain("died");
	expect(readState().phase).toBe(null);
});

it("does not lift a founder's pause set since the tick read the control", () => {
	const founder = { by: "founder", at: NOW - 1 };
	writeControlFile({ ...baseControl, paused: founder });
	writeState(RUN_STATE);
	tend({ ...baseControl, paused: OURS });
	expect(readStored()?.paused).toEqual(founder);
});

it("takes no pause over one set since the tick read the control, and counts no attempt", () => {
	const founder = { by: "founder", at: NOW - 1 };
	writeControlFile({ ...baseControl, paused: founder });
	writeState({ due: { at: NOW - 1, value: true } });
	const { next } = tend(baseControl);
	expect(readStored()?.paused).toEqual(founder);
	expect(next).toBe(baseControl);
	expect(readState().attemptAt).toBeUndefined();
});

it("takes the pause on a due bench and names why", () => {
	writeControlFile(baseControl);
	writeState({ due: { at: NOW - 1, value: true } });
	const { next } = tend(baseControl);
	expect(next.paused).toMatchObject({ by: QUIET_BENCH_PAUSE, at: NOW });
	expect(next.paused?.why).toContain(`#${LADDER_BENCH.issue}`);
	expect(readStored()?.paused).toEqual(next.paused);
});

it("does nothing with its setting off", () => {
	const control = { ...baseControl, quietBenchOff: true as const };
	writeControlFile(control);
	writeState({ due: { at: NOW - 1, value: true } });
	expect(tend(control).next.paused).toBeUndefined();
});

it("reads as off where no served checkout holds the bench", () => {
	writeControlFile(baseControl);
	writeState({ due: { at: NOW - 1, value: true } });
	expect(tend(baseControl, [dir]).next.paused).toBeUndefined();
});

it("starts the runner in the checkout on the second quiet reading", () => {
	const control = { ...baseControl, paused: OURS };
	writeControlFile(control);
	writeState({
		attemptAt: NOW - 600_000,
		phase: "drain",
		since: NOW - 600_000,
		quietSince: NOW - 300_000,
		quietAt: NOW - 60_000,
	});
	vi.stubEnv("WFC_PS", writePsStub(dir, ["1 1 init"]));
	const meminfo = path.join(dir, "meminfo");
	fs.writeFileSync(
		meminfo,
		buildMeminfo({ availableMb: 8000, swapTotalMb: 0, swapFreeMb: 0 }),
	);
	vi.stubEnv("WFC_MEMINFO", meminfo);
	const { next, start } = tend(control);
	expect(start).toHaveBeenCalledWith(checkout);
	expect(next.paused?.why).toContain("running");
	expect(readState().phase).toBe("run");
});

it("posts a run a dead runner left unposted, once", () => {
	writeControlFile(baseControl);
	writeState({ attemptAt: NOW - 1000 });
	createRun(new Date(NOW));
	const { lines } = tend(baseControl);
	expect(lines.join()).toContain("posted run");
	expect(readUnpostedRuns()).toEqual([]);
	expect(tend(baseControl).lines).toEqual([]);
});

it("leaves a run unposted while gh fails, for a later tick", () => {
	writeControlFile(baseControl);
	writeState({ attemptAt: NOW - 1000 });
	createRun(new Date(NOW));
	vi.stubEnv("WFC_GH", stubGhScript(dir, GH_FAILING_SCRIPT).gh);
	expect(tend(baseControl).lines.join()).toContain("not posted");
	expect(readUnpostedRuns()).toHaveLength(1);
});

it("keeps its runs outside what the scratch sweep reaps", () => {
	const { runs } = quietBenchFiles();
	expect(runs.startsWith(dir)).toBe(true);
	expect(runs).not.toContain(path.join(".claude", "tmp"));
});

it("reads the due bench's blockers off #4607, the whole-suite re-measure (#4608)", () => {
	/* An empty checkout's suite has drifted -100% from the ladder's. */
	execFileSync("git", ["init", "-q", checkout]);
	fs.mkdirSync(path.join(checkout, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(checkout, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "owner/tracker" }),
	);
	const asked = path.join(dir, "asked");
	vi.stubEnv(
		"WFC_GH",
		stubGhScript(dir, `#!/bin/sh\nprintf "%s\\n" "$@" > ${asked}\necho 1\n`).gh,
	);
	writeControlFile(baseControl);
	expect(tend(baseControl).next.paused).toBeUndefined();
	expect(fs.readFileSync(asked, "utf8")).toContain(
		"repos/owner/tracker/issues/4607/dependencies/blocked_by",
	);
	expect(readState().due.value).toBe(false);
});
