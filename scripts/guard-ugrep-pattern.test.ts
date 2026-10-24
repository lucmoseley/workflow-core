// @vitest-environment node
/*
 * guard-ugrep-pattern.sh warns, once per agent and session and never denying,
 * when a bare `grep` pattern carries a ranged repeat that Claude Code's bundled
 * ugrep may refuse (#1021).
 *
 * The first fire case and the first two pass cases are #1021's acceptance
 * criteria; do not thin them.
 *
 * The real guard is spawned with a hook payload on stdin and its own config
 * and project directories under a temp dir, so its latch and any fail-open
 * record land there rather than in the founder's own state.
 *
 * It is a `PreToolUse` Bash hook in self-plugin/hooks/hooks.json: loosen a case
 * here and a refused pattern's exit 2 reads to a session as "no match" again,
 * with stderr discarded and nothing to say otherwise.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog } from "./guard-log-fixture";
import { buildBashPayload, guardOutput } from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-ugrep-pattern.sh");

let dir: string;
let config: string;
let project: string;

const run = (command: string, session = "mine", agent?: string) => {
	const verdict = guardOutput(
		GUARD,
		{
			...buildBashPayload(command, session),
			cwd: project,
			...(agent ? { agent_id: agent } : {}),
		},
		{ project, config, cwd: project },
	);
	if (!verdict) return null;
	expect(verdict.permissionDecision).toBeUndefined();
	return verdict.additionalContext as string;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-ugrep-pattern-"));
	config = path.join(dir, "config");
	project = path.join(dir, "project");
	fs.mkdirSync(project);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a bounded repeat ugrep may refuse is warned on", () => {
	it("names ugrep, exit 2, -P and the discarded stderr", () => {
		const note = run('grep -o -h -E ".{0,80}(x|y).{0,80}" f 2>/dev/null');
		expect(note).toContain("ugrep");
		expect(note).toContain("exits 2");
		expect(note).toContain("`-P` in place of `-E`");
		expect(note).toContain("every other flag kept");
		expect(note).toContain("an alternation");
		expect(note).toContain("discards stderr");
	});

	it("leaves out the stderr sentence where stderr is kept", () => {
		const note = run('grep -o -E ".{0,20}x.{0,20}" f');
		expect(note).toContain("ugrep");
		expect(note).not.toContain("discards stderr");
	});

	it.each([
		'grep -oE "a{1,3}" f >/dev/null 2>&1',
		'grep -oE "a{1,3}" f &>/dev/null',
		'grep -oE "a{1,3}" f 2>&-',
		'grep -oE "a{1,3}" f 2> /dev/null | head',
		'grep -oE "a{1,3}" f 2>>/dev/null',
	])("says stderr is discarded: %s", (command) => {
		expect(run(command)).toContain("discards stderr");
	});

	it.each([
		'grep -oE "a{1,3}" f 2>&1 | head',
		'ls 2>/dev/null; grep -oE "a{1,3}" f',
		'grep -oE "a{1,3}" f; ls >/dev/null 2>&1',
	])("says nothing of another command's stderr: %s", (command) => {
		const note = run(command);
		expect(note).toContain("ugrep");
		expect(note).not.toContain("discards stderr");
	});

	it("tells a basic-mode pattern to drop its backslashes under -P", () => {
		expect(run("grep -o '.\\{0,80\\}x' f")).toContain(
			"the backslashes taken off",
		);
	});

	it.each([
		'grep -oE "a{,3}" f',
		'grep -oE "a{2,}" f',
		"grep -o '.\\{0,80\\}x' f",
		'cat f | grep -E -e zz -e "a{1,3}" | head',
		'grep -oEh --include=*.ts "a{1,3}" f',
		'X=1 grep -E "a{1,3}" f',
		// -G after -E is basic mode again.
		"grep -E -G 'a\\{1,3\\}' f",
		// ugrep's own value flags, whose values are not the pattern.
		'grep -t cpp -E "a{1,3}" .',
		'grep -E -e zz --and "a{1,3}" f',
	])("%s", (command) => {
		expect(run(command)).toContain("ugrep");
	});
});

describe("what passes", () => {
	it.each([
		'grep -o -h -P ".{0,80}(x|y).{0,80}" f 2>/dev/null',
		"grep -n foo f",
		'grep -oP ".{0,80}x" f',
		'grep -E -o ".{0,80}x" -P f',
		'grep -FE "a{1,3}" f',
		'grep -E -G "a{1,3}" f',
		// BRE without the backslashes: ugrep reads the braces literally.
		'grep -o ".{0,80}x.{0,80}" f',
		'grep -E "a{3}" f',
		// Each of these reaches GNU grep, not the function.
		'egrep "a{1,3}" f',
		'xargs grep -E "a{1,3}"',
		'command grep -E "a{1,3}" f',
		'/usr/bin/grep -E "a{1,3}" f',
		'grep -zE "a{1,3}" f',
		// The bounded repeat is a file name, the pattern coming by -e.
		'grep -E -e foo "a{1,3}"',
		'echo "grep -E a{1,3}"',
	])("%s", (command) => {
		expect(run(command)).toBeNull();
	});
});

describe("the latch", () => {
	const cmd = 'grep -oE ".{0,80}x.{0,80}" f';

	it("warns once a session", () => {
		expect(run(cmd)).toContain("ugrep");
		expect(run(cmd)).toBeNull();
	});

	it("warns another session and another agent", () => {
		expect(run(cmd)).toContain("ugrep");
		expect(run(cmd, "theirs")).toContain("ugrep");
		expect(run(cmd, "mine", "a1")).toContain("ugrep");
	});

	it("is not spent by a call that passes", () => {
		expect(run("grep -n foo f")).toBeNull();
		expect(run(cmd)).toContain("ugrep");
	});
});

describeFailOpenLog({
	guard: GUARD,
	denied: {
		tool_input: { command: 'grep -oE ".{0,80}x.{0,80}" f' },
		session_id: "mine",
	},
	armed: /"additionalContext"/,
	fieldless: { tool_input: {}, session_id: "mine" },
	fieldlessMatch: /no command in payload/,
	benign: { tool_input: { command: "grep -n foo f" }, session_id: "mine" },
	ctx: () => ({ dir, config, project }),
});
