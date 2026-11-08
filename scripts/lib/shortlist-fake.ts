/*
 * The `pick-next.js --json` shortlist the refill loop's run tests stub, held to
 * what lib/shortlist-parse.js's parseShortlist requires by
 * lib/shortlist-parse.test.ts, and to what the real script prints by
 * lib/shortlist.contract.test.ts (#4358). A field the parser comes to require
 * goes here.
 */

/** A frontier row with every sort level the loop reads. */
export const buildShortlistRow = (over: Record<string, unknown> = {}) => ({
	number: 5,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	reach: 0,
	collision: "writes repo files",
	takes: ["implement"],
	labels: [],
	parkedAt: null,
	...over,
});

/** An empty shortlist that parses clean. */
export const buildShortlist = (over: Record<string, unknown> = {}) => ({
	frontier: [],
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
	ownRepo: null,
	goalSet: null,
	conflictGraph: { candidates: [], inFlight: [] },
	running: [],
	...over,
});

/** A stubbed pick-next.js's source line printing `shortlist`. */
export const buildShortlistStub = (shortlist: object) =>
	`process.stdout.write(${JSON.stringify(JSON.stringify(shortlist))});\n`;
