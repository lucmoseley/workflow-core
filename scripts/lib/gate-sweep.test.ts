// @vitest-environment node
/*
 * The refill loop's gate sweep (#2279): which readings queue a `/triage <n>`
 * judgement, the store surviving a restart, the tick dropping each judgement
 * it tried, the decision core launching a queued one, and the sweep running
 * beside ticks rather than in one. Two cases run real children from stub
 * check-gates.js scripts written to a temp dir: the exit code a real child
 * returns, and a sweep the loop does not wait on.
 *
 * Loosen one and a met gate stays held with nobody summoned to judge it, a
 * judge is launched on every sweep whatever it read, a refused judgement
 * takes a slot every tick, or one slow `check:` stalls every tick behind it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	GATE_SWEEP_MS,
	JUDGE_EVERY_MS,
	dropTried,
	gateSweeper,
	readGateStore,
	runCheckGates,
} = require("./gate-sweep.js");
const { decideTick } = require("./refill-decide.js");

const WFC = "/home/u/workflow-core";
const NOW = Date.parse("2026-10-21T17:00:00Z");

let dir: string;
let file: string;

/* Every case but the damaged-store one seeds a sound store, so a logged
 * line is a failure. */
const throwOnLog = (line: string) => {
	throw new Error(`unexpected log: ${line}`);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sweep-"));
	file = path.join(dir, "gates.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const row = (number: number, reading: string, state = "READING") => ({
	number,
	state,
	reading,
	detail: null,
});

const envelope = (rows: unknown[]) => JSON.stringify({ rows, outcome: "OK" });

const seed = (store: Record<string, unknown>) =>
	fs.writeFileSync(file, JSON.stringify(store));

async function sweepOnce(stdout: string, now = NOW) {
	const lines: string[] = [];
	const sweeper = gateSweeper({
		file,
		runRoot: async () => ({ stdout }),
		log: (l: string) => lines.push(l),
		cadenceMs: GATE_SWEEP_MS,
	});
	await sweeper.startIfDue([WFC], now);
	return { store: readGateStore(file, throwOnLog), lines };
}

