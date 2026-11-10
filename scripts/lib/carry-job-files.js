/*
 * carry-job-files.js — the files a background job's prompt names in its own
 * job directory, copied out before `claude rm` deletes that directory (#4750).
 * The harness saves a pasted image there (`<seat>/jobs/<id>/tmp/pasted-<hex>.png`,
 * older `<seat>/jobs/<id>/pasted-N.png`) and names it in the prompt, so every
 * route that removes a job carries them first: the main-checkout job guard's
 * relaunch and the refill loop's removal of a job record. A file pasted in a
 * later turn is named in the transcript's user turns instead
 * (readUserTurnsNaming).
 *
 * Each copy lands in its checkout's ignored `.claude/tmp/attachments/<job>/`,
 * at its path below the job directory. The directory matches as given or
 * resolved; punctuation glued after a path that does not exist is dropped. A
 * file already gone, or resolving outside the job directory, is one removal
 * cannot delete, and is left named as it was. A file whose copy is already
 * there counts as carried, so a second pass after the directory is gone still
 * names it. Residual: a path holding a space is cut there, so it is not
 * matched and not carried.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { escapeRe } = require("./regex-group.js");
const { relativeUnder } = require("./is-under.js");
const { trimEndRun } = require("./trim-run.js");
const { parseJsonlRow } = require("./jsonl.js");
const { readWholeLines } = require("./session-transcript.js");

/**
 * `p` resolved; null where it, or a directory on its way, does not exist.
 * @param {string} p
 */
function realOrNull(p) {
	try {
		return fs.realpathSync(p);
	} catch (err) {
		const { code } = /** @type {NodeJS.ErrnoException} */ (err);
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw err;
	}
}

/**
 * `text` with each file it names under `jobDir` copied to
 * `<checkout>/.claude/tmp/attachments/<jobId>/` and named there instead, and what was
 * carried; throws naming a file it cannot copy.
 * @param {{text: string, jobDir: string, jobId: string, checkout: string}} job
 * @returns {{text: string, carried: {from: string, to: string}[]}}
 */
function carryJobFiles({ text, jobDir, jobId, checkout }) {
	const real = realOrNull(jobDir);
	const spellings = [
		...new Set([path.resolve(jobDir), ...(real ? [real] : [])]),
	];
	const unders = spellings.map((d) => `(${escapeRe(`${d}${path.sep}`)})`);
	const named = new RegExp(`(?:${unders.join("|")})[^\\s'"\`<>|]+`, "g");
	const into = path.join(checkout, ".claude", "tmp", "attachments", jobId);
	/** @type {{from: string, to: string}[]} */
	const carried = [];
	const out = text.replace(named, (token, ...groups) => {
		const under = String(
			spellings[groups.findIndex((g) => typeof g === "string")],
		);
		for (const from of [token, trimEndRun(token, ".,;:)]")]) {
			const one = carryOne(from, { under, real, into, checkout });
			if (one.kind === "absent") continue;
			if (one.kind === "left") return token;
			const { to } = one;
			if (!carried.some((c) => c.from === from)) carried.push({ from, to });
			return `${to}${token.slice(from.length)}`;
		}
		return token;
	});
	return { text: out, carried };
}

/**
 * `from`, named under job directory spelling `under`: `carried` to `to`;
 * `left` where removal cannot delete it; `absent` where neither it nor its
 * copy exists.
 * @param {string} from
 * @param {{under: string, real: string|null, into: string, checkout: string}} at
 * @returns {{kind: "carried", to: string} | {kind: "left"} | {kind: "absent"}}
 */
function carryOne(from, { under, real, into, checkout }) {
	const rel = relativeUnder(under, path.resolve(from));
	if (!rel) return { kind: "left" };
	const to = path.join(into, rel);
	if (!fs.existsSync(from))
		return fs.existsSync(to) ? { kind: "carried", to } : { kind: "absent" };
	const resolved = realOrNull(from);
	if (!real || !resolved || !relativeUnder(real, resolved))
		return { kind: "left" };
	copyOut(from, to, checkout);
	return { kind: "carried", to };
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} checkout
 */
function copyOut(from, to, checkout) {
	try {
		if (!fs.existsSync(checkout))
			throw new Error(`its checkout ${checkout} is gone`);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(from, to);
	} catch (err) {
		throw new Error(
			`carrying ${from} out of its job directory failed: ${caught(err).message}`,
			{
				cause: err,
			},
		);
	}
}

/**
 * The line telling a resumed session where `carried` went; empty where
 * nothing was.
 * @param {{from: string, to: string}[]} carried
 */
const buildCarriedNote = (carried) =>
	carried.length === 0
		? ""
		: `Files an earlier prompt named in this job's directory, which removing the job deletes, were copied out: ${carried.map((c) => `${c.from} is now ${c.to}`).join("; ")}.`;

/**
 * The text of each user turn in transcript `file` that names job `jobId`'s
 * directory, a turn's own words and no tool result; empty where the
 * transcript is gone.
 * @param {string} file
 * @param {string} jobId
 */
function readUserTurnsNaming(file, jobId) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return "";
		throw err;
	}
	const needle = `${path.sep}jobs${path.sep}${jobId}${path.sep}`;
	/** @type {string[]} */
	const said = [];
	try {
		for (const chunk of readWholeLines(fd))
			for (const line of chunk.toString("utf8").split("\n"))
				if (line.includes(needle)) said.push(...userWords(line));
	} finally {
		fs.closeSync(fd);
	}
	return said.join("\n");
}

/**
 * A transcript line's user words: its string content, else its text blocks.
 * @param {string} line
 * @returns {string[]}
 */
function userWords(line) {
	const row = /** @type {Record<string, any> | null | undefined} */ (
		parseJsonlRow(line)
	);
	if (row?.type !== "user" || row.isMeta === true) return [];
	const content = row.message?.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(/** @type {any} */ b) =>
				b?.type === "text" && typeof b.text === "string",
		)
		.map((/** @type {{text: string}} */ b) => b.text);
}

module.exports = { buildCarriedNote, carryJobFiles, readUserTurnsNaming };
