const {
	EC_CLEARED,
	callSignature,
	chainName,
	isNeighbours,
	lookup,
} = require("./echo-chain.js");
const { textOf } = require("./guard-entry.js");
const {
	PARENT_WAIT,
	SUBAGENT_WAIT,
	WAIT_SLOT,
	withWait,
} = require("./wait-text.js");

const REASON = `This exact call has already run twice in a row and given the same answer both times — for a Read, the file unchanged since you last read it — so a third run is very unlikely to say anything new.

${WAIT_SLOT}

If you genuinely need this again — the state it reads has changed since — VARY THE COMMAND and it will not match. The first refusal on a call clears its chain and lets the identical call through once more, but a second refusal on the same call does not, and from there only a varied command runs.`;

/**
 * @typedef {Pick<import("./core-contract.js").CoreContext,
 *   "input" | "tool" | "key" | "agentLabel" | "log" | "corePaths"> &
 *   import("./echo-record.js").EchoPorts & {
 *   now: () => number,
 *   readChain: (name: string) => string | null,
 * }} EchoContext
 */

/**
 * @param {EchoContext} ctx
 * @param {string} name
 * @param {string} sig
 * @param {{ hash: string, run: number, denies: number }} seen
 */
function recorded(ctx, name, sig, seen) {
	const stored = ctx.chain(name, sig, (prior) => {
		const record = prior ?? seen;
		const denies = record.denies + 1;
		return denies >= 2
			? { hash: record.hash, run: record.run, denies }
			: { hash: EC_CLEARED, run: 0, denies };
	});
	if (stored) return true;
	ctx.log("could not record the refusal — repeat allowed unchecked");
	return false;
}

/**
 * @param {string} _session
 * @param {EchoContext} ctx
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(_session, ctx) {
	const tool = ctx.tool;
	if (tool !== "Bash" && tool !== "Read") return null;
	if (isNeighbours(tool, textOf(ctx.input.command))) return null;
	if (!ctx.key) return null;
	const sig = callSignature(tool, ctx.input, ctx.fileState);
	const name = chainName(ctx.key);
	const text = ctx.readChain(name);
	if (text === null) {
		ctx.log("could not read the chain store — repeat allowed unchecked");
		return null;
	}
	const record = lookup(text, sig, ctx.now());
	if (!record || record.run < 2) return null;
	if (!recorded(ctx, name, sig, record)) return null;
	const waiting =
		ctx.agentLabel === "main"
			? `If you are waiting on a background job or a subagent: END THE TURN — ${PARENT_WAIT}, so a repeat buys nothing. Say in one line what you are waiting for, then stop producing output.`
			: `If you are waiting on a background job, ${SUBAGENT_WAIT}`;
	return { deny: ctx.corePaths(withWait(REASON, waiting)) };
}

module.exports = {
	decide,
	field: "session_id",
	noun: "repeat check",
	top: true,
};
