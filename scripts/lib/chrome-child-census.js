/*
 * chrome-child-census.js — the leftover census's reader (#5385): every Chrome
 * child on the machine, from every seat's transcripts, the record store, its
 * given-up folder and its closed log, each classed by what its tabs did.
 *
 * A CHILD is any main transcript session that called an
 * `mcp__claude-in-chrome__*` tool, launched by claude-child.js or not. Its
 * seat is the config dir its transcript sits under. Its tally is
 * lib/chrome-child.js's, fed every tool result after its first Chrome call;
 * a closer's resume writes to the same session, in the same file or another,
 * so a session's files are read oldest first into one tally.
 *
 *   running     a record names it and its launcher still runs; not counted
 *   clean       the tally leaves no tab
 *   held        its record has `heldSince`, and no sweep has run since the
 *               hold ended (`heldSince` + HOLD_MS)
 *   given-up    its record is in `given-up/`
 *   unexplained any other leftover, a launcher-less session's included
 *
 * ONE READ PER TRANSCRIPT, line by line: a line is parsed only where it names
 * a Chrome tool, or carries a tool result once the session has called one.
 * The machine's transcripts run to tens of GB, nearly none of them Chrome.
 *
 * `last-sweep` in the store holds the ISO time of the closer's last
 * `--sweep` run; a missing one means none has run.
 */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { configDirs } = require("./arbiter-store.js");
const { caught } = require("./caught.js");
const { createTabTally } = require("./chrome-child.js");
const {
	HOLD_MS,
	listGivenUp,
	listRecords,
	isProcessLive,
	readClosedLog,
	readLastSweep,
} = require("./chrome-child-store.js");
const { parseJsonlRow } = require("./jsonl.js");
const { readSeatTranscripts } = require("./project-dirs.js");

const CHROME_TOOL = "mcp__claude-in-chrome__";
const SESSION_ID = /"sessionId":"([^"]+)"/;

/**
 * @typedef {import("./chrome-child-store.js").ChildRecord} ChildRecord
 * @typedef {import("./chrome-child.js").OpenTab} OpenTab
 * @typedef {"running" | "clean" | "held" | "given-up" | "unexplained"} ChildClass
 * @typedef {{sessionId: string, seat: string, left: OpenTab[],
 *   class: ChildClass}} Child
 * @typedef {{children: Child[], listed: number, absent: string[],
 *   unreadable: string[], lastSweep: string | null}} Census
 */

/** @param {unknown} row */
function isChromeCall(row) {
	const { type, message } =
		/** @type {{type?: unknown, message?: {content?: unknown}}} */ (row);
	if (type !== "assistant" || !Array.isArray(message?.content)) return false;
	return message.content.some(
		(block) =>
			block?.type === "tool_use" &&
			typeof block.name === "string" &&
			block.name.startsWith(CHROME_TOOL),
	);
}

/**
 * @typedef {{sessionId: string, seat: string, chrome: boolean,
 *   tally: ReturnType<typeof createTabTally>}} Session
 */

/**
 * Whether `line` may carry a Chrome tool's result: a tool result, once its
 * session has called one.
 * @param {string} line
 * @param {Session | undefined} session
 */
const isResultLine = (line, session) =>
	session?.chrome === true && line.includes('"tool_result"');

/**
 * A reader of one transcript's lines into its session, made on the first row
 * naming one, else on the file's name.
 * @param {string} file
 * @param {string} seat
 * @param {Map<string, Session>} sessions accumulator: each session read is
 *   added or extended here
 * @returns {(line: string) => void}
 */
function lineReader(file, seat, sessions) {
	/** @type {Session | undefined} */
	let session;
	const sessionOf = (/** @type {string} */ id) => {
		let s = sessions.get(id);
		if (!s) {
			s = {
				sessionId: id,
				seat,
				chrome: false,
				tally: createTabTally({ missingIsEmpty: true }),
			};
			sessions.set(id, s);
		}
		return s;
	};
	return (line) => {
		if (!session) {
			const id = SESSION_ID.exec(line)?.[1];
			if (id) session = sessionOf(id);
		}
		const names = line.includes(CHROME_TOOL);
		if (!names && !isResultLine(line, session)) return;
		const row = parseJsonlRow(line);
		if (!row) return;
		session ??= sessionOf(path.basename(file, ".jsonl"));
		if (names && isChromeCall(row)) session.chrome = true;
		if (session.chrome) session.tally.read(row);
	};
}

