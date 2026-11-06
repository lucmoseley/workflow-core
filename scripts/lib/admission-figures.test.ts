// @vitest-environment node
/*
 * Pins the admission arithmetic both of admission.js's verdicts read (#4263):
 * each rule once, on its figures. Loosen a case and a session can be admitted
 * past the machine's 10 GB cap, which freezes it, or a free slot held shut.
 *
 * A 3700 MB budget fits 4 at 3058, not 5 at 3736; a 1300 MB budget fits 1 at
 * p95 (929, not 1666) and 2 at the 600 MB mean.
 */
import { describe, expect, it } from "vitest";
import { admissionFigures } from "./admission-figures";

/* earlyoom's kill line, and the margin above it every budget holds free. */
const FLOOR = 794;
const HELD = FLOOR + 300;

type Readings = NonNullable<Parameters<typeof admissionFigures>[2]>;
type Procs = Parameters<typeof admissionFigures>[1];
type Mem = Parameters<typeof admissionFigures>[0];

const host = { meanMb: 600, sigmaMb: 200, declared: true };
const figures = (mem: Mem, procs: Procs, readings: Readings = {}) =>
	admissionFigures(mem, procs, { host, ...readings });
/* The figures of a memory reading, which every case but one takes. */
const measured = (mem: Mem, procs: Procs, readings?: Readings) => {
	const f = figures(mem, procs, readings);
	if (!f.memRead) throw new Error("memory unread");
	return f;
};

const roomy = { ok: true as const, mb: 4000 + FLOOR };
const tight = { ok: true as const, mb: 1300 + HELD };
const scant = { ok: true as const, mb: 100 };
const one = { ok: true as const, sessions: 1, working: 0 };
const none = { ok: true as const, sessions: 0, working: 0 };
const working = { ok: true as const, sessions: 3, working: 2, self: true };
const over = { overloaded: true, load1: 60, ceiling: 48 };
const capped = {
	ceiling: 3,
	sessions: 2,
	idleSpares: 0,
	slots: 1,
	full: false,
	unknown: null,
};

describe("the CPU limb (#830, #834)", () => {
	it("holds every slot over the load ceiling, the guarantee included, keeping the memory figures", () => {
		const f = measured(roomy, one, { load: over });
		expect(f.byMemory).toBe(4);
		expect(f.memorySlots).toBe(4);
		expect(f.slots).toBe(0);
		expect(f.liftedCapped).toBe(0);
		const alone = measured(scant, none, { load: over });
		expect(alone.guaranteed).toBe(true);
		expect(alone.memorySlots).toBe(1);
		expect(alone.slots).toBe(0);
	});

	it("caps the slots at the session ceiling, the guarantee included (#2141)", () => {
		const f = measured(roomy, one, { cpu: capped });
		expect(f.slots).toBe(1);
		expect(f.liftedCapped).toBe(1);
		const full = { ...capped, sessions: 3, slots: 0, full: true };
		expect(measured(scant, none, { cpu: full }).slots).toBe(0);
	});

	it("changes nothing where the load and ps are unread", () => {
		const f = measured(roomy, one);
		expect(f.slots).toBe(4);
		expect(f.liftedCapped).toBe(4);
	});
});

describe("the session floor (#2501, #2507)", () => {
	it("lifts the slots toward the floor, counting working sessions and this one", () => {
		const f = measured(tight, working, { sessionFloor: 6 });
		expect(f.byMemory).toBe(1);
		expect(f.floor).toMatchObject({
			sessionFloorWorking: 3,
			sessionFloorSlots: 2,
			sessionFloorLifted: true,
		});
		expect(f.liftedSlots).toBe(2);
		expect(f.slots).toBe(2);
	});

	it("never lowers the p95 slots, and grants none where none is declared", () => {
		const met = measured(tight, working, { sessionFloor: 3 });
		expect(met.slots).toBe(1);
		expect(met.floor.sessionFloorLifted).toBe(false);
		expect(measured(tight, working).floor.sessionFloorSlots).toBe(0);
	});

	it("names no lift where the always-admit-one guarantee already gives the slot", () => {
		const alone = { ok: true as const, sessions: 0, working: 0, self: true };
		const f = measured({ ok: true, mb: 700 + HELD }, alone, {
			sessionFloor: 2,
		});
		expect(f.guaranteed).toBe(true);
		expect(f.floor.sessionFloorSlots).toBe(1);
		expect(f.floor.sessionFloorLifted).toBe(false);
		expect(f.liftedSlots).toBe(1);
	});

	it("is capped by the CPU, and held at 0 by an overload", () => {
		const cpu = measured(tight, working, { cpu: capped, sessionFloor: 6 });
		expect(cpu.memorySlots).toBe(2);
		expect(cpu.slots).toBe(1);
		const load = measured(tight, working, { load: over, sessionFloor: 6 });
		expect(load.floor.sessionFloorSlots).toBe(2);
		expect(load.slots).toBe(0);
	});

	it("grants no floor slot while the swap hold binds, keeping the p95 slot (#2690)", () => {
		const swapHold = {
			held: true as const,
			swapFreeMb: 245,
			swapTotalMb: 2048,
			availableMb: 1300 + HELD,
		};
		const f = measured(tight, working, { sessionFloor: 6, swapHold });
		expect(f.slots).toBe(1);
		expect(f.floor.sessionFloorSlots).toBe(0);
		expect(f.floor.sessionFloorLifted).toBe(false);
		expect(f.floor.swapHold).toEqual(swapHold);
	});

	it("grants no floor and no guarantee where the session count is unread", () => {
		const f = measured(
			scant,
			{ ok: false, error: "x" },
			{
				sessionFloor: 6,
			},
		);
		expect(f.guaranteed).toBe(false);
		expect(f.floor.sessionFloorSlots).toBe(0);
		expect(f.slots).toBe(0);
	});

	it("yields no figures where memory is unread, only its error", () => {
		const f = figures({ ok: false, error: "x" }, working, { sessionFloor: 6 });
		expect(f.memRead).toBe(false);
		expect(f).toMatchObject({ error: "x" });
		expect(f.floor.sessionFloorSlots).toBe(0);
	});
});

describe("the per-slot pending pair (#2511, #2568)", () => {
	it("charges each slot past the first its own pair", () => {
		// 4 at 3058 plus 3 pairs is 3808, 3 at 2370 plus 2 is 2870
		const f = measured(roomy, one, { launchMb: 250 });
		expect(f.byMemory).toBe(3);
		expect(f.needAtMb).toBe(2370 + 2 * 250);
		expect(f.nextNeedMb).toBe(3058 + 3 * 250);
	});

	it("charges nothing without a launch price", () => {
		expect(measured(roomy, one).byMemory).toBe(4);
	});
});

describe("the readings' failed reads", () => {
	it("reserves nothing for an unread pool and credits nothing unread, keeping each error", () => {
		const f = measured(roomy, one, {
			overhead: { ok: false, error: "pool" },
			reclaimable: { ok: false, error: "reap" },
		});
		expect(f.reservedMb).toBe(0);
		expect(f.reclaimedMb).toBe(0);
		expect(f.reservedError).toBe("pool");
		expect(f.reclaimableError).toBe("reap");
	});

	it("clamps memory less a reserve larger than it at 0", () => {
		const f = measured(scant, one, { overhead: { ok: true, mb: 800 } });
		expect(f.effectiveMb).toBe(0);
		expect(f.budgetMb).toBe(-HELD);
	});
});
