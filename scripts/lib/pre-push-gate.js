/*
 * pre-push-gate.js — the shell each pre-push gate runs in (#3116): its
 * printed pass and the entry point that finds the pushing tree and reads
 * git's ref lines from stdin.
 *
 * Each fault here is not the push's, so each prints and lets the push
 * through: a refusal there would refuse every push (#2409, #1954).
 */

const { readFdAll } = require("./read-fd.js");
const { readTopLevel } = require("./git-tree.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/**
 * The printer a gate names a fault with as it lets the push through.
 * @param {string} gate the gate's program name
 * @param {string} unjudged what goes unchecked, as `<unjudged> not checked`
 * @returns {(why: string) => void}
 */
const buildUnchecked = (gate, unjudged) => (why) =>
	writeFd(2, `${gate}: ${why} — ${unjudged} not checked.\n`);

/**
 * Run `judge` on git's ref lines from the pushing tree; 0, printed, where the
 * tree or stdin cannot be read.
 * @param {(why: string) => void} unchecked
 * @param {(stdin: string, tree: string) => number} judge
 * @returns {number} the hook's exit code
 */
function runPrePushGate(unchecked, judge) {
	const tree = readTopLevel(process.cwd());
	if (tree === null) {
		unchecked("could not find the pushing tree");
		return 0;
	}
	let stdin = "";
	try {
		stdin = readFdAll(0).toString("utf8");
	} catch (e) {
		unchecked(`could not read the pushed refs (${caught(e).message})`);
		return 0;
	}
	return judge(stdin, tree);
}

module.exports = {
	buildUnchecked,
	runPrePushGate,
};
