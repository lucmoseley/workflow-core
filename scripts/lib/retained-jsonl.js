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
			const { rows } = parseJsonl(text);
			const ageOf = (/** @type {Record<string, unknown>} */ row) =>
				now - Date.parse(String(row.at));
			const [oldest] = rows;
			if (oldest === undefined || !(ageOf(oldest) > retainMs + DAY_MS)) return;
			return rows
				.filter((row) => ageOf(row) <= retainMs)
				.map((row) => `${JSON.stringify(row)}\n`)
				.join("");
		}),
	);
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
 * @param {number} untouchedMs
 * @param {() => number} [now]
 */
function sweepRetained(dir, untouchedMs, now = Date.now) {
	const entries = fs.readdirSync(dir).flatMap((name) => {
		if (!name.endsWith(".jsonl") && !name.includes(".jsonl.")) return [];
		const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
		return stat === undefined ? [] : [{ name, mtimeMs: stat.mtimeMs }];
	});
	const ages = timelineAges(
		entries.map(({ mtimeMs }) => mtimeMs),
		now(),
	);
	entries.forEach(({ name, mtimeMs }, i) => {
		if (!((ages[i] ?? 0) > untouchedMs)) return;
		const entry = path.join(dir, name);
		if (name.endsWith(".jsonl")) removeUntouched(entry, mtimeMs, now);
		else fs.rmSync(entry, { recursive: true, force: true });
	});
}

/**
 * @param {number[]} stamps
 * @param {number} now
 * @returns {number[]}
 */
function timelineAges(stamps, now) {
	const order = stamps
		.map((at, i) => ({ i, stamp: Math.min(at, now) }))
		.sort((x, y) => x.stamp - y.stamp);
	const elapsed = new Array(stamps.length).fill(0);
	let total = 0;
	order.forEach(({ i, stamp }, k) => {
		const previous = order[k - 1];
		if (previous) total += Math.min(stamp - previous.stamp, MAX_GAP_MS);
		elapsed[i] = total;
	});
	return stamps.map((at, i) => Math.min(now - at, total - elapsed[i]));
}

/**
 * @param {string} file
 * @param {number} mtimeMs
 * @param {() => number} now
 */
function removeUntouched(file, mtimeMs, now) {
	withDirLock(
		lockOf(file),
		(held) => {
			const stat = fs.statSync(file, { throwIfNoEntry: false });
			if (held && stat?.mtimeMs === mtimeMs) replaceCarrying(file, () => null);
		},
		now,
	);
}

module.exports = {
	DAY_MS,
	appendRetained,
	sweepRetained,
};
