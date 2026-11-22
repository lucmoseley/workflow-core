const fs = require("node:fs");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
const readEnvelope = (file) => {
	const raw = fs.readFileSync(file, "utf8");
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${file} is not a --json envelope object`);
	return parsed;
};

/**
 * @typedef {object} FaultDiffProfile
 * @property {(key: string) => boolean} keys
 * @property {(item: unknown, key: string) => string} identity
 * @property {(item: unknown, key: string) => boolean} [gating]
 * @property {(item: unknown, key: string) => string} [label]
 * @property {(item: unknown, key: string) => string} [family]
 * @property {(item: unknown, baseline: unknown, key: string) => boolean} [worse]
 * @property {(item: unknown, key: string, envelope: Record<string, unknown>) => number | undefined} [measure]
 * @property {string} [unit]
 * @property {(key: string) => boolean} [newOnly]
 * @property {(item: unknown, key: string) => boolean} [indexOnly]
 */

/** @type {(item: unknown) => string} */
const defaultLabel = (item) =>
	typeof item === "string" ? item : JSON.stringify(item);

/**
 * @param {Record<string, unknown>} staged
 * @param {Record<string, unknown>} baseline
 * @param {FaultDiffProfile} profile
 * @returns {{ key: string, item: unknown, line: string }[]}
 */
const newFaultItems = (staged, baseline, profile) => {
	const {
		keys,
		identity,
		gating = () => true,
		label = defaultLabel,
		family = identity,
		worse,
		measure,
		unit,
		indexOnly = () => false,
	} = profile;
	if (worse && family === identity)
		throw new Error(
			"fault-diff: a profile setting `worse` must set `family` too — " +
				"`worse` alone never runs.",
		);
	if (measure && !unit)
		throw new Error(
			"fault-diff: a profile setting `measure` must set `unit` too — " +
				"the figure would print bare.",
		);
	/** @type {{ key: string, item: unknown, line: string }[]} */
	const out = [];
	for (const [key, value] of Object.entries(staged)) {
		if (!keys(key) || !Array.isArray(value)) continue;
		out.push(
			...newItemsUnder(key, value, baseline[key], {
				identity,
				gating: (item, k) => !indexOnly(item, k) && gating(item, k),
				label,
				family,
				worse,
			}),
		);
	}
	return out;
};

/**
 * @typedef {Required<Pick<FaultDiffProfile, "identity" | "gating" | "label" | "family">>
 *   & Pick<FaultDiffProfile, "worse">} ResolvedProfile
 */

/**
 * @param {string} key
 * @param {unknown[]} items
 * @param {unknown} baselineItems
 * @param {ResolvedProfile} profile
 * @returns {{ key: string, item: unknown, line: string }[]}
 */
const newItemsUnder = (key, items, baselineItems, profile) => {
	const { identity, gating, label, family, worse } = profile;
	const before = (Array.isArray(baselineItems) ? baselineItems : []).filter(
		(/** @type {unknown} */ i) => gating(i, key),
	);
	const known = new Set(before.map((i) => identity(i, key)));
	/** @type {Map<string, unknown[]>} */
	const families = new Map();
	for (const i of before) {
		const f = family(i, key);
		families.set(f, [...(families.get(f) ?? []), i]);
	}

	const out = [];
	for (const item of items) {
		if (!gating(item, key)) continue;
		if (known.has(identity(item, key))) continue;
		const kin = families.get(family(item, key));
		if (kin && (!worse || !kin.every((b) => worse(item, b, key)))) continue;
		out.push({ key, item, line: `${key}: ${label(item, key)}` });
	}
	return out;
};

/**
 * @param {Record<string, unknown>} staged
 * @param {Record<string, unknown>} baseline
 * @param {FaultDiffProfile} profile
 * @returns {string[]}
 */
const newFaults = (staged, baseline, profile) =>
	newFaultItems(staged, baseline, profile).map((f) => f.line);

/**
 * @param {string} name
 * @returns {void}
 */
const failClosedOnCrash = (name) => {
	process.on("uncaughtException", (/** @type {any} */ e) => {
		writeFd(
			2,
			`${name}: crashed before it finished the fault list — ${e?.stack ?? e}\n`,
		);
		process.exit(2);
	});
};

/**
 * @param {string} name
 * @param {string | undefined} stagedFile
 * @param {string | undefined} baselineFile
 * @param {FaultDiffProfile} profile
 * @returns {never}
 */
const runCli = (name, stagedFile, baselineFile, profile) => {
	failClosedOnCrash(name);
	let found;
	try {
		if (!stagedFile || !baselineFile) throw new Error("two envelopes required");
		found = newFaults(
			readEnvelope(stagedFile),
			readEnvelope(baselineFile),
			profile,
		);
	} catch (e) {
		writeFd(2, `${name}: ${caught(e).message}\n`);
		process.exit(2);
	}
	try {
		if (found.length > 0) writeFd(1, `${found.join("\n")}\n`);
	} catch (e) {
		writeFd(
			2,
			`${name}: could not write the fault list — ${caught(e).message}\n`,
		);
		process.exit(2);
	}
	process.exit(found.length > 0 ? 1 : 0);
};

module.exports = {
	readEnvelope,
	newFaultItems,
	newFaults,
	runCli,
};
