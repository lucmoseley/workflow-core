const fs = require("node:fs");
const path = require("node:path");

const { markersDir } = require("./marker-root.js");

// guess, workflow-core#861
const INPUT_CHARS = 160;

/**
 * @param {{name?: unknown, input?: unknown} | undefined} call
 * @returns {string}
 */
function describeCall(call) {
	if (!call) return "a tool call this transcript no longer carries";
	const input = /** @type {Record<string, unknown> | null} */ (
		call.input && typeof call.input === "object" ? call.input : null
	);
	const gist =
		input && typeof input.command === "string"
			? input.command
			: JSON.stringify(call.input ?? null);
	const one = String(gist).replace(/\s+/g, " ").trim();
	const name = typeof call.name === "string" ? call.name : "?";
	return `${name}: ${one.length > INPUT_CHARS ? `${one.slice(0, INPUT_CHARS)}…` : one}`;
}

/**
 * @param {string} file
 * @returns {Set<string>}
 */
function readSeen(file) {
	try {
		return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean));
	} catch {
		return new Set();
	}
}

/**
 * @param {string} file
 * @param {Set<string>} seen
 * @returns {boolean}
 */
function writeSeen(file, seen) {
	try {
		fs.writeFileSync(file, `${[...seen].join("\n")}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * @template T
 * @param {{root: string, sessionId: string, seenPrefix: string, items: T[],
 *   idOf: (item: T) => string, block: (fresh: T[]) => boolean}} opts
 * @returns {boolean}
 */
function reportOnce({ root, sessionId, seenPrefix, items, idOf, block }) {
	const file = path.join(markersDir(root), seenPrefix + sessionId);
	const seen = readSeen(file);
	const fresh = items.filter((item) => !seen.has(idOf(item)));
	if (fresh.length === 0) return false;

	const emitted = block(fresh);
	if (emitted) {
		for (const item of fresh) seen.add(idOf(item));
		writeSeen(file, seen);
	}
	return emitted;
}

module.exports = { describeCall, readSeen, reportOnce, writeSeen };