describe("which readings queue a judgement", () => {
	it("queues exactly one /triage <n> on a reading that differs from the stored one", async () => {
		seed({ readings: { [`${WFC}#2046`]: "3 of 4 runs ended" } });
		const { store, lines } = await sweepOnce(
			envelope([row(2046, "every pair started and every run ended")]),
		);
		expect(store.pending).toHaveLength(1);
		expect(store.pending[0]).toMatchObject({ root: WFC, number: 2046 });
		expect(store.pending[0].prompt).toMatch(
			/^\/triage 2046 .*check-gates\.js --issue 2046/,
		);
		expect(store.readings[`${WFC}#2046`]).toBe(
			"every pair started and every run ended",
		);
		expect(lines.join("\n")).toContain(
			"reading or repair state changed on #2046",
		);
	});

	it("queues none on an unchanged reading", async () => {
		seed({ readings: { [`${WFC}#2046`]: "3 of 4 runs ended" } });
		const { store } = await sweepOnce(
			envelope([row(2046, "3 of 4 runs ended")]),
		);
		expect(store.pending).toEqual([]);
	});

	it("queues a reading that changes every sweep once per 6 hours, the first sweep past the bound seeing the change (#3092)", async () => {
		const queuedOn = [];
		for (let i = 0; i <= 13; i++) {
			const at = NOW + i * GATE_SWEEP_MS;
			const { store } = await sweepOnce(envelope([row(2906, `load ${i}`)]), at);
			if (store.pending.length > 0) queuedOn.push(i);
			dropTried(file, [{ root: WFC, issues: [2906] }], throwOnLog);
		}
		expect(queuedOn).toEqual([0, 12]);
	});

	it("keeps the stored reading through the bound, so a reading that changed once inside it is queued after it", async () => {
		await sweepOnce(envelope([row(2906, "load 30")]));
		dropTried(file, [{ root: WFC, issues: [2906] }], throwOnLog);
		const held = await sweepOnce(
			envelope([row(2906, "load 2")]),
			NOW + GATE_SWEEP_MS,
		);
		expect(held.store.pending).toEqual([]);
		expect(held.store.readings[`${WFC}#2906`]).toBe("load 30");
		const past = await sweepOnce(
			envelope([row(2906, "load 2")]),
			NOW + 6 * 60 * 60 * 1000,
		);
		expect(past.store.pending).toHaveLength(1);
	});

	it("queues one on a first sighting", async () => {
		const { store } = await sweepOnce(envelope([row(7, "v1.3.15")]));
		expect(store.pending.map((j: { number: number }) => j.number)).toEqual([7]);
	});

	it.each([
		["NO-OUTPUT", "exit 0, nothing on stdout"],
		["NOT-A-COMMAND", "carries a second pair of backticks inside the first"],
	])(
		"queues one judgement on a first %s sighting, and none on the same state next sweep (#3487)",
		async (state, reading) => {
			const first = await sweepOnce(envelope([row(3223, reading, state)]));
			expect(first.store.pending).toHaveLength(1);
			expect(first.store.pending[0].prompt).toMatch(
				new RegExp(`^/triage 3223 .*reads ${state}.*by hand.*prints`),
			);
			dropTried(file, [{ root: WFC, issues: [3223] }], throwOnLog);
			const next = await sweepOnce(
				envelope([row(3223, reading, state)]),
				// Past the bound, so the bound is not what holds it.
				NOW + JUDGE_EVERY_MS + GATE_SWEEP_MS,
			);
			expect(next.store.pending).toEqual([]);
		},
	);

	it("queues one judgement where a reading turns to a repair state, under the same bound", async () => {
		seed({ readings: { [`${WFC}#2491`]: "41 runs" } });
		const { store } = await sweepOnce(
			envelope([
				row(2491, "killed at 60s — run it by hand", "OVER-BUDGET"),
				row(9, "exit 127, nothing on stdout", "DEAD"),
			]),
		);
		expect(store.pending.map((j: { number: number }) => j.number)).toEqual([
			2491, 9,
		]);
		expect(store.readings).toEqual({
			[`${WFC}#2491`]: "[OVER-BUDGET]",
			[`${WFC}#9`]: "[DEAD]",
		});
	});

	it("queues none for a row that is no segment to repair", async () => {
		const { store } = await sweepOnce(
			envelope([
				row(4, "no `check:` — judge the condition by hand", "NOT-STATED"),
				row(6, "malformed marker", "GATES-NOTHING"),
			]),
		);
		expect(store.pending).toEqual([]);
		expect(store.readings).toEqual({});
	});

	it("moves nothing for a checkout whose envelope carries no rows", async () => {
		const stored = { [`${WFC}#1`]: "a" };
		seed({ readings: stored });
		for (const stdout of ["not json", JSON.stringify({ outcome: "SKIP" })]) {
			const { store, lines } = await sweepOnce(stdout, NOW);
			expect(store.readings).toEqual(stored);
			expect(lines.join("\n")).toContain("readings kept");
			seed({ readings: stored });
		}
	});

	it("drops an issue no longer gated from the store and the queue, leaving other checkouts", async () => {
		seed({
			readings: { [`${WFC}#1`]: "a", "/home/u/dv#1": "b" },
			pending: [{ root: WFC, number: 1, prompt: "/triage 1" }],
		});
		const { store } = await sweepOnce(envelope([]));
		expect(store.readings).toEqual({ "/home/u/dv#1": "b" });
		expect(store.pending).toEqual([]);
	});

	it("counts a non-zero exit that printed as a reading, never as a verdict", async () => {
		const script = path.join(dir, "exit-1.js");
		fs.writeFileSync(
			script,
			`process.stdout.write(${JSON.stringify(envelope([{ ...row(5, "no match"), detail: "exit 1" }]))}); process.exitCode = 1;`,
		);
		const out = await runCheckGates(dir, { env: process.env, script });
		const { store } = await sweepOnce(out.stdout);
		expect(store.readings[`${WFC}#5`]).toBe("no match");
		expect(store.pending).toHaveLength(1);
	});
});

