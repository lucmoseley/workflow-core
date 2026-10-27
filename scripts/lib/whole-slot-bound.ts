/*
 * whole-slot-bound.ts — the whole-slot bound (#2931) as the tests spell it:
 * suite-bounded.js keeps its own copy file-local. suite-bounded.test.ts holds
 * the two equal through `weighFiles`, and suite-ladder.test.ts holds this one
 * at a quarter of the suite the ladder was measured on.
 */

export const WHOLE_SLOT_BOUND = 121;
