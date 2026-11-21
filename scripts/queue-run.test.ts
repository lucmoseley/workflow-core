// @vitest-environment node
/*
 * queue-run.js (#1776): the suite queue for `node --test`, pytest and the
 * other non-vitest runners. The gate, the turn, the spawn and the signals are
 * injected, those being shapes a real process cannot stage without a loaded
 * machine (§X3); the markers and the exit log are real files in a scratch
 * directory, and the classifier is the real lib/suite-launch.js. Two cases
 * run the program itself: a refusal, which queues nothing, and a `--tsc`
 * launch nested in its own command (#3404).
 * In the world, a wrong verdict runs a fourth suite past the cap, strands a
 * waiter's marker so later waiters queue behind nothing, or leaves its wait
 * out of the daily queue-wait figure.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readText } from "./lib/file-read.js";
import { mkScratchDir } from "./lib/git-fixture";
import { keptSpawn } from "./lib/kept-spawn.js";
import { chargeMb as launchChargeMb } from "./lib/launch-charge";
import { noop } from "./lib/noop.js";
import { writeCwd } from "./lib/proc-fake";
import { writePsStub } from "./lib/ps-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { WHOLE_SUITE_WORKERS, weighCarried } from "./lib/suite-bounded";
import { rungMb } from "./lib/suite-ladder";

const TSC_PEAK_MB = launchChargeMb({ kind: "tsc" });
const TSC7_PEAK_MB = launchChargeMb({ kind: "tsc", major: 7 });

const tscRung = rungMb(TSC_PEAK_MB);

const { main } = require("./queue-run.js");
const { gateRepoName, readGatePids } = require("./lib/gate-seat.js");
const PROGRAM = path.resolve(__dirname, "queue-run.js");

const dirs: string[] = [];
/* A run inside a gate seat's tree (a commit's pre-lock run) hands it
 * WFC_GATE_SEAT, which would read every launch here as already seated. */
beforeEach(() => {
	vi.stubEnv("WFC_GATE_SEAT", undefined);
});
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const fixture = () => {
	const dir = mkScratchDir("queue-run-");
	dirs.push(dir);
	const log = path.join(dir, "exits.jsonl");
	const signals = new EventEmitter();
	const err: string[] = [];
	const spawned: {
		command: string;
		args: string[];
		opts: { env?: Record<string, string> };
		child: FakeChild;
	}[] = [];
	const readMarkers = () =>
		fs.readdirSync(dir).filter((f) => f.startsWith("wfc-suite-queue-"));
	const readLog = () =>
		fs.existsSync(log)
			? fs
					.readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	const options = (extra: object = {}) => ({
		queueDir: dir,
		queueLog: log,
		sessionId: "s1",
		/* The highest compiler's, whatever store the run's own tree links. */
		tscPeakMb: TSC_PEAK_MB,
		gate: () => false,
		turn: () => true,
		// A wait that never polls again: the gate's first answer is final.
		sleepFn: () => new Promise(noop),
		out: { write: () => true },
		err: { write: (s: string) => err.push(s) },
		signals,
		spawnFn: (
			command: string,
			args: string[],
			opts: { env?: Record<string, string> },
		) => {
			const child = new FakeChild();
			spawned.push({ command, args, opts, child });
			return child;
		},
		...extra,
	});
	return { dir, signals, err, spawned, readMarkers, readLog, options };
};

class FakeChild extends EventEmitter {
	killed: string[] = [];
	kill(signal: string) {
		this.killed.push(signal);
		return true;
	}
}

const tick = () => new Promise((r) => setImmediate(r));

