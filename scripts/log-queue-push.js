#!/usr/bin/env node
/*
 * log-queue-push.js — the pre-push limb of the queue log (workflow-core#4485, spec
 * workflow-core#4458): with the `landing` module on, logs each `queue/<name>` update a
 * push to lib/landing-refs.js's remote makes, at push time, for the queue
 * lander to order its batch by (lib/queue-log.js).
 *
 *   node scripts/log-queue-push.js <remote>
 *
 * git feeds `<local ref> <local sha> <remote ref> <remote sha>` per ref on
 * stdin. A deletion logs nothing.
 *
 * IN NO `scripts/` FAMILY (code-standards §N3): it gates nothing and is no
 * hook of Claude Code's. It refuses no push: past a command line it refuses
 * (2), every path exits 0, a fault costing only its row, printed.
 */

const { parseErrorText } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { QUEUE_HEADS, REMOTE } = require("./lib/landing-refs.js");
const { isModuleOnAtHead, runPrePushGate } = require("./lib/pre-push-gate.js");
const { isZeroSha, parseRefLines } = require("./lib/push-refs.js");
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
	return runPrePushGate(unlogged, (stdin, tree) => {
		const pushes = parseRefLines(stdin).filter(
			(r) => r.remoteRef?.startsWith(QUEUE_HEADS) && !isZeroSha(r.sha),
		);
		if (pushes.length === 0 || !isModuleOnAtHead("landing", tree, unlogged))
			return 0;
		const root = repoRoot();
		if (root === null) {
			unlogged("could not find the canonical checkout");
			return 0;
		}
		const file = queueLogFile(root);
		const at = now();
		for (const { remoteRef, sha } of pushes)
			if (remoteRef && !logEnqueue(file, { ref: remoteRef, sha, at }))
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
