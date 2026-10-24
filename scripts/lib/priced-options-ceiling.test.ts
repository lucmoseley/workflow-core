// @vitest-environment node
/*
 * The priced-options guard's ceiling policy, driven from priced-options-limbs.js's
 * rows alone (#1474): each group below is a row's prefix with a stand-in
 * reason, so no limb's check runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tier } from "./priced-options-limbs";

const { blockOn, ceilingPlan } = require("./priced-options-ceiling.js");
const { markersDir } = require("./marker-root.js");
const {
	LIMBS,
	SESSION_MAX,
	SESSION_PREFIX,
} = require("./priced-options-limbs.js");
const hookBlock = require("./hook-block.js");

interface Group {
	prefix: string;
	reasons: string[];
}

const group = (tier: Tier): Group => {
	const row = LIMBS.find((limb: { tier: Tier }) => limb.tier === tier);
	return { prefix: row.prefix, reasons: [`a ${tier} defect`] };
};

/* The ceiling counter standing at `spent`. */
const at = (spent: number) => (max: number) => spent >= max;

const plan = (tiers: Tier[], spent: number, afterBatch?: () => Group[]) =>
	ceilingPlan(tiers.map(group), at(spent), afterBatch);
const prefixesOf = (groups: Group[]) => groups.map((g) => g.prefix);
const prefixes = (tiers: Tier[]) => tiers.map((tier) => group(tier).prefix);

describe("the shape reserve", () => {
	it("holds the ceiling's last block back from a shape-only turn", () => {
		const p = plan(["shape"], SESSION_MAX - 1);
		expect(p.blocking).toEqual([]);
		expect(p.chargesCeiling).toBe(false);
	});

	it("spends it on a turn carrying a filing defect, shape riding along", () => {
		const p = plan(["shape", "filing"], SESSION_MAX - 1);
		expect(prefixesOf(p.blocking)).toEqual(prefixes(["shape", "filing"]));
		expect(p.chargesCeiling).toBe(true);
		expect(p.last).toBe(true);
	});

	it("warns one block sooner that shape is going dark", () => {
		expect(plan(["shape"], SESSION_MAX - 2).shapeLast).toBe(true);
		expect(plan(["shape"], 0).shapeLast).toBe(false);
	});
});

describe("the outside-ceiling tier", () => {
	it("blocks alone once the ceiling is spent, charging no ceiling", () => {
		const p = plan(["shape", "filing", "outside-ceiling"], SESSION_MAX);
		expect(prefixesOf(p.blocking)).toEqual(prefixes(["outside-ceiling"]));
		expect(p.chargesCeiling).toBe(false);
	});

	it("blocks a shape-only turn past the reserve", () => {
		const p = plan(["shape", "outside-ceiling"], SESSION_MAX - 1);
		expect(prefixesOf(p.blocking)).toEqual(prefixes(["outside-ceiling"]));
	});

	it("charges no ceiling blocking alone", () => {
		expect(plan(["outside-ceiling"], 0).chargesCeiling).toBe(false);
	});
});

/* Points the marker root at a fresh directory, so blockOn's counters start at 0. */
function useMarkerRoot() {
	let root: string;
	let saved: string | undefined;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ceiling-"));
		fs.mkdirSync(markersDir(root), { recursive: true });
		saved = process.env.WFC_REPO_ROOT;
		process.env.WFC_REPO_ROOT = root;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.WFC_REPO_ROOT;
		else process.env.WFC_REPO_ROOT = saved;
		fs.rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});
}

describe("a block shared with the outside-ceiling tier", () => {
	useMarkerRoot();

	it("writes one block, and charges the ceiling and each limb's own counter once", () => {
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const p = plan(["filing", "outside-ceiling"], 0);
		expect(blockOn(p, { sessionId: "sid" })).toBe(true);
		expect(out).toHaveBeenCalledTimes(1);
		for (const prefix of [
			...prefixes(["filing", "outside-ceiling"]),
			SESSION_PREFIX,
		])
			expect(hookBlock.readCount(prefix, "sid")).toBe(1);
	});
});

describe("the after-batch tier", () => {
	it("is not even read while anything else blocks", () => {
		const afterBatch = vi.fn(() => [group("after-batch")]);
		expect(prefixesOf(plan(["filing"], 0, afterBatch).blocking)).toEqual(
			prefixes(["filing"]),
		);
		plan(["outside-ceiling"], SESSION_MAX, afterBatch);
		expect(afterBatch).not.toHaveBeenCalled();
	});

	it("blocks when nothing else did, charging no ceiling", () => {
		for (const [tiers, spent] of [
			[[], 0],
			[["shape"], SESSION_MAX - 1],
			[["filing"], SESSION_MAX],
		] as [Tier[], number][]) {
			const p = plan(tiers, spent, () => [group("after-batch")]);
			expect(prefixesOf(p.blocking)).toEqual(prefixes(["after-batch"]));
			expect(p.chargesCeiling).toBe(false);
		}
	});
});

it("gives every row but the after-batch one hook-block.js's default cap", () => {
	for (const limb of LIMBS)
		if (limb.tier !== "after-batch")
			expect(limb.cap).toBe(hookBlock.MAX_BLOCKS);
});

describe("the ceiling's notices (#2062)", () => {
	useMarkerRoot();

	/* Each notice opens on its own sentence, so a reason is known to carry it. */
	const openers = [
		"last Stop block of the session",
		"will not refuse a turn for reply shape alone",
		"session ceiling is spent: only the",
	];

	/* The row goes onto LIMBS itself because no caller hands blockOn its rows;
	 * the fixture's prefix never blocks, so limbOf never looks it up. */
	const reasonsWith = (row: object) => {
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		LIMBS.push(row);
		try {
			[
				plan(["filing"], SESSION_MAX - 1),
				plan(["filing"], SESSION_MAX - 2),
				plan(["outside-ceiling"], SESSION_MAX),
			].forEach((p, n) => {
				blockOn(p, { sessionId: `sid-${String(n)}` });
			});
		} finally {
			LIMBS.pop();
		}
		const reasons = out.mock.calls.map(
			([chunk]) => JSON.parse(String(chunk)).reason as string,
		);
		expect(reasons).toHaveLength(openers.length);
		reasons.forEach((reason, n) => {
			expect(reason).toContain(openers[n]);
		});
		return reasons;
	};
	const fixture = (tier: Tier) => ({
		prefix: `.fixture-${tier}-nagged-`,
		tier,
		cap: 1,
		name: `fixture-${tier}`,
	});

	it("names a new outside-ceiling row in all three, by its row alone", () => {
		const reasons = reasonsWith({
			...fixture("outside-ceiling"),
			recordPrefix: ".fixture-record-",
		});
		for (const reason of reasons)
			expect(reason).toContain("fixture-outside-ceiling");
		expect(reasons[0]).toMatch(
			/the [^.]*fixture-outside-ceiling checks also on the shape of a question they refused/,
		);
	});

	it("names a new after-batch row in all three", () => {
		for (const reason of reasonsWith(fixture("after-batch")))
			expect(reason).toContain("fixture-after-batch");
	});
});