/**
 * Feed one transcript into its session, a line at a time.
 * @param {string} file
 * @param {string} seat
 * @param {Map<string, Session>} sessions accumulator: each session read is
 *   added or extended here
 */
async function readTranscript(file, seat, sessions) {
	const read = lineReader(file, seat, sessions);
	const lines = readline.createInterface({
		input: fs.createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of lines) read(line);
	} catch (e) {
		/* A transcript gone since the listing holds no session now. */
		if (caught(e).code !== "ENOENT") throw e;
	}
}

/**
 * How a child's tabs ended.
 * @param {{left: OpenTab[], record: ChildRecord | undefined,
 *   givenUp: boolean, lastSweepMs: number, launcherLive: boolean}} seen
 *   `lastSweepMs` is -Infinity where no sweep has run
 * @returns {ChildClass}
 */
function classify({ left, record, givenUp, lastSweepMs, launcherLive }) {
	if (record && launcherLive) return "running";
	if (left.length === 0) return "clean";
	if (record?.heldSince && lastSweepMs < Date.parse(record.heldSince) + HOLD_MS)
		return "held";
	if (givenUp) return "given-up";
	return "unexplained";
}

/**
 * Every Chrome child whose transcript was written at or after `fromMs`.
 * @param {number} fromMs
 * @returns {Promise<Census>}
 */
async function readCensus(fromMs) {
	const { files, listed, absent, unreadable } = readSeatTranscripts(
		configDirs(),
	);
	const dated = files.flatMap((file) => {
		try {
			const mtimeMs = fs.statSync(file).mtimeMs;
			return mtimeMs >= fromMs ? [{ file, mtimeMs }] : [];
		} catch (e) {
			if (caught(e).code === "ENOENT") return [];
			throw e;
		}
	});
	dated.sort((a, b) => a.mtimeMs - b.mtimeMs);
	/** @type {Map<string, Session>} */
	const sessions = new Map();
	/* <seat>/projects/<slug>/<id>.jsonl */
	for (const { file } of dated)
		await readTranscript(
			file,
			path.dirname(path.dirname(path.dirname(file))),
			sessions,
		);
	const records = new Map(listRecords().map((r) => [r.sessionId, r]));
	const givenUp = new Set(listGivenUp().map((r) => r.sessionId));
	const lastSweep = readLastSweep();
	const lastSweepMs = lastSweep
		? Date.parse(lastSweep)
		: Number.NEGATIVE_INFINITY;
	const children = [...sessions.values()]
		.filter((s) => s.chrome)
		.map((s) => {
			const record = records.get(s.sessionId);
			const left = s.tally.left();
			return {
				sessionId: s.sessionId,
				seat: s.seat,
				left,
				class: classify({
					left,
					record,
					givenUp: givenUp.has(s.sessionId),
					lastSweepMs,
					launcherLive: record
						? isProcessLive(record.launcherPid, record.launcherStart)
						: false,
				}),
			};
		});
	return { children, listed, absent, unreadable, lastSweep };
}

/**
 * Each confirmed close of a held tab, from the closed log: how long the hold
 * ran and what closed it.
 * @returns {{sessionId: string, heldSince: string, closedAt: string,
 *   minutes: number, by: string}[]}
 */
function readTurnarounds() {
	return readClosedLog().flatMap(({ sessionId, heldSince, closedAt, by }) =>
		heldSince
			? [
					{
						sessionId,
						heldSince,
						closedAt,
						minutes: Math.round(
							(Date.parse(closedAt) - Date.parse(heldSince)) / 60_000,
						),
						by,
					},
				]
			: [],
	);
}

module.exports = { readCensus, readTurnarounds };
