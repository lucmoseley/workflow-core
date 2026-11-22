import { createRequire } from "node:module";

const req = createRequire(__filename);

export function withStopClockLeft(modules: string[], leftMs: number) {
	const all = ["./hook-deadline.js", ...modules];
	const drop = () => {
		for (const m of all) delete req.cache[req.resolve(m)];
	};
	drop();
	const deadline = req("./hook-deadline.js");
	deadline.startEntryClock(
		"Stop",
		Date.now() +
			process.uptime() * 1000 -
			(deadline.ENTRY_BUDGET_MS.Stop - leftMs),
	);
	const loaded = modules.map((m) => req(m));
	return { loaded, drop };
}