describe("queue-run.js", () => {
	it("runs the command once the gate opens, holding its marker until it exits", async () => {
		const f = fixture();
		const done = main(["--", "node", "--test", "a.test.js"], f.options());
		await tick();
		expect(f.spawned).toHaveLength(1);
		expect(f.spawned[0]).toMatchObject({
			command: "node",
			args: ["--test", "a.test.js"],
		});
		const [marker] = f.readMarkers();
		const read = () =>
			JSON.parse(fs.readFileSync(path.join(f.dir, marker as string), "utf8"));
		f.spawned[0].child.emit("spawn");
		expect(read().spawned).toBe(true);
		f.spawned[0].child.emit("exit", 3, null);
		expect(await done).toBe(3);
		expect(f.readMarkers()).toEqual([]);
		expect(f.readLog()).toEqual([
			expect.objectContaining({
				reason: "opened",
				kind: "other",
				session: "s1",
				empty: false,
			}),
		]);
	});

	it("stamps its marker with its runner's measured peak (#4648)", async () => {
		const f = fixture();
		const chargeOf = async (words: string[]) => {
			const done = main(["--", ...words], f.options());
			await tick();
			const [marker] = f.readMarkers();
			const { chargeMb } = JSON.parse(
				fs.readFileSync(path.join(f.dir, marker as string), "utf8"),
			);
			f.spawned.at(-1)?.child.emit("exit", 0, null);
			await done;
			return chargeMb;
		};
		expect(await chargeOf(["env", "CI=1", "pytest", "-n", "4"])).toBe(
			launchChargeMb({ kind: "pytest", workers: 4 }),
		);
		expect(await chargeOf(["node", "--test", "a.test.js"])).toBe(
			launchChargeMb({ kind: "node-test" }),
		);
		expect(await chargeOf(["python3", "scripts/x.test.py"])).toBe(
			launchChargeMb({ kind: "pytest", workers: 0 }),
		);
	});

	it("puts on its exit line the older part-suites its turn passed (#3115)", async () => {
		const f = fixture();
		const older = path.join(f.dir, "wfc-suite-queue-1.json");
		fs.writeFileSync(
			older,
			JSON.stringify({
				pid: 1,
				at: Date.now() - 1000,
				part: true,
				memoryHeld: true,
			}),
		);
		const { turn: _injected, ...options } = f.options({ alive: () => true });
		const done = main(["--seat", "--", "node", "mutate.js"], options);
		await tick();
		f.spawned[0].child.emit("exit", 0, null);
		expect(await done).toBe(0);
		expect(f.readLog()).toEqual([
			expect.objectContaining({ reason: "opened", kind: "seat", passed: 1 }),
		]);
	});

	it("passes a signal to a running command and takes its exit", async () => {
		const f = fixture();
		const done = main(["--", "pytest"], f.options());
		await tick();
		f.signals.emit("SIGTERM");
		expect(f.spawned[0].child.killed).toEqual(["SIGTERM"]);
		f.spawned[0].child.emit("exit", null, "SIGTERM");
		expect(await done).toBe(143);
		expect(f.readMarkers()).toEqual([]);
	});

	/* A wait still held at the bound refuses: one the memory rung holds would
	 * land short of its rung, where earlyoom kills live sessions (#2421), and
	 * one the count cap or the turn holds would run beside another whole suite
	 * (#2714). */
	it.each([
		{
			held: "memory rung",
			denial: { limb: "memory", mb: 900, rungMb: 3250 },
			turn: (): boolean => true,
			limb: "memory",
			line: /gate still denies on memory/,
		},
		{
			held: "count cap",
			denial: { limb: "count" },
			turn: (): boolean => true,
			limb: "count",
			line: /count cap .*wait bound — refused, not run/,
		},
		{
			held: "closed turn",
			denial: null,
			turn: (): boolean => false,
			limb: "turn",
			line: /turn still closed .*wait bound — refused, not run/,
		},
	])(
		"refuses a wait the $held holds at the timeout, spawning nothing",
		async ({ denial, turn, limb, line }) => {
			const f = fixture();
			const said: string[] = [];
			const code = await main(
				["--", "pytest"],
				f.options({
					gate: () => denial,
					turn,
					timeoutMs: -1,
					out: { write: (s: string) => said.push(s) },
				}),
			);
			expect(code).not.toBe(0);
			expect(f.spawned).toEqual([]);
			expect(f.readMarkers()).toEqual([]);
			expect(f.readLog()).toEqual([
				expect.objectContaining({ reason: "refused", limb }),
			]);
			expect(said.join("")).toMatch(line);
		},
	);

	it("leaves the queue and logs `killed` when a signal ends the wait", async () => {
		const f = fixture();
		const exits: number[] = [];
		main(
			["--", "pytest"],
			f.options({ gate: () => true, exit: (c: number) => exits.push(c) }),
		);
		await tick();
		f.signals.emit("SIGINT");
		expect(exits).toEqual([130]);
		expect(f.readMarkers()).toEqual([]);
		expect(f.spawned).toEqual([]);
		expect(f.readLog()).toEqual([
			expect.objectContaining({
				reason: "killed",
				kind: "other",
				signal: "SIGINT",
			}),
		]);
	});

	it("leaves a signal after its command exits to the process, never exiting on it", async () => {
		const f = fixture();
		const exits: number[] = [];
		const done = main(
			["--", "pytest"],
			f.options({ exit: (c: number) => exits.push(c) }),
		);
		await tick();
		f.spawned[0].child.emit("exit", 0, null);
		expect(await done).toBe(0);
		f.signals.emit("SIGTERM");
		expect(exits).toEqual([]);
	});

	it("exits 127 where the command will not start", async () => {
		const f = fixture();
		const done = main(["--", "pytest"], f.options());
		await tick();
		f.spawned[0].child.emit("error", new Error("spawn pytest ENOENT"));
		expect(await done).toBe(127);
		expect(f.err.join("")).toMatch(/pytest would not start/);
		expect(f.readMarkers()).toEqual([]);
	});

	it("takes a child's signal death as 128 + the signal's number", async () => {
		const f = fixture();
		const done = main(["--", "pytest"], f.options());
		await tick();
		f.spawned[0].child.emit("exit", null, "SIGKILL");
		expect(await done).toBe(137);
	});

	it.each([
		["node --test a.test.js"],
		["timeout 600 pytest -x"],
		["python3 test/check-flow.test.py"],
	])("queues %s", async (command) => {
		const f = fixture();
		main(["--", ...command.split(" ")], f.options());
		await tick();
		expect(f.spawned).toHaveLength(1);
	});

	it.each([
		[
			"npm run test",
			/vitest launch, whose queue is run-vitest\.js's `--queue`/,
		],
		["ls", /runs no suite the cap counts/],
		["node scripts/queue-run.js -- pytest", /already a queue-run\.js launch/],
		[
			"node scripts/queue-run.js -- npm test",
			/vitest launch, whose queue is run-vitest\.js's `--queue`/,
		],
	])("refuses %s before it queues", async (command, why) => {
		const f = fixture();
		expect(await main(["--", ...command.split(" ")], f.options())).toBe(2);
		expect(f.err.join("")).toMatch(why);
		expect(f.readMarkers()).toEqual([]);
		expect(f.spawned).toEqual([]);
		expect(f.readLog()).toEqual([]);
	});

	it("as a program, exits 2 on a refusal and names the queue to use", async () => {
		const { dir } = fixture();
		const r = await runInProcessAsync(PROGRAM, ["--", "npm", "run", "test"], {
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			},
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/run-vitest\.js's `--queue`/);
	});

	describe("--seat, one part-suite wait for a whole mutation loop (#2918)", () => {
		it("waits once as a part-suite and hands the driver its seat", async () => {
			const f = fixture();
			const weights: unknown[] = [];
			const done = main(
				["--seat", "--", "python3", "mutate.py"],
				f.options({
					gate: undefined,
					gateRead: (_command: string, weight: unknown) => {
						weights.push(weight);
						return null;
					},
				}),
			);
			await tick();
			expect(weights).toEqual([{ resolvedFiles: 1, wholeSlot: false }]);
			const [marker] = f.readMarkers();
			const file = path.join(f.dir, marker);
			expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
				part: true,
			});
			expect(f.spawned[0]).toMatchObject({
				command: "python3",
				args: ["mutate.py"],
			});
			expect(f.spawned[0].opts.env?.WFC_SUITE_SEAT).toBe(file);
			f.spawned[0].child.emit("spawn");
			f.spawned[0].child.emit("exit", 0, null);
			expect(await done).toBe(0);
			expect(f.readMarkers()).toEqual([]);
			expect(f.readLog()).toEqual([
				expect.objectContaining({ reason: "opened", kind: "seat" }),
			]);
		});

		it("runs at the bound a wait only the count cap holds, as a part-suite does", async () => {
			const f = fixture();
			main(
				["--seat", "--", "node", "mutate.js"],
				f.options({ gate: () => ({ limb: "count" }), timeoutMs: -1 }),
			);
			await tick();
			expect(f.spawned).toHaveLength(1);
		});

		it.each([["pytest"], ["npm run test"], ["node --test a.test.js"]])(
			"refuses %s, a suite itself, before it queues",
			async (command) => {
				const f = fixture();
				expect(
					await main(["--seat", "--", ...command.split(" ")], f.options()),
				).toBe(2);
				expect(f.err.join("")).toMatch(/is a suite itself/);
				expect(f.readMarkers()).toEqual([]);
				expect(f.spawned).toEqual([]);
			},
		);
	});
	describe("a command naming its test files, a part-suite (#5274, spec #5273 §7)", () => {
		/* The weight the queue's poll asks the gate with, and the marker it
		 * joins with, for `command`. */
		const joinOf = async (command: string[]) => {
			const f = fixture();
			const weights: unknown[] = [];
			main(
				["--", ...command],
				f.options({
					gate: undefined,
					gateRead: (_command: string, weight: unknown) => {
						weights.push(weight);
						return null;
					},
				}),
			);
			await tick();
			const [marker] = f.readMarkers();
			return {
				weights,
				marker: JSON.parse(
					fs.readFileSync(path.join(f.dir, marker as string), "utf8"),
				),
			};
		};

		it.each([
			["pytest", "tests/test_a.py"],
			["python3", "-m", "unittest", "tests.test_a"],
			["node", "--test", "a.test.js"],
		])(
			"joins and polls %s as a part-suite, its file count unread so the rung charges a whole suite's workers",
			async (...command) => {
				const { weights, marker } = await joinOf(command);
				expect(weights).toEqual([{ resolvedFiles: null, wholeSlot: false }]);
				expect(marker.part).toBe(true);
				expect(marker.files).toBeUndefined();
				expect(
					weighCarried(
						weights[0] as { resolvedFiles: number | null; wholeSlot: boolean },
					).workers,
				).toBe(WHOLE_SUITE_WORKERS);
			},
		);

		it("still joins a run naming no file whole", async () => {
			const { weights, marker } = await joinOf(["pytest"]);
			expect(weights).toEqual([null]);
			expect(marker.part).toBeUndefined();
		});

		it("runs at the bound a wait only the count cap holds, as a part-suite does", async () => {
			const f = fixture();
			main(
				["--", "pytest", "tests/test_a.py"],
				f.options({ gate: () => ({ limb: "count" }), timeoutMs: -1 }),
			);
			await tick();
			expect(f.spawned).toHaveLength(1);
		});
	});

	describe("--gate, a commit gate's seat in the whole-suite slot (#5274)", () => {
		const parentOf = (pid: number) => (pid > 10 ? pid - 10 : 0);
		const gateRun = ["--gate", "--", "bash test/all.sh"];
		const gateOptions = (f: ReturnType<typeof fixture>, extra: object = {}) => {
			const gateLog = path.join(f.dir, "gate-runs.jsonl");
			return {
				gateLog,
				readGates: () => {
					const read = readText(gateLog);
					return read.state === "read"
						? read.data
								.split("\n")
								.filter(Boolean)
								.map((l: string) => JSON.parse(l))
						: [];
				},
				options: f.options({
					gateLog,
					gateChargeMb: 2100,
					ticket: 77,
					inSuite: () => false,
					...extra,
				}),
			};
		};

		it("joins whole, as role gate, and hands its command the seat in WFC_GATE_SEAT", async () => {
			const f = fixture();
			const g = gateOptions(f);
			const done = main(gateRun, g.options);
			await tick();
			const [marker] = f.readMarkers();
			const file = path.join(f.dir, marker as string);
			const record = JSON.parse(fs.readFileSync(file, "utf8"));
			expect(record).toMatchObject({
				role: "gate",
				chargeMb: 2100,
				session: "s1",
				command: "bash test/all.sh",
			});
			expect(record.part).toBeUndefined();
			expect(f.spawned[0]).toMatchObject({
				command: "sh",
				args: ["-c", "bash test/all.sh"],
			});
			expect(f.spawned[0].opts.env?.WFC_GATE_SEAT).toBe(file);
			expect(f.spawned[0].opts).toMatchObject({ detached: true });
			f.spawned[0].child.emit("spawn");
			f.spawned[0].child.emit("exit", 0, null);
			expect(await done).toBe(0);
			expect(f.readMarkers()).toEqual([]);
			expect(f.readLog()).toEqual([
				expect.objectContaining({ reason: "opened", kind: "gate" }),
			]);
			expect(g.readGates()).toEqual([
				expect.objectContaining({
					command: "bash test/all.sh",
					session: "s1",
					ticket: 77,
					outcome: "pass",
					peakTreeMb: 0,
				}),
			]);
		});

		/* A host sleep steps the wall clock on resume and leaves CLOCK_MONOTONIC
		 * where it was. The two clocks are spied, not injected: what is under test is the
		 * default clock, which an injected `monoClock` would replace (§X2). */
		it("records its wait and run on the monotonic clock, counting no host sleep (#5446)", async () => {
			let wallMs = Date.now();
			let monoMs = 1_000_000;
			const sleep = (awakeMs: number) => {
				wallMs += 8 * 3_600_000;
				monoMs += awakeMs;
			};
			vi.spyOn(Date, "now").mockImplementation(() => wallMs);
			vi.spyOn(process.hrtime, "bigint").mockImplementation(() =>
				BigInt(monoMs * 1_000_000),
			);
			try {
				const f = fixture();
				let denials = 1;
				const g = gateOptions(f, {
					gate: () =>
						denials-- > 0 ? { limb: "memory", mb: 100, rungMb: 3350 } : false,
					sleepFn: () => {
						sleep(30_000);
						return Promise.resolve();
					},
				});
				const done = main(gateRun, g.options);
				await tick();
				expect(f.spawned).toHaveLength(1);
				f.spawned[0].child.emit("spawn");
				sleep(60_000);
				f.spawned[0].child.emit("exit", 0, null);
				expect(await done).toBe(0);
				expect(f.readLog()).toEqual([
					expect.objectContaining({ reason: "opened", waitS: 30 }),
				]);
				expect(g.readGates()).toEqual([
					expect.objectContaining({ waitS: 30, runS: 60, outcome: "pass" }),
				]);
			} finally {
				vi.restoreAllMocks();
			}
		});

		it("takes the command by its role, never the classifier", async () => {
			const f = fixture();
			const g = gateOptions(f);
			main(["--gate", "--", "npm", "run", "test"], g.options);
			await tick();
			expect(f.spawned).toHaveLength(1);
		});

		it("is never refused at the queue's bound, keeping its place", async () => {
			const f = fixture();
			const g = gateOptions(f, {
				gate: () => ({ limb: "memory", mb: 100, rungMb: 3350 }),
				timeoutMs: -1,
			});
			main(gateRun, g.options);
			await tick();
			expect(f.spawned).toEqual([]);
			expect(f.err.join("")).not.toMatch(/refused/);
			expect(f.readMarkers()).toHaveLength(1);
		});

		it("prints its place on joining and each time it changes", async () => {
			const f = fixture();
			const holder = path.join(f.dir, "wfc-suite-queue-20.json");
			fs.writeFileSync(
				holder,
				JSON.stringify({
					pid: 20,
					at: 0,
					spawned: true,
					role: "gate",
					repo: "design-vault",
					session: "s9",
					command: "bash test/all.sh",
				}),
			);
			let polls = 0;
			const g = gateOptions(f, {
				alive: () => true,
				gate: () => ({ limb: "count" }),
				sleepFn: () => {
					polls += 1;
					if (polls === 2) fs.rmSync(holder);
					return polls < 4 ? Promise.resolve() : new Promise(noop);
				},
			});
			main(gateRun, g.options);
			for (let i = 0; i < 6; i++) await tick();
			const places = f.err
				.join("")
				.split("\n")
				.filter((l) => l.includes("position"));
			expect(places).toHaveLength(2);
			expect(places[0]).toMatch(
				/position 2 for the whole-suite slot, held by design-vault, session s9 \(pid 20\), waited \d+s/,
			);
			expect(places[1]).toMatch(
				/position 1 for the whole-suite slot, slot free/,
			);
		});

		describe("a short gate, a part-suite on its record (#5450)", () => {
			const run = (runS: number, peakTreeMb: number, outcome = "pass") => ({
				repo: gateRepoName(),
				command: "bash test/all.sh",
				outcome,
				runS,
				peakTreeMb,
			});
			/* Seats a gate while a whole suite holds the slot, its record
			 * `runs`, and returns its marker and whether it started. */
			const seatBeside = async (runs: object[]) => {
				const f = fixture();
				fs.writeFileSync(
					path.join(f.dir, "wfc-suite-queue-20.json"),
					JSON.stringify({ pid: 20, at: 0, spawned: true }),
				);
				const peaks: number[] = [];
				const g = gateOptions(f, {
					alive: () => true,
					gate: () => ({ limb: "count" }),
					shortGate: (_climbMb: number, peakMb: number) => {
						peaks.push(peakMb);
						return null;
					},
					sleepFn: () => new Promise(noop),
				});
				fs.writeFileSync(
					g.gateLog,
					runs.map((r) => `${JSON.stringify(r)}\n`).join(""),
				);
				main(gateRun, g.options);
				await tick();
				const mine = f
					.readMarkers()
					.find((m: string) => m !== "wfc-suite-queue-20.json");
				return {
					marker: JSON.parse(
						fs.readFileSync(path.join(f.dir, mine as string), "utf8"),
					),
					started: f.spawned.length === 1,
					peaks,
				};
			};
			const five = [
				run(20, 120),
				run(34, 189),
				run(21, 90),
				run(60, 150),
				run(19, 80),
			];

			it("starts beside a whole suite, charged the highest of its last 5 peaks", async () => {
				const { marker, started, peaks } = await seatBeside(five);
				expect(started).toBe(true);
				expect(marker).toMatchObject({
					role: "gate",
					part: true,
					chargeMb: 189,
				});
				expect(peaks).toEqual([189]);
			});

			it.each([
				["4 records", five.slice(1)],
				["5 records, one at 61 s", [...five.slice(1), run(61, 100)]],
				[
					"a slower run of another command",
					[...five.slice(1), { ...run(20, 100), command: "other" }],
				],
			])("waits whole on %s", async (_what, runs) => {
				const { marker, started } = await seatBeside(runs);
				expect(started).toBe(false);
				expect(marker.part).toBeUndefined();
				expect(marker.chargeMb).toBe(2100);
			});

			it("leaves a `ceiling` outcome out of the 5", async () => {
				const { marker, started } = await seatBeside([
					...five.slice(0, 4),
					run(840, 3000, "ceiling"),
					five[4] as object,
				]);
				expect(started).toBe(true);
				expect(marker.chargeMb).toBe(189);
			});
		});

		it("kills its command at the suite ceiling and reads red", async () => {
			const f = fixture();
			const fired: (() => void)[] = [];
			const g = gateOptions(f, {
				schedule: (onCeiling: () => void) => {
					fired.push(onCeiling);
					return () => fired.length;
				},
			});
			const done = main(gateRun, g.options);
			await tick();
			f.spawned[0].child.emit("spawn");
			for (const fire of fired) fire();
			f.spawned[0].child.emit("exit", null, "SIGKILL");
			expect(await done).toBe(1);
			expect(f.err.join("")).toMatch(/SUITE CEILING/);
			expect(g.readGates()).toEqual([
				expect.objectContaining({ outcome: "ceiling" }),
			]);
		});

		it.each([
			[1, null, "red", 1],
			[null, "SIGTERM", "killed", 143],
		])(
			"records an exit of %s / %s as %s",
			async (code, signal, outcome, status) => {
				const f = fixture();
				const g = gateOptions(f);
				const done = main(gateRun, g.options);
				await tick();
				f.spawned[0].child.emit("spawn");
				f.spawned[0].child.emit("exit", code, signal);
				expect(await done).toBe(status);
				expect(g.readGates()).toEqual([expect.objectContaining({ outcome })]);
			},
		);

		it("records its tree's PSS peak, sampled from spawn", async () => {
			const f = fixture();
			const samples = [300 * 1024, 900 * 1024, 500 * 1024];
			const g = gateOptions(f, {
				treeSample: () => ({ kb: samples.shift() ?? 0, pids: [] }),
				sampleMs: 1,
			});
			const done = main(gateRun, g.options);
			await tick();
			Object.assign(f.spawned[0].child, { pid: 1 });
			f.spawned[0].child.emit("spawn");
			await vi.waitFor(() => expect(samples).toHaveLength(0));
			f.spawned[0].child.emit("exit", 0, null);
			await done;
			expect(g.readGates()[0].peakTreeMb).toBe(900);
			expect(f.err.join("")).not.toMatch(/would not read/);
		});

		it("names its unread tree samples, its recorded peak a floor", async () => {
			const f = fixture();
			let reads = 0;
			const g = gateOptions(f, {
				treeSample: () => {
					reads += 1;
					throw new Error("EACCES");
				},
				sampleMs: 1,
			});
			const done = main(gateRun, g.options);
			await tick();
			Object.assign(f.spawned[0].child, { pid: 1 });
			f.spawned[0].child.emit("spawn");
			await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
			f.spawned[0].child.emit("exit", 0, null);
			await done;
			expect(g.readGates()[0].peakTreeMb).toBe(0);
			expect(f.err.join("")).toMatch(
				/tree samples would not read \(EACCES\), so its recorded peakTreeMb is a floor/,
			);
		});

		it("records each tree sample's pids on the seat's pid record, ended on exit (#5269)", async () => {
			const f = fixture();
			const gatePidsDir = path.join(f.dir, "run-memory");
			let reads = 0;
			const g = gateOptions(f, {
				gatePidsDir,
				treeSample: () => {
					reads += 1;
					return { kb: 0, pids: [1, 50 + reads] };
				},
				sampleMs: 1,
			});
			const done = main(gateRun, g.options);
			await tick();
			Object.assign(f.spawned[0].child, { pid: 1 });
			f.spawned[0].child.emit("spawn");
			await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
			f.spawned[0].child.emit("exit", 0, null);
			await done;
			const { seats } = readGatePids(gatePidsDir);
			expect(seats).toEqual([
				expect.objectContaining({
					command: "bash test/all.sh",
					session: "s1",
					sampleMs: 1,
					endedAt: expect.any(String),
				}),
			]);
			expect(Object.keys(seats[0].seenAt)).toEqual(
				expect.arrayContaining(["1", "51", "52"]),
			);
		});

		it("runs a launch inside a gate seat's tree at once, in the seat's slot", async () => {
			const f = fixture();
			const outer = path.join(f.dir, "wfc-suite-queue-20.json");
			fs.writeFileSync(
				outer,
				JSON.stringify({ pid: 20, at: 0, role: "gate", spawned: true }),
			);
			const done = main(
				["--", "node", "--test", "a.test.js"],
				f.options({
					env: { WFC_GATE_SEAT: outer },
					pid: 40,
					parentOf: (pid: number) => (pid > 10 ? pid - 10 : 1),
					alive: () => true,
					gate: () => ({ limb: "count" }),
				}),
			);
			await tick();
			expect(f.spawned).toHaveLength(1);
			expect(f.readMarkers()).toEqual(["wfc-suite-queue-20.json"]);
			f.spawned[0].child.emit("exit", 0, null);
			expect(await done).toBe(0);
		});

		/* A nested --gate once spawned its joined words as one program name and
		 * died ENOENT (#5296); its pair, the unnested gate, is "joins whole, as
		 * role gate" above. */
		it("runs a --gate launch inside a gate seat's tree as the one shell string a gate's command is", async () => {
			const f = fixture();
			const outer = path.join(f.dir, "wfc-suite-queue-20.json");
			fs.writeFileSync(
				outer,
				JSON.stringify({ pid: 20, at: 0, role: "gate", spawned: true }),
			);
			const done = main(
				["--gate", "--", "sh stub.sh"],
				f.options({
					env: { WFC_GATE_SEAT: outer },
					pid: 40,
					parentOf: (pid: number) => (pid > 10 ? pid - 10 : 1),
					alive: () => true,
					gate: () => ({ limb: "count" }),
				}),
			);
			await tick();
			expect(f.spawned.map((s) => [s.command, s.args])).toEqual([
				["sh", ["-c", "sh stub.sh"]],
			]);
			f.spawned[0].child.emit("exit", 0, null);
			expect(await done).toBe(0);
		});

		it("runs at once inside a running suite's tree, joining no queue, and is still recorded", async () => {
			const f = fixture();
			const g = gateOptions(f, {
				inSuite: () => true,
				gate: () => ({ limb: "count" }),
			});
			const done = main(gateRun, g.options);
			await tick();
			expect(f.readMarkers()).toEqual([]);
			expect(f.spawned).toHaveLength(1);
			f.spawned[0].child.emit("spawn");
			f.spawned[0].child.emit("exit", 0, null);
			expect(await done).toBe(0);
			expect(g.readGates()).toEqual([
				expect.objectContaining({ outcome: "pass", waitS: 0 }),
			]);
		});

		it("reads a suite runner among its ancestors as inside a suite", () => {
			const { isInSuite } = require("./lib/gate-seat.js");
			const args: Record<number, string> = {
				30: "sh -c bash test/all.sh",
				20: "node /x/node_modules/.bin/vitest run",
				10: "bash",
			};
			const argsOf = (pid: number) => args[pid] ?? "";
			expect(isInSuite({ pid: 40, parentOf, argsOf })).toBe(true);
			args[20] = "node scripts/commit-paths.js -m x -- a";
			expect(isInSuite({ pid: 40, parentOf, argsOf })).toBe(false);
			args[20] = "python3 -m pytest scripts";
			expect(isInSuite({ pid: 40, parentOf, argsOf })).toBe(true);
		});

		it("reads each runner ancestor's declared suiteRunners off that ancestor, not the host (#5303)", () => {
			const { isInSuite } = require("./lib/gate-seat.js");
			const args: Record<number, string> = {
				30: "sh -c bash test/all.sh",
				20: "node scripts/run-all.js",
			};
			const asked: number[] = [];
			const runnersOf = (pid: number) => {
				asked.push(pid);
				return pid === 20 ? ["scripts/run-all.js"] : [];
			};
			const argsOf = (pid: number) => args[pid] ?? "";
			expect(isInSuite({ pid: 40, parentOf, argsOf, runnersOf })).toBe(true);
			expect(asked).toEqual([20]);
			expect(
				isInSuite({ pid: 40, parentOf, argsOf, runnersOf: () => [] }),
			).toBe(false);
		});

		describe("off the real /proc and config reads (#5303)", () => {
			/* The suite's own checkout declares its runner; the commit happens in
			 * a fixture repo the pre-commit hook points CLAUDE_PROJECT_DIR at,
			 * which declares none. */
			const world = () => {
				const base = mkScratchDir("gate-ancestor-");
				dirs.push(base);
				const repo = (name: string, config: object) => {
					const root = path.join(base, name);
					fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
					fs.writeFileSync(
						path.join(root, ".claude", "workflow-core.json"),
						JSON.stringify({ contract: 1, ...config }),
					);
					expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(
						0,
					);
					return root;
				};
				const host = repo("host", { suiteRunners: ["scripts/run-all.js"] });
				const fixtureRepo = repo("fixture", {});
				const proc = path.join(base, "proc");
				const processAt = (pid: number, argv: string[], cwd: string) => {
					fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
					fs.writeFileSync(
						path.join(proc, String(pid), "cmdline"),
						`${argv.join("\0")}\0`,
					);
					writeCwd(proc, String(pid), cwd);
				};
				processAt(30, ["sh", "-c", "bash test/all.sh"], fixtureRepo);
				processAt(10, ["bash"], host);
				vi.stubEnv("WFC_PROC", proc);
				vi.stubEnv("CLAUDE_PROJECT_DIR", fixtureRepo);
				return { host, fixtureRepo, processAt };
			};

			it("takes no seat under the host's declared runner, the commit in another repo", async () => {
				const w = world();
				w.processAt(20, ["node", "scripts/run-all.js"], w.host);
				const f = fixture();
				const g = gateOptions(f, {
					inSuite: undefined,
					pid: 40,
					parentOf,
					gate: () => ({ limb: "count" }),
				});
				const done = main(gateRun, g.options);
				await tick();
				expect(f.readMarkers()).toEqual([]);
				expect(f.spawned).toHaveLength(1);
				f.spawned[0].child.emit("spawn");
				f.spawned[0].child.emit("exit", 0, null);
				expect(await done).toBe(0);
			});

			it("takes a seat with the gate variable set but no runner above it", async () => {
				const w = world();
				w.processAt(20, ["node", "scripts/commit-paths.js"], w.host);
				w.processAt(99, ["node", "scripts/run-all.js"], w.host);
				const f = fixture();
				const outer = path.join(f.dir, "wfc-suite-queue-99.json");
				fs.writeFileSync(
					outer,
					JSON.stringify({ pid: 99, at: 0, role: "gate", spawned: true }),
				);
				const g = gateOptions(f, {
					inSuite: undefined,
					env: { WFC_GATE_SEAT: outer },
					pid: 40,
					parentOf,
					alive: () => true,
					gate: () => ({ limb: "count" }),
				});
				main(gateRun, g.options);
				await tick();
				expect(f.spawned).toHaveLength(0);
				expect(f.readMarkers()).toContain("wfc-suite-queue-40.json");
			});
		});

		it("refuses --gate beside another slot flag", async () => {
			const f = fixture();
			expect(
				await main(["--gate", "--seat", "--", "sh", "-c", "x"], f.options()),
			).toBe(2);
			expect(f.err.join("")).toMatch(/give one/);
		});
	});
	describe("--tsc, the machine-wide type-check slot (#3163)", () => {
		const typecheck = ["--tsc", "--", "sh", "-c", "tsc --noEmit"];
		beforeEach(() => {
			vi.stubEnv("WFC_TSC_SLOT", undefined);
		});

		/** The machine the real gate reads: `ps` lines and MemAvailable. */
		const machine = (dir: string, lines: string[], mb: number) => {
			vi.stubEnv("WFC_PS", writePsStub(dir, lines, { name: "ps-tsc" }));
			const meminfo = path.join(dir, "meminfo");
			fs.writeFileSync(meminfo, `MemAvailable:    ${mb * 1024} kB\n`);
			vi.stubEnv("WFC_MEMINFO", meminfo);
		};

		/** The fixture's options less its injected turn and gate, so the
		 * slot's own queue and gate decide. */
		const own = (f: ReturnType<typeof fixture>, extra: object = {}) => {
			const { turn: _turn, gate: _gate, ...rest } = f.options(extra);
			return rest;
		};

		it("waits, visibly, while a `tsc` is running, naming its PID, then runs nothing", async () => {
			const f = fixture();
			machine(f.dir, ["4242 node /r/node_modules/.bin/tsc --noEmit"], 9000);
			const out: string[] = [];
			main(typecheck, own(f, { out: { write: (s: string) => out.push(s) } }));
			await tick();
			expect(f.spawned).toEqual([]);
			expect(out).toEqual([
				`queue-run.js: waiting for the type-check slot: a \`tsc\` running, a suite starting (#3203), or MemAvailable, less what a climbing suite has yet to draw (#3416), under its ~${tscRung} MB rung, or Windows' own free memory under what it draws (#4557)\n`,
				"queue-run.js: after 0s, held on the count cap, PID 4242\n",
			]);
		});

		it("waits, visibly, while MemAvailable is under its rung", async () => {
			const f = fixture();
			machine(f.dir, ["bash -l"], 1000);
			const out: string[] = [];
			main(typecheck, own(f, { out: { write: (s: string) => out.push(s) } }));
			await tick();
			expect(f.spawned).toEqual([]);
			expect(out).toEqual([
				`queue-run.js: waiting for the type-check slot: a \`tsc\` running, a suite starting (#3203), or MemAvailable, less what a climbing suite has yet to draw (#3416), under its ~${tscRung} MB rung, or Windows' own free memory under what it draws (#4557)\n`,
				`queue-run.js: after 0s, held on the memory rung, MemAvailable 1000 MB against ~${tscRung} MB\n`,
			]);
		});

		it("refuses at the bound a launch under its rung, naming the rung", async () => {
			const f = fixture();
			machine(f.dir, ["bash -l"], 1000);
			const out: string[] = [];
			const code = await main(
				typecheck,
				own(f, {
					timeoutMs: -1,
					out: { write: (s: string) => out.push(s) },
				}),
			);
			expect(code).toBe(1);
			expect(f.spawned).toEqual([]);
			expect(out.join("")).toMatch(
				new RegExp(`MemAvailable 1000 MB against the ~${tscRung} MB rung`),
			);
			expect(f.readLog()).toEqual([
				expect.objectContaining({
					reason: "refused",
					kind: "tsc",
					limb: "memory",
				}),
			]);
		});

		it("admits a TypeScript 7 launch on its own rung, logging its charge (#4892)", async () => {
			const f = fixture();
			const mb = rungMb(TSC7_PEAK_MB);
			expect(mb).toBeLessThan(tscRung);
			machine(f.dir, ["bash -l"], mb);
			main(typecheck, own(f, { tscPeakMb: TSC7_PEAK_MB }));
			await tick();
			expect(f.spawned).toHaveLength(1);
			expect(f.readLog()).toEqual([
				expect.objectContaining({
					reason: "opened",
					kind: "tsc",
					chargeMb: TSC7_PEAK_MB,
				}),
			]);
		});

		it("logs a killed waiter's charge, the replay's rung for it (#4921)", async () => {
			const f = fixture();
			const exits: number[] = [];
			machine(f.dir, ["node /r/node_modules/.bin/tsc --noEmit"], 9000);
			main(
				typecheck,
				own(f, {
					tscPeakMb: TSC7_PEAK_MB,
					exit: (c: number) => exits.push(c),
				}),
			);
			await tick();
			f.signals.emit("SIGINT");
			expect(exits).toEqual([130]);
			expect(f.readLog()).toEqual([
				expect.objectContaining({
					reason: "killed",
					kind: "tsc",
					chargeMb: TSC7_PEAK_MB,
				}),
			]);
		});

		describe("under WFC_TSC_NO_WAIT, one try at the slot (#3278)", () => {
			beforeEach(() => {
				vi.stubEnv("WFC_TSC_NO_WAIT", "1");
			});

			it.each([
				["a `tsc` running", ["node /r/node_modules/.bin/tsc --noEmit"], 9000],
				["MemAvailable under its rung", ["bash -l"], 1000],
			])(
				"exits 75 at once, running nothing and leaving the queue, with %s",
				async (_held, lines, mb) => {
					const f = fixture();
					machine(f.dir, lines, mb);
					const out: string[] = [];
					const code = await main(
						typecheck,
						own(f, { out: { write: (s: string) => out.push(s) } }),
					);
					expect(code).toBe(75);
					expect(f.spawned).toEqual([]);
					expect(f.readMarkers()).toEqual([]);
					expect(out).toEqual([]);
					expect(f.err.join("")).toBe(
						"queue-run.js: the type-check slot is held, by a `tsc` running, a suite starting (#3203) or MemAvailable, less what a climbing suite has yet to draw (#3416), under its rung — not run, as WFC_TSC_NO_WAIT asks (#3278)\n",
					);
				},
			);

			it("marks its exit line as a try, held or admitted (#3803)", async () => {
				const held = fixture();
				machine(held.dir, ["node /r/node_modules/.bin/tsc --noEmit"], 9000);
				await main(typecheck, own(held));
				expect(held.readLog()).toEqual([
					expect.objectContaining({ reason: "refused", noWait: true }),
				]);

				const free = fixture();
				machine(free.dir, ["bash -l"], 9000);
				main(typecheck, own(free));
				await tick();
				expect(free.readLog()).toEqual([
					expect.objectContaining({ reason: "opened", noWait: true }),
				]);
			});

			it("exits 75 at once, never sleeping a poll, where a rival is admitted on the same poll", async () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				// The rival's admission lands between this waiter's turn and its own.
				const turn = () => {
					fs.writeFileSync(
						path.join(f.dir, "wfc-suite-queue-999999.json"),
						JSON.stringify({ pid: 999_999, at: 0, admitted: true }),
					);
					return true;
				};
				const code = await main(typecheck, {
					...own(f, { alive: () => true }),
					turn,
				});
				expect(code).toBe(75);
				expect(f.spawned).toEqual([]);
			});

			it("runs the type-check where the slot is free", async () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				const code = main(typecheck, own(f));
				await tick();
				expect(f.spawned).toHaveLength(1);
				f.spawned[0].child.emit("exit", 0, null);
				expect(await code).toBe(0);
			});

			/* A suite admitted and not yet up is a draw MemAvailable does not
			 * count yet (#3203). */
			it("exits 75 while a suite is starting, and runs once it is up", async () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				vi.stubEnv("TMPDIR", f.dir);
				const suites = path.join(f.dir, "wfc-suite-queue");
				fs.mkdirSync(suites);
				const suite = path.join(suites, `wfc-suite-queue-${process.ppid}.json`);
				fs.writeFileSync(
					suite,
					JSON.stringify({ pid: process.ppid, at: 0, admitted: true }),
				);
				const opts = own(f, { queueDir: undefined, alive: () => true });
				expect(await main(typecheck, opts)).toBe(75);
				expect(f.spawned).toEqual([]);
				fs.writeFileSync(
					suite,
					JSON.stringify({
						pid: process.ppid,
						at: 0,
						admitted: true,
						spawned: true,
					}),
				);
				main(typecheck, opts);
				await tick();
				expect(f.spawned).toHaveLength(1);
			});
		});

		it("runs two type-checks one after the other", async () => {
			const f = fixture();
			machine(f.dir, ["bash -l"], 9000);
			let wake: () => void = noop;
			const out: string[] = [];
			const opts = (pid: number) =>
				own(f, {
					pid,
					alive: () => true,
					sleepFn: () =>
						new Promise<void>((r) => {
							wake = r;
						}),
					out: { write: (s: string) => out.push(`${pid}: ${s}`) },
				});
			const first = main(typecheck, opts(101));
			await tick();
			expect(f.spawned).toHaveLength(1);
			f.spawned[0].child.emit("spawn");
			const second = main(typecheck, opts(102));
			await tick();
			expect(f.spawned).toHaveLength(1);
			expect(out).toEqual([
				`102: queue-run.js: waiting for the type-check slot: a \`tsc\` running, a suite starting (#3203), or MemAvailable, less what a climbing suite has yet to draw (#3416), under its ~${tscRung} MB rung, or Windows' own free memory under what it draws (#4557)\n`,
				"102: queue-run.js: after 0s, held on the waiters ahead, PID 101\n",
			]);
			f.spawned[0].child.emit("exit", 0, null);
			expect(await first).toBe(0);
			wake();
			await tick();
			expect(f.spawned).toHaveLength(2);
			expect(out.at(-1)).toMatch(
				/^102: queue-run\.js: gate opened after \d+s — held \d+s on the waiters ahead\n$/,
			);
			f.spawned[1].child.emit("spawn");
			f.spawned[1].child.emit("exit", 0, null);
			expect(await second).toBe(0);
		});

		it("queues apart from the suites, so a waiting suite never holds it", async () => {
			const f = fixture();
			machine(f.dir, ["bash -l"], 9000);
			vi.stubEnv("TMPDIR", f.dir);
			const suites = path.join(f.dir, "wfc-suite-queue");
			fs.mkdirSync(suites);
			fs.writeFileSync(
				path.join(suites, `wfc-suite-queue-${process.ppid}.json`),
				JSON.stringify({ pid: process.ppid, at: 0 }),
			);
			main(typecheck, own(f, { queueDir: undefined }));
			await tick();
			expect(f.spawned).toHaveLength(1);
			expect(fs.readdirSync(path.join(f.dir, "wfc-tsc-queue"))).toEqual([
				`wfc-suite-queue-${process.pid}.json`,
			]);
		});

		describe("nested in a `--tsc` launch's own command (#3404)", () => {
			const marker = (dir: string, pid: number) => {
				const file = path.join(dir, `wfc-suite-queue-${pid}.json`);
				fs.writeFileSync(
					file,
					JSON.stringify({ pid, at: 0, admitted: true, spawned: true }),
				);
				return file;
			};

			it("hands its command its marker in WFC_TSC_SLOT", async () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				main(typecheck, own(f));
				await tick();
				expect(f.spawned[0].opts.env?.WFC_TSC_SLOT).toBe(
					path.join(f.dir, `wfc-suite-queue-${process.pid}.json`),
				);
			});

			it("runs at once where its ancestor's marker is not yet stamped spawned", async () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				const outer = path.join(f.dir, "wfc-suite-queue-20.json");
				fs.writeFileSync(
					outer,
					JSON.stringify({ pid: 20, at: 0, admitted: true }),
				);
				main(
					typecheck,
					own(f, {
						env: { WFC_TSC_SLOT: outer },
						pid: 30,
						parentOf: () => 20,
						alive: () => true,
					}),
				);
				await tick();
				expect(f.spawned).toHaveLength(1);
			});

			it("runs at once, joining no queue, where an ancestor holds the slot", async () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				const outer = marker(f.dir, 20);
				/* 40 → 30 → 20: the launch is 40, the slot's holder 20. */
				const code = main(
					typecheck,
					own(f, {
						env: { WFC_TSC_SLOT: outer },
						pid: 40,
						parentOf: (pid: number) => (pid > 10 ? pid - 10 : 1),
						alive: () => true,
					}),
				);
				await tick();
				expect(f.spawned).toHaveLength(1);
				expect(f.spawned[0].opts.env).toBeUndefined();
				expect(f.readMarkers()).toEqual(["wfc-suite-queue-20.json"]);
				f.spawned[0].child.emit("spawn");
				f.spawned[0].child.emit("exit", 4, null);
				expect(await code).toBe(4);
				expect(f.readMarkers()).toEqual(["wfc-suite-queue-20.json"]);
				expect(f.readLog()).toEqual([]);
			});

			it("still waits behind another session's admitted ticket its variable names", async () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				const other = marker(f.dir, 999_999);
				main(
					typecheck,
					own(f, { env: { WFC_TSC_SLOT: other }, alive: () => true }),
				);
				await tick();
				expect(f.spawned).toEqual([]);
				expect(f.readMarkers()).toHaveLength(2);
			});

			it("as a program, runs `queue-run.js --tsc` inside its own command once and exits", () => {
				const f = fixture();
				machine(f.dir, ["bash -l"], 9000);
				const inner = `node ${PROGRAM} --tsc -- node -e "process.exit(7)"`;
				const { WFC_TSC_SLOT: _held, ...env } = process.env;
				const r = keptSpawn("concurrent").spawnSync(
					"node",
					[PROGRAM, "--tsc", "--", "sh", "-c", inner],
					{
						encoding: "utf8",
						/* A deadlock never exits; the bound fails it rather than hang
						 * the suite. 20 s is far above the ~0.5 s a pass takes. */
						timeout: 20_000,
						env: {
							...env,
							TMPDIR: f.dir,
							CLAUDE_PROJECT_DIR: f.dir,
							CLAUDE_CONFIG_DIR: path.join(f.dir, "config"),
						},
					},
				);
				expect(r.status).toBe(7);
				expect(fs.readdirSync(path.join(f.dir, "wfc-tsc-queue"))).toEqual([]);
			});
		});

		it.each([["npm run test"], ["pytest"]])(
			"refuses %s, a suite, before it queues",
			async (command) => {
				const f = fixture();
				expect(
					await main(["--tsc", "--", ...command.split(" ")], f.options()),
				).toBe(2);
				expect(f.err.join("")).toMatch(/--tsc holds the type-check slot/);
				expect(f.spawned).toEqual([]);
			},
		);

		it("refuses --seat beside it", async () => {
			const f = fixture();
			expect(
				await main(["--seat", "--tsc", "--", "node", "x.js"], f.options()),
			).toBe(2);
			expect(f.err.join("")).toMatch(/hold different slots/);
		});
	});
});
