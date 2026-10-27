// @vitest-environment node
/*
 * Pins how one Bash command is sorted into `matched` / `invoked` / `wasted`
 * for a candidate `if` rule — the classifier. Every
 * figure mantahostels#2127 turns on is a count of commands sorted into those three.
 *
 * The rows below are seven of the nine commands mantahostels#2159 §5 ran
 * against the live matcher, read in its `Bash(git *)` column, plus the shapes
 * mantahostels#2127 probed against the guards.
 *
 * Built end to end (#1369, §G6: nothing is exported only for its tests): each
 * case writes a one-command transcript, runs the program over it in-process
 * through lib/run-in-process.js's `runInProcessAsync` with `--dir --json`, and
 * reads which counter the command landed in. The four `invoked*` counters are
 * exclusive per command, so the one that moved IS the command's invocation
 * verdict, and `matchedAnchored` is whether the anchored rule fires.
 *
 * CI's vitest step runs this file; the script itself gates nothing and is run
 * by hand. Breaking it misprices a candidate `if` rule in
 * `.claude/settings.json`, so a rule can be chosen that still fires guards on
 * prose, or one that misses calls a guard must judge.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { buildBashCall } from "./lib/transcript-testkit";

const SCRIPT = path.join(__dirname, "measure-if-overmatch.js");

let dir = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "if-overmatch-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const measure = async (records: object[]) => {
	fs.writeFileSync(
		path.join(dir, "t.jsonl"),
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
	const r = await runInProcessAsync(SCRIPT, ["--dir", dir, "--json"]);
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return JSON.parse(r.stdout);
};

type Invocation = "bare" | "wrapped" | "pathspelled" | "quoted" | null;

/** How the scan sorts one command for `tool`. */
const verdict = async (cmd: string, tool: string) => {
	const s = (await measure([buildBashCall(cmd, "t1")]))[tool];
	const moved = Object.entries({
		bare: s.invokedBare,
		wrapped: s.invokedWrapped,
		pathspelled: s.invokedPathspelled,
		quoted: s.invokedQuoted,
	})
		.filter(([, n]) => n)
		.map(([kind]) => kind);
	expect(moved.length).toBeLessThanOrEqual(1);
	return {
		invocation: (moved[0] ?? null) as Invocation,
		anchored: s.matchedAnchored === 1,
	};
};
const invocation = async (cmd: string, tool: string) =>
	(await verdict(cmd, tool)).invocation;
const anchoredFires = async (cmd: string, tool: string) =>
	(await verdict(cmd, tool)).anchored;

describe("segments", () => {
	/*
	 * Two of these six — `;` and `|` — were measured against the live matcher
	 * (mantahostels#2159 §5). The other four are `hooks.md`'s documented behaviour, or were
	 * measured against one guard's own walker rather than the matcher, so the
	 * anchored counts this script prints are an UPPER bound on the matcher's
	 * real coverage.
	 */
	it("splits the six separators, two of them measured", async () => {
		for (const cmd of [
			"echo x ; git status",
			"echo x && git status",
			"false || git status",
			"echo x | git status",
			"echo x & git status",
			"echo x\ngit status",
		]) {
			expect(await anchoredFires(cmd, "git")).toBe(true);
		}
	});

	it("descends into a subshell and a command substitution", async () => {
		expect(await anchoredFires("( git status )", "git")).toBe(true);
		expect(await anchoredFires("echo $(git status)", "git")).toBe(true);
	});

	it("does not split inside a quoted span", async () => {
		const cmd = `sh -c "gh issue close 1; gh issue close 2"`;
		expect(await verdict(cmd, "gh")).toEqual({
			invocation: "quoted",
			anchored: false,
		});
	});

	it("strips a leading assignment, as the matcher does", async () => {
		expect(await verdict("FOO=bar git status", "git")).toEqual({
			invocation: "bare",
			anchored: true,
		});
	});
});

describe("anchoredFires", () => {
	/* mantahostels#2159 §5's first seven rows, read in its `Bash(git *)` column. */
	const measured: [string, boolean][] = [
		["echo P1_plain", false],
		["git --version", true],
		["timeout 5 git --version", false],
		["echo P4 ; git --version", true],
		["git --version | cat", true],
		[`sh -c "git --version"`, false],
		[`echo "P7 git mention"`, false],
	];
	for (const [cmd, fires] of measured) {
		it(`${fires ? "fires" : "does not fire"} on ${cmd}`, async () => {
			expect(await anchoredFires(cmd, "git")).toBe(fires);
		});
	}

	it("does not fire on a bare tool word with no argument", async () => {
		expect(await anchoredFires("gh", "gh")).toBe(false);
	});
});

