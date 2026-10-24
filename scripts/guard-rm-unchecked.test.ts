// @vitest-environment node
/*
 * guard-rm-unchecked.sh refuses, once per command, an `rm` Claude Code's
 * built-in removal check cannot resolve (#2436). A firing case that goes
 * silent leaves an away-mode session to meet a permission prompt nobody
 * answers; a silent case that fires costs every plain `rm` a round trip.
 *
 * It spawns the real guard on a harness-shaped PreToolUse payload, with
 * `CLAUDE_PROJECT_DIR` and `CLAUDE_CONFIG_DIR` in a temp directory so its latch
 * and fail-open log never land in the real checkout or the founder's log.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-rm-unchecked.sh");
/* CommonJS, hence the require. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("rm-unchecked-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command`, or null where it said nothing. */
const emission = (command: string, session = `s-${Math.random()}`) =>
	guardOutput(
		GUARD,
		{ ...buildBashPayload(command, session), hook_event_name: "PreToolUse" },
		{ project: dir, config, cwd: dir },
	);

describe("an rm the harness cannot check is refused, naming both spellings", () => {
	it.each([
		[
			"rm -rf $T/*",
			"a variable the command never sets, then a slash",
			"`$T/*`",
		],
		['rm -f "$S/$f"', "the same, quoted", "`$S/$f`"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["rm -rf ${D}/x", "the same, braced", "`${D}/x`"],
		[
			"T=$(mktemp -d); rm -rf $T/*",
			"a variable set from a command substitution, probed denied on #2436",
			"`$T/*`",
		],
		["cd /tmp && rm -f corpus/*", "a relative glob after a cd", "`corpus/*`"],
		[
			"T=$(mktemp -d -p .claude/tmp p.XXXX); for c in a b; do g=x.sh; bash $g; done; rm -rf $T",
			"rm beside a shell running a variable's script",
			"`$g`",
		],
		["bash -c 'rm -rf \"$x\"'", "an rm inside a shell -c script", "`-c`"],
		[
			"bash -c 'make'; rm -rf .claude/tmp/lit",
			"a literal rm beside a shell -c script",
			"`-c`",
		],
		[
			"P=/home/x; for d in c d e; do rm -rf $P/$d; done",
			"a second variable in the target the command never sets",
			"`$P/$d`",
		],
		[
			"bash -c 'echo; rm -rf x' arg0",
			"an rm after the -c script's first command, with a $0",
			"`-c`",
		],
		["bash -o pipefail -c 'rm x'", "a -o value before -c", "`-c`"],
		['env bash -c "rm x"', "a shell behind env", "`-c`"],
		["sudo rm -rf $T/*", "an rm behind sudo", "`$T/*`"],
	])("%s is refused — %s", (command, _why, quoted) => {
		const out = emission(command);
		expect(out?.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(quoted);
		expect(out.permissionDecisionReason).toContain(ruleText("rm-unchecked"));
		expect(out.permissionDecisionReason).toContain("A LITERAL PATH");
		expect(out.permissionDecisionReason).toContain("NO `rm` AT ALL");
	});

	it("lets the same command through on its re-send, and refuses a different one", () => {
		const session = "one-session";
		expect(emission("rm -rf $T/*", session)?.permissionDecision).toBe("deny");
		expect(emission("rm -rf $T/*", session)).toBeNull();
		expect(emission("rm -rf $U/*", session)?.permissionDecision).toBe("deny");
	});
});

describe("an rm the harness resolves passes silently", () => {
	it.each([
		["rm -rf .claude/tmp/abc-1234", "a literal path"],
		["rm file.txt", "a plain rm"],
		["T=.claude/tmp/x; rm -rf $T/*", "a variable the command sets first"],
		["export T=.claude/tmp/x; rm -rf $T/*", "a variable an export sets"],
		[
			"R=sub; S=v3; rm -f $R/$S/a",
			"every variable set first, measured to pass",
		],
		["T=$(mktemp -d); rm -rf $T", "a bare variable, measured to pass"],
		[
			'for f in a b; do rm "$f"; done',
			"a loop's bare variable, measured to pass",
		],
		["rm -f corpus/*", "a relative glob with no cd"],
		["bash scripts/x.sh; rm -rf .claude/tmp/a", "a shell running a named file"],
		["bash -c 'echo hi'", "a shell -c script with no rm"],
		['echo "rm -rf $T/x"', "rm only quoted as text"],
		["git rm -r $T/x", "git rm, which the check does not read"],
	])("%s passes — %s", (command) => {
		expect(emission(command)).toBeNull();
	});
});
