// @vitest-environment node
/**
 * Pins lib/rescue-jobs.js's account of where a dead session got to — its
 * transcript, its jobs and its landed commits — which the `rescue-sessions`
 * skill hands to the session that takes its work over on another Claude plan
 * (mantahostels#2605). The list and snapshot cores run in-process on
 * lib/rescue-ports-fake.ts's ports (#5157), whose oracle lists no seat here,
 * so liveness reads as unreadable; rescue-sessions.test.ts keeps the
 * program's own cases.
 *
 * Over temp config dirs in the daemon's own layout: the transcript reducers
 * are read back from what `snapshot` writes, the job reads from what `list`
 * prints, and the landed commits over a throwaway git repo. Loosen a case and
 * the successor session the skill briefs reads a wrong account of where a
 * dead session got to — a neighbour's commit taken for its own, or its last
 * prose lost under tool output.
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRescuePorts } from "./rescue-ports-fake";
import {
	MODEL_LIMIT_LINE,
	SESSION_LIMIT_LINE,
	WEEKLY_LIMIT_LINE,
} from "./rescue-testkit";
import { buildBashCall } from "./transcript-testkit";

type Core = (
	args: object,
	ports: object,
) => Promise<{ status: number; stdout: string; stderr: string }>;
const { list, snapshot } = require("./rescue-jobs.js") as {
	list: Core;
	snapshot: Core;
};

/** The ports, no seat listed: liveness reads as unreadable. */
const ports = () => createRescuePorts(join(tmpdir(), "no-proc")).ports;

/** Every temp dir a test made. */
const made: string[] = [];

afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** One transcript line, in the shape the daemon writes. */
function line(obj: unknown): string {
	return JSON.stringify(obj);
}

function assistant(content: unknown[]) {
	return { type: "assistant", message: { content } };
}

const said = (text: string) => line(assistant([{ type: "text", text }]));
const called = (name: string, input: Record<string, unknown>) =>
	line(assistant([{ type: "tool_use", name, input }]));
const bash = (command: string) => line(buildBashCall(command));

/** A config dir holding the jobs described, in the daemon's own layout. */
function configDirOf(jobs: Record<string, unknown>): string {
	const dir = tempDir("rescue-cfg-");
	mkdirSync(join(dir, "jobs"), { recursive: true });
	for (const [short, state] of Object.entries(jobs)) {
		mkdirSync(join(dir, "jobs", short), { recursive: true });
		writeFileSync(
			join(dir, "jobs", short, "state.json"),
			typeof state === "string" ? state : JSON.stringify(state),
		);
	}
	return dir;
}

interface Snapshot {
	short: string;
	model: string;
	deathPoint: string;
	artefactsSurvived: string[];
	commitsAttempted: string[];
	commitsLanded: string[] | null;
}

/**
 * `snapshot` over one job whose transcript is `lines`: the narration file it
 * wrote, the job's index entry, and what it printed.
 */
async function snapshotOf(
	lines: string[],
	state: Record<string, unknown> = {},
) {
	const work = tempDir("rescue-test-");
	const transcript = join(work, "t.jsonl");
	writeFileSync(transcript, `${lines.join("\n")}\n`);
	const cfg = configDirOf({
		aaaa1111: { state: "blocked", linkScanPath: transcript, ...state },
	});
	const out = join(work, "out");
	const res = await snapshot(
		{ _: ["snapshot"], from: cfg, out, ids: "aaaa1111" },
		ports(),
	);
	expect(res.status, res.stderr).toBe(0);
	const [entry] = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
	return {
		res,
		narration: readFileSync(join(out, "aaaa1111.narration.txt"), "utf8"),
		entry: entry as Snapshot,
	};
}

