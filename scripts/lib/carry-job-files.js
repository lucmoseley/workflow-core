const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { escapeRe } = require("./regex-group.js");
const { relativeUnder } = require("./is-under.js");
const { trimEndRun } = require("./trim-run.js");
const { parseJsonlRow } = require("./jsonl.js");
const { readWholeLines } = require("./session-transcript.js");
const { realPathOrNull } = require("./real-path.js");

/**
 * @param {{text: string, jobDir: string, jobId: string, checkout: string}} job
 * @returns {{text: string, carried: {from: string, to: string}[]}}
 */
function carryJobFiles({ text, jobDir, jobId, checkout }) {
	const real = realPathOrNull(jobDir);
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
	const resolved = realPathOrNull(from);
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

/** @param {{from: string, to: string}[]} carried */
const buildCarriedNote = (carried) =>
	carried.length === 0
		? ""
		: `Files an earlier prompt named in this job's directory, which removing the job deletes, were copied out: ${carried.map((c) => `${c.from} is now ${c.to}`).join("; ")}.`;

/**
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
