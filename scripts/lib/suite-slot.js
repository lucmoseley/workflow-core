const { readAvailableMb, readTotalMb } = require("./meminfo.js");
const { clampedClause, reachableRung, rungMb } = require("./suite-ladder.js");
const { gateDenies, queueSeat } = require("./suite-queue.js");

const LANDER_ROLE = "lander";

/**
 * @typedef {{ok: true, spawned: () => void, release: () => void}
 *   | {ok: false, reason: string, memoryShut?: boolean}} Admission
 */

/**
 * @param {{chargeMb: number, pollMs?: number, timeoutMs?: number,
 *   gate?: (climbMb: number) => import("./suite-queue.js").GateDenial | null,
 *   memory?: () => import("./meminfo.js").MbResult,
 *   totalMb?: () => number | null, queueDir?: string}} options
 * @returns {Promise<Admission>}
 */
async function suiteSlot({
	chargeMb,
	pollMs,
	timeoutMs,
	gate = (climbMb) => gateDenies([], undefined, null, { climbMb }),
	memory = readAvailableMb,
	totalMb = readTotalMb,
	queueDir,
}) {
	const seat = queueSeat({
		queue: { queueDir },
		join: { role: LANDER_ROLE, chargeMb },
	});
	const reach = reachableRung(rungMb(chargeMb), totalMb());
	let mem = memory();
	let memoryShut = false;
	const outcome = await seat.wait({
		pollMs,
		timeoutMs,
		gate: (climbMb) => {
			mem = memory();
			memoryShut = !mem.ok || mem.mb - climbMb < reach.rungMb;
			if (memoryShut)
				return {
					limb: "memory",
					...(mem.ok ? { mb: mem.mb } : {}),
					...reach,
					...(climbMb > 0 ? { climbMb } : {}),
				};
			return gate(climbMb);
		},
		label: "lander",
	});
	if (outcome !== "refused")
		return { ok: true, spawned: seat.spawned, release: seat.leave };
	const memoryRead = mem.ok
		? `${mem.mb} MB available against ${reach.rungMb} MB${clampedClause(reach.ladderMb)}`
		: `memory unread: ${mem.error}`;
	return {
		ok: false,
		reason: `no suite slot by the ceiling (${memoryRead})`,
		memoryShut,
	};
}

module.exports = { LANDER_ROLE, suiteSlot };
