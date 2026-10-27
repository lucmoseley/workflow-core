// @vitest-environment node
/*
 * guard-paste-self-match.js refuses a turn handing the founder a `!` paste
 * whose `pkill -f` pattern matches the paste itself, or under `-v` misses it
 * (#1814), or whose `pkill` without `-f` selects the shell's name, `bash`, the
 * same two ways (#1842); warns on such a `pgrep`, and passes the rest (#921) —
 * #921's Stop guard, black-box.
 *
 * Driven in process through `lib/stop-guard-testkit`, the way
 * `self-plugin/hooks/hooks.json` runs it, with every root it writes redirected
 * into a temp directory, so its block counter and fail-open log never touch the
 * real repo or config.
 *
 * It runs at every `Stop` (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`),
 * the last place a founder paste can be seen: a break here lets the agent hand
 * the founder a paste that kills their shell.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { readStopGuardBlock } from "./lib/stop-guard-testkit";

const GUARD = path.join(__dirname, "guard-paste-self-match.js");

let dir: string;
let sid = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "paste-self-match-"));
	sid = `s-${path.basename(dir)}`;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The guard's whole output on `message`, or null where it says nothing. */
const run = (message: string) =>
	readStopGuardBlock(GUARD, { dir, sid, message }) as
		| ({ decision?: string; reason?: string; systemMessage?: string } & object)
		| null;

const refused = (message: string) => run(message)?.decision === "block";

/** The fail-open log for this test's project. */
const readErrorLog = () => readFailOpenLog(path.join(dir, "config"), dir);

function refusalFor(message: string, pattern: string): string {
	const out = run(message);
	expect(out?.decision).toBe("block");
	expect(out?.reason).toContain(`pattern /${pattern}/`);
	expect(out?.reason).toContain("kill by pid");
	return out?.reason ?? "";
}

describe("#921: a `!` pkill -f whose pattern recurs in the paste is refused", () => {
	it("refuses a plain pattern followed by its own target, naming it a process kill in a paste", () => {
		const reason = refusalFor(
			"Paste this:\n\n`! pkill -f bake-run.py; nohup python3 bake-run.py &`",
			"bake-run.py",
		);
		expect(reason).toContain("A PROCESS KILL IN A `!` PASTE");
	});

	it("refuses the bracket trick when the literal sits in the same paste, naming the pattern and offering a kill by pid", () => {
		refusalFor(
			'`! pkill -f "[b]ake-run.py"; nohup python3 bake-run.py &` restarts it.',
			"[b]ake-run.py",
		);
	});

	it("refuses a fenced block whose third line names the target", () => {
		refusalFor(
			'Run:\n\n```\n! pkill -f "[b]ake"\nsleep 1\nnohup python3 bake-run.py &\n```\n',
			"[b]ake",
		);
	});

	it("shows a segment typed with a tab on one spaced line", () => {
		const reason = refusalFor(
			"Paste this:\n\n`! pkill -f\tbake-run.py; nohup python3 bake-run.py &`",
			"bake-run.py",
		);
		expect(reason).toContain("  pkill -f bake-run.py\n");
	});

	it("reads a tilde fence", () => {
		refusalFor("~~~\n! pkill -f bake\nbake\n~~~", "bake");
	});

	it("reads -f past a bundled signal", () => {
		refusalFor("`! pkill -STOP -f bake; echo bake`", "bake");
	});

	it("honours -i", () => {
		refusalFor('`! pkill -i -f "[B]AKE"; echo bake`', "[B]AKE");
	});

	it("lists a pgrep read beside the refused kill", () => {
		const reason = refusalFor(
			"`! pkill -f bake; bake`\n\nthen `! pgrep -f '[s]low'; echo slow`",
			"bake",
		);
		expect(reason).toContain("pattern /[s]low/");
	});

	it("reads a double-backtick span", () => {
		refusalFor("`` ! pkill -f x.py; python3 x.py ``", "x.py");
	});
});

