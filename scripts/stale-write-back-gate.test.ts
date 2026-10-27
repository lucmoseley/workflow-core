// @vitest-environment node
/*
 * The pre-commit stale-write-back gate (#113), driven through real `git commit`s
 * in a throwaway repo whose hooks are the live `.husky/pre-commit` line; for
 * `--no-verify`, the live `.husky/prepare-commit-msg`; and for #114's base
 * advance, the live `.husky/post-commit`'s block.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a session's
 * commit silently writes back over a neighbour's committed edit, or the gate
 * refuses a session's honest commit of its own work.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AS_ROOT,
	core,
	freshSandbox,
	live,
	SCRIPT,
	store,
} from "./lib/arbiter-testkit";
import {
	coreCall,
	cutInReplay,
	cutShellFunction,
	HOOK,
	POST_COMMIT,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { readRuleText } from "./lib/rule-text";
import { runInProcess } from "./lib/run-in-process";

const sb = freshSandbox();

const WIRING = `${coreCall("bash", "scripts/stale-write-back-gate.sh")} || exit 1`;

const DOC = "docs/doc-map.md";
const OTHER = "scripts/evidence-audit.py";

type Env = Record<string, string>;

/** git in the fixture, as a neighbour runs it: no session id, no hooks. */
const git = (...args: string[]) => {
	const r = spawnSync("git", args, {
		cwd: sb.repo,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: "" },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(sb.repo, rel), text);
};
const neighbourCommits = (rel: string, text: string) => {
	write(rel, text);
	git("commit", "-qm", `neighbour edits ${rel}`, "--", rel);
};

/** post-commit's capture of the commit's sha, which runs ahead of every block. */
const CAPTURE = POST_COMMIT.split("\n").findIndex((l) =>
	l.startsWith("committed=$("),
);

interface Hooks {
	prepareCommitMsg?: boolean;
	postCommit?: boolean;
}

/**
 * The hooks directory: pre-commit is the live hook's gate line, and
 * `prepareCommitMsg` adds the live hook of that name. `postCommit` adds the
 * live post-commit's sha capture, claim release and base advance (#114), cut
 * from it.
 */
function hooks({ prepareCommitMsg = false, postCommit = false }: Hooks = {}) {
	const dir = path.join(
		sb.dir,
		`hooks${prepareCommitMsg ? "-pcm" : ""}${postCommit ? "-pc" : ""}`,
	);
	fs.mkdirSync(dir, { recursive: true });
	if (postCommit) {
		if (CAPTURE === -1)
			throw new Error(".husky/post-commit no longer captures the sha");
		const body = [
			POST_COMMIT.split("\n")[CAPTURE],
			cutInReplay(),
			// Ahead of the advance, as in the live hook: its loop once reused
			// `committed` and emptied the sha the advance reads (#115).
			cutShellFunction("release_committed_claims"),
			"release_committed_claims",
			cutShellFunction("advance_committed_bases"),
			"advance_committed_bases",
		].join("\n");
		fs.writeFileSync(path.join(dir, "post-commit"), `#!/bin/sh -e\n${body}\n`, {
			mode: 0o755,
		});
	}
	const line = HOOK.split("\n").find((l) => l === WIRING);
	if (!line) throw new Error(".husky/pre-commit no longer runs the gate");
	fs.writeFileSync(path.join(dir, "pre-commit"), `#!/bin/sh\n${line}\n`, {
		mode: 0o755,
	});
	if (prepareCommitMsg)
		fs.writeFileSync(
			path.join(dir, "prepare-commit-msg"),
			fs.readFileSync(path.join(ROOT, ".husky", "prepare-commit-msg")),
			{ mode: 0o755 },
		);
	return dir;
}

/** A commit by the session `alice` (or `env`'s), through the gate. */
function commit(
	args: string[],
	opts: Hooks & { env?: Env; cwd?: string } = {},
) {
	const cwd = opts.cwd ?? sb.repo;
	const readHead = () => git("-C", cwd, "rev-parse", "HEAD");
	const before = readHead();
	const r = spawnSync(
		"git",
		["-c", `core.hooksPath=${hooks(opts)}`, "commit", "-q", ...args],
		{
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_CODE_SESSION_ID: "alice",
				// The hooks reach the scripts through this, as an adopter's shim
				// hands them the core's root (#1839).
				WFC_PLUGIN_ROOT: ROOT,
				...opts.env,
			},
		},
	);
	return {
		status: r.status,
		stderr: r.stderr,
		landed: readHead() !== before,
		gateLines: r.stderr
			.split("\n")
			.filter((l) => /stale-write-back|stale write-back/.test(l)),
	};
}

