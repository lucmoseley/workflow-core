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
import { afterEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";

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
});
