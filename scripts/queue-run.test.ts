// @vitest-environment node
/*
 * queue-run.js (#1776): the suite queue for `node --test`, pytest and the
 * other non-vitest runners. The gate, the turn, the spawn and the signals are
 * injected, those being shapes a real process cannot stage without a loaded
 * machine (§X3); the markers and the exit log are real files in a scratch
 * directory, and the classifier is the real lib/suite-launch.sh. One case
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
	const spawned: { command: string; args: string[]; child: FakeChild }[] = [];
	const markers = () =>
		fs.readdirSync(dir).filter((f) => f.startsWith("wfc-suite-queue-"));
	const lines = () =>
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
		spawnFn: (command: string, args: string[]) => {
			const child = new FakeChild();
			spawned.push({ command, args, child });
			return child;
		},
		...extra,
	});
	return { dir, signals, err, spawned, markers, lines, options };
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
		const [marker] = f.markers();
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
		expect(f.markers()).toEqual([]);
		expect(f.lines()).toEqual([
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
		expect(f.markers()).toEqual([]);
	});

	/* A wait the memory rung still holds at the ceiling would land short of
	 * its rung, where earlyoom kills live sessions; the count cap's runs (#2421). */
	it("refuses a wait the memory rung holds at the timeout, spawning nothing", async () => {
		const f = fixture();
		const said: string[] = [];
		const code = await main(
			["--", "pytest"],
			f.options({
				gate: () => ({ limb: "memory", mb: 900, rungMb: 3250 }),
				timeoutMs: -1,
				out: { write: (s: string) => said.push(s) },
			}),
		);
		expect(code).not.toBe(0);
		expect(f.spawned).toEqual([]);
		expect(f.markers()).toEqual([]);
		expect(f.lines()).toEqual([
			expect.objectContaining({ reason: "refused", limb: "memory" }),
		]);
		expect(said.join("")).toMatch(/gate still denies on memory/);
	});

	it("runs a wait the count cap holds at the timeout", async () => {
		const f = fixture();
		const done = main(
			["--", "pytest"],
			f.options({ gate: () => ({ limb: "count" }), timeoutMs: -1 }),
		);
		await tick();
		expect(f.spawned).toHaveLength(1);
		f.spawned[0].child.emit("exit", 0, null);
		expect(await done).toBe(0);
		expect(f.lines()).toEqual([
			expect.objectContaining({ reason: "timeout", limb: "count" }),
		]);
	});

	it("leaves the queue and logs `killed` when a signal ends the wait", async () => {
		const f = fixture();
		const exits: number[] = [];
		main(
			["--", "pytest"],
			f.options({ gate: () => true, exit: (c: number) => exits.push(c) }),
		);
		await tick();
		expect(f.markers()).toHaveLength(1);
		f.signals.emit("SIGINT");
		expect(exits).toEqual([130]);
		expect(f.markers()).toEqual([]);
		expect(f.spawned).toEqual([]);
		expect(f.lines()).toEqual([
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
		expect(f.markers()).toEqual([]);
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
	])("refuses %s before it queues", async (command, why) => {
		const f = fixture();
		expect(await main(["--", ...command.split(" ")], f.options())).toBe(2);
		expect(f.err.join("")).toMatch(why);
		expect(f.markers()).toEqual([]);
		expect(f.spawned).toEqual([]);
		expect(f.lines()).toEqual([]);
	});

	it("as a program, exits 2 on a refusal and names the queue to use", () => {
		const { dir } = fixture();
		const r = spawnSync("node", [PROGRAM, "--", "npm", "run", "test"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/run-vitest\.js's `--queue`/);
	});
});
