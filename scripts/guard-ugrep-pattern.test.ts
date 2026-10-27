// @vitest-environment node
/*
 * The guard-ugrep-pattern core of guard-dispatch.js warns, once per agent and
 * session and never denying, when a bare `grep` pattern carries a ranged
 * repeat that Claude Code's bundled ugrep may refuse (#1021). These are its
 * boundary cases (§X11), the dispatcher entry run on it alone on a
 * harness-shaped payload — each exit and its stream, the warn latch on disk,
 * the core-path rewrite crossed for real and the fail-open record. Which grep
 * warns, and with which sentence, is lib/ugrep-pattern.test.ts's (#2801); the
 * entry's payload faults and the throw policy are guard-dispatch's own tests'
 * (#3227).
 *
 * CLAUDE_PROJECT_DIR is a temp project, so the latch and any fail-open record
 * land under it and the temp CLAUDE_CONFIG_DIR, never the founder's own state.
 *
 * Break the latch and every grep repeats the note; lose the emission and a
 * refused pattern's exit 2 reads to a session as "no match" again.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenRecords } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-ugrep-pattern";
const FIRES = 'grep -oE ".{0,80}x.{0,80}" f';

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("guard-ugrep-pattern-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command`, or null; exit 0 and a quiet
 *  stderr asserted on every call, and never a permission decision. */
const emission = (
	command: string,
	{
		session = "mine" as string | null,
		agent,
		env = {},
	}: { session?: string | null; agent?: string; env?: NodeJS.ProcessEnv } = {},
) => {
	const out = dispatchCoreOutput(
		CORE,
		{
			...buildBashPayload(command, session),
			cwd: dir,
			...(agent ? { agent_id: agent } : {}),
		},
		{ project: dir, config, cwd: dir, env },
	);
	if (out) {
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBeUndefined();
	}
	return out?.additionalContext as string | undefined;
};

/** The warn latch at the path `latchAfter` writes. */
const latch = (key: string) =>
	path.join(
		dir,
		".claude",
		"tmp",
		"markers",
		`.rule-injected-warn.ugrep-pattern-${key}`,
	);

describe("the warning, end to end", () => {
	it("warns as additionalContext on exit 0, latches its marker after it, then is silent", () => {
		expect(fs.existsSync(latch("main-mine"))).toBe(false);
		expect(emission(FIRES)).toContain("bundled ugrep");
		expect(fs.existsSync(latch("main-mine"))).toBe(true);
		expect(emission(FIRES)).toBeUndefined();
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("is silent for a session whose marker is already written", () => {
		fs.mkdirSync(path.dirname(latch("main-mine")), { recursive: true });
		fs.writeFileSync(latch("main-mine"), "");
		expect(emission(FIRES)).toBeUndefined();
	});

	it("warns another session and another agent, each latched apart", () => {
		expect(emission(FIRES)).toContain("ugrep");
		expect(emission(FIRES, { session: "theirs" })).toContain("ugrep");
		expect(emission(FIRES, { agent: "a1" })).toContain("ugrep");
		expect(fs.existsSync(latch("main-theirs"))).toBe(true);
		expect(fs.existsSync(latch("aa1-mine"))).toBe(true);
	});

	it("is silent on a call that passes, and spends no latch", () => {
		expect(emission("grep -n foo f")).toBeUndefined();
		expect(fs.existsSync(latch("main-mine"))).toBe(false);
		expect(emission(FIRES)).toContain("ugrep");
	});

	it("points an install outside this checkout at the plugin's own doc", () => {
		const root = path.join(dir, "plugin");
		fs.mkdirSync(path.join(root, "docs", "agents"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "agents", "tool-output.md"), "");
		expect(emission(FIRES, { env: { WFC_SCRIPT_ROOT: root } })).toContain(
			`Warned once a session; ${root}/docs/agents/tool-output.md.`,
		);
		expect(emission(FIRES, { session: "other" })).toContain(
			"Warned once a session; docs/agents/tool-output.md.",
		);
	});

	it("warns a payload carrying no session id every time, recording it unlatchable", () => {
		expect(emission(FIRES, { session: null })).toContain("ugrep");
		expect(emission(FIRES, { session: null })).toContain("ugrep");
		expect(readFailOpenRecords(config, dir)[0]?.slice(1)).toEqual([
			CORE,
			"no session key — rule ugrep-pattern unlatchable, delivered again",
		]);
	});
});
