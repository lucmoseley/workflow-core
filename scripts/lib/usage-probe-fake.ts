import fs from "node:fs";
import path from "node:path";
import { SESSION_PREFIX, type SessionBar } from "./session-bar-carry.js";
import { shellQuote } from "./sh-quote.js";

interface Limit {
	kind: string;
	percent: Percent;
	resets_at: string;
	[key: string]: unknown;
}

export const recorded: {
	harness: string;
	refreshedAfterMs: number;
	printed: string[];
	cache: {
		fetchedAtMs: number;
		accountUuid: string;
		utilization: { limits: Limit[] };
	};
	sessionBar?: SessionBar & { limit: Limit };
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "usage-probe.json"),
		"utf8",
	),
);

export const printedLines = [
	...recorded.printed,
	...(recorded.sessionBar ? [recorded.sessionBar.printed] : []),
];
export const recordedLimits = [
	...recorded.cache.utilization.limits,
	...(recorded.sessionBar ? [recorded.sessionBar.limit] : []),
];

type Percent = number | string;

export interface Bars {
	session?: Percent;
	week?: Percent;
}

type Kind = "session" | "weekly_all";

const PREFIX: Record<Kind, string> = {
	session: SESSION_PREFIX,
	weekly_all: "Current week (all models):",
};

const USED = /(?<![0-9])[0-9]+% used/;

function printedLine(kind: Kind, percent: Percent): string {
	const line = printedLines.find((l) => l.startsWith(PREFIX[kind]));
	if (!line)
		throw new Error(`${recorded.harness} printed no "${PREFIX[kind]}" line`);
	return line.replace(USED, `${percent}% used`);
}

export const printedResets = {
	session: printedLine("session", 0).replace(/^.*resets /, ""),
	week: printedLine("weekly_all", 0).replace(/^.*resets /, ""),
};

const byKind = (bars: Bars): [Kind, Percent][] =>
	(
		[
			["session", bars.session],
			["weekly_all", bars.week],
		] as const
	).filter((e): e is [Kind, Percent] => e[1] !== undefined);

export function buildUsageText(bars: Bars): string {
	return byKind(bars)
		.map(([kind, percent]) => `${printedLine(kind, percent)}\n`)
		.join("");
}

export function buildUsageBranch(bars: Bars): string {
	return `printf '%s' ${shellQuote(buildUsageText(bars))}`;
}

const WINDOW_MS: Record<Kind, number> = {
	session: 5 * 60 * 60 * 1000,
	weekly_all: 7 * 24 * 60 * 60 * 1000,
};

export function recordedLimit(kind: string): Limit {
	const limit = recordedLimits.find((l) => l.kind === kind);
	if (!limit) throw new Error(`${recorded.harness} cached no "${kind}" bar`);
	return limit;
}

function limitOf(
	kind: Kind,
	percent: Percent,
	fetchedAtMs: number,
	resetsAt: string | undefined,
): Limit {
	return {
		...recordedLimit(kind),
		percent,
		resets_at:
			resetsAt ?? new Date(fetchedAtMs + WINDOW_MS[kind]).toISOString(),
	};
}

export interface ScopedBar {
	model: string;
	percent: number;
	resetsAt: string;
	severity?: string;
}

function scopedLimitOf(bar: ScopedBar): Limit {
	const limit = recordedLimit("weekly_scoped");
	const scope = limit.scope as { model?: Record<string, unknown> } | null;
	if (!scope?.model)
		throw new Error(`${recorded.harness} cached no scoped model on its bar`);
	return {
		...limit,
		percent: bar.percent,
		severity: bar.severity ?? limit.severity,
		resets_at: bar.resetsAt,
		scope: { ...scope, model: { ...scope.model, display_name: bar.model } },
	};
}

export interface CacheOptions {
	resetsAt?: { session?: string; week?: string };
	accountUuid?: string;
	scoped?: ScopedBar[];
}

export function buildUsageCache(
	bars: Bars,
	fetchedAtMs: number,
	{ resetsAt = {}, accountUuid, scoped = [] }: CacheOptions = {},
): { cachedUsageUtilization: typeof recorded.cache } {
	const resetOf: Record<Kind, string | undefined> = {
		session: resetsAt.session,
		weekly_all: resetsAt.week,
	};
	return {
		cachedUsageUtilization: {
			...recorded.cache,
			accountUuid: accountUuid ?? recorded.cache.accountUuid,
			fetchedAtMs,
			utilization: {
				limits: [
					...byKind(bars).map(([kind, percent]) =>
						limitOf(kind, percent, fetchedAtMs, resetOf[kind]),
					),
					...scoped.map(scopedLimitOf),
				],
			},
		},
	};
}

export function buildRefreshLine(bars: Bars, target: string): string {
	const now = Date.now();
	const [head, tail] = JSON.stringify(buildUsageCache(bars, now)).split(
		`"fetchedAtMs":${now}`,
	);
	if (tail === undefined) {
		throw new Error("no fetchedAtMs stamp in the usage cache to re-stamp");
	}
	return `printf '%s%s%s' ${shellQuote(`${head}"fetchedAtMs":`)} "$(($(date +%s%N) / 1000000))" ${shellQuote(tail)} > ${target}`;
}

export function buildRefreshBranch(configDir: string, bars: Bars): string[] {
	return [
		`mkdir -p ${shellQuote(configDir)}`,
		buildRefreshLine(bars, shellQuote(path.join(configDir, ".claude.json"))),
	];
}
