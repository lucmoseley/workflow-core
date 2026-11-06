// @vitest-environment node
/*
 * The seam's three halves answer byte for byte alike (#14).
 *
 * `lib/arbiter-core.js`'s `stateDir()` slugs `hostRoot()` and `lib/guard-log.sh`
 * slugs `gr_root`, so a divergence relocates live state silently. The halves
 * are spawned rather than in-process because the shell and Python halves have
 * no in-process seam, and the JS half run in-process would share this worker's
 * cwd and memo.
 *
 * The `.` case runs from a working directory reached through a symlink: from a
 * physical one, the dereference it tests would be the identity.
 *
 * Loosen a case and a divergence lands unseen: the guards' fail-open records
 * go to a project directory check-guard-errors.js never reads, so every
 * guard that failed open looks as if it never had. This test, red in CI, is
 * what catches it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shellQuote } from "./lib/sh-quote.js";

const LIB = path.resolve(__dirname, "lib");

let tmp: string;
let repo: string;
let repoLink: string;
let linked: string;
let linkedLink: string;
let gitFiled: string;

beforeAll(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-seam-")));
	repo = path.join(tmp, "repo");
	fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
	fs.writeFileSync(path.join(repo, "file.txt"), "x\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"x",
		],
		{ cwd: repo },
	);
	linked = path.join(tmp, "linked");
	execFileSync("git", ["worktree", "add", "-q", linked], { cwd: repo });
	fs.mkdirSync(path.join(linked, "sub"));
	repoLink = path.join(tmp, "repo-link");
	fs.symlinkSync(repo, repoLink);
	fs.mkdirSync(path.join(tmp, "nowhere"));
	linkedLink = path.join(tmp, "linked-link");
	fs.symlinkSync(linked, linkedLink);
	/* A submodule's checkout: a git file whose git dir has no `commondir`. */
	gitFiled = path.join(tmp, "gitfiled");
	fs.mkdirSync(path.join(tmp, "gitfiled-git"), { recursive: true });
	fs.mkdirSync(gitFiled);
	fs.writeFileSync(path.join(gitFiled, ".git"), "gitdir: ../gitfiled-git\n");
});

afterAll(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** `undefined` unsets CLAUDE_PROJECT_DIR; a string sets it, the empty one included. */
const envWith = (declared: string | undefined): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_CEILING_DIRECTORIES: tmp,
	};
	delete env.CLAUDE_PROJECT_DIR;
	delete env.WFC_REPO_ROOT;
	if (declared !== undefined) env.CLAUDE_PROJECT_DIR = declared;
	return env;
};

const readAnswers = (cwd: string, declared: string | undefined) => {
	const opts = { cwd, env: envWith(declared), encoding: "utf8" as const };
	const js = spawnSync(
		process.execPath,
		[
			"-e",
			`process.stdout.write(require(${JSON.stringify(path.join(LIB, "host-root.js"))}).hostRoot())`,
		],
		opts,
	);
	const sh = spawnSync(
		"bash",
		["-c", `source ${shellQuote(path.join(LIB, "guard-root.sh"))}; gr_root`],
		/* bash's $PWD is the logical path it inherits, so hand it the spelling. */
		{ ...opts, env: { ...opts.env, PWD: cwd } },
	);
	const py = spawnSync(
		"python3",
		[
			"-c",
			"import sys; sys.path.insert(0, sys.argv[1]); from host_root import host_root; sys.stdout.write(host_root())",
			LIB,
		],
		opts,
	);
	for (const r of [js, sh, py]) expect(r.stderr).toBe("");
	return { js: js.stdout, sh: sh.stdout, py: py.stdout };
};

describe("hostRoot(), gr_root and host_root() agree", () => {
	const cases: [string, () => [string, string | undefined], () => string][] = [
		["a symlinked CLAUDE_PROJECT_DIR", () => [tmp, repoLink], () => repo],
		["a trailing slash", () => [tmp, `${repo}/`], () => repo],
		[
			/* Only here does the strip itself act: an existing path loses its
			 * slash to the dereference anyway. */
			"a trailing slash on a path that does not exist",
			() => [tmp, `${path.join(tmp, "absent")}/`],
			() => path.join(tmp, "absent"),
		],
		[
			"a path that does not exist",
			() => [tmp, path.join(tmp, "absent")],
			() => path.join(tmp, "absent"),
		],
		[
			"`.`, from a working directory reached through a symlink",
			() => [path.join(repoLink, "sub"), "."],
			() => path.join(repo, "sub"),
		],
		["`/`", () => [tmp, "/"], () => "/"],
		[
			"an empty CLAUDE_PROJECT_DIR, which falls to the git limb",
			() => [path.join(repo, "sub"), ""],
			() => repo,
		],
		[
			"a file rather than a directory",
			() => [tmp, path.join(repo, "file.txt")],
			() => path.join(repo, "file.txt"),
		],
		[
			/* The harness hands a session launched in a worktree that worktree
			 * (#4487); the shared stores are keyed on its main checkout. */
			"a CLAUDE_PROJECT_DIR naming a linked worktree",
			() => [linked, linked],
			() => repo,
		],
		[
			"a CLAUDE_PROJECT_DIR naming a linked worktree, from elsewhere",
			() => [tmp, `${linked}/`],
			() => repo,
		],
		[
			"a symlinked CLAUDE_PROJECT_DIR naming a linked worktree",
			() => [tmp, linkedLink],
			() => repo,
		],
		[
			"a CLAUDE_PROJECT_DIR whose git file names no common dir",
			() => [tmp, gitFiled],
			() => gitFiled,
		],
		[
			/* The Bash tool sets no CLAUDE_PROJECT_DIR (#4482). */
			"no CLAUDE_PROJECT_DIR, from a linked worktree",
			() => [linked, undefined],
			() => repo,
		],
		[
			"no CLAUDE_PROJECT_DIR, from a linked worktree's subdirectory",
			() => [path.join(linked, "sub"), undefined],
			() => repo,
		],
		[
			"no CLAUDE_PROJECT_DIR, from the main checkout",
			() => [path.join(repo, "sub"), undefined],
			() => repo,
		],
		[
			"no CLAUDE_PROJECT_DIR and no repository",
			() => [path.join(tmp, "nowhere"), undefined],
			() => path.join(tmp, "nowhere"),
		],
	];

	it.each(cases)("%s", (_name, input, expected) => {
		const [cwd, declared] = input();
		const got = readAnswers(cwd, declared);
		expect(got).toEqual({ js: expected(), sh: expected(), py: expected() });
	});
});

/* The split #4487 measured: a hook handed the worktree and a script run from
 * the Bash tool, with no CLAUDE_PROJECT_DIR, filed claims in two stores. */
it("a hook handed a linked worktree and a Bash-route script read one claim store", () => {
	const stateDir = (declared: string | undefined) =>
		spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(LIB, "arbiter-core.js"))}).stateDir())`,
			],
			{
				cwd: linked,
				env: { ...envWith(declared), CLAUDE_CONFIG_DIR: path.join(tmp, "cfg") },
				encoding: "utf8",
			},
		).stdout;
	const hook = stateDir(linked);
	expect(hook).toContain(path.join(tmp, "cfg"));
	expect(hook).toBe(stateDir(undefined));
	expect(hook).toBe(stateDir(repo));
});
