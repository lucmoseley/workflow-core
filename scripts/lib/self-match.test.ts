// @vitest-environment node
/*
 * lib/self-match.js, a PreToolUse dispatcher core (#2790), answers one
 * question: does this command select the shell running it — by full command
 * line with a pattern its own text matches (#1782, #1805), by name with a
 * pattern `bash` matches (#1842), or either inverted with one that misses
 * (#1847)? `pkill` is denied; `pgrep` and a `ps | grep` liveness check are
 * warned (the second limb mantahostels#2014).
 *
 * A deny is only defensible while it cannot wedge sanctioned work, so every
 * silent case below is a shape that would otherwise be a false positive. Do not
 * thin them out.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * real rule store and a latch directory in the case's temp dir. `run` renders
 * the merged output as the hook line writes it, so each case reads the text a
 * session receives. The hook line itself is scripts/guard-dispatch.test.ts's
 * boundary set.
 *
 * Loosen a case and a session kills its own shell, or waits for ever on a
 * pattern that matches its own loop; widen it and a `kill` by pid or a `pkill`
 * by a name other than the shell's is refused.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";

let dir: string;

type Verdict = "deny" | "warn" | "silent";

/** The core's answer on `command`, as the hook line writes it. */
const run = (command: string) => {
	const { output } = runCore(
		"guard-self-match",
		{
			session_id: "test",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		},
		{ root: dir },
	);
	return output
		? JSON.stringify({
				hookSpecificOutput: { hookEventName: "PreToolUse", ...output },
			})
		: "";
};

