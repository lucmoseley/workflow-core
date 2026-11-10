/*
 * lander-records.js — the queue lander's two record files, the pipeline
 * record and the drop record: each one's shape, its validator and its read
 * and write, side by side (#4897).
 *
 * A read takes a record any older lander wrote: a field added after a record
 * shipped is optional on read and given its default here, a field no longer
 * written and any unknown field are ignored, so the read returns the current
 * shape whatever the record's age. No field is made required after it
 * ships, and the files carry no version.
 */

const { writeFileAtomic } = require("./atomic-write.js");
const { readText } = require("./file-read.js");
const { asObject } = require("./json-shape.js");

/**
 * @typedef {import("./queue-lander.js").Verdict} Verdict
 * @typedef {import("./queue-lander.js").QueueRef} QueueRef
 * @typedef {import("./queue-lander.js").Unmerged} Unmerged
 */

/* `isolating` while each member is tested alone on `main`, `serial` while
 * members land one at a time after a collision, `requeued` done without
 * landing, `held` done on its `hold`. */
const PHASES = Object.freeze(
	/** @type {const} */ ([
		"merging",
		"testing",
		"isolating",
		"serial",
		"requeued",
		"held",
		"landed",
	]),
);

/**
 * @template T
 * @typedef {{kind: "absent"} | {kind: "torn"} | {kind: "read", value: T}}
 *   RecordRead a record file: absent, torn where it will not parse or is not
 *   the record, or read
 */

/**
 * @typedef {typeof PHASES[number]} Phase
 * @typedef {QueueRef} Member a batch member, at its snapshot sha
 * @typedef {{readonly kind: "base", readonly main: string,
 *   readonly files: readonly string[], readonly ticket: number|null,
 *   readonly retakeAt?: number}
 *   | {readonly kind: "refused", readonly main: string,
 *     readonly sha: string, readonly reason: string}} Hold why a batch
 *   stopped at `main`: red only where `main` is, on `files`, none where the
 *   red named none, with the base-red ticket, and `retakeAt`, in ms, where
 *   no run fired at `main` either; or its push of `sha` refused
 * @typedef {object} Blame what a red batch's isolation runs on
 * @property {readonly string[]} files the failing files `main` passes, none
 *   where the red named none
 * @property {readonly string[]} base the failing files `main` fails too
 * @property {readonly string[]} members the names isolated, in push order
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly iso: string}} Isolated a member merged alone onto the batch's
 *   `onto` as `iso`
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly onto: string}} Step a serial step: the member `name` merged
 *   alone onto `onto` as `sha`
 * @typedef {{readonly landed: readonly string[],
 *   readonly step: Step|null}} Serial the members landed so far, and the
 *   step under test
 * @typedef {{readonly sha: string, readonly files: readonly string[],
 *   readonly verdict: Exclude<Verdict, {kind: "unknown"}>}} BaseVerdict a
 *   base check's verdict at `main`'s `sha` on `files`, none for the whole
 *   suite
 * @typedef {object} Batch
 * @property {number} slot the k of its `lander/batch-<k>` ref, unique among
 *   the pipeline's batches
 * @property {readonly Member[]} members in push order
 * @property {readonly string[]} deferred the names of members left out, to
 *   be taken again once their deferral no longer holds them; read as none
 *   where the record has none
 * @property {readonly string[]} dropped
 * @property {string} onto the base its members were merged onto: `main`
 *   for the line's head and a search, else the integration commit of the
 *   batch ahead
 * @property {string|null} integration the commit under test, null while
 *   merging
 * @property {Phase} phase
 * @property {readonly string[]} ahead the members that form the next batch
 *   alone, ahead of newer refs
 * @property {Blame|null} blame
 * @property {readonly Isolated[]} isolated
 * @property {Serial|null} serial
 * @property {Hold|null} hold
 * @property {readonly BaseVerdict[]} bases the base checks this batch asked;
 *   read as none where the record has none
 * @typedef {object} Pipeline
 * @property {readonly Batch[]} line the batches in flight, in queue order,
 *   the head first
 * @property {Batch|null} search the red batch whose culprits are sought, or
 *   done held or re-batched, until a take or a new search replaces it
 * @property {number} depth the window: how many batches the line may hold
 * @typedef {object} PipelineRecord
 * @property {() => RecordRead<Pipeline>} read
 * @property {(p: Pipeline) => void} write
 * @typedef {{readonly kind: "red", readonly name: string,
 *   readonly files: readonly string[], readonly iso: string,
 *   readonly noRun?: true}} RedAlone red on `files` twice, none where the
 *   red named none, merged alone onto `main` as `iso`, where `main` passed
 *   them; `noRun` where no CI run fired for that tree
 * @typedef {{readonly kind: "collision", readonly name: string,
 *   readonly files: readonly string[], readonly step: string,
 *   readonly after: readonly string[], readonly noRun?: true}} Collision
 *   the serial step `step`, merging it onto `main` after the members `after`
 *   landed, red twice on `files`, none where the red named none, each member
 *   having passed alone; `noRun` where no CI run fired for that tree
 * @typedef {{readonly kind: "unrecorded", readonly name: string}} Unrecorded
 *   a dropped ref no drop record entry named
 * @typedef {Exclude<Unmerged, {kind: "stale-base"}> | RedAlone | Collision
 *   | Unrecorded} Cause
 * @typedef {object} Drop a dropped member, as the drop record holds it
 * @property {string} name after `queue/`
 * @property {string} sha
 * @property {string} ref the dropped ref holding it, after `refs/heads/`
 * @property {string} onto the `main` it was merged onto, or, for an entry
 *   written back for a ref none named, `main` when it was
 * @property {Cause} cause
 * @property {number|null} ticket its fix ticket, null until filed
 * @property {number} at when it was dropped, in ms
 * @property {number} [reapedAt] when its dropped ref was deleted, in ms
 * @typedef {object} DropRecord
 * @property {() => Drop[]} read
 * @property {(drops: readonly Drop[]) => void} write
 */

