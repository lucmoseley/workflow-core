/*
 * inventory-format.js — the founder inventory's format, in the words the
 * ceiling guard's inventory step uses (#1249). #958 ruled that step's wording,
 * and these pieces are cut from it. The inventory guard's placement line and
 * the parser's block shape are built from them too, as are the inventory
 * guard's empty-block, no-tail and draft refusals, so a change here changes
 * every one of those texts.
 *
 * WHAT STAYS OUTSIDE IT: the bare heading `waits on you:` and the bare word
 * `nothing`, which the readers' regexes match and their refusals name in
 * place — the guard's header-line and tail-mismatch refusals, and the parser's
 * own block shape — and the guard's cross-tracker tail example,
 * `— waits on you: #N, owner/repo#M`.
 *
 * THE TWO STATUS LINES are written here whole, tail included, so every
 * other guard's template for them is the shape the inventory guard accepts
 * (#2374).
 *
 * IT REQUIRES NOTHING, ON PURPOSE. The parser loads it at its top, and a
 * parser that crashes lets every close through guard-issue-close.sh unchecked
 * (#1255), so a dependency here would put the check at risk.
 */

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
