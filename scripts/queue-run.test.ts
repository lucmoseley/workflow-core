// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readText } from "./lib/file-read.js";
import {
	defineTemplate,
	emptyRepoTemplate,
	mkScratchDir,
} from "./lib/git-fixture";
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
const { readStartTimeOf } = require("./lib/suite-queue.js");
const { readRunFiles } = require("./lib/run-memory.js");
const { armTripwire, gateTripwire } = require("./lib/peak-tripwire.js");
const PROGRAM = path.resolve(__dirname, "queue-run.js");

const dirs: string[] = [];
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
		tscPeakMb: TSC_PEAK_MB,
		gate: () => false,
		turn: () => true,
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

const fakeStream = () =>
	Object.assign(new EventEmitter(), { setEncoding: noop });

class FakeChild extends EventEmitter {
	killed: string[] = [];
	stdout = fakeStream();
	stderr = fakeStream();
	kill(signal: string) {
		this.killed.push(signal);
		return true;
	}
	override emit(event: string | symbol, ...args: unknown[]) {
		const heard = super.emit(event, ...args);
		if (event === "exit") super.emit("close", ...args);
		return heard;
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

	it("stamps its marker with its session, the place the per-session cap counts (#5595)", async () => {
		vi.stubEnv("WFC_LANDER_RUN", "");
		const f = fixture();
		const done = main(["--", "node", "--test", "a.test.js"], f.options());
		await tick();
		const [marker] = f.readMarkers();
		const { session } = JSON.parse(
			fs.readFileSync(path.join(f.dir, marker as string), "utf8"),
		);
		f.spawned[0]?.child.emit("exit", 0, null);
		await done;
		expect(session).toBe("s1");
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

		const capReader = () => {
			const f = fixture();
			const gateLog = path.join(f.dir, "gate-runs.jsonl");
			fs.writeFileSync(
				gateLog,
				[1201, 2340, 565, 577, 900]
					.map(
						(peakTreeMb) =>
							`${JSON.stringify({ repo: gateRepoName(), command: "bash test/all.sh", outcome: "pass", runS: 300, peakTreeMb })}\n`,
					)
					.join(""),
			);
			const caps: unknown[] = [];
			const read = (
				_command: string,
				_weight: unknown,
				_climb: number,
				reads: { capMb?: number },
			) => {
				caps.push(reads.capMb);
				return null;
			};
			return { f, gateLog, caps, read };
		};

		it("hands the gate its repo's measured whole-run peak as the most it is charged (#5802)", async () => {
			const { f, gateLog, caps, read } = capReader();
			main(
				["--", "node", "--test", "a.test.js"],
				f.options({ gate: undefined, gateRead: read, gateLog }),
			);
			await tick();
			expect(caps).toEqual([2340]);
		});

		it("hands a whole native run, alone or chained after a named one, its repo's measured whole-run peak, and a wrapper none (#5877)", async () => {
			const { f, gateLog, caps, read } = capReader();
			const commands = [
				"pytest",
				"python3 -m unittest discover tests",
				"python3 -m unittest discover tests -k name",
				"python3 -m pytest -q tests/",
				"node --test",
				"pytest tests/test_a.py && pytest",
				"npm run test:py -- scripts",
			];
			for (const command of commands) {
				main(
					["--", ...command.split(" ")],
					f.options({ gate: undefined, gateRead: read, gateLog }),
				);
				await tick();
			}
			expect(caps).toEqual([2340, 2340, 2340, 2340, 2340, 2340, undefined]);
		});

		it("records a capped run in the test run store, so a kill beside it trips the peak tripwire (#5812)", async () => {
			const f = fixture();
			const gateLog = path.join(f.dir, "gate-runs.jsonl");
			fs.writeFileSync(
				gateLog,
				[2340, 2340, 2340, 2340, 2340]
					.map(
						(peakTreeMb) =>
							`${JSON.stringify({ repo: gateRepoName(), command: "bash test/all.sh", outcome: "pass", runS: 300, peakTreeMb })}\n`,
					)
					.join(""),
			);
			const runStore = path.join(f.dir, "runs");
			const admitted =
				(capMb?: number) =>
				(
					_c: string,
					_w: unknown,
					_m: number,
					reads: { onAdmission?: (a: object) => void },
				) => {
					reads.onAdmission?.({
						mode: "ladder",
						cause: "unsized",
						rungMb: 3400,
						climbMb: 0,
						...(capMb === undefined ? {} : { capMb }),
					});
					return null;
				};
			const done = main(
				["--", "pytest", "tests/test_a.py"],
				f.options({
					gate: undefined,
					gateRead: admitted(2340),
					gateLog,
					runStore,
				}),
			);
			await tick();
			const child = f.spawned[0].child;
			child.emit("spawn");
			const runs = () => readRunFiles(runStore).runs;
			expect(runs()).toEqual([
				expect.objectContaining({
					session: "s1",
					argv: ["pytest", "tests/test_a.py"],
					mode: "ladder",
					admission: expect.objectContaining({ capMb: 2340 }),
				}),
			]);
			const [run] = runs();
			const killAt = Date.parse(run.at) + 500;
			const tripFile = path.join(f.dir, "peak-tripwire.json");
			armTripwire({ session: "s0", now: killAt - 60_000, file: tripFile });
			expect(
				gateTripwire({
					file: tripFile,
					now: killAt + 1000,
					readIncidents: () => ({
						incidents: [
							{
								kills: [
									{
										at: new Date(killAt).toISOString(),
										pid: 4242,
										name: "python",
										kind: "test run",
										testRun: { role: "worker", kind: "named", repo: "r" },
										rssMiB: 900,
									},
								],
							},
						],
						why: null,
					}),
					readRunFiles: () => readRunFiles(runStore),
				}),
			).toMatchObject({ cause: "tripped" });
			child.emit("exit", 0, null);
			expect(await done).toBe(0);
			expect(runs()[0].endedAt).toEqual(expect.any(String));

			const uncapped = path.join(f.dir, "uncapped");
			const plain = main(
				["--", "pytest", "tests/test_a.py"],
				f.options({
					gate: undefined,
					gateRead: admitted(),
					gateLog,
					runStore: uncapped,
				}),
			);
			await tick();
			f.spawned[1].child.emit("exit", 0, null);
			expect(await plain).toBe(0);
			expect(readRunFiles(uncapped).runs).toEqual([]);
		});

		it("charges it uncapped where no gate command has 5 measured runs", async () => {
			const f = fixture();
			const caps: unknown[] = [];
			main(
				["--", "pytest", "tests/test_a.py"],
				f.options({
					gate: undefined,
					gateLog: path.join(f.dir, "absent.jsonl"),
					gateRead: (
						_c: string,
						_w: unknown,
						_m: number,
						reads: { capMb?: number },
					) => {
						caps.push(reads.capMb);
						return null;
					},
				}),
			);
			await tick();
			expect(caps).toEqual([undefined]);
		});

		it("charges it uncapped where the gate-run record will not read", async () => {
			const f = fixture();
			const gateLog = path.join(f.dir, "unreadable-gate-runs");
			fs.mkdirSync(gateLog);
			const caps: unknown[] = [];
			main(
				["--", "pytest", "tests/test_a.py"],
				f.options({
					gate: undefined,
					gateLog,
					gateRead: (
						_c: string,
						_w: unknown,
						_m: number,
						reads: { capMb?: number },
					) => {
						caps.push(reads.capMb);
						return null;
					},
				}),
			);
			await tick();
			expect(caps).toEqual([undefined]);
		});

		it("records a capped whole run in the test run store as whole (#5877)", async () => {
			// measured, lucmoseley/health-and-fitness#318
			const HealthPeak = 550;
			const f = fixture();
			const gateLog = path.join(f.dir, "gate-runs.jsonl");
			fs.writeFileSync(
				gateLog,
				new Array(5)
					.fill(HealthPeak)
					.map(
						(peakTreeMb) =>
							`${JSON.stringify({ repo: gateRepoName(), command: "sh scripts/test.sh", outcome: "pass", runS: 30, peakTreeMb })}\n`,
					)
					.join(""),
			);
			const runStore = path.join(f.dir, "runs");
			const weights: unknown[] = [];
			const done = main(
				["--", "python3", "-m", "unittest", "discover", "tests"],
				f.options({
					gate: undefined,
					gateLog,
					runStore,
					gateRead: (
						_c: string,
						weight: unknown,
						_m: number,
						reads: { capMb?: number; onAdmission?: (a: object) => void },
					) => {
						weights.push(weight);
						reads.onAdmission?.({
							mode: "ladder",
							cause: "unsized",
							rungMb: rungMb(HealthPeak),
							climbMb: 0,
							capMb: reads.capMb,
						});
						return null;
					},
				}),
			);
			await tick();
			const child = f.spawned[0].child;
			child.emit("spawn");
			expect(weights).toEqual([null]);
			expect(readRunFiles(runStore).runs).toEqual([
				expect.objectContaining({
					kind: "whole",
					argv: ["python3", "-m", "unittest", "discover", "tests"],
					admission: expect.objectContaining({ capMb: HealthPeak }),
				}),
			]);
			child.emit("exit", 0, null);
			expect(await done).toBe(0);
		});

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
		const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
		const gateRun = ["--gate", "--tree", emptyTree, "--", "bash test/all.sh"];
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

		it("records its wait and run on the monotonic clock, counting no host sleep (#5446), and its run's wall time beside it (#5471)", async () => {
			let wallMs = Date.now();
			let monoMs = 1_000_000;
			const sleep = (awakeMs: number) => {
				wallMs += 8 * 3_600_000 + awakeMs;
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
					expect.objectContaining({
						waitS: 30,
						runS: 60,
						wallS: 8 * 3600 + 60,
						outcome: "pass",
					}),
				]);
			} finally {
				vi.restoreAllMocks();
			}
		});

		it("takes the command by its role, never the classifier", async () => {
			const f = fixture();
			const g = gateOptions(f);
			main(
				["--gate", "--tree", emptyTree, "--", "npm", "run", "test"],
				g.options,
			);
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
					f,
					g,
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
				const { marker, started, peaks, f, g } = await seatBeside(five);
				expect(started).toBe(true);
				expect(marker).toMatchObject({
					role: "gate",
					part: true,
					chargeMb: 189,
				});
				expect(peaks).toEqual([189]);
				f.spawned[0].child.emit("spawn");
				f.spawned[0].child.emit("exit", 0, null);
				await tick();
				expect(g.readGates().at(-1)).toMatchObject({
					outcome: "pass",
					part: true,
				});
			});

			it.each([
				["4 records", five.slice(1)],
				["5 records, one with no peak read", [...five.slice(1), run(20, 0)]],
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

			it("waits whole on 5 records with one over 60 s, charged the highest of their peaks (#5591)", async () => {
				const { marker, started } = await seatBeside([
					...five.slice(1),
					run(145, 100),
				]);
				expect(started).toBe(false);
				expect(marker.part).toBeUndefined();
				expect(marker.chargeMb).toBe(189);
			});

			it("waits whole on a gate-run record that will not read, charged its configured seat", async () => {
				const f = fixture();
				const gateLog = path.join(f.dir, "unreadable-gate-runs");
				fs.mkdirSync(gateLog);
				const g = gateOptions(f, {
					gateLog,
					alive: () => true,
					sleepFn: () => new Promise(noop),
				});
				main(gateRun, g.options);
				await tick();
				const mine = f.readMarkers()[0] as string;
				expect(
					JSON.parse(fs.readFileSync(path.join(f.dir, mine), "utf8")),
				).toMatchObject({ role: "gate", chargeMb: 2100 });
				expect(f.err.join("")).toMatch(
					/would not read; this gate waits for the whole-suite slot, charged its configured or default seat/,
				);
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

		it("runs a --gate launch inside a gate seat's tree as the one shell string a gate's command is", async () => {
			const f = fixture();
			const outer = path.join(f.dir, "wfc-suite-queue-20.json");
			fs.writeFileSync(
				outer,
				JSON.stringify({ pid: 20, at: 0, role: "gate", spawned: true }),
			);
			const done = main(
				["--gate", "--tree", emptyTree, "--", "sh stub.sh"],
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
			const emptyRepo = defineTemplate(emptyRepoTemplate);
			const world = () => {
				const base = mkScratchDir("gate-ancestor-");
				dirs.push(base);
				const repo = (name: string, config: object) => {
					const root = emptyRepo.instantiate(path.join(base, name));
					fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
					fs.writeFileSync(
						path.join(root, ".claude", "workflow-core.json"),
						JSON.stringify({ contract: 1, ...config }),
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

			it("reads a runner whose checkout or config will not read as no suite, so its gate takes a seat (#5303)", () => {
				const { isInSuite } = require("./lib/gate-seat.js");
				const w = world();
				const loose = mkScratchDir("gate-loose-");
				dirs.push(loose);
				w.processAt(20, ["node", "scripts/run-all.js"], w.host);
				expect(isInSuite({ pid: 40, parentOf })).toBe(true);
				w.processAt(20, ["node", "scripts/run-all.js"], loose);
				expect(isInSuite({ pid: 40, parentOf })).toBe(false);
				fs.writeFileSync(
					path.join(w.host, ".claude", "workflow-core.json"),
					"{ torn",
				);
				w.processAt(20, ["node", "scripts/run-all.js"], w.host);
				expect(isInSuite({ pid: 40, parentOf })).toBe(false);
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

		it("records the tree it tested, and the selection its command wrote (#5448)", async () => {
			const f = fixture();
			const g = gateOptions(f);
			const done = main(gateRun, g.options);
			await tick();
			const file = f.spawned[0].opts.env?.WFC_GATE_SELECTION as string;
			fs.writeFileSync(file, "\n  12 of 40  \nignored\n");
			f.spawned[0].child.emit("spawn");
			f.spawned[0].child.emit("exit", 0, null);
			expect(await done).toBe(0);
			expect(g.readGates()).toEqual([
				expect.objectContaining({ tree: emptyTree, selection: "12 of 40" }),
			]);
			expect(fs.existsSync(path.dirname(file))).toBe(false);
		});

		it("leaves the selection absent where its command wrote none (#5448)", async () => {
			const f = fixture();
			const g = gateOptions(f);
			const done = main(gateRun, g.options);
			await tick();
			f.spawned[0].child.emit("spawn");
			f.spawned[0].child.emit("exit", 1, null);
			expect(await done).toBe(1);
			const [run] = g.readGates();
			expect(run).toMatchObject({ tree: emptyTree, outcome: "red" });
			expect(run).not.toHaveProperty("selection");
		});

		it("refuses --gate without --tree, --tree without --gate, and a --tree no sha (#5448)", async () => {
			const refusal = async (argv: string[]) => {
				const f = fixture();
				const code = await main(argv, f.options());
				expect(f.spawned).toHaveLength(0);
				return { code, err: f.err.join("") };
			};
			const together = /--gate and --tree go together/;
			expect(await refusal(["--gate", "--", "bash test/all.sh"])).toEqual({
				code: 2,
				err: expect.stringMatching(together),
			});
			expect(
				await refusal(["--seat", "--tree", emptyTree, "--", "sh", "-c", "x"]),
			).toEqual({ code: 2, err: expect.stringMatching(together) });
			expect(await refusal(["--gate", "--tree", "", "--", "sh x"])).toEqual({
				code: 2,
				err: expect.stringMatching(/--tree takes a git tree's sha/),
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

		const machine = (dir: string, lines: string[], mb: number) => {
			vi.stubEnv("WFC_PS", writePsStub(dir, lines, { name: "ps-tsc" }));
			const meminfo = path.join(dir, "meminfo");
			fs.writeFileSync(meminfo, `MemAvailable:    ${mb * 1024} kB\n`);
			vi.stubEnv("WFC_MEMINFO", meminfo);
		};

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
						"queue-run.js: the type-check slot is held, by a `tsc` running, a suite starting (#3203), MemAvailable, less what a climbing suite has yet to draw (#3416), under its rung, or this session's own two places in the queue (#5595) — not run, as WFC_TSC_NO_WAIT asks (#3278)\n",
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
			const run = `wfc-tsc-run-${process.pid}-${readStartTimeOf(process.pid)}`;
			expect(fs.readdirSync(path.join(f.dir, "wfc-tsc-queue")).sort()).toEqual([
				`wfc-suite-queue-${process.pid}.json`,
				`${run}.err`,
				`${run}.out`,
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
						// #1776 measured ~0.5 s a pass
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

		describe("joining a queued run with the same worktree, directory and command (#5640)", () => {
			const Where = { toplevel: "/w/tree", cwd: "/w/tree" };

			const hub = () => {
				const f = fixture();
				const clock = { now: 1000, mono: 0 };
				let pending: (() => void)[] = [];
				const settle = async () => {
					for (let k = 0; k < 6; k += 1) await tick();
				};
				const poll = async (rounds = 1) => {
					for (let i = 0; i < rounds; i += 1) {
						const due = pending;
						pending = [];
						for (const resolve of due) resolve();
						await settle();
					}
				};
				const request = (
					pid: number,
					{
						open = () => true,
						words = typecheck,
						...extra
					}: { open?: () => boolean; words?: string[] } & Record<
						string,
						unknown
					> = {},
				) => {
					const out: string[] = [];
					const err: string[] = [];
					const stdout: string[] = [];
					const exits: number[] = [];
					const signals = new EventEmitter();
					const code = main(words, {
						...f.options(),
						pid,
						alive: () => true,
						worktree: Where,
						gate: () => null,
						turn: open,
						clock: () => clock.now,
						monoClock: () => clock.mono,
						sleepFn: () => new Promise<void>((r) => pending.push(r)),
						out: { write: (s: string) => out.push(s) },
						err: { write: (s: string) => err.push(s) },
						stdout: { write: (s: string) => stdout.push(s) },
						signals,
						exit: (c: number) => exits.push(c),
						...extra,
					});
					return { code, out, err, stdout, exits, signals };
				};
				const leftovers = () =>
					fs
						.readdirSync(f.dir)
						.filter((name) => /^wfc-tsc-(join|run)-/.test(name));
				const runMarker = (pid: number, at: number, extra: object = {}) =>
					fs.writeFileSync(
						path.join(f.dir, `wfc-suite-queue-${pid}.json`),
						JSON.stringify({
							pid,
							at,
							start: 0,
							...Where,
							command: typecheck.slice(2),
							session: "s9",
							...extra,
						}),
					);
				return { f, clock, poll, request, leftovers, runMarker };
			};

			const finishRun = (
				child: FakeChild,
				code: number,
				out = "src/a.ts(1,1): error TS2322\n",
			) => {
				child.emit("spawn");
				child.stdout.emit("data", out);
				child.stderr.emit("data", "tsc: warned\n");
				child.emit("exit", code, null);
			};

			it.each([
				["green", 0],
				["red", 2],
			])(
				"makes one spawn for two requests, the joiner taking its output and its %s exit",
				async (_colour, exit) => {
					const h = hub();
					let open = false;
					const a = h.request(101, { open: () => open });
					await tick();
					h.clock.now = 2000;
					const b = h.request(102);
					await h.poll();
					expect(h.f.spawned).toEqual([]);
					open = true;
					h.clock.now = 5000;
					await h.poll();
					expect(h.f.spawned).toHaveLength(1);
					finishRun(h.f.spawned[0].child, exit);
					expect(await a.code).toBe(exit);
					await h.poll();
					expect(await b.code).toBe(exit);
					expect(h.f.spawned).toHaveLength(1);
					expect(a.stdout.join("")).toBe("src/a.ts(1,1): error TS2322\n");
					expect(a.err.join("")).toBe("tsc: warned\n");
					expect(b.err).toEqual([
						"queue-run: joined the type-check pid 101 (session s1) queued at 1970-01-01T00:00:01.000Z; its output and exit code follow\n",
						"tsc: warned\n",
					]);
					expect(b.stdout.join("")).toBe("src/a.ts(1,1): error TS2322\n");
					expect(h.f.readLog()).toEqual([
						expect.objectContaining({ reason: "opened", kind: "tsc" }),
						expect.objectContaining({
							reason: "opened",
							kind: "tsc",
							session: "s1",
							at: new Date(5000).toISOString(),
							waitS: 3,
							chargeMb: TSC_PEAK_MB,
							joined: { pid: 101, session: "s1" },
						}),
					]);
					expect(h.f.readLog()[0]).not.toHaveProperty("joined");
					expect(h.leftovers()).toEqual([]);
				},
			);

			it("joins across sessions, the joiner holding no place in the queue", async () => {
				const h = hub();
				h.request(111, { open: () => false, sessionId: "parent" });
				await tick();
				h.clock.now = 2000;
				const b = h.request(112, { sessionId: "other" });
				await h.poll();
				expect(h.f.spawned).toEqual([]);
				expect(h.f.readMarkers()).toEqual(["wfc-suite-queue-111.json"]);
				expect(b.err).toEqual([]);
			});

			it("queues a run of its own behind a run that has spawned, which a later request joins", async () => {
				const h = hub();
				const a = h.request(121);
				await tick();
				h.f.spawned[0].child.emit("spawn");
				let open = false;
				h.clock.now = 2000;
				const b = h.request(122, { open: () => open });
				await h.poll();
				expect(h.f.spawned).toHaveLength(1);
				h.clock.now = 3000;
				const c = h.request(123);
				await h.poll();
				expect(h.f.spawned).toHaveLength(1);
				h.f.spawned[0].child.emit("exit", 0, null);
				expect(await a.code).toBe(0);
				open = true;
				await h.poll();
				expect(h.f.spawned).toHaveLength(2);
				finishRun(h.f.spawned[1].child, 2);
				expect(await b.code).toBe(2);
				await h.poll();
				expect(await c.code).toBe(2);
				expect(c.err[0]).toMatch(/joined the type-check pid 122 /);
			});

			it.each([
				["another worktree", { worktree: { toplevel: "/w/b", cwd: "/w/b" } }],
				[
					"another working directory",
					{ worktree: { toplevel: "/w/tree", cwd: "/w/tree/sub" } },
				],
				[
					"another command",
					{
						words: ["--tsc", "--", "npx", "tsc", "-p", "tsconfig.strict.json"],
					},
				],
			])("never joins a run from %s", async (_why, extra) => {
				const h = hub();
				h.request(131, { open: () => false });
				await tick();
				h.clock.now = 2000;
				const b = h.request(132, extra);
				await h.poll();
				expect(h.f.spawned).toHaveLength(1);
				expect(b.err).toEqual([]);
			});

			it("settles a near tie on the earlier marker, by `at` then pid", async () => {
				const later = hub();
				later.runMarker(141, 1000);
				later.request(142);
				await later.poll();
				expect(later.f.spawned).toEqual([]);

				const earlier = hub();
				earlier.runMarker(152, 1000);
				earlier.request(151);
				await earlier.poll();
				expect(earlier.f.spawned).toHaveLength(1);
			});

			it("joins a run the per-session cap holds, by its ask, not its entry (#5595)", async () => {
				const h = hub();
				h.runMarker(261, 1000, { enteredAt: 9000 });
				h.clock.now = 2000;
				h.request(262);
				await h.poll();
				expect(h.f.spawned).toEqual([]);
				expect(h.f.readMarkers()).toEqual(["wfc-suite-queue-261.json"]);
			});

			it("never joins a run admitted and not yet stamped spawned", async () => {
				const h = hub();
				h.runMarker(241, 500, { admitted: true });
				const b = h.request(242, { open: () => false });
				await h.poll();
				expect(h.f.readMarkers()).toEqual([
					"wfc-suite-queue-241.json",
					"wfc-suite-queue-242.json",
				]);
				expect(h.leftovers()).toEqual([]);
				expect(b.err).toEqual([]);
			});

			it("polls again, never falling back, on a marker read mid-write", async () => {
				const h = hub();
				let open = false;
				h.request(251, { open: () => open });
				await tick();
				h.clock.now = 2000;
				const b = h.request(252);
				await h.poll();
				const marker = path.join(h.f.dir, "wfc-suite-queue-251.json");
				const whole = fs.readFileSync(marker, "utf8");
				fs.writeFileSync(marker, whole.slice(0, 10));
				await h.poll(2);
				expect(h.f.spawned).toEqual([]);
				fs.writeFileSync(marker, whole);
				open = true;
				await h.poll();
				finishRun(h.f.spawned[0].child, 0);
				await h.poll();
				expect(await b.code).toBe(0);
				expect(h.f.spawned).toHaveLength(1);
			});

			it("never joins a run that a no-wait try made, nor joins as one", async () => {
				const h = hub();
				vi.stubEnv("WFC_TSC_NO_WAIT", "1");
				h.request(161);
				await tick();
				expect(h.f.spawned).toHaveLength(1);
				vi.stubEnv("WFC_TSC_NO_WAIT", undefined);
				h.clock.now = 2000;
				h.request(162, { open: () => false });
				await tick();
				expect(h.f.readMarkers()).toEqual([
					"wfc-suite-queue-161.json",
					"wfc-suite-queue-162.json",
				]);
				h.f.spawned[0].child.emit("spawn");
				vi.stubEnv("WFC_TSC_NO_WAIT", "1");
				h.clock.now = 3000;
				const c = h.request(163, { sessionId: "s2" });
				await h.poll();
				expect(h.f.spawned).toHaveLength(2);
				expect(c.err).toEqual([]);
			});

			it("runs a nested type-check at once, joining nothing", async () => {
				const h = hub();
				h.request(171, { open: () => false });
				await tick();
				const outer = path.join(h.f.dir, "wfc-suite-queue-20.json");
				fs.writeFileSync(
					outer,
					JSON.stringify({ pid: 20, at: 0, admitted: true, spawned: true }),
				);
				h.clock.now = 2000;
				h.request(172, {
					env: { WFC_TSC_SLOT: outer },
					parentOf: () => 20,
				});
				await tick();
				expect(h.f.spawned).toHaveLength(1);
			});

			it("refuses at the wait bound, counted from its ask, a joiner whose run has not spawned", async () => {
				const h = hub();
				h.request(181, { open: () => false });
				await tick();
				h.clock.mono = 1000;
				const b = h.request(182, { timeoutMs: 10_000 });
				await h.poll();
				h.clock.mono = 11_000;
				await h.poll();
				expect(await b.code).toBe(1);
				expect(b.out.join("")).toMatch(
					/the type-check pid 181 this request joined had not started after 10s/,
				);
				expect(h.f.readLog()).toEqual([
					expect.objectContaining({
						reason: "timeout",
						kind: "tsc",
						waitS: 10,
						joined: { pid: 181, session: "s1" },
					}),
				]);
				expect(h.leftovers()).toEqual([]);
				expect(h.f.spawned).toEqual([]);
			});

			it("falls back to its own run at its original place and wait clock when the run is refused", async () => {
				const h = hub();
				h.request(191, { open: () => false, timeoutMs: 5000 });
				await tick();
				h.clock.now = 2000;
				h.clock.mono = 1000;
				const b = h.request(192, { open: () => false, timeoutMs: 10_000 });
				await h.poll();
				h.clock.now = 9000;
				h.clock.mono = 6000;
				await h.poll(2);
				expect(
					JSON.parse(
						fs.readFileSync(
							path.join(h.f.dir, "wfc-suite-queue-192.json"),
							"utf8",
						),
					).at,
				).toBe(2000);
				h.clock.mono = 11_000;
				await h.poll();
				expect(await b.code).toBe(1);
				const rows = h.f.readLog();
				expect(rows).toEqual([
					expect.objectContaining({ reason: "refused" }),
					expect.objectContaining({ reason: "refused", waitS: 10 }),
				]);
				expect(rows[1]).not.toHaveProperty("joined");
				expect(h.f.spawned).toEqual([]);
			});

			it.each([
				[
					"its child never starts",
					(h: ReturnType<typeof hub>) =>
						h.f.spawned[0].child.emit("error", new Error("ENOENT")),
				],
				[
					"its runner dies",
					(_h: ReturnType<typeof hub>, dead: Set<number>) => dead.add(201),
				],
				[
					"its child is killed by a signal after it spawned",
					(h: ReturnType<typeof hub>) => {
						h.f.spawned[0].child.emit("spawn");
						h.f.spawned[0].child.stdout.emit("data", "partial\n");
						h.f.spawned[0].child.emit("exit", null, "SIGTERM");
					},
				],
			])("queues its own run when %s", async (_why, leave) => {
				const h = hub();
				const dead = new Set<number>();
				const alive = (pid: number) => !dead.has(pid);
				let open = false;
				h.request(201, { open: () => open, alive });
				await tick();
				h.clock.now = 2000;
				h.request(202, { alive });
				await h.poll();
				open = true;
				await h.poll();
				expect(h.f.spawned).toHaveLength(1);
				leave(h, dead);
				await h.poll(2);
				expect(h.f.spawned).toHaveLength(2);
			});

			it.each([
				["before", 1500],
				["after", 3000],
			])(
				"joins another queued same-key run, queued %s its own ask, when its run leaves without a result",
				async (_when, queuedAt) => {
					const h = hub();
					h.request(211, { open: () => false, timeoutMs: 5000 });
					await tick();
					h.clock.now = 2000;
					const b = h.request(212);
					await h.poll();
					h.runMarker(215, queuedAt);
					h.clock.mono = 6000;
					await h.poll(2);
					expect(h.f.spawned).toEqual([]);
					const stem = path.join(h.f.dir, "wfc-tsc-run-215-0");
					fs.writeFileSync(`${stem}.out`, "clean\n");
					fs.writeFileSync(`${stem}.err`, "");
					fs.writeFileSync(
						`${stem}.result.json`,
						JSON.stringify({
							code: 0,
							signal: null,
							spawnedAt: 4000,
							endedAt: 7000,
						}),
					);
					fs.rmSync(path.join(h.f.dir, "wfc-suite-queue-215.json"));
					await h.poll();
					expect(await b.code).toBe(0);
					expect(b.stdout.join("")).toBe("clean\n");
					expect(h.f.readLog().at(-1)).toMatchObject({
						reason: "opened",
						waitS: 2,
						joined: { pid: 215, session: "s9" },
					});
					expect(h.leftovers()).toEqual([]);
				},
			);

			it("drops its join marker and logs `killed` when a signal ends its wait", async () => {
				const h = hub();
				h.request(221, { open: () => false });
				await tick();
				const b = h.request(222);
				await h.poll();
				b.signals.emit("SIGINT");
				expect(b.exits).toEqual([130]);
				expect(h.f.readLog()).toEqual([
					expect.objectContaining({
						reason: "killed",
						signal: "SIGINT",
						joined: { pid: 221, session: "s1" },
					}),
				]);
				expect(h.leftovers()).toEqual([]);
			});

			it("closes every capture file it opened when its child ends on a signal", async () => {
				const h = hub();
				const open = new Set<number>();
				const queueFs = {
					...fs,
					openSync: (file: string, flags: string) => {
						const fd = fs.openSync(file, flags);
						if (path.basename(file).startsWith("wfc-tsc-run-")) open.add(fd);
						return fd;
					},
					closeSync: (fd: number) => {
						open.delete(fd);
						return fs.closeSync(fd);
					},
				};
				const a = h.request(271, { queueFs });
				await tick();
				expect(open.size).toBe(2);
				h.f.spawned[0].child.emit("spawn");
				h.f.spawned[0].child.emit("exit", null, "SIGTERM");
				expect(await a.code).toBe(143);
				expect(open.size).toBe(0);
				expect(h.leftovers()).toEqual([]);
			});

			it("stamps a joiner killed after its run spawned at the injected wall clock", async () => {
				const h = hub();
				let open = false;
				h.request(241, { open: () => open });
				await tick();
				h.clock.now = 2000;
				const b = h.request(242);
				await h.poll();
				open = true;
				await h.poll();
				h.f.spawned[0].child.emit("spawn");
				h.clock.now = 6000;
				await h.poll();
				h.clock.now = 9000;
				b.signals.emit("SIGINT");
				expect(h.f.readLog().at(-1)).toMatchObject({
					reason: "killed",
					at: new Date(6000).toISOString(),
					joined: { pid: 241, session: "s1" },
				});
			});

			it("says so and still runs when its capture files will not open", async () => {
				const h = hub();
				const queueFs = {
					...fs,
					openSync: (file: string, flags: string) => {
						if (path.basename(file).startsWith("wfc-tsc-run-"))
							throw new Error("EACCES");
						return fs.openSync(file, flags);
					},
				};
				const a = h.request(251, { queueFs });
				await tick();
				finishRun(h.f.spawned[0].child, 0);
				expect(await a.code).toBe(0);
				expect(a.stdout.join("")).toBe("src/a.ts(1,1): error TS2322\n");
				expect(a.out.join("")).toMatch(
					/could not open this type-check's capture files .*\(EACCES\) — it runs, but a request that joined it joins another queued run or runs its own/,
				);
			});

			it("says so and queues its own run when its join marker will not write", async () => {
				const h = hub();
				h.request(261, { open: () => false });
				await tick();
				const queueFs = {
					...fs,
					writeFileSync: (file: string, data: string) => {
						if (path.basename(file).startsWith("wfc-tsc-join-"))
							throw new Error("ENOSPC");
						return fs.writeFileSync(file, data);
					},
				};
				h.clock.now = 2000;
				const b = h.request(262, { open: () => false, queueFs });
				await h.poll();
				expect(b.out.join("")).toMatch(
					/could not write a join marker .*\(ENOSPC\) — queueing a type-check of its own instead/,
				);
				expect(h.f.readMarkers().sort()).toEqual([
					"wfc-suite-queue-261.json",
					"wfc-suite-queue-262.json",
				]);
			});

			it("says so, and still takes the verdict, when its join marker will not remove", async () => {
				const h = hub();
				let open = false;
				const a = h.request(281, { open: () => open });
				await tick();
				const queueFs = {
					...fs,
					rmSync: (file: string, opts: object) => {
						if (path.basename(file).startsWith("wfc-tsc-join-"))
							throw new Error("EBUSY");
						return fs.rmSync(file, opts);
					},
				};
				h.clock.now = 2000;
				const b = h.request(282, { queueFs });
				await h.poll();
				open = true;
				await h.poll();
				finishRun(h.f.spawned[0].child, 0);
				expect(await a.code).toBe(0);
				await h.poll();
				expect(await b.code).toBe(0);
				expect(b.out.join("")).toMatch(
					/could not remove its join marker .*\(EBUSY\) — the stale sweep removes it once this process exits/,
				);
			});

			it("on fallback joins a later same-key run even past another key's waiter, as the spec's Fallback decision rules", async () => {
				const h = hub();
				h.request(291, { open: () => false, timeoutMs: 5000 });
				await tick();
				h.clock.now = 2000;
				h.request(292, { open: () => false });
				await h.poll();
				fs.writeFileSync(
					path.join(h.f.dir, "wfc-suite-queue-293.json"),
					JSON.stringify({
						pid: 293,
						at: 2500,
						start: 0,
						toplevel: "/other",
						cwd: "/other",
						command: typecheck.slice(2),
						session: "s8",
					}),
				);
				h.runMarker(295, 3000);
				h.clock.mono = 6000;
				await h.poll(2);
				expect(h.f.readMarkers()).not.toContain("wfc-suite-queue-292.json");
				expect(h.leftovers()).toContain("wfc-tsc-join-292.json");
				expect(h.f.spawned).toEqual([]);
			});

			it("leaves no capture behind a run nobody joined", async () => {
				const h = hub();
				const a = h.request(231);
				await tick();
				finishRun(h.f.spawned[0].child, 0);
				expect(await a.code).toBe(0);
				expect(a.stdout.join("")).toBe("src/a.ts(1,1): error TS2322\n");
				expect(h.leftovers()).toEqual([]);
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
