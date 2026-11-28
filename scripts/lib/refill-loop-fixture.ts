import fs from "node:fs";
import path from "node:path";
import { FULL } from "./refill-decide.js";
import type { LoopState, Transition } from "./refill-state.js";

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

export const row = (
	root: string,
	number: number,
	takes = "implement",
	over: Record<string, unknown> = {},
) => ({
	root,
	number,
	bug: false,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	depth: 0,
	closes: 0,
	agePoints: 0,
	reach: 0,
	collision: "comment-only",
	takes: [takes],
	labels: [`takes:${takes}`],
	...over,
});

export const seat = (
	name: string,
	week: number | null,
	session: number | null,
) => ({
	seat: name,
	week,
	session,
	weekFull: week !== null && week >= FULL,
	sessionFull: session !== null && session >= FULL,
	sessionResets: null,
	weekResets: null,
	readAt: NOW,
	weekRead: { percent: null, atMs: null },
});

export function stateFileFake(initial: LoopState, writes: LoopState[]) {
	let onDisk = initial;
	return (transition: Transition) => {
		const next = transition(onDisk);
		if (next !== onDisk) writes.push(next);
		onDisk = next;
		return onDisk;
	};
}
