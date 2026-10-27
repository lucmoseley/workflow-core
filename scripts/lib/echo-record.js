/*
 * echo-record.js — the PostToolUse dispatcher core that watches what a call
 * ANSWERED: the half of mantahostels#2570 the PreToolUse guard cannot be,
 * since it never sees a response (#2787).
 *
 * IMPLICIT:  hashes every Bash and Read call's input and its response into a
 *            per-agent scratch chain, so lib/echo-call.js can refuse a third
 *            identical call that has already given the same answer twice.
 * JUSTIFIED: fail-safe — an input-only rule refuses the wrong call 43.5% of
 *            the time (mantahostels#2570).
 * DEFEAT:    WFC_NO_ECHO_CHAIN=1 — recording stops, so the guard sees no chain
 *            and never fires. There is no partial setting.
 *
 * Its "Bash|Read" tools must equal the guard-echo-call row's in
 * lib/guard-cores.json: a tool recorded but not guarded costs work for
 * nothing, and one guarded but not recorded can never fire. It never says anything — a PostToolUse output is
 * context handed to the session, and this has none to give. lib/echo-chain.js
 * holds the rules it shares with the guard; the store is its host's.
 */

const {
	callSignature,
	chainName,
	isNeighbours,
	responseHash,
} = require("./echo-chain.js");

/**
 * @typedef {{ hash: string, run: number, denies: number }} Prior
 * @typedef {{
 *   fileState: (file: string) => string | null,
 *   chain: (name: string, sig: string,
 *     next: (prior: Prior | null) => Prior) => boolean,
 * }} EchoPorts the Read's file state, null where it is missing or could not
 *   be read (logged); and the store, rewriting `sig`'s record from its prior
 *   one under a lock: false where it could not be written, and true where it
 *   could not be read, a fault the port logs itself and leaves the chain as is
 */

/**
 * @param {unknown} _subject
 * @param {import("./kit-context.js").KitContext & EchoPorts & {
 *   env: Record<string, string | undefined> }} ctx
 */
function decide(_subject, ctx) {
	if (ctx.env.WFC_NO_ECHO_CHAIN === "1") return null;
	const tool = ctx.tool ?? "";
	/* The two shapes lib/agent-poll.js owns are neither judged nor recorded:
	 * a chain nothing reads is work for nothing on every timed beat. */
	const command = ctx.input.command;
	if (isNeighbours(tool, typeof command === "string" ? command : ""))
		return null;
	const sig = callSignature(tool, ctx.input, ctx.fileState);
	/* An absent response is ordinary and silent: the chain is left alone, and
	 * re-forms from the next readable answer. */
	const answered = responseHash(ctx.response);
	if (answered === null) return null;
	let hash = answered;
	if (!ctx.key) {
		ctx.log("no session_id in payload — echo record allowed unchecked");
		return null;
	}
	const unchanged =
		tool === "Read" &&
		/** @type {{ type?: unknown } | null} */ (ctx.response)?.type ===
			"file_unchanged";
	const stored = ctx.chain(chainName(ctx.key), sig, (prior) => {
		if (!prior) return { hash, run: 1, denies: 0 };
		/* THE READ SHORT CIRCUIT IS THE SAME ANSWER AGAIN, not a new one: the
		 * harness answers a re-read of an unchanged file with `file_unchanged`,
		 * so it extends the chain and keeps the full read's hash (#1090). */
		if (unchanged) hash = prior.hash;
		/* Denies carry across the reset: the guard's escalation counts refusals
		 * on this signature over the agent's life, and a count the reset
		 * restarted would never reach two. */
		return {
			hash,
			run: prior.hash === hash ? prior.run + 1 : 1,
			denies: prior.denies,
		};
	});
	if (!stored)
		ctx.log("could not write the chain store — no echo chain recorded");
	return null;
}

module.exports = {
	field: ["command", "file_path"],
	noun: "echo record",
	decide,
};
