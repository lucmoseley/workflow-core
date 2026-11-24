const { readFdAll } = require("./read-fd.js");
const { readTopLevel } = require("./git-tree.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/**
 * @param {string} gate
 * @param {string} unjudged
 * @returns {(why: string) => void}
 */
const buildUnchecked = (gate, unjudged) => (why) =>
	writeFd(2, `${gate}: ${why} — ${unjudged} not checked.\n`);

/**
 * @param {(why: string) => void} unchecked
 * @param {(stdin: string, tree: string) => number} judge
 * @returns {number}
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
