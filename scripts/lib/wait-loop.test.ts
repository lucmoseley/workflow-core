// @vitest-environment node
/*
 * lib/wait-loop.js, a PreToolUse dispatcher core, answers two questions about
 * an opaque shell string: is this an `until`/`while` loop around `sleep` with
 * nothing to stop it (a warn), and does it wait more than 15 minutes (a deny,
 * #1288)?
 *
 * The fire cases are mantahostels#2012's two wedged commands verbatim
 * (mantahostels#2017 §Testing Decisions). The silent cases are the shapes that
 * would otherwise be false positives — do not thin them out.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * real rule store. The core reads only the command string, so the temp dir is
 * the host root alone. The hook line, stdin and the environment the entry
 * inherits are scripts/guard-dispatch.test.ts's boundary set.
 *
 * Loosen a case here and an unbounded wait loop outlives its session
 * unwarned, or a wait past 15 minutes runs unrefused.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";

/* Their file arguments are the only change from the ticket, which writes
 * `<file>` as a placeholder. */
const WEDGED_13H =
	"until grep -q '######## T5' /tmp/tenure.log && ! pgrep -f 'tenure.js' >/dev/null; do sleep 3; done";
const WEDGED_TSC =
	"until grep -qE 'AFTER|error TS' /tmp/typecheck.log; do sleep 8; done";

let root: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wait-loop-")));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

interface Verdict {
	warning: string | null;
	denied: boolean;
	reason: string | null;
}

const payload = (input: Record<string, unknown>) => ({
	session_id: "mine",
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: input,
});

function run(command: string, extra: Record<string, unknown> = {}): Verdict {
	const { output } = runCore(
		"guard-wait-loop",
		payload({ command, ...extra }),
		{
			root,
		},
	);
	return {
		warning: output?.additionalContext ?? null,
		denied: output?.permissionDecision === "deny",
		reason: output?.permissionDecisionReason ?? null,
	};
}

const warns = (command: string) => run(command).warning !== null;

describe("an unbounded wait loop", () => {
	it.each([
		[WEDGED_13H, "#2012's 13-hour loop, its session gone"],
		[WEDGED_TSC, "#2012's typecheck poll"],
		["until [ -f /tmp/done ]; do sleep 5; done", "a bare file poll"],
		["while ! grep -q ok /tmp/f; do sleep 2; done", "the while spelling"],
		["ls; until grep -q x /tmp/f; do sleep 5; done", "after a separator"],
		[
			'git commit -m "add timeout"; until grep -q x /tmp/f; do sleep 5; done',
			"a `timeout` only inside a quoted span, which is no ceiling (#1731)",
		],
		[
			"npm run test\nuntil grep -q x /tmp/f; do sleep 5; done",
			"on a second line rather than after a separator",
		],
		["{ until grep -q x /tmp/f; do sleep 5; done; }", "inside a brace group"],
		[
			"until grep -q done /tmp/log; do sleep 5; done",
			"`done` as a grep pattern, which must not end the loop early",
		],
		[
			'nohup bash -c "until grep -q x /tmp/f; do sleep 5; done" &',
			"behind a quote — the shape that actually reparents to init",
		],
		[
			'until [ "$(free -m | awk "/Mem:/{print \\$7}")" -ge 1850 ]; do sleep 30; done',
			"a numeric comparison that is a data condition, not a ceiling",
		],
		[
			"until grep -q x /tmp/f; do sleep 5; n=$((n+1)); done",
			"a counter nothing tests",
		],
	])("%s — %s", (command) => {
		expect(warns(command)).toBe(true);
	});

	it("names the loop it matched, so a compound command says which one", () => {
		const { warning } = run("ls; until grep -q x /tmp/f; do sleep 5; done");
		expect(warning).toContain("until grep -q x /tmp/f; do sleep 5");
	});

	it("names a `bash -c` loop up to its own `done`, not the script's closing quote and what follows (#1808)", () => {
		const { warning } = run(
			"nohup bash -c 'until grep -q x /tmp/f; do sleep 5; done' & echo hi",
		);
		expect(warning).toContain("`until grep -q x /tmp/f; do sleep 5` —");
		expect(warning).not.toContain("echo hi");
	});

	it("hands over both recipes, so the loop is fixable in this turn", () => {
		const { warning } = run(WEDGED_TSC);
		expect(warning).toContain("timeout 600 bash -c");
		expect(warning).toContain("n=$((n+1))");
	});

	it("says what it cannot see, so the session can weigh the warning", () => {
		expect(run(WEDGED_TSC).warning).toContain("What this guard cannot see");
	});

	it("names the ticket the rule came from", () => {
		expect(run(WEDGED_TSC).warning).toContain("#2042");
	});

	it("speaks once however many the command carries", () => {
		const { warning } = run(
			"until a; do sleep 1; done; until b; do sleep 2; done; until c; do sleep 3; done",
		);
		expect(warning?.match(/has no ceiling/g)).toHaveLength(1);
		// The FIRST of them: a guard that merely overwrote would name the last.
		expect(warning).toContain("until a; do sleep 1");
		expect(warning).not.toContain("until c");
	});

	it("still fires where one loop in the command is bounded and another is not", () => {
		expect(
			warns(
				"n=0; until [ $n -ge 5 ]; do sleep 1; n=$((n+1)); done; until b; do sleep 2; done",
			),
		).toBe(true);
	});
});