/** @param {unknown} list @returns {list is string[]} */
const isStringList = (list) =>
	Array.isArray(list) && list.every((f) => typeof f === "string");

/**
 * A field added after its record shipped: `fallback` where the record has
 * none.
 * @param {unknown} value
 * @param {unknown} fallback
 */
const orDefault = (value, fallback) => (value === undefined ? fallback : value);

/** @param {unknown} p @returns {p is Phase} */
const isPhase = (p) =>
	typeof p === "string" &&
	/** @type {readonly string[]} */ (PHASES).includes(p);

/**
 * A green row's verdict: the run that passed it and the files its in-job
 * retry cleared, its flakes (#4558), where the row names them.
 * @param {Record<string, unknown>} o
 * @returns {Verdict}
 */
const parseGreen = (o) => ({
	kind: "green",
	...(typeof o.run === "number" ? { run: o.run } : {}),
	...(isStringList(o.cleared) && o.cleared.length > 0
		? { cleared: o.cleared }
		: {}),
});

/**
 * A stored verdict where it is a green or a red, else null.
 * @param {unknown} v
 * @returns {Exclude<Verdict, {kind: "unknown"}>|null}
 */
function parseVerdict(v) {
	const o = asObject(v);
	if (o?.kind === "green")
		return /** @type {Extract<Verdict, {kind: "green"}>} */ (parseGreen(o));
	if (o?.kind === "red" && isStringList(o.files))
		return {
			kind: "red",
			files: o.files,
			...(isStringList(o.jobs) ? { jobs: o.jobs } : {}),
			/* Retried in its own run, so the lander takes no re-run (#4545). */
			...(o.retried === true ? { retried: true } : {}),
			...(o.noRun === true ? { noRun: true } : {}),
		};
	return null;
}

/** @param {unknown} b @returns {b is Blame} */
const isBlame = (b) => {
	const o = asObject(b);
	return (
		isStringList(o?.files) && isStringList(o?.base) && isStringList(o?.members)
	);
};

/** @param {unknown} i @returns {i is Isolated} */
const isIsolated = (i) => {
	const o = asObject(i);
	return (
		typeof o?.name === "string" &&
		typeof o.sha === "string" &&
		typeof o.iso === "string"
	);
};

/** @param {unknown} s @returns {s is Serial} */
const isSerial = (s) => {
	const o = asObject(s);
	const step = asObject(o?.step);
	return (
		isStringList(o?.landed) &&
		(o?.step === null ||
			(typeof step?.name === "string" &&
				typeof step.sha === "string" &&
				typeof step.onto === "string"))
	);
};

/** @param {unknown} h @returns {h is Hold} */
const isHold = (h) => {
	const o = asObject(h);
	if (typeof o?.main !== "string") return false;
	if (o.kind === "base")
		return (
			isStringList(o.files) &&
			(o.ticket === null || Number.isInteger(o.ticket)) &&
			(o.retakeAt === undefined || Number.isFinite(o.retakeAt))
		);
	return (
		o.kind === "refused" &&
		typeof o.sha === "string" &&
		typeof o.reason === "string"
	);
};

/**
 * A base check, its verdict narrowed to the fields a verdict carries.
 * @param {unknown} x
 * @returns {BaseVerdict|null}
 */
const parseBaseVerdict = (x) => {
	const o = asObject(x);
	const verdict = parseVerdict(o?.verdict);
	return typeof o?.sha === "string" && isStringList(o.files) && verdict
		? { sha: o.sha, files: o.files, verdict }
		: null;
};

/** @param {unknown} m @returns {m is Member} */
const isMember = (m) => {
	const o = asObject(m);
	return (
		typeof o?.name === "string" &&
		typeof o.sha === "string" &&
		typeof o.pushedAt === "number"
	);
};

/**
 * A batch in the current shape, or null where it is none. A field added
 * after the record shipped is read as its default where the record has none.
 * @param {unknown} parsed
 * @returns {Batch|null}
 */