/** SessionStart, recording HEAD as the session's fallback base. */
const start = (sessionId: string) =>
	runInProcess(SCRIPT, ["prune-markers", "--detach"], {
		cwd: sb.repo,
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: "" },
		stdin: JSON.stringify({ session_id: sessionId, source: "startup" }),
	});

/** alice's base on DOC, then a neighbour's commit on it. */
const staleSetup = () => {
	start("alice");
	store.acquire(DOC, live(sb, "alice"));
	neighbourCommits(DOC, "seeded\nneighbour's line\n");
};

beforeEach(() => {
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	write(DOC, "seeded\n");
	write(OTHER, "seeded\n");
	git("add", "--", DOC, OTHER);
	git("commit", "-qm", "seed");
});

describe("the stale-write-back gate in the commit stack (#113)", () => {
	it("is wired into .husky/pre-commit", () => {
		expect(HOOK.split("\n")).toContain(WIRING);
	});

	it("refuses a stale write-back on a pathspec commit, naming the path, the commit, both ways forward and the rule (#115)", () => {
		staleSetup();
		write(DOC, "seeded\n");
		const r = commit(["-m", "alice", "--", DOC]);
		expect(r.landed).toBe(false);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
		expect(r.stderr).toContain(
			`${git("rev-parse", "--short", "HEAD")} neighbour edits ${DOC}`,
		);
		expect(r.stderr).toContain("re-derive the file from HEAD");
		expect(r.stderr).toContain(`accept-head ${DOC}`);
		expect(r.stderr).toContain("rule:stale-write-back");
		expect(r.stderr).toContain(readRuleText("stale-write-back"));
	});

	it("refuses the whole commit where one path of several is stale, naming only the stale path", () => {
		staleSetup();
		write(DOC, "seeded\n");
		write(OTHER, "alice's own work\n");
		const r = commit(["-m", "alice", "--", DOC, OTHER]);
		expect(r.landed).toBe(false);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
		expect(r.stderr).not.toContain(`refusing ${OTHER}`);
	});

	it("passes an ordinary commit carrying the neighbour's change", () => {
		staleSetup();
		write(DOC, "seeded\nneighbour's line\nalice's line\n");
		const r = commit(["-m", "alice", "--", DOC]);
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes an ordinary commit where HEAD has not moved", () => {
		start("alice");
		write(DOC, "alice's rewrite\n");
		const r = commit(["-m", "alice", "--", DOC]);
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("refuses mantahostels#2557's private-index commit, naming the path a neighbour edits: read-tree HEAD, a neighbour commit, then the commit", () => {
		start("alice");
		const index = path.join(sb.dir, "private-index");
		const priv = { GIT_INDEX_FILE: index };
		const inPrivate = (...args: string[]) =>
			spawnSync("git", args, {
				cwd: sb.repo,
				env: { ...process.env, ...priv },
			});
		expect(inPrivate("read-tree", "HEAD").status).toBe(0);
		neighbourCommits(DOC, "seeded\nneighbour's line\n");
		write(OTHER, "alice's own work\n");
		expect(inPrivate("add", "--", OTHER).status).toBe(0);

		const r = commit(["-m", "alice"], { env: priv });
		expect(r.landed).toBe(false);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
		expect(r.stderr).toContain(`neighbour edits ${DOC}`);
	});

	it("passes a private-index commit taken after the neighbour's", () => {
		start("alice");
		neighbourCommits(DOC, "seeded\nneighbour's line\n");
		const priv = { GIT_INDEX_FILE: path.join(sb.dir, "private-index") };
		const inPrivate = (...args: string[]) =>
			spawnSync("git", args, {
				cwd: sb.repo,
				env: { ...process.env, ...priv },
			});
		expect(inPrivate("read-tree", "HEAD").status).toBe(0);
		write(DOC, "seeded\nneighbour's line\nalice's line\n");
		expect(inPrivate("add", "--", DOC).status).toBe(0);

		const r = commit(["-m", "alice"], { env: priv });
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("refuses a plain `git add` then `git commit`, whose hook gets a relative index, naming the stale path", () => {
		staleSetup();
		write(DOC, "seeded\n");
		git("add", "--", DOC);
		const r = commit(["-m", "alice"]);
		expect(r.landed).toBe(false);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
	});

	it("refuses through a private index named relatively, naming the stale path", () => {
		start("alice");
		const priv = { GIT_INDEX_FILE: ".git/private-index" };
		const inPrivate = (...args: string[]) =>
			spawnSync("git", args, {
				cwd: sb.repo,
				env: { ...process.env, ...priv },
			});
		expect(inPrivate("read-tree", "HEAD").status).toBe(0);
		neighbourCommits(DOC, "seeded\nneighbour's line\n");
		write(OTHER, "alice's own work\n");
		expect(inPrivate("add", "--", OTHER).status).toBe(0);

		const r = commit(["-m", "alice"], { env: priv });
		expect(r.landed).toBe(false);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
	});

	it("finds the one stale path in a wide commit", () => {
		const many = Array.from({ length: 60 }, (_, i) => `scripts/gen-${i}.py`);
		for (const rel of many) write(rel, "seeded\n");
		git("add", "--", ...many);
		git("commit", "-qm", "seed many");
		staleSetup();
		for (const rel of many) write(rel, "regenerated\n");
		write(DOC, "seeded\n");
		const r = commit(["-m", "alice", "--", DOC, ...many]);
		expect(r.landed).toBe(false);
		expect(r.status).toBe(1);
		expect(r.stderr.match(/refusing /g)).toHaveLength(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
	});

	it("leaves a commit in another repo alone", () => {
		staleSetup();
		const other = path.join(sb.dir, "other");
		fs.mkdirSync(other);
		const inOther = (...args: string[]) => git("-C", other, ...args);
		inOther("init", "-q", "-b", "main");
		inOther("config", "user.email", "t@t");
		inOther("config", "user.name", "t");
		// DOC at alice's base, which judged against this repo's HEAD would refuse.
		fs.mkdirSync(path.join(other, "docs"));
		fs.writeFileSync(path.join(other, DOC), "seeded\n");
		fs.writeFileSync(path.join(other, "x.md"), "one\n");
		inOther("add", "--", "x.md", DOC);
		inOther("commit", "-qm", "seed");
		fs.writeFileSync(path.join(other, "x.md"), "two\n");

		const r = commit(["-m", "alice", "--", "x.md"], { cwd: other });
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("runs under --no-verify, through prepare-commit-msg", () => {
		staleSetup();
		write(DOC, "seeded\n");
		const r = commit(["--no-verify", "-m", "alice", "--", DOC], {
			prepareCommitMsg: true,
		});
		expect(r.landed).toBe(false);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
	});

	it("never judges a deletion", () => {
		staleSetup();
		git("rm", "-q", "--cached", DOC);
		const r = commit(["-m", "alice"]);
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("never judges an addition — the base's version restored after a neighbour deleted it", () => {
		staleSetup();
		git("rm", "-q", DOC);
		git("commit", "-qm", `neighbour deletes ${DOC}`);
		write(DOC, "seeded\n");
		git("add", "--", DOC);
		const r = commit(["-m", "alice"]);
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("skips a commit in a linked worktree, whose HEAD the bases were not taken against", () => {
		staleSetup();
		const wt = path.join(sb.dir, "wt");
		git("worktree", "add", "-q", "-b", "wt", wt);
		fs.writeFileSync(path.join(wt, DOC), "seeded\n");
		const r = commit(["-m", "alice", "--", DOC], { cwd: wt });
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes silently with no session id", () => {
		staleSetup();
		write(DOC, "seeded\n");
		const r = commit(["-m", "founder", "--", DOC], {
			env: { CLAUDE_CODE_SESSION_ID: "" },
		});
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});
});

describe("post-commit's base advance, seen through the gate (#114)", () => {
	const readBaseOf = (rel: string, sessionId = "alice") => {
		const file = store.paths.base(rel, sessionId);
		return fs.existsSync(file)
			? JSON.parse(fs.readFileSync(file, "utf8"))
			: null;
	};
	const withAdvance = { postCommit: true };
	/** alice commits DOC grown by three lines, then trims two of them back off. */
	const commitThenTrim = (opts: { postCommit?: boolean }) => {
		start("alice");
		store.acquire(DOC, live(sb, "alice"));
		write(DOC, "seeded\none\ntwo\nthree\n");
		expect(commit(["-m", "alice grows", "--", DOC], opts).landed).toBe(true);
		write(DOC, "seeded\none\n");
		return commit(["-m", "alice trims", "--", DOC], opts);
	};

	it("is wired into .husky/post-commit", () => {
		const liveLines = POST_COMMIT.split("\n").filter(
			(l) => !l.trimStart().startsWith("#"),
		);
		expect(liveLines.join("\n")).toContain("advance-bases");
		expect(liveLines).toContain("advance_committed_bases");
	});

	it("reads the commit's sha before any block runs, so a neighbour's later commit is never recorded", () => {
		const lines = POST_COMMIT.split("\n");
		const firstBlock = lines.indexOf("report_unpushed");
		expect(CAPTURE).toBeGreaterThan(-1);
		expect(firstBlock).toBeGreaterThan(CAPTURE);
		expect(cutShellFunction("advance_committed_bases")).not.toContain(
			"rev-parse --verify -q HEAD",
		);
	});

	it("passes a session's trim of its own committed text", () => {
		const r = commitThenTrim(withAdvance);
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.gateLines).toEqual([]);
	});

	it("is what the pass turns on: without it the same trim is refused, naming the file", () => {
		const r = commitThenTrim({});
		expect(r.landed).toBe(false);
		expect(r.stderr).toContain(`refusing ${DOC}`);
	});

	it("advances every path the commit touched, and no other", () => {
		start("alice");
		store.acquire(DOC, live(sb, "alice"));
		store.acquire(OTHER, live(sb, "alice"));
		const other = readBaseOf(OTHER);
		write(DOC, "alice's\n");
		write("docs/new.md", "new\n");
		git("add", "--", "docs/new.md");
		expect(
			commit(["-m", "alice", "--", DOC, "docs/new.md"], withAdvance).landed,
		).toBe(true);

		const head = git("rev-parse", "HEAD");
		expect(readBaseOf(DOC)).toMatchObject({
			head,
			blob: git("rev-parse", `HEAD:${DOC}`),
		});
		expect(readBaseOf("docs/new.md")).toMatchObject({ head });
		expect(readBaseOf(OTHER)).toEqual(other);
	});

	it("advances nothing with no session id", () => {
		write(DOC, "a person's\n");
		const r = commit(["-m", "person", "--", DOC], {
			...withAdvance,
			env: { CLAUDE_CODE_SESSION_ID: "" },
		});
		expect(r.landed).toBe(true);
		expect(readBaseOf(DOC, "")).toBeNull();
		expect(fs.existsSync(store.paths.basesDir())).toBe(false);
	});

	/** A neighbour's commit on a side branch, and alice's base on DOC before it. */
	const sideCommit = () => {
		start("alice");
		store.acquire(DOC, live(sb, "alice"));
		const before = readBaseOf(DOC);
		git("checkout", "-qb", "side");
		neighbourCommits(DOC, "seeded\nside line\n");
		const sha = git("rev-parse", "HEAD");
		git("checkout", "-q", "main");
		return { before, sha };
	};
	/** git as alice's session runs it, through the advance's hook. */
	const aliceGit = (args: string[], input?: string) =>
		spawnSync("git", ["-c", `core.hooksPath=${hooks(withAdvance)}`, ...args], {
			cwd: sb.repo,
			encoding: "utf8",
			input,
			env: { ...process.env, CLAUDE_CODE_SESSION_ID: "alice" },
		});

	it("advances nothing on a cherry-pick replay", () => {
		const { before, sha } = sideCommit();
		expect(aliceGit(["cherry-pick", sha]).status).toBe(0);
		expect(git("show", `HEAD:${DOC}`)).toContain("side line");
		expect(readBaseOf(DOC)).toEqual(before);
	});

	it("advances nothing on a rebase replay", () => {
		const { before } = sideCommit();
		write(OTHER, "main moves\n");
		git("commit", "-qm", "main moves", "--", OTHER);
		expect(aliceGit(["rebase", "-q", "main", "side"]).status).toBe(0);
		expect(git("show", `HEAD:${DOC}`)).toContain("side line");
		expect(readBaseOf(DOC)).toEqual(before);
	});

	it("advances nothing on `git am`, which fires no post-commit", () => {
		const { before, sha } = sideCommit();
		const patch = git("format-patch", "-1", "--stdout", sha);
		const r = aliceGit(["am", "-q"], `${patch}\n`);
		expect(r.status).toBe(0);
		expect(git("show", `HEAD:${DOC}`)).toContain("side line");
		expect(readBaseOf(DOC)).toEqual(before);
	});

	it("advances nothing on a commit in a linked worktree", () => {
		start("alice");
		store.acquire(DOC, live(sb, "alice"));
		const before = readBaseOf(DOC);
		const wt = path.join(sb.dir, "wt");
		git("worktree", "add", "-q", "-b", "wt", wt);
		fs.writeFileSync(path.join(wt, DOC), "worktree's\n");
		expect(
			commit(["-m", "wt", "--", DOC], { ...withAdvance, cwd: wt }).landed,
		).toBe(true);
		expect(readBaseOf(DOC)).toEqual(before);
	});
});

describe("the gate's skips on the replay path (#113)", () => {
	/*
	 * Each sequence stops on a conflict in OTHER, leaving its marker in the git
	 * directory, over a HEAD a neighbour has moved DOC past alice's base on. The
	 * hand commit that finishes it carries DOC at the base, which the gate would
	 * refuse anywhere else.
	 */
	const branchEditingOther = () => {
		git("checkout", "-qb", "topic");
		write(OTHER, "topic's\n");
		git("commit", "-qam", "topic edits OTHER");
		git("checkout", "-q", "-");
	};
	const conflicted = (run: () => void) => {
		staleSetup();
		branchEditingOther();
		neighbourCommits(OTHER, "main's\n");
		run();
		write(OTHER, "resolved\n");
		write(DOC, "seeded\n");
		git("add", "--", OTHER, DOC);
		return commit(["-m", "resolution"]);
	};
	const fails = (...args: string[]) =>
		expect(
			spawnSync("git", args, {
				cwd: sb.repo,
				env: { ...process.env, CLAUDE_CODE_SESSION_ID: "" },
			}).status,
		).not.toBe(0);

	it("skips a commit made during a cherry-pick", () => {
		const r = conflicted(() => fails("cherry-pick", "topic"));
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("skips a commit made during a rebase", () => {
		const r = conflicted(() => {
			git("checkout", "-q", "topic");
			fails("rebase", "main");
		});
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("skips a commit made during git am", () => {
		const r = conflicted(() => {
			const patch = git("format-patch", "-1", "topic", "-o", sb.dir);
			fails("am", patch);
		});
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});
});

describe("the gate fails open (#113)", () => {
	const expectFailedOpen = (r: ReturnType<typeof commit>, fault: RegExp) => {
		expect(r.landed).toBe(true);
		expect(r.status).toBe(0);
		expect(r.gateLines).toHaveLength(1);
		expect(r.gateLines[0]).toMatch(fault);
		expect(r.gateLines[0]).toMatch(/check.guard-errors/);
	};

	it.skipIf(AS_ROOT)("on an unreadable store", () => {
		staleSetup();
		write(DOC, "seeded\n");
		const dir = sb.stateDir();
		fs.chmodSync(dir, 0o000);
		try {
			expectFailedOpen(commit(["-m", "alice", "--", DOC]), /not checked/);
		} finally {
			fs.chmodSync(dir, 0o755);
		}
	});

	it("on a git error, and logs it", () => {
		start("alice");
		// A session base naming a commit git does not have.
		core.writeRecord(store.paths.sessionBase("alice"), {
			sessionId: "alice",
			head: "0123456789abcdef0123456789abcdef01234567",
			at: new Date().toISOString(),
		});
		write(DOC, "alice's\n");
		expectFailedOpen(commit(["-m", "alice", "--", DOC]), /git could not read/);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("stale-check");
	});

	it("on a timeout, and logs it", () => {
		staleSetup();
		write(DOC, "seeded\n");
		const r = commit(["-m", "alice", "--", DOC], {
			env: { WFC_STALE_GATE_BOUND: "0.001" },
		});
		expectFailedOpen(r, /timed out/);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("timed out");
	});

	it("on an arbiter that crashes, which exits 1 and is not a refusal", () => {
		staleSetup();
		write(DOC, "seeded\n");
		const bin = path.join(sb.dir, "crashing-node");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "node"),
			"#!/bin/sh\necho 'Error: Cannot find module' >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		const r = commit(["-m", "alice", "--", DOC], {
			env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
		});
		expectFailedOpen(r, /exited 1/);
		expect(r.stderr).not.toContain("Cannot find module");
	});
});
