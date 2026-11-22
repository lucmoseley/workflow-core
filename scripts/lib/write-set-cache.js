const crypto = require("node:crypto");
const { MARKERS_REL } = require("./marker-root.js");
const fs = require("node:fs");
const nodePath = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { requiredGroup } = require("./regex-group.js");
const { caught, ignoreFailure } = require("./caught.js");

/**
 * @typedef {{issue: number, bodyHash: string, derivedAt: string,
 *   writeSet: string[], trackedAtDerive: string[], sizeBand: string|null,
 *   predictedSize: string|null, gist: string|null,
 *   provisional: boolean}} Entry
 * @typedef {{number: number, body?: string|null}} IssueRef
 * @typedef {{ok: true, files: string[]} | {ok: false, files?: undefined}} Tracked
 * @typedef {{state: "cold", entry: null, unrevalidated?: undefined,
 *     promotable?: undefined, gonePaths?: undefined}
 *   | {state: "body-changed", entry: Entry, unrevalidated?: undefined,
 *     promotable?: undefined, gonePaths?: undefined}
 *   | {state: "hit", entry: Entry, unrevalidated?: boolean,
 *     promotable?: string[], gonePaths?: undefined}
 *   | {state: "path-gone", entry: Entry, gonePaths: string[],
 *     unrevalidated?: undefined, promotable?: undefined}} Lookup
 */

const CACHE_SUBDIR = nodePath.join(MARKERS_REL, ".pick-next", "write-sets");

/** @param {string} root */
const cacheDir = (root) => nodePath.join(root, CACHE_SUBDIR);
/**
 * @param {string} root
 * @param {number|string} n
 */
const entryPath = (root, n) =>
	nodePath.join(cacheDir(root), `${Number(n)}.json`);

/** @param {string|null|undefined} body */
const normaliseBody = (body) =>
	String(body ?? "").replace(
		/^([^\S\n\r\u2028\u2029]*[-*]\s*)\[[xX]\]/gm,
		"$1[ ]",
	);

/** @param {string|null|undefined} body */
// lucmoseley/mantahostels#385
const bodyHash = (body) =>
	crypto.createHash("sha256").update(normaliseBody(body)).digest("hex");

/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
const isPathList = (v) =>
	Array.isArray(v) && v.every((p) => typeof p === "string");

const PREDICTED_SIZES = ["small", "medium", "large"];

/**
 * @param {Entry & {size?: string|null}} e
 * @returns {Entry}
 */
function withSizeBandKey(e) {
	if (e.sizeBand !== undefined || !("size" in e)) return e;
	const { size, ...rest } = e;
	return { ...rest, sizeBand: size ?? null };
}

/** @param {string} root @param {number|string} n @returns {Entry|null} */
function readEntry(root, n) {
	let raw;
	try {
		raw = fs.readFileSync(entryPath(root, n), "utf8");
	} catch {
		return null;
	}
	try {
		const e = JSON.parse(raw);
		if (!e || e.issue !== Number(n)) return null;
		if (typeof e.bodyHash !== "string" || !e.bodyHash) return null;
		if (!isPathList(e.writeSet)) return null;
		if (e.trackedAtDerive !== undefined && !isPathList(e.trackedAtDerive))
			return null;
		if (e.provisional !== undefined && typeof e.provisional !== "boolean")
			return null;
		if (
			e.predictedSize !== undefined &&
			e.predictedSize !== null &&
			!PREDICTED_SIZES.includes(e.predictedSize)
		)
			return null;
		return withSizeBandKey(e);
	} catch {
		return null;
	}
}

/**
 * @param {string} root
 * @param {{
 *   issue: number,
 *   bodyHash: string,
 *   writeSet?: string[],
 *   trackedAtDerive?: string[],
 *   sizeBand?: string | null,
 *   predictedSize?: string | null,
 *   gist?: string | null,
 *   derivedAt?: string,
 *   provisional?: boolean,
 * }} options
 * @returns {{ok: true, path: string, entry: Entry}
 *   | {ok: false, error: string}}
 */
function writeEntry(
	root,
	{
		issue,
		bodyHash: hash,
		writeSet,
		trackedAtDerive,
		sizeBand,
		predictedSize,
		gist,
		derivedAt,
		provisional,
	},
) {
	const entry = {
		issue: Number(issue),
		bodyHash: String(hash),
		derivedAt: derivedAt ?? new Date().toISOString(),
		writeSet: writeSet ?? [],
		trackedAtDerive: trackedAtDerive ?? [],
		sizeBand: sizeBand ?? null,
		predictedSize:
			predictedSize != null && PREDICTED_SIZES.includes(predictedSize)
				? predictedSize
				: null,
		gist: gist ?? null,
		provisional: provisional === true,
	};
	try {
		const target = entryPath(root, entry.issue);
		writeFileAtomic(target, JSON.stringify(entry), { mkdir: true });
		return { ok: true, path: target, entry };
	} catch (e) {
		return { ok: false, error: String(caught(e).message || e) };
	}
}

