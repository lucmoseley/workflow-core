/*
 * program-scope.js — a CLI program's body run inside this process as its own
 * process would run it (#5208): under the caller's working directory and
 * environment, its fd 1 and fd 2 writes captured rather than printed.
 *
 * WHY: the post-commit dispatcher runs each of the hook's Node programs as a
 * row in one process, and a row hands back `{ exit, stdout, stderr }`
 * (lib/precommit-dispatch.js's RowResult). These programs were written for a
 * process of their own: they read `process.env` and `process.cwd()`, their
 * git children inherit both, and they print through lib/write-fd.js.
 *
 * WHAT IS SWAPPED, AND PUT BACK IN A `finally`:
 *
 *   env     replaced in place, lib/process-globals.js's replaceEnv.
 *   cwd     process.chdir to the caller's directory.
 *   output  fd 1 and fd 2, by both routes, taken by lib/process-globals.js's
 *           takeWrites. Every other fd writes as it would.
 *
 * NOT REPRODUCED: a `process.exit` inside the body ends this process, and a
 * grandchild spawned with `stdio: "inherit"` writes to the real fd.
 *
 * One body at a time: the swap is global to the process, so two overlapping
 * bodies would restore each other's state.
 */

const { replaceEnv, takeWrites } = require("./process-globals.js");

/**
 * @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} ProcessIo
 * @typedef {{ exit: number, stdout: string, stderr: string }} ProgramResult
 */

/**
 * @param {ProcessIo} io
 */
function enter({ cwd, env }) {
	const saved = { cwd: process.cwd(), env: { ...process.env } };
	replaceEnv(env);
	try {
		process.chdir(cwd);
	} catch (e) {
		replaceEnv(saved.env);
		throw e;
	}
	return () => {
		replaceEnv(saved.env);
		process.chdir(saved.cwd);
	};
}

/**
 * Run `body` under `io`'s working directory and environment, restored after
 * it returns, throws, or (for a promise) settles.
 * @template T
 * @param {ProcessIo} io
 * @param {() => T} body
 * @returns {T}
 */
function inProgramScope(io, body) {
	const restore = enter(io);
	let result;
	try {
		result = body();
	} catch (e) {
		restore();
		throw e;
	}
	if (result instanceof Promise)
		return /** @type {T} */ (result.finally(restore));
	restore();
	return result;
}

/**
 * @param {() => number} body
 * @returns {ProgramResult}
 */
function captured(body) {
	/** @type {Record<1 | 2, string>} */
	const taken = { 1: "", 2: "" };
	const restore = takeWrites((fd, text) => {
		taken[fd] += text;
	});
	let exit;
	try {
		exit = body();
	} finally {
		restore();
	}
	return { exit, stdout: taken[1], stderr: taken[2] };
}

/**
 * A program's run in this process: `body` returns its exit code, and what it
 * writes to fd 1 and fd 2 comes back as stdout and stderr.
 * @param {ProcessIo} io
 * @param {() => number} body
 * @returns {ProgramResult}
 */
const runProgram = (io, body) => inProgramScope(io, () => captured(body));

module.exports = { inProgramScope, runProgram };
