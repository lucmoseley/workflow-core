#!/usr/bin/env node

const { caught } = require("./lib/caught.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { readDeclaredOverflowLookup } = require("./lib/dispatch-ledger.js");
const { readFdAll } = require("./lib/read-fd.js");
const { writeFd } = require("./lib/write-fd.js");

function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("overflow-sessions.js")} < session-ids`,
	});
	if (typeof parsed === "number") return parsed;
	let lookup;
	try {
		lookup = readDeclaredOverflowLookup();
	} catch (e) {
		writeFd(2, `overflow-sessions: ${caught(e).message}\n`);
		return 1;
	}
	const marked = readFdAll(0)
		.toString("utf8")
		.split("\n")
		.filter((sessionId) => sessionId && lookup({ sessionId }));
	if (marked.length > 0) writeFd(1, `${marked.join("\n")}\n`);
	return 0;
}

if (require.main === module) process.exit(main());
