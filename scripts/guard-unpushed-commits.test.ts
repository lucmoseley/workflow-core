// @vitest-environment node
/*
 * Pins the Stop guard that names this session's own unpushed commits, the
 * `session-arbiter.js record-commit` ledger it reads, and the .husky/post-commit
 * block that writes it.
 *
 * Each test builds a throwaway repo with a bare origin and its own Claude
 * config dir, because the guard's answer turns on what the pushed ref holds and
 * which session's ledger names a commit, and the real repo can be set to
 * neither.
 *
 * Breaking it either leaves commits unpushed with no session owning the push,
 * or warns a session about a neighbour's commits (#766).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cutWorktree } from "./lib/git-fixture";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import {
	commitOverSequencer,
	cutInReplay,
	cutShellFunction,
	POST_COMMIT,
} from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { readStopGuardBlock } from "./lib/stop-guard-testkit";
import { buildBashCall } from "./lib/transcript-testkit";

const { projectSlug } = createRequire(__filename)("./lib/project-slug.js");

const GUARD = path.join(__dirname, "guard-unpushed-commits.js");
const ARBITER = path.join(__dirname, "session-arbiter.js");

let root: string;
let sid: string;

const config = () => path.join(root, ".claude-home");

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** A repo on `main` tracking `origin/main` in a bare sibling, one commit pushed. */
function makeRepo(): string {
	const base = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "unpushed-")),
	);
	const dir = path.join(base, "work");
	const origin = path.join(base, "origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	const fixtureGit = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	fixtureGit("config", "user.email", "t@example.com");
	fixtureGit("config", "user.name", "T");
	fixtureGit("remote", "add", "origin", origin);
	fixtureGit("commit", "-q", "--allow-empty", "-m", "base");
	fixtureGit("push", "-q", "-u", "origin", "main");
	return dir;
}

function commit(subject: string): string {
	git("commit", "-q", "--allow-empty", "-m", subject);
	return git("rev-parse", "HEAD");
}

/* The arbiter's commit ledger for this session: one sha per line, at
 * <config>/projects/<slug of the main worktree>/commits/<sid>.txt
 * (lib/arbiter-core.js `paths.commitLedger`). */
function ledgerFile(): string {
	return path.join(
		config(),
		"projects",
		projectSlug(root),
		"commits",
		`${sid}.txt`,
	);
}

function ledger(shas: string[]) {
	fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
	fs.writeFileSync(ledgerFile(), shas.map((s) => `${s}\n`).join(""));
}

/**
 * The guard's block for a turn ending `message`; with no `transcript`, the
 * payload names a file that does not exist.
 */
function run(
	message = "result: done.",
	transcript?: string,
	dir = root,
	env: NodeJS.ProcessEnv = {},
) {
	return readStopGuardBlock(GUARD, {
		dir,
		sid,
		config: config(),
		message,
		transcript,
		env,
	});
}

beforeEach(() => {
	root = makeRepo();
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("the session's own worktree, then the main checkout (#4243, #4272)", () => {
	const runIn = (wt: string) =>
		readStopGuardBlock(GUARD, {
			dir: root,
			worktree: wt,
			sid,
			config: config(),
			message: "result: done.",
		});

	it("names a commit on the worktree's HEAD, read against the host's ledger", () => {
		const wt = cutWorktree(root);
		execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "in wt"], {
			cwd: wt,
		});
		ledger([
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: wt,
				encoding: "utf8",
			}).trim(),
		]);
		const out = runIn(wt);
		expect(out?.reason).toContain(
			"1 commit(s) this session made are not on origin/main",
		);
		expect(out?.reason).toContain("in wt");
	});

	it("names the main checkout's unpushed commit when the worktree's HEAD carries none", () => {
		const wt = cutWorktree(root);
		ledger([commit("in main")]);
		const out = runIn(wt);
		expect(out?.reason).toContain(
			`1 commit(s) this session made in the main checkout (${root}) are not on origin/main`,
		);
		expect(out?.reason).toContain("in main");
	});

	it("names both checkouts' commits in one warning", () => {
		const wt = cutWorktree(root);
		const inMain = commit("in main");
		execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "in wt"], {
			cwd: wt,
		});
		ledger([
			inMain,
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: wt,
				encoding: "utf8",
			}).trim(),
		]);
		const reason = runIn(wt)?.reason ?? "";
		expect(reason).toContain(
			"1 commit(s) this session made are not on origin/main",
		);
		expect(reason).toContain("in the main checkout");
		expect(reason.indexOf("in wt")).toBeLessThan(reason.indexOf("in main"));
	});
});

