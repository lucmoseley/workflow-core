const fs = require("node:fs");
const { orFallback } = require("./caught.js");

const store = require("./arbiter-store");
const { findNewestTranscript } = require("./transcript");
const { readTail } = require("./file-read.js");
const { parseJsonlRow } = require("./jsonl.js");

// guess: room for a Stop's whole-file read, lucmoseley/mantahostels#2299
const WHOLE_FILE_LIMIT = 16 * 1024 * 1024;
const TAIL_BYTES = WHOLE_FILE_LIMIT / 2;

/**
 * @param {{transcript_path?: unknown}} payload
 * @param {string} sessionId
 * @returns {string | null}
 */
function resolve(payload, sessionId) {
	const named = payload?.transcript_path;
	if (
		typeof named === "string" &&
		named !== "" &&
		orFallback(() => {
			fs.accessSync(named, fs.constants.R_OK);
			return true;
		}, false)
	)
		return named;
	return findNewestTranscript(store.configDirs(), sessionId)?.file ?? null;
}

/**
 * @param {string} file
 * @returns {string}
 */
function read(file) {
	const size = fs.statSync(file).size;
	if (size <= WHOLE_FILE_LIMIT) return fs.readFileSync(file, "utf8");

	const tail = readTail(file, TAIL_BYTES);
	if (tail.state === "absent")
		throw Object.assign(new Error(`ENOENT: ${file} deleted mid-read`), {
			code: "ENOENT",
		});
	if (tail.state === "unreadable") throw tail.error;
	const { text, partial } = tail.data;
	if (!partial) return text;
	const cut = text.indexOf("\n");
	return cut === -1 ? "" : text.slice(cut + 1);
}

// workflow-core#2944 measured first-stamp offsets; one record runs to ~60 KB
const CHUNK_BYTES = 64 * 1024;

const RESUME_NEEDLE = Buffer.from('"hookName":"SessionStart:resume"');

/** @param {number} fd */
function* readWholeLines(fd) {
	const buf = Buffer.alloc(CHUNK_BYTES);
	let pending = Buffer.alloc(0);
	for (let at = 0; ; at += CHUNK_BYTES) {
		const got = fs.readSync(fd, buf, 0, CHUNK_BYTES, at);
		const bytes = Buffer.concat([pending, buf.subarray(0, got)]);
		const cut = got < CHUNK_BYTES ? bytes.length : bytes.lastIndexOf(10) + 1;
		pending = bytes.subarray(cut);
		yield bytes.subarray(0, cut);
		if (got < CHUNK_BYTES) return;
	}
}

/** @param {string} line */
function parseStamped(line) {
	const record =
		/** @type {{ timestamp?: string, attachment?: { hookName?: string } } | null | undefined} */ (
			parseJsonlRow(line)
		);
	if (!record) return null;
	const t = Date.parse(record.timestamp ?? "");
	return { record, t: Number.isNaN(t) ? null : t };
}

/** @param {number} fd */
function readStartMarks(fd) {
	/** @type {number | null} */
	let first = null;
	/** @type {number | null} */
	let resumed = null;
	for (const chunk of readWholeLines(fd)) {
		if (first !== null && !chunk.includes(RESUME_NEEDLE)) continue;
		for (const line of chunk.toString("utf8").split("\n")) {
			const got = parseStamped(line);
			if (first === null) first = got?.t ?? null;
			if (got?.record?.attachment?.hookName === "SessionStart:resume")
				resumed = got.t ?? resumed;
		}
	}
	return { first, resumed };
}

/**
 * @param {string} file
 * @returns {number | null}
 */
function readStartedAt(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const { first, resumed } = readStartMarks(fd);
		return resumed ?? first;
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

// workflow-core#4992 guess
const MODEL_TAIL_BYTES = 1024 * 1024;

/**
 * @param {string} file
 * @returns {string}
 */
function readLastModel(file) {
	const tail = readTail(file, MODEL_TAIL_BYTES);
	if (tail.state !== "read") return "";
	const lines = tail.data.text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		if (!line.includes('"type":"assistant"')) continue;
		const row =
			/** @type {{message?: {model?: unknown}} | null | undefined} */ (
				parseJsonlRow(line)
			);
		const model = row?.message?.model;
		if (typeof model === "string" && model && model !== "<synthetic>")
			return model;
	}
	return "";
}

module.exports = {
	readLastModel,
	resolve,
	read,
	readStartedAt,
	readWholeLines,
};
