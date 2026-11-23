const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId, holderAlive } = require("./arbiter-proc.js");
const core = require("./arbiter-core.js");
const { isWantRecord } = require("./arbiter-records.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").WantRecord} WantRecord */

// guess, #5529
const WANT_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * @param {string} subject
 * @param {Identity} me
 */
function recordWant(subject, me) {
	if (!me?.sessionId) return;
	try {
		fs.mkdirSync(core.paths.wantsDir(), { recursive: true });
		core.writeRecord(core.paths.want(me.sessionId), {
			sessionId: me.sessionId,
			wants: subject,
			pid: me.pid ?? null,
			procStart: me.procStart ?? null,
			bootId: readCurrentBootId() || undefined,
			since: new Date().toISOString(),
		});
	} catch (e) {
		core.logError(`want record ${subject}`, e);
	}
}

/** @param {string|null} sessionId */
function dropWant(sessionId) {
	if (!sessionId) return;
	try {
		fs.unlinkSync(core.paths.want(sessionId));
	} catch (e) {
		if (caught(e).code !== "ENOENT") core.logError(`want drop ${sessionId}`, e);
	}
}

function readWants() {
	let files = [];
	try {
		files = fs
			.readdirSync(core.paths.wantsDir())
			.filter((f) => f.endsWith(".json"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		core.logError("want list", e);
		return null;
	}
	/** @type {WantRecord[]} */
	const out = [];
	for (const f of files) {
		const file = path.join(core.paths.wantsDir(), f);
		let record = null;
		try {
			record = core.readRecordAs(file, isWantRecord);
		} catch {
			continue;
		}
		if (!record || !holderAlive(record)) continue;
		out.push(record);
	}
	return out;
}

module.exports = {
	dropWant,
	readWants,
	recordWant,
	WANT_AGE_MS,
};