describe("the warning", () => {
	it("names this session's commits that are not on origin/main", () => {
		const a = commit("first of mine");
		const b = commit("second of mine");
		ledger([a, b]);
		const out = run();
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("A warning, not a refusal");
		expect(out?.reason).toContain("2 commit(s)");
		expect(out?.reason).toContain("origin/main");
		expect(out?.reason).toContain(`${b.slice(0, 7)}`);
		expect(out?.reason).toContain("first of mine");
		expect(out?.reason).toContain("second of mine");
	});

	it("says nothing when the session made no commit", () => {
		commit("their commit");
		expect(run()).toBeNull();
	});

	it("says nothing once the session's commits are pushed", () => {
		ledger([commit("mine")]);
		git("push", "-q", "origin", "main");
		expect(run()).toBeNull();
	});

	it("never names a neighbour's unpushed commit", () => {
		const mine = commit("mine");
		commit("their commit");
		ledger([mine]);
		const out = run();
		expect(out?.reason).toContain("1 commit(s)");
		expect(out?.reason).toContain("mine");
		expect(out?.reason).not.toContain("their commit");
	});

	it("says nothing where only a neighbour's commits are unpushed", () => {
		const mine = commit("mine");
		git("push", "-q", "origin", "main");
		commit("their commit");
		ledger([mine]);
		expect(run()).toBeNull();
	});

	it("says nothing about a commit no longer on HEAD", () => {
		const mine = commit("rewound");
		git("reset", "-q", "--hard", "HEAD~1");
		ledger([mine]);
		expect(run()).toBeNull();
	});

	it("says nothing where the pushed ref does not resolve", () => {
		git("update-ref", "-d", "refs/remotes/origin/main");
		ledger([commit("mine")]);
		expect(run()).toBeNull();
	});

	it("reads the main worktree's ledger from a session started in a linked one", () => {
		ledger([commit("mine")]);
		const linked = `${root}-wt`;
		git("worktree", "add", "-q", "--detach", linked);
		expect(run(undefined, undefined, linked)?.reason).toContain("mine");
	});

	it("says nothing where the ledger names a sha git does not have", () => {
		ledger(["0".repeat(40)]);
		expect(run()).toBeNull();
	});

	it("tells the session to run push:check before it pushes", () => {
		ledger([commit("mine")]);
		expect(run()?.reason).toMatch(
			/\(`rule:push-cadence`\): run `[^`]*push-check\.js`, then push\. /,
		);
	});

	it("tells the session just to push where the suites module is off", () => {
		ledger([commit("mine")]);
		const out = run(undefined, undefined, root, { WFC_MODULES: "" });
		expect(out?.reason).toContain(
			'push to `origin/main` — module "suites" is off',
		);
		expect(out?.reason).not.toMatch(/push-check/);
	});
});

describe("with the landing module on (#2408, #4485)", () => {
	const landing = { WFC_MODULES: "suites,landing" };

	/** A session worktree whose HEAD carries one commit of this session's. */
	const sessionCommit = (subject: string) => {
		const wt = cutWorktree(root, "q1");
		const wtGit = (...args: string[]) =>
			execFileSync("git", args, { cwd: wt, encoding: "utf8" }).trim();
		wtGit("commit", "-q", "--allow-empty", "-m", subject);
		const sha = wtGit("rev-parse", "HEAD");
		ledger([sha]);
		return { wt, wtGit, sha };
	};

	it("names a session worktree's commit on origin/main's tip but not on its queue ref, once it has one", () => {
		const { wt, wtGit } = sessionCommit("mine");
		wtGit("push", "-q", "origin", "HEAD~1:refs/heads/queue/q1");
		wtGit("fetch", "-q", "origin");
		const out = run(undefined, undefined, wt, landing);
		expect(out?.reason).toContain("not on origin/queue/q1");
		expect(out?.reason).toContain("mine");
	});

	it("tells the session to land, which pushes its queue ref, with no push:check first (#2933)", () => {
		const { wt } = sessionCommit("mine");
		const out = run(undefined, undefined, wt, landing);
		expect(out?.reason).toContain(
			'land it with `node scripts/session-checkout.js land`, which pushes your queue ref — module "landing" is on — the lander runs the full suite',
		);
		expect(out?.reason).toContain("(`rule:push-cadence-landing`)");
		expect(out?.reason).not.toMatch(/push-check|push to `origin\/main`/);
	});

	it("names the base cadence rule and push_check where the config will not read", () => {
		ledger([commit("mine")]);
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 99 }),
		);
		const out = run();
		expect(out?.reason).toContain("(`rule:push-cadence`): run `");
		expect(out?.reason).toContain("then push.");
	});

	it("says nothing once the commit is on the session's queue ref", () => {
		const { wt, wtGit } = sessionCommit("mine");
		wtGit("push", "-q", "origin", "HEAD:refs/heads/queue/q1");
		wtGit("fetch", "-q", "origin");
		expect(run(undefined, undefined, wt, landing)).toBeNull();
	});
});