describe("invocation", () => {
	it("calls prose no invocation at all", async () => {
		for (const cmd of [
			"echo neighbour",
			"echo through the ghost",
			"grep -n right scripts/foo.sh",
		]) {
			expect(await invocation(cmd, "gh")).toBeNull();
		}
	});

	it("counts that prose as wasted under the unanchored rule", async () => {
		const s = (await measure([buildBashCall("echo through the ghost", "t1")]))
			.gh;
		expect(s.matchedUnanchored).toBe(1);
		expect(s.wastedUnanchored).toBe(1);
		expect(s.topWasteWords).toEqual([
			["through", 1],
			["ghost", 1],
		]);
	});

	it("does not read a path or a compound word as an invocation", async () => {
		expect(await invocation("cat .gitignore", "git")).toBeNull();
		expect(await invocation("cat .github/workflows/ci.yml", "git")).toBeNull();
	});

	it("reads a segment leading with the tool as bare", async () => {
		expect(await invocation("echo x ; gh issue view 1", "gh")).toBe("bare");
	});

	it("reads a no-argument wrapper prefix as wrapped", async () => {
		// The three spellings the `guard-issue-phase-scope` core walks (mantahostels#2127).
		expect(await invocation("timeout 60 gh issue view 1", "gh")).toBe(
			"wrapped",
		);
		expect(await invocation("env gh issue view 1", "gh")).toBe("wrapped");
		expect(await invocation("nohup gh issue view 1 &", "gh")).toBe("wrapped");
	});

	it("reads a quoted body as quoted, and a bare mention as neither", async () => {
		expect(await invocation(`sh -c "gh issue view 1"`, "gh")).toBe("quoted");
		expect(await invocation("the gh guard is silent", "gh")).toBeNull();
	});

	it("prefers bare over wrapped when a command has both", async () => {
		expect(
			await invocation("timeout 5 gh issue view 1 ; gh issue view 2", "gh"),
		).toBe("bare");
	});
});

describe("heredoc bodies", () => {
	it("drops a heredoc body, so its lines are not read as commands", async () => {
		const cmd = `cat > f <<'EOF'\ngh issue create --title x\nEOF\necho done`;
		expect(await verdict(cmd, "gh")).toEqual({
			invocation: null,
			anchored: false,
		});
	});

	it("handles an unquoted and a dash-suppressed delimiter", async () => {
		expect(await anchoredFires("cat <<EOF\ngh x\nEOF\n", "gh")).toBe(false);
		expect(await anchoredFires("cat <<-END\ngh x\nEND\n", "gh")).toBe(false);
	});

	it("reads on past the closing delimiter", async () => {
		expect(await invocation("cat <<EOF\nx\nEOF\ngh issue view 1", "gh")).toBe(
			"bare",
		);
	});

	it("drops everything after an unterminated heredoc, as the shell waits", async () => {
		expect(
			await verdict(
				"cat <<'EOF'\ngh issue view 1\nnot the end\ngh issue view 2",
				"gh",
			),
		).toEqual({ invocation: null, anchored: false });
	});
});

describe("the wrapper walk is the guard-issue-phase-scope core's", () => {
	/*
	 * The core's unwrapped() (`scripts/lib/issue-phase-scope.js`) steps over a
	 * no-argument wrapper, plus the ONE leading value `timeout` and `nice` each
	 * take, and stops on anything else.
	 */
	const walks: [string, string][] = [
		["timeout 60 gh issue view 1", "a bare duration"],
		["timeout 5m gh issue view 1", "a suffixed duration"],
		["nice -n 10 gh issue view 1", "nice's own -n pair"],
		["env nohup gh issue view 1", "two wrappers in a row"],
	];
	for (const [cmd, why] of walks) {
		it(`walks past ${why}`, async () => {
			expect(await invocation(cmd, "gh")).toBe("wrapped");
		});
	}

	const stops: [string, string][] = [
		["env FOO=1 gh issue view 1", "an env assignment"],
		["timeout --signal=INT 60 gh issue view 1", "a timeout flag"],
	];
	for (const [cmd, why] of stops) {
		it(`stops on ${why}, as the guard does`, async () => {
			expect(await invocation(cmd, "gh")).toBeNull();
		});
	}
});

describe("path-spelled invocations", () => {
	/*
	 * Every guard resolves its command word through `basename`, so this IS an
	 * invocation they judge — and the anchored `if` matches it in neither
	 * spelling.
	 */
	it("is neither bare nor wasted", async () => {
		expect(await verdict("/usr/bin/gh issue create --title x", "gh")).toEqual({
			invocation: "pathspelled",
			anchored: false,
		});
	});
});

describe("anchored matches are a subset of bare invocations", () => {
	/*
	 * A segment leading with the tool word IS an invocation of it, so the
	 * anchored form cannot waste an exec.
	 */
	const corpusShapes = [
		"gh issue view 1",
		"echo x ; gh issue view 1",
		"cd /tmp && gh issue list",
		"gh issue view 1 | jq .",
		"FOO=bar gh issue view 1",
		"echo neighbour",
		"timeout 60 gh issue view 1",
		`sh -c "gh issue view 1"`,
		"/usr/bin/gh issue view 1",
	];
	for (const cmd of corpusShapes) {
		it(`holds for ${cmd}`, async () => {
			const v = await verdict(cmd, "gh");
			if (v.anchored) expect(v.invocation).toBe("bare");
		});
	}
});

describe("quoted spans", () => {
	it("reads each quoted span's contents, and nothing outside one", async () => {
		expect(
			await invocation(`echo 'a b' && sh -c "gh issue view 1"`, "gh"),
		).toBe("quoted");
		/* `gh` follows a span but sits outside it, as an argument to echo. */
		expect(await invocation(`echo 'a b' gh issue view 1`, "gh")).toBeNull();
	});
});

describe("the scan", () => {
	it("counts a call replayed under the same tool-use id once", async () => {
		const out = await measure([
			buildBashCall("gh issue view 1", "t1"),
			buildBashCall("gh issue view 1", "t1"),
			buildBashCall("gh issue view 2", "t2"),
		]);
		expect(out.bashCalls).toBe(2);
		expect(out.gh.invokedBare).toBe(2);
	});

	it("refuses a transcript directory it cannot read rather than reporting zero", async () => {
		const missing = path.join(dir, "nope");
		const r = await runInProcessAsync(SCRIPT, ["--dir", missing, "--json"]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain(`cannot read ${missing}`);
	});
});
