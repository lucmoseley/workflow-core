// @vitest-environment node

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
