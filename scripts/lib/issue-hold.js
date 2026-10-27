/*
 * issue-hold.js — whether anything pick-next.js skips a ticket on holds it:
 * an active `**Gated until:**` or well-formed `**Gated on:**` line carrying
 * its `**Gate basis:**`, an open native blocked-by edge, or an open
 * `**Blocked on**` issue (#3263).
 * rule:blocked-ticket-gate names these as the gate a not-ready ticket owes.
 */

const { ghGetRetrying } = require("./gh");
const { resolveGate } = require("./issue-gate");
const { proseRefsOf } = require("./prose-blockers");

/**
 * Every read is strict: an empty answer would read as no blocker.
 * @param {{number: number, body: string}} iss
 * @returns {Promise<{ok: true, held: boolean} | {ok: false, what: string, fix: string}>}
 */
async function readHold(iss) {
	const gates = resolveGate(iss.body);
	if ((gates.gateHolds || gates.gateOnHolds) && gates.basis)
		return { ok: true, held: true };
	const edges = await ghGetRetrying(
		`repos/{owner}/{repo}/issues/${iss.number}/dependencies/blocked_by`,
		{ strict: true },
	);
	if (!edges.ok)
		return {
			ok: false,
			what: `its blockers are unreadable (${edges.error})`,
			fix: `re-run, or read them yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/dependencies/blocked_by`,
		};
	if (
		edges.out.some((/** @type {{state?: unknown}} */ b) => b.state === "open")
	)
		return { ok: true, held: true };
	/* Fails closed: an unreadable marker refuses even where a later one is
	 * open, since the session can re-run and an unjudged park is the harm. */
	for (const r of proseRefsOf(iss.body)) {
		const ref = await ghGetRetrying(
			`repos/${r.repo ?? "{owner}/{repo}"}/issues/${r.number}`,
			{ strict: true },
		);
		if (!ref.ok)
			return {
				ok: false,
				what: `its **Blocked on** ${r.repo ?? ""}#${r.number} is unreadable (${ref.error})`,
				fix: `re-run, or read it yourself: gh issue view ${r.number}${r.repo ? ` --repo ${r.repo}` : ""}`,
			};
		if (ref.out[0]?.state === "open") return { ok: true, held: true };
	}
	return { ok: true, held: false };
}

module.exports = { readHold };
