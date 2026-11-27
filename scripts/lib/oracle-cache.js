const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { storeConfigDir } = require("./arbiter-core.js");
const { sleepSync } = require("./sleep-sync.js");
const { caught, ignoreFailure } = require("./caught.js");
const { budgetMs } = require("./hook-deadline.js");
const { capMs } = require("./cap-ms.js");

/** @typedef {{raw: string, at: number}} Hit */

/** @param {string} key */
const keyOf = (key) =>
	crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 12);

/** @param {string} key */
const cachePath = (key) =>
	path.join(storeConfigDir(), `wfc-oracle-cache-${keyOf(key)}.json`);

/** @param {string} key */
const lockPath = (key) =>
	path.join(storeConfigDir(), `wfc-oracle-cache-${keyOf(key)}.lock`);

// guess, workflow-core#3561
const ttlMs = () => capMs("WFC_ORACLE_CACHE_TTL_MS", 30_000);

// measured 2.75 s warm spawn at lucmoseley/mantahostels#1921, 0.78-1.21 s at workflow-core#1446
const waitMs = () => capMs("WFC_ORACLE_CACHE_WAIT_MS", 4000);

// guess, lucmoseley/mantahostels#1920
const lockStaleMs = () => capMs("WFC_ORACLE_CACHE_LOCK_STALE_MS", 60_000);

// guess, lucmoseley/mantahostels#1924
const pollMs = () => capMs("WFC_ORACLE_CACHE_POLL_MS", 100);

const isDisabled = () => process.env.WFC_ORACLE_CACHE === "0";

/**
 * @param {number} ms
 * @returns {boolean}
 */
function trySleep(ms) {
	try {
		sleepSync(ms);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} key
 * @param {number} [minAt]
 * @param {number} [maxAgeMs]
 * @returns {Hit|null}
 */
function readFresh(key, minAt, maxAgeMs) {
	const rec = freshRecord(key, minAt, maxAgeMs);
	return typeof rec?.raw === "string" ? { raw: rec.raw, at: rec.at } : null;
}

/**
 * @param {string} key
 * @returns {string|null}
 */
function readRefusal(key) {
	const rec = freshRecord(key);
	return typeof rec?.why === "string" ? rec.why : null;
}

/**
 * @param {string} key
 * @param {number} [minAt]
 * @param {number} [maxAgeMs]
 * @returns {{raw?: unknown, why?: unknown, at: number} | null}
 */
function freshRecord(key, minAt, maxAgeMs = ttlMs()) {
	if (isDisabled()) return null;
	try {
		const rec = JSON.parse(fs.readFileSync(cachePath(key), "utf8"));
		if (!rec || typeof rec !== "object") return null;
		const at = Number(rec.at);
		if (!Number.isFinite(at)) return null;
		const age = Date.now() - at;
		if (age < 0 || age > maxAgeMs) return null;
		if (minAt !== undefined && at < minAt) return null;
		return { ...rec, at };
	} catch {
		return null;
	}
}

/**
 * @param {string} key
 * @param {string} raw
 */
function write(key, raw) {
	publish(key, { raw });
}

/**
 * @param {string} key
 * @param {string} why
 */
function writeRefusal(key, why) {
	publish(key, { why });
}

/**
 * @param {string} key
 * @param {{raw: string} | {why: string}} fields
 */
function publish(key, fields) {
	if (isDisabled()) return;
	ignoreFailure(() => {
		writeFileAtomic(
			cachePath(key),
			JSON.stringify({ at: Date.now(), ...fields }),
			{ mkdir: true },
		);
		sweep();
	});
}

// guess, lucmoseley/mantahostels#1924
const keepMs = () => capMs("WFC_ORACLE_CACHE_KEEP_MS", 300_000);

function sweep() {
	ignoreFailure(() => {
		const dir = storeConfigDir();
		const cutoff = Date.now() - keepMs();
		for (const name of fs.readdirSync(dir)) {
			if (!name.startsWith("wfc-oracle-cache-")) continue;
			if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
			const full = path.join(dir, name);
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
		}
	});
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function acquire(key) {
	if (isDisabled()) return true;
	try {
		fs.mkdirSync(storeConfigDir(), { recursive: true });
	} catch {
		return true;
	}
	try {
		fs.mkdirSync(lockPath(key));
		return true;
	} catch (e) {
		if (caught(e).code !== "EEXIST") return true;
		if (!breakIfStale(key)) return false;
		try {
			fs.mkdirSync(lockPath(key));
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function breakIfStale(key) {
	try {
		const age = Date.now() - fs.statSync(lockPath(key)).mtimeMs;
		if (age <= lockStaleMs()) return false;
		fs.rmSync(lockPath(key), { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/** @param {string} key */
function release(key) {
	if (isDisabled()) return;
	ignoreFailure(() =>
		fs.rmSync(lockPath(key), { recursive: true, force: true }),
	);
}

/**
 * @param {string} key
 * @param {{ sleep?: (ms: number) => boolean }} [deps]
 * @returns {Hit|null}
 */
function waitForLeader(key, { sleep = trySleep } = {}) {
	if (isDisabled()) return null;
	const began = Date.now();
	const deadline = began + budgetMs(waitMs(), began);
	const step = pollMs();
	while (Date.now() < deadline) {
		if (!sleep(step)) return null;
		const hit = readFresh(key, began);
		if (hit !== null) return hit;
		if (!isHeldByAnother(key)) return null;
	}
	return null;
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isHeldByAnother(key) {
	try {
		return fs.existsSync(lockPath(key));
	} catch {
		return false;
	}
}

module.exports = {
	readFresh,
	readRefusal,
	write,
	writeRefusal,
	acquire,
	release,
	waitForLeader,
};
