// @vitest-environment node
/*
 * The equivalence contract for `.husky/post-commit`'s programs (#5208, spec
 * #5207 seam 3): each program the hook's steps run, run in-process through
 * its PROGRAM export or, for the two `--touched-by` checkers, lib/check.js's
 * checkInProcess(), gives the same exit code, stdout and stderr as the same
 * program spawned as `node <script> <args>` over the same fixture.
 *
 * Breaking it costs the licence for the post-commit dispatcher's rows: a
 * program whose in-process run drifts from its spawned one says, or keeps
 * silent, differently after a commit.
 *
 * spawn-kept: the `spawnedNode` helper is the real process every in-process
 * run is held to.
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
import { scrubbedGitEnv } from "./hook-entry.js";

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

/** A PROGRAM export's run, as the dispatcher makes it. */
const program = (script: string, args: string[], cwd: string, env: Env) =>
	load(path.join(SCRIPTS, script)).PROGRAM({ cwd, env, args }) as Run;

const bothWays = (script: string, args: string[], cwd: string, env: Env) => ({
	inProcess: program(script, args, cwd, env),
	spawned: spawnedNode(path.join(SCRIPTS, script), args, cwd, env),
});

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
