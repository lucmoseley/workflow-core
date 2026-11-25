const DAY_MS = 24 * 60 * 60 * 1000;
// guess, workflow-core#5366
const WINDOW_MS = 7 * DAY_MS;
const MIN_SAMPLES = 30;
// guess, workflow-core#5362
const PERCENTILE = 0.99;

/** @typedef {"named" | "touched"} PartKind */

/**
 * @param {unknown} kind
 * @returns {PartKind | null}
 */
const partKindOf = (kind) =>
	kind === "named" || kind === "touched" ? kind : null;

/**
 * @param {{ kind: string, source: string } | null | undefined} route
 * @returns {PartKind | null}
 */
const partKindOfRoute = (route) =>
	!route || route.source === "adopt" ? null : partKindOf(route.kind);

// guess, workflow-core#5366
const BUCKETS = /** @type {const} */ ([
	{ label: "1", max: 1 },
	{ label: "2-4", max: 4 },
	{ label: "5-20", max: 20 },
	{ label: "21-120", max: 120 },
]);

/**
 * @param {number} files
 * @returns {string | null}
 */
function bucketOf(files) {
	if (!Number.isInteger(files) || files < 1) return null;
	return BUCKETS.find((b) => files <= b.max)?.label ?? null;
}

/**
 * @param {number[]} values
 * @param {number} p
 */
function nearestRank(values, p) {
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil(p * sorted.length));
	return /** @type {number} */ (sorted[rank - 1]);
}

/**
 * @typedef {{ kind?: unknown, wholeSlot?: unknown, resolvedFiles?: unknown,
 *   startedAt?: unknown, at?: unknown,
 *   memory?: { peaksMiB?: { sum?: unknown } } | null }} LedgerLine
 * @typedef {{ kind: PartKind, p99Mb: number, samples: number, bucket: string }} PartPeak
 */

/** @typedef {import("./peak-tripwire.js").Fallback["cause"] | "thin" | "unread" | "unsized" | "untold"} LadderCause */

/**
 * @typedef {{ mode: "peak", kind: PartKind, bucket: string, p99Mb: number, rungMb: number, climbMb: number, samples: number }
 *   | { mode: "ladder", cause: LadderCause, kind?: PartKind, bucket?: string, rungMb: number, climbMb: number }} PartAdmission
 */

/** @typedef {Pick<Extract<PartAdmission, { mode: "peak" }>, "kind" | "bucket" | "p99Mb" | "samples">} PeakCharge */

/**
 * @param {PeakCharge} peak
 */
const peakClause = ({ kind, bucket, p99Mb, samples }) =>
	`a ${kind} part-suite of ${bucket} file(s), whose p99 peak over ${samples} runs in ${WINDOW_MS / DAY_MS} days is ${p99Mb} MB (workflow-core#5366)`;

/**
 * @param {readonly LedgerLine[]} lines
 * @param {{ kind: PartKind, files: number, now: number }} run
 * @returns {PartPeak | null}
 */
function partSuitePeak(lines, { kind, files, now }) {
	const bucket = bucketOf(files);
	if (bucket === null) return null;
	const since = now - WINDOW_MS;
	/** @type {number[]} */
	const peaks = [];
	for (const line of lines) {
		if (line.kind !== kind || line.wholeSlot !== false) continue;
		const sum = line.memory?.peaksMiB?.sum;
		if (typeof sum !== "number" || !Number.isFinite(sum)) continue;
		if (bucketOf(Number(line.resolvedFiles)) !== bucket) continue;
		const started = Date.parse(String(line.startedAt ?? line.at));
		if (!(started >= since && started <= now)) continue;
		peaks.push(sum);
	}
	if (peaks.length < MIN_SAMPLES) return null;
	return {
		kind,
		p99Mb: nearestRank(peaks, PERCENTILE),
		samples: peaks.length,
		bucket,
	};
}

module.exports = {
	bucketOf,
	partKindOf,
	partKindOfRoute,
	partSuitePeak,
	peakClause,
};
