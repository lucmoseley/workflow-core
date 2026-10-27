/*
 * echo-call.js — the dispatcher core that refuses a tool call which has
 * already answered the same thing twice in a row (mantahostels#2570). Its
 * production ports are lib/echo-call-host.js; it reads the chain
 * lib/echo-record.js writes after every Bash and Read call, by
 * lib/echo-chain.js's rules.
 *
 * THE FAILURE. An ECHO TURN is a turn whose tool call is byte-identical to a
 * recent one. It scales with session length — 0.5% of turns under 50, 5.0% at
 * 200-399, and 24.2% of turns and 24.5% of cost past 400 (mantahostels#2562,
 * exhaustive over the 3,856 sessions its own pass read).
 *
 * WHY lib/agent-poll.js DOES NOT CATCH IT. That core is wired on the same
 * tools; the gap is its CLASSIFIER, which reads five named shapes. A poll
 * spelled `cat`, `grep`, `tail` or a script on a background job's output file
 * is a route it does not classify — its own header says so — and that
 * spelling is where the mass sits, most of it a suite or job output file read
 * by one of those verbs (mantahostels#2570). This core classifies nothing. It
 * compares.
 *
 * THE RULE. Refuse a call whose (tool, tool_input) signature has returned a
 * byte-identical response on each of its last TWO runs. A Read's signature
 * includes the file's on-disk state, so a file rewritten since is not refused
 * (#1058). The harness answers
 * a re-read of an unchanged file with a `type: "file_unchanged"` short circuit
 * rather than the file, and lib/echo-record.js counts that as the same answer
 * again, so a Read is refused on its third call as a Bash command is. #1090
 * reversed mantahostels#2637's reset once the file-state signature made the
 * fold measure no worse (`measure-echo-chain.js --read-chains`; the rows and
 * what they cannot show are on #1090). lib/echo-chain.js holds the store and
 * the rule's reasoning; mantahostels#2616 holds the measured rows and their
 * population, and `node scripts/measure-echo-chain.js` re-derives them. In
 * short, refusing on a repeated INPUT alone is right 55.9% of the time and on
 * two repeated RESPONSES 94.3%, because the legitimate repeat — a timed watch,
 * a re-read after an edit — is exactly the one whose answer changes.
 *
 * WIRED on Bash and Read through lib/guard-cores.json. ListAgents is
 * deliberately NOT covered: lib/agent-poll.js already caps it at two calls in
 * five minutes, and on the measured corpus this rule split near evenly there
 * (47 right, 35 wrong).
 *
 * DENY, not warn, on mantahostels#103's house rule: the call count and the
 * response hashes are structured facts, and a warn cannot stop the failure
 * because the loop's cost is paid per call. It sits on the deny side by a
 * narrower margin than lib/agent-poll.js, though: 5.7% of refusals on the
 * measured corpus were wrong, so the reason below says how to proceed anyway.
 *
 * FAILS CLOSED on a throw (its row's `failure`). Every fault it can name —
 * a store that will not read, a refusal that will not record, a file that
 * will not stat — fails open, logged (mantahostels#103 §6, mantahostels#147).
 *
 * LIMITS:
 *   * THE FIRST REFUSAL ON A SIGNATURE CLEARS ITS CHAIN; the second does not.
 *     So a session with a real need pays one turn and carries on, and a
 *     runaway loop is stopped after at most five wasted calls rather than
 *     being refused every third for ever. A varied command is the way past
 *     either way.
 *   * A loop whose answer changes every time — a `date`, a growing log tailed
 *     with `wc -c` — is invisible here and always will be. lib/agent-poll.js
 *     is the cadence guard; this one is the repetition guard.
 *   * Volatile fields in the response are dropped by NAME PATTERN
 *     (lib/echo-chain.js), so a differently-named one added upstream disarms
 *     this silently.
 *   * The fold keys on the harness's literal `file_unchanged` type, so a
 *     renamed one upstream silently moves the Read refusal back to the fourth
 *     call.
 *   * It sees this agent only. A neighbour running the identical command is
 *     neither seen nor counted, correctly — its cost is its own — and nor is
 *     the parent or a sibling subagent under the same session (#1004).
 *
 * A SUBAGENT IS TOLD OTHERWISE (#1732), in lib/agent-poll.js's words (#1169,
 * #1735): where the parent is told to end the turn, a subagent is told to
 * wait inside it (lib/wait-text.js).
 */

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

const field = "session_id";
const top = true;
const noun = "repeat check";

const REASON = `This exact call has already run twice in a row and given the same answer both times — for a Read, the file unchanged since you last read it — so a third run is very unlikely to say anything new.

${WAIT_SLOT}

If you genuinely need this again — the state it reads has changed since — VARY THE COMMAND and it will not match. The first refusal on a call clears its chain and lets the identical call through once more, but a second refusal on the same call does not, and from there only a varied command runs.`;

/**
 * @typedef {Pick<import("./guard-dispatch.js").CoreContext,
 *   "input" | "tool" | "key" | "agentLabel" | "log" | "corePaths"> &
 *   import("./echo-record.js").EchoPorts & {
 *   now: () => number,
 *   readChain: (name: string) => string | null,
 * }} EchoContext `readChain` "" where the store is absent, null where it will
 *   not read
 */

/**
 * The refusal written to the store, false where it would not write, logged.
 * ESCALATION — the first LIMITS bullet above (mantahostels#2570): a first
 * refusal clears the chain, a second leaves it armed. A reset that failed
 * leaves the chain armed while the message promises it has been cleared, so
 * it fails open on the record, never closed.
 * @param {EchoContext} ctx
 * @param {string} name the chain's store name
 * @param {string} sig
 * @param {{ hash: string, run: number, denies: number }} seen the record the
 *   refusal was judged on, the base where the store has lost it since
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
 * @returns {import("./guard-dispatch.js").CoreDecision}
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

module.exports = { decide, field, noun, top };
