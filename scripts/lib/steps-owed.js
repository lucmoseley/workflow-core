/*
 * steps-owed.js — the sole reader/writer of `.claude/workflow-core.json`'s
 * `stepsOwed` array (workflow-core#248): a manual step a migration note's walk could not
 * discharge itself, carried forward as `{tag, type, text}` rather than lost.
 * `upgrade.js` (the walker) appends to it; `scripts/steps-owed.js` (the CLI)
 * clears an entry or marks a `choice` declined — the only writer outside the
 * walker; `check-plugin-gap.js` (the reporter) reads it.
 *
 * A `choice` entry is never removed on decline — it is marked `declined:
 * true` in place, so the founder's preference about this repo's files
 * travels with the repo (in git) rather than being asked again on the next
 * machine or the next session here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { STEP_TYPES } = require("./migration-note.js");
const { formatConfigJson } = require("./config-json.js");
const { caught } = require("./caught.js");

const CONFIG_REL = path.join(".claude", "workflow-core.json");

/** @typedef {{tag: string, type: "act"|"choice"|"notice", text: string, declined?: boolean}} StepOwed */

/** @param {unknown} e @returns {e is StepOwed} */
function isValidEntry(e) {
	if (typeof e !== "object" || e === null) return false;
	const r = /** @type {Record<string, unknown>} */ (e);
	return (
		typeof r.tag === "string" &&
		r.tag.length > 0 &&
		STEP_TYPES.includes(/** @type {any} */ (r.type)) &&
		typeof r.text === "string" &&
		r.text.length > 0 &&
		(!("declined" in r) || typeof r.declined === "boolean")
	);
}

/** @param {string} root */
function configPath(root) {
	return path.join(root, CONFIG_REL);
}

/**
 * @param {string} root
 * @returns {{path: string, config: Record<string, unknown>}}
 */
function readConfigRaw(root) {
	const at = configPath(root);
	try {
		return { path: at, config: JSON.parse(fs.readFileSync(at, "utf8")) };
	} catch (err) {
		if (caught(err).code === "ENOENT") return { path: at, config: {} };
		throw new Error(`${at} does not parse: ${caught(err).message}`, {
			cause: err,
		});
	}
}

/**
 * @param {string} at
 * @param {Record<string, unknown>} config
 * @param {StepOwed[]} steps
 */
function writeStepsOwed(at, config, steps) {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, formatConfigJson({ ...config, stepsOwed: steps }));
}

/**
 * The well-formed entries only — a malformed one (hand-edited, or left by a
 * stale contract) is dropped here rather than surfaced or written back.
 * @param {string} root
 * @returns {StepOwed[]}
 */
function stepsOwed(root) {
	const { config } = readConfigRaw(root);
	const raw = Array.isArray(config.stepsOwed) ? config.stepsOwed : [];
	return raw.filter(isValidEntry);
}

/**
 * Appends `entries` for `tag`, preserving whatever the field already holds.
 * `upgrade.js`'s only write to this field (workflow-core#248) — never called with an
 * empty `entries`.
 * @param {string} root
 * @param {string} tag
 * @param {{type: "act"|"choice"|"notice", text: string}[]} entries
 */
function appendStepsOwed(root, tag, entries) {
	if (entries.length === 0) return;
	const { path: at, config } = readConfigRaw(root);
	const existing = Array.isArray(config.stepsOwed) ? config.stepsOwed : [];
	const additions = entries.map((e) => ({ tag, type: e.type, text: e.text }));
	writeStepsOwed(at, config, [...existing, ...additions]);
}

/**
 * Clears one entry — an `act` performed, a `notice` printed, or a `choice`
 * already declined and now stale — matching `tag`+`type`+`text` exactly, as
 * `stepsOwed()` prints them. Throws on a malformed identifier before
 * touching the file; returns false where nothing matched.
 * @param {string} root
 * @param {{tag: string, type: string, text: string}} at
 */
function clearStepOwed(root, { tag, type, text }) {
	if (!tag || !STEP_TYPES.includes(/** @type {any} */ (type)) || !text)
		throw new Error(
			`clear needs a tag, one of ${STEP_TYPES.join("/")}, and the step's exact text`,
		);
	const { path: file, config } = readConfigRaw(root);
	const raw = Array.isArray(config.stepsOwed) ? config.stepsOwed : [];
	const i = raw.findIndex(
		(e) =>
			isValidEntry(e) && e.tag === tag && e.type === type && e.text === text,
	);
	if (i === -1) return false;
	writeStepsOwed(file, config, [...raw.slice(0, i), ...raw.slice(i + 1)]);
	return true;
}

/**
 * Marks a `choice` entry declined in place, matching `tag`+`text` exactly.
 * Throws on a malformed identifier before touching the file; returns false
 * where nothing matched.
 * @param {string} root
 * @param {{tag: string, text: string}} at
 */
function declineStepOwed(root, { tag, text }) {
	if (!tag || !text)
		throw new Error("decline needs a tag and the choice's exact text");
	const { path: file, config } = readConfigRaw(root);
	const raw = Array.isArray(config.stepsOwed) ? config.stepsOwed : [];
	const i = raw.findIndex(
		(e) =>
			isValidEntry(e) &&
			e.tag === tag &&
			e.type === "choice" &&
			e.text === text,
	);
	if (i === -1) return false;
	const next = raw.slice();
	next[i] = { ...next[i], declined: true };
	writeStepsOwed(file, config, next);
	return true;
}

module.exports = {
	stepsOwed,
	appendStepsOwed,
	clearStepOwed,
	declineStepOwed,
};
