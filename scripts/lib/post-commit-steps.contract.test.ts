// @vitest-environment node
/*
 * The equivalence contract for `.husky/post-commit`'s steps (#5208, spec
 * #5207 seam 3): each program the hook spawns, run in-process through its
 * PROGRAM export or, for the two `--touched-by` checkers, lib/check.js's
 * checkInProcess(), gives the same exit code, stdout and stderr as the same
 * program spawned as `node <script> <args>` over the same fixture; and each
 * of lib/post-commit-steps.js's eight steps prints exactly what the hook's
 * own shell block prints, cut from `.husky/post-commit` and run in sh over
 * the same fixture — the unpushed report and the dropped-review-tier report,
 * which have no program of their own, held to that alone.
 *
 * Every case compares the two runs, never a hand-written expectation, and
 * the linked-worktree cases run under the GIT_INDEX_FILE, GIT_DIR and
 * GIT_WORK_TREE a real post-commit hook is handed, captured from one.
 *
 * Breaking it costs the licence for the post-commit dispatcher's rows: a step
 * whose in-process run drifts from the hook it replaces says, or keeps
 * silent, differently after a commit, and a step reading the hook's
 * redirects reads another tree's index or gitdir.
 *
 * Over §X8's 10 s budget, at 12–17 s by load: every case pays a real `node` or
 * `sh` on its spawned side, the thing the contract compares against, and
 * each of the four program families and eight blocks needs its own fixture.
 *
 * spawn-kept: the `spawnedNode` and `shellBlock` helpers are the real
 * processes every in-process run is held to.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	arbiterCli,
	commitAll,
	freshSandbox,
	gitRepo,
	live,
} from "./arbiter-testkit";
import { checkInProcess } from "./check";
import {
	droppedReviewTier,
	keepShimsRow,
	newSharedFaultsRow,
	recordCommitRow,
	releaseClaimsRow,
	scrubbedGitEnv,
	touchedByRow,
	unpushedReport,
} from "./post-commit-steps.js";
import { cutPostCommitBlock, cutShellFunction } from "./precommit-gate-testkit";

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");
const load = createRequire(__filename);

const sb = freshSandbox();
const { cli } = arbiterCli(sb);

type Env = NodeJS.ProcessEnv;
interface Run {
	exit: number | null;
	stdout: string;
	stderr: string;
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: scrubbedGitEnv(process.env),
	}).trim();

const write = (repo: string, rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
};

const commit = (repo: string, rel: string, body: string, message = rel) => {
	write(repo, rel, body);
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", message);
	return git(repo, "rev-parse", "HEAD");
};

/** The sandbox repo with one seed commit. */
const seeded = () => {
	gitRepo(sb);
	write(sb.repo, "docs/notes.md", "seed\n");
	commitAll(sb);
	return sb.repo;
};

