const fs = require("node:fs");
const path = require("node:path");
const { caught, ignoreFailure } = require("./caught.js");
const { parseJsonl } = require("./jsonl.js");
const { withDirLock } = require("./dir-lock.js");
const { writeFileAtomic } = require("./atomic-write.js");

const DAY_MS = 24 * 60 * 60 * 1000;
// guess, #5785
const MAX_GAP_MS = DAY_MS;

/** @param {string} file */
const lockOf = (file) => `${file}.lock`;

/**
 * @param {string|null} file
 * @param {Record<string, unknown> & { at: string }} entry
 * @param {number} retainMs
 * @param {{dropOnBadLine?: boolean, now?: () => number}} [options]
 * @returns {boolean}
 */
function appendRetained(
	file,
	entry,
	retainMs,
	{ dropOnBadLine = false, now = Date.now } = {},
) {
	if (!file) return false;
	let landed = false;
	ignoreFailure(() =>
		withDirLock(
			lockOf(file),
			(held) => {
				if (held && dropOnBadLine)
					replaceCarrying(file, (text) => {
						const { bad, zeroed } = parseJsonl(text);
						return bad.length + zeroed.length > 0 ? null : undefined;
					});
				fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
				landed = true;
				if (held) prune(file, retainMs, now());
			},
			now,
		),
	);
	return landed;
}

/**
 * @param {string} file
 * @param {number} retainMs
 * @param {number} now
 */
function prune(file, retainMs, now) {
	ignoreFailure(() =>
		replaceCarrying(file, (text) => {
			const aged = agedRows(parseJsonl(text).rows, now);
			const [oldest] = aged;
			if (oldest === undefined || !(oldest.age > retainMs + DAY_MS)) return;
			return aged
				.filter(({ age }) => age <= retainMs)
				.map(({ row }) => `${JSON.stringify(row)}\n`)
				.join("");
		}),
	);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {number} now
 */
function agedRows(rows, now) {
	const aged = rows.map((row) => {
		const at = Date.parse(String(row.at));
		return { row, at, stamp: Math.min(at, now), elapsed: 0, age: Number.NaN };
	});
	const dated = aged
		.filter(({ at }) => !Number.isNaN(at))
		.sort((x, y) => x.stamp - y.stamp);
	let elapsed = 0;
	let previous = Number.NaN;
	for (const entry of dated) {
		if (!Number.isNaN(previous))
			elapsed += Math.min(entry.stamp - previous, MAX_GAP_MS);
		entry.elapsed = elapsed;
		previous = entry.stamp;
	}
	for (const entry of dated)
		entry.age = Math.min(now - entry.at, elapsed - entry.elapsed);
	return aged;
}

/**
 * @param {string} file
 * @param {(text: string) => string | null | undefined} next
 */
function replaceCarrying(file, next) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (e) {
		if (caught(e).code === "ENOENT") return;
		throw e;
	}
	try {
		const { ino } = fs.fstatSync(fd);
		const text = fs.readFileSync(fd);
		const out = next(text.toString("utf8"));
		if (out === undefined) return;
		if (fs.statSync(file, { throwIfNoEntry: false })?.ino !== ino) return;
		if (out === null) fs.rmSync(file, { force: true });
		else writeFileAtomic(file, out);
		for (let read = text.length; ; ) {
			const { size } = fs.fstatSync(fd);
			if (size <= read) break;
			const tail = Buffer.alloc(size - read);
			fs.readSync(fd, tail, 0, tail.length, read);
			fs.appendFileSync(file, tail);
			read = size;
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @param {string} dir
 * @param {number} beforeMs
 * @param {() => number} [now]
 */
function sweepRetained(dir, beforeMs, now = Date.now) {
	for (const name of fs.readdirSync(dir)) {
		const entry = path.join(dir, name);
		if (name.endsWith(".jsonl")) removeUntouched(entry, beforeMs, now);
		else if (name.includes(".jsonl.") && writtenBefore(entry, beforeMs))
			fs.rmSync(entry, { recursive: true, force: true });
	}
}

/**
 * @param {string} file
 * @param {number} beforeMs
 */
const writtenBefore = (file, beforeMs) => {
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	return stat !== undefined && stat.mtimeMs < beforeMs;
};

/**
 * @param {string} file
 * @param {number} beforeMs
 * @param {() => number} now
 */
function removeUntouched(file, beforeMs, now) {
	withDirLock(
		lockOf(file),
		(held) => {
			if (held && writtenBefore(file, beforeMs))
				replaceCarrying(file, () => null);
		},
		now,
	);
}

module.exports = {
	DAY_MS,
	appendRetained,
	sweepRetained,
};