describe("what it stays out of the way of", () => {
	it.each([
		[
			"timeout 600 bash -c 'until grep -q x /tmp/f; do sleep 5; done'",
			"a timeout-wrapped loop, the recipe the warning recommends",
		],
		[
			"n=0; until [ $n -ge 36 ]; do echo x; sleep 20; n=$((n+1)); done",
			"a counter-bounded loop, the other recipe",
		],
		[
			"n=0; while [ $n -lt 10 ]; do sleep 3; ((n++)); done",
			"the ((n++)) increment spelling",
		],
		[
			"for i in $(seq 1 20); do echo x; sleep 30; done",
			"a for loop, bounded by construction",
		],
		[
			'while read -r line; do echo "$line"; done < /tmp/f',
			"a while loop with no sleep in it",
		],
		["sleep 30", "a sleep with no loop around it"],
		["npm run test:changed", "an ordinary command"],
		[
			'git commit -m "Poll until ready; do sleep 5; done is the old shape"',
			"loop text inside a commit message (#1731)",
		],
		[
			"gh issue comment 5 --body-file - <<'EOF'\nwhile true; do sleep 5; done\nEOF",
			"loop text inside a heredoc body (#1731)",
		],
	])("%s — %s", (command) => {
		expect(run(command)).toEqual({
			warning: null,
			denied: false,
			reason: null,
		});
	});
});

/* THE_WAIT is #1286's command verbatim. */
const THE_WAIT = 'timeout 10104 bash -c "sleep 9984"';

describe("a wait over 15 minutes is refused", () => {
	it.each([
		["sleep 9984", "a bare sleep"],
		[THE_WAIT, "#1286's wait, a sleep inside a long timeout"],
		["sleep 2h", "an hour suffix"],
		["sleep 1h 30m", "GNU sleep's summed arguments"],
		["sleep 600; sleep 600", "two sleeps, one twenty-minute wait"],
		["sleep 901", "one second over"],
		["sleep infinity", "a sleep with no end"],
		["npm run build && sleep 2h", "after other work"],
		['nohup bash -c "sleep 9984" &', "inside a `-c` script"],
		["bash <<'EOF'\nsleep 2h\nEOF", "inside a heredoc fed to a shell"],
		[
			"timeout 3600 bash -c 'until grep -q x /tmp/f; do sleep 5; done'",
			"an uncounted loop under a long timeout",
		],
		[
			"timeout -s KILL 2h bash -lc 'n=0; until [ -f x ]; do sleep 5; done'",
			"timeout's flags, a bundled -lc and a leading assignment",
		],
		['timeout 3600 sleep "$n"', "a long timeout around an unreadable sleep"],
		[
			"n=0; until [ $n -ge 200 ]; do sleep 20; n=$((n+1)); done",
			"a counted loop of 67 minutes",
		],
		["for i in $(seq 1 100); do sleep 60; done", "a for loop over seq"],
		["for i in {1..20}; do sleep 60; done", "a for loop over a brace range"],
	])("%s — %s", (command) => {
		expect(run(command).denied).toBe(true);
	});

	it("is refused when backgrounded too", () => {
		expect(run(THE_WAIT, { run_in_background: true }).denied).toBe(true);
	});

	it("names the wait, the limit and the hand-back route", () => {
		const { reason } = run("sleep 2h");
		expect(reason).toContain("120 minutes");
		expect(reason).toContain("`sleep 2h`");
		expect(reason).toContain("15 MINUTES");
		expect(reason).toContain("release-issue");
		expect(reason).toContain("Gated");
		expect(reason).toMatch(/`result:` or `needs input:`, never `waiting:`/);
	});

	it("names a timeout by its duration, past its own flags", () => {
		expect(
			run("timeout -s KILL 2h bash -lc 'until [ -f x ]; do sleep 5; done'")
				.reason,
		).toContain("`timeout 2h` around an uncounted `until` loop");
	});
});

