const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { orFallback } = require("./caught.js");
const { parseJsonlRow } = require("./jsonl.js");

// #5827
/** @param {string} text */
const textHash = (text) =>
	crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

const SESSION_PREFIX_LEN = 8;

/**
 * @param {string} home
 * @returns {Map<string, string>}
 */
function transcriptIndex(home) {
	/** @type {Map<string, string>} */
	const index = new Map();
	const configs = orFallback(() => fs.readdirSync(home), []).filter((d) =>
		d.startsWith(".claude"),
	);
	for (const config of configs) {
		const root = path.join(home, config, "projects");
		for (const project of orFallback(() => fs.readdirSync(root), [])) {
			const dir = path.join(root, project);
			for (const file of orFallback(() => fs.readdirSync(dir), [])) {
				if (!file.endsWith(".jsonl")) continue;
				const prefix = file.slice(0, SESSION_PREFIX_LEN);
				const full = path.join(dir, file);
				index.set(`${config.slice(1)}__${prefix}`, full);
				if (!index.has(prefix)) index.set(prefix, full);
			}
		}
	}
	return index;
}

/**
 * @param {Map<string, string>} index
 * @param {string} id
 * @returns {string|undefined}
 */
const transcriptFor = (index, id) =>
	index.get(id) ?? index.get(id.split("__").slice(-2).join("__"));

/**
 * @param {string} file
 * @param {string} hash
 * @returns {string|null}
 */
function replyWithHash(file, hash) {
	const text = orFallback(() => fs.readFileSync(file, "utf8"), "");
	for (const line of text.split("\n")) {
		const row = parseJsonlRow(line);
		if (row?.type !== "assistant") continue;
		const message = /** @type {{content?: unknown}|undefined} */ (row.message);
		const content = message?.content;
		if (!Array.isArray(content)) continue;
		for (const part of content)
			if (
				part?.type === "text" &&
				typeof part.text === "string" &&
				textHash(part.text) === hash
			)
				return part.text;
	}
	return null;
}

/**
 * @template {{id: string, text?: string, transcript?: unknown, textHash?: unknown}} R
 * @param {R[]} rows
 * @param {Map<string, string>} index
 * @returns {{rows: R[], unresolved: string[]}}
 */
function rehydrate(rows, index) {
	/** @type {string[]} */
	const unresolved = [];
	const out = rows.map((row) => {
		if (typeof row.text === "string") return row;
		const { transcript, textHash: hash } = row;
		const file =
			typeof transcript === "string"
				? transcriptFor(index, transcript)
				: undefined;
		const text =
			file && typeof hash === "string" ? replyWithHash(file, hash) : null;
		if (text === null) {
			unresolved.push(row.id);
			return row;
		}
		return { ...row, text };
	});
	return { rows: out, unresolved };
}

module.exports = { rehydrate, textHash, transcriptIndex };
