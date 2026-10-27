// @vitest-environment node
/*
 * guard-ugrep-pattern.js warns, once per agent and session and never denying,
 * when a bare `grep` pattern carries a ranged repeat that Claude Code's
 * bundled ugrep may refuse (#1021). These are its boundary cases (§X11): the
 * entry run on a harness-shaped payload — each exit and its stream, the warn
 * latch on disk, the core-path rewrite crossed for real, the fail-open record
 * and a core that throws. Which grep warns, and with which sentence, is
 * lib/ugrep-pattern.test.ts's (#2801).
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
import { readFailOpenLog, readFailOpenRecords } from "./guard-log-fixture";
import {
	buildBashPayload,
	entryBesideThrowingCore,
	guardDirs,
	nodeGuardOutput,
	runNodeGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-ugrep-pattern.js");
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
	const out = nodeGuardOutput(
		GUARD,
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
			"guard-ugrep-pattern.js",
			"no session key — rule ugrep-pattern unlatchable, delivered again",
		]);
	});
});

describe("the fail-open record", () => {
	const run = (stdin: string) =>
		runNodeGuard(GUARD, null, { project: dir, config, cwd: dir, stdin });

	it("treats an empty payload as nothing to check, not a fault", () => {
		const r = run("");
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it.each([
		[
			"a payload that is not JSON",
			"{not json",
			/payload did not parse as JSON/,
		],
		[
			"a payload carrying no command",
			JSON.stringify({ session_id: "t", tool_name: "Bash", tool_input: {} }),
			/no command in payload/,
		],
	])("records %s, allowing", (_l, stdin, match) => {
		const r = run(stdin);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		const faults = readFailOpenRecords(config, dir);
		expect(faults).toHaveLength(1);
		expect(faults[0]).toEqual([
			expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			"guard-ugrep-pattern.js",
			expect.stringMatching(match),
		]);
	});

	it("allows, logged, where its core throws: it is advisory", () => {
		const entry = entryBesideThrowingCore(
			dir,
			"scripts/guard-ugrep-pattern.js",
			"ugrep-pattern.js",
		);
		const out = nodeGuardOutput(entry, buildBashPayload(FIRES, "mine"), {
			project: dir,
			config,
			cwd: dir,
		});
		expect(out).toBeNull();
		expect(readFailOpenLog(config, dir)).toMatch(
			/guard threw — allowed unchecked: broke/,
		);
		expect(fs.existsSync(latch("main-mine"))).toBe(false);
	});
});
