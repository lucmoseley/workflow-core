// @vitest-environment node
/*
 * guard-root-find.sh refuses a `find` started at `/`, at any depth, and hands
 * over the plugin's own root, the repo's scratch and named roots (#1006).
 *
 * The first fire list and the first pass list are #1006's acceptance criteria;
 * do not thin them. The payload's `cwd` is what the `cd /`, `..` and bare-find
 * cases test, since a relative start point resolves against it. The guard is
 * spawned with project and config dirs in a temp directory, and every case
 * asserts exit 0 and empty stderr, since a crashed guard is silent too.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a fire case and a `find /` walks the whole
 * Windows mount on a 10 GB machine; lose a pass case and a scoped `find` is
 * refused.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog } from "./guard-log-fixture";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-root-find.sh");

let dir: string;
let config: string;
let project: string;

const run = (command: string, cwd = project) =>
	guardOutput(
		GUARD,
		{ ...buildBashPayload(command, null), cwd },
		{ project, config },
	);

beforeEach(() => {
	({ dir, config } = guardDirs("guard-root-find-"));
	project = path.join(dir, "project");
	fs.mkdirSync(project);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a find started at / is refused", () => {
	it.each([
		"find / -name x",
		"find / -maxdepth 6 -name x",
		"find /usr / -name x",
		"find -L / -name x",
		'find "/" -name x',
		"timeout 120 find / -xdev -name x",
		"cd ~ && find / -name x",
		"sudo find / -name x 2>/dev/null | head",
		"find // -name x",
		"find /tmp/.. -name x",
		"cd / && find . -name x",
	])("%s", (command) => {
		const out = run(command);
		expect(out?.permissionDecision).toBe("deny");
	});

	it("refuses a bare find from a session standing in /", () => {
		expect(run("find -name x", "/")?.permissionDecision).toBe("deny");
	});

	it("hands over the plugin root, the scratch and named roots", () => {
		const reason: string = run("find / -name x").permissionDecisionReason;
		expect(reason).toContain(`${path.resolve(__dirname, "..")} `);
		expect(reason).toContain(".claude/tmp/");
		expect(reason).toContain("find /usr /opt /home -xdev -name");
		expect(reason).toContain("`find / -name x`");
	});
});

describe("every other start point passes silently", () => {
	it.each([
		"find ~ -name x",
		"find $HOME -name x",
		"find /home/lucmo -name x",
		"find /usr -name x",
		"find /mnt/c/Users -name x",
		"find . -name x",
		"find scripts -name x",
		'find "$state_dir" -maxdepth 1',
		"find \\( -name a \\)",
		"find -name x",
	])("%s", (command) => {
		expect(run(command)).toBeNull();
	});

	it.each([
		"grep -n 'find /' file",
		'echo "find / -name"',
		"cat <<'EOF'\nfind / -name x\nEOF",
	])("a mention is not a run: %s", (command) => {
		expect(run(command)).toBeNull();
	});
});

describeFailOpenLog({
	guard: GUARD,
	denied: { tool_input: { command: "find / -name x" } },
	fieldless: { tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: { tool_input: { command: "find . -name x" } },
	ctx: () => ({ dir, config, project }),
});
