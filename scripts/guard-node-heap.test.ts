// @vitest-environment node
/*
 * guard-node-heap.sh hands a session the Node heap rule on a command touching
 * `max-old-space-size` (#2025). The rule left every always-loaded file for this
 * guard, so a firing case that goes silent leaves a session free to raise the
 * cap with nothing telling it not to; a silent case that fires spends the rule
 * on commands that never touch the heap.
 *
 * It spawns the real guard on a harness-shaped PreToolUse payload, with
 * `CLAUDE_PROJECT_DIR` and `CLAUDE_CONFIG_DIR` in a temp directory so its latch
 * and fail-open log never land in the real checkout or the founder's log.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-node-heap.sh");
/* CommonJS, hence the require. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("node-heap-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command`, or null where it said nothing. */
const emission = (command: string, session = `s-${Math.random()}`) =>
	guardOutput(
		GUARD,
		{ ...buildBashPayload(command, session), hook_event_name: "PreToolUse" },
		{ project: dir, config, cwd: dir },
	);

describe("a command touching the heap flag is handed the rule, and refused nothing", () => {
	it.each([
		["export NODE_OPTIONS=--max-old-space-size=8192", "a raise"],
		[
			"sed -i 's/max-old-space-size=4096//' ~/.bashrc",
			"a removal from ~/.bashrc",
		],
		["node --max_old_space_size=6144 build.js", "V8's underscore spelling"],
	])("%s is handed the whole rule — %s", (command) => {
		const out = emission(command);
		expect(out).not.toBeNull();
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(ruleText("node-heap"));
	});

	it("says it once a session", () => {
		const session = "one-session";
		expect(
			emission("node --max-old-space-size=8192 x.js", session),
		).not.toBeNull();
		expect(emission("node --max-old-space-size=8192 x.js", session)).toBeNull();
	});
});

describe("it stays silent off the flag", () => {
	it.each([
		["echo $NODE_OPTIONS", "reads NODE_OPTIONS, names no heap flag"],
		["npm run build", "an unrelated command"],
	])("%s says nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});
});

/* `toContain(ruleText(...))` moves with a mutation to the fragment, so the
 * operative clauses are pinned here, whitespace collapsed against reflow. */
describe("the rule carries its operative clauses", () => {
	it.each([
		["4096 STAYS: never remove it and never raise it", "the rule itself"],
		["cut concurrent sessions instead", "what to do instead"],
		["enlarges what one runaway can take down", "why the cap stays"],
		["is not a raise", "a per-command lowering is allowed"],
	])("names %s — %s", (clause) => {
		expect(ruleText("node-heap").replace(/\s+/g, " ")).toContain(clause);
	});
});
