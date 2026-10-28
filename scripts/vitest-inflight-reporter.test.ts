// @vitest-environment node
/*
 * The premise #1149's heartbeat rests on, proved against a real vitest run:
 * per-test events from one worker reach the vitest parent while another worker
 * is parked in a synchronous call, and those events alone hold the stall
 * watchdog off. An in-process fake cannot show it — the parked worker has to be
 * a real process blocking its own event loop.
 *
 * Worker A parks in `Atomics.wait` for longer than the ceiling while worker B
 * runs short async tests until A wakes.
 *
 * The reporter is registered in `vitest.config` for every suite run: break the
 * premise and `run-vitest.js`'s stall watchdog kills a long test file that is
 * still working.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { main } = require("./run-vitest.js");
const inflight = require("./lib/test-inflight.js");
const timings = require("./lib/test-file-timings.js");
const { takeRunReport } = require("./lib/suite-handoff.js");

const REPO = path.resolve(__dirname, "..");
/* The ceiling must outlast the run's own start-up silence (fork, import, first
 * test event), and the park must outlast the ceiling. Margins, not measured
 * under load: quiet, the case takes 8.7 s, and with beats off it is killed at
 * 4.5 s. */
const STALL = 4000;
const PARK = 8000;

let dir: string;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-park-")));
	const at = (name: string) => JSON.stringify(path.join(dir, name));
	fs.writeFileSync(
		path.join(dir, "vitest.config.mjs"),
		`export default { test: { globals: true, environment: "node", pool: "forks",
  maxWorkers: 2, include: ["*.test.mjs"], testTimeout: 60000,
  reporters: ["default", ${JSON.stringify(path.join(REPO, "scripts", "vitest-inflight-reporter.ts"))}] } };\n`,
	);
	fs.writeFileSync(
		path.join(dir, "a-parked.test.mjs"),
		`import fs from "node:fs";
test("parks", async () => {
  while (!fs.existsSync(${at("b-started")})) await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(${at("park-start")}, String(Date.now()));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${PARK});
  fs.writeFileSync(${at("park-end")}, String(Date.now()));
});\n`,
	);
	fs.writeFileSync(
		path.join(dir, "b-live.test.mjs"),
		`import fs from "node:fs";
beforeAll(() => fs.writeFileSync(${at("b-started")}, ""));
for (let i = 0; i < 1000; i++)
  test("t" + i, async () => {
    if (fs.existsSync(${at("park-end")})) return;
    await new Promise((r) => setTimeout(r, 100));
  });\n`,
	);
}

it.each([
	"onTestCaseReady",
	"onTestCaseResult",
	"onHookStart",
	"onHookEnd",
] as const)("beats on %s", async (hook) => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-beat-")));
	const file = path.join(dir, "inflight.json");
	vi.stubEnv(inflight.INFLIGHT_ENV, file);
	const { default: Reporter } = await import("./vitest-inflight-reporter");
	const reporter = new Reporter();
	reporter.onTestRunStart();
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(file, past, past);

	reporter[hook]();

	expect(inflight.lastBeat(file)).toBeGreaterThan(past.getTime() + 30_000);
});

it("records the files the run scheduled as it starts (#2696)", async () => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-sched-")));
	const file = path.join(dir, "inflight.json");
	vi.stubEnv(inflight.INFLIGHT_ENV, file);
	const { default: Reporter } = await import("./vitest-inflight-reporter");
	const reporter = new Reporter();
	const a = path.join(dir, "a.test.ts");
	const b = path.join(dir, "b.test.ts");

	reporter.onTestRunStart([{ moduleId: a }, { moduleId: b }]);

	expect(inflight.readRecord(file).scheduled).toEqual([a, b]);
});

/* The run-cost report's figure (#1883): queued to end, on fake timers so
 * the seconds are exact (§X9). */
it("leaves each file's queued-to-end seconds where the wrapper names a file", async () => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-span-")));
	const file = path.join(dir, "timings.json");
	vi.stubEnv(inflight.INFLIGHT_ENV, path.join(dir, "inflight.json"));
	vi.stubEnv(timings.TIMINGS_ENV, file);
	vi.useFakeTimers({ toFake: ["performance"] });
	const { default: Reporter } = await import("./vitest-inflight-reporter");
	const reporter = new Reporter();
	const module = { moduleId: path.join(dir, "a.test.ts") };

	reporter.onTestRunStart();
	reporter.onTestModuleQueued(module);
	vi.advanceTimersByTime(12_500);
	reporter.onTestModuleCollected(module);
	reporter.onTestModuleEnd(module);
	reporter.onTestRunEnd();

	expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
		[module.moduleId]: 12.5,
	});
});

/* The margin check's slowest files (#2770), repo-relative off vitest's root. */
it("hands the run's slowest files to the pass marker's run report", async () => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-slow-")));
	vi.stubEnv(inflight.INFLIGHT_ENV, path.join(dir, "inflight.json"));
	vi.stubEnv(timings.TIMINGS_ENV, "");
	vi.useFakeTimers({ toFake: ["performance"] });
	const { default: Reporter } = await import("./vitest-inflight-reporter");
	const reporter = new Reporter();
	reporter.onInit({ config: { root: dir } });
	const module = { moduleId: path.join(dir, "lib", "a.test.ts") };

	reporter.onTestRunStart();
	reporter.onTestModuleQueued(module);
	vi.advanceTimersByTime(12_500);
	reporter.onTestModuleEnd(module);
	reporter.onTestRunEnd();

	expect(takeRunReport().slowest).toEqual([
		{ file: path.join("lib", "a.test.ts"), seconds: 12.5 },
	]);
});

it("keeps a run alive on test events alone while another worker is parked", async () => {
	fixture();
	const chunks: number[] = [];
	const said: string[] = [];
	for (const s of [process.stdout, process.stderr])
		vi.spyOn(s, "write").mockImplementation((chunk) => {
			chunks.push(Date.now());
			said.push(String(chunk));
			return true;
		});

	const code = await main(["--shared", "--full=coverage"], {
		root: dir,
		bin: path.join(REPO, "node_modules", ".bin", "vitest"),
		stall: STALL,
		inflightFile: path.join(dir, "inflight.json"),
		out: { write: () => true },
	});
	vi.restoreAllMocks();

	const start = Number(fs.readFileSync(path.join(dir, "park-start"), "utf8"));
	const end = Number(fs.readFileSync(path.join(dir, "park-end"), "utf8"));
	expect(said.join("")).not.toContain("SUITE STALLED");
	expect(code).toBe(0);
	/* Without these two the case passes vacuously: output inside the window, or
	 * a window shorter than the ceiling, could have held the watchdog off. */
	expect(end - start).toBeGreaterThan(STALL);
	expect(chunks.filter((t) => t > start && t < end)).toEqual([]);
}, 120_000);
