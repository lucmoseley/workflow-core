/*
 * grouped-child.js — a child in a process group of its own, so a kill reaches
 * what it starts as well (workflow-core#2677). `execFile`'s timeout kills only the process
 * it spawned, and its `detached` is dropped.
 *
 * A group still live when this process exits is killed with it. RESIDUAL: a
 * SIGKILL to this process cannot be caught, and leaves the group running.
 */

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { writeFd } = require("./write-fd.js");

/* `docker stop`'s default on Linux, the one published figure for this wait; no
 * run here measured what a gate's cleanup needs. */
const SYNC_GRACE_MS = 10_000;
/* Untraced: short against a grace, long enough not to spin. */
const GRACE_POLL_MS = 100;
/* A guess, as process-fixture.ts's: the kernel's reaping runs on its own clock. */
const KILL_SETTLE_MS = 5000;
const SUPERVISOR = path.join(__dirname, "grouped-child-supervisor.js");
const NO_END = {
	code: null,
	signal: null,
	killedFor: null,
	killedCode: null,
	unkilled: null,
	spawnCode: null,
};

/** @type {Set<number>} */
const live = new Set();
process.on("exit", () => {
	for (const pgid of live) killGroup(pgid, "SIGKILL");
});

/**
 * Signal a whole process group. A group already gone is no failure: its
 * close is on its way (workflow-core#2306).
 * @param {number} pgid
 * @param {NodeJS.Signals} signal
 * @returns {string|null} why the group is still running, else null
 */
function killGroup(pgid, signal) {
	try {
		process.kill(-pgid, signal);
		return null;
	} catch (e) {
		return caught(e).code === "ESRCH" ? null : caught(e).message;
	}
}

/** @param {number} pgid */
function isGroupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return caught(e).code === "EPERM";
	}
}

/**
 * @param {number} pgid
 * @param {number} ms
 * @returns {Promise<boolean>} whether the group went within `ms`
 */
async function groupGoneWithin(pgid, ms) {
	for (const end = performance.now() + ms; performance.now() < end; ) {
		if (!isGroupAlive(pgid)) return true;
		await new Promise((r) => setTimeout(r, GRACE_POLL_MS));
	}
	return !isGroupAlive(pgid);
}

/**
 * SIGTERM to a group, then SIGKILL to what outlives `graceMs`, returning once
 * the group has gone.
 * @param {number} pgid
 * @param {number} graceMs
 * @returns {Promise<{killed: boolean, unkilled: string|null}>} `killed` where
 *   the grace ran out; `unkilled` why the group is still running, else null
 */
async function endGroup(pgid, graceMs) {
	const unsignalled = killGroup(pgid, "SIGTERM");
	if (unsignalled) return { killed: false, unkilled: unsignalled };
	if (await groupGoneWithin(pgid, graceMs))
		return { killed: false, unkilled: null };
	const unkilled = killGroup(pgid, "SIGKILL");
	if (unkilled) return { killed: true, unkilled };
	return {
		killed: true,
		unkilled: (await groupGoneWithin(pgid, KILL_SETTLE_MS))
			? null
			: `it still answers ${KILL_SETTLE_MS / 1000} s after SIGKILL`,
	};
}

/**
 * Run `file` with `args` in a group of its own, collecting its output. Past
 * `timeoutMs`, or once stdout passes `maxBuffer` bytes, the run ends, naming
 * why in `killedFor` and `killedCode`, and `unkilled` if the group would not
 * take the signal. With no `graceMs` the group gets SIGKILL and the run settles
 * at once, without waiting on pipes a descendant that left the group may hold
 * open. With one, the group gets SIGTERM with its pipes still drained, and
 * SIGKILL for whatever outlives the grace. `stdout` and `stderr` stop at the
 * kill. `spawnCode` names why `file` would not start (ENOENT, EACCES), else
 * null.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number,
 *   maxBuffer: number, graceMs?: number, input?: string}} opts
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null,
 *   stdout: string, stderr: string, killedFor: string|null,
 *   killedCode: "ETIMEDOUT"|"ENOBUFS"|null, unkilled: string|null,
 *   spawnCode: string|null}>}
 */
