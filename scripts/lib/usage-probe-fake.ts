/*
 * The fake of `claude -p "/usage"`: the bar lines it prints and the seat
 * cache it rewrites, as the installed harness's recording
 * (scripts/fixtures/usage-probe.json, re-recorded by `node
 * scripts/record-claude-responses.js`) holds them, with a case's own
 * percents (#3266).
 */

import fs from "node:fs";
import path from "node:path";

interface Limit {
	kind: string;
	percent: Percent;
	resets_at: string;
	[key: string]: unknown;
}

export const recorded: {
	harness: string;
	/** How long after the probe's start the seat's cache stamp moved. */
	refreshedAfterMs: number;
	printed: string[];
	cache: {
		fetchedAtMs: number;
		accountUuid: string;
		utilization: { limits: Limit[] };
	};
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "usage-probe.json"),
		"utf8",
	),
);

/** A bar's percent; a string lets a case print one no parse reads. */
type Percent = number | string;

/** The two bars lib/allowance.js reads; an absent one is neither printed
 * nor cached. */
export interface Bars {
	session?: Percent;
	week?: Percent;
}

type Kind = "session" | "weekly_all";

const PREFIX: Record<Kind, string> = {
	session: "Current session:",
	weekly_all: "Current week (all models):",
};

const USED = /[0-9]+% used/;

/** The recorded line of `kind`'s bar, reading `percent`. */
function printedLine(kind: Kind, percent: Percent): string {
	const line = recorded.printed.find((l) => l.startsWith(PREFIX[kind]));
	if (!line)
		throw new Error(`${recorded.harness} printed no "${PREFIX[kind]}" line`);
	return line.replace(USED, `${percent}% used`);
}

/** The reset time each printed bar names, as a refusal quotes it. */
export const printedResets = {
	session: printedLine("session", 0).replace(/^.*resets /, ""),
	week: printedLine("weekly_all", 0).replace(/^.*resets /, ""),
};

/** The bars `bars` gives, keyed by the kind the harness names them. */
const byKind = (bars: Bars): [Kind, Percent][] =>
	(
		[
			["session", bars.session],
			["weekly_all", bars.week],
		] as const
	).filter((e): e is [Kind, Percent] => e[1] !== undefined);

/** What the probe prints, as far as lib/allowance.js reads it. */
export function buildUsageText(bars: Bars): string {
	return byKind(bars)
		.map(([kind, percent]) => `${printedLine(kind, percent)}\n`)
		.join("");
}

export function buildUsageBranch(bars: Bars): string {
	return `printf '%s' '${buildUsageText(bars)}'`;
}

/* Each bar's window, so a written bar resets after its stamp; any offset
 * longer than a case runs would do. */
const WINDOW_MS: Record<Kind, number> = {
	session: 5 * 60 * 60 * 1000,
	weekly_all: 7 * 24 * 60 * 60 * 1000,
};

/** The recording's cached bar of `kind`. */
export function recordedLimit(kind: string): Limit {
	const limit = recorded.cache.utilization.limits.find((l) => l.kind === kind);
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

/** One `weekly_scoped` bar: a model's own weekly allowance, which
 * lib/seat-utilisation.js reads (#304, #3282). */
export interface ScopedBar {
	model: string;
	percent: number;
	resetsAt: string;
	severity?: string;
}

/** The recorded `weekly_scoped` bar, renamed to `bar`'s model and reading
 * its percent; its severity is the recorded one unless `bar` names one. */
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

/** A seat's `.claude.json`, holding a usage cache stamped `fetchedAtMs` with
 * the bars given. */
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

/** A bash stub line writing `buildUsageCache(bars)` to `file`, a bash word,
 * stamped when it runs, as the probe's refresh does. */
export function buildRefreshLine(bars: Bars, file: string): string {
	const now = Date.now();
	const [head, tail] = JSON.stringify(buildUsageCache(bars, now)).split(
		`"fetchedAtMs":${now}`,
	);
	return `printf '%s%s%s' '${head}"fetchedAtMs":' "$(($(date +%s%N) / 1000000))" '${tail}' > ${file}`;
}

export function buildRefreshBranch(configDir: string, bars: Bars): string[] {
	return [
		`mkdir -p '${configDir}'`,
		buildRefreshLine(bars, `'${path.join(configDir, ".claude.json")}'`),
	];
}
