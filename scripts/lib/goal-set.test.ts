// @vitest-environment node
/*
 * Pins goal-set.js: the open issues a `drain` goal names, its ref's open
 * descendants through parent links at any depth, the ref in another repo
 * included (#3866, ruling #2524).
 *
 * A core, so its cases call it with seeded issue lists; pick-next.test.ts keeps
 * the run that crosses the goal flag and the GOAL SET line.
 *
 * Breaking it drains the wrong set: a goal that stops a level down, takes in
 * a stranger, or misses a child whose parent lives in another checkout, and
 * the refill loop ranks work nobody named.
 */

import { describe, expect, it } from "vitest";

const { openDescendants } = require("./goal-set.js");

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
