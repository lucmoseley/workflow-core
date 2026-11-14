/*
 * precommit-arm.js — whether a pre-commit dispatcher row's arm arms on a
 * commit's staged paths (#5172): the one rule lib/precommit-dispatch.js runs
 * and the equivalence contract's fixtures are held to (#5195).
 */

/**
 * Whether `arm` arms on `staged`, `list` being its computed list's paths.
 * @param {import("./precommit-dispatch.js").Arm} arm
 * @param {import("./precommit-dispatch.js").StagedEntry[]} staged
 * @param {string[]} list
 * @param {(path: string) => boolean} exists
 */
function armed(arm, staged, list, exists) {
	if ("always" in arm) return true;
	const computed = new Set(list);
	if (staged.some((e) => computed.has(e.path))) return true;
	if (!("pattern" in arm)) return false;
	return staged.some(
		(e) =>
			arm.pattern.test(e.path) &&
			(!arm.live || ((e.status === "A" || e.status === "M") && exists(e.path))),
	);
}

module.exports = { armed };