describe("#1814: under -v a pattern that misses the paste selects its shell", () => {
	it("refuses a pkill -v -f whose pattern misses, naming the miss and only the kill by pid", () => {
		const reason = refusalFor("`! pkill -v -f '[n]ode'`", "[n]ode");
		expect(reason).toContain("misses, under -v,");
		expect(reason).not.toContain("keep the target string out");
	});

	it("refuses -v -x where the pattern is not the whole paste", () => {
		refusalFor("`! pkill -v -x -f bake; echo bake`", "bake");
	});

	it("warns on a pgrep -v -f whose pattern misses, naming the pattern and the miss", () => {
		const out = run("`! pgrep -v -f '[n]ode'`");
		expect(out?.decision).toBeUndefined();
		expect(out?.systemMessage).toContain("pattern /[n]ode/ misses, under -v,");
	});

	it("passes a pkill -v -f whose pattern matches the paste", () => {
		expect(run("`! pkill -v -f bake; echo bake`")).toBeNull();
	});
});

describe("#1842: without -f the pattern is tested against the shell's name", () => {
	it("refuses a pkill -v whose pattern misses bash, naming the name and only the kill by pid", () => {
		const reason = refusalFor("`! pkill -v node`", "node");
		expect(reason).toContain("misses, under -v, the shell's name, bash,");
		expect(reason).not.toContain("keep the target string out");
	});

	it("refuses a pkill whose pattern matches bash", () => {
		const reason = refusalFor("`! pkill ba; echo done`", "ba");
		expect(reason).toContain("matches the shell's name, bash,");
		expect(reason).toContain("the name `bash` does not match");
	});

	it("warns on a pgrep -v whose pattern misses bash", () => {
		const out = run("`! pgrep -v node`");
		expect(out?.decision).toBeUndefined();
		expect(out?.systemMessage).toContain(
			"pattern /node/ misses, under -v, the shell's name, bash,",
		);
	});

	it("refuses a pkill -v whose segment names $$, which spares no inverted match", () => {
		refusalFor("`! pkill -v -P $$ node`", "node");
	});

	it("passes a pkill -v whose pattern matches bash", () => {
		expect(run("`! pkill -v bash`")).toBeNull();
	});
});

describe("what passes", () => {
	it("passes the bracket trick with no literal elsewhere", () => {
		expect(run('`! pkill -f "[b]ake-run.py"`')).toBeNull();
	});

	it("does not read pkill -f in prose or in a span with no leading !", () => {
		expect(
			run(
				"Never run pkill -f bake-run.py; nohup bake-run.py.\n\n`pkill -f bake-run.py; bake-run.py`\n\n```\npkill -f bake\nbake\n```",
			),
		).toBeNull();
	});

	it("passes a segment carrying $$ or $PPID", () => {
		expect(run("`! pkill -f bake -P $$; echo bake`")).toBeNull();
		expect(run("`! pkill -f bake -P $PPID; echo bake`")).toBeNull();
	});

	it("passes -A, which spares the founder's shell", () => {
		expect(run("`! pkill -A -f bake; bake`")).toBeNull();
	});

	it("passes -x where the pattern is not the whole paste", () => {
		expect(run("`! pkill -x -f bake; echo bake`")).toBeNull();
	});

	it("passes a pattern carrying an expansion and logs it", () => {
		expect(run('`! pkill -f "$TARGET"; echo x`')).toBeNull();
		expect(readErrorLog()).toContain("pattern carries an expansion");
	});

	it("passes pkill without -f whose pattern misses bash", () => {
		expect(run("`! pkill bake; echo bake`")).toBeNull();
	});

	it("passes an uncompilable pattern and logs it", () => {
		expect(run('`! pkill -f "(" ; echo "("`')).toBeNull();
		expect(readErrorLog()).toContain("did not compile as a regex");
	});
});

describe("a matching pgrep -f warns and never refuses", () => {
	it("puts the read on the founder's screen, refusing nothing", () => {
		const out = run('`! pgrep -f "[b]ake"; echo bake`');
		expect(out?.decision).toBeUndefined();
		expect(out?.systemMessage).toContain("pattern /[b]ake/");
	});
});

describe("the cap", () => {
	it("refuses three times, then moves the finding to the screen, naming the pattern there", () => {
		const message = "`! pkill -f bake; bake`";
		for (let i = 0; i < 3; i++) expect(refused(message)).toBe(true);
		const out = run(message);
		expect(out?.decision).toBeUndefined();
		expect(out?.systemMessage).toContain("pattern /bake/");
	});
});
