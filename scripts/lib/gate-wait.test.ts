// @vitest-environment node
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";
import type { PartAdmission } from "./part-suite-peak.js";

const { waitForGate } = require("./gate-wait.js");
const { queueSeat } = require("./suite-queue.js");

const noQueue = () => "admitted" as const;

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function qdir() {
	const d = mkScratchDir("queue-");
	dirs.push(d);
	return d;
}

const seatStamps = (queue: object) => queueSeat({ queue, join: false }).stamps;

describe("waitForGate's load hold, before the gate's last read (#2622)", () => {
	it("reads the gate and the turn again after the hold, and only then admits", async () => {
		const order: string[] = [];
		const outcome = await waitForGate({
			gate: () => {
				order.push("gate");
				return null;
			},
			turn: () => {
				order.push("turn");
				return true;
			},
			hold: () => {
				order.push("hold");
				return Promise.resolve(true);
			},
			admit: () => {
				order.push("admit");
				return "admitted";
			},
			out: { write: () => true },
		});
		expect(outcome).toBe("run");
		expect(order).toEqual(["gate", "turn", "hold", "gate", "turn", "admit"]);
	});

	it("waits again, and holds again, where the gate closed during the hold", async () => {
		const gates = [null, { limb: "count" }, null, null];
		const hold = vi.fn(() => Promise.resolve(true));
		const sleepFn = vi.fn(() => Promise.resolve());
		const outcome = await waitForGate({
			gate: () => gates.shift() ?? null,
			hold,
			admit: noQueue,
			sleepFn,
			out: { write: () => true },
		});
		expect(outcome).toBe("run");
		expect(sleepFn).toHaveBeenCalledTimes(1);
		expect(hold).toHaveBeenCalledTimes(2);
	});

	it("refuses, admitting nothing, where the hold refuses", async () => {
		const admit = vi.fn(() => "admitted");
		const exits: unknown[] = [];
		const outcome = await waitForGate({
			gate: () => null,
			hold: () => Promise.resolve(false),
			admit,
			onExit: (reason: string) => exits.push(reason),
			out: { write: () => true },
		});
		expect(outcome).toBe("refused");
		expect(exits).toEqual(["refused"]);
		expect(admit).not.toHaveBeenCalled();
	});

	it("re-reads at once after yielding ahead, and after a poll when behind", async () => {
		const sleeps = async (yields: string) => {
			const admissions = [yields, "admitted"];
			const sleepFn = vi.fn(() => Promise.resolve());
			await waitForGate({
				gate: () => null,
				admit: () => admissions.shift(),
				sleepFn,
				out: { write: () => true },
			});
			return sleepFn.mock.calls.length;
		};
		expect([await sleeps("ahead"), await sleeps("behind")]).toEqual([0, 1]);
	});

	const atCeiling = (options: object) => {
		const said: string[] = [];
		const outcome = waitForGate({
			timeoutMs: 0,
			part: true,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => said.push(line) },
			...options,
		});
		return { outcome, said };
	};

	it("holds at its ceiling, then reads the gate again before it runs anyway", async () => {
		const order: string[] = [];
		const { outcome, said } = atCeiling({
			gate: () => {
				order.push("gate");
				return { limb: "count" };
			},
			hold: () => {
				order.push("hold");
				return Promise.resolve(true);
			},
			admit: () => {
				order.push("admit");
				return "admitted";
			},
		});
		expect(await outcome).toBe("run");
		expect(order).toEqual(["gate", "hold", "gate", "admit"]);
		expect(said.join("")).toMatch(/running anyway/);
	});

	it("refuses at its ceiling on the memory rung the gate reads after the hold", async () => {
		const gates = [{ limb: "count" }, { limb: "memory", mb: 900 }];
		const { outcome, said } = atCeiling({
			gate: () => gates.shift(),
			hold: () => Promise.resolve(true),
		});
		expect(await outcome).toBe("refused");
		expect(said.join("")).toMatch(/denies on memory/);
	});

	it("yields at its ceiling to another admitted launch, and runs a poll later", async () => {
		const admissions = ["ahead", "admitted"];
		const sleepFn = vi.fn(() => Promise.resolve());
		const { outcome } = atCeiling({
			gate: () => ({ limb: "count" }),
			admit: () => admissions.shift(),
			sleepFn,
		});
		expect(await outcome).toBe("run");
		expect(sleepFn).toHaveBeenCalledTimes(1);
	});
});