describe("the store across ticks and restarts", () => {
	it("drops each judgement a tick tried, launched or refused, and keeps the rest", () => {
		seed({
			pending: [
				{ root: WFC, number: 1, prompt: "/triage 1" },
				{ root: WFC, number: 2, prompt: "/triage 2" },
			],
		});
		dropTried(file, [{ root: WFC, issues: [1] }], throwOnLog);
		expect(
			readGateStore(file, throwOnLog).pending.map(
				(j: { number: number }) => j.number,
			),
		).toEqual([2]);
	});

	it("reads a damaged store as empty, logging its path (#3380)", () => {
		fs.writeFileSync(file, "{ not json");
		const lines: string[] = [];
		expect(readGateStore(file, (l: string) => lines.push(l)).pending).toEqual(
			[],
		);
		expect(lines).toEqual([expect.stringContaining(`${file} is damaged`)]);
	});

	it("keeps readings and the last sweep's start, so a restarted loop sweeps on cadence and queues nothing on an unchanged reading", async () => {
		const stdout = envelope([row(2046, "3 of 4 runs ended")]);
		await sweepOnce(stdout);
		dropTried(file, [{ root: WFC, issues: [2046] }], throwOnLog);

		const restarted = gateSweeper({
			file,
			runRoot: async () => ({ stdout }),
			log: () => undefined,
			cadenceMs: GATE_SWEEP_MS,
		});
		expect(restarted.startIfDue([WFC], NOW + GATE_SWEEP_MS - 1)).toBeNull();
		await restarted.startIfDue([WFC], NOW + GATE_SWEEP_MS);
		const store = readGateStore(file, throwOnLog);
		expect(store.pending).toEqual([]);
		expect(store.readings[`${WFC}#2046`]).toBe("3 of 4 runs ended");
		expect(store.lastSweepAt).toBe(NOW + GATE_SWEEP_MS);
	});
});

describe("never inside a tick", () => {
	it("returns while its child still runs, so ticks run beside it, reading busy, and starts no second sweep", async () => {
		const release = path.join(dir, "release");
		const script = path.join(dir, "held.js");
		fs.writeFileSync(
			script,
			`const fs = require("node:fs");
			const t = setInterval(() => {
				if (!fs.existsSync(${JSON.stringify(release)})) return;
				clearInterval(t);
				process.stdout.write(${JSON.stringify(envelope([row(3, "x")]))});
			}, 20);`,
		);
		const sweeper = gateSweeper({
			file,
			runRoot: (root: string) =>
				runCheckGates(root, { env: process.env, script }),
			log: () => undefined,
			cadenceMs: GATE_SWEEP_MS,
		});
		let done = false;
		const sweep = sweeper.startIfDue([dir], NOW);
		sweep.then(() => {
			done = true;
		});
		// Two stand-in ticks, each a full read of the store, while the child is held.
		for (let tick = 0; tick < 2; tick++) {
			await new Promise((r) => setImmediate(r));
			expect(done).toBe(false);
			expect(readGateStore(file, throwOnLog).pending).toEqual([]);
		}
		expect(sweeper.startIfDue([dir], NOW + GATE_SWEEP_MS)).toBeNull();
		// The loop adopts no new code while this reads true (#2361).
		expect(sweeper.busy()).toBe(true);
		fs.writeFileSync(release, "");
		await sweep;
		expect(sweeper.busy()).toBe(false);
		expect(readGateStore(file, throwOnLog).pending).toHaveLength(1);
	});
});

describe("the decision core launches a queued judgement", () => {
	const judgement = { root: WFC, number: 2046, prompt: "/triage 2046 — judge" };
	const tick = (over: Record<string, unknown> = {}) =>
		decideTick({
			now: NOW,
			startedAt: NOW - 1000,
			stopRequested: false,
			frontier: [],
			retroBundles: [],
			running: [],
			freeSlots: 2,
			lastPromptAt: null,
			seats: [{ seat: "~/.claude3", week: 40, session: 20, fits: 9 }],
			ceilings: { week: 90, session: 90 },
			history: [],
			judgements: [judgement],
			...over,
		});

	it("launches it, once, ahead of the ranking", () => {
		const d = tick({
			frontier: [
				{
					root: WFC,
					number: 1,
					urgent: false,
					goal: false,
					stallDays: 0,
					asksQuestions: false,
					reach: 0,
					collision: "comment-only",
					takes: ["implement"],
					labels: ["takes:implement"],
				},
			],
			freeSlots: 1,
		});
		expect(d.launches).toEqual([
			expect.objectContaining({
				root: WFC,
				issues: [2046],
				prompt: judgement.prompt,
				gate: true,
			}),
		]);
	});

	it("launches none while a session runs on its issue", () => {
		const d = tick({ running: [{ root: WFC, issues: [2046] }] });
		expect(d.launches).toEqual([]);
	});
});
