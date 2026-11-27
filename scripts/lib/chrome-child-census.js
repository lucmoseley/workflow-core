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
 *   class: ChildClass, recorded: boolean}} Child
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
 * @param {string} line
 * @param {Session | undefined} session
 */
const isResultLine = (line, session) =>
	session?.chrome === true && line.includes('"tool_result"');

/**
 * @param {string} file
 * @param {string} seat
 * @param {Map<string, Session>} sessions
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
 * @param {string} file
 * @param {string} seat
 * @param {Map<string, Session>} sessions
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
		if (caught(e).code !== "ENOENT") throw e;
	}
}

/**
 * @param {{left: OpenTab[], record: ChildRecord | undefined,
 *   givenUp: boolean, lastSweepMs: number, launcherLive: boolean}} seen
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
				recorded: record !== undefined,
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
