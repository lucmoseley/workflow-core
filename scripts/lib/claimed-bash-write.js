/*
 * claimed-bash-write.js — a PreToolUse dispatcher core (workflow-core#2788): this Bash
 * command writes over a file a live session holds (mantahostels#1818, split
 * out of mantahostels#1772).
 *
 * Why: lib/file-claim.js sees Write, Edit and NotebookEdit only, so a
 * redirect, a `cp`, a `sed -i` reaches a claimed file with nothing said
 * (mantahostels#1772).
 *
 * WARN, NEVER DENY — mantahostels#287 declined a Bash-route deny on price: the
 * parser is outrunnable (mantahostels#201), so a parser miss must cost a
 * missing reminder rather than a wrong refusal.
 *
 * TIER 1 ONLY, FOR THE WARNING — `docs/`, `.claude/`, `CLAUDE.md`,
 * `AGENTS.md`. The `scripts/` tier is detect-only by mantahostels#287's own
 * ruling. What it says, and what bounds it per session, is lib/claim-warning.js.
 *
 * IT ALSO CREDITS, AND THAT HALF IS NOT TIER-BOUND (mantahostels#2778). Every
 * literal write target matching lib/code-signal.sh's CODE globs is appended to
 * THIS session's write ledger — but only where no OTHER live session holds a
 * claim on it (claim-warning.js's `creditable` carries why that skip is the
 * whole safety argument).
 *
 * PreToolUse, so it credits INTENT, not an outcome — the post-write core's
 * record is POST for a reason, and that reason is that a write the claim guard DENIED must
 * not be billed. Nothing denies a Bash write over a claimed file, so that case
 * cannot arise here, and a command refused or failing for any other reason
 * costs nothing: the backstop intersects the ledger with its own
 * `git diff --name-only`, so a path that did not change is dropped before it
 * is counted.
 *
 * It carries NO `if` narrowing: a redirect can head with any word at all, so
 * no command-prefix pattern would reach the dominant form.
 *
 * WHAT IT READS is lib/bash-write-plan.js, with its routes and their LIMITS.
 * The judge FAILS OPEN throughout (mantahostels#103 §6), logged
 * (mantahostels#147); the one limb failing closed is a rule-text store fault
 * under the restore rule, the injection's own contract (mantahostels#1762).
 */

const { plan } = require("./bash-write-plan.js");
const { creditable, warnings } = require("./claim-warning.js");

/**
 * The session ledger's latch name (mantahostels#2345), in the rule latches'
 * marker family so clear-rule-latch.sh's glob clears it at a compaction with the
 * payload it records. `led.` is a namespace of its own — a ledger is not a
 * rule, and sharing a rule's latch name would make one write read as the
 * other delivered.
 */
const LEDGER = "led.claimed-bash-write";

/**
 * @typedef {import("./guard-dispatch.js").CoreContext & import("./claim-warning.js").ClaimPorts & {
 *   recordWrite: (rel: string, session: string) => unknown,
 *   recordSelect: (rel: string, session: string) => unknown,
 * }} Ctx
 * @typedef {import("./bash-write-plan.js").Writes} Writes
 */

/**
 * @param {() => void} fn
 * @param {Ctx} ctx
 */
function failOpen(fn, ctx) {
	try {
		fn();
	} catch (e) {
		/* Each half of the judge fails open on its own, logged
		 * (mantahostels#147), so a fault in one cannot silence another. */
		ctx.log(
			`claimed-bash-write: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * The judge's three halves for a command with something to judge: credit,
 * selection and the warning, each failing open on its own.
 * @param {Writes} w
 * @param {string} session
 * @param {Ctx} ctx
 * @returns {import("./claim-warning.js").Warning}
 */
function judge(w, session, ctx) {
	const locks = ctx.listLocks();
	if (locks === null && w.credit.length + w.targets.length > 0)
		ctx.log(
			"the lock store could not be read — a Bash-route write allowed unchecked and uncredited (mantahostels#2778)",
		);
	failOpen(() => {
		if (locks)
			for (const rel of creditable(w.credit, session, locks, ctx))
				ctx.recordWrite(rel, session);
	}, ctx);
	failOpen(() => {
		for (const rel of new Set(w.select)) ctx.recordSelect(rel, session);
	}, ctx);
	/** @type {import("./claim-warning.js").Warning} */
	let said = { text: "", ledger: null };
	failOpen(() => {
		if (locks && w.targets.length > 0)
			said = warnings(
				w.targets,
				{ session, locks, ledger: ctx.readLatch(LEDGER) },
				ctx,
			);
	}, ctx);
	return said;
}

/**
 * @param {string} subject the command
 * @param {Ctx} ctx
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function decide(subject, ctx) {
	const w = plan(subject, ctx);
	if (w.targets.length + w.credit.length + w.select.length === 0)
		return w.owed ? { injectRules: ["whole-file-restore"] } : null;
	// Without a session id no neighbour's claim can be told from this
	// session's own, and every warning would be about the reader's own work.
	if (!ctx.session) {
		ctx.log("no session_id in payload — a Bash-route write allowed unchecked");
		return null;
	}
	const said = judge(w, ctx.session, ctx);
	const latchWrites = said.ledger
		? [{ name: LEDGER, text: JSON.stringify(said.ledger) }]
		: [];
	const prelude = said.text ? ctx.corePaths(said.text) : "";
	// One hook object carries both, so the claim warning rides ahead of the
	// rule in its envelope; once the rule is latched it goes out alone.
	if (w.owed)
		return {
			injectRules: ["whole-file-restore"],
			...(prelude ? { prelude } : {}),
			latchWrites,
		};
	return prelude ? { injectRules: [], prelude, latchWrites } : null;
}

module.exports = {
	LEDGER,
	field: "command",
	noun: "command",
	decide,
};
