/*
 * Which of a checker's faults THIS COMMIT introduced (mantahostels#1688, mantahostels#1753).
 *
 * A `.husky/pre-commit` gate ran a whole-repo checker and got a failure. That
 * says nothing about who caused it: in this shared working tree `main` itself
 * can be red, and a fault a bystander inherited must not refuse their commit.
 *
 * Both arguments are `--json` envelopes from the same checker: the STAGED one
 * from this commit's reading, the BASELINE one from HEAD read against HEAD's own
 * files. An item in both is inherited and warns; an item in the staged envelope
 * alone is this commit's and refuses.
 *
 * EVERY POLICY IS THE CALLER'S. Which keys hold faults, what makes two faults
 * the same fault, which are gate material and how one prints all differ per
 * checker (mantahostels#1753).
 *
 * FAIL-CLOSED IS THE CALLER'S JOB. A baseline that could not be produced must
 * refuse the commit rather than call every fault inherited.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/**
 * A `--json` envelope read off disk.
 *
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
 * @property {(key: string) => boolean} keys      which envelope keys hold faults
 * @property {(item: unknown, key: string) => string} identity  what makes two faults the same fault
 * @property {(item: unknown, key: string) => boolean} [gating] which faults are gate material; all, by default
 * @property {(item: unknown, key: string) => string} [label]   how one prints
 * @property {(item: unknown, key: string) => string} [family]  a COARSER grouping than identity — see worse(); identity, by default
 * @property {(item: unknown, baseline: unknown, key: string) => boolean} [worse]  whether a staged item is worse than a baseline one of the same family
 * @property {(item: unknown, key: string, envelope: Record<string, unknown>) => number | undefined} [measure]  the number this fault carries, read out of EITHER envelope — see newFaultItems()
 * @property {string} [unit]  what `measure` counts, printed after the figure and a space — `B`, `ms`
 * @property {(key: string) => boolean} [newOnly]  keys whose items are faults only as this commit's addition: one the baseline already carries is no fault, so lib/check.js never reports it inherited
 * @property {(item: unknown, key: string) => boolean} [indexOnly]  items the baseline side never computes (lib/check.js isBaselineSide()), so never compared: the index side's own report prints them
 */

/** @type {(item: unknown) => string} */
const defaultLabel = (item) =>
	typeof item === "string" ? item : JSON.stringify(item);

/**
 * Every gating fault item in `staged` absent from `baseline`, each with the
 * envelope key it came from, the item itself, and its `key: <label>` line.
 *
 * THE ITEM IS EXPOSED FOR A MEASUREMENT (mantahostels#1939): only the caller holds both
 * envelopes, so it composes the delta line, and `measure` needs the item a
 * printed string has already lost.
 *
 * The baseline is filtered by `gating` too, deliberately: an item that is not
 * gate material cannot make a staged item inherited, because the two envelopes
 * must be read on the same terms or a severity change would read as a repair.
 *
 * FAMILY AND `worse` EXIST FOR A FAULT THAT CARRIES A MEASUREMENT (mantahostels#1834). A set
 * difference can say "this fault is new" but not "this fault got worse", and a
 * cap gate needs the second: check-context-budget.js's finding embeds the
 * surface's byte total, so plain identity would read a commit that SHEDS bytes
 * from an over-cap surface as adding a fault and refuse the very repair the gate
 * demands. A profile that sets both groups its items by `family` — the surface,
 * not the number — and calls a staged item new only where its family is absent
 * from the baseline, or `worse` holds against every baseline item in it.
 *
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
	/* `worse` alone is INERT, not lenient: reaching its test needs the identity
	 * miss, and with `family` defaulted to `identity` that miss guarantees the
	 * family is absent too, so the comparator never runs and the profile quietly
	 * reverts to plain set difference (mantahostels#1834). */
	if (worse && family === identity)
		throw new Error(
			"fault-diff: a profile setting `worse` must set `family` too — " +
				"`worse` alone never runs.",
		);
	/* `measure` returns a bare number, and a figure printed with no unit is one
	 * the reader cannot act on. */
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
 *   & Pick<FaultDiffProfile, "worse">} ResolvedProfile a profile with its defaults filled in
 */

/**
 * The new faults among one key's staged items, against that key's baseline.
 *
 * @param {string} key
 * @param {unknown[]} items the key's staged items
 * @param {unknown} baselineItems the key's baseline entry, an array or absent
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
 * The same set difference as `key: <label>` lines alone — every caller that
 * only prints them.
 *
 * @param {Record<string, unknown>} staged
 * @param {Record<string, unknown>} baseline
 * @param {FaultDiffProfile} profile
 * @returns {string[]}
 */
const newFaults = (staged, baseline, profile) =>
	newFaultItems(staged, baseline, profile).map((f) => f.line);

/**
 * Routes a crash to exit 2 instead of node's default 1 (mantahostels#2314).
 *
 * EXIT 1 MEANS A COMPLETE FAULT LIST. gate_direction reads a 1 with anything on
 * stdout as "this commit adds the lines above" (lib/precommit-gate.sh), so a
 * crash that exits 1 having already printed part of a list is reported as the
 * session's own new faults, with the list silently truncated.
 *
 * A REQUIRE-TIME THROW IS BEFORE THIS and still exits 1 — but with an EMPTY
 * stdout, which gate_direction already routes to its "could not answer" limb
 * (mantahostels#2247).
 *
 * @param {string} name
 * @returns {void}
 */
const failClosedOnCrash = (name) => {
	/* `any`, not node's `Error`: a `throw` takes any value. Covers
	 * uncaughtException alone — runCli is synchronous, so there is no rejection
	 * to miss. */
	process.on("uncaughtException", (/** @type {any} */ e) => {
		writeFd(
			2,
			`${name}: crashed before it finished the fault list — ${e?.stack ?? e}\n`,
		);
		process.exit(2);
	});
};

/**
 * The CLI every new-faults front end shares: read the pair, print what is new,
 * exit 0 (nothing new) / 1 (this commit's) / 2 (could not answer).
 *
 * @param {string} name
 * @param {string | undefined} stagedFile
 * @param {string | undefined} baselineFile
 * @param {FaultDiffProfile} profile
 * @returns {never}
 */
const runCli = (name, stagedFile, baselineFile, profile) => {
	failClosedOnCrash(name);
	/* writeFd throughout, never console: every caller reads this through
	 * command substitution in .husky/pre-commit, so stdout is a pipe and node
	 * drops whatever is still buffered at process.exit (§N6). */
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
	/* THE CATCH IS DIAGNOSTIC ONLY (mantahostels#2314): failClosedOnCrash above
	 * already routes a throwing write to exit 2. */
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
