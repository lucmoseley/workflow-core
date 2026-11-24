const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { asObject } = require("./json-shape.js");

/**
 * @typedef {import("./queue-lander.js").Verdict} Verdict
 * @typedef {import("./queue-lander.js").QueueRef} QueueRef
 * @typedef {import("./queue-lander.js").Unmerged} Unmerged
 */

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
 * @typedef {{kind: "absent"} | {kind: "torn"} | {kind: "read", value: T}} RecordRead
 */

/**
 * @typedef {typeof PHASES[number]} Phase
 * @typedef {QueueRef} Member
 * @typedef {{readonly kind: "base", readonly main: string,
 *   readonly files: readonly string[], readonly ticket: number|null,
 *   readonly retakeAt?: number}
 *   | {readonly kind: "refused", readonly main: string,
 *     readonly sha: string, readonly reason: string}} Hold
 * @typedef {object} Blame
 * @property {readonly string[]} files
 * @property {readonly string[]} base
 * @property {readonly string[]} members
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly iso: string}} Isolated
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly onto: string}} Step
 * @typedef {{readonly landed: readonly string[],
 *   readonly step: Step|null}} Serial
 * @typedef {{readonly sha: string, readonly files: readonly string[],
 *   readonly verdict: Exclude<Verdict, {kind: "unknown"}>}} BaseVerdict
 * @typedef {object} Batch
 * @property {number} slot
 * @property {readonly Member[]} members
 * @property {readonly string[]} deferred
 * @property {readonly string[]} dropped
 * @property {string} onto
 * @property {string|null} integration
 * @property {Phase} phase
 * @property {readonly string[]} ahead
 * @property {Blame|null} blame
 * @property {readonly Isolated[]} isolated
 * @property {Serial|null} serial
 * @property {Hold|null} hold
 * @property {readonly BaseVerdict[]} bases
 * @typedef {object} Pipeline
 * @property {readonly Batch[]} line
 * @property {Batch|null} search
 * @property {number} depth
 * @typedef {object} PipelineRecord
 * @property {() => RecordRead<Pipeline>} read
 * @property {(p: Pipeline) => void} write
 * @property {() => string} quarantine
 * @typedef {{readonly file: string, readonly test: string,
 *   readonly message: string}} QuotedFailure
 * @typedef {{readonly noRun?: true,
 *   readonly typecheck?: readonly string[],
 *   readonly runs?: readonly number[],
 *   readonly failures?: readonly QuotedFailure[]}} RedMarks
 * @typedef {{readonly kind: "red", readonly name: string,
 *   readonly files: readonly string[], readonly iso: string,
 *   readonly mainRun?: number} & RedMarks} RedAlone
 * @typedef {{readonly kind: "collision", readonly name: string,
 *   readonly files: readonly string[], readonly step: string,
 *   readonly after: readonly string[]} & RedMarks} Collision
 * @typedef {{readonly kind: "unrecorded", readonly name: string}} Unrecorded
 * @typedef {Exclude<Unmerged, {kind: "stale-base"}> | RedAlone | Collision
 *   | Unrecorded} Cause
 * @typedef {"open" | "settled" | "ticketed"} DropState
 * @typedef {object} Drop
 * @property {string} name
 * @property {string} sha
 * @property {string} ref
 * @property {string} onto
 * @property {Cause} cause
 * @property {number|null} ticket
 * @property {number} at
 * @property {DropState} state
 * @property {number} decidedAt
 * @property {string} [settledOn]
 * @property {string} [filingRefused]
 * @property {number} [reapedAt]
 * @typedef {object} DropRecord
 * @property {() => Drop[]} read
 * @property {(drops: readonly Drop[]) => void} write
 */

/** @param {unknown} list @returns {list is string[]} */
const isStringList = (list) =>
	Array.isArray(list) && list.every((f) => typeof f === "string");

/** @param {unknown} list @returns {list is number[]} */
const isNumberList = (list) =>
	Array.isArray(list) && list.every((n) => typeof n === "number");

/**
 * @param {Record<string, unknown>|null} o
 * @returns {o is {file: string, test: string} & Record<string, unknown>}
 */
const isFailingTest = (o) =>
	typeof o?.file === "string" && typeof o.test === "string";

/** @param {unknown} list @returns {list is QuotedFailure[]} */
const isQuotedFailureList = (list) =>
	Array.isArray(list) &&
	list.every((f) => {
		const o = asObject(f);
		return isFailingTest(o) && typeof o.message === "string";
	});

/**
 * @param {unknown} value
 * @param {unknown} fallback
 */
const orDefault = (value, fallback) => (value === undefined ? fallback : value);

/** @param {unknown} p @returns {p is Phase} */
const isPhase = (p) =>
	typeof p === "string" &&
	/** @type {readonly string[]} */ (PHASES).includes(p);

/**
 * @param {Record<string, unknown>} o
 * @returns {Verdict}
 */
const parseGreen = (o) => ({
	kind: "green",
	...(typeof o.run === "number" ? { run: o.run } : {}),
	...(typeof o.named === "number" ? { named: o.named } : {}),
	...(isStringList(o.cleared) && o.cleared.length > 0
		? { cleared: o.cleared }
		: {}),
});

/**
 * @param {unknown} list
 * @returns {import("./queue-lander.js").Failure[]}
 */