describe("waitForGate, the wait itself (mantahostels#2024)", () => {
	it("refuses a wait with no admit before reading the gate (#2742)", () => {
		const gate = vi.fn(() => null);
		expect(() => waitForGate({ gate })).toThrow(/`admit` is required/);
		expect(gate).not.toHaveBeenCalled();
	});

	it("refuses a wait with no gate, which would otherwise never hold", () => {
		expect(() => waitForGate({ admit: noQueue })).toThrow(/`gate` is required/);
	});

	it("says so when it waited", async () => {
		const lines: string[] = [];
		let closed = 1;
		await waitForGate({
			gate: () => closed-- > 0,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => lines.push(line) },
		});
		expect(lines.join("")).toMatch(/waiting for it/);
		expect(lines.join("")).toMatch(/gate opened/);
	});

	describe("tracing the limb that holds it (#4359)", () => {
		const traced = async (polls: object[], traceLimbs: boolean) => {
			const lines: string[] = [];
			let now = 0;
			await waitForGate({
				gate: () => polls.shift() ?? null,
				admit: noQueue,
				monoClock: () => now,
				sleepFn: () => {
					now += 10_000;
					return Promise.resolve();
				},
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs,
			});
			return lines;
		};
		const gates = () => [
			{ limb: "count", pids: [7] },
			{ limb: "count", pids: [7] },
			{ limb: "memory", mb: 2000, rungMb: 2750 },
			{ limb: "memory", mb: 2100, rungMb: 2750, climbMb: 300 },
			{ limb: "count", pids: [8] },
		];

		it("prints each change of limb or holder, never a moving MemAvailable, and the time on each as the gate opens", async () => {
			expect(await traced(gates(), true)).toEqual([
				"q: waiting\n",
				"q: after 0s, held on the count cap, PID 7\n",
				"q: after 20s, held on the memory rung, MemAvailable 2000 MB against ~2750 MB\n",
				"q: after 40s, held on the count cap, PID 8\n",
				"q: gate opened after 50s — held 30s on the count cap, 20s on the memory rung; MemAvailable at lowest 2000 MB\n",
			]);
		});

		it("names every limb failing on the poll, not the gate's first alone", async () => {
			const lines: string[] = [];
			let turns = 0;
			await waitForGate({
				gate: () =>
					turns < 1
						? { limb: "count", pids: [7], memory: { mb: 2000, rungMb: 2750 } }
						: null,
				turn: () => turns++ > 0,
				admit: noQueue,
				sleepFn: () => Promise.resolve(),
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines[1]).toBe(
				"q: after 0s, held on the count cap, PID 7; also on the memory rung, MemAvailable 2000 MB against ~2750 MB; also on the queue's turn\n",
			);
		});

		it("rounds the breakdown so its parts sum to the whole", async () => {
			const lines: string[] = [];
			let now = 0;
			const polls: object[] = [{ limb: "count" }, { limb: "memory" }];
			await waitForGate({
				gate: () => polls.shift() ?? null,
				admit: noQueue,
				monoClock: () => now,
				sleepFn: () => {
					now += 1500;
					return Promise.resolve();
				},
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines.at(-1)).toBe(
				"q: gate opened after 3s — held 2s on the count cap, 1s on the memory rung\n",
			);
		});

		it("sums the parts to the printed whole where the float sum would not, counting the first stretch to its limb", async () => {
			const lines: string[] = [];
			let now = 0;
			const steps = [1003, 2377];
			const polls: object[] = [
				{ limb: "count" },
				{ limb: "memory" },
				{ limb: "count", pids: [9] },
			];
			await waitForGate({
				gate: () => {
					if (now === 0) now = 120;
					return polls.shift() ?? null;
				},
				admit: noQueue,
				monoClock: () => now,
				sleepFn: () => {
					now += steps.shift() ?? 0;
					return Promise.resolve();
				},
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines.at(-1)).toBe(
				"q: gate opened after 4s — held 1s on the count cap, 3s on the memory rung\n",
			);
		});

		it("keeps the lowest MemAvailable a count-cap poll read beside it", async () => {
			const lines: string[] = [];
			const polls: object[] = [
				{ limb: "count", pids: [7], memory: { mb: 1800, rungMb: 2750 } },
			];
			await waitForGate({
				gate: () => polls.shift() ?? null,
				admit: noQueue,
				sleepFn: () => Promise.resolve(),
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines.at(-1)).toMatch(
				/^q: gate opened after 0s — held 0s on the count cap; MemAvailable at lowest 1800 MB\n$/,
			);
		});

		it("prints none of it untraced", async () => {
			expect(await traced(gates(), false)).toEqual([
				"q: waiting\n",
				"q: gate opened after 50s\n",
			]);
		});

		it("breaks a wait refused at its bound down by limb", async () => {
			const lines: string[] = [];
			await waitForGate({
				gate: () => ({ limb: "memory", mb: 1000, rungMb: 2750 }),
				admit: noQueue,
				timeoutMs: 0,
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines.slice(0, 3)).toEqual([
				"q: waiting\n",
				"q: after 0s, held on the memory rung, MemAvailable 1000 MB against ~2750 MB\n",
				"q: held 0s on the memory rung; MemAvailable at lowest 1000 MB\n",
			]);
		});
	});

	it("admits no run its own memory rung refuses, its turn open (#3058)", async () => {
		const admit = vi.fn(noQueue);
		const outcome = await waitForGate({
			gate: () => ({ limb: "memory" }),
			turn: () => true,
			admit,
			part: true,
			timeoutMs: 0,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
		});
		expect(outcome).toBe("refused");
		expect(admit).not.toHaveBeenCalled();
	});

	it("tells its caller each time the memory rung starts or stops holding it (#3058)", async () => {
		const gates = [
			{ limb: "memory" },
			{ limb: "memory" },
			{ limb: "count" },
			null,
		];
		const heard: boolean[] = [];
		await waitForGate({
			gate: () => gates.shift() ?? null,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
			onMemoryHeld: (held: boolean) => heard.push(held),
		});
		expect(heard).toEqual([true, false]);
	});

	it("tells its caller the rung a memory hold waits on, each time it changes (#5555)", async () => {
		const gates = [
			{ limb: "memory", rungMb: 3350 },
			{ limb: "memory", rungMb: 3350 },
			{ limb: "memory", rungMb: 2950 },
			{ limb: "count" },
			null,
		];
		const heard: number[] = [];
		await waitForGate({
			gate: () => gates.shift() ?? null,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
			onMemoryRung: (rungMb: number) => heard.push(rungMb),
		});
		expect(heard).toEqual([3350, 2950]);
	});

	it("ends the wait early, and says why, where the check answers a base (#1158)", async () => {
		const lines: string[] = [];
		const left = await waitForGate({
			gate: () => true,
			leave: () => "abc123",
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => lines.push(line) },
		});
		expect(left).toBe("left");
		expect(lines.join("")).toMatch(/abc123 reaches no test file/);
		expect(lines.join("")).not.toMatch(/gate opened/);
	});
});

describe("waitForGate's timeout, judged on the last poll (#2421, #2714)", () => {
	const Memory = { limb: "memory", mb: 900, rungMb: 3250 };
	const Count = { limb: "count" };
	const Climb = (climbMb: number, mb = 4000) => ({
		limb: "memory",
		mb,
		rungMb: 2750,
		climbMb,
	});

	const timedWait = async (
		limbs: (object | null)[],
		{
			part = false,
			turn = (): boolean => true,
			hold,
		}: {
			part?: boolean;
			turn?: () => boolean;
			hold?: () => Promise<boolean>;
		} = {},
	) => {
		let now = 0;
		let poll = 0;
		const said: string[] = [];
		const exits: unknown[][] = [];
		const outcome = await waitForGate({
			monoClock: () => now,
			gate: () => {
				now += 10;
				return limbs[Math.min(poll++, limbs.length - 1)];
			},
			timeoutMs: 30,
			part,
			turn,
			...(hold ? { hold } : {}),
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (s: string) => said.push(s) },
			onExit: (...args: unknown[]) => exits.push(args),
		});
		return { outcome, said: said.join(""), exits, polls: poll };
	};

	it("records the admission a given gate hears on its exit line, as a seat's does (#5366)", async () => {
		const admission: PartAdmission = {
			mode: "peak",
			kind: "touched",
			bucket: "2-4",
			p99Mb: 900,
			rungMb: 2000,
			climbMb: 0,
			samples: 40,
		};
		const exits: unknown[][] = [];
		await waitForGate({
			gate: (_climb: number, hear?: (a: PartAdmission) => void) => {
				hear?.(admission);
				return null;
			},
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
			onExit: (...args: unknown[]) => exits.push(args),
		});
		expect(exits).toEqual([["opened", expect.any(Number), { admission }]]);
	});

	it("names a part-suite's own peak in a memory hold's text (#5366)", async () => {
		const said: string[] = [];
		const limbs = [
			{
				limb: "memory",
				mb: 1500,
				rungMb: 1750,
				climbMb: 300,
				peak: { kind: "named", bucket: "1", p99Mb: 609, samples: 683 },
			},
			null,
		];
		let poll = 0;
		await waitForGate({
			gate: () => limbs[Math.min(poll++, limbs.length - 1)] ?? null,
			traceLimbs: true,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (text: string) => said.push(text) },
		});
		expect(said.join("")).toContain(
			"against ~1750 MB, the rung of a named part-suite of 1 file(s), whose p99 peak over 683 runs in 7 days is 609 MB",
		);
	});

	it("records the highest charge that held a wait, on whichever exit ends it (#3806)", async () => {
		const opened = await timedWait([Climb(1400), Climb(1900), null]);
		expect(opened.exits).toEqual([["opened", 30, { climbMb: 1900 }]]);
		const refused = await timedWait([Climb(1900), Climb(1400), Climb(1400)]);
		expect(refused.exits).toEqual([
			["refused", 30, { limb: "memory", climbMb: 1900 }],
		]);
	});

	it("keeps the highest charge for a killed wait's exit line (#3806)", async () => {
		const stamps = seatStamps({ queueDir: qdir() });
		expect(stamps.polledHold()).toEqual({});
		let polls = 0;
		const limbs = [Climb(1900), Climb(1400), null];
		await waitForGate({
			...stamps,
			climbMb: () => 0,
			gate: () => limbs[polls++],
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
		});
		expect(stamps.polledHold()).toEqual({ climbMb: 1900 });
	});

	it("records no charge where the reading alone sat under the rung (#3806)", async () => {
		const wait = await timedWait([Climb(1900, 2000), null]);
		expect(wait.exits).toEqual([["opened", 20]]);
	});

	it("refuses a wait the memory rung holds at the last poll, naming the reading and the reap", async () => {
		const wait = await timedWait([Count, Count, Memory]);
		expect(wait.polls).toBe(3);
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "memory" }]]);
		expect(wait.said).toMatch(
			/gate still denies on memory after 0s \(MemAvailable 900 MB against the ~3250 MB rung\) — refused, not run/,
		);
		expect(wait.said).toMatch(/reap-finished-sessions\.js/);
		expect(wait.said).not.toMatch(/running anyway/);
	});

	it("refuses a whole suite the count cap holds at the bound, naming the bound and holding nothing", async () => {
		const hold = vi.fn(() => Promise.resolve(true));
		const wait = await timedWait([Memory, Memory, Count], { hold });
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "count" }]]);
		expect(wait.said).toMatch(
			/gate still denies on its count cap after 0s, the queue's 0-minute wait bound — refused, not run/,
		);
		expect(wait.said).not.toMatch(/running anyway/);
		expect(hold).not.toHaveBeenCalled();
	});

	it("refuses a whole suite whose turn is still closed at the bound", async () => {
		const wait = await timedWait([null], { turn: () => false });
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "turn" }]]);
		expect(wait.said).toMatch(
			/turn still closed after 0s, .* — refused, not run/,
		);
	});

	describe("the peer limb on the exit line (#4765)", () => {
		const peerHold = () => ({
			limb: "peer" as const,
			holders: [{ pid: 7, queue: "wfc-tsc-queue" }],
		});
		const peerWait = async (
			limbs: (typeof Memory | null)[],
			extra: Partial<Parameters<typeof waitForGate>[0]> = {},
		) => {
			let now = 0;
			let poll = 0;
			const said: string[] = [];
			const exits: unknown[][] = [];
			const outcome = await waitForGate({
				monoClock: () => now,
				gate: () => {
					now += 10_000;
					return limbs[Math.min(poll++, limbs.length - 1)] ?? null;
				},
				timeoutMs: 30_000,
				turn: () => false,
				turnHold: peerHold,
				admit: noQueue,
				sleepFn: () => Promise.resolve(),
				out: { write: (s: string) => said.push(s) },
				onExit: (...args: unknown[]) => exits.push(args),
				...extra,
			});
			return { outcome, said: said.join(""), exits };
		};

		it("refuses a wait a peer holds at the bound on `peer`, with the seconds it held", async () => {
			const wait = await peerWait([Memory, null]);
			expect(wait.outcome).toBe("refused");
			expect(wait.exits).toEqual([
				["refused", 30_000, { limb: "peer", peerS: 10 }],
			]);
			expect(wait.said).toMatch(
				/turn still closed on an older waiter in the other queue the climb charge holds after 30s/,
			);
		});

		it("names a part-suite run past the bound on `peer`", async () => {
			const wait = await peerWait([null], { part: true });
			expect(wait.exits).toEqual([
				["timeout", 30_000, { limb: "peer", peerS: 30 }],
			]);
		});

		it("gives a killed wait's line the peer seconds to its last poll", async () => {
			const stamps = seatStamps({ queueDir: qdir() });
			await peerWait([null], { ...stamps, climbMb: () => 0 });
			expect(stamps.polledHold()).toEqual({ peerS: 30 });
		});
	});

	it("names the default bound in minutes", async () => {
		let now = 0;
		const said: string[] = [];
		await waitForGate({
			monoClock: () => now,
			gate: () => {
				now += 40 * 60 * 1000;
				return { limb: "count" };
			},
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (s: string) => said.push(s) },
		});
		expect(said.join("")).toMatch(/the queue's 40-minute wait bound/);
	});

	it("runs a part-suite anyway where the count cap or the turn holds the last poll", async () => {
		const count = await timedWait([Memory, Memory, Count], { part: true });
		expect(count.outcome).toBe("run");
		expect(count.exits).toEqual([["timeout", 30, { limb: "count" }]]);
		expect(count.said).toMatch(/running anyway/);
		const turn = await timedWait([null], { part: true, turn: () => false });
		expect(turn.outcome).toBe("run");
		expect(turn.exits).toEqual([["timeout", 30, { limb: "turn" }]]);
	});

	it("refuses a part-suite the memory rung holds at the last poll", async () => {
		const wait = await timedWait([Count, Count, Memory], { part: true });
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "memory" }]]);
	});
});

