/*
 * doc-map-gate-ports.js — the production adapters of lib/doc-map-gate.js's
 * ports (#5155): git in the hook's cwd and index, and the checker scripts run
 * under this node. doc-map-gate-fake.ts is the test fake, and
 * doc-map-gate.contract.test.ts holds the two to one verdict (base §G7).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { substituted } = require("./precommit-gate-verdicts.js");

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env] added to the hook's own
 */
const git = (args, env) =>
	spawnSync("git", args, {
		stdio: ["ignore", "pipe", "ignore"],
		env: env ? { ...process.env, ...env } : process.env,
		maxBuffer: 256 * 1024 * 1024,
	});

/**
 * The ports, running scripts out of `scripts` and recording each scratch
 * directory in `made` for the caller to remove.
 * @param {string} scripts
 * @param {string[]} made
 * @returns {import("./doc-map-gate.js").DocMapGatePorts}
 */
function realPorts(scripts, made) {
	/**
	 * `script` under this node, its stdout (and its stderr where `err`) into `out`.
	 * @param {string} script
	 * @param {string[]} args
	 * @param {string} out
	 * @param {{ err: boolean, indexFile?: string }} opts
	 */
	const nodeInto = (script, args, out, opts) => {
		const fd = fs.openSync(out, "w");
		try {
			return spawnSync(
				process.execPath,
				[path.join(scripts, script), ...args],
				{
					stdio: ["ignore", fd, opts.err ? fd : "ignore"],
					env: opts.indexFile
						? { ...process.env, GIT_INDEX_FILE: opts.indexFile }
						: process.env,
				},
			).status;
		} finally {
			fs.closeSync(fd);
		}
	};

	return {
		tmpdir: () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-gate-"));
			made.push(dir);
			return dir;
		},
		extract: (prefix, indexFile) =>
			git(
				["checkout-index", "-a", `--prefix=${prefix}`],
				indexFile ? { GIT_INDEX_FILE: indexFile } : undefined,
			).status === 0,
		readHead: (indexFile) =>
			git(["read-tree", "HEAD"], { GIT_INDEX_FILE: indexFile }).status === 0,
		isFile: (file) =>
			fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false,
		mapDiffStatus: () =>
			git(["diff", "--quiet", "HEAD", "--", "docs/doc-map.md"]).status,
		stageOut: (rel, dest) => {
			const run = git(["cat-file", "-p", `:${rel}`]);
			if (run.status !== 0) return false;
			fs.writeFileSync(dest, run.stdout);
			return true;
		},
		deletedByCommit: (rel) => {
			const run = git([
				"--literal-pathspecs",
				"diff",
				"--cached",
				"--diff-filter=D",
				"--name-only",
				"-z",
				"--",
				rel,
			]);
			return run.status === 0
				? { ok: true, deleted: run.stdout.toString().replace(/\0/g, "") !== "" }
				: { ok: false, deleted: false };
		},
		// A checker killed by a signal has no status; it failed.
		check: (args, out) =>
			nodeInto("check-doc-map.js", args, out, { err: true }) ?? 1,
		checkJson: (args, out, indexFile) => {
			nodeInto("check-doc-map.js", args, out, { err: false, indexFile });
		},
		read: (out) => fs.readFileSync(out, "utf8"),
		newFaults: (staged, baseline) => {
			const run = spawnSync(
				process.execPath,
				[
					path.join(scripts, "checker-new-faults.js"),
					"doc-map",
					staged,
					baseline,
				],
				{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
			);
			// No status is a comparison that could not answer: exit 2's verdict.
			return {
				status: run.status ?? 2,
				stdout: run.stdout ?? "",
				stderr: run.stderr ?? "",
			};
		},
		headMap: () => {
			const run = git(["cat-file", "-p", "HEAD:docs/doc-map.md"]);
			return run.status === 0 ? substituted(run.stdout.toString()) : "";
		},
	};
}

module.exports = { realPorts };
