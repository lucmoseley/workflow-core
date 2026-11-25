const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const core = require("./arbiter-core.js");
const { caught, orFallback } = require("./caught.js");

// guess, workflow-core#5529
const SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// guess, lucmoseley/mantahostels#287
const SCAN_MINT_MAX = 20;

const WATCHED_PATHSPECS = [...core.WARNED, ...core.DETECT_ONLY];

// guess, workflow-core#833
const RACY_MARGIN_MS = 1000;

const statKey = (/** @type {fs.BigIntStats} */ st) =>
	`${st.size} ${st.mtimeNs} ${st.ctimeNs}`;

const STAT_FIELDS = 3;

const NO_STAT = new Array(STAT_FIELDS).fill("-").join(" ");

/** @returns {Map<string, fs.BigIntStats> | null} */
function readTierFiles() {
	const listed = core.git([
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		...WATCHED_PATHSPECS,
	]);
	if (listed === null) return null;
	const root = core.treeRoot();
	const files = new Map();
	for (const rel of listed.split("\0")) {
		if (!rel) continue;
		if (rel.includes("\n")) continue;
		if (!core.isWatched(rel)) continue;
		let st;
		try {
			st = fs.lstatSync(path.join(root, rel), { bigint: true });
		} catch {
			continue;
		}
		if (st.isFile()) files.set(rel, st);
	}
	return files;
}

/** @param {string[]} rels */
function hashPaths(rels) {
	if (rels.length === 0) return new Map();
	const out = core.gitIn(
		["hash-object", "--stdin-paths"],
		`${rels.join("\n")}\n`,
	);
	if (out === null) return null;
	const shas = out.split("\n").filter(Boolean);
	if (shas.length !== rels.length) return null;
	return new Map(rels.map((rel, i) => [rel, shas[i]]));
}

/**
 * @typedef {{ sha: string, stat: string }} Entry
 * @typedef {{ trustBefore: bigint | null, entries: Map<string, Entry> }} Snapshot
 */

const HEADER = "#trust-ctime-before ";

/**
 * @param {string} sessionId
 * @returns {Snapshot | null}
 */
function readSnapshot(sessionId) {
	let text;
	try {
		text = fs.readFileSync(core.paths.snapshot(sessionId), "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT")
			core.logError(`snapshot read ${sessionId}`, e);
		return null;
	}
	const lines = text.split("\n");
	const head = lines.shift() ?? "";
	const trustBefore = orFallback(() => BigInt(head.slice(HEADER.length)), null);
	const fields = 1 + STAT_FIELDS;
	const entries = new Map();
	for (const line of lines) {
		const parts = line.split(" ");
		const rel = parts.slice(fields).join(" ");
		if (!rel) continue;
		entries.set(rel, {
			sha: parts[0],
			stat: parts.slice(1, fields).join(" "),
		});
	}
	return { trustBefore, entries };
}

/**
 * @param {string} sessionId
 * @param {Snapshot} snapshot
 */
function writeSnapshot(sessionId, { trustBefore, entries }) {
	const file = core.paths.snapshot(sessionId);
	const lines = [`${HEADER}${trustBefore}`];
	for (const [rel, { sha, stat }] of entries)
		lines.push(`${sha} ${stat} ${rel}`);
	try {
		writeFileAtomic(file, `${lines.join("\n")}\n`, { mkdir: true });
	} catch (e) {
		core.logError(`snapshot write ${sessionId}`, e);
	}
}

/**
 * @param {Map<string, fs.BigIntStats>} files
 * @param {Snapshot | null} before
 */
function currentTier(files, before) {
	const toHash = [];
	for (const [rel, st] of files) {
		const was = before?.entries.get(rel);
		const trusted =
			was !== undefined &&
			before?.trustBefore != null &&
			st.ctimeNs < before.trustBefore &&
			was.stat === statKey(st);
		if (!trusted) toHash.push(rel);
	}
	const hashed = hashPaths(toHash);
	if (hashed === null) return null;
	const now = new Map();
	for (const [rel, st] of files) {
		const sha = hashed.get(rel) ?? before?.entries.get(rel)?.sha;
		if (sha) now.set(rel, { sha, stat: statKey(st) });
	}
	return now;
}

/** @param {string} sessionId */
function scanChanged(sessionId) {
	if (!sessionId) return [];
	const trustBefore = BigInt(Date.now() - RACY_MARGIN_MS) * BigInt(1e6);
	const files = readTierFiles();
	if (files === null) return [];
	const before = readSnapshot(sessionId);
	const now = currentTier(files, before);
	if (now === null) return [];
	if (before === null) {
		writeSnapshot(sessionId, { trustBefore, entries: now });
		return [];
	}
	const changed = [];
	const next = new Map(now);
	for (const [rel, { sha }] of now) {
		const was = before.entries.get(rel);
		if (was?.sha === sha) continue;
		if (changed.length < SCAN_MINT_MAX) changed.push(rel);
		else if (was) next.set(rel, { sha: was.sha, stat: NO_STAT });
		else next.delete(rel);
	}
	writeSnapshot(sessionId, { trustBefore, entries: next });
	return changed;
}

module.exports = {
	scanChanged,
	SNAPSHOT_AGE_MS,
};
