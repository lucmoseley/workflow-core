const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { configDir: runningConfigDir } = require("./config-dir.js");
const store = require("./arbiter-store.js");
const { canHoldState } = require("./can-hold-state.js");

let baseMemo = { key: "", value: "" };

/** @param {string} [configDir] */
function base(configDir) {
	if (configDir) return path.join(configDir, "adopter-upgrade", "consent");
	let dirsKey = "";
	let scanFailed = false;
	try {
		dirsKey = store.configDirs().join("\n");
	} catch {
		scanFailed = true;
	}
	if (!scanFailed && baseMemo.key === dirsKey) return baseMemo.value;
	let value;
	try {
		const dirs = store
			.configDirs()
			.map((cfg) => path.join(cfg, "adopter-upgrade", "consent"))
			.sort();
		const first = dirs[0];
		if (first === undefined) throw new Error("configDirs() named no directory");
		value = dirs.find(canHoldState) || first;
	} catch {
		value = path.join(runningConfigDir(), "adopter-upgrade", "consent");
	}
	baseMemo = { key: dirsKey, value };
	return value;
}

/** @param {string} s */
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
 * @param {string} file
 * @param {object} obj
 */
function atomicWriteJSON(file, obj) {
	try {
		writeFileAtomic(file, `${JSON.stringify(obj)}\n`, { mkdir: true });
		return true;
	} catch {
		return false;
	}
}

/** @param {string} file */
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
 * @param {string} repo
 * @param {string} tag
 * @param {{configDir?: string}} [opts]
 * @returns {boolean}
 */
function decline(repo, tag, { configDir } = {}) {
	return atomicWriteJSON(declineFile(repo, tag, configDir), {
		repo,
		tag,
		declinedAt: new Date().toISOString(),
	});
}

/**
 * @param {string} repo
 * @param {string} tag
 * @param {{configDir?: string}} [opts]
 */
function isDeclined(repo, tag, { configDir } = {}) {
	return readJSON(declineFile(repo, tag, configDir)) !== null;
}

/**
 * @param {string} repo
 * @param {string} tag
 * @param {{configDir?: string}} [opts]
 * @returns {boolean}
 */
function setPendingConsent(repo, tag, { configDir } = {}) {
	return atomicWriteJSON(pendingFile(repo, tag, configDir), {
		repo,
		tag,
		acceptedAt: new Date().toISOString(),
	});
}

/**
 * @param {string} repo
 * @param {string} tag
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
 * @param {string} repo
 * @param {string} tag
 * @param {{configDir?: string}} [opts]
 * @returns {boolean}
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
