/*
 * adopter-consent.js — the founder's yes/no about a plugin upgrade, crossing
 * from the chat to disk (workflow-core#238, workflow-core#245).
 *
 * Two records, keyed `<repo>@<tag>` — `repo` is the adopter root the session
 * is running in, `tag` the pin ref being proposed, so two adopters sharing a
 * config dir never satisfy each other's consent and a later tag in the same
 * repo is asked about fresh:
 *
 *   decline          permanent for that repo+tag. Read by
 *                     scripts/check-plugin-gap.js (workflow-core#243) to silence the
 *                     reporter for a tag the founder already said no to.
 *   pendingConsent    written on a yes. Read and cleared by
 *                     scripts/reconcile-plugin.js (workflow-core#247) once — and only
 *                     once — its materialise succeeds.
 *
 * NOTHING HERE CAN EXPRESS "accepted and completed". Clearing the pending
 * record on success IS the record of success; there is no third state. A
 * materialise that fails leaves the pending record in place, so the reporter
 * (which only reads decline, never pending) keeps speaking and the founder is
 * asked again next session rather than the gap going silently unclosed.
 *
 * STORAGE is one directory for the machine: the sorted config-dir candidate
 * list, the first this process can write to, so every `~/.claude*`
 * plan on this machine agrees on one directory without talking to each other
 * (lib/can-hold-state.js). A PRODUCTION CALLER PASSES NO `configDir` — the
 * CLI writes through the scan, so a reader that named an explicit dir instead
 * could disagree with it about which plan's directory is "the" one. `configDir`
 * is a TEST-ONLY override, bypassing the scan outright so a test never touches
 * the real registry.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { configDir: runningConfigDir } = require("./config-dir.js");
// Called as `store.configDirs()`, never destructured: a test forcing the
// fallback spies on this live property.
const store = require("./arbiter-store.js");
const { canHoldState } = require("./can-hold-state.js");

/** Memoised per config-dir set. */
let baseMemo = { key: "", value: "" };

/**
 * The one directory this consent store's files live under.
 * @param {string} [configDir] an explicit override, bypassing the scan
 */
function base(configDir) {
	if (configDir) return path.join(configDir, "adopter-upgrade", "consent");
	let dirsKey = "";
	let scanFailed = false;
	try {
		dirsKey = store.configDirs().join("\n");
	} catch {
		// A thrown configDirs() leaves dirsKey "" — the same string baseMemo.key
		// starts at, so without this flag the very first failing call would read
		// as a cache hit on the unset memo and return "" rather than falling
		// through to the runningConfigDir() fallback below.
		scanFailed = true;
	}
	if (!scanFailed && baseMemo.key === dirsKey) return baseMemo.value;
	let value;
	try {
		const dirs = store
			.configDirs()
			.map((cfg) => path.join(cfg, "adopter-upgrade", "consent"))
			.sort();
		// Not pinnedOrFirstUsable: consent is machine-wide, so there is no
		// per-project arbiter store to prefer.
		// configDirs() always lists the running config dir, so an empty list is a
		// broken invariant; it lands in the catch's fallback, as a failed scan
		// does, rather than storing undefined as the base (workflow-core#1344).
		const first = dirs[0];
		if (first === undefined) throw new Error("configDirs() named no directory");
		value = dirs.find(canHoldState) || first;
	} catch {
		value = path.join(runningConfigDir(), "adopter-upgrade", "consent");
	}
	baseMemo = { key: dirsKey, value };
	return value;
}

/** A `<repo>@<tag>` key spelled safely as part of a filename. @param {string} s */
const slug = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");

/** @param {string} repo @param {string} tag */
const keyOf = (repo, tag) => `${repo}@${tag}`;

/** @param {string} repo @param {string} tag @param {string} [configDir] */
const declineFile = (repo, tag, configDir) =>
	path.join(base(configDir), `${slug(keyOf(repo, tag))}.decline.json`);

/** @param {string} repo @param {string} tag @param {string} [configDir] */
const pendingFile = (repo, tag, configDir) =>
	path.join(base(configDir), `${slug(keyOf(repo, tag))}.pending.json`);

/**
 * Write `obj` to `file` atomically. Never throws. Returns whether it landed.
 * @param {string} file @param {object} obj
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
 * Read one JSON record. `null` for absent, unreadable or torn — never a
 * throw.
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
 * Record a permanent decline for `repo`+`tag`. Idempotent.
 * @param {string} repo @param {string} tag
 * @param {{configDir?: string}} [opts]
 * @returns {boolean} whether the write landed
 */
function decline(repo, tag, { configDir } = {}) {
	return atomicWriteJSON(declineFile(repo, tag, configDir), {
		repo,
		tag,
		declinedAt: new Date().toISOString(),
	});
}

/**
 * Whether `repo`+`tag` carries a decline record.
 * @param {string} repo @param {string} tag
 * @param {{configDir?: string}} [opts]
 */
function isDeclined(repo, tag, { configDir } = {}) {
	return readJSON(declineFile(repo, tag, configDir)) !== null;
}

/**
 * Record a pending consent — the founder said yes, materialise still owed.
 * @param {string} repo @param {string} tag
 * @param {{configDir?: string}} [opts]
 * @returns {boolean} whether the write landed
 */
function setPendingConsent(repo, tag, { configDir } = {}) {
	return atomicWriteJSON(pendingFile(repo, tag, configDir), {
		repo,
		tag,
		acceptedAt: new Date().toISOString(),
	});
}

/**
 * The pending consent for `repo`+`tag`, or null where none is owed.
 * @param {string} repo @param {string} tag
 * @param {{configDir?: string}} [opts]
 * @returns {{repo: string, tag: string, acceptedAt: string}|null}
 */
function readPendingConsent(repo, tag, { configDir } = {}) {
	const record = readJSON(pendingFile(repo, tag, configDir));
	if (
		!record ||
		typeof record.repo !== "string" ||
		typeof record.tag !== "string" ||
		typeof record.acceptedAt !== "string"
	)
		return null;
	return { repo: record.repo, tag: record.tag, acceptedAt: record.acceptedAt };
}

/**
 * Consume the pending consent for `repo`+`tag` — called once the materialise
 * that closed it has actually succeeded. Idempotent: clearing one never set,
 * or already cleared, is not an error.
 * @param {string} repo @param {string} tag
 * @param {{configDir?: string}} [opts]
 * @returns {boolean} whether a record was there to clear
 */
function clearPendingConsent(repo, tag, { configDir } = {}) {
	try {
		fs.unlinkSync(pendingFile(repo, tag, configDir));
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	base,
	decline,
	isDeclined,
	setPendingConsent,
	readPendingConsent,
	clearPendingConsent,
};
