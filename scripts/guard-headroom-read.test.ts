// @vitest-environment node
/*
 * The guard-headroom-read core of guard-dispatch.js states the headroom rule
 * before a session draws a conclusion from a memory reading
 * (mantahostels#1933). These are its boundary cases, the dispatcher entry run
 * on it alone on a harness-shaped payload: the answer and the latch on disk,
 * which no in-process case reaches. Its decision is lib/headroom-read.test.ts's;
 * the entry's payload faults and the throw policy are guard-dispatch's own
 * tests' (#3225).
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

const CORE = "guard-headroom-read";

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("headroom-read-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The core's hookSpecificOutput for `command`, or null. */
const emission = (command: string) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "s1"), {
		project: dir,
		config,
		cwd: dir,
	});

describe("the core, through the dispatcher", () => {
	it("hands `free -m` the rule as context, refusing nothing, and latches it", () => {
		expect(emission("free -m")).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: readRuleText("headroom-reap"),
		});
		expect(
			fs.existsSync(
				path.join(
					dir,
					".claude/tmp/markers/.rule-injected-headroom-reap-main-s1",
				),
			),
		).toBe(true);
		expect(emission("free -m")).toBeNull();
	});

	it("says nothing on `ls -la`", () => {
		expect(emission("ls -la")).toBeNull();
	});
});
