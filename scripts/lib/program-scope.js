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
 * @param {ProcessIo} io
 * @param {() => number} body
 * @returns {ProgramResult}
 */
const runProgram = (io, body) => inProgramScope(io, () => captured(body));

module.exports = { inProgramScope, runProgram };
