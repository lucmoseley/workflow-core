/*
 * A started Stop clock for a test (#4115). hook-deadline.js keeps its clock as
 * module state, so a case that starts one loads its own copies of the modules
 * that read it, and drops them after.
 */

import { createRequire } from "node:module";

const req = createRequire(__filename);

/**
 * Fresh copies of `modules`, each a path relative to scripts/lib/, reading a
 * Stop clock with `leftMs` of its budget left.
 */
export function withStopClockLeft(modules: string[], leftMs: number) {
	const all = ["./hook-deadline.js", ...modules];
	const drop = () => {
		for (const m of all) delete req.cache[req.resolve(m)];
	};
	drop();
	const deadline = req("./hook-deadline.js");
	/* startEntryClock dates the start back by the process's uptime; adding it
	 * here puts the start `budget - leftMs` ago. */
	deadline.startEntryClock(
		"Stop",
		Date.now() +
			process.uptime() * 1000 -
			(deadline.ENTRY_BUDGET_MS.Stop - leftMs),
	);
	// biome-ignore lint/suspicious/noExplicitAny: CJS modules have no types to import
	const loaded: any[] = modules.map((m) => req(m));
	return { loaded, drop };
}
