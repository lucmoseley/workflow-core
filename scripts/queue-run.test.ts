// @vitest-environment node
/*
 * queue-run.js (#1776): the suite queue for `node --test`, pytest and the
 * other non-vitest runners. The gate, the turn, the spawn and the signals are
 * injected, those being shapes a real process cannot stage without a loaded
 * machine (§X3); the markers and the exit log are real files in a scratch
 * directory, and the classifier is the real lib/suite-launch.js. One case
 * runs the program itself, on a refusal, which queues nothing.
 * In the world, a wrong verdict runs a fourth suite past the cap, strands a
 * waiter's marker so later waiters queue behind nothing, or leaves its wait
 * out of the daily queue-wait figure.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { writePsStub } from "./lib/ps-stub";

const { main } = require("./queue-run.js");
const PROGRAM = path.resolve(__dirname, "queue-run.js");

const dirs: string[] = [];
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
		gate: () => false,
		turn: () => true,
		// A wait that never polls again: the gate's first answer is final.
		sleepFn: () =>
			new Promise(() => {
				/* never settles */
			}),
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
		expect(marker).toBeTruthy();
		const read = () =>
			JSON.parse(fs.readFileSync(path.join(f.dir, marker), "utf8"));
		// Admitted before the launch, so no other waiter's turn comes (#2578).
		expect(read()).toMatchObject({ admitted: true });
		expect(read().spawned).toBeUndefined();
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
		expect(f.readMarkers()).toHaveLength(1);
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

	it("as a program, exits 2 on a refusal and names the queue to use", () => {
		const { dir } = fixture();
		const r = spawnSync("node", [PROGRAM, "--", "npm", "run", "test"], {
			encoding: "utf8",
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
	describe("--tsc, the machine-wide type-check slot (#3163)", () => {
		const typecheck = ["--tsc", "--", "sh", "-c", "tsc --noEmit"];
		const envKeys = [
			"WFC_PS",
			"WFC_MEMINFO",
			"TMPDIR",
			"WFC_TSC_NO_WAIT",
		] as const;
		const saved: Partial<Record<(typeof envKeys)[number], string>> = {};
		beforeEach(() => {
			for (const k of envKeys) saved[k] = process.env[k];
		});
		afterEach(() => {
			for (const k of envKeys)
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
		});

		/** The machine the real gate reads: `ps` lines and MemAvailable. */
		const machine = (dir: string, lines: string[], mb: number) => {
			process.env.WFC_PS = writePsStub(dir, lines, { name: "ps-tsc" });
			const meminfo = path.join(dir, "meminfo");
			fs.writeFileSync(meminfo, `MemAvailable:    ${mb * 1024} kB\n`);
			process.env.WFC_MEMINFO = meminfo;
		};

		/** The fixture's options less its injected turn and gate, so the
		 * slot's own queue and gate decide. */
		const own = (f: ReturnType<typeof fixture>, extra: object = {}) => {
			const { turn: _turn, gate: _gate, ...rest } = f.options(extra);
			return rest;
		};

		it("waits, visibly, while a `tsc` is running, then runs nothing", async () => {
			const f = fixture();
			machine(f.dir, ["node /r/node_modules/.bin/tsc --noEmit"], 9000);
			const out: string[] = [];
			main(typecheck, own(f, { out: { write: (s: string) => out.push(s) } }));
			await tick();
			expect(f.spawned).toEqual([]);
			expect(out.join("")).toBe(
				"queue-run.js: waiting for the type-check slot: a `tsc` running, or MemAvailable under its ~2750 MB rung\n",
			);
		});

		it("waits, visibly, while MemAvailable is under its rung", async () => {
			const f = fixture();
			machine(f.dir, ["bash -l"], 1000);
			const out: string[] = [];
			main(typecheck, own(f, { out: { write: (s: string) => out.push(s) } }));
			await tick();
			expect(f.spawned).toEqual([]);
			expect(out.join("")).toBe(
				"queue-run.js: waiting for the type-check slot: a `tsc` running, or MemAvailable under its ~2750 MB rung\n",
			);
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
				/MemAvailable 1000 MB against the ~2750 MB rung/,
			);
			expect(f.readLog()).toEqual([
				expect.objectContaining({
					reason: "refused",
					kind: "tsc",
					limb: "memory",
				}),
			]);
		});

		describe("under WFC_TSC_NO_WAIT, one try at the slot (#3278)", () => {
			beforeEach(() => {
				process.env.WFC_TSC_NO_WAIT = "1";
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
						"queue-run.js: the type-check slot is held — not run, as WFC_TSC_NO_WAIT asks (#3278)\n",
					);
				},
			);

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
		});

		it("runs two type-checks one after the other", async () => {
			const f = fixture();
			machine(f.dir, ["bash -l"], 9000);
			let wake = () => {
				/* replaced by the second waiter's sleep */
			};
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
				"102: queue-run.js: waiting for the type-check slot: a `tsc` running, or MemAvailable under its ~2750 MB rung\n",
			]);
			f.spawned[0].child.emit("exit", 0, null);
			expect(await first).toBe(0);
			wake();
			await tick();
			expect(f.spawned).toHaveLength(2);
			f.spawned[1].child.emit("spawn");
			f.spawned[1].child.emit("exit", 0, null);
			expect(await second).toBe(0);
		});

		it("queues apart from the suites, so a waiting suite never holds it", async () => {
			const f = fixture();
			machine(f.dir, ["bash -l"], 9000);
			process.env.TMPDIR = f.dir;
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