describe("what passes the 15-minute limit", () => {
	it.each([
		["sleep 600", "ten minutes"],
		["sleep 900", "exactly the limit"],
		["sleep 15m", "the limit, suffixed"],
		["sleep 5 && sleep 5", "two short sleeps"],
		['sleep "$n"', "an unreadable duration, which passes unseen"],
		[
			"timeout 900 bash -c 'until grep -q x /tmp/f; do sleep 5; done'",
			"a wait loop under a timeout at the limit",
		],
		["timeout 1h sleep 899", "a long timeout around a short sleep"],
		[
			"timeout 3600 sh -c 'sleep 2 && npm run build'",
			"a short sleep ahead of long work",
		],
		[
			"timeout 3600 bash -c 'n=0; until [ $n -ge 10 ]; do sleep 5; n=$((n+1)); done'",
			"a short counted loop under a long timeout",
		],
		["timeout 600 npm run test", "a suite under its own timeout"],
		["timeout 3600 npm run build", "long work, which is not a wait"],
		["scripts/bg-run.sh run full -- npm run test -- --full=x", "bg-run.sh run"],
		["node scripts/watch-artefact.js a.md 120", "the artefact watcher"],
		["node scripts/session-arbiter.js wait docs/x.md", "the arbiter's wait"],
		[
			"n=0; until [ $n -ge 36 ]; do sleep 20; n=$((n+1)); done",
			"a counted loop of 12 minutes",
		],
		["for i in {1..10}; do sleep 60; done", "a for loop of 10 minutes"],
		[
			"n=0; until [ $n -ge 200 ]; do sleep $d; n=$((n+1)); done",
			"a counted loop whose interval is unreadable",
		],
		[
			'git commit -m "Refuse sleep 2h waits"',
			"a long sleep quoted in a message",
		],
		[
			'gh issue comment 1288 --body "it ran timeout 10104 bash -c \\"sleep 9984\\""',
			"#1286's command quoted, escaped quotes and all",
		],
		["cat > /tmp/w.sh <<'EOF'\nsleep 2h\nEOF\nls", "a heredoc writing a file"],
		["python3 - <<EOF\nprint('sleep 9984')\nEOF", "a heredoc fed to python"],
	])("%s — %s", (command) => {
		expect(run(command).denied).toBe(false);
	});

	it("still reads the command after a heredoc", () => {
		expect(run("cat > /tmp/w.sh <<'EOF'\nx\nEOF\nsleep 2h").denied).toBe(true);
	});
});

describe("counts a mutant must not survive", () => {
	it.each([
		["for i in {1..4}; do sleep 240; done", "a brace range counts both ends"],
		[
			"for i in $(seq 3); do sleep 400; done",
			"seq with one number counts to it",
		],
		["sleep 500 500", "every duration word is summed"],
	])("refuses %s — %s", (command) => {
		expect(run(command).denied).toBe(true);
	});

	it("passes seq FIRST LAST counted from FIRST", () => {
		expect(run("for i in $(seq 3 4); do sleep 400; done").denied).toBe(false);
	});

	it("rounds the minutes up", () => {
		expect(run("sleep 901").reason).toContain("This waits 16 minutes");
	});

	it("reads the cap from the condition, not the body", () => {
		expect(
			warns(
				"n=0; while true; do [ $n -ge 3 ] && break; sleep 1; n=$((n+1)); done",
			),
		).toBe(true);
	});

	it("leaves a for loop with no count unwarned", () => {
		expect(warns("for f in *.log; do sleep 1; done")).toBe(false);
	});
});

describe("the verdict", () => {
	it("never denies a loop it only warns on", () => {
		for (const command of [WEDGED_13H, WEDGED_TSC, "until a; do sleep 1; done"])
			expect(run(command).denied).toBe(false);
	});
});

describe("fail-open", () => {
	it("allows a payload carrying no command, and records that", () => {
		const { output, logs } = runCore("guard-wait-loop", payload({}), { root });
		expect(output).toBeNull();
		expect(logs.join("\n")).toMatch(/no command in payload/);
	});

	it("says nothing about a loop it judged and passed", () => {
		const { output, logs } = runCore(
			"guard-wait-loop",
			payload({
				command:
					"timeout 600 bash -c 'until grep -q x /tmp/f; do sleep 5; done'",
			}),
			{ root },
		);
		expect(output).toBeNull();
		expect(logs).toEqual([]);
	});
});