describe("the narration snapshot writes", () => {
	it("keeps assistant prose and drops the tool results that dwarf it", async () => {
		const { narration } = await snapshotOf([
			said("Claiming and editing."),
			line({
				type: "user",
				message: {
					content: [{ type: "tool_result", content: "x".repeat(50_000) }],
				},
			}),
		]);
		expect(narration).toBe("A: Claiming and editing.");
	});

	it("signs a Bash call with its command, flattened to one line", async () => {
		expect(
			(await snapshotOf([bash("npm run test\n--changed")])).narration,
		).toBe("  [Bash] npm run test --changed");
	});

	it("signs a file-touching call with its path, not its content", async () => {
		const { narration } = await snapshotOf([
			called("Write", {
				file_path: "scripts/x.js",
				content: "secret".repeat(999),
			}),
		]);
		expect(narration).toBe("  [Write] scripts/x.js");
	});

	it("keeps a real user turn but drops an injected system-reminder", async () => {
		const { narration } = await snapshotOf([
			line({ type: "user", message: { content: "Accept recommendation" } }),
			line({
				type: "user",
				message: { content: "<system-reminder>noise</system-reminder>" },
			}),
		]);
		expect(narration).toBe("USER: Accept recommendation");
	});

	it("preserves the order prose and calls actually happened in", async () => {
		const { narration } = await snapshotOf([
			line(
				assistant([
					{ type: "text", text: "First." },
					{ type: "tool_use", name: "Bash", input: { command: "a" } },
				]),
			),
			said("Second."),
		]);
		expect(narration.split("\n")).toEqual([
			"A: First.",
			"  [Bash] a",
			"A: Second.",
		]);
	});

	it("skips a malformed line rather than throwing", async () => {
		expect((await snapshotOf(["{not json", said("Survived.")])).narration).toBe(
			"A: Survived.",
		);
	});
});

describe("where snapshot says a session died", () => {
	it("drops the rate-limit spam that ends every stuck session, a model limit's included (#2380)", async () => {
		const { entry, res } = await snapshotOf([
			said("Now the guard tests."),
			said(SESSION_LIMIT_LINE),
			said(WEEKLY_LIMIT_LINE),
			said(MODEL_LIMIT_LINE),
		]);
		expect(entry.deathPoint).toBe("A: Now the guard tests.");
		expect(res.stdout).toContain("═══ aaaa1111");
	});

	it("ignores tool-call signatures", async () => {
		const { entry } = await snapshotOf([
			said("Committing."),
			bash("git commit -m x"),
		]);
		expect(entry.deathPoint).toBe("A: Committing.");
	});
});

/** `list` over the jobs described. */
async function listOf(jobs: Record<string, unknown>, extra = {}) {
	const cfg = configDirOf(jobs);
	const res = await list({ _: ["list"], from: cfg, ...extra }, ports());
	expect(res.status, res.stderr).toBe(0);
	return res.stdout;
}

const modelListed = async (respawnFlags: string[]) =>
	/model (\S+)/.exec(
		await listOf({ aaaaaaaa: { state: "blocked", respawnFlags } }),
	)?.[1];

describe("the model list reads off respawnFlags", () => {
	it("reads the model by flag name, not by position", async () => {
		expect(await modelListed(["--model", "opus[1m]", "--name", "x"])).toBe(
			"opus[1m]",
		);
	});

	it("does not mistake the advisor for the model — the shape dispatch-sessions.js launches", async () => {
		expect(await modelListed(["--advisor", "opus", "--model", "sonnet"])).toBe(
			"sonnet",
		);
	});

	it("answers unknown rather than guessing when no --model is present", async () => {
		expect(await modelListed(["--name", "claude"])).toBe("?");
		expect(await modelListed(["--model"])).toBe("?");
	});
});

describe("the jobs list reads", () => {
	it("counts an unparseable state file rather than swallowing it", async () => {
		const out = await listOf({
			aaaaaaaa: { state: "blocked", updatedAt: "2026-09-02T10:00:00Z" },
			bbbbbbbb: "{not json",
		});
		expect(out).toContain("1 job(s) in");
		expect(out).toContain("1 state file(s) would not parse");
	});

	it("skips a job directory holding no state file, as a leftover tmp/ is not a job (#1146)", async () => {
		const cfg = configDirOf({
			aaaaaaaa: { state: "blocked", updatedAt: "2026-09-02T10:00:00Z" },
		});
		mkdirSync(join(cfg, "jobs", "cccccccc", "tmp"), { recursive: true });
		const res = await list({ _: ["list"], from: cfg }, ports());
		expect(res.stdout).toContain("1 job(s) in");
		expect(res.stdout).not.toContain("would not parse");
	});

	it("sorts newest first", async () => {
		const out = await listOf({
			older: { state: "blocked", updatedAt: "2026-09-01T00:00:00Z" },
			newer: { state: "blocked", updatedAt: "2026-09-02T00:00:00Z" },
		});
		expect(out.indexOf("newer")).toBeLessThan(out.indexOf("older"));
	});
});

