/*
 * suite-slot.js — the queue lander's suite slot (workflow-core#2416, workflow-core#2542, workflow-core#2650): the
 * production `admit` lib/local-tester.js holds each group of runs under;
 * lib/suite-slot-fake.ts is the test one. A module of its own so the slot is
 * tested through this export, not a test-only one off local-tester.js
 * (workflow-core#5237).
 */

const { readAvailableMb, readTotalMb } = require("./meminfo.js");
const { clampedClause, reachableRung, rungMb } = require("./suite-ladder.js");
const { gateDenies, queueSeat } = require("./suite-queue.js");

/* The queue marker's role, which session admission reads (workflow-core#2416). */
const LANDER_ROLE = "lander";

/**
 * @typedef {{ok: true, spawned: () => void, release: () => void}
 *   | {ok: false, reason: string, memoryShut?: boolean}} Admission
 *   `memoryShut` where the memory limb still denied at the ceiling
 */

/**
 * One suite slot: a place in the suite queue, the suite gate open, and
 * MemAvailable at `rungMb(chargeMb)` (docs/environment.md §6, workflow-core#2416), all
 * three at once, the rung clamped to what MemTotal can supply (workflow-core#5310). Memory that cannot be read holds the slot shut. An open slot
 * is stamped admitted, so no other waiter launches beside it before its suite
 * spawns (workflow-core#2650). At the ceiling it
 * refuses on either limb: the lander then exits with no verdict, leaving the
 * batch for its next run (workflow-core#2542).
 * @param {{chargeMb: number, pollMs?: number, timeoutMs?: number,
 *   gate?: (climbMb: number) => import("./suite-queue.js").GateDenial | null,
 *   memory?: () => import("./meminfo.js").MbResult,
 *   totalMb?: () => number | null, queueDir?: string}}
 *   options `gate` answers which limb of the suite gate denies a suite, if
 *   any; the poll and ceiling default to the suite queue's
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