const spawnedNode = (
	script: string,
	args: string[],
	cwd: string,
	env: Env,
): Run => {
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd,
		env,
		encoding: "utf8",
	});
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A hook block run in sh as the hook runs it: `-e`, the core's own scripts. */
const shellBlock = (
	block: string,
	call: string,
	cwd: string,
	env: Env,
): Run => {
	const r = spawnSync("sh", ["-e", "-c", `${block}\n${call}`], {
		cwd,
		env: { ...env, WFC_PLUGIN_ROOT: ROOT },
		encoding: "utf8",
	});
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A PROGRAM export's run, as the dispatcher makes it. */
const program = (script: string, args: string[], cwd: string, env: Env) =>
	load(path.join(SCRIPTS, script)).PROGRAM({ cwd, env, args }) as Run;

/** The same program both ways, in-process and spawned. */
const bothWays = (script: string, args: string[], cwd: string, env: Env) => ({
	inProcess: program(script, args, cwd, env),
	spawned: spawnedNode(path.join(SCRIPTS, script), args, cwd, env),
});

const BLOCKS = {
	unpushed: [cutShellFunction("report_unpushed"), "report_unpushed"],
	faults: [
		cutPostCommitBlock("report_new_shared_faults"),
		"report_new_shared_faults",
	],
	release: [
		cutPostCommitBlock("release_committed_claims"),
		"release_committed_claims",
	],
	record: [
		cutPostCommitBlock("record_session_commit"),
		"record_session_commit",
	],
	shims: [cutShellFunction("keep_hook_shims"), "keep_hook_shims"],
	tier: [
		cutShellFunction("report_dropped_review_tier"),
		"report_dropped_review_tier",
	],
} as const;

const hook = (name: keyof typeof BLOCKS, cwd: string, env: Env) =>
	shellBlock(BLOCKS[name][0], BLOCKS[name][1], cwd, env);

const touchedHook = (script: string, cwd: string, env: Env) =>
	shellBlock(
		cutPostCommitBlock("report_touched_by"),
		`report_touched_by ${script}`,
		cwd,
		env,
	);

/** A stub whole-repo checker printing `<root>/envelope.json`, else none. */
const stubChecker = () => {
	const file = path.join(sb.dir, "stub-checker.js");
	fs.writeFileSync(
		file,
		`const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[process.argv.indexOf("--root") + 1];
const at = path.join(root, "envelope.json");
process.stdout.write(fs.existsSync(at) ? fs.readFileSync(at, "utf8") : '{"findings":[]}');
`,
	);
	return file;
};
/**
 * A whole-repo checker whose finding is each file under `<root>/docs` its own
 * `git ls-files`, run from that root, does not list. A materialised tree is
 * no repository, so a clean environment lists none and finds every file; one
 * still carrying the hook's GIT_DIR and GIT_INDEX_FILE lists the hook's index
 * and finds nothing.
 */
const gitProbeChecker = () => {
	const file = path.join(sb.dir, "git-probe-checker.js");
	fs.writeFileSync(
		file,
		`const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[process.argv.indexOf("--root") + 1];
const listed = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
const known = new Set(listed.status === 0 ? listed.stdout.split("\\n") : []);
const docs = path.join(root, "docs");
const files = fs.existsSync(docs) ? fs.readdirSync(docs).map((f) => "docs/" + f) : [];
const findings = files.filter((f) => !known.has(f)).map((f) => (${fault.toString()})(f));
process.stdout.write(JSON.stringify({ findings }));
`,
	);
	return file;
};
const brokenChecker = () => {
	const file = path.join(sb.dir, "broken-checker.js");
	fs.writeFileSync(file, 'process.stdout.write("not json {");\n');
	return file;
};
const fault = (file: string) => ({
	severity: "FAIL",
	tag: "UNPRINTED-RULE",
	message: `${file}:1 — no wired emitter prints this fragment.`,
	kind: "UNPRINTED-RULE",
	file,
	rule: `rule id "${file}"`,
});
const checkersEnv = (checkers: Record<string, string>): Env => ({
	...process.env,
	WFC_SHARED_FAULT_CHECKERS: JSON.stringify(checkers),
});

/**
 * A linked worktree of the sandbox repo whose commit fires a post-commit hook
 * recording the GIT_* variables git hands it; returns the worktree and the
 * caller's env with those variables in it, as a hook's own process has them.
 */
const linkedCommit = () => {
	seeded();
	const wt = path.join(sb.dir, "wt");
	git(sb.repo, "worktree", "add", "-q", "-b", "wt", wt);
	const hooks = path.join(sb.dir, "hooks");
	const seen = path.join(sb.dir, "hook-env");
	fs.mkdirSync(hooks);
	fs.writeFileSync(
		path.join(hooks, "post-commit"),
		`#!/bin/sh\nenv | grep -E '^GIT_(INDEX_FILE|DIR|WORK_TREE)=' > '${seen}'\n`,
		{ mode: 0o755 },
	);
	git(wt, "config", "core.hooksPath", hooks);
	commit(wt, "docs/wt.md", "from the worktree\n");
	git(wt, "config", "--unset", "core.hooksPath");
	const redirects = Object.fromEntries(
		fs
			.readFileSync(seen, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);
	return { wt, env: { ...process.env, ...redirects } as Env, redirects };
};

describe("each post-commit program runs in-process exactly as spawned", () => {
	it("report-new-shared-faults.js: a fault the commit added (exit 1)", () => {
		const repo = seeded();
		commit(
			repo,
			"envelope.json",
			JSON.stringify({ findings: [fault("x.txt")] }),
		);
		const sha = commit(
			repo,
			"envelope.json",
			JSON.stringify({ findings: [fault("x.txt"), fault("y.txt")] }),
		);
		const env = checkersEnv({ "guard-registry": stubChecker() });
		const r = bothWays("report-new-shared-faults.js", [sha], repo, env);
		expect(r.inProcess.exit).toBe(1);
		expect(r.inProcess).toEqual(r.spawned);
	});

	it("report-new-shared-faults.js: a side that would not read (exit 2)", () => {
		const repo = seeded();
		const sha = commit(repo, "a.txt", "a\n");
		const env = checkersEnv({ "guard-registry": brokenChecker() });
		const r = bothWays("report-new-shared-faults.js", [sha], repo, env);
		expect(r.inProcess.exit).toBe(2);
		expect(r.inProcess).toEqual(r.spawned);
	});

	it("report-new-shared-faults.js: a root commit and a bad ref", () => {
		const repo = seeded();
		const env = checkersEnv({ "guard-registry": stubChecker() });
		for (const args of [["HEAD"], ["no-such-ref"], ["a", "b"]]) {
			const r = bothWays("report-new-shared-faults.js", args, repo, env);
			expect(r.inProcess).toEqual(r.spawned);
		}
	});

	it("session-arbiter.js release-committed: a claim the commit landed", () => {
		const repo = seeded();
		live(sb, "alice");
		const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "alice" };
		const run = (way: "inProcess" | "spawned") => {
			write(repo, "docs/notes.md", `${way}\n`);
			expect(cli(["claim", "docs/notes.md"], env).status).toBe(0);
			const sha = commit(repo, "docs/notes.md", `${way}\n`);
			const args = ["release-committed", "--commit", sha, "docs/notes.md"];
			return way === "inProcess"
				? program("session-arbiter.js", args, repo, env)
				: spawnedNode(
						path.join(SCRIPTS, "session-arbiter.js"),
						args,
						repo,
						env,
					);
		};
		const inProcess = run("inProcess");
		expect(inProcess.stdout).toContain("Released docs/notes.md");
		expect(inProcess).toEqual(run("spawned"));
	});

	it("session-arbiter.js release-committed: nothing held, and no session", () => {
		const repo = seeded();
		const sha = git(repo, "rev-parse", "HEAD");
		const args = ["release-committed", "--commit", sha, "docs/notes.md"];
		for (const env of [
			{ ...process.env, CLAUDE_CODE_SESSION_ID: "bob" },
			scrubbedGitEnv({ ...process.env, CLAUDE_CODE_SESSION_ID: "" }),
		]) {
			const r = bothWays("session-arbiter.js", args, repo, env);
			expect(r.inProcess).toEqual(r.spawned);
		}
	});

	it("session-arbiter.js record-commit: the record, and its usage refusal", () => {
		const repo = seeded();
		const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "alice" };
		const sha = git(repo, "rev-parse", "HEAD");
		for (const args of [["record-commit", sha], ["record-commit"]]) {
			const r = bothWays("session-arbiter.js", args, repo, env);
			expect(r.inProcess).toEqual(r.spawned);
		}
		expect(cli(["writes", "--committed"], env).stdout.split("\n")).toContain(
			"docs/notes.md",
		);
	});

	it("keep-hook-shims.js --lazy, and a bad flag", () => {
		const repo = seeded();
		for (const args of [["--lazy"], [], ["--nope"]]) {
			const r = bothWays("keep-hook-shims.js", args, repo, process.env);
			expect(r.inProcess).toEqual(r.spawned);
		}
	});

	it.each(["check-instruction-surface.js", "check-guard-registry.js"])(
		"%s --touched-by, through checkInProcess",
		async (script) => {
			const file = path.join(SCRIPTS, script);
			const { SPEC } = load(file);
			expect(SPEC, `${script} exports its SPEC`).toBeTruthy();
			const repo = seeded();
			const args = [
				"--root",
				repo,
				"--touched-by",
				git(repo, "rev-parse", "HEAD"),
			];
			const was = process.cwd();
			process.chdir(repo);
			let inProcess: Run;
			try {
				inProcess = await checkInProcess(SPEC, args, { script: file });
			} finally {
				process.chdir(was);
			}
			expect(inProcess).toEqual(spawnedNode(file, args, repo, process.env));
		},
		60_000,
	);
});

