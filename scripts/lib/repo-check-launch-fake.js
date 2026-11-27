// workflow-core#5734
const fs = require("node:fs");
const { sleepSync } = require("./sleep-sync.js");

/**
 * @typedef {{ id: string, launches: string, envelope?: object | null,
 *   onRescan?: object, exit?: number, sleepMs?: number, stderr?: string }} StubSpec
 * @typedef {{ status: number, stdout: string, stderr: string } | { timedOut: true }} StubAnswer
 */

/**
 * @param {StubSpec} spec
 * @param {string[]} argv
 * @param {number} [timeoutMs]
 * @returns {StubAnswer}
 */
function answer(spec, argv, timeoutMs) {
	fs.appendFileSync(spec.launches, `${JSON.stringify([spec.id, ...argv])}\n`);
	if (spec.sleepMs && timeoutMs !== undefined && spec.sleepMs >= timeoutMs) {
		sleepSync(timeoutMs);
		return { timedOut: true };
	}
	if (spec.sleepMs) sleepSync(spec.sleepMs);
	const envelope =
		spec.onRescan && argv.includes("--rescan") ? spec.onRescan : spec.envelope;
	return {
		status: spec.exit ?? 0,
		stdout: envelope && argv.includes("--json") ? JSON.stringify(envelope) : "",
		stderr: spec.stderr ?? "a diagnostic line\n",
	};
}

/**
 * @param {StubSpec} spec
 * @param {NodeJS.Module} shim
 * @returns {{ answer: (argv: string[], timeoutMs?: number) => StubAnswer }}
 */
function stubChecker(spec, shim) {
	if (require.main === shim) {
		const r = answer(spec, process.argv.slice(2));
		if ("status" in r) {
			process.stdout.write(r.stdout);
			process.stderr.write(r.stderr);
			process.exitCode = r.status;
		}
	}
	return { answer: (argv, timeoutMs) => answer(spec, argv, timeoutMs) };
}

/**
 * @param {string} file
 * @param {StubSpec} spec
 */
function writeStubChecker(file, spec) {
	fs.writeFileSync(
		file,
		`module.exports = require(${JSON.stringify(__filename)}).stubChecker(${JSON.stringify(spec)}, module);\n`,
	);
}

/**
 * @param {string} _file
 * @param {string[]} args
 * @param {{ timeout?: number }} [options]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function inProcessSpawn(_file, args, options = {}) {
	const [shim = "", ...argv] = args;
	delete require.cache[require.resolve(shim)];
	const r = require(shim).answer(argv, options.timeout);
	if ("timedOut" in r)
		return {
			pid: 0,
			output: [null, "", ""],
			stdout: "",
			stderr: "",
			status: null,
			signal: "SIGKILL",
			error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
				code: "ETIMEDOUT",
			}),
		};
	return {
		pid: 0,
		output: [null, r.stdout, r.stderr],
		stdout: r.stdout,
		stderr: r.stderr,
		status: r.status,
		signal: null,
	};
}

module.exports = { stubChecker, writeStubChecker, inProcessSpawn };
