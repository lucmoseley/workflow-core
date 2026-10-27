// @vitest-environment node
/*
 * guard-node-heap.js hands a session the Node heap rule on a command touching
 * `max-old-space-size` (#2025). These are its boundary cases: the hook line
 * self-plugin/hooks/hooks.json registers, run by bash as the harness runs it,
 * on a harness-shaped payload — the wiring, the process exit and the latch on
 * disk, which no in-process case reaches. Its decision is lib/node-
 * heap.test.ts's and its latch, cap and fault arms guard-entry.test.ts's.
 *
 * CLAUDE_PROJECT_DIR and CLAUDE_CONFIG_DIR sit in a temp directory whose
 * `scripts` links to this checkout's, so the line finds the real entry while
 * its latch and fail-open log never land in the checkout or the founder's log.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";
import { readRuleText } from "./lib/rule-text";

const LINES = readHookLines(
	"self-plugin/hooks/hooks.json",
	"scripts/guard-node-heap.js",
);

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("node-heap-"));
	fs.symlinkSync(path.resolve(__dirname), path.join(dir, "scripts"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command` through `line`, or null. */
const emission = (line: string, command: string, env = {}) =>
	guardOutput("/bin/bash", buildBashPayload(command, "s1"), {
		project: dir,
		config,
		cwd: dir,
		args: ["-c", line],
		env,
	});

describe("the registered hook line", () => {
	it("is registered once per `if` narrowing, every one the same line", () => {
		expect(LINES.length).toBeGreaterThan(0);
		expect(new Set(LINES).size).toBe(1);
	});

	it("hands `node --max-old-space-size=8192 x.js` the rule as context, refusing nothing, and latches it", () => {
		const out = emission(LINES[0], "node --max-old-space-size=8192 x.js");
		expect(out).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: readRuleText("node-heap"),
		});
		expect(
			fs.existsSync(
				path.join(dir, ".claude/tmp/markers/.rule-injected-node-heap-main-s1"),
			),
		).toBe(true);
		expect(
			emission(LINES[0], "node --max-old-space-size=8192 x.js"),
		).toBeNull();
	});

	it("says nothing on `npm run build`", () => {
		expect(emission(LINES[0], "npm run build")).toBeNull();
	});

	it("fails open, exit 0 and silent, where node is not on PATH", () => {
		expect(
			emission(LINES[0], "node --max-old-space-size=8192 x.js", {
				PATH: "/nonexistent",
			}),
		).toBeNull();
	});
});