describe("the artefacts snapshot says survived", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir("rescue-artefacts-");
	});

	it("keeps only the paths that still exist, resolved against the job's cwd", async () => {
		writeFileSync(join(dir, "kept.txt"), "x");
		const { entry, res } = await snapshotOf(
			[
				said("Writing."),
				called("Write", { file_path: "kept.txt" }),
				called("Edit", { file_path: "gone.txt" }),
			],
			{ cwd: dir },
		);
		expect(entry.artefactsSurvived).toEqual(["kept.txt"]);
		expect(res.stdout).toContain("artefacts survived: kept.txt");
	});

	it("resolves an absolute path directly, ignoring cwd", async () => {
		const abs = join(dir, "kept.txt");
		writeFileSync(abs, "x");
		const { entry } = await snapshotOf([called("Write", { file_path: abs })], {
			cwd: "/nonexistent",
		});
		expect(entry.artefactsSurvived).toEqual([abs]);
	});

	it("ignores every tool call that is not a Write or an Edit", async () => {
		writeFileSync(join(dir, "kept.txt"), "x");
		const { entry } = await snapshotOf(
			[called("Read", { file_path: "kept.txt" }), bash("git status")],
			{ cwd: dir },
		);
		expect(entry.artefactsSurvived).toEqual([]);
	});

	// mantahostels#2628: package.json genuinely exists at the repo root, the cwd
	// runInProcess gives the script here — the case that would otherwise pass
	// by accident.
	it("never resolves a relative path against its own process cwd when the job has none", async () => {
		const { entry } = await snapshotOf([
			called("Write", { file_path: "package.json" }),
		]);
		expect(entry.artefactsSurvived).toEqual([]);
	});
});

