#!/usr/bin/env node
/*
 * biome-staged.js — `biome check` over this commit's added and modified
 * paths, reading the bytes the commit carries (#2429).
 *
 * Usage:
 *   node scripts/biome-staged.js [<biome check flag>…]
 *
 * `biome check --staged` takes its path list from the index but reads each
 * file from disk, so a commit carrying part of a file — a
 * `commit-paths.js --patch` commit (#801), or a file edited after staging —
 * was judged on the worktree's bytes, uncommitted hunks
 * included. Here the index, the temporary one a pathspec commit builds
 * (GIT_INDEX_FILE) included, is extracted whole into a temp directory and
 * Biome runs there: whole, as its project rules (noImportCycles,
 * noFloatingPromises) read the files a staged one imports.
 *
 * The rules that read node_modules — noUntrustedLicenses, and
 * noFloatingPromises, noMisusedPromises and noDeprecatedImports on a
 * third-party import — see only a dependency whose real path lies inside
 * Biome's project (biomejs/biome#12934), so neither the bare tree nor a
 * symlink into it raises them (#4085). So the caller's node_modules, a
 * worktree's out-of-tree dependency store included, is bind-mounted onto the
 * tree's inside a private mount namespace (`unshare -rm`) (#4639). Off Linux, or where the mount fails, those rules go quiet here
 * and `biome ci .` in CI raises them.
 *
 * Not a check-*.js: Biome's own report is the verdict, any failing exit
 * reading as 1. `biome` is found on PATH, which `npm run` and the hook both
 * point at node_modules/.bin; a relative entry, as husky writes, is resolved
 * against the caller's directory, since Biome runs from the temp tree
 * (#4079). A commit adding, modifying or retyping no path runs nothing and
 * exits 0. Exits 2, BROKEN's code, where git cannot
 * extract the index or biome will not start.
 *
 * cli-args-exempt: a pass-through wrapper; its argv is `biome check`'s.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { extractTree, git, indexTree } = require("./lib/check");
const { listTree } = require("./lib/git-objects");
const { caught } = require("./lib/caught.js");

/**
 * The paths this commit adds, modifies or retypes. --no-renames, so a
 * rename's new path reads as an add. Node's default 1 MB buffer holds some
 * 20,000 paths.
 * @returns {string[]}
 */
function readStagedPaths() {
	return git(
		[
			"diff",
			"--cached",
			"--name-only",
			"--no-renames",
			"--diff-filter=AMT",
			"-z",
		],
		"listing the staged paths",
	)
		.split("\0")
		.filter(Boolean);
}

/* The launch's own exits, apart from Biome's 0 and 1: the mount failing,
 * and sh's "cannot execute" and "not found". */
const MOUNT_FAILED = 125;
const NOT_STARTED = new Set([126, 127]);

/**
 * How to run `biome check`: mounted, as the header says, or plain Biome
 * where the repo has no node_modules, the tree carries its own, or the host
 * cannot mount: off Linux, silently; on Linux, saying so.
 * @param {string} tree
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} check `biome check`'s arguments
 * @returns {{ command: string, args: string[] }}
 */
function buildBiomeLaunch(tree, env, check) {
	const plain = { command: "biome", args: check };
	if (process.platform !== "linux") return plain;
	const target = path.join(tree, "node_modules");
	if (fs.existsSync(target)) return plain;
	let source;
	try {
		source = fs.realpathSync("node_modules");
	} catch (e) {
		if (caught(e).code === "ENOENT") return plain;
		throw e;
	}
	fs.mkdirSync(target);
	const mount = [
		"-rm",
		"sh",
		"-c",
		`mount --bind "$1" node_modules || exit ${MOUNT_FAILED}; shift; exec "$@"`,
		"sh",
		source,
	];
	/* `unshare` refused exits 1, as Biome's findings do, so the host is
	 * probed in a namespace that dies with the probe. */
	const probe = spawnSync("unshare", [...mount, "true"], {
		cwd: tree,
		env,
		encoding: "utf8",
	});
	if (probe.status === 0)
		return { command: "unshare", args: [...mount, "biome", ...check] };
	fs.rmdirSync(target);
	process.stderr.write(
		`biome-staged: could not mount node_modules into the extracted tree (${(probe.error?.message ?? probe.stderr).trim()}), so noUntrustedLicenses and the type rules on third-party imports are off for this commit\n`,
	);
	return plain;
}

/** @returns {number} the exit code */
function main() {
	const paths = readStagedPaths();
	if (paths.length === 0) return 0;

	const work = fs.mkdtempSync(path.join(os.tmpdir(), "biome-staged-"));
	try {
		const tree = path.join(work, "tree");
		fs.mkdirSync(tree);
		const sha = indexTree(path.join(work, "index"));
		extractTree(sha, tree);
		/* An intent-to-add entry is listed as added, but write-tree leaves it
		 * out of the tree, as the commit does. Judged on the tree, not the
		 * disk, so a path the extraction failed to write reaches Biome and
		 * fails there. */
		const inTree = new Set(listTree(sha, []).map((e) => e.path));
		const present = paths.filter((p) => inTree.has(p));
		if (present.length === 0) return 0;

		/* A git repo of its own, as biome.json's vcs settings expect: outside
		 * one, Biome refuses an empty or absent .gitignore. Off the hook's
		 * GIT_* variables, which name the real repo and its index. */
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
		);
		if (process.env.PATH !== undefined)
			env.PATH = process.env.PATH.split(path.delimiter)
				.map((dir) => path.resolve(dir))
				.join(path.delimiter);
		git(["init", "-q", tree], "making the extracted tree a repo", env);

		const { command, args } = buildBiomeLaunch(tree, env, [
			"check",
			...process.argv.slice(2),
			...present,
		]);
		const r = spawnSync(command, args, { cwd: tree, env, stdio: "inherit" });
		if (r.error) throw new Error(`biome would not start: ${r.error.message}`);
		if (r.status === MOUNT_FAILED)
			throw new Error("could not mount node_modules into the extracted tree");
		if (NOT_STARTED.has(r.status ?? 0))
			throw new Error(`biome would not start: exit ${r.status}`);
		return r.status === 0 ? 0 : 1;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

try {
	process.exitCode = main();
} catch (e) {
	process.stderr.write(`biome-staged: ${caught(e).message}\n`);
	process.exitCode = 2;
}
