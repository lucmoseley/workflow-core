// @vitest-environment node
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
	linkedLink = path.join(tmp, "linked-link");
	fs.symlinkSync(linked, linkedLink);
	fs.mkdirSync(path.join(tmp, "nowhere"));
});

afterAll(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

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
			"a CLAUDE_PROJECT_DIR naming a linked worktree",
			() => [linked, linked],
			() => repo,
		],
		[
			"a CLAUDE_PROJECT_DIR naming a linked worktree, with a trailing slash",
			() => [tmp, `${linked}/`],
			() => repo,
		],
		[
			"a CLAUDE_PROJECT_DIR naming a linked worktree through a symlink",
			() => [tmp, linkedLink],
			() => repo,
		],
		[
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

describe("sessionTree() and gr_session_tree agree (#4271)", () => {
	const readTrees = (from: string, cwd: string | undefined) => {
		const opts = { cwd: from, env: envWith(repo), encoding: "utf8" as const };
		const input = cwd === undefined ? {} : { cwd };
		const js = spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(LIB, "host-root.js"))}).sessionTree(${JSON.stringify(input)}) ?? "")`,
			],
			opts,
		);
		const sh = spawnSync(
			"bash",
			[
				"-c",
				`source ${shellQuote(path.join(LIB, "guard-root.sh"))}; gr_session_tree ${shellQuote(cwd ?? "")}`,
			],
			{ ...opts, env: { ...opts.env, PWD: from } },
		);
		for (const r of [js, sh]) expect(r.stderr).toBe("");
		return { js: js.stdout, sh: sh.stdout };
	};

	const cases: [string, () => [string, string | undefined], () => string][] = [
		[
			"a cwd in a linked worktree's subdirectory",
			() => [repo, path.join(linked, "sub")],
			() => linked,
		],
		[
			"a cwd reaching a linked worktree through a symlink",
			() => [repo, path.join(linkedLink, "sub")],
			() => linked,
		],
		["a cwd in the main checkout", () => [linked, repo], () => repo],
		[
			"no cwd, from a linked worktree",
			() => [path.join(linked, "sub"), undefined],
			() => linked,
		],
		[
			"a cwd outside any repository, never the main checkout",
			() => [repo, path.join(tmp, "nowhere")],
			() => "",
		],
	];

	it.each(cases)("%s", (_name, input, expected) => {
		const [from, cwd] = input();
		expect(readTrees(from, cwd)).toEqual({ js: expected(), sh: expected() });
	});
});

describe("worktreeRoot() and gr_worktree_root agree (#5287)", () => {
	let other: string;

	beforeAll(() => {
		other = path.join(tmp, "other");
		fs.mkdirSync(other);
		execFileSync("git", ["init", "-q"], { cwd: other });
	});

	const readRoots = (cwd: string, declared: string | undefined) => {
		const opts = { cwd, env: envWith(declared), encoding: "utf8" as const };
		const js = spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(LIB, "host-root.js"))}).worktreeRoot())`,
			],
			opts,
		);
		const sh = spawnSync(
			"bash",
			[
				"-c",
				`source ${shellQuote(path.join(LIB, "guard-root.sh"))}; gr_worktree_root`,
			],
			{ ...opts, env: { ...opts.env, PWD: cwd } },
		);
		for (const r of [js, sh]) expect(r.stderr).toBe("");
		return { js: js.stdout, sh: sh.stdout };
	};

	const cases: [string, () => [string, string | undefined], () => string][] = [
		[
			"a linked worktree, the main checkout declared",
			() => [path.join(linked, "sub"), repo],
			() => linked,
		],
		[
			"a linked worktree reached through a symlink",
			() => [path.join(linkedLink, "sub"), repo],
			() => linked,
		],
		[
			"a linked worktree, the main checkout declared through a symlink",
			() => [path.join(linked, "sub"), repoLink],
			() => linked,
		],
		[
			"a linked worktree, nothing declared",
			() => [path.join(linked, "sub"), undefined],
			() => linked,
		],
		["the main checkout", () => [path.join(repo, "sub"), repo], () => repo],
		["another repository, never its tree", () => [other, repo], () => repo],
		[
			"outside any repository, the host declared",
			() => [path.join(tmp, "nowhere"), repo],
			() => repo,
		],
		[
			"outside any repository, nothing declared",
			() => [path.join(tmp, "nowhere"), undefined],
			() => path.join(tmp, "nowhere"),
		],
	];

	it.each(cases)("%s", (_name, input, expected) => {
		const [cwd, declared] = input();
		expect(readRoots(cwd, declared)).toEqual({
			js: expected(),
			sh: expected(),
		});
	});
});
