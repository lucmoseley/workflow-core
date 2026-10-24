// @vitest-environment node
/*
 * mantahostels#1562's guard: given one opaque shell string, is this command about to pour a
 * whole file, a wide slice or an uncounted glob into the context window? And
 * since mantahostels#2595, the same question of a `Read` tool call, which a Bash-only hook
 * never saw.
 *
 * The fire cases prove it names the shape and the cheaper form; the pass cases
 * prove it stays silent on a bounded read.
 *
 * Every case asserts exit 0 and an absent `permissionDecision`: this guard warns
 * and must never deny, whatever it matched.
 *
 * The real guard is spawned over small files in a temp repo, with its
 * thresholds passed in as WFC_WIDE_READ_* so fixtures stay tiny; one block binds
 * the shipped default instead.
 *
 * It is a `PreToolUse` hook on Bash and `Read` in self-plugin/hooks/hooks.json:
 * loosen a fire case and whole files pour into a session's context unwarned,
 * the largest share of a long session's spend (mantahostels#1553); loosen a
 * pass case and bounded reads draw noise.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GUARD = path.resolve(__dirname, "guard-wide-read.sh");

/** Thresholds the fixtures are sized against, passed to the guard as its own. */
const WIDE_BYTES = 1000;
const WIDE_LINES = 20;
const WIDE_MATCHES = 3;
/** The Read limb's threshold, overridden the same way. */
const WIDE_READ_BYTES = 1000;

let dir: string;
let repo: string;
let config: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wide-read-"));
	repo = path.join(dir, "repo");
	config = path.join(dir, "config");
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(config, { recursive: true });
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

/**
 * Runs the guard on `command`, as Claude Code would. `env` is spread last, so a
 * case can override a threshold — or pass `undefined` to remove the key from the
 * child entirely (Node drops an undefined env value), which is what lets a case
 * bind the SHIPPED default without a founder's own export reaching it.
 */
function run(
	command: string,
	env: Record<string, string | undefined> = {},
): Verdict {
	return call({ tool_name: "Bash", tool_input: { command } }, env);
}

/** The same, for a `Read` payload: the file, and optionally offset and limit. */
function runRead(
	toolInput: Record<string, unknown>,
	env: Record<string, string | undefined> = {},
): Verdict {
	return call({ tool_name: "Read", tool_input: toolInput }, env);
}

function call(
	payload: Record<string, unknown>,
	env: Record<string, string | undefined>,
): Verdict {
	const r = spawnSync(GUARD, [], {
		cwd: repo,
		encoding: "utf8",
		input: JSON.stringify({ session_id: "mine", ...payload }),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			// Unset, the guard's fail-open records would append to the founder's own
			// log and manufacture the faults check-guard-errors.js exists to report.
			CLAUDE_CONFIG_DIR: config,
			WFC_WIDE_READ_BYTES: String(WIDE_BYTES),
			WFC_WIDE_READ_LINES: String(WIDE_LINES),
			WFC_WIDE_READ_MATCHES: String(WIDE_MATCHES),
			WFC_WIDE_READ_TOOL_BYTES: String(WIDE_READ_BYTES),
			...env,
		},
	});
	expect(r.status).toBe(0);
	if (!r.stdout.trim()) return { warning: null, denied: false };
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	return {
		warning: out.additionalContext ?? null,
		denied: out.permissionDecision === "deny",
	};
}

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
		expect(run(command)).toEqual({ warning: null, denied: false });
	});
});

describe("fail-open", () => {
	it("allows and records when the shared parser cannot be loaded", () => {
		// The one recorded fail-open: no lib/, so gp_begin never defines and the
		// guard stands down rather than judging on a parser it does not have.
		const bare = path.join(dir, "bare");
		fs.mkdirSync(bare);
		fs.copyFileSync(GUARD, path.join(bare, "guard-wide-read.sh"));
		const r = spawnSync(path.join(bare, "guard-wide-read.sh"), [], {
			cwd: repo,
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "mine",
				tool_name: "Bash",
				tool_input: { command: "cat big.md" },
			}),
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: repo,
				CLAUDE_CONFIG_DIR: config,
			},
		});
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe("");
	});
});

describe("the default byte threshold", () => {
	// Every other case overrides WFC_WIDE_READ_BYTES, so nothing else here can
	// see the shipped default move (mantahostels#2571).
	const defaultWideBytes = 20_000;

	/** Runs the guard with no byte override, so the shipped default binds. */
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
		expect(runShipped("cat under.md")).toEqual({
			warning: null,
			denied: false,
		});
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
		// whole file clears TAIL_ONLY_BYTES; the window `Read` returns does not.
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
		expect(runRead({ file_path: abs("long.md"), limit: 20 })).toEqual({
			warning: null,
			denied: false,
		});
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
		expect(runRead({ file_path: abs("tail-only.md") }, env)).toEqual({
			warning: null,
			denied: false,
		});
		// The same file read from the far side of the cap does warn, which proves
		// the silence above is the window and not an unreadable fixture.
		const { warning } = runRead(
			{ file_path: abs("tail-only.md"), offset: 2001 },
			env,
		);
		expect(warning).toContain("pours a whole file into context");
	});

	it.each([
		["stays silent on a small file", { file_path: "small.md" }],
		["stays silent on a file that does not exist", { file_path: "absent.md" }],
		["stays silent on a directory", { file_path: "." }],
	])("%s", (_what, input) => {
		const filePath = path.join(repo, String(input.file_path));
		expect(runRead({ ...input, file_path: filePath })).toEqual({
			warning: null,
			denied: false,
		});
	});

	it("skips a rendered file, whose bytes are not what the session pays for", () => {
		fs.writeFileSync(
			path.join(repo, "shot.png"),
			"x".repeat(WIDE_READ_BYTES + 1),
		);
		expect(runRead({ file_path: abs("shot.png") })).toEqual({
			warning: null,
			denied: false,
		});
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
		// A leading zero is octal to bash, and a huge one wraps `last` below `first` into a
		// range sed rejects. Both must read as "no offset" and judge from line 1.
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
		expect(runRead({ file_path: abs("SHOT.PNG") })).toEqual({
			warning: null,
			denied: false,
		});
	});

	it("measures a path beginning with a dash rather than reading it as flags", () => {
		// PreToolUse fires before the Read tool rejects such a path, so sed sees
		// it. Without a `--` it parses as options and the measurement is lost.
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
		call(
			{
				tool_name: "Read",
				tool_input: toolInput,
				...(agent ? { agent_id: agent } : {}),
			},
			{},
		).warning;

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
		expect(runShipped("r-under.md")).toEqual({ warning: null, denied: false });
	});

	it("warns one character over it, quoting the byte count", () => {
		const { warning } = runShipped("r-over.md");
		expect(warning).toContain(String(defaultReadBytes + 1));
	});
});
