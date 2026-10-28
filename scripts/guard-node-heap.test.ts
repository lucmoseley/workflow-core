// @vitest-environment node
/*
 * The guard-node-heap core of guard-dispatch.js hands a session the Node heap
 * rule on a command touching `max-old-space-size` (#2025). These are its
 * boundary cases, the dispatcher entry run on it alone on a harness-shaped
 * payload: the process exit and the latch on disk, which no in-process case
 * reaches. Its decision is lib/node-heap.test.ts's and its latch, cap and
 * fault arms guard-entry.test.ts's; the entry's payload faults and the throw
 * policy are guard-dispatch's own tests' (#3226).
 *
 * CLAUDE_PROJECT_DIR and CLAUDE_CONFIG_DIR sit in a temp directory, so its
 * latch and fail-open log never land in the checkout or the founder's log.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";
import { readRuleText } from "./lib/rule-text";

const CORE = "guard-node-heap";

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("node-heap-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command`, or null. */
const emission = (command: string) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "s1"), {
		project: dir,
		config,
		cwd: dir,
	});

describe("the core, through the dispatcher", () => {
	it("hands `node --max-old-space-size=8192 x.js` the rule as context, refusing nothing, and latches it", () => {
		const out = emission("node --max-old-space-size=8192 x.js");
		expect(out).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: readRuleText("node-heap"),
		});
		expect(
			fs.existsSync(
				path.join(dir, ".claude/tmp/markers/.rule-injected-node-heap-main-s1"),
			),
		).toBe(true);
		expect(emission("node --max-old-space-size=8192 x.js")).toBeNull();
	});

	it("says nothing on `npm run build`", () => {
		expect(emission("npm run build")).toBeNull();
	});
});
