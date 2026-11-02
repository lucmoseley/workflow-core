// @vitest-environment node
/*
 * The refill loop's goal refs (#3864): what `set` reads a typed ref as, and
 * which ticked repo it lands in. Loosen one and a number lands in the wrong repo.
 */
import { describe, expect, it } from "vitest";
import {
	buildGoalFlags,
	buildGoalLine,
	buildGoalProgress,
	goalProgressOf,
	parseAskedRefs,
	parseGoalForm,
	parseGoalProgress,
	qualifyOpenRefs,
	qualifyRefs,
} from "./refill-goal.js";

describe("a typed ref", () => {
	it("reads N, #N and <repo>#N, by comma or space", () => {
		expect(parseAskedRefs("12,#13 core#14")).toEqual([
			{ repo: null, number: 12 },
			{ repo: null, number: 13 },
			{ repo: "core", number: 14 },
		]);
	});

	it.each(["", "soon", "drain #5", "#0", "core#", "a/b#1", "core#1#2"])(
		"reads %j as no list of refs",
		(text) => {
			expect(parseAskedRefs(text)).toBeNull();
		},
	);
});

describe("a typed goal (#3866)", () => {
	it("reads drain and unblock with one ref, else a list of refs", () => {
		const ref = [{ repo: "core", number: 5 }];
		expect(parseGoalForm("drain core#5")).toEqual({ form: "drain", refs: ref });
		expect(parseGoalForm(" unblock   core#5 ")).toEqual({
			form: "unblock",
			refs: ref,
		});
		expect(parseGoalForm("core#5")).toEqual({ form: "issues", refs: ref });
	});

	it.each(["drain", "unblock ", "drain #1,#2", "drain #1 #2", "soon", ""])(
		"reads %j as no goal",
		(text) => {
			expect(parseGoalForm(text)).toBeNull();
		},
	);

	it("gives a walk the `set` flags a restart prints", () => {
		expect(
			buildGoalFlags({
				form: "drain",
				text: "drain #5",
				refs: [{ repo: "core", number: 5 }],
				setAt: 1,
			}),
		).toBe("--goal 'drain core#5'");
	});
});

describe("a goal's progress (#3866)", () => {
	const issue = { repo: "o/r", number: 2, title: "t" };
	const read = (set: (typeof issue)[], complete = true) => ({
		setAt: 7,
		set,
		takeable: set.length,
		running: 0,
		complete,
	});
	const goal = { form: "drain" as const, text: "drain #5", refs: [], setAt: 7 };

	it("finishes at the first complete read with nothing open, and keeps that time", () => {
		const done = buildGoalProgress(null, read([]), 100);
		expect(done).toMatchObject({ doneAt: 100, readAt: 100 });
		expect(buildGoalProgress(done, read([]), 200)).toMatchObject({
			doneAt: 100,
			readAt: 200,
		});
	});

	it("does not finish on a read that missed a shortlist", () => {
		expect(buildGoalProgress(null, read([], false), 100)?.doneAt).toBeNull();
	});

	it("goes live again when the set gains an open issue", () => {
		const done = buildGoalProgress(null, read([]), 100);
		expect(buildGoalProgress(done, read([issue]), 200)?.doneAt).toBeNull();
	});

	it("forgets a replaced goal's finish", () => {
		const done = buildGoalProgress(null, read([]), 100);
		const next = { ...read([]), setAt: 8 };
		expect(buildGoalProgress(done, next, 200)?.doneAt).toBe(200);
	});

	it("has none once the goal is cleared, and shows none for a goal no read reached", () => {
		const done = buildGoalProgress(null, read([]), 100);
		expect(buildGoalProgress(done, null, 200)).toBeNull();
		expect(goalProgressOf({ ...goal, setAt: 8 }, done)).toBeNull();
		expect(goalProgressOf(null, done)).toBeNull();
	});

	it("says the counts or the finish on the goal's line", () => {
		const live = buildGoalProgress(null, read([issue]), 100);
		expect(buildGoalLine(goal, live)).toContain(
			"— 1 open, 1 takeable, 0 running",
		);
		const done = buildGoalProgress(null, read([]), 0);
		expect(buildGoalLine(goal, done)).toContain(
			"— done 1970-01-01T00:00:00.000Z; running bare",
		);
		expect(buildGoalLine(goal)).not.toContain("—");
	});

	it("reads a garbled state field as no progress", () => {
		expect(parseGoalProgress({ set: "x" })).toBeNull();
		expect(parseGoalProgress({ setAt: 1, set: [] })).toBeNull();
		const done = buildGoalProgress(null, read([]), 100);
		expect(parseGoalProgress(done)).toEqual(done);
	});
});

describe("a ref's repo", () => {
	const bare = { repo: null, number: 5 };

	it("is the one ticked repo for a bare #N, each ref once", () => {
		expect(
			qualifyRefs([bare, { repo: "core", number: 5 }], ["/home/u/core"]),
		).toEqual([{ repo: "core", number: 5 }]);
	});

	it("refuses a bare #N unless exactly one repo is ticked", () => {
		for (const roots of [[], ["/home/u/core", "/home/u/manta"]])
			expect(qualifyRefs([bare], roots)).toContain(
				`#5 names no repo with ${roots.length} repos ticked`,
			);
	});

	it("refuses a ref to an unticked repo, naming it", () => {
		expect(
			qualifyRefs([{ repo: "manta", number: 5 }], ["/home/u/core"]),
		).toContain("tick manta first");
	});
});

describe("a ref read as an open issue", () => {
	const asked = [{ repo: "core", number: 5 }];
	const roots = ["/home/u/core"];

	it("passes an open issue", () => {
		expect(qualifyOpenRefs(asked, roots, () => ({ state: "OPEN" }))).toEqual(
			asked,
		);
	});

	it("refuses a closed one, naming it", () => {
		expect(qualifyOpenRefs(asked, roots, () => ({ state: "CLOSED" }))).toBe(
			"core#5 is closed: a goal names open issues",
		);
	});

	it("refuses one that will not read, naming why", () => {
		expect(qualifyOpenRefs(asked, roots, () => ({ unread: "no such" }))).toBe(
			"core#5 will not read as an open issue: no such",
		);
	});

	it("reads no issue for a ref its repo refuses", () => {
		expect(
			qualifyOpenRefs(asked, ["/home/u/manta"], () => {
				throw new Error("read");
			}),
		).toContain("tick core first");
	});
});
