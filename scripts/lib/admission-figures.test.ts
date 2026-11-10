// @vitest-environment node
/*
 * Pins the admission arithmetic both of admission.js's verdicts read (#4263):
 * each rule once, on its figures. Loosen a case and a session can be admitted
 * past the machine's 10 GB cap, which freezes it, or a free slot held shut.
 *
 * A 3700 MB budget fits 4 at 3058, not 5 at 3736.
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
const scant = { ok: true as const, mb: 100 };
const one = { ok: true as const, sessions: 1 };
const none = { ok: true as const, sessions: 0 };
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
		expect(f.freeSlots).toBe(0);
		const alone = measured(scant, none, { load: over });
		expect(alone.guaranteed).toBe(true);
		expect(alone.memorySlots).toBe(1);
		expect(alone.slots).toBe(0);
	});

	it("caps the slots at the session ceiling, the guarantee included (#2141)", () => {
		const f = measured(roomy, one, { cpu: capped });
		expect(f.slots).toBe(1);
		expect(f.freeSlots).toBe(1);
		const full = { ...capped, sessions: 3, slots: 0, full: true };
		expect(measured(scant, none, { cpu: full }).slots).toBe(0);
	});

	it("changes nothing where the load and ps are unread", () => {
		const f = measured(roomy, one);
		expect(f.slots).toBe(4);
		expect(f.freeSlots).toBe(4);
	});
});

describe("the type-check reserve and the Windows limbs (#4956)", () => {
	const fresh = (mb: number) => ({ state: "fresh" as const, mb, ageS: 30 });
	const plain = measured(roomy, one);

	it("holds back a type-check's charge, less the share each live session's draw already carries", () => {
		const live = {
			sessions: 2,
			meanMb: 1200,
			varianceMb2: 80_000,
			pssMb: 1665,
			unread: 0,
			noProcess: 0,
			problems: [],
		};
		const bare = measured(roomy, one, { live });
		const f = measured(roomy, one, { live, typecheckChargeMb: 1497 });
		expect(f.typecheckReserveMb).toBe(1497 - 2 * 147);
		expect(f.budgetMb).toBe(bare.budgetMb - f.typecheckReserveMb);
		expect(f.byMemory).toBeLessThan(bare.byMemory);
		const many = { ...live, sessions: 11 };
		expect(
			measured(roomy, one, { live: many, typecheckChargeMb: 1497 }),
		).toMatchObject({ typecheckReserveMb: 0, budgetMb: bare.budgetMb });
	});

	it("takes off the budget the guest free memory Windows cannot back above its floor", () => {
		const f = measured(roomy, one, { windows: fresh(1500), guestFreeMb: 3000 });
		expect(f.windowsChargeMb).toBe(2500);
		expect(f.budgetMb).toBe(plain.budgetMb - 2500);
		expect(f.byMemory).toBe(1);
		expect(f.windowsCapped).toBe(true);
	});

	it("charges Windows nothing for a session that fits in memory the VM already holds", () => {
		for (const guestFreeMb of [0, 500]) {
			const f = measured(roomy, one, { windows: fresh(1500), guestFreeMb });
			expect(f).toMatchObject({
				windowsChargeMb: 0,
				windowsCapped: false,
				byMemory: plain.byMemory,
				slots: plain.slots,
			});
		}
	});

	it("charges all the guest's free memory, and no page cache, where Windows is under its floor", () => {
		const f = measured(roomy, one, { windows: fresh(800), guestFreeMb: 100 });
		expect(f.windowsChargeMb).toBe(100);
		expect(
			measured(roomy, one, { windows: fresh(800), guestFreeMb: 0 }),
		).toMatchObject({ windowsChargeMb: 0, slots: plain.slots });
	});

	it.each([
		["a stale reading", { state: "stale" as const, why: "old" }, 3000],
		["no memwatch", { state: "absent" as const }, 3000],
		["unread guest free memory", fresh(1500), null],
	])("charges nothing on %s", (_name, windows, guestFreeMb) => {
		const f = measured(roomy, one, { windows, guestFreeMb });
		expect(f.windowsChargeMb).toBe(0);
		expect(f.slots).toBe(plain.slots);
	});

	it("adds no session while a queued test run is held on Windows memory, the guarantee included, keeping the memory figures", () => {
		const f = measured(roomy, one, { testsHeld: 1 });
		expect(f.byMemory).toBe(4);
		expect(f.memorySlots).toBe(4);
		expect(f.slots).toBe(0);
		expect(f.freeSlots).toBe(0);
		const alone = measured(scant, none, { testsHeld: 2 });
		expect(alone.memorySlots).toBe(1);
		expect(alone.slots).toBe(0);
	});
});

describe("unread readings", () => {
	it("grants no guarantee where the session count is unread", () => {
		const f = measured(scant, { ok: false, error: "x" });
		expect(f.guaranteed).toBe(false);
		expect(f.slots).toBe(0);
	});

	it("yields no figures where memory is unread, only its error", () => {
		const f = figures({ ok: false, error: "x" }, one);
		expect(f.memRead).toBe(false);
		expect(f).toMatchObject({ error: "x" });
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