const parseFailures = (list) =>
	(Array.isArray(list) ? list : []).flatMap((f) => {
		const o = asObject(f);
		if (!isFailingTest(o)) return [];
		return [
			{
				file: o.file,
				test: o.test,
				...(typeof o.message === "string" ? { message: o.message } : {}),
				...(typeof o.signature === "string" ? { signature: o.signature } : {}),
			},
		];
	});

/**
 * @param {unknown} v
 * @returns {Exclude<Verdict, {kind: "unknown"}>|null}
 */
function parseVerdict(v) {
	const o = asObject(v);
	if (o?.kind === "green")
		return /** @type {Extract<Verdict, {kind: "green"}>} */ (parseGreen(o));
	if (o?.kind === "red" && isStringList(o.files)) {
		const failures = parseFailures(o.failures);
		return {
			kind: "red",
			files: o.files,
			...(typeof o.run === "number" ? { run: o.run } : {}),
			...(isStringList(o.jobs) ? { jobs: o.jobs } : {}),
			...(failures.length > 0 ? { failures } : {}),
			...(o.retried === true ? { retried: true } : {}),
			...(o.noRun === true ? { noRun: true } : {}),
			...(isStringList(o.typecheck) ? { typecheck: o.typecheck } : {}),
		};
	}
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
	const marksValid =
		(o.noRun === undefined || o.noRun === true) &&
		(o.typecheck === undefined || isStringList(o.typecheck)) &&
		(o.runs === undefined || isNumberList(o.runs)) &&
		(o.failures === undefined || isQuotedFailureList(o.failures));
	/** @type {Record<Cause["kind"], () => boolean>} */
	const valid = {
		conflict: () => isStringList(o.files),
		refused: () => typeof o.reason === "string",
		red: () =>
			isStringList(o.files) &&
			typeof o.iso === "string" &&
			(o.mainRun === undefined || typeof o.mainRun === "number") &&
			marksValid,
		unrecorded: () => true,
		collision: () =>
			isStringList(o.files) &&
			typeof o.step === "string" &&
			isStringList(o.after) &&
			marksValid,
	};
	return Object.hasOwn(valid, String(o.kind))
		? valid[/** @type {Cause["kind"]} */ (o.kind)]()
		: false;
};

/** @type {readonly string[]} */
const DROP_STATES = ["open", "settled", "ticketed"];

/**
 * @param {unknown} d
 * @returns {Drop|null}
 */
function parseDrop(d) {
	const o = asObject(d);
	const state = orDefault(o?.state, o?.ticket === null ? "open" : "ticketed");
	const decidedAt = orDefault(o?.decidedAt, o?.at);
	if (
		typeof o?.name !== "string" ||
		typeof o.sha !== "string" ||
		typeof o.ref !== "string" ||
		typeof o.onto !== "string" ||
		!isCause(o.cause) ||
		!(o.ticket === null || Number.isInteger(o.ticket)) ||
		!Number.isFinite(o.at) ||
		!DROP_STATES.includes(String(state)) ||
		!Number.isFinite(decidedAt) ||
		!(o.settledOn === undefined || typeof o.settledOn === "string") ||
		!(o.filingRefused === undefined || typeof o.filingRefused === "string") ||
		!(o.reapedAt === undefined || Number.isFinite(o.reapedAt))
	)
		return null;
	return /** @type {Drop} */ ({
		name: o.name,
		sha: o.sha,
		ref: o.ref,
		onto: o.onto,
		cause: o.cause,
		ticket: o.ticket,
		at: o.at,
		state,
		decidedAt,
		...(o.settledOn === undefined ? {} : { settledOn: o.settledOn }),
		...(o.filingRefused === undefined
			? {}
			: { filingRefused: o.filingRefused }),
		...(o.reapedAt === undefined ? {} : { reapedAt: o.reapedAt }),
	});
}

/**
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
 * @param {string} file
 * @param {() => number} [now]
 * @returns {PipelineRecord}
 */
function pipelineRecord(file, now = Date.now) {
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
		quarantine() {
			const stem = `${file}.torn-${new Date(now()).toISOString()}`;
			for (let n = 0; ; n++) {
				const aside = n === 0 ? stem : `${stem}-${n}`;
				try {
					// workflow-core#4905
					fs.linkSync(file, aside);
				} catch (err) {
					if (caught(err).code === "EEXIST") continue;
					throw err;
				}
				fs.unlinkSync(file);
				return aside;
			}
		},
	};
}

/**
 * @param {string} file
 * @returns {RecordRead<Drop[]>}
 */
function readDropFile(file) {
	const r = readRecordFile(file);
	if (r.kind !== "read") return r;
	return Array.isArray(r.value)
		? {
				kind: "read",
				value: r.value.map(parseDrop).filter((d) => d !== null),
			}
		: { kind: "torn" };
}

/**
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

/** @param {Drop} d */
const isOwedDrop = (d) =>
	d.state === "open" &&
	d.ticket === null &&
	d.reapedAt === undefined &&
	d.filingRefused === undefined;

/**
 * @param {string} file
 * @returns {Drop[]}
 */
const readOwedDrops = (file) => dropRecord(file).read().filter(isOwedDrop);

/** @returns {Pick<Batch, "ahead" | "blame" | "isolated" | "serial" | "hold" | "bases">} */
const redPathAtRest = () => ({
	ahead: [],
	blame: null,
	isolated: [],
	serial: null,
	hold: null,
	bases: [],
});

module.exports = {
	dropRecord,
	readOwedDrops,
	isStringList,
	parseVerdict,
	pipelineRecord,
	readDropFile,
	redPathAtRest,
};
