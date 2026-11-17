/*
 * part-suite-peak.js — what a part-suite actually draws (#5366): the rolling
 * p99 process-tree peak of the runs of its kind and file-count bucket, off the
 * run ledger (lib/run-ledger.js). Pure: the caller hands it the ledger's lines.
 *
 * The gate charges a part-suite the rung of this peak in place of the
 * ladder's busy-worker rung (lib/suite-concurrency.js), and a spawned
 * part-suite's climb on the same figure (lib/suite-queue.js `peakMbOf`).
 *
 * A LINE COUNTS only where it carries a `memory` block, a `kind` of `named` or
 * `touched`, and `wholeSlot` false, started inside the window. Red runs count.
 * A kind's lines feed only its own buckets.
 *
 * The peak is `memory.peaksMiB.sum`, MiB, charged as MB: the rung's margin
 * holds the 5% between them.
 *
 * Values, each untraced (#5348's modelling, #5366): the bucket edges, the
 * 7-day window and the 30-sample floor. p99 nearest rank is #5362's delegated
 * decision 1.
 */

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SAMPLES = 30;
const PERCENTILE = 0.99;

/** @typedef {"named" | "touched"} PartKind */

/**
 * The part-suite kind a launch route's kind is (lib/launch-route.js): null
 * for any other, `--changed`, `--adopt` or a plain script's, whose runs the
 * ledger records under their own kinds.
 * @param {unknown} kind
 * @returns {PartKind | null}
 */
const partKindOf = (kind) =>
	kind === "named" || kind === "touched" ? kind : null;

/* Inclusive upper edges by resolved file count; the last is the whole-slot
 * bound's last part-suite. */
const BUCKETS = /** @type {const} */ ([
	{ label: "1", max: 1 },
	{ label: "2-4", max: 4 },
	{ label: "5-20", max: 20 },
	{ label: "21-120", max: 120 },
]);

/**
 * The bucket a resolved file count falls in, or null outside every bucket.
 * @param {number} files
 * @returns {string | null}
 */
function bucketOf(files) {
	if (!Number.isInteger(files) || files < 1) return null;
	return BUCKETS.find((b) => files <= b.max)?.label ?? null;
}

/**
 * The nearest-rank percentile `p` of `values`, sorted or not.
 * @param {number[]} values non-empty
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
 * @typedef {{ p99Mb: number, samples: number, bucket: string }} PartPeak
 */

/**
 * Why a part-suite was judged on the ladder (#5366): its bucket holds too few
 * runs, the ledger would not read, the tripwire is tripped or its journal
 * would not read (lib/peak-tripwire.js), a touched run's selection is
 * unresolved, so it has no bucket, or its kind cannot be told (`partKindOf`).
 * @typedef {"thin" | "unread" | "tripped" | "journal-unread" | "unsized" | "untold"} LadderCause
 */

/**
 * How a part-suite was admitted, on the ledger line and the queue's exit
 * record: its own peak's rung, or the ladder's and why. `rungMb` is the rung
 * charged and `climbMb` the climb charged beside it.
 * @typedef {{ mode: "peak", kind: PartKind, bucket: string, p99Mb: number, rungMb: number, climbMb: number, samples: number }
 *   | { mode: "ladder", cause: LadderCause, kind?: PartKind, bucket?: string, rungMb: number, climbMb: number }} PartAdmission
 */

/**
 * What a deny or a wait names of a peak charge.
 * @typedef {Pick<Extract<PartAdmission, { mode: "peak" }>, "kind" | "bucket" | "p99Mb" | "samples">} PeakCharge
 */

/**
 * @param {PeakCharge} peak
 */
const peakClause = ({ kind, bucket, p99Mb, samples }) =>
	`a ${kind} part-suite of ${bucket} file(s), whose p99 peak over ${samples} runs in 7 days is ${p99Mb} MB (#5366)`;

/**
 * The peak a run of `kind` resolving to `files` test files is charged, off
 * the lines of the 7 days before `now`; null where its bucket holds fewer
 * than MIN_SAMPLES runs or `files` falls in none.
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
		p99Mb: nearestRank(peaks, PERCENTILE),
		samples: peaks.length,
		bucket,
	};
}

module.exports = {
	bucketOf,
	partKindOf,
	partSuitePeak,
	peakClause,
};