describe("the bound", () => {
	it("passes the re-stop: each commit is warned about once", () => {
		ledger([commit("mine")]);
		expect(run()?.decision).toBe("block");
		expect(run()).toBeNull();
	});

	it("warns again when a new commit lands, naming every unpushed one", () => {
		const a = commit("older");
		ledger([a]);
		expect(run()?.decision).toBe("block");
		const b = commit("newer");
		ledger([a, b]);
		const out = run();
		expect(out?.reason).toContain("2 commit(s)");
		expect(out?.reason).toContain("older");
	});

	it("stops at three blocks a session", () => {
		const shas: string[] = [];
		for (let i = 0; i < 4; i++) {
			shas.push(commit(`c${String(i)}`));
			ledger(shas);
			const out = run();
			if (i < 3) expect(out?.decision).toBe("block");
			else expect(out).toBeNull();
		}
	});

	const handoff = "waiting: the suite run will wake this session.";

	function transcript(launchOut: boolean): string {
		const file = path.join(path.dirname(root), "transcript.jsonl");
		const lines: unknown[] = [
			{ type: "user", message: { content: [{ type: "text", text: "go" }] } },
			buildBashCall("sleep 60", "toolu_launch01", {
				input: { run_in_background: true },
			}),
		];
		if (!launchOut)
			lines.push({
				type: "user",
				message: {
					content: [
						{
							type: "text",
							text: "<task-notification><tool-use-id>toolu_launch01</tool-use-id></task-notification>",
						},
					],
				},
			});
		fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
		return file;
	}

	it("passes over a `waiting:` hand-off with a launch out, and warns on the turn after", () => {
		ledger([commit("mine")]);
		expect(run(handoff, transcript(true))).toBeNull();
		expect(run()?.decision).toBe("block");
	});

	it("warns on a `waiting:` resting on nothing still running", () => {
		ledger([commit("mine")]);
		expect(run(handoff, transcript(false))?.decision).toBe("block");
	});
});

describe("session-arbiter.js record-commit", () => {
	const record = (sha: string, session = sid) =>
		runInProcess(ARBITER, ["record-commit", sha], {
			cwd: root,
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: config(),
				CLAUDE_PROJECT_DIR: root,
				CLAUDE_CODE_SESSION_ID: session,
			},
		});

	it("appends the sha to this session's ledger, silently, and the guard reads it", () => {
		const sha = commit("mine");
		const r = record(sha);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.readFileSync(ledgerFile(), "utf8")).toBe(`${sha}\n`);
		expect(run()?.reason).toContain("mine");
	});

	it("records nothing without a session id, or for a non-sha", () => {
		for (const r of [record(commit("x"), ""), record("HEAD")])
			expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(ledgerFile())).toBe(false);
	});

	it("prints its usage and exits 2 with no commit", () => {
		const r = record("");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: session-arbiter.js record-commit");
	});
});

