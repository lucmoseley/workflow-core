// @vitest-environment node
/*
 * lib/wide-read.js (#2791), mantahostels#1562's core: given one opaque shell
 * string, is this command about to pour a whole file, a wide slice or an
 * uncounted glob into the context window? And since mantahostels#2595, the
 * same question of a `Read` tool call, which a Bash-only hook never saw.
 *
 * The fire cases prove it names the shape and the cheaper form; the pass cases
 * prove it stays silent on a bounded read. Every case asserts no
 * `permissionDecision`: this guard warns and must never deny, whatever it
 * matched.
 *
 * Module cases, over small files in a temp repo with the thresholds passed as
 * WFC_WIDE_READ_* so fixtures stay tiny; one block binds the shipped default
 * instead. The `Read` limb runs through lib/guard-core-testkit.ts as the
 * dispatcher runs it, latches and all. The Bash limbs call `decide` with the
 * production host ports (lib/wide-read-host.js) and a built context; the
 * dispatcher entry is crossed for them in guard-wide-read.test.ts.
 *
 * Loosen a fire case and whole files pour into a session's context unwarned,
 * the largest share of a long session's spend (mantahostels#1553); loosen a
 * pass case and bounded reads draw noise.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";
import { decide } from "./wide-read.js";
import { buildHostPorts } from "./wide-read-host.js";

/** Thresholds the fixtures are sized against, passed to the core as its own. */
const WIDE_BYTES = 1000;
const WIDE_LINES = 20;
const WIDE_MATCHES = 3;
/** The Read limb's threshold, overridden the same way. */
const WIDE_READ_BYTES = 1000;

const THRESHOLDS: Record<string, string> = {
	WFC_WIDE_READ_BYTES: String(WIDE_BYTES),
	WFC_WIDE_READ_LINES: String(WIDE_LINES),
	WFC_WIDE_READ_MATCHES: String(WIDE_MATCHES),
	WFC_WIDE_READ_TOOL_BYTES: String(WIDE_READ_BYTES),
};

let dir: string;
let repo: string;
let logs: string[];

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wide-read-")));
	repo = path.join(dir, "repo");
	fs.mkdirSync(repo, { recursive: true });
	logs = [];
	// One file over the byte threshold, one comfortably under, and four small
	// ones so a glob can cross the match threshold without crossing the byte one.
	fs.writeFileSync(path.join(repo, "big.md"), "x".repeat(WIDE_BYTES + 1));
	fs.writeFileSync(path.join(repo, "small.md"), "x".repeat(20));
	for (const n of [1, 2, 3, 4])
		fs.writeFileSync(path.join(repo, `part-${n}.txt`), "y".repeat(10));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Verdict {
	warning: string | null;
	denied: boolean;
}

/** `env` laid over the thresholds; an `undefined` value removes the key, so a
 * case can bind the SHIPPED default. */
const envWith = (env: Record<string, string | undefined>) => {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries({ ...THRESHOLDS, ...env }))
		if (v !== undefined) out[k] = v;
	return out;
};

/** The core on a Bash `command`, standing in the repo, as the entry runs it. */
function run(
	command: string,
	env: Record<string, string | undefined> = {},
): Verdict {
	const ctx = kitContextFake({
		input: { command },
		cwd: repo,
		fallbackCwd: repo,
		isDir: (p: string) =>
			fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
		log: (what: string) => logs.push(what),
		env: envWith(env),
		...buildHostPorts(),
	});
	const d = decide(command, ctx);
	return {
		warning: d && "context" in d ? d.context : null,
		denied: !!d && "deny" in d,
	};
}

/** The core on a `Read` payload through the dispatcher: the file, and
 * optionally offset and limit. */
function runRead(
	toolInput: Record<string, unknown>,
	env: Record<string, string | undefined> = {},
	agent?: string,
): Verdict {
	const r = runCore(
		"guard-wide-read",
		{
			session_id: "mine",
			tool_name: "Read",
			tool_input: toolInput,
			...(agent ? { agent_id: agent } : {}),
		},
		{ root: repo, cwd: repo, env: envWith(env) },
	);
	logs.push(...r.logs);
	return {
		warning: r.output?.additionalContext ?? null,
		denied: r.output?.permissionDecision === "deny",
	};
}

const silent = { warning: null, denied: false };

