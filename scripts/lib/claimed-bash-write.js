const { plan } = require("./bash-write-plan.js");
const { creditable, warnings } = require("./claim-warning.js");

const LEDGER = "led.claimed-bash-write";

/**
 * @typedef {import("./core-contract.js").CoreContext & import("./claim-warning.js").ClaimPorts & {
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
		ctx.log(
			`claimed-bash-write: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
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
 * @param {string} subject
 * @param {Ctx} ctx
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(subject, ctx) {
	const w = plan(subject, ctx);
	if (w.targets.length + w.credit.length + w.select.length === 0)
		return w.owed ? { injectRules: ["whole-file-restore"] } : null;
	if (!ctx.session) {
		ctx.log("no session_id in payload — a Bash-route write allowed unchecked");
		return null;
	}
	const said = judge(w, ctx.session, ctx);
	const latchWrites = said.ledger
		? [{ name: LEDGER, text: JSON.stringify(said.ledger) }]
		: [];
	const prelude = said.text ? ctx.corePaths(said.text) : "";
	if (w.owed)
		return {
			injectRules: ["whole-file-restore"],
			...(prelude ? { prelude } : {}),
			latchWrites,
		};
	return prelude ? { injectRules: [], prelude, latchWrites } : null;
}

module.exports = {
	field: "command",
	noun: "command",
	decide,
};
