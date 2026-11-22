// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seenFrom } from "./lib/core-path-testkit";
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
			additionalContext: seenFrom(dir, () => readRuleText("headroom-reap")),
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
