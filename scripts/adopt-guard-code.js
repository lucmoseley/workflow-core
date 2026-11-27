#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	adoptGuardCodeAt,
	adoptionLine,
	guardCodeDir,
	guardFiles,
} = require("./lib/guard-code.js");
const { writeFd } = require("./lib/write-fd.js");
const { orFallback } = require("./lib/caught.js");

parseOrExit(process.argv.slice(2), {
	usage: `Usage: node ${scriptPath("adopt-guard-code.js")}`,
});

const adoption = adoptGuardCodeAt(hostRoot());
if (adoption === null) {
	writeFd(
		1,
		"guard code: nothing to adopt — this checkout's hooks do not run from pinned guard code\n",
	);
	process.exit(0);
}
const live = orFallback(
	() =>
		fs.existsSync(
			path.join(
				guardFiles(guardCodeDir()).current,
				"scripts",
				"guard-dispatch.js",
			),
		),
	false,
);
writeFd(
	adoption.kind === "error" || !live ? 2 : 1,
	`${adoptionLine(adoption)}${live ? "" : "; no guard code is live, so every guarded call is refused"}\n`,
);
process.exit(adoption.kind !== "error" && live ? 0 : 1);
