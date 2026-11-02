/*
 * The refill loop's fixtures its pure-core tests share (#2012, #3370): a
 * clock, three checkout roots, a scope in each mode and a launch record.
 */
import fs from "node:fs";
import path from "node:path";

export const MIN = 60 * 1000;
export const NOW = Date.parse("2026-10-18T12:00:00Z");

export const WFC = "/home/u/workflow-core";
export const MH = "/home/u/mantahostels";
export const DV = "/home/u/design-vault";

export const normal = (
	repos: string[],
	goals: Record<string, number[]> = {},
) => ({
	mode: "normal" as const,
	repos,
	goals,
});
export const away = (
	repos: string[],
	goals: Record<string, number[]> = {},
) => ({
	mode: "away" as const,
	repos,
	goals,
});

/** A main checkout in `home` carrying a workflow-core config; its root. */
export function writeCheckout(
	home: string,
	name: string,
	config: Record<string, unknown> = {},
) {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		`${JSON.stringify(config)}\n`,
	);
	return root;
}

export function record(over: Record<string, unknown> = {}) {
	return {
		root: "/home/u/design-vault",
		issues: [42],
		prompt: "/implement 42",
		seat: "/home/u/.claude3",
		jobId: "job42",
		launchedAt: NOW - 10 * MIN,
		finishedAt: null,
		...over,
	};
}

export type Launch = import("./refill-loop.js").LoopLaunch;