describe("each post-commit step prints what the hook's block prints", () => {
	it("the unpushed report: none, one, several, and a missing ref", () => {
		const repo = seeded();
		const step = () => unpushedReport({ cwd: repo, env: process.env });
		const check = () =>
			expect(step()).toEqual(hook("unpushed", repo, process.env));
		check();
		git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
		check();
		commit(repo, "a.txt", "a\n");
		expect(step().stdout).toContain("1 commit not pushed to origin/main.");
		check();
		commit(repo, "b.txt", "b\n");
		expect(step().stdout).toContain("2 commits not pushed to origin/main.");
		check();
	});

	it("new shared faults: added, unreadable, and a root commit", () => {
		const repo = seeded();
		const io = (env: Env) => ({ cwd: repo, env });
		const clean = checkersEnv({ "guard-registry": stubChecker() });
		expect(newSharedFaultsRow(io(clean))).toEqual(hook("faults", repo, clean));
		commit(
			repo,
			"envelope.json",
			JSON.stringify({ findings: [fault("y.txt")] }),
		);
		expect(newSharedFaultsRow(io(clean)).stdout).toContain("y.txt");
		expect(newSharedFaultsRow(io(clean))).toEqual(hook("faults", repo, clean));
		const broken = checkersEnv({ "guard-registry": brokenChecker() });
		expect(newSharedFaultsRow(io(broken))).toEqual(
			hook("faults", repo, broken),
		);
	});

	it.each(["check-instruction-surface.js", "check-guard-registry.js"])(
		"the %s --touched-by report",
		async (script) => {
			const repo = seeded();
			expect(
				await touchedByRow(script)({ cwd: repo, env: process.env }),
			).toEqual(touchedHook(script, repo, process.env));
		},
		60_000,
	);

	it("the claim release and the commit record", () => {
		const repo = seeded();
		live(sb, "alice");
		const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "alice" };
		const claimed = (way: string) => {
			write(repo, "docs/notes.md", `${way}\n`);
			expect(cli(["claim", "docs/notes.md"], env).status).toBe(0);
			commit(repo, "docs/notes.md", `${way}\n`);
		};
		claimed("step");
		const step = releaseClaimsRow({ cwd: repo, env });
		expect(step.stdout).toContain("Released docs/notes.md");
		claimed("hook");
		expect(step).toEqual(hook("release", repo, env));
		expect(recordCommitRow({ cwd: repo, env })).toEqual(
			hook("record", repo, env),
		);
		const anon = { ...process.env, CLAUDE_CODE_SESSION_ID: "" };
		expect(recordCommitRow({ cwd: repo, env: anon })).toEqual(
			hook("record", repo, anon),
		);
	});

	it("the hook-shim keeper", () => {
		const repo = seeded();
		expect(keepShimsRow({ cwd: repo, env: process.env })).toEqual(
			hook("shims", repo, process.env),
		);
	});

	it("the dropped-review-tier report: dropped, kept, and no amend", () => {
		const repo = seeded();
		const step = () => droppedReviewTier({ cwd: repo, env: process.env });
		const check = () => expect(step()).toEqual(hook("tier", repo, process.env));
		commit(repo, "a.txt", "a\n", "a\n\nreview-tier  : light");
		check();
		git(repo, "commit", "-q", "--amend", "-m", "a again\n\nReview-Tier: light");
		expect(step().stderr).toBe("");
		check();
		git(repo, "commit", "-q", "--amend", "-m", "a, its tier dropped");
		expect(step().stderr).toContain("this amend dropped the Review-Tier: line");
		check();
	});
});

