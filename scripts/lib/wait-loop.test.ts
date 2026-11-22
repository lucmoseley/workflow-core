// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

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
		["node scripts/session-arbiter.js wait 540", "the arbiter's wait"],
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

describe("from a linked worktree, its rule is read from the main checkout's store (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});
	const plantRule = (tree: string, id: string, text: string) => {
		vi.stubEnv("WFC_RULES_DIR", "");
		const rules = path.join(tree, "docs", "agents", "rules");
		fs.mkdirSync(rules, { recursive: true });
		fs.writeFileSync(path.join(rules, `${id}.txt`), `${text}\n`);
	};
	const fromWorktree = (command: string) =>
		runCore("guard-wait-loop", toolCall("Bash", { command }), {
			root: at.main,
			worktree: at.worktree,
		}).output;

	it("refuses with the main checkout's wait-length fragment, not the worktree's", () => {
		plantRule(at.main, "wait-length", "HOST WAIT RULE");
		plantRule(at.worktree, "wait-length", "WORKTREE WAIT RULE");
		const reason = String(fromWorktree("sleep 2h")?.permissionDecisionReason);
		expect(reason).toContain("HOST WAIT RULE");
		expect(reason).not.toContain("WORKTREE WAIT RULE");
	});
});

const LOAD_45M = `for i in $(seq 1 90); do l=$(cut -d' ' -f1 /proc/loadavg); awk "BEGIN{exit !($l < 6)}" && break; sleep 30; done; echo "load at start: $(cut -d' ' -f1 /proc/loadavg)"`;
const LOAD_14M = `for i in $(seq 1 28); do l=$(cut -d' ' -f1 /proc/loadavg); awk "BEGIN{exit !($l < 8)}" && break; sleep 30; done; l=$(cut -d' ' -f1 /proc/loadavg); echo "load: $l"`;
const UNTIL_6 = `until [ "$(cut -d. -f1 /proc/loadavg)" -lt 6 ]; do sleep 30; done; npm run test`;

const LOAD_RULE = "A BASH WAIT THAT GATES ON MACHINE LOAD IS BANNED";

describe("a wait loop gated on machine load is refused (#5325)", () => {
	it.each([
		[LOAD_14M, "#5325's 14-minute wait, under the 15-minute limit"],
		[UNTIL_6, "an until loop on /proc/loadavg below 6"],
		[UNTIL_6.replace("-lt 6", "-lt 8"), "the same below 8"],
		[
			"while [ $(uptime | awk -F'average: ' '{print int($2)}') -ge 8 ]; do sleep 20; done",
			"an uptime condition",
		],
		[
			`until node -e 'process.exit(require("os").loadavg()[0] < 6 ? 0 : 1)'; do sleep 10; done`,
			"a node -e condition on os.loadavg",
		],
		[
			"until python3 -c 'import os,sys; sys.exit(os.getloadavg()[0] >= 6)'; do sleep 10; done",
			"a python3 -c condition on os.getloadavg",
		],
		[
			"while true; do l=$(cut -d. -f1 /proc/loadavg); [ $l -lt 6 ] && break; sleep 15; done",
			"a body read with break",
		],
		[
			"while :; do [ $(cut -d. -f1 /proc/loadavg) -lt 6 ] && exit 0; sleep 15; done",
			"a body read with exit",
		],
		[
			"for i in $(seq 1 10); do uptime | grep -q 'average: [0-5]\\.' && break; sleep 20; done",
			"a counted for loop that polls uptime and breaks",
		],
		[
			"bash -c 'until [ $(cut -d. -f1 /proc/loadavg) -lt 6 ]; do sleep 30; done'",
			"inside bash -c",
		],
		[
			"timeout 600 bash -c 'until [ $(cut -d. -f1 /proc/loadavg) -lt 6 ]; do sleep 30; done'",
			"inside timeout … bash -c, so a ceiling does not let it through",
		],
		[
			"bash <<'EOF'\nuntil [ $(cut -d. -f1 /proc/loadavg) -lt 6 ]; do sleep 30; done\nEOF",
			"inside a heredoc fed to bash",
		],
		[
			'bash -c "until [ \\"\\$(cut -d. -f1 /proc/loadavg)\\" -lt 6 ]; do sleep 30; done"',
			"inside a double-quoted bash -c, its inner quotes escaped",
		],
		[
			"while :; do l=$(cut -d. -f1 /proc/loadavg); if [ $l -lt 6 ]; then echo go; break; fi; sleep 15; done",
			"an if on a load variable around the break",
		],
		[
			"while :; do read -r l _ < /proc/loadavg; [ $l -lt 6 ] && break; sleep 15; done",
			"a load read by read, tested beside the break",
		],
		[
			"while true; do if [ $(cut -d. -f1 /proc/loadavg) -lt 6 ]; then break; fi; sleep 30; done",
			"the spec's own `if …; then break; fi` form",
		],
		[
			"for i in $(seq 1 10); do if [ $(cut -d. -f1 /proc/loadavg) -lt 6 ]; then exit 0; fi; sleep 15; done",
			"the same with `then exit 0`",
		],
		[
			"while :; do node -e 'process.exit(require(\"os\").loadavg()[0] < 6 ? 0 : 1)' >/dev/null 2>&1 && break; sleep 10; done",
			"an interpreter test with its output redirected",
		],
		[
			"while :; do read -t 5 l _ < /proc/loadavg; (( l < 6 )) && break; sleep 15; done",
			"a bare name in an arithmetic test, read with a valued flag",
		],
		[
			"while :; do l=$(cut -d. -f1 /proc/loadavg); busy=$((l>5)); [ $busy = 0 ] && break; sleep 15; done",
			"a variable assigned from a load variable",
		],
	])("%s — %s", (command) => {
		const v = run(command);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(LOAD_RULE);
	});

	it("is judged before the 15-minute limit, so a long load wait gets the load-wait reason", () => {
		const { denied, reason } = run(LOAD_45M);
		expect(denied).toBe(true);
		expect(reason).toContain(LOAD_RULE);
		expect(reason).not.toContain("the limit is 15 minutes");
	});

	it("is judged before the no-ceiling warning, refusing where it would only warn", () => {
		const v = run("until grep -q 0 /proc/loadavg; do sleep 5; done");
		expect(v).toMatchObject({ denied: true, warning: null });
	});

	it("names the loop it matched", () => {
		expect(run(LOAD_14M).reason).toContain(
			"`for i in $(seq 1 28); do l=$(cut -d",
		);
	});

	it("names the routes each kind of wait belongs on, and the records a threshold's base rate comes from", () => {
		const reason = String(run(UNTIL_6).reason);
		for (const piece of [
			"#830",
			"queue-run.js",
			"re-run the same",
			"#3210",
			"base rate",
			"load1AtStart",
			"memwatch-minute.jsonl",
		])
			expect(reason).toContain(piece);
	});
});

