// @vitest-environment node
/*
 * tickCriteria (#5354): the tick a landing-queue closer writes before its
 * close. Loosen it and a box outside the criteria section or a waived one is
 * ticked as verified, or a met alarm closes unticked and fails the daily
 * criteria check.
 */
import { expect, it } from "vitest";
import { tickCriteria, unmetCriteria } from "./ticket-criteria.js";

it("ticks each unmet criterion and leaves a waived one and the rest of the body as they are", () => {
	const body = `## What to build

- [ ] not a criterion

## Acceptance criteria

- [ ] The cause is fixed, at \`$&\`.
- [x] Already done.
- [ ] Dropped. **waived:** out of scope

## Notes

- [ ] not a criterion either
`;

	const ticked = tickCriteria(body);

	expect(unmetCriteria(ticked)).toEqual([]);
	expect(ticked).toBe(
		body
			.replace("- [ ] The cause", "- [x] The cause")
			.replace("- [ ] Dropped.", "- [ ] Dropped."),
	);
	expect(tickCriteria(ticked)).toBe(ticked);
});

it("returns a body with no criteria section unchanged", () => {
	expect(tickCriteria("## What to build\n\n- [ ] x\n")).toBe(
		"## What to build\n\n- [ ] x\n",
	);
});