describe("the shapes it warns on", () => {
	it("names the size of a whole file read with cat", () => {
		const { warning, denied } = run("cat big.md");
		expect(denied).toBe(false);
		expect(warning).toContain("Reading a whole file into context");
		expect(warning).toContain(String(WIDE_BYTES + 1));
		expect(warning).toContain("sed -n '<start>,<end>p' big.md");
		expect(warning).toContain("`… > .claude/tmp/out.txt`");
	});

	it("names the line span of a wide `sed -n` range", () => {
		const { warning, denied } = run(`sed -n '1,${WIDE_LINES}p' big.md`);
		expect(denied).toBe(false);
		expect(warning).toContain("This `sed -n` range is wide");
		expect(warning).toContain(`prints ${WIDE_LINES} lines`);
	});

	it("treats a range open to the end of the file as wide however short", () => {
		const { warning } = run("sed -n '1,$p' small.md");
		expect(warning).toContain("open-ended to the end of the file");
	});

	it("counts a glob the session did not count", () => {
		const { warning, denied } = run("cat part-*.txt");
		expect(denied).toBe(false);
		expect(warning).toContain("This glob's match count is unknown to you");
		expect(warning).toContain(`matches at least ${WIDE_MATCHES} files`);
	});

	it("points at the document that owns the convention", () => {
		expect(run("cat big.md").warning).toContain("docs/agents/tool-output.md");
	});
});

describe("a read past Bash's own output cap", () => {
	// #1029.
	const cutBytes = 2000;
	const cut = (command: string) =>
		run(command, { WFC_WIDE_READ_CUT_BYTES: String(cutBytes) }).warning;

	it("names the cut-off and the remedy on a cat at the threshold", () => {
		fs.writeFileSync(path.join(repo, "huge.md"), "x".repeat(cutBytes));
		const warning = cut("cat huge.md");
		expect(warning).toContain("may cut this off with no notice");
		expect(warning).toContain("2 KB preview");
		expect(warning).toContain("use `Read` with `offset` and `limit`");
	});

	it("gives the existing warning without the cut-off one character under it", () => {
		fs.writeFileSync(path.join(repo, "huge.md"), "x".repeat(cutBytes - 1));
		const warning = cut("cat huge.md");
		expect(warning).toContain("Reading a whole file into context");
		expect(warning).not.toContain("may cut this off");
	});

	it("names the cut-off on a glob that measured past it", () => {
		fs.writeFileSync(path.join(repo, "huge-1.md"), "x".repeat(cutBytes));
		expect(cut("cat huge-*.md")).toMatch(
			/This glob's match count[\s\S]*may cut this off/,
		);
	});

	it("ships at the CLI's 30,000-character default", () => {
		fs.writeFileSync(path.join(repo, "huge.md"), "x".repeat(30_000));
		expect(
			run("cat huge.md", { WFC_WIDE_READ_CUT_BYTES: undefined }).warning,
		).toContain("Past ~30000 characters");
	});
});

describe("the reads it must stay silent on", () => {
	it.each([
		["stays silent on a bounded read of a large file", "sed -n '1,5p' big.md"],
		["stays silent on a whole file that is small", "cat small.md"],
		["stays silent on a large read piped into a bound", "cat big.md | head -5"],
		[
			"stays silent on a large read redirected to a file",
			"cat big.md > out.txt",
		],
		["stays silent under both glob thresholds", "cat part-1.txt part-2.txt"],
		["stays silent on a command that summarises", "wc -c big.md"],
		["stays silent on a large file named in prose", "echo 'cat big.md'"],
		["stays silent on a file that does not exist", "cat absent.md"],
		["stays silent on an ordinary command", "ls -la"],
		// grep, rg, head and tail bound their own output, so a glob given to one
		// is the cheaper form this guard recommends, not a shape to warn about.
		["stays silent on a glob given to grep", "grep -n x part-*.txt"],
		["stays silent on a glob given to head", "head -2 part-*.txt"],
	])("%s", (_what, command) => {
		expect(run(command)).toEqual(silent);
	});
});

describe("the default byte threshold", () => {
	// Every other case overrides WFC_WIDE_READ_BYTES, so nothing else here can
	// see the shipped default move (mantahostels#2571).
	const defaultWideBytes = 20_000;

	/** Runs the core with no byte override, so the shipped default binds. */
	const runShipped = (command: string) =>
		run(command, { WFC_WIDE_READ_BYTES: undefined });

	beforeEach(() => {
		fs.writeFileSync(
			path.join(repo, "under.md"),
			"x".repeat(defaultWideBytes - 1),
		);
		fs.writeFileSync(
			path.join(repo, "over.md"),
			"x".repeat(defaultWideBytes + 1),
		);
	});

	it("stays silent one character under it", () => {
		expect(runShipped("cat under.md")).toEqual(silent);
	});

	it("warns one character over it, quoting the byte count", () => {
		const { warning, denied } = runShipped("cat over.md");
		expect(denied).toBe(false);
		expect(warning).toContain("Reading a whole file into context");
		expect(warning).toContain(String(defaultWideBytes + 1));
	});
});