describe("the commits snapshot says were attempted and landed", () => {
	let repo: string;
	beforeEach(() => {
		repo = tempDir("rescue-git-");
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "a@example.com"], {
			cwd: repo,
		});
		execFileSync("git", ["config", "user.name", "a"], { cwd: repo });
	});

	const commit = (msg: string) =>
		execFileSync("git", ["commit", "--allow-empty", "-m", msg], { cwd: repo });

	/** snapshot over a session that ran `calls`, dying now in `cwd`. */
	const landed = (calls: string[], cwd = repo) =>
		snapshotOf(calls.map(bash), {
			cwd,
			updatedAt: new Date().toISOString(),
		});

	it("lists the session's own git commit calls, ignoring every other line", async () => {
		const { entry } = await snapshotOf([
			said("Committing."),
			bash("git commit -m x -- scripts/y.js"),
			bash("npm run test"),
			said("Done."),
		]);
		expect(entry.commitsAttempted).toEqual(["git commit -m x -- scripts/y.js"]);
	});

	it("lists commit-paths.js calls by repo or plugin-cache path behind a prefix (#1714)", async () => {
		const cached = `node /home/u/.claude2/plugins/cache/workflow-core/workflow-core/1.0.0/scripts/commit-paths.js -m "fix b" -- b.js`;
		const { entry } = await snapshotOf([
			bash('node scripts/commit-paths.js -m "fix a" -- a.js'),
			bash(
				`timeout 900 bash -c 'while [ -e .git/index.lock ]; do sleep 1; done'; ${cached}`,
			),
			bash("cd /repo && git commit -m c -- c.js"),
			bash("cat scripts/commit-paths.js"),
			bash("grep -n 'node scripts/commit-paths.js -m' CLAUDE.md"),
		]);
		expect(entry.commitsAttempted).toEqual([
			'node scripts/commit-paths.js -m "fix a" -- a.js',
			cached,
			"git commit -m c -- c.js",
		]);
	});

	it("does not count a commit-paths.js --tree pin as an attempt (#2383)", async () => {
		const { entry } = await snapshotOf([
			bash("t=$(node scripts/commit-paths.js --tree -- a.js) && git diff $t"),
		]);
		expect(entry.commitsAttempted).toEqual([]);
	});

	it("does not count a commit-paths.js call it would refuse for its message (#2383)", async () => {
		const { entry } = await snapshotOf([
			bash("node scripts/commit-paths.js -m a -m b -- a.js"),
			bash("node scripts/commit-paths.js -- a.js"),
		]);
		expect(entry.commitsAttempted).toEqual([]);
	});

	it("does not count a commit-paths.js --help call as an attempt (#2383)", async () => {
		const { entry } = await snapshotOf([
			bash("node scripts/commit-paths.js --help"),
		]);
		expect(entry.commitsAttempted).toEqual([]);
	});

	it.each([
		[
			"an env assignment",
			'WFC_ALLOW_RETRO_EDIT=1 git commit -m "env subject" -- a.js',
			"env subject",
		],
		[
			"NODE_OPTIONS",
			'NODE_OPTIONS=--max-old-space-size=2048 node scripts/commit-paths.js -m "node opts subject" -- a.js',
			"node opts subject",
		],
		[
			"timeout",
			'timeout 900 node scripts/commit-paths.js -m "timeout subject" -- a.js',
			"timeout subject",
		],
		["git -C", 'git -C . commit -m "dash C subject" -- a.js', "dash C subject"],
		[
			"a shell-quoted plugin path",
			`node '/home/u/my plugins/workflow-core/scripts/commit-paths.js' -m "quoted path subject" -- a.js`,
			"quoted path subject",
		],
	])(
		"counts a commit behind %s, with its message (#2383)",
		async (_, call, subject) => {
			commit(subject);
			const { entry } = await landed([call]);
			expect(entry.commitsAttempted).toEqual([call]);
			expect(entry.commitsLanded).toEqual([
				expect.stringMatching(new RegExp(` ${subject}$`)),
			]);
		},
	);

	it("counts each commit of a command, a message-less one with no subject, and no merge (#2383)", async () => {
		commit("first of two");
		const { entry } = await landed([
			'git commit -m "first of two" -- a.js && git commit -m "second" -- b.js',
			'git commit --amend --no-edit && git merge -m "merge subject" x',
		]);
		expect(entry.commitsAttempted).toEqual([
			'git commit -m "first of two" -- a.js',
			'git commit -m "second" -- b.js',
			"git commit --amend --no-edit",
		]);
		expect(entry.commitsLanded).toEqual([
			expect.stringMatching(/ first of two$/),
		]);
	});

	it("matches a commit-paths.js message longer than the narration keeps (#1714)", async () => {
		const subject = `Make the rescue snapshot see commits made through commit-paths.js, ${"so nothing is missed ".repeat(4).trim()}`;
		commit(subject);
		const { entry } = await landed([
			`node scripts/commit-paths.js -m "${subject}" -- scripts/rescue-sessions.js`,
		]);
		expect(entry.commitsLanded).toEqual([expect.stringContaining(subject)]);
	});

	it("matches the subject of a message given by -F file or heredoc (#1714)", async () => {
		writeFileSync(join(repo, "msg.txt"), "subject from a file\n\nbody\n");
		commit("subject from a file");
		commit("subject from a heredoc");
		const { entry } = await landed([
			"node scripts/commit-paths.js -F msg.txt -- a.js",
			`node scripts/commit-paths.js -m "$(cat <<'EOF'\nsubject from a heredoc\n\nbody\nEOF\n)" -- b.js`,
		]);
		expect(entry.commitsLanded).toHaveLength(2);
	});

	it("matches a message carrying an apostrophe whole (#1714)", async () => {
		commit("the session's own fix");
		commit("the session");
		const { entry } = await landed([
			`node scripts/commit-paths.js -m "the session's own fix" -- a.js`,
		]);
		expect(entry.commitsLanded).toEqual([
			expect.stringContaining("the session's own fix"),
		]);
	});

	it("matches a commit whose quoted -m message it finds in the log", async () => {
		commit("landed the fix");
		const { entry, res } = await landed([
			'git commit -m "landed the fix" -- a.js',
		]);
		expect(entry.commitsLanded).toHaveLength(1);
		expect(entry.commitsLanded?.[0]).toContain("landed the fix");
		expect(res.stdout).toContain("commits landed (matched against");
	});

	it("does not credit a neighbour's Revert of the message, or a longer subject holding it (#2373)", async () => {
		commit('Revert "landed the fix"');
		commit("Follow up on landed the fix");
		commit("landed the fix, and more");
		commit("landed the fix");
		const { entry } = await landed(['git commit -m "landed the fix" -- a.js']);
		expect(entry.commitsLanded).toEqual([
			expect.stringMatching(/^\w+ landed the fix$/),
		]);
	});

	it("reads a message's shell quoting and escapes as bash does (#2373)", async () => {
		commit("the session's fix");
		commit('Read "x" now');
		commit("Use `foo` for $5");
		const { entry } = await landed([
			"git commit -m 'the session'\\''s fix' -- a.js",
			'git commit -m "Read \\"x\\" now" -- a.js',
			'git commit -m "Use \\`foo\\` for \\$5" -- a.js',
		]);
		expect(entry.commitsLanded).toHaveLength(3);
	});

	it("reads a heredoc closed on its terminator's own line, and a <<- heredoc's tabs (#2373)", async () => {
		commit("same line term");
		commit("tabbed subj tabbed two");
		commit("  spaced subj");
		const { entry } = await landed([
			`git commit -m "$(cat <<'EOF'\nsame line term\nEOF)" -- a.js`,
			`git commit -m "$(cat <<-'EOF'\n\ttabbed subj\n\ttabbed two\n\tEOF\n)" -- a.js`,
			`git commit -m "  spaced subj" -- a.js`,
		]);
		expect(entry.commitsLanded).toHaveLength(3);
	});

	it("matches a first paragraph spanning lines as git's one-line subject (#2373)", async () => {
		commit("first line\nsecond line\n\nbody");
		const { entry } = await landed([
			`git commit -m "$(cat <<'EOF'\nfirst line\nsecond line\n\nbody\nEOF\n)" -- a.js`,
		]);
		expect(entry.commitsLanded).toEqual([
			expect.stringMatching(/ first line second line$/),
		]);
	});

	it("matches a message under six characters on its exact subject (#2373)", async () => {
		commit("fix x");
		commit("fix xy");
		const { entry } = await landed(['git commit -m "fix x" -- a.js']);
		expect(entry.commitsLanded).toEqual([expect.stringMatching(/ fix x$/)]);
	});

	it("reads a heredoc message whose terminator line is missing (#2373)", async () => {
		commit("no terminator");
		const { entry } = await landed([
			`git commit -m "$(cat <<'EOF'\nno terminator\n\nbody`,
		]);
		expect(entry.commitsLanded).toHaveLength(1);
	});

	it("matches a bare -m message", async () => {
		commit("fix-the-thing");
		const { entry } = await landed(["git commit -m fix-the-thing -- a.js"]);
		expect(entry.commitsLanded?.[0]).toContain("fix-the-thing");
	});

	it("matches nothing for an attempt with no -m to read", async () => {
		commit("whatever it was");
		expect((await landed(["git commit --amend"])).entry.commitsLanded).toEqual(
			[],
		);
	});

	// mantahostels#2628: a bare time window would attribute ANY commit in the window to
	// this job, including a concurrent neighbour's.
	it("does not attribute a neighbour's commit this job never attempted", async () => {
		commit("a neighbour's unrelated commit");
		const { entry } = await landed(['git commit -m "landed the fix" -- a.js']);
		expect(entry.commitsLanded).toEqual([]);
	});

	it("answers empty, not unreadable, where nothing was attempted to match", async () => {
		commit("whatever");
		const { entry, res } = await landed(["npm run lint"]);
		expect(entry.commitsLanded).toEqual([]);
		expect(res.stdout).not.toContain("commits landed");
	});

	it("says unreadable rather than throwing where the job's dir is gone", async () => {
		const { entry, res } = await landed(
			['git commit -m "landed the fix" -- a.js'],
			join(repo, "gone"),
		);
		expect(entry.commitsLanded).toBeNull();
		expect(res.stdout).toContain("commits landed: unreadable");
	});
});
