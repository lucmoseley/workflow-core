#!/usr/bin/env node
/*
 * record-typecheck-red.js — .husky/pre-commit's hand-off of a RED type-check:
 * the output on stdin, the command as its argument (workflow-core#3824).
 *
 * IT JOINS NO FAMILY (§G4, §N3): it gates nothing, so it is no `check-*`, and it
 * is not a hook, so it is no `guard-*`.
 *
 * A RECORD THAT DOES NOT LAND IS SAID ON STDERR, and exits 0, as the gate that
 * calls it reports and never refuses. No session id records nothing.
 */

const { readFdAll } = require("./lib/read-fd.js");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { fromEnv } = require("./lib/session-id.js");
const { recordRed } = require("./lib/typecheck-red-host.js");
const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");

const parsed = parseOrCode(process.argv.slice(2), {
	usage: `Usage: node ${scriptPath("record-typecheck-red.js")} -- <command> < <output>`,
	min: 1,
	max: 1,
});
const sid = fromEnv();
if (typeof parsed === "number") process.exitCode = parsed;
else if (sid) {
	try {
		recordRed(process.cwd(), sid, {
			command: parsed.positionals[0] ?? "",
			output: readFdAll(0).toString("utf8"),
		});
	} catch (e) {
		writeFd(
			2,
			`record-typecheck-red.js: not recorded, so this session hears this RED only from the output above — ${caught(e).message}\n`,
		);
	}
}
