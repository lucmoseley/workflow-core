#!/usr/bin/env node
// cli-args-exempt: #941

const { adopt } = require("./lib/init-adopter-core.js");
const { run } = require("./lib/materialise-plugin.js");
const { writeFd } = require("./lib/write-fd.js");

process.exit(
	adopt(process.argv.slice(2), {
		out: (text) => writeFd(1, text),
		err: (text) => writeFd(2, text),
		runNode: (root, script, args, opts) =>
			run(root, [process.execPath, script, ...args], opts),
	}),
);
