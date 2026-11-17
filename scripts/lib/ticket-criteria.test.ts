// @vitest-environment node
/*
 * tickCriteria (#5354): the tick a landing-queue closer writes before its
 * close. Loosen it and a box outside the criteria section or a waived one is
 * ticked as verified, or a met alarm closes unticked and fails the daily
 * criteria check.
 */
import { expect, it } from "vitest";
import { tickCriteria, unmetCriteria } from "./ticket-criteria.js";

it("ticks the named criterion and leaves a waived one, any other, and the rest of the body as they are", () => {
	const body = `## What to build

- [ ] not a criterion

## Acceptance criteria

- [ ] The cause is fixed, at \`$&\`.
- [x] Already done.
- [ ] Dropped. **waived:** out of scope
- [ ] Added by hand.

## Notes

- [ ] not a criterion either
`;

	const ticked = tickCriteria(body, "The cause is fixed, at `$&`.");

	expect(unmetCriteria(ticked).map((i) => i.text)).toEqual(["Added by hand."]);
	expect(ticked).toBe(body.replace("- [ ] The cause", "- [x] The cause"));
	expect(tickCriteria(ticked, "The cause is fixed, at `$&`.")).toBe(ticked);
});

it("returns a body with no criteria section unchanged", () => {
	expect(tickCriteria("## What to build\n\n- [ ] x\n", "x")).toBe(
		"## What to build\n\n- [ ] x\n",
	);
});

it("ticks the criteria section's box, not an identical one above it", () => {
	const body =
		"## What to build\n\n- [ ] x\n\n## Acceptance criteria\n\n- [ ] x\n";

	expect(tickCriteria(body, "x")).toBe(
		"## What to build\n\n- [ ] x\n\n## Acceptance criteria\n\n- [x] x\n",
	);
});

it("ticks a CRLF body, keeping its line endings", () => {
	expect(tickCriteria("## Acceptance criteria\r\n\r\n- [ ] x\r\n", "x")).toBe(
		"## Acceptance criteria\r\n\r\n- [x] x\r\n",
	);
});
