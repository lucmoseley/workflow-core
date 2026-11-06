// @vitest-environment node
/*
 * Pins goal-set.js: the open issues a `drain` goal names, its ref's open
 * descendants through parent links at any depth, the ref in another repo
 * included (#3866, ruling #2524); and `resolveGoal`'s outcome for each goal
 * form (#4382).
 *
 * A core, so its cases call it with seeded issue lists; pick-next.test.ts
 * keeps the runs that cross the goal flag.
 *
 * Breaking it drains the wrong set: a goal that stops a level down, takes in
 * a stranger, or misses a child whose parent lives in another checkout, and
 * the refill loop ranks work nobody named.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAdopterCheckout } from "./claim-store-testkit";

const { openDescendants, resolveGoal } = require("./goal-set.js");
const { goalRefRepo } = require("./goal-ref-repo.js");

const OWN = "o/r";
/** An open issue here, its parent the issue `parent` names, or none. */
const issue = (number: number, parent: number | string | null = null) => ({
	number,
	parent:
		typeof parent === "number"
			? `https://api.github.com/repos/${OWN}/issues/${parent}`
			: parent,
});
const numbers = (issues: { number: number }[]) => issues.map((i) => i.number);

describe("openDescendants (#3866)", () => {
	const map = [issue(1), issue(2, 1), issue(3, 2), issue(4), issue(5, 4)];

	it("drains a ref's open descendants at any depth, not the ref or a stranger", () => {
		expect(
			numbers(openDescendants(map, { repo: OWN, number: 1 }, OWN)),
		).toEqual([2, 3]);
	});

	it("takes a child filed since under a descendant, the goal unchanged", () => {
		const later = [...map, issue(6, 2)];
		expect(
			numbers(openDescendants(later, { repo: OWN, number: 1 }, OWN)),
		).toEqual([2, 3, 6]);
	});

	it("drains a child whose parent is another repo's issue, and not one in a third repo sharing its number", () => {
		const issues = [
			issue(7, "https://api.github.com/repos/o/manta/issues/40"),
			issue(8, 7),
			issue(9, "https://api.github.com/repos/o/z/issues/40"),
		];
		expect(
			numbers(openDescendants(issues, { repo: "o/manta", number: 40 }, OWN)),
		).toEqual([7, 8]);
	});
});

describe("resolveGoal (#4382)", () => {
	const map = [issue(1), issue(2, 1), issue(3, 2), issue(5)].map((i) => ({
		...i,
		title: `t${i.number}`,
	}));
	const graph = { ownRepo: OWN };
	let home = "";
	let savedHome: string | undefined;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "goal-set-"));
		writeAdopterCheckout(path.join(home, "manta"), "o/manta");
		savedHome = process.env.HOME;
		process.env.HOME = home;
	});
	afterEach(() => {
		process.env.HOME = savedHome;
		fs.rmSync(home, { recursive: true, force: true });
	});
	/** The production lookup, the run's own checkout `r` under the temp HOME. */
	const ownCheckout = (ref: { repo: string | null }, own: string | null) =>
		goalRefRepo(ref, own, path.join(home, "r"));

	it("ranks nothing for a checkout gone from the machine, and says so", () => {
		expect(
			resolveGoal(
				{ form: "drain", ref: { repo: "ghost", number: 5 } },
				map,
				graph,
				ownCheckout,
			),
		).toEqual({
			members: [],
			ranked: [],
			notice: "--goal names ghost#5: no checkout named ghost",
		});
		// This checkout, bare or by its own directory name, drains with no notice.
		for (const repo of [null, "r"])
			expect(
				resolveGoal(
					{ form: "drain", ref: { repo, number: 1 } },
					map,
					graph,
					ownCheckout,
				),
			).toMatchObject({ ranked: [2, 3], notice: null });
	});

	it("refuses an unblock in another repo, naming it, and ranks an issue list here", () => {
		expect(
			resolveGoal(
				{ form: "unblock", ref: { repo: "manta", number: 40 } },
				map,
				graph,
				ownCheckout,
			),
		).toEqual({
			refusal: "--goal names o/manta#40, another repo's: run it there",
		});
		expect(
			resolveGoal(
				{ form: "issues", refs: [{ repo: null, number: 5 }] },
				map,
				graph,
				ownCheckout,
			),
		).toEqual({
			members: [{ repo: OWN, number: 5, title: "t5" }],
			ranked: [5],
			notice: null,
		});
	});
});
