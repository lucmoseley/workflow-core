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

export const buildShortlistStub = (shortlist: object) =>
	`process.stdout.write(${JSON.stringify(JSON.stringify(shortlist))});\n`;
