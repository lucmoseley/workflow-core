#!/usr/bin/env node
// DENIES-THROUGH: lib/guard-judge.js

const { parseOrExit } = require("./lib/cli-args.js");

const { flags } = parseOrExit(process.argv.slice(2), {
	usage:
		"Usage: guard-dispatch.js [--only <core>]   (the hook payload on stdin)",
	flags: { "--only": "value" },
});
const only = flags["--only"];
require("./lib/guard-dispatch.js").runDispatch(
	typeof only === "string" ? only : undefined,
);
