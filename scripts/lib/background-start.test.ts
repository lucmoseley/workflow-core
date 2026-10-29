// @vitest-environment node
/*
 * Pins what lib/background-start.js counts as a background start (#3707),
 * the predicate that holds a founder's once-a-day notice back for his own
 * session start.
 *
 * In process, each case handing the predicate its own environment object,
 * so the case does not depend on whether the suite itself runs in a
 * background job.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(__filename);
const { isBackgroundStart } = require_("./background-start.js") as {
	isBackgroundStart: (env: NodeJS.ProcessEnv) => boolean;
};

describe("isBackgroundStart", () => {
	it.each([
		[
			"a `claude --bg` job",
			{ CLAUDE_JOB_DIR: "/j", CLAUDE_CODE_ENTRYPOINT: "cli" },
		],
		["a print-mode run", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
	])("counts %s as a background start", (_, env) => {
		expect(isBackgroundStart(env)).toBe(true);
	});

	it.each([
		["an interactive terminal session", { CLAUDE_CODE_ENTRYPOINT: "cli" }],
		["an empty job dir", { CLAUDE_JOB_DIR: "" }],
		["no harness variables", {}],
	])("counts %s as interactive", (_, env) => {
		expect(isBackgroundStart(env)).toBe(false);
	});
});