describe("a double-quoted shell script is read unescaped, by every limb (#5328)", () => {
	it("refuses a counted wait whose inner quotes are escaped", () => {
		const v = run(
			'bash -c "for i in \\$(seq 1 100); do [ \\"\\$x\\" ] && break; sleep 30; done"',
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("the limit is 15 minutes");
	});

	it("warns on an unbounded one", () => {
		const v = run(
			'bash -c "until [ \\"\\$(cat f)\\" = ok ]; do sleep 5; done"',
		);
		expect(v).toMatchObject({ denied: false });
		expect(v.warning).not.toBeNull();
	});
});

describe("where its rule will not read, it still refuses (#5330)", () => {
	it("names the fragment's file in the fallback", () => {
		vi.stubEnv("WFC_RULES_DIR", path.join(root, "no-rules"));
		const { denied, reason } = run(UNTIL_6);
		expect(denied).toBe(true);
		expect(reason).toContain("gates on machine load");
		expect(reason).toContain("agents/rules/load-wait.txt");
		expect(reason).not.toContain(LOAD_RULE);
	});
});

describe("what a load read leaves alone", () => {
	it.each([
		["cat /proc/loadavg", "a one-off read"],
		["uptime", "a one-off uptime"],
		[
			"for i in $(seq 1 60); do cat /proc/loadavg >> /tmp/load.log; sleep 5; done",
			"a sampling loop with no gate",
		],
		[
			"while read -r l; do echo $l; done < /proc/loadavg",
			"a loop reading load with no sleep",
		],
		[
			'git commit -m "Refuse until [ $(cut -d. -f1 /proc/loadavg) -lt 6 ]; do sleep 30; done"',
			"a commit message quoting a load loop",
		],
		[
			"gh issue comment 5325 --body-file - <<'EOF'\nfor i in $(seq 1 28); do l=$(cut -d' ' -f1 /proc/loadavg); [ $l -lt 8 ] && break; sleep 30; done\nEOF",
			"an issue body quoting one",
		],
		[
			"cat > /tmp/w.sh <<EOF\nuntil [ $(cut -d. -f1 /proc/loadavg) -lt 6 ]; do sleep 30; done\nEOF",
			"a heredoc writing one to a file",
		],
		[
			'git commit -m "Deny a \\`until uptime; do sleep 5; done\\` wait"',
			"a commit message quoting one in escaped backticks",
		],
		[
			'gh issue create --title t --body "Shape: \\`until [ \\$(cut -d. -f1 /proc/loadavg) -lt 6 ]; do sleep 30; done\\`"',
			"an issue body quoting one with an escaped substitution",
		],
		[
			"echo -e 'while true; do cat /proc/loadavg; [ x ] && break; sleep 5; done' > /tmp/w.sh",
			"echo -e writing one to a file",
		],
	])("%s — %s", (command) => {
		expect(run(command)).toEqual({
			warning: null,
			denied: false,
			reason: null,
		});
	});

	it.each([
		[
			"n=0; until npm test; do cat /proc/loadavg; [ $n -ge 3 ] && exit 1; n=$((n+1)); sleep 30; done",
			"a retry that logs load and exits on its own count",
		],
		[
			"for i in $(seq 1 60); do cat /proc/loadavg >> /tmp/l.log; [ -f /tmp/stop ] && break; sleep 5; done",
			"a sampler with a stop file",
		],
		[
			"for i in $(seq 1 10); do grep -q x /tmp/loadavg.log && break; sleep 5; done",
			"a file named for load, never read from the kernel",
		],
		[
			`while true; do gh run view 1 | grep -q completed && break; echo "load $(cut -d' ' -f1 /proc/loadavg)"; sleep 30; done`,
			"a CI poll that logs load beside a break on its run",
		],
	])(
		"%s — %s: a break something else decides is no load gate (#5328)",
		(command) => {
			expect(run(command).denied).toBe(false);
		},
	);

	it("leaves an unbounded sampler to the no-ceiling warning alone", () => {
		const v = run(
			"while true; do cat /proc/loadavg >> /tmp/load.log; sleep 5; done",
		);
		expect(v.denied).toBe(false);
		expect(v.warning).not.toBeNull();
	});
});
