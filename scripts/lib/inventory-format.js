const NOTHING = "`waits on you: nothing`";
const REFS_TAIL = "— waits on you: #N";
const NOTHING_TAIL = "— nothing waits on you";

const INVENTORY = Object.freeze({
	placement: "directly above the status line",
	itemLines: "one `- #N (what to do)` line per item",
	nothingText: NOTHING,
	nothingLine: `the single line ${NOTHING}`,
	statusTail: `\`${REFS_TAIL}, #M\` or \`${NOTHING_TAIL}\``,
	refsTail: REFS_TAIL,
	nothingTail: NOTHING_TAIL,
	needsInputLine: `needs input: <the decision you are blocked on> ${REFS_TAIL}`,
	resultLine: `result: <what was delivered> ${NOTHING_TAIL}`,
});

module.exports = { INVENTORY };
