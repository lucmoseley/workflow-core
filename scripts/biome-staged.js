#!/usr/bin/env node
// cli-args-exempt: #5540

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { extractTree, git, indexTree } = require("./lib/check");
const { listTree } = require("./lib/git-objects");
const { caught } = require("./lib/caught.js");

/** @returns {string[]} */
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

const MOUNT_FAILED = 125;
const NOT_STARTED = new Set([126, 127]);

/**
 * @param {string} tree
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} check
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

/** @returns {number} */
function main() {
	const paths = readStagedPaths();
	if (paths.length === 0) return 0;

	const work = fs.mkdtempSync(path.join(os.tmpdir(), "biome-staged-"));
	try {
		const tree = path.join(work, "tree");
		fs.mkdirSync(tree);
		const sha = indexTree(path.join(work, "index"));
		extractTree(sha, tree);
		const inTree = new Set(listTree(sha, []).map((e) => e.path));
		const present = paths.filter((p) => inTree.has(p));
		if (present.length === 0) return 0;

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
