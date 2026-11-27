#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { withoutLateEpipe } = require("./child-failure.js");
const { readFdAll } = require("./read-fd.js");
const { writeFd } = require("./write-fd.js");
const { caught } = require("./caught.js");

const SPAWN_ALL_CONCURRENCY = Math.max(
	1,
	Math.min(4, os.availableParallelism()),
);

/**
 * @typedef {{ file: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv }} Job
 * @typedef {{ status: number | null, signal: string | null, stdout: string, stderr: string, error?: Error }} JobResult
 * @typedef {Omit<JobResult, "error"> & { error?: string }} WireResult
 */

/** @param {Job[]} jobs @returns {JobResult[]} */
function spawnAllSync(jobs) {
	if (jobs.length === 0) return [];
	const r = withoutLateEpipe(
		spawnSync(process.execPath, [__filename], {
			input: JSON.stringify(jobs),
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		}),
	);
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(
			`spawn-all.js exited ${r.status ?? r.signal}: ${r.stderr.trim()}`,
		);
	/** @type {WireResult[]} */
	const results = JSON.parse(r.stdout);
	return results.map(({ error, ...rest }) =>
		error === undefined ? rest : { ...rest, error: new Error(error) },
	);
}

/**
 * @param {Job} job
 * @returns {Promise<WireResult>}
 */
function runJob(job) {
	return new Promise((resolve) => {
		const got = {
			stdout: "",
			stderr: "",
			/** @type {string | undefined} */ error: undefined,
			started: true,
		};
		const child = spawn(job.file, job.args, {
			cwd: job.cwd,
			env: job.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		/** @param {"stdout" | "stderr"} name */
		const collect = (name) => (/** @type {string} */ chunk) => {
			if (got[name].length + chunk.length > CHILD_MAX_BUFFER) {
				got.error = "output past CHILD_MAX_BUFFER";
				child.kill();
				return;
			}
			got[name] += chunk;
		};
		child.stdout.setEncoding("utf8").on("data", collect("stdout"));
		child.stderr.setEncoding("utf8").on("data", collect("stderr"));
		child.on("error", (e) => {
			got.error = e.message;
			got.started = false;
		});
		child.on("close", (status, signal) => {
			resolve({
				status: got.started ? status : null,
				signal,
				stdout: got.stdout,
				stderr: got.stderr,
				...(got.error !== undefined && { error: got.error }),
			});
		});
	});
}

/**
 * @param {Job[]} jobs
 */
async function runAll(jobs) {
	/** @type {WireResult[]} */
	const results = new Array(jobs.length);
	const queue = jobs.entries();
	const lane = async () => {
		for (const [i, job] of queue) results[i] = await runJob(job);
	};
	await Promise.all(
		Array.from({ length: Math.min(SPAWN_ALL_CONCURRENCY, jobs.length) }, lane),
	);
	return results;
}

async function main() {
	const jobs = JSON.parse(readFdAll(0).toString("utf8"));
	writeFd(1, JSON.stringify(await runAll(jobs)));
}

if (require.main === module)
	main().catch((e) => {
		writeFd(
			2,
			`spawn-all.js: ${e instanceof Error ? e.stack : caught(e).message}\n`,
		);
		process.exitCode = 1;
	});

module.exports = { spawnAllSync };
