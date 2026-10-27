/*
 * allowance.js — the shared reader `dispatch-sessions.sh`'s gate and
 * `admission.js`'s per-spawn re-read both want (#293, #294).
 *
 * Reads `cachedUsageUtilization.utilization.limits`, through
 * `usage-cache.js`, out of `.claude.json` under `lib/config-dir.js`'s dir, matching
 * `kind: "session"` for the 5-hour bar and `kind: "weekly_all"` for the week
 * bar (#280). Falls back, per bar, to a printed `claude -p "/usage"`
 * transcript when the JSON reading for that bar is not `fresh`.
 *
 * Returns raw figures and a TRUST verdict, never a ceiling verdict (#293
 * ruling 2): each caller owns its own ceilings and its own refusal text.
 */

const { configDir: defaultConfigDir } = require("./config-dir.js");
const { hasResetPassed, readUsageCache } = require("./usage-cache.js");
const { requiredGroup } = require("./regex-group.js");

/** A usage line's share used, as a whole percent. */
const USED_RE = /([0-9]+)% used/;
/** A usage line's reset time, to the end of the line. */
const RESETS_RE = /resets (.*)$/;

/** A cached reading older than this is stale (#280 ruling 3). */
const STALE_MS = 5 * 60 * 1000;

/** @typedef {{ percent: number, severity: string | null, resetsAt: string | null, fetchedAtMs: number | null }} RawBar */
/** @typedef {{ percent: number | null, severity: string | null, resetsAt: string | null, fetchedAtMs: number | null, trust: "fresh" | "stale" | "absent" }} Bar */

const KINDS = /** @type {const} */ ({
	session: { kind: "session", textPrefix: "Current session:" },
	weekly_all: { kind: "weekly_all", textPrefix: "Current week (all models):" },
});

/**
 * Both non-`ok` cache states read as no bar, so `trustOf` calls it ABSENT —
 * never a thrown error, since this runs on the dispatch path (#377 ruling 3).
 * @param {import("./usage-cache.js").UsageCache} cache
 * @param {string} kind
 * @returns {RawBar | null}
 */
function barFromCache(cache, kind) {
	if (cache.state !== "ok") return null;
	const limit = cache.bars.find((l) => l.kind === kind);
	if (!limit || limit.percent === null) return null;
	return {
		percent: limit.percent,
		severity: limit.severity,
		resetsAt: limit.resetsAt,
		fetchedAtMs: cache.fetchedAtMs,
	};
}

/**
 * Whether a JSON-sourced bar is trustworthy: its cache stamp is under 5
 * minutes old AND its own `resetsAt` has not already passed (#280 ruling 3).
 * A bar with no `fetchedAtMs` at all reads as stale rather than fresh.
 * @param {RawBar | null} bar
 * @param {number} now
 * @returns {"fresh" | "stale" | "absent"}
 */
function trustOf(bar, now) {
	if (!bar) return "absent";
	if (typeof bar.fetchedAtMs !== "number") return "stale";
	if (now - bar.fetchedAtMs > STALE_MS) return "stale";
	if (hasResetPassed(bar.resetsAt, now)) return "stale";
	return "fresh";
}

/**
 * The one bar's worth of the printed `claude -p "/usage"` transcript. A
 * live parse reads as FRESH: the text just came off a call that ran seconds
 * ago, so there is no separate age to judge.
 * @param {string} usageText
 * @param {string} textPrefix
 * @returns {RawBar | null}
 */
function parseBar(usageText, textPrefix) {
	for (const line of usageText.split("\n")) {
		if (!line.includes(textPrefix)) continue;
		const m = line.match(USED_RE);
		if (!m) continue;
		const resetsMatch = line.match(RESETS_RE);
		return {
			percent: Number(requiredGroup(m, 1, USED_RE)),
			severity: null,
			resetsAt: resetsMatch ? requiredGroup(resetsMatch, 1, RESETS_RE) : null,
			fetchedAtMs: null,
		};
	}
	return null;
}

/**
 * No automatic retry — reaching `absent` here means something is genuinely
 * wrong, not momentarily absent.
 *
 * @param {{ configDir?: string, usageText?: string, now?: number }} [opts]
 * @returns {{ session: Bar, weekly_all: Bar }}
 */
