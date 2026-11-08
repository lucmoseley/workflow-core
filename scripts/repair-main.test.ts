// @vitest-environment node
/*
 * The repair of an unreadable shared `main` (#3198), run as a session runs it,
 * against a real repo. Its side on the real tick is refill-loop-run-holds.test.ts's, and
 * the guard's that names it is guard-pull-form.test.ts's.
 *
 * WHAT BREAKING IT COSTS: a proof that lets a readable `main` through rewinds a
 * neighbour's commits; a target that takes the reflog's last line restores an
 * unpushed scratch commit as `main`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, initGitRepo, mkScratchDir } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const CLI = path.join(__dirname, "repair-main.js");
const SESSION = "repair-session";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, file: string, message: string) => {
	fs.writeFileSync(path.join(cwd, file), `${message}\n`);
	git(cwd, "add", file);
	git(cwd, "commit", "-qm", message);
	return git(cwd, "rev-parse", "HEAD");
};

/* `pushed` is on origin; `A` and `B` are scratch commits, on none. */
const template = defineTemplate((root) => {
	const repo = path.join(root, "repo");
	const hooks = path.join(root, "no-hooks");
	fs.mkdirSync(repo);
	fs.mkdirSync(hooks);
	initGitRepo(repo, hooks);
	const origin = path.join(root, "origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	git(repo, "remote", "add", "origin", origin);
	commit(repo, "tracked.txt", "pushed");
	git(repo, "push", "-q", "origin", "main");
	commit(repo, "tracked.txt", "A");
	commit(repo, "tracked.txt", "B");
	git(repo, "worktree", "add", "-q", "--detach", path.join(root, "worktree"));
});

let dir: string;
let repo: string;
let refFile: string;

const shaOf = (subject: string) =>
	git(repo, "log", "-g", "--format=%H %gs", "--all", "--no-walk=unsorted")
		.split("\n")
		.find((l) => l.endsWith(`commit: ${subject}`))
		?.split(" ")[0] ?? "";

const repair = (
	cwd = repo,
	session: string | undefined = SESSION,
	over: NodeJS.ProcessEnv = {},
	args: string[] = [],
) =>
	runInProcess(CLI, args, {
		cwd,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: cwd,
			CLAUDE_CODE_SESSION_ID: session,
			...over,
		},
	});

const backups = () => {
	const base = path.join(repo, ".claude", "tmp", `git-repair-${SESSION}`);
	return fs.existsSync(base)
		? fs.readdirSync(base).map((run) => path.join(base, run))
		: [];
};

const ASK_FOUNDER = "repo-hold.js list";

const expectRefused = (
	r: { status: number | null; stderr: string },
	named: string,
	wayOut = ASK_FOUNDER,
) => {
	expect(r.status).toBe(1);
	expect(r.stderr).toContain("repair-main: refused, main not written:");
	expect(r.stderr).toContain(named);
	expect(r.stderr).toContain(wayOut);
	expect(backups()).toEqual([]);
};

/* A git that runs `act` on the call matching `pattern`, then goes on as real git. */
const stubGit = (pattern: string, act: string) => {
	const stub = path.join(dir, "git-stub");
	fs.writeFileSync(
		stub,
		`#!/bin/sh\ncase "$*" in *${shellQuote(pattern)}*) ${act} ;; esac\nexec git "$@"\n`,
		{ mode: 0o755 },
	);
	return stub;
};
const CUT_OFF = "kill -9 $$";