describe("the verdict", () => {
	it("never denies, on any shape it matches", () => {
		for (const command of [
			"cat big.md",
			"sed -n '1,999p' big.md",
			"cat part-*.txt",
		])
			expect(run(command).denied).toBe(false);
	});

	it("reports both shapes when one command carries two", () => {
		const { warning } = run(`cat big.md && sed -n '1,${WIDE_LINES}p' big.md`);
		expect(warning).toContain("Reading a whole file into context");
		expect(warning).toContain("This `sed -n` range is wide");
	});
});

describe("the Read limb", () => {
	// mantahostels#2595. Every case here goes through a `Read` payload.
	const abs = (name: string) => path.join(repo, name);

	beforeEach(() => {
		// 3,000 lines of 10 characters, so the first 2,000 are 20,000 characters
		// and the last 1,000 are the part `Read` would never return.
		fs.writeFileSync(path.join(repo, "long.md"), "abcdefghi\n".repeat(3000));
		// 2,000 lines of 2 characters, then one very long line past the cap. The
		// whole file clears the threshold below; the window `Read` returns does not.
		fs.writeFileSync(
			path.join(repo, "tail-only.md"),
			`${"a\n".repeat(2000)}${"b".repeat(10_000)}\n`,
		);
	});

	it("names the size of a whole-file Read and the one-call remedy", () => {
		const { warning, denied } = runRead({ file_path: abs("big.md") });
		expect(denied).toBe(false);
		expect(warning).toContain("pours a whole file into context");
		expect(warning).toContain("`Read` with `offset` and `limit`");
		expect(warning).toContain(String(WIDE_BYTES + 1));
	});

	it("stays silent on a Read carrying a limit, however large the file", () => {
		expect(runRead({ file_path: abs("long.md"), limit: 20 })).toEqual(silent);
	});

	it("still judges a Read carrying an offset but no limit", () => {
		// An offset moves the window; it does not bound it.
		const { warning } = runRead({ file_path: abs("long.md"), offset: 5 });
		expect(warning).toContain("pours a whole file into context");
	});

	it("measures the lines Read returns, not the file", () => {
		// The wide part sits past line 2,000, where `Read` stops. The file is
		// 14,000 characters and the window is 4,000, so a threshold between them
		// separates the two measures: warning here would mean it measured the file.
		const env = { WFC_WIDE_READ_TOOL_BYTES: "5000" };
		expect(runRead({ file_path: abs("tail-only.md") }, env)).toEqual(silent);
		// The same file read from the far side of the cap does warn, which proves
		// the silence above is the window and not an unreadable fixture.
		const { warning } = runRead(
			{ file_path: abs("tail-only.md"), offset: 2001 },
			env,
		);
		expect(warning).toContain("pours a whole file into context");
	});

	it.each([
		["stays silent on a small file", "small.md"],
		["stays silent on a file that does not exist", "absent.md"],
		["stays silent on a directory", "."],
	])("%s", (_what, name) => {
		expect(runRead({ file_path: path.join(repo, name) })).toEqual(silent);
	});

	it("skips a rendered file, whose bytes are not what the session pays for", () => {
		fs.writeFileSync(
			path.join(repo, "shot.png"),
			"x".repeat(WIDE_READ_BYTES + 1),
		);
		expect(runRead({ file_path: abs("shot.png") })).toEqual(silent);
	});

	it("never denies", () => {
		expect(runRead({ file_path: abs("big.md") }).denied).toBe(false);
	});

	it("names the path it measured", () => {
		expect(runRead({ file_path: abs("big.md") }).warning).toContain(
			abs("big.md"),
		);
	});

	it.each([
		// A leading zero and an offset past nine digits must read as "no offset"
		// and judge from line 1, as must anything not a positive integer.
		["a leading-zero offset", "08"],
		["an offset wider than any file", "99999999999999999999"],
		["a non-numeric offset", "first"],
		["a zero offset", "0"],
	])("judges from line 1 given %s", (_what, offset) => {
		const { warning } = runRead({ file_path: abs("big.md"), offset });
		expect(warning).toContain("pours a whole file into context");
	});

	it("stays silent on a rendered file however its extension is cased", () => {
		fs.writeFileSync(
			path.join(repo, "SHOT.PNG"),
			"x".repeat(WIDE_READ_BYTES + 1),
		);
		expect(runRead({ file_path: abs("SHOT.PNG") })).toEqual(silent);
	});

	it("measures a relative path from the hook's own directory, a leading dash and all", () => {
		// PreToolUse fires before the Read tool rejects such a path.
		fs.writeFileSync(path.join(repo, "-n.md"), "x".repeat(WIDE_READ_BYTES + 1));
		const { warning } = runRead({ file_path: "-n.md" });
		expect(warning).toContain("pours a whole file into context");
	});

	it("points at the document that owns the convention", () => {
		expect(runRead({ file_path: abs("big.md") }).warning).toContain(
			"docs/agents/tool-output.md",
		);
	});
});

