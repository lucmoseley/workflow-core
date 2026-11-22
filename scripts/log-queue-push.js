#!/usr/bin/env node

const { parseErrorText } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { parseQueuePushes, REMOTE } = require("./lib/landing-refs.js");
const { runPrePushGate } = require("./lib/pre-push-gate.js");
const { logEnqueue, queueLogFile } = require("./lib/queue-log.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("log-queue-push.js")} <remote>
  reads git's pre-push ref lines on stdin`;

/** @param {string} why */
const unlogged = (why) =>
	writeFd(2, `log-queue-push: ${why} — the queue push goes unlogged.\n`);

/** @param {string[]} [argv] @returns {number} */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, { usage: USAGE, min: 1 });
	if (typeof parsed === "number") return parsed;
	if (parsed.positionals[0] !== REMOTE) return 0;
	return runPrePushGate(unlogged, (stdin) => {
		const pushes = parseQueuePushes(stdin);
		if (pushes.length === 0) return 0;
		const root = repoRoot();
		if (root === null) {
			unlogged("could not find the canonical checkout");
			return 0;
		}
		const file = queueLogFile(root);
		const at = now();
		for (const { remoteRef, sha } of pushes)
			if (!logEnqueue(file, { ref: remoteRef, sha, at }))
				unlogged(`could not write ${file}`);
		return 0;
	});
}

if (require.main === module) {
	let code = 0;
	try {
		code = main();
	} catch (err) {
		unlogged(parseErrorText(err));
	}
	process.exit(code);
}

module.exports = { main };
