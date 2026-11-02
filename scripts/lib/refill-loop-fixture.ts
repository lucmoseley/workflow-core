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

interface FixtureGoal {
	form: "issues" | "drain" | "unblock" | "topic";
	text: string;
	refs: { repo: string; number: number }[];
	setAt: number;
}

/** An `issues` goal naming `refs`, each `[repo, number]`. */
export const issuesGoal = (...refs: [string, number][]): FixtureGoal => ({
	form: "issues",
	text: refs.map(([repo, number]) => `${repo}#${number}`).join(","),
	refs: refs.map(([repo, number]) => ({ repo, number })),
	setAt: NOW,
});

export const normal = (repos: string[], goal: FixtureGoal | null = null) => ({
	mode: "normal" as const,
	repos,
	goal,
});
export const away = (repos: string[], goal: FixtureGoal | null = null) => ({
	mode: "away" as const,
	repos,
	goal,
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