function runGrouped(
	file,
	args,
	{ cwd, env, timeoutMs, maxBuffer, graceMs = 0, input },
) {
	const child = spawn(file, args, {
		cwd,
		env,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		detached: true,
	});
	if (child.stdin) {
		child.stdin.on("error", (e) => {
			/* A child that exits with its input unread is no failure of this run
			 * (workflow-core#3923). */
			if (caught(e).code !== "EPIPE") throw e;
		});
		child.stdin.end(input);
	}
	const pgid = /** @type {number} */ (child.pid);
	const stdout = /** @type {import("node:stream").Readable} */ (child.stdout);
	const stderr = /** @type {import("node:stream").Readable} */ (child.stderr);
	if (child.pid) live.add(pgid);
	/** @type {Buffer[]} */
	const out = [];
	let outBytes = 0;
	/** @type {Buffer[]} */
	const err = [];
	let errBytes = 0;
	return new Promise((resolve) => {
		let settled = false;
		let killing = false;
		const settle = (
			/** @type {Omit<Awaited<ReturnType<typeof runGrouped>>, "stdout" | "stderr">} */ r,
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(ceiling);
			resolve({
				...r,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		};
		const kill = (
			/** @type {string} */ why,
			/** @type {"ETIMEDOUT"|"ENOBUFS"} */ killedCode,
		) => {
			if (killing) return;
			killing = true;
			clearTimeout(ceiling);
			const finish = (/** @type {string|null} */ unkilled) => {
				stdout.destroy();
				stderr.destroy();
				settle({
					...NO_END,
					killedFor: unkilled ? `${why}, unkilled: ${unkilled}` : why,
					killedCode,
					unkilled,
				});
			};
			if (graceMs)
				endGroup(pgid, graceMs).then(
					(r) => finish(r.unkilled),
					(e) => finish(caught(e).message),
				);
			else finish(killGroup(pgid, "SIGKILL"));
		};
		stdout.on("data", (/** @type {Buffer} */ chunk) => {
			if (killing) return;
			out.push(chunk);
			outBytes += chunk.length;
			if (outBytes > maxBuffer)
				kill(`stdout past ${maxBuffer} bytes`, "ENOBUFS");
		});
		/* Only stderr's tail is ever read, so past the cap its oldest chunks go. */
		stderr.on("data", (/** @type {Buffer} */ chunk) => {
			if (killing) return;
			err.push(chunk);
			errBytes += chunk.length;
			while (errBytes > maxBuffer && err.length > 1)
				errBytes -= /** @type {Buffer} */ (err.shift()).length;
		});
		const ceiling = setTimeout(
			() => kill(`timed out after ${timeoutMs / 1000} s`, "ETIMEDOUT"),
			timeoutMs,
		);
		child.on("error", (e) => {
			live.delete(pgid);
			settle({
				...NO_END,
				killedFor: e.message,
				spawnCode: caught(e).code ?? null,
			});
		});
		child.on("close", (code, signal) => {
			live.delete(pgid);
			if (killing) return;
			settle({ ...NO_END, code, signal });
		});
	});
}

/**
 * execFileSync in a group of its own. Past `opts.timeout`, or `opts.maxBuffer`
 * of stdout, the whole group gets SIGTERM, and whatever outlives `opts.graceMs`
 * (default SYNC_GRACE_MS) SIGKILL, before this throws. Past the cap stderr keeps
 * only its tail, so a flood of it runs on to the timeout. It returns stdout and
 * throws as execFileSync does, `code`, `status` and `stderr` on the error. A run
 * that ends by itself leaves its background children alone.
 *
 * A supervisor process does the waiting, as the group's pipes must stay open
 * through the grace (workflow-core#3923).
 *
 * RESIDUAL: a SIGKILL to the supervisor leaves the group running with no
 * timeout. A descendant in a group of its own dies only if its wrapper kills
 * that group within the grace.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, input?: string,
 *   timeout: number, maxBuffer?: number, graceMs?: number}} opts
 * @returns {string}
 */
function execGroupedSync(
	file,
	args,
	{
		cwd,
		env,
		input,
		timeout,
		maxBuffer = CHILD_MAX_BUFFER,
		graceMs = SYNC_GRACE_MS,
	},
) {
	const supervised = spawnSync(process.execPath, [SUPERVISOR], {
		encoding: "utf8",
		input: JSON.stringify({
			file,
			args,
			opts: { cwd, env, input, timeoutMs: timeout, maxBuffer, graceMs },
		}),
		/* Already capped by `maxBuffer` in the supervisor, stdout and stderr each. */
		maxBuffer: Number.POSITIVE_INFINITY,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (supervised.error) throw supervised.error;
	if (supervised.status !== 0)
		throw new Error(
			`${file}'s supervisor exited ${supervised.status ?? supervised.signal}: ${supervised.stderr}`,
		);
	const run = /** @type {Awaited<ReturnType<typeof runGrouped>>} */ (
		JSON.parse(supervised.stdout)
	);
	if (run.unkilled) writeFd(2, `${file}'s group still runs: ${run.unkilled}\n`);
	const code = run.killedCode ?? run.spawnCode;
	if (!code && run.code === 0) return run.stdout;
	throw Object.assign(
		new Error(
			code
				? `${file}: ${run.killedFor}`
				: `${file} exited ${run.code ?? run.signal}: ${run.stderr}`,
		),
		{
			code,
			status: run.code,
			signal: run.signal,
			stdout: run.stdout,
			stderr: run.stderr,
		},
	);
}

module.exports = {
	endGroup,
	execGroupedSync,
	isGroupAlive,
	killGroup,
	runGrouped,
};