beforeEach(() => {
	dir = mkScratchDir("repair-main-");
	template.instantiate(dir);
	repo = path.join(dir, "repo");
	refFile = path.join(repo, ".git", "refs", "heads", "main");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the proofs", () => {
	it("refuses a readable main, at whatever commit", () => {
		const before = fs.readFileSync(refFile, "utf8");
		const r = repair();
		expectRefused(r, "`main` reads", "git merge --ff-only");
		expect(fs.readFileSync(refFile, "utf8")).toBe(before);
	});

	it("refuses a missing ref file", () => {
		fs.rmSync(refFile);
		const r = repair();
		expectRefused(r, "does not exist");
		expect(fs.existsSync(refFile)).toBe(false);
	});

	it("refuses where no reflog entry is an ancestor of origin, writing nothing", () => {
		const orphan = git(
			repo,
			"commit-tree",
			"-m",
			"elsewhere",
			`${git(repo, "rev-parse", "HEAD")}^{tree}`,
		);
		git(repo, "update-ref", "refs/remotes/origin/main", orphan);
		fs.writeFileSync(refFile, "");
		const r = repair();
		expectRefused(r, "is an ancestor of");
		expect(fs.readFileSync(refFile, "utf8")).toBe("");
	});

	it("refuses where no origin ref resolves, writing nothing", () => {
		git(repo, "update-ref", "-d", "refs/remotes/origin/main");
		fs.writeFileSync(refFile, "");
		const r = repair();
		expectRefused(r, "resolves");
		expect(fs.readFileSync(refFile, "utf8")).toBe("");
	});

	it("refuses with no reflog to read", () => {
		fs.writeFileSync(refFile, "");
		fs.rmSync(path.join(repo, ".git", "logs", "refs", "heads", "main"));
		expectRefused(repair(), "no reflog");
		expect(fs.readFileSync(refFile, "utf8")).toBe("");
	});

	it("refuses a shared tree not on main, whose index it would load another branch into", () => {
		git(repo, "checkout", "-q", "-b", "side");
		fs.writeFileSync(refFile, "");
		const r = repair();
		expectRefused(r, "not on `main`");
	});

	it("refuses from no session, as the loop strips its identity and never repairs", () => {
		fs.writeFileSync(refFile, "");
		const r = repair(repo, "");
		expectRefused(r, "no session id", "Run it from a session");
	});

	it("refuses behind a held ref lock, leaving the lock", () => {
		fs.writeFileSync(refFile, "");
		fs.writeFileSync(`${refFile}.lock`, "held");
		expectRefused(repair(), "could not take", "Re-run");
		expect(fs.readFileSync(`${refFile}.lock`, "utf8")).toBe("held");
		expect(fs.readFileSync(refFile, "utf8")).toBe("");
	});

	it("refuses a main a neighbour restored behind its first read, proved again under the lock", () => {
		const tip = fs.readFileSync(refFile, "utf8");
		fs.writeFileSync(refFile, "");
		const r = repair(repo, SESSION, {
			WFC_GIT: stubGit(
				"merge-base",
				`echo ${shellQuote(tip.trim())} > ${shellQuote(refFile)}`,
			),
		});
		expectRefused(r, "`main` reads", "git merge --ff-only");
		expect(fs.readFileSync(refFile, "utf8")).toBe(tip);
		expect(fs.existsSync(`${refFile}.lock`)).toBe(false);
	});

	it("writes nothing where the backup fails, and gives the lock back", () => {
		fs.writeFileSync(refFile, "");
		fs.writeFileSync(path.join(repo, ".claude"), "");
		expectRefused(repair(), "no backup, so no write");
		expect(fs.readFileSync(refFile, "utf8")).toBe("");
		expect(fs.existsSync(`${refFile}.lock`)).toBe(false);
	});

	it.each([
		["the ref's own read", "--verify refs/heads/main", "did not answer"],
		["the ancestor read", "merge-base", "did not answer"],
	])(
		"refuses a git cut off on %s, which proves nothing",
		(_what, call, named) => {
			fs.writeFileSync(refFile, "");
			const r = repair(repo, SESSION, { WFC_GIT: stubGit(call, CUT_OFF) });
			expectRefused(r, named, "Re-run");
			expect(fs.readFileSync(refFile, "utf8")).toBe("");
		},
	);

	it("refuses an origin ref git will not read, as it may be the one with the proof", () => {
		fs.writeFileSync(refFile, "");
		const r = repair(repo, SESSION, {
			WFC_GIT: stubGit("refs/remotes/origin/main", "exit 129"),
		});
		expectRefused(r, "could not read origin/main", "Re-run");
		expect(fs.readFileSync(refFile, "utf8")).toBe("");
	});

	it("exits 2 on an argument it does not take, reading nothing", () => {
		fs.writeFileSync(refFile, "");
		const r = repair(repo, SESSION, {}, ["--force"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage:");
		expect(fs.readFileSync(refFile, "utf8")).toBe("");
	});
});

describe.each([
	["empty", ""],
	/* A sha and its newline long. */
	["NUL-filled", "\0".repeat(41)],
])("repairing an %s ref", (_name, broken) => {
	beforeEach(() => fs.writeFileSync(refFile, broken));

	it("picks the pushed tip over newer unpushed scratch entries, the 27 Oct failure (#3198)", () => {
		const r = repair();
		expect(r.status).toBe(0);
		expect(fs.readFileSync(refFile, "utf8")).toBe(`${shaOf("pushed")}\n`);
		expect(git(repo, "rev-parse", "--verify", "refs/heads/main")).toBe(
			shaOf("pushed"),
		);
		expect(r.stdout).toMatch(/\n[0-9a-f]+ pushed\n/);
		expect(fs.existsSync(`${refFile}.lock`)).toBe(false);
	});

	it("takes the backup before the write", () => {
		const index = fs.readFileSync(path.join(repo, ".git", "index"));
		const r = repair();
		expect(r.status).toBe(0);
		const [backup] = backups();
		expect(r.stdout).toContain(`Backup of the ref and the index: ${backup}`);
		expect(fs.readFileSync(path.join(backup ?? "", "main"), "utf8")).toBe(
			broken,
		);
		expect(fs.readFileSync(path.join(backup ?? "", "index"))).toEqual(index);
	});

	it("lists the newer entries, oldest first", () => {
		const r = repair();
		expect(r.status).toBe(0);
		const a = r.stdout.indexOf(`${shaOf("A")} commit: A\n`);
		const b = r.stdout.indexOf(`${shaOf("B")} commit: B\n`);
		expect(r.stdout).toContain("2 reflog entries newer than the target");
		expect(a).toBeGreaterThan(-1);
		expect(b).toBeGreaterThan(a);
	});

	it("leaves working files untouched, and rebuilds the index from the target", () => {
		const tracked = path.join(repo, "tracked.txt");
		const stray = path.join(repo, "stray.txt");
		fs.writeFileSync(tracked, "a neighbour's edit\n");
		fs.writeFileSync(stray, "untracked\n");
		expect(repair().status).toBe(0);
		expect(fs.readFileSync(tracked, "utf8")).toBe("a neighbour's edit\n");
		expect(fs.readFileSync(stray, "utf8")).toBe("untracked\n");
		expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
	});

	it("repairs the shared tree's main from a linked worktree", () => {
		const r = repair(path.join(dir, "worktree"));
		expect(r.status).toBe(0);
		expect(fs.readFileSync(refFile, "utf8")).toBe(`${shaOf("pushed")}\n`);
		expect(backups()).toHaveLength(1);
		expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
	});

	it("refuses a second run, once main reads again", () => {
		expect(repair().status).toBe(0);
		const second = repair();
		expect(second.status).toBe(1);
		expect(second.stderr).toContain("`main` reads");
		expect(backups()).toHaveLength(1);
	});
});

it("says so where the target is the reflog's last entry", () => {
	git(repo, "push", "-q", "origin", "main");
	fs.writeFileSync(refFile, "");
	const r = repair();
	expect(r.status).toBe(0);
	expect(fs.readFileSync(refFile, "utf8")).toBe(`${shaOf("B")}\n`);
	expect(r.stdout).toContain("No reflog entry is newer than the target.");
});

it("reports an index that will not rebuild, with main restored and the entries still listed", () => {
	fs.writeFileSync(refFile, "");
	fs.writeFileSync(path.join(repo, ".git", "index.lock"), "");
	const r = repair();
	expect(r.status).toBe(1);
	expect(fs.readFileSync(refFile, "utf8")).toBe(`${shaOf("pushed")}\n`);
	expect(r.stderr).toContain("run `git read-tree HEAD`");
	expect(r.stdout).toContain("2 reflog entries newer than the target");
});

it("shows a torn reflog line whole among the newer entries, and takes no target from it", () => {
	fs.writeFileSync(refFile, "");
	fs.appendFileSync(
		path.join(repo, ".git", "logs", "refs", "heads", "main"),
		"torn line\n",
	);
	const r = repair();
	expect(r.status).toBe(0);
	expect(fs.readFileSync(refFile, "utf8")).toBe(`${shaOf("pushed")}\n`);
	expect(r.stdout).toContain("3 reflog entries newer than the target");
	expect(r.stdout).toContain("\ntorn line\n");
});

it("reads an abbreviated new sha as torn, as it would leave the ref as broken", () => {
	const log = path.join(repo, ".git", "logs", "refs", "heads", "main");
	const pushed = shaOf("pushed");
	fs.writeFileSync(refFile, "");
	fs.appendFileSync(
		log,
		`${pushed} ${pushed.slice(0, 8)} t <t@t> 1 +0000\tcommit: short\n`,
	);
	const r = repair();
	expect(r.status).toBe(0);
	expect(fs.readFileSync(refFile, "utf8")).toBe(`${pushed}\n`);
	expect(r.stdout).toContain("commit: short\n");
});

it("lists an entry git wrote with no message, as `git update-ref` does", () => {
	const log = path.join(repo, ".git", "logs", "refs", "heads", "main");
	const b = shaOf("B");
	fs.writeFileSync(refFile, "");
	fs.appendFileSync(log, `${b} ${"c".repeat(40)} t <t@t> 1 +0000\n`);
	const r = repair();
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(`${"c".repeat(40)} (no message)\n`);
});