describe("the Read limb's latch", () => {
	// #1034.
	const abs = (name: string) => path.join(repo, name);

	beforeEach(() => {
		fs.writeFileSync(abs("other.md"), "x".repeat(WIDE_READ_BYTES + 1));
	});

	const readAs = (toolInput: Record<string, unknown>, agent?: string) =>
		runRead(toolInput, {}, agent).warning;

	it("warns once on two reads of the same file by the same agent", () => {
		expect(readAs({ file_path: abs("big.md") })).toContain(
			"pours a whole file",
		);
		expect(readAs({ file_path: abs("big.md") })).toBeNull();
	});

	it("warns a different agent on the same file", () => {
		expect(readAs({ file_path: abs("big.md") }, "a1")).toContain(
			"pours a whole file",
		);
		expect(readAs({ file_path: abs("big.md") }, "a2")).toContain(
			"pours a whole file",
		);
	});

	it("warns the parent on a file a subagent was already warned on", () => {
		expect(readAs({ file_path: abs("big.md") }, "a1")).toContain(
			"pours a whole file",
		);
		expect(readAs({ file_path: abs("big.md") })).toContain(
			"pours a whole file",
		);
	});

	it("warns the same agent on a different file", () => {
		expect(readAs({ file_path: abs("big.md") })).toContain(
			"pours a whole file",
		);
		expect(readAs({ file_path: abs("other.md") })).toContain(
			"pours a whole file",
		);
	});

	it("neither warns nor latches on a Read carrying a limit", () => {
		expect(readAs({ file_path: abs("big.md"), limit: 5000 })).toBeNull();
		expect(readAs({ file_path: abs("big.md") })).toContain(
			"pours a whole file",
		);
	});

	it("is silenced by its latch in the shared marker scheme, whoever wrote it", () => {
		// The latch file `latchAfter` writes for `wide-read.<16 hex of sha1(path)>`.
		const file = abs("big.md");
		const hex = crypto
			.createHash("sha1")
			.update(file)
			.digest("hex")
			.slice(0, 16);
		const markers = path.join(repo, ".claude", "tmp", "markers");
		fs.mkdirSync(markers, { recursive: true });
		fs.writeFileSync(
			path.join(markers, `.rule-injected-warn.wide-read.${hex}-main-mine`),
			"",
		);
		expect(readAs({ file_path: file })).toBeNull();
		expect(readAs({ file_path: abs("other.md") })).toContain(
			"pours a whole file",
		);
	});
});

describe("the default Read threshold", () => {
	// mantahostels#2595 set it at half the Bash limb's. That halving is the
	// guarantee, so it is pinned here.
	const defaultReadBytes = 10_000;

	beforeEach(() => {
		fs.writeFileSync(
			path.join(repo, "r-under.md"),
			"x".repeat(defaultReadBytes - 1),
		);
		fs.writeFileSync(
			path.join(repo, "r-over.md"),
			"x".repeat(defaultReadBytes + 1),
		);
	});

	const runShipped = (name: string) =>
		runRead(
			{ file_path: path.join(repo, name) },
			{ WFC_WIDE_READ_TOOL_BYTES: undefined },
		);

	it("stays silent one character under it", () => {
		expect(runShipped("r-under.md")).toEqual(silent);
	});

	it("warns one character over it, quoting the byte count", () => {
		const { warning } = runShipped("r-over.md");
		expect(warning).toContain(String(defaultReadBytes + 1));
	});
});

