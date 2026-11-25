// #5734
const fs = require("node:fs");

/**
 * @typedef {{ id: string, launches: string, envelope?: object | null,
 *   onRescan?: object, exit?: number, sleepMs?: number, stderr?: string }} StubSpec
 * @typedef {{ status: number, stdout: string, stderr: string }} StubAnswer
 */

/**
 * @param {StubSpec} spec
 * @param {string[]} argv
 * @returns {StubAnswer}
 */
function call(spec, argv) {
	fs.appendFileSync(spec.launches, `${JSON.stringify([spec.id, ...argv])}\n`);
	if (spec.sleepMs)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.sleepMs);
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
 * @returns {{ call: (argv: string[]) => StubAnswer }}
 */
function stubChecker(spec, shim) {
	if (require.main === shim) {
		const r = call(spec, process.argv.slice(2));
		process.stdout.write(r.stdout);
		process.stderr.write(r.stderr);
		process.exitCode = r.status;
	}
	return { call: (argv) => call(spec, argv) };
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
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function inProcessSpawn(_file, args) {
	const [shim = "", ...argv] = args;
	delete require.cache[require.resolve(shim)];
	const r = require(shim).call(argv);
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
