const fs = require("node:fs");
const { MARKERS_REL } = require("./marker-root.js");
const { isSafeId } = require("./safe-id.js");
const path = require("node:path");
const idSeam = require("./session-id");
const { ignoreFailure } = require("./caught.js");

const MARKER_SUBDIR = path.join(
	MARKERS_REL,
	".pick-next",
	"selection-sessions",
);

// guess: a week outlives any session still dispatching, lucmoseley/mantahostels#422
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {string} root
 * @param {string|null|undefined} sessionId
 * @returns {string|null}
 */
function markerPath(root, sessionId) {
	if (!isSafeId(sessionId)) return null;
	return path.join(root, MARKER_SUBDIR, `${sessionId}.json`);
}

/** @param {string} root */
function prune(root) {
	const dir = path.join(root, MARKER_SUBDIR);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	const cutoff = Date.now() - MAX_AGE_MS;
	for (const name of names) {
		const file = path.join(dir, name);
		ignoreFailure(() => {
			if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
		});
	}
}

/**
 * @param {string} root
 * @param {{sessionId: string|null|undefined, frontier: number, slots?: number|null,
 *   noCommand?: number|null}} run
 * @returns {boolean}
 */
function record(root, { sessionId, frontier, slots, noCommand }) {
	const file = markerPath(root, sessionId);
	if (!file) return false;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			`${JSON.stringify({
				sessionId,
				frontier: Number.isInteger(frontier) ? frontier : null,
				slots: Number.isInteger(slots) ? slots : null,
				noCommand: Number.isInteger(noCommand) ? noCommand : null,
				at: new Date().toISOString(),
			})}\n`,
		);
	} catch {
		return false;
	}
	prune(root);
	return true;
}

/**
 * @param {string} root
 * @param {{frontier: number, slots?: number|null, noCommand?: number|null}} run
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function recordFromEnv(root, run, env = process.env) {
	return record(root, { ...run, sessionId: idSeam.fromEnv(env) });
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {string[]} keys
 * @returns {boolean}
 */
function openWave(root, sessionId, keys) {
	return patch(root, sessionId, {
		wave: { keys: [...new Set(keys)], at: new Date().toISOString() },
	});
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @returns {boolean}
 */
function closeWave(root, sessionId) {
	return patch(root, sessionId, { wave: null });
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {object} fields
 * @returns {boolean}
 */
function patch(root, sessionId, fields) {
	const file = markerPath(root, sessionId);
	if (!file) return false;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return false;
		fs.writeFileSync(file, `${JSON.stringify({ ...parsed, ...fields })}\n`);
	} catch {
		return false;
	}
	return true;
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @returns {{frontier: number|null, slots: number|null, noCommand: number|null,
 *   at: string|null, wave: {keys: string[]}|null}|null}
 */
function read(root, sessionId) {
	const file = markerPath(root, sessionId);
	if (!file) return null;
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const keys = parsed.wave?.keys;
	return {
		frontier: Number.isInteger(parsed.frontier) ? parsed.frontier : null,
		slots: Number.isInteger(parsed.slots) ? parsed.slots : null,
		noCommand: Number.isInteger(parsed.noCommand) ? parsed.noCommand : null,
		at: typeof parsed.at === "string" ? parsed.at : null,
		wave: Array.isArray(keys)
			? { keys: keys.filter((k) => typeof k === "string") }
			: null,
	};
}

module.exports = {
	record,
	recordFromEnv,
	read,
	prune,
	openWave,
	closeWave,
};
