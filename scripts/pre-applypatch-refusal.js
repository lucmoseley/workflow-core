#!/usr/bin/env node
if (require.main === module) {
	try {
		const { parseOrCode } = require("./lib/cli-args.js");
		const { writeFd } = require("./lib/write-fd.js");
		const { commitRoute, scanRefusal } = require("./lib/commit-route.js");
		const parsed = parseOrCode(process.argv.slice(2), {
			usage: "node pre-applypatch-refusal.js <absolute git dir>",
			min: 1,
		});
		if (typeof parsed === "number") {
			process.exitCode = parsed || 1;
		} else {
			const route = commitRoute("pre-applypatch", parsed.positionals[0] ?? "");
			writeFd(1, scanRefusal("pre-applypatch", route));
			process.exitCode = 0;
		}
	} catch {
		process.exitCode = 1;
	}
}
