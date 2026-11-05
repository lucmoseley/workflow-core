/*
 * A suite slot for lib/local-tester.js's `admit`, granting every ask at once
 * and logging, in order, each `hold`, each `spawned` and each `release`.
 */

export const admitted = () => {
	const log: string[] = [];
	return {
		log,
		admit: async () => {
			log.push("hold");
			return {
				ok: true as const,
				spawned: () => log.push("spawned"),
				release: () => log.push("release"),
			};
		},
	};
};

/** The most slots `log` shows held at once. */
export const peakHeld = (log: string[]) => {
	let held = 0;
	let peak = 0;
	for (const at of log) {
		if (at === "hold") held += 1;
		if (at === "release") held -= 1;
		peak = Math.max(peak, held);
	}
	return peak;
};