const verdict = (command: string): Verdict => {
	const out = run(command);
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
	if (/"additionalContext"/.test(out)) return "warn";
	return "silent";
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "self-match-")));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("pkill by command line is denied", () => {
	it.each([
		[
			"pkill -f 'node -c'",
			"#1858 (the 2026-08-23 incident): the command that killed its own shell",
		],
		["pkill -f land.sh", "an unquoted pattern"],
		["pkill --full land.sh", "the long spelling"],
		["pkill -9 -f land.sh", "with a signal in front"],
		["pkill -if land.sh", "-f inside a bundle"],
		["ls && pkill -f land.sh", "the second command of a compound"],
		["/usr/bin/pkill -f land.sh", "called by its path"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("deny");
	});

	it("says why the pattern matches, not merely that it might", () => {
		const out = run("pkill -f land.sh");
		expect(out).toContain("/bin/bash -c");
		expect(out).toContain("exit 144");
	});

	it("carries the pid recipe", () => {
		expect(run("pkill -f land.sh")).toContain("pidfile");
	});
});

describe("pgrep by command line warns rather than denying", () => {
	it.each([
		["pgrep -f land.sh", "the plain form"],
		["pgrep -af land.sh", "-f inside a bundle"],
		["pgrep --full land.sh", "the long spelling"],
		[
			"while pgrep -f land.sh; do sleep 15; done",
			"#1858 (the 2026-08-23 incident): the loop shape that wedged a background job",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("warn");
	});

	/*
	 * mantahostels#103: deny on a structured fact, warn where the guard is inferring.
	 */
	it("never denies a read", () => {
		expect(run("pgrep -f land.sh")).not.toContain('"deny"');
	});

	it("names the command it is warning about", () => {
		expect(run("pgrep -f land.sh")).toContain("pgrep -f land.sh");
	});

	it("speaks once for a compound command full of them", () => {
		const out = run("pgrep -f a.sh; pgrep -f b.sh; pgrep -f c.sh");
		expect(out.match(/matches the command line/g)).toHaveLength(1);
	});
});

describe("what it stays out of the way of", () => {
	it.each([
		["pkill node", "pkill by process name never reads a command line"],
		["killall node", "killall matches names, so it cannot self-match"],
		["kill 1234", "a pid, which is the recipe the guard recommends"],
		["kill -9 1234 5678", "several pids"],
		["ps -eo pid,args", "a plain listing with no pattern"],
		["echo 'never pkill -f x'", "a mention inside a quoted span"],
		["grep -f patterns.txt file", "-f on a command that is not pgrep/pkill"],
		["git commit -m 'x' -- a.md", "an ordinary command"],
		["pkill -fA land.sh", "-A, which spares the calling shell"],
		["pkill -uf lucmo land.sh", "-u taking f as its value, so no -f"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("silent");
	});

	/*
	 * A caller who has named the calling shell has already reckoned with the
	 * self-match, and needs no lecture.
	 */
	it.each([
		["pgrep -f land.sh | grep -v $$", "excluding this shell from a read"],
		["pkill -f land.sh --older-than $PPID", "naming the parent"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("silent");
	});
});

/*
 * A pattern that cannot match the command's own text cannot self-match, so it
 * passes as a `ps | grep` one does (#1805); every way the guard cannot prove
 * that keeps the verdict.
 */
describe("a pgrep -f or pkill -f whose pattern cannot match its own text", () => {
	it.each([
		["pkill -f '[l]and.sh'", "a bracketed first character"],
		["pgrep -f '[n]ode'", "a read"],
		["pkill -9 -f '[l]and.sh'", "with a signal in front"],
		["pkill -u lucmo -f '[n]ode'", "behind a value-taking flag"],
		["pgrep -fi '[N]ODE'", "case-folded"],
		["while pgrep -f '[l]and.sh'; do sleep 15; done", "inside a loop"],
	])("%s — %s passes", (command) => {
		expect(verdict(command)).toBe("silent");
	});

	it.each([
		["pkill -f '[n]ode'; echo node", "deny", "the bare word elsewhere"],
		["pkill -f '[b]ash'", "deny", "the shell's own /bin/bash -c"],
		["pkill -v -f '[n]ode'", "deny", "inverted"],
		['pkill -f "$x"', "deny", "a pattern read from a variable"],
		["pkill -f", "deny", "no pattern at all"],
		["pkill -f 'nex''t'", "deny", "matching the words as ps prints them"],
		["pgrep -fi '[N]ODE'; echo node", "warn", "case-folded, bare elsewhere"],
	])("%s — %s: %s", (command, expected) => {
		expect(verdict(command)).toBe(expected);
	});

	it("hands over the bracket and -A recipes", () => {
		const out = run("pkill -f land.sh");
		expect(out).toContain("'[n]ode'");
		expect(out).toContain("-A");
	});
});

/*
 * `pgrep -af` is the regression from #1858 (the 2026-08-23 incident), paired
 * with `pkill -if land.sh` in the first block (§X4). Before the bundle walker
 * was used, `-af` read as a single unknown flag and the guard stayed silent on
 * it.
 */
describe("a bundled -f is still -f", () => {
	it("warns on pgrep -af", () => {
		expect(verdict("pgrep -af land.sh")).toBe("warn");
	});

	it("denies pkill -9f, where f is the last letter of the bundle", () => {
		expect(verdict("pkill -9f land.sh")).toBe("deny");
	});
});

/*
 * #1847 (the ticket giving -v its own text): an inverted pattern selects every
 * process it misses, so the bracket recipe, which makes a pattern miss the
 * shell, puts the shell in. The text must say so and offer the pid alone.
 */
describe("a pgrep -v -f or pkill -v -f is told the inverted hazard", () => {
	it.each([
		["pkill -v -f vitest", "deny"],
		["pgrep -v -f vitest", "warn"],
	])("%s — %s, without the bracket recipe", (command, expected) => {
		expect(verdict(command)).toBe(expected);
		const out = run(command);
		expect(out).toContain("is inverted");
		expect(out).toContain("puts the shell in");
		expect(out).toContain("pidfile");
		expect(out).not.toContain("'[n]ode'");
		expect(out).not.toContain("matches the command line of the shell");
	});
});

/*
 * #1842 (the ticket judging pgrep/pkill without -f): the pattern is tested
 * against process names, and the shell running the command is named bash —
 * selected where the pattern matches that name, or under -v misses it.
 */
describe("a pgrep or pkill without -f whose pattern selects the shell's name", () => {
	it.each([
		["pkill -v node", "deny", "inverted, missing bash"],
		["pgrep -v node", "warn", "an inverted read"],
		["pkill ba", "deny", "a pattern bash matches"],
		["pkill -i BASH", "deny", "case-folded"],
		["pgrep -x bash", "warn", "the exact name, read"],
		['pkill -v "$x"', "deny", "inverted, from a variable"],
		["while pgrep -v node; do sleep 1; done", "warn", "inside a loop"],
	])("%s — %s: %s", (command, expected) => {
		expect(verdict(command)).toBe(expected);
	});

	it("names bash, offers a name it does not match, and no bracket recipe", () => {
		const out = run("pkill ba");
		expect(out).toContain("`bash`");
		expect(out).toContain("use one `bash` does not match");
		expect(out).not.toContain("'[n]ode'");
	});

	/*
	 * Naming the shell spares it from no inverted match: `-P $$` under `-v`
	 * selects every process that is not this shell's child, the shell included.
	 */
	it.each([
		["pkill -v node; echo $$", "deny"],
		["pkill -v -P $$ node", "deny"],
		["pgrep -v -f vitest | grep -v $PPID", "warn"],
	])("%s — %s, though it names the shell", (command, expected) => {
		expect(verdict(command)).toBe(expected);
	});

	it("tells an inverted one the inverted hazard", () => {
		expect(run("pkill -v node")).toContain("is inverted");
	});

	it.each([
		["pkill node", "a name bash does not match"],
		["pkill -x ba", "anchored, so ba is not bash"],
		["pkill -v bash", "inverted, sparing bash"],
		["pkill -A -v node", "-A, which spares the calling shell"],
		['pkill "$x"', "a variable, not inverted"],
		["pkill -v '('", "a pattern that will not compile, so nothing is killed"],
	])("%s — %s passes", (command) => {
		expect(verdict(command)).toBe("silent");
	});
});

describe("ps piped into grep warns, checking a job's liveness", () => {
	it.each([
		[
			"ps -ef | grep berl18qst",
			"mantahostels#2014's shape, which misreported a live job as gone",
		],
		["ps aux | grep -i vitest", "the BSD-style flag spelling"],
		["ps -ef|grep node", "no spaces around the pipe"],
		["while ps -ef | grep -q foo; do sleep 1; done", "inside a poll loop"],
		["npm run test && ps -ef | grep node", "the second command of a compound"],
		["if ! ps -ef | grep -q node; then echo dead; fi", "after a negation"],
		["{ ps -ef | grep node; }", "inside a brace group"],
		[
			"npm run test\nps -ef | grep node",
			"the second line, not the second command",
		],
		[
			"ps -ef | grep -v grep",
			"the grep -v grep idiom, which does not hide from this check",
		],
		['ps -ef | grep "$name"', "a pattern read from a variable"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("warn");
	});

	it("never denies it", () => {
		expect(run("ps -ef | grep node")).not.toContain('"deny"');
	});

	it("points at the verification doc", () => {
		expect(run("ps -ef | grep node")).toContain("docs/agents/verification.md");
	});

	it("names the harness-task-id and grep -v grep failures, not a process-visibility one", () => {
		const out = run("ps -ef | grep node");
		expect(out).toContain("harness's own task id");
		expect(out).not.toContain("process view does not include");
	});

	it.each([
		["ps -ef | grep $$", "excluding this shell from the read"],
		["ps aux | grep $PPID", "naming the parent"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("silent");
	});

	it.each([
		["ps -eo pid,args", "no grep at all"],
		["ps -ef | awk '{print $2}'", "not piped into grep"],
		["cat file | grep ps", "grep, but not fed by ps"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("silent");
	});
});

/*
 * A pattern that cannot match the command's own text cannot self-match, so it
 * passes (#1782); every way the guard cannot prove that still warns.
 */
describe("a ps | grep whose pattern cannot match its own text", () => {
	it("passes the build-concurrency rule's own recipe, read from the fragment", () => {
		const fragment = fs.readFileSync(
			path.resolve(__dirname, "../../docs/agents/rules/build-concurrency.txt"),
			"utf8",
		);
		const recipe = fragment
			.split("\n")
			.map((line) => line.trim())
			.find((line) => /^ps\b.*\|\s*grep\b/.test(line));
		expect(recipe).toBeDefined();
		expect(verdict(recipe as string)).toBe("silent");
	});

	it.each([
		["ps -ef | grep '[n]ode'", "a bracketed first character"],
		["ps -ef | grep -i '[N]ODE'", "case-folded"],
		["ps -ef | egrep '[v]itest|[n]ext'", "every alternative bracketed"],
		["ps -ef | grep -e '[n]ode' -e '[v]itest'", "every -e pattern bracketed"],
		["while ps -ef | grep -q '[n]ode'; do sleep 1; done", "inside a loop"],
	])("%s — %s passes", (command) => {
		expect(verdict(command)).toBe("silent");
	});

	it.each([
		["ps -ef | egrep node", "egrep, bare"],
		["ps -ef | fgrep node", "fgrep, bare"],
		["ps -ef | grep '[n]ode' | grep -v grep", "a trailing grep -v grep"],
		["ps -ef | grep -F '[n]ode'", "a fixed string, whose bracket is literal"],
		["ps -ef | grep -E '[v]itest|next'", "one alternative left bare"],
		["ps -ef | grep -e '[n]ode' -e vitest", "one -e pattern left bare"],
		["ps -ef | grep -v '[g]rep'", "inverted"],
		["ps -ef | grep -v '[n]ode'", "inverted, its pattern missing its own text"],
		["ps -ef | grep -f patterns.txt", "patterns from a file"],
		["ps -ef | grep -P '[n]ode'", "a Perl regex, never tested"],
		[
			"ps -ef | grep '[n]ode(x'",
			"a basic regex an extended one reads otherwise",
		],
		["ps -ef | grep 'nex''t'", "matching the words as ps prints them"],
		[
			"ps -ef | grep '[n]ode'; echo node",
			"the bare word elsewhere in the command",
		],
		["ps -ef | grep '[b]ash'", "the shell's own /bin/bash -c"],
	])("%s — %s still warns, handing over the bracket recipe", (command) => {
		const out = run(command);
		expect(out).toContain('"additionalContext"');
		expect(out).toContain("grep '[n]ode'");
	});
});

/*
 * #2027: the comm-counting rule left the always-loaded CLAUDE.md for this
 * guard, so its whole text must arrive on the trigger.
 */
const ruleText = fs
	.readFileSync(
		path.resolve(__dirname, "../../docs/agents/rules/claude-process-count.txt"),
		"utf8",
	)
	.trim();

const context = (command: string) => {
	const out = run(command);
	return out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
};

describe("a Claude process count matched on comm is handed the rule", () => {
	it.each([
		["pgrep -c claude", "pgrep by name"],
		["pgrep claude | wc -l", "pgrep by name, counted"],
		["ps -C claude -o pid=", "ps selecting by command name"],
		["ps -Cclaude", "-C bundled with its value"],
		["ps -e | grep -c claude", "the UNIX default format, whose CMD is comm"],
		["ps -eo pid,comm:30 | grep -c claude", "a comm column with a width"],
		['ps -o "pid comm" | grep -c claude', "a space-separated format list"],
		["ps -eo pid,comm | grep -c claude", "a comm column"],
		["ps axo comm | grep '[c]laude'", "a BSD format and a bracketed pattern"],
		["cat /proc/*/comm | grep -c claude", "/proc's comm files"],
		[
			'for p in /proc/[0-9]*; do cat "$p/comm"; done | grep -c claude',
			"/proc's comm files, read in a loop",
		],
	])("%s — %s", (command) => {
		expect(context(command)).toContain(ruleText);
	});

	it("rides beside the self-match warning in one envelope", () => {
		const said = context("ps -eo pid,comm | grep -c claude");
		expect(said).toContain("`ps | grep` self-matches");
		expect(said).toContain(ruleText);
	});

	it("is said once a session", () => {
		expect(context("pgrep -c claude")).toContain(ruleText);
		expect(context("pgrep -c claude")).toBe("");
	});
});

describe("a count matched on argv[0], or not on claude, is handed no rule", () => {
	it.each([
		["pgrep -fc claude", "-f reads the command line, argv[0] included"],
		[
			"ps -eo pid,comm,args | grep -c '[c]laude'",
			"an args column beside the comm one",
		],
		["ps -e -o comm= | sort", "a comm listing that never names claude"],
		["pgrep -c node", "a name count of something else"],
		["ps -o comm= -C node", "-C naming something else"],
		[
			"ps -eo pid,comm,args:200 | grep -c '[c]laude'",
			"an args column with a width",
		],
		["ps -ef | grep -c '[c]laude'", "-f, whose CMD is args"],
		["ps aux | grep -c '[c]laude'", "a BSD format, whose COMMAND is args"],
		["ps -ef --sort comm | grep -c '[c]laude'", "comm as a sort key alone"],
		["ps -O comm | grep -c '[c]laude'", "-O, which keeps the args column"],
	])("%s — %s", (command) => {
		expect(context(command)).not.toContain("NEVER `comm`");
	});
});

describe("cases a mutant must not survive", () => {
	it("quotes a denied pkill with its quoted span shown as …", () => {
		expect(run("pkill -f 'node -c'")).toContain(
			'pkill -f \\"…\\" matches the command line',
		);
	});

	it("judges a pkill behind `time`, which the bash guard read as the command", () => {
		expect(run("time pkill -f node")).toContain("matches the command line");
	});

	it("keeps the first pgrep's warning where a later one would say another", () => {
		expect(context("pgrep -f node; pgrep -v -f x")).toMatch(
			/^pgrep -f node matches the command line/,
		);
	});

	it.each([
		[
			"ps -ef | grep '[n]ode\n'",
			"a pattern ending in a newline, whose empty last line GNU grep matches everywhere",
		],
		[
			`echo "a; ps -ef | grep '[n]ode'"`,
			"a ps | grep the walk finds no grep for",
		],
	])("warns on %j — %s", (command) => {
		expect(verdict(command)).toBe("warn");
	});

	it.each([
		[
			"ps -eo comm,cmd | grep -c '[c]laude'",
			"a cmd column beside the comm one",
		],
		["grep claude /tmp/comm", "a comm path outside /proc"],
	])("hands no rule on %s — %s", (command) => {
		expect(context(command)).not.toContain("NEVER `comm`");
	});
});
