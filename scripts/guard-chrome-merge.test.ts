// @vitest-environment node
/*
 * The guard-chrome-merge core of guard-dispatch.js refuses a Chrome child's
 * launch whose stderr is merged into stdout (#5386, spec #5385): the
 * launcher's stdout is one JSON line on every end path, and a merged note
 * breaks the parse (#5381). The dispatcher entry is run on the core alone:
 * the payload on stdin, end to end. The command judged is never run.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { mkScratchDir } from "./lib/git-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-chrome-merge";
const LAUNCH =
	"node scripts/claude-child.js chrome --config-dir X --pages 1 --prompt-file f";

let dir: string;
let config: string;

/** The hook output for `command`, or null; exit 0 and a quiet stderr
 * asserted on every call. */
const emission = (command: string) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "test"), {
		project: dir,
		config,
		cwd: dir,
	});

beforeEach(() => {
	dir = mkScratchDir("guard-chrome-merge-");
	config = path.join(dir, "claude-config");
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a launch with stderr merged", () => {
	it("is refused, naming the command and saying to read stdout alone", () => {
		const out = emission(`${LAUNCH} 2>&1`);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			`This launches a Chrome child with its stderr merged into stdout: ${LAUNCH} 2>&1\n\nRead the launcher's stdout alone: it is exactly one JSON line on every end path, and its \`claude-child:\` notes are mirrored inside that line under \`notes\`, so stderr need not be merged (#5381). Merged, the notes reach the JSON reader as extra lines and the parse fails. Run it again without the \`2>&1\`, \`&>\` or \`|&\`.`,
		);
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it.each([
		["&>", `${LAUNCH} &>out.json`],
		["&>>", `${LAUNCH} &>>out.json`],
		["|&", `${LAUNCH} |& cat`],
		[
			"2>&1 into a python3 -c reader",
			`${LAUNCH} 2>&1 | python3 -c 'import json,sys; print(json.load(sys.stdin))'`,
		],
		["|& into a python3 -c reader", `${LAUNCH} |& python3 -c 'import json'`],
		["behind a wrapper", `timeout 900 ${LAUNCH} 2>&1`],
		[
			"by absolute path",
			"node /home/u/repo/scripts/claude-child.js chrome --pages 1 2>&1",
		],
		[
			"by the plugin path",
			`node "\${CLAUDE_PLUGIN_ROOT}"/../scripts/claude-child.js chrome --pages 1 2>&1`,
		],
	])("is refused: %s", (_label, command) => {
		expect(emission(command).permissionDecision).toBe("deny");
	});
});

describe("what passes", () => {
	it.each([
		["the launch alone", LAUNCH],
		["stderr discarded", `${LAUNCH} 2>/dev/null`],
		["stdout piped alone", `${LAUNCH} | python3 -c 'import json'`],
		["chrome-close", "node scripts/claude-child.js chrome-close --sweep 2>&1"],
		["another mode", "node scripts/claude-child.js usage --seat a 2>&1"],
		["a merge in an earlier segment", `ls 2>&1; ${LAUNCH}`],
		["a |& in a later segment", `${LAUNCH}; ls |& cat`],
		["a mention", `echo ${LAUNCH} |& cat`],
	])("%s", (_label, command) => {
		expect(emission(command)).toBeNull();
	});
});