describe("under the redirects git hands a linked worktree's post-commit hook", () => {
	it("captures them from a real hook", () => {
		const { redirects } = linkedCommit();
		expect(redirects.GIT_INDEX_FILE).toBeTruthy();
	});

	it("reads the worktree's commit, as the hook's blocks do", () => {
		const { wt, env } = linkedCommit();
		const io = { cwd: wt, env };
		git(wt, "update-ref", "refs/remotes/origin/main", "HEAD~1");
		const unpushed = unpushedReport(io);
		expect(unpushed.stdout).toContain("1 commit not pushed to origin/main.");
		expect(unpushed).toEqual(hook("unpushed", wt, env));

		const probed = {
			...checkersEnv({ "guard-registry": gitProbeChecker() }),
			...env,
		};
		const faults = newSharedFaultsRow({ cwd: wt, env: probed });
		expect(faults.stdout, "the probe's git read no hook index").toContain(
			"docs/wt.md",
		);
		expect(faults).toEqual(hook("faults", wt, probed));
		expect(keepShimsRow(io)).toEqual(hook("shims", wt, env));
		expect(droppedReviewTier(io)).toEqual(hook("tier", wt, env));
	});

	it("releases the worktree commit's paths and records it at the main tree", () => {
		const { wt, env } = linkedCommit();
		live(sb, "alice");
		const session = { ...env, CLAUDE_CODE_SESSION_ID: "alice" };
		const release = releaseClaimsRow({ cwd: wt, env: session });
		expect(release.stdout).toContain("docs/wt.md");
		expect(release).toEqual(hook("release", wt, session));
		expect(recordCommitRow({ cwd: wt, env: session })).toEqual(
			hook("record", wt, session),
		);
		/* The ledger the Stop hook reads, at the main tree, bills the
		 * worktree's commit — recorded twice, once per way, and once kept. */
		const ledger = cli(["writes", "--committed"], {
			...scrubbedGitEnv(session),
			CLAUDE_PROJECT_DIR: sb.repo,
		});
		expect(ledger.stdout.split("\n")).toContain("docs/wt.md");
	});

	it("leaves the caller's environment and directory as they were", () => {
		const { wt, env } = linkedCommit();
		const before = { cwd: process.cwd(), env: { ...process.env } };
		unpushedReport({ cwd: wt, env });
		releaseClaimsRow({ cwd: wt, env: { ...env, CLAUDE_CODE_SESSION_ID: "x" } });
		expect(process.cwd()).toBe(before.cwd);
		expect(process.env).toEqual(before.env);
	});
});
