const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { gitBinary, gitSpawnOptions } = require("./git.js");
const { substituted } = require("./precommit-gate-verdicts.js");

/**
 * @param {import("node:child_process").SpawnSyncReturns<unknown>} run
 * @param {number} otherwise
 */
const shellStatus = (run, otherwise) =>
	run.status ??
	(run.signal ? 128 + os.constants.signals[run.signal] : otherwise);

const HOOK_SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGTERM"]);

class Interrupted extends Error {
	/** @param {NodeJS.Signals} signal */
	constructor(signal) {
		super(`interrupted by ${signal}`);
		this.status = 128 + os.constants.signals[signal];
	}
}

/**
 * @template {import("node:child_process").SpawnSyncReturns<unknown>} T
 * @param {T} run
 * @returns {T}
 */
function uninterrupted(run) {
	if (run.signal && HOOK_SIGNALS.has(run.signal))
		throw new Interrupted(run.signal);
	return run;
}

/**
 * @param {string} scripts
 * @param {string[]} made
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} host
 * @returns {import("./doc-map-gate.js").DocMapGatePorts}
 */
function realPorts(scripts, made, { cwd, env }) {
	/**
	 * @param {string[]} args
	 * @param {Record<string, string>} [extra]
	 */
	const git = (args, extra) =>
		spawnSync(
			gitBinary(),
			args,
			gitSpawnOptions({
				cwd,
				stdio: /** @type {const} */ (["ignore", "pipe", "ignore"]),
				env: extra ? { ...env, ...extra } : env,
			}),
		);

	/**
	 * @param {string} script
	 * @param {string[]} args
	 * @param {string} out
	 * @param {{ err: boolean, indexFile?: string }} opts
	 */
	const nodeInto = (script, args, out, opts) => {
		const fd = fs.openSync(out, "w");
		try {
			return uninterrupted(
				spawnSync(process.execPath, [path.join(scripts, script), ...args], {
					cwd,
					stdio: ["ignore", fd, opts.err ? fd : "ignore"],
					env: opts.indexFile
						? { ...env, GIT_INDEX_FILE: opts.indexFile }
						: env,
				}),
			);
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
		check: (args, out) =>
			shellStatus(nodeInto("check-doc-map.js", args, out, { err: true }), 1),
		checkJson: (args, out, indexFile) => {
			nodeInto("check-doc-map.js", args, out, { err: false, indexFile });
		},
		read: (out) => fs.readFileSync(out, "utf8"),
		newFaults: (staged, baseline) => {
			const run = uninterrupted(
				spawnSync(
					process.execPath,
					[
						path.join(scripts, "checker-new-faults.js"),
						"doc-map",
						staged,
						baseline,
					],
					{
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
						env,
						encoding: "utf8",
						maxBuffer: CHILD_MAX_BUFFER,
					},
				),
			);
			return {
				status: shellStatus(run, 2),
				stdout: run.stdout ?? "",
				stderr: run.stderr ?? "",
			};
		},
		readHeadMap: () => {
			const run = git(["cat-file", "-p", "HEAD:docs/doc-map.md"]);
			return run.status === 0 ? substituted(run.stdout.toString()) : "";
		},
	};
}

module.exports = { Interrupted, realPorts };
