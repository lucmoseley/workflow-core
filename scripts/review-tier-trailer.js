#!/usr/bin/env node
const { CliExit, parse } = require("./lib/cli-args.js");
const { runTrailer } = require("./lib/review-tier-trailer.js");
const { buildTrailerPorts } = require("./lib/review-tier-trailer-host.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = "usage: review-tier-trailer.js <message file>\n";

/**
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, args: string[] }} io
 * @returns {import("./lib/precommit-dispatch.js").RowResult}
 */
const PROGRAM = ({ cwd, env, args }) => {
	let positionals;
	try {
		({ positionals } = parse(args, { usage: USAGE, min: 1, max: 1 }));
	} catch (e) {
		if (!(e instanceof CliExit)) throw e;
		return e.code === 0
			? { exit: 0, stdout: e.text, stderr: "" }
			: { exit: e.code, stdout: "", stderr: e.text };
	}
	const { status, stderr } = runTrailer(
		positionals[0] ?? "",
		buildTrailerPorts({ cwd, env }),
	);
	return { exit: status, stdout: "", stderr };
};

module.exports = { PROGRAM };

if (require.main === module) {
	const { exit, stdout, stderr } = PROGRAM({
		cwd: process.cwd(),
		env: process.env,
		args: process.argv.slice(2),
	});
	if (stdout) writeFd(1, stdout);
	if (stderr) writeFd(2, stderr);
	process.exit(exit);
}
