const { configDir: defaultConfigDir } = require("./config-dir.js");
const { hasResetPassed, readUsageCache } = require("./usage-cache.js");
const { requiredGroup } = require("./regex-group.js");

const USED_RE = /(?<![0-9])([0-9]+)% used/;
const RESETS_RE = /resets (.*)$/;

// guess, workflow-core#280
const STALE_MS = 5 * 60 * 1000;

/** @typedef {{ percent: number, severity: string | null, resetsAt: string | null, fetchedAtMs: number | null }} RawBar */
/** @typedef {{ percent: number | null, severity: string | null, resetsAt: string | null, fetchedAtMs: number | null, trust: Trust }} Bar */
/** @typedef {"fresh" | "stale" | "absent" | "unreported"} Trust */

const KINDS = /** @type {const} */ ({
	session: { kind: "session", textPrefix: "Current session:" },
	weekly_all: { kind: "weekly_all", textPrefix: "Current week (all models):" },
});

/**
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
		if (jsonBar) return { ...jsonBar, trust: jsonTrust };
		return {
			percent: null,
			severity: null,
			resetsAt: null,
			fetchedAtMs: null,
			trust: isUnreported(kind) ? "unreported" : "absent",
		};
	};
	/** @param {"session" | "weekly_all"} kind */
	const isUnreported = (kind) => {
		const others = Object.values(KINDS).filter((k) => k.kind !== kind);
		if (
			cache.state === "ok" &&
			!cache.bars.some((l) => l.kind === kind) &&
			others.some((k) => trustOf(barFromCache(cache, k.kind), now) === "fresh")
		)
			return true;
		return (
			!usageText.includes(KINDS[kind].textPrefix) &&
			others.some((k) => parseBar(usageText, k.textPrefix) !== null)
		);
	};
	const result = {
		session: readOne(KINDS.session.kind, KINDS.session.textPrefix),
		weekly_all: readOne(KINDS.weekly_all.kind, KINDS.weekly_all.textPrefix),
	};
	return result;
}

/** @param {string} usageText */
const printsWeek = (usageText) =>
	parseBar(usageText, KINDS.weekly_all.textPrefix) !== null;

/** @param {{ session: Bar, weekly_all: Bar }} result */
function isTrustworthy(result) {
	const bars = [result.session, result.weekly_all];
	return (
		bars.every((b) => b.trust === "fresh" || b.trust === "unreported") &&
		bars.some((b) => b.trust === "fresh")
	);
}

/**
 * @param {Bar} bar
 * @returns {number | null}
 */
function sizedPercent(bar) {
	if (bar.trust === "unreported") return 0;
	return bar.trust === "fresh" ? bar.percent : null;
}

// measured, workflow-core#380
const POINTS_PER_USD = /** @type {const} */ ({
	session: 0.47,
	weekly_all: 0.054,
});

/** @typedef {"session" | "weekly_all"} BarKey */

/**
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
 * @property {number} runningPoints
 * @property {number} perSessionPoints
 * @property {number} fits
 */

/**
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
	isTrustworthy,
	printsWeek,
	sizedPercent,
	capSet,
	isWarned,
	POINTS_PER_USD,
	STALE_MS,
};