describe("waitForGate on the turn and the climb charge it reads", () => {
	it("keeps waiting on an open gate while it is not this waiter's turn", async () => {
		let turns = 3;
		const sleepFn = vi.fn(() => Promise.resolve());
		await waitForGate({
			gate: () => false,
			turn: () => turns-- <= 0,
			admit: noQueue,
			sleepFn,
			out: { write: () => true },
		});
		expect(sleepFn).toHaveBeenCalledTimes(3);
	});

	it("stamps a wait the climb alone holds, never one MemAvailable itself fails", async () => {
		const heard: boolean[] = [];
		const polls = [
			{ limb: "memory", mb: 3000, rungMb: 2750, climbMb: 500 },
			{ limb: "memory", mb: 2000, rungMb: 2750, climbMb: 500 },
			{ limb: "memory", mb: 3000, rungMb: 2750, climbMb: 500 },
		];
		await waitForGate({
			gate: () => polls.shift() ?? null,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
			onClimbStamp: (held: boolean) => heard.push(held),
		});
		expect(heard).toEqual([true, false, true, false]);
	});

	it("names the charge apart from the reading when the rung refuses at the bound", async () => {
		const said: string[] = [];
		await waitForGate({
			gate: (climbMb: number) => ({
				limb: "memory",
				mb: 3000,
				rungMb: 3250,
				climbMb,
			}),
			climbMb: () => 700,
			timeoutMs: 0,
			admit: noQueue,
			out: { write: (s: string) => said.push(s) },
		});
		expect(said.join("")).toMatch(
			/\(MemAvailable 3000 MB, less 700 MB the other queue's launches have yet to draw, against the ~3250 MB rung\)/,
		);
	});
});