function parseBatch(parsed) {
	const b = asObject(parsed);
	if (!b) return null;
	const { slot, members, onto, integration, phase, ahead, isolated } = b;
	const deferred = orDefault(b.deferred, []);
	const bases = orDefault(b.bases, []);
	const baseVerdicts = Array.isArray(bases) ? bases.map(parseBaseVerdict) : [];
	if (
		!Number.isInteger(slot) ||
		!Array.isArray(members) ||
		!members.every(isMember) ||
		typeof onto !== "string" ||
		!isStringList(deferred) ||
		!isStringList(b.dropped) ||
		!(integration === null || typeof integration === "string") ||
		!isPhase(phase) ||
		!isStringList(ahead) ||
		!(b.blame === null || isBlame(b.blame)) ||
		!Array.isArray(isolated) ||
		!isolated.every(isIsolated) ||
		!(b.serial === null || isSerial(b.serial)) ||
		!(b.hold === null || isHold(b.hold)) ||
		!Array.isArray(bases) ||
		baseVerdicts.some((x) => x === null)
	)
		return null;
	return {
		slot: /** @type {number} */ (slot),
		members,
		deferred,
		dropped: b.dropped,
		onto,
		integration,
		phase,
		ahead,
		blame: b.blame,
		isolated,
		serial: b.serial,
		hold: b.hold,
		bases: /** @type {BaseVerdict[]} */ (baseVerdicts),
	};
}

/**
 * @param {unknown} parsed
 * @returns {Pipeline|null}
 */
function parsePipeline(parsed) {
	const p = asObject(parsed);
	if (!p || !Array.isArray(p.line) || !Number.isInteger(p.depth)) return null;
	const line = p.line.map(parseBatch);
	const search = p.search === null ? null : parseBatch(p.search);
	if (line.some((b) => b === null) || (p.search !== null && search === null))
		return null;
	return {
		line: /** @type {Batch[]} */ (line),
		search,
		depth: /** @type {number} */ (p.depth),
	};
}

/** @param {unknown} u @returns {u is Cause} */
const isCause = (u) => {
	const o = asObject(u);
	if (typeof o?.name !== "string") return false;
	/** @type {Record<Cause["kind"], () => boolean>} */
	const valid = {
		conflict: () => isStringList(o.files),
		refused: () => typeof o.reason === "string",
		red: () => isStringList(o.files) && typeof o.iso === "string",
		unrecorded: () => true,
		collision: () =>
			isStringList(o.files) &&
			typeof o.step === "string" &&
			isStringList(o.after),
	};
	return Object.hasOwn(valid, String(o.kind))
		? valid[/** @type {Cause["kind"]} */ (o.kind)]()
		: false;
};

/** @param {unknown} d @returns {d is Drop} */
const isDrop = (d) => {
	const o = asObject(d);
	return (
		typeof o?.name === "string" &&
		typeof o.sha === "string" &&
		typeof o.ref === "string" &&
		typeof o.onto === "string" &&
		isCause(o.cause) &&
		(o.ticket === null || Number.isInteger(o.ticket)) &&
		Number.isFinite(o.at) &&
		(o.reapedAt === undefined || Number.isFinite(o.reapedAt))
	);
};

/**
 * A JSON record file: absent, torn where it will not parse, or its value.
 * Any other read fault throws.
 * @param {string} file
 * @returns {RecordRead<unknown>}
 */
function readRecordFile(file) {
	const r = readText(file);
	if (r.state === "absent") return { kind: "absent" };
	if (r.state === "unreadable") throw r.error;
	try {
		return { kind: "read", value: JSON.parse(r.data) };
	} catch {
		return { kind: "torn" };
	}
}

/**
 * The pipeline record: the batches a run is landing, so the next run
 * resumes them. Its read is absent, torn where the file is no pipeline, or
 * the pipeline.
 * @param {string} file
 * @returns {PipelineRecord}
 */
function pipelineRecord(file) {
	return {
		read() {
			const r = readRecordFile(file);
			if (r.kind !== "read") return r;
			const pipeline = parsePipeline(r.value);
			return pipeline ? { kind: "read", value: pipeline } : { kind: "torn" };
		},
		write(p) {
			writeFileAtomic(file, `${JSON.stringify(p)}\n`);
		},
	};
}

/**
 * The drop record's file: absent, torn where it is no list, or its drops, a
 * row that is not a drop skipped.
 * @param {string} file
 * @returns {RecordRead<Drop[]>}
 */
function readDropFile(file) {
	const r = readRecordFile(file);
	if (r.kind !== "read") return r;
	return Array.isArray(r.value)
		? { kind: "read", value: r.value.filter(isDrop) }
		: { kind: "torn" };
}

/**
 * The drop record: every dropped ref, with its fix ticket, until the queue
 * log's retention after its reap. An absent or torn record reads as none,
 * and the lander writes back the entry of each dropped ref it named from the
 * tracker.
 * @param {string} file
 * @returns {DropRecord}
 */
function dropRecord(file) {
	return {
		read() {
			const r = readDropFile(file);
			return r.kind === "read" ? r.value : [];
		},
		write(drops) {
			writeFileAtomic(file, `${JSON.stringify(drops)}\n`);
		},
	};
}

module.exports = {
	dropRecord,
	isStringList,
	parseVerdict,
	pipelineRecord,
	readDropFile,
};
