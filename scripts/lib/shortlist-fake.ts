/*
 * The `pick-next.js --json` shortlist the refill loop's run tests stub, held to
 * what lib/shortlist-parse.js's parseShortlist reads by
 * lib/shortlist-parse.test.ts (#4358). A field the parser comes to require
 * goes here, and the parser's own test fails until it does.
 */

/** A frontier row with every sort level the loop reads, as #`number`. */
export const shortlistRow = (over: Record<string, unknown> = {}) => ({
	number: 5,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	reach: 0,
	collision: "",
	takes: ["implement"],
	labels: [],
	...over,
});

/** An empty shortlist that parses clean, with `over`'s fields swapped in. */
export const buildShortlist = (over: Record<string, unknown> = {}) => ({
	frontier: [],
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
	conflictGraph: { candidates: [], inFlight: [] },
	running: [],
	...over,
});

/** A stubbed pick-next.js's source line printing `shortlist`. */
export const printShortlist = (shortlist: object) =>
	`process.stdout.write(${JSON.stringify(JSON.stringify(shortlist))});\n`;