/**
 * @param {string} root
 * @param {IssueRef} issue
 * @param {Tracked|null|undefined} tracked
 * @returns {Lookup}
 */
function lookup(root, issue, tracked) {
	const entry = readEntry(root, issue.number);
	if (!entry) return { state: "cold", entry: null };
	if (entry.bodyHash !== bodyHash(issue.body))
		return { state: "body-changed", entry };

	const wasTracked = entry.trackedAtDerive ?? [];
	if (!tracked?.ok)
		return wasTracked.length > 0
			? { state: "hit", entry, unrevalidated: true }
			: { state: "hit", entry };
	const gonePaths = wasTracked.filter((p) => !tracked.files.includes(p));
	if (gonePaths.length > 0) return { state: "path-gone", entry, gonePaths };
	const promotable = (entry.writeSet ?? []).filter(
		(p) => !wasTracked.includes(p) && tracked.files.includes(p),
	);
	return promotable.length > 0
		? { state: "hit", entry, promotable }
		: { state: "hit", entry };
}

/**
 * @param {string} root
 * @param {Entry} entry
 * @param {string[]} promotable
 * @returns {Entry}
 */
function promoteTracked(root, entry, promotable) {
	if (readEntry(root, entry.issue)?.bodyHash !== entry.bodyHash) return entry;
	const trackedAtDerive = [...(entry.trackedAtDerive ?? []), ...promotable];
	return writeEntry(root, { ...entry, trackedAtDerive }).ok
		? { ...entry, trackedAtDerive }
		: entry;
}

/**
 * @param {string} root
 * @param {IssueRef[]} issues
 * @param {Tracked|null|undefined} tracked
 */
function lookupAll(root, issues, tracked) {
	/** @type {(Entry & {number: number, unrevalidated: boolean})[]} */
	const warm = [];
	/** @type {{number: number, state: string, bodyHash: string,
	 *   gonePaths: string[]|null}[]} */
	const cold = [];
	for (const i of issues) {
		/** @type {Lookup} */
		let r;
		try {
			r = lookup(root, i, tracked);
		} catch {
			r = { state: "cold", entry: null };
		}
		if (r.state === "hit") {
			const entry = r.promotable
				? promoteTracked(root, r.entry, r.promotable)
				: r.entry;
			warm.push({
				number: i.number,
				...entry,
				provisional: entry?.provisional === true,
				unrevalidated: r.unrevalidated === true,
			});
		} else
			cold.push({
				number: i.number,
				state: r.state,
				bodyHash: bodyHash(i.body),
				gonePaths: r.gonePaths ?? null,
			});
	}
	return { warm, cold };
}

/** @param {string} root @param {number[]|null|undefined} openNumbers */
function prune(root, openNumbers) {
	if (!openNumbers || openNumbers.length === 0)
		return { ok: true, removed: [] };
	const open = new Set(openNumbers.map(Number));
	let names;
	try {
		names = fs.readdirSync(cacheDir(root));
	} catch {
		return { ok: true, removed: [] };
	}
	/** @type {number[]} */
	const removed = [];
	for (const name of names) {
		if (name.endsWith(".tmp")) {
			ignoreFailure(() => fs.rmSync(nodePath.join(cacheDir(root), name)));
			continue;
		}
		const m = /^(\d+)\.json$/.exec(name);
		if (!m || open.has(Number(m[1]))) continue;
		ignoreFailure(() => {
			fs.rmSync(nodePath.join(cacheDir(root), name));
			removed.push(Number(m[1]));
		});
	}
	return { ok: true, removed: removed.sort((a, b) => a - b) };
}

const ENTRY_FILE = /^(\d+)\.json$/;

/** @param {string} root @param {string|null|undefined} since */
function countDerivedSince(root, since) {
	const from = Date.parse(since ?? "");
	if (!Number.isFinite(from)) return { ok: false, count: null };
	let names;
	try {
		names = fs.readdirSync(cacheDir(root));
	} catch {
		return { ok: true, count: 0 };
	}
	let count = 0;
	for (const name of names) {
		const m = ENTRY_FILE.exec(name);
		if (!m) continue;
		const entry = readEntry(root, requiredGroup(m, 1, ENTRY_FILE));
		if (entry?.provisional) continue;
		const at = Date.parse(entry?.derivedAt ?? "");
		if (Number.isFinite(at) && at > from) count += 1;
	}
	return { ok: true, count };
}

module.exports = {
	CACHE_SUBDIR,
	bodyHash,
	cacheDir,
	readEntry,
	writeEntry,
	lookup,
	lookupAll,
	prune,
	countDerivedSince,
};