describe(".husky/post-commit's unpushed count (#2408)", () => {
	const block = cutShellFunction("report_unpushed");

	/** `sh -e`, as husky runs every hook. */
	function count(env: NodeJS.ProcessEnv = {}, cwd = root): string {
		const r = spawnSync("sh", ["-e", "-c", `${block}\nreport_unpushed`], {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				WFC_PLUGIN_ROOT: path.join(__dirname, ".."),
				...env,
			},
		});
		expect(r.status).toBe(0);
		return r.stdout;
	}

	it("counts the commits not on origin/main with the module off", () => {
		commit("mine");
		expect(count()).toContain("1 commit not pushed to origin/main.");
	});

	it("counts a session worktree's commits not on its queue ref with the module on", () => {
		const wt = cutWorktree(root, "q1");
		const wtGit = (...args: string[]) =>
			execFileSync("git", args, { cwd: wt, encoding: "utf8" }).trim();
		wtGit("push", "-q", "origin", "HEAD:refs/heads/queue/q1");
		wtGit("fetch", "-q", "origin");
		wtGit("commit", "-q", "--allow-empty", "-m", "mine");
		wtGit("commit", "-q", "--allow-empty", "-m", "mine too");
		expect(count({ WFC_MODULES: "landing" }, wt)).toContain(
			"2 commits not pushed to origin/queue/q1.",
		);
	});

	it("says the pushed ref is missing rather than counting against nothing", () => {
		git("update-ref", "-d", "refs/remotes/origin/main");
		commit("mine");
		expect(count({ WFC_MODULES: "landing" })).toContain(
			"origin/main does not exist here",
		);
	});
});

describe(".husky/post-commit's record block", () => {
	const temps = registerTempCleanup(afterEach);
	const block = `${cutInReplay()}\n${cutShellFunction("record_session_commit")}`;

	/** A stub arbiter printing its argv and the project dir it was handed. */
	const stub =
		'process.stdout.write(process.argv.slice(2).join(" ") + " @ " + process.env.CLAUDE_PROJECT_DIR + "\\n");\n';

	function hookRepo() {
		const repo = newRepo("post-commit-record-", temps);
		repo.git("commit", "-q", "--allow-empty", "-m", "one");
		fs.mkdirSync(path.join(repo.root, "scripts"));
		fs.writeFileSync(
			path.join(repo.root, "scripts", "session-arbiter.js"),
			stub,
		);
		return repo;
	}

	/** `sh -e`, as husky runs every hook. */
	function runBlock(cwd: string, env: Record<string, string>) {
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
		}).trim();
		const r = spawnSync(
			"sh",
			[
				"-e",
				"-c",
				`committed=${shellQuote(head)}\n${block}\nrecord_session_commit\nprintf "reached-end\\n"`,
			],
			{ cwd, encoding: "utf8", env: { ...process.env, ...env } },
		);
		expect(r.stdout).toContain("reached-end");
		return { head, out: r.stdout.replace("reached-end\n", "") };
	}

	it("is called at column zero in the live hook", () => {
		expect(POST_COMMIT.split("\n")).toContain("record_session_commit");
	});

	it("hands the arbiter the commit, rooted at the main worktree", () => {
		const repo = hookRepo();
		const { head, out } = runBlock(repo.root, {
			CLAUDE_CODE_SESSION_ID: "s1",
		});
		expect(out.trim()).toBe(
			`record-commit ${head} @ ${fs.realpathSync(repo.root)}`,
		);
	});

	it("roots a linked worktree's commit at the main worktree too", () => {
		const repo = hookRepo();
		const linked = path.join(repo.root, "..", `${path.basename(repo.root)}-wt`);
		temps.push(linked);
		repo.git("worktree", "add", "-q", "--detach", linked);
		fs.mkdirSync(path.join(linked, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(linked, "scripts", "session-arbiter.js"), stub);
		const { out } = runBlock(linked, { CLAUDE_CODE_SESSION_ID: "s1" });
		expect(out.trim().endsWith(`@ ${fs.realpathSync(repo.root)}`)).toBe(true);
	});

	it("records nothing without a session id", () => {
		const repo = hookRepo();
		const { out } = runBlock(repo.root, { CLAUDE_CODE_SESSION_ID: "" });
		expect(out).toBe("");
	});

	it("records a commit made over a leftover sequencer (#3298)", () => {
		const repo = hookRepo();
		commitOverSequencer(repo.root, false);
		const { head, out } = runBlock(repo.root, {
			CLAUDE_CODE_SESSION_ID: "s1",
		});
		expect(out).toContain(`record-commit ${head}`);
	});

	it("records nothing mid revert sequence", () => {
		const repo = hookRepo();
		commitOverSequencer(repo.root, true);
		const { out } = runBlock(repo.root, { CLAUDE_CODE_SESSION_ID: "s1" });
		expect(out).toBe("");
	});

	it("records nothing mid-replay", () => {
		const repo = hookRepo();
		fs.writeFileSync(path.join(repo.root, ".git", "CHERRY_PICK_HEAD"), "x\n");
		const { out } = runBlock(repo.root, { CLAUDE_CODE_SESSION_ID: "s1" });
		expect(out).toBe("");
	});
});