function readAllowance(opts = {}) {
	const {
		configDir = defaultConfigDir(),
		usageText = "",
		now = Date.now(),
	} = opts;
	const cache = readUsageCache(configDir);
	/** @param {"session" | "weekly_all"} kind @param {string} textPrefix @returns {Bar} */
	const readOne = (kind, textPrefix) => {
		const jsonBar = barFromCache(cache, kind);
		const jsonTrust = trustOf(jsonBar, now);
		if (jsonBar && jsonTrust === "fresh") return { ...jsonBar, trust: "fresh" };
		const textBar = parseBar(usageText, textPrefix);
		if (textBar) return { ...textBar, trust: "fresh" };
		return jsonBar
			? { ...jsonBar, trust: jsonTrust }
			: {
					percent: null,
					severity: null,
					resetsAt: null,
					fetchedAtMs: null,
					trust: "absent",
				};
	};
	const result = {
		session: readOne(KINDS.session.kind, KINDS.session.textPrefix),
		weekly_all: readOne(KINDS.weekly_all.kind, KINDS.weekly_all.textPrefix),
	};
	return result;
}

/*
 * Bar points per dollar of list-price spend (#370). Updated BY HAND from
 * `scripts/measure-points-per-usd.js`, which prints one rate per seat and bar
 * and writes nothing (#380): each is a single snapshot, and which to trust is
 * a judgement.
 */
const POINTS_PER_USD = /** @type {const} */ ({
	session: 0.47,
	weekly_all: 0.054,
});

/** @typedef {"session" | "weekly_all"} BarKey */

/**
 * Whether a bar is at or past its threshold, where the cap applies.
 * @param {BarKey} bar
 * @param {Record<BarKey, number>} readings
 * @param {Record<BarKey, number>} thresholds
 */
const isWarned = (bar, readings, thresholds) =>
	readings[bar] >= thresholds[bar];

/**
 * @typedef {object} BarCap
 * @property {BarKey} bar
 * @property {number} reading
 * @property {number} threshold
 * @property {number} runningPoints  projected remaining spend of sessions already running
 * @property {number} perSessionPoints
 * @property {number} fits  members that just reach 100% of the bar, at least one under 100%
 */

/**
 * How many of `members` launch. Per bar at or past its threshold, headroom is
 * 100 − reading − running sessions' projected spend, and the members that fit
 * are the shortest prefix whose cumulative spend reaches it — X =
 * ceil(headroom / figure), so the allowance is spent to the limit. A bar reading under 100% has room by definition,
 * so it launches at least one even where the running sessions' projection
 * fills the headroom; only a bar at 100% launches none. Both reverse
 * #371's X−1, the ruling recorded there. Residual:
 * the last member under X, and any member on the floor, is projected past
 * 100% and may hit the rate limit mid-work; each dispatch call applies the
 * floor afresh. The products are compared with a tolerance, so a rounding
 * error never buys a member past X. The smaller count across warned bars
 * binds; below both thresholds the whole set launches. The prefix is the set's
 * own order, `/pick-next` §4's, with no skip-ahead (#371 items 3-4).
 * `floored` is true where the launch is the floor's member alone, which the
 * refill loop reads as none (#2425).
 *
 * @param {{ readings: Record<BarKey, number>, thresholds: Record<BarKey, number>, members: number, runningPoints: Record<BarKey, number>, perSessionPoints: Record<BarKey, number> }} opts
 * @returns {{ launch: number, floored: boolean, binding: BarCap | null, warned: BarCap[] }}
 */
function capSet({
	readings,
	thresholds,
	members,
	runningPoints,
	perSessionPoints,
}) {
	/** @type {BarCap[]} */
	const warned = [];
	let floored = false;
	for (const bar of /** @type {BarKey[]} */ (["session", "weekly_all"])) {
		if (!isWarned(bar, readings, thresholds)) continue;
		const headroom = 100 - readings[bar] - runningPoints[bar];
		const figure = perSessionPoints[bar];
		let fits = 0;
		while (fits < members && fits * figure < headroom - 1e-9) fits++;
		if (fits === 0 && members > 0 && readings[bar] < 100) {
			fits = 1;
			floored = true;
		}
		warned.push({
			bar,
			reading: readings[bar],
			threshold: thresholds[bar],
			runningPoints: runningPoints[bar],
			perSessionPoints: figure,
			fits,
		});
	}
	const binding = warned.reduce(
		(/** @type {BarCap | null} */ min, b) =>
			!min || b.fits < min.fits ? b : min,
		null,
	);
	const launch = binding ? binding.fits : members;
	return { launch, floored: floored && launch > 0, binding, warned };
}

module.exports = {
	readAllowance,
	capSet,
	isWarned,
	POINTS_PER_USD,
};
