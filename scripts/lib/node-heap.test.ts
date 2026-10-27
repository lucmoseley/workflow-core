// @vitest-environment node
/*
 * lib/node-heap.js decides when a command is handed the Node heap rule
 * (#2025). A firing case that goes silent leaves a session free to raise the
 * cap with nothing telling it not to; a silent case that fires spends the
 * once-a-session rule on commands that never touch the heap. The latch, the
 * emission and the hook boundary are guard-entry.test.ts's and
 * guard-node-heap.test.ts's.
 */

import { describe, expect, it } from "vitest";

const { decide } = require("./node-heap.js") as {
	decide: (command: string) => { injectRules: string[] } | null;
};
/* CommonJS, hence the require. */
const { readRuleText } = require("./rule-text") as {
	readRuleText: (id: string) => string;
};

describe("a command touching the heap flag is handed the rule", () => {
	it.each([
		["export NODE_OPTIONS=--max-old-space-size=8192", "a raise"],
		[
			"sed -i 's/max-old-space-size=4096//' ~/.bashrc",
			"a removal from ~/.bashrc",
		],
		["node --max_old_space_size=6144 build.js", "V8's underscore spelling"],
	])("%s — %s", (command) => {
		expect(decide(command)).toEqual({ injectRules: ["node-heap"] });
	});
});

describe("it stays silent off the flag", () => {
	it.each([
		["echo $NODE_OPTIONS", "reads NODE_OPTIONS, names no heap flag"],
		["npm run build", "an unrelated command"],
		["node --max-semi-space-size=64 old.js", "another V8 heap flag"],
	])("%s — %s", (command) => {
		expect(decide(command)).toBeNull();
	});
});

/* The fragment is the store's, so its operative clauses are pinned here,
 * whitespace collapsed against reflow. */
describe("the rule carries its operative clauses", () => {
	it.each([
		["4096 STAYS: never remove it and never raise it", "the rule itself"],
		["cut concurrent sessions instead", "what to do instead"],
		["enlarges what one runaway can take down", "why the cap stays"],
		["is not a raise", "a per-command lowering is allowed"],
	])("names %s — %s", (clause) => {
		expect(readRuleText("node-heap").replace(/\s+/g, " ")).toContain(clause);
	});
});
