const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { ignoreFailure } = require("./caught.js");
const { configDir } = require("./config-dir.js");
const store = require("./arbiter-store.js");
const { holderAlive, readOwnIdentity } = require("./arbiter-proc.js");
const { hostRoot } = require("./host-root.js");
const { projectSlug } = require("./project-slug.js");
const { pinnedOrFirstUsable } = require("./can-hold-state.js");

/** @typedef {"OK"|"SKIP"|"WARN"|"FAIL"|"BROKEN"} Outcome */
/**
 * @typedef {{checker: string, outcome: Outcome, text: string, at: string,
 *   durationMs: number|null, stamp: string|null,
 *   stamps: Record<string, string>, owner: string|null,
 *   maxAgeMs: number|null}} Report
 * @typedef {{checker: string, startedAt: string, pid: number,
 *   procStart: string|null, bootId: string|null}} RunRecord
 */

function base() {
	try {
		const slug = projectSlug(hostRoot());
		return pinnedOrFirstUsable(
			path.join(store.stateDir(), "notify-reports"),
			store
				.configDirs()
				.map((cfg) => path.join(cfg, "projects", slug, "notify-reports")),
		);
	} catch {
		return path.join(
			configDir(),
			"projects",
			projectSlug(hostRoot()),
			"notify-reports",
		);
	}
}

/**
 * @param {string} id
 */
const slug = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "-");

/** @param {string} checker */
const reportFile = (checker) =>
	path.join(base(), `${slug(checker)}.report.json`);

/** @param {string} checker */
const runFile = (checker) => path.join(base(), `${slug(checker)}.run.json`);

/**
 * @returns {string[]}
 */
function list() {
	let names;
	try {
		names = fs.readdirSync(base());
	} catch {
		return [];
	}
	const keys = new Set();
	for (const name of names) {
		const m = name.match(/^(.+)\.(?:report|run)\.json$/);
		if (m) keys.add(m[1]);
	}
	return [...keys].sort();
}

/**
 * @param {string} file
 * @param {object} obj
 */
function atomicWriteJSON(file, obj) {
	try {
		writeFileAtomic(file, `${JSON.stringify(obj)}\n`, { mkdir: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} file
 */
function readJSON(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	try {
		const obj = JSON.parse(text);
		return obj && typeof obj === "object" ? obj : null;
	} catch {
		return null;
	}
}

/**
 * @param {string} checker
 * @param {{outcome: Outcome, text?: string, finishedAt?: Date|string,
 *   durationMs?: number|null, stamp?: string|null,
 *   stamps?: Record<string, string>, owner?: string|null,
 *   maxAgeMs?: number|null}} entry
 * @returns {boolean}
 */
function writeReport(
	checker,
	{
		outcome,
		text = "",
		finishedAt = new Date(),
		durationMs = null,
		stamp = null,
		stamps = {},
		owner = null,
		maxAgeMs = null,
	},
) {
	const at =
		finishedAt instanceof Date ? finishedAt.toISOString() : String(finishedAt);
	return atomicWriteJSON(reportFile(checker), {
		checker,
		outcome,
		text,
		at,
		durationMs,
		stamp,
		stamps,
		owner,
		maxAgeMs,
	});
}

/**
 * @param {string} checker
 * @returns {Report|null}
 */
function readReport(checker) {
	const record = readJSON(reportFile(checker));
	if (
		!record ||
		typeof record.checker !== "string" ||
		typeof record.outcome !== "string" ||
		typeof record.text !== "string" ||
		typeof record.at !== "string"
	)
		return null;
	return {
		checker: record.checker,
		outcome: /** @type {Outcome} */ (record.outcome),
		text: record.text,
		at: record.at,
		durationMs:
			typeof record.durationMs === "number" ? record.durationMs : null,
		stamp: typeof record.stamp === "string" ? record.stamp : null,
		stamps:
			record.stamps &&
			typeof record.stamps === "object" &&
			!Array.isArray(record.stamps)
				? Object.fromEntries(
						Object.entries(record.stamps).filter(
							([, v]) => typeof v === "string" && v !== "",
						),
					)
				: {},
		owner:
			typeof record.owner === "string" && record.owner ? record.owner : null,
		maxAgeMs:
			Number.isFinite(record.maxAgeMs) && record.maxAgeMs > 0
				? record.maxAgeMs
				: null,
	};
}

/**
 * @param {Report|null} report
 * @param {number} [now]
 */
function ageMs(report, now = Date.now()) {
	if (!report) return null;
	const t = Date.parse(report.at);
	return Number.isNaN(t) ? null : Math.max(0, now - t);
}

// guess, lucmoseley/mantahostels#1949
const DEFAULT_STALE_MS = 4 * 60 * 60 * 1000;

// guess, #3772
const LONG_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {Report|null} report
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 */
function isStale(report, maxAgeMs = DEFAULT_STALE_MS, now = Date.now()) {
	const age = ageMs(report, now);
	return age === null ? true : age > maxAgeMs;
}

/**
 * @param {string} checker
 */
function openRun(checker) {
	atomicWriteJSON(runFile(checker), {
		checker,
		startedAt: new Date().toISOString(),
		...readOwnIdentity(),
	});
}

/**
 * @param {string} checker
 */
function closeRun(checker) {
	ignoreFailure(() => fs.unlinkSync(runFile(checker)));
}

/**
 * @param {string} checker
 * @returns {RunRecord|null}
 */
function readRun(checker) {
	const record = readJSON(runFile(checker));
	if (
		!record ||
		typeof record.pid !== "number" ||
		typeof record.checker !== "string" ||
		typeof record.startedAt !== "string"
	)
		return null;
	return {
		checker: record.checker,
		startedAt: record.startedAt,
		pid: record.pid,
		procStart:
			typeof record.procStart === "string" ||
			typeof record.procStart === "number"
				? record.procStart
				: null,
		bootId: typeof record.bootId === "string" ? record.bootId : null,
	};
}

/**
 * @param {RunRecord|null} run
 */
function isCancelled(run) {
	if (!run) return false;
	return !holderAlive({
		pid: run.pid,
		procStart: run.procStart,
		bootId: run.bootId ?? undefined,
	});
}

module.exports = {
	LONG_STALE_MS,
	DEFAULT_STALE_MS,
	atomicWriteJSON,
	readJSON,
	base,
	slug,
	list,
	reportFile,
	writeReport,
	readReport,
	ageMs,
	isStale,
	openRun,
	closeRun,
	readRun,
	isCancelled,
};