describe("the cases a mutant must not survive (#2791)", () => {
	const write = (name: string, bytes: number) =>
		fs.writeFileSync(path.join(repo, name), "x".repeat(bytes));

	it("warns at each shipped threshold exactly, not only one past it", () => {
		write("at.md", 20_000);
		expect(
			run("cat at.md", { WFC_WIDE_READ_BYTES: undefined }).warning,
		).toContain("at.md is 20000 characters");
		expect(
			run("sed -n '1,200p' small.md", { WFC_WIDE_READ_LINES: undefined })
				.warning,
		).toContain("prints 200 lines");
		for (const n of [1, 2, 3, 4, 5]) write(`m-${n}.txt`, 1);
		expect(
			run("cat m-*.txt", { WFC_WIDE_READ_MATCHES: undefined }).warning,
		).toContain("matches at least 5 files");
		write("r-at.md", 10_000);
		expect(
			runRead(
				{ file_path: path.join(repo, "r-at.md") },
				{ WFC_WIDE_READ_TOOL_BYTES: undefined },
			).warning,
		).toContain("returns 10000 characters");
	});

	it("warns at an overridden threshold exactly", () => {
		write("at.md", WIDE_BYTES);
		expect(run("cat at.md").warning).toContain(`is ${WIDE_BYTES} characters`);
		write("r-at.md", WIDE_READ_BYTES);
		expect(
			runRead({ file_path: path.join(repo, "r-at.md") }).warning,
		).toContain(`returns ${WIDE_READ_BYTES} characters`);
	});

	it("keeps the shipped default where an override is not digits", () => {
		expect(run("cat small.md", { WFC_WIDE_READ_BYTES: "abc" })).toEqual(silent);
	});

	it("judges awk's glob and a path-spelled cat", () => {
		expect(run("awk 1 part-*.txt").warning).toContain(
			`matches at least ${WIDE_MATCHES} files`,
		);
		expect(run("/bin/cat big.md").warning).toContain(
			"Reading a whole file into context",
		);
	});

	it("drops a command word it cannot fully read, whatever its last component", () => {
		expect(run("/opt$X/cat big.md")).toEqual(silent);
	});

	it("reads every dash-led word to cat as a flag, never a file", () => {
		write("-big", WIDE_BYTES + 1);
		expect(run("cat -- -big")).toEqual(silent);
	});

	it("names the count where cat reads two files", () => {
		expect(run("cat big.md small.md").warning).toContain(
			"big.md and 2 files in all is",
		);
	});

	it.each([
		["-En", "a quiet flag among others"],
		["--quiet", "the long spelling"],
	])("reads sed %s as quiet — %s", (flag) => {
		expect(run(`sed ${flag} '1,${WIDE_LINES}p' big.md`).warning).toContain(
			`prints ${WIDE_LINES} lines`,
		);
	});

	it.each([
		["cat part-[1-4].txt", "a bracket"],
		["cat part-[!9].txt", "a negated bracket"],
		['cat "part-1.txt part-*.txt"', "blanks split as an unquoted expansion"],
	])("counts the glob %s — %s", (command) => {
		expect(run(command).warning).toContain(
			`matches at least ${WIDE_MATCHES} files`,
		);
	});

	it("matches one character with `?`, and a hidden file only by a dot-led pattern", () => {
		for (const name of ["q-1.txt", "q-22.txt", "q-333.txt", "q-4444.txt"])
			write(name, 1);
		expect(run("cat q-?.txt")).toEqual(silent);
		for (const n of [1, 2, 3]) write(`.h-${n}.txt`, 1);
		expect(run("cat *h-*.txt")).toEqual(silent);
		expect(run("cat .h-*.txt").warning).toContain(
			`matches at least ${WIDE_MATCHES} files`,
		);
	});

	it("measures no directory, silently", () => {
		fs.mkdirSync(path.join(repo, "sub"));
		expect(runRead({ file_path: path.join(repo, "sub") })).toEqual(silent);
		expect(logs).toEqual([]);
	});

	it.skipIf(process.getuid?.() === 0)("measures no file it cannot read", () => {
		write("locked.md", WIDE_BYTES + 1);
		fs.chmodSync(path.join(repo, "locked.md"), 0o000);
		expect(run("cat locked.md")).toEqual(silent);
	});

	it("reads a `limit` of false as no limit, as jq's `//` does", () => {
		expect(
			runRead({ file_path: path.join(repo, "big.md"), limit: false }).warning,
		).toContain("pours a whole file");
	});

	it("logs a Read it could not measure, and allows it", () => {
		const said: string[] = [];
		const d = decide(
			path.join(repo, "big.md"),
			kitContextFake({
				tool: "Read",
				input: { file_path: path.join(repo, "big.md") },
				fallbackCwd: repo,
				env: envWith({}),
				log: (what: string) => said.push(what),
				fileBytes: () => 5000,
				windowBytes: () => null,
				glob: () => [],
			}),
		);
		expect(d).toBeNull();
		expect(said.join("\n")).toContain("could not measure");
	});
});
