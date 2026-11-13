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
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { gitBinary, gitSpawnOptions } = require("./git.js");
const { substituted } = require("./precommit-gate-verdicts.js");

/**
 * git, unmemoised: the gate swaps GIT_INDEX_FILE between reads, which
 * lib/git.js's read memo does not key on.
 * @param {string[]} args
 * @param {Record<string, string>} [env] added to the hook's own
 */
const git = (args, env) =>
	spawnSync(
		gitBinary(),
		args,
		gitSpawnOptions({
			stdio: /** @type {const} */ (["ignore", "pipe", "ignore"]),
			env: env ? { ...process.env, ...env } : process.env,
		}),
	);

/**
 * A finished child's exit as sh's `$?` reads it: 128 + the signal's number
 * where a signal ended it, so an OOM kill reads 137, never a clean 1.
 * @param {import("node:child_process").SpawnSyncReturns<unknown>} run
 * @param {number} otherwise where neither a status nor a signal is known
 */
const shellStatus = (run, otherwise) =>
	run.status ??
	(run.signal ? 128 + os.constants.signals[run.signal] : otherwise);

/** The signals sh's trap caught. */
const HOOK_SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGTERM"]);

/**
 * Thrown where a hook signal ended a child. A signal sent to the hook's process
 * group reaches the gate while spawnSync blocks, and Node drops it there, so
 * the child's death is the only sign of it.
 */
class Interrupted extends Error {
	/** @param {NodeJS.Signals} signal */
	constructor(signal) {
		super(`interrupted by ${signal}`);
		this.status = 128 + os.constants.signals[signal];
	}
}

/**
 * `run`, unless a hook signal ended it.
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
 * @param {string[]} made accumulator: each scratch directory made, for the
 *   caller to remove
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
			return uninterrupted(
				spawnSync(process.execPath, [path.join(scripts, script), ...args], {
					stdio: ["ignore", fd, opts.err ? fd : "ignore"],
					env: opts.indexFile
						? { ...process.env, GIT_INDEX_FILE: opts.indexFile }
						: process.env,
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
						stdio: ["ignore", "pipe", "pipe"],
						encoding: "utf8",
						maxBuffer: CHILD_MAX_BUFFER,
					},
				),
			);
			// No status is a comparison that could not answer, which the verdict
			// reads as such whatever the code.
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
