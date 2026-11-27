const fs = require("node:fs");
const path = require("node:path");
const { isTerminalAgent } = require("./agent-liveness.js");
const { caught } = require("./caught.js");
const { stopOn } = require("./claude-stop.js");
const { readEveryOverflowLookup } = require("./dispatch-ledger.js");
const { shortJobId } = require("./job-paths.js");
const { readJsonl } = require("./jsonl.js");
const {
	dollars,
	priceSessions,
	readReplyUsd,
} = require("./overflow-budget.js");
const { chainRootOf, chainSpendOf } = require("./overflow-budget-core.js");
const { refillPath } = require("./refill-dir.js");
const { buildSeatLabel, overflowSeatsOf } = require("./refill-seats.js");

/**
 * @typedef {import("./refill-seats.js").OverflowSeat} OverflowSeat
 * @typedef {import("./dispatch-ledger.js").OverflowLookup} OverflowLookup
 */

const LAUNCHED_KINDS = new Set(["background", "headless"]);

/** @param {OverflowSeat} seat */
const cappedFile = (seat) =>
	refillPath(path.join(".overflow-ledger", `${seat.keyVar}.capped.jsonl`));

/**
 * @param {OverflowSeat} seat
 * @param {import("./agent-liveness.js").AgentRecord[]} agents
 * @param {OverflowLookup} lookup
 */
function priceOverAllowance(seat, agents, lookup) {
	const spent = chainSpendOf(
		lookup,
		priceSessions(seat, lookup),
		readReplyUsd(seat),
	);
	const capped = new Set(
		(readJsonl(cappedFile(seat))?.rows ?? []).map((r) =>
			chainRootOf(lookup, String(r.sessionId)),
		),
	);
	return agents.flatMap((a) => {
		if (
			!LAUNCHED_KINDS.has(a.kind ?? "") ||
			capped.has(chainRootOf(lookup, a.sessionId)) ||
			a.founderReply === true
		)
			return [];
		const launch = lookup({ jobId: a.id, sessionId: a.sessionId });
		const spentUsd = spent.get(a.sessionId);
		if (
			launch?.keyVar !== seat.keyVar ||
			spentUsd === undefined ||
			spentUsd < launch.allowanceUsd
		)
			return [];
		return [
			{
				jobId: a.id ?? shortJobId(a.sessionId),
				sessionId: a.sessionId,
				name: a.name ?? null,
				spentUsd,
				allowanceUsd: launch.allowanceUsd,
				ended: isTerminalAgent(a),
			},
		];
	});
}

/**
 * @param {import("./refill-seats.js").SeatList} declared
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @returns {string[]}
 */
function stopOverAllowance(declared, agents) {
	if (declared.errors.length > 0)
		return [`overflow allowances unjudged: ${declared.errors.join("; ")}`];
	const seats = overflowSeatsOf(declared.seats);
	if (seats.length === 0) return [];
	if (!agents) return ["overflow allowances unjudged: the listing is unread"];
	let lookup;
	try {
		lookup = readEveryOverflowLookup();
	} catch (err) {
		return [`overflow allowances unjudged: ${caught(err).message}`];
	}
	return seats.flatMap((seat) => {
		let over;
		try {
			over = priceOverAllowance(seat, agents, lookup);
		} catch (err) {
			return [
				`overflow allowances on ${buildSeatLabel(seat)} unjudged: ${caught(err).message}`,
			];
		}
		return over.flatMap((s) => capSession(seat, s));
	});
}

/**
 * @param {OverflowSeat} seat
 * @param {ReturnType<typeof priceOverAllowance>[number]} s
 * @returns {string[]}
 */
function capSession(seat, s) {
	const who = `overflow session ${s.name ? `${s.name} (${s.jobId})` : s.jobId} on ${buildSeatLabel(seat)}`;
	if (!Number.isFinite(s.allowanceUsd))
		return [`${who} unjudged: its launch records no allowance`];
	const r = s.ended ? null : stopOn(seat.dir, s.jobId);
	const figures = `spent ${dollars(s.spentUsd)} of its ${dollars(s.allowanceUsd)} allowance`;
	if (r && !r.ok) return [`could not stop ${who}, ${figures}: ${r.why}`];
	const row = {
		sessionId: s.sessionId,
		jobId: s.jobId,
		at: new Date().toISOString(),
		spentUsd: s.spentUsd,
		allowanceUsd: s.allowanceUsd,
	};
	try {
		fs.appendFileSync(cappedFile(seat), `${JSON.stringify(row)}\n`);
	} catch (err) {
		return [
			`${r ? "stopped" : "ended"} ${who}, ${figures}, not marked capped: ${caught(err).message}`,
		];
	}
	return r ? [`stopped ${who}: ${figures}`] : [];
}

module.exports = { stopOverAllowance };
