const path = require("node:path");
const fs = require("node:fs");
const { sessionDirs } = require("./arbiter-core.js");
const { caught } = require("./caught.js");
const { realKey } = require("./deref.js");
const { configDir, seatDir } = require("./config-dir.js");
const { homeDir } = require("./refill-repos.js");
const { relativeUnder } = require("./is-under.js");

/**
 * @typedef {{dir: string, kind: "plan"}} PlanSeat
 * @typedef {{dir: string, kind: "overflow", keyVar: string, grantUsd: number,
 *   cycleDay: number}} OverflowSeat
 * @typedef {PlanSeat|OverflowSeat} Seat
 * @typedef {{seats: Seat[], errors: string[]}} SeatList
 */

const FIELDS = ["key", "grant", "cycle-day"];

/**
 * @param {Seat[]} seats
 * @returns {OverflowSeat[]}
 */
const overflowSeatsOf = (seats) =>
	seats.flatMap((s) => (s.kind === "overflow" ? [s] : []));

/**
 * @param {Seat[]} seats
 * @returns {PlanSeat[]}
 */
const planSeatsOf = (seats) =>
	seats.flatMap((s) => (s.kind === "plan" ? [s] : []));

/** @param {string} home */
const seatsFile = (home) => path.join(home, ".claude", "refill-seats");

/**
 * @param {string[]} words
 * @returns {Map<string, string>|string}
 */
function namedFields(words) {
	/** @type {Map<string, string>} */
	const given = new Map();
	for (const word of words) {
		const eq = word.indexOf("=");
		const name = eq === -1 ? word : word.slice(0, eq);
		if (eq === -1 || !FIELDS.includes(name))
			return `unknown field "${word}"; expected key=, grant= and cycle-day=`;
		if (given.has(name)) return `"${name}=" given twice`;
		given.set(name, word.slice(eq + 1));
	}
	return given;
}

/**
 * @param {string[]} words
 * @returns {Omit<OverflowSeat, "dir"|"kind">|string}
 */
function overflowFields(words) {
	if (words[0] !== "api") return `expected "api" after the config dir`;
	const given = namedFields(words.slice(1));
	if (typeof given === "string") return given;
	const keyVar = given.get("key");
	const grant = given.get("grant");
	const day = given.get("cycle-day");
	if (keyVar === undefined || grant === undefined || day === undefined)
		return `missing ${FIELDS.filter((f) => !given.has(f))
			.map((f) => `${f}=`)
			.join(", ")}`;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyVar))
		return `key=${keyVar} is not an environment variable name`;
	if (!/^\d+(\.\d+)?$/.test(grant) || Number(grant) <= 0)
		return `grant=${grant} is not a positive US$ amount`;
	if (!/^\d+$/.test(day) || Number(day) < 1 || Number(day) > 28)
		return `cycle-day=${day} is not a day from 1 to 28`;
	return { keyVar, grantUsd: Number(grant), cycleDay: Number(day) };
}

/**
 * @param {string[]} words
 * @param {number} lineNo
 * @param {Map<string, number>} keyLines
 * @returns {Omit<OverflowSeat, "dir"|"kind">|string|null}
 */
function parseLineFields(words, lineNo, keyLines) {
	if (words.length === 0) return null;
	const fields = overflowFields(words);
	if (typeof fields === "string") return fields;
	const taken = keyLines.get(fields.keyVar);
	if (taken !== undefined)
		return `key=${fields.keyVar} is already line ${taken}'s`;
	keyLines.set(fields.keyVar, lineNo);
	return fields;
}

/**
 * @param {string} text
 * @param {{home: string, file: string}} at
 * @returns {SeatList}
 */
function parseSeats(text, { home, file }) {
	/** @type {Seat[]} */
	const seats = [];
	const errors = [];
	/** @type {Map<string, number>} */
	const keyLines = new Map();
	/** @type {{dir: string, where: string, named: string, line: string}[]} */
	const overflowLines = [];
	for (const [i, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const [first, ...rest] = line.split(/\s+/);
		if (first === undefined) continue;
		const dir = seatDir(first, home);
		const fields = parseLineFields(rest, i + 1, keyLines);
		if (typeof fields === "string") {
			errors.push(`${file}:${i + 1}: ${fields}: ${line}`);
			continue;
		}
		if (fields !== null)
			overflowLines.push({
				dir,
				where: `${file}:${i + 1}`,
				named: first,
				line,
			});
		seats.push(
			fields === null
				? { dir, kind: "plan" }
				: { dir, kind: "overflow", ...fields },
		);
	}
	const planDirs = new Set(planSeatsOf(seats).map((s) => s.dir));
	for (const { dir, where, named, line } of overflowLines)
		if (!planDirs.has(dir))
			errors.push(
				`${where}: ${named} has no plan seat line, and an overflow seat launches under its plan seat's config dir: ${line}`,
			);
	return { seats, errors };
}

/**
 * @param {string} [home]
 * @returns {SeatList}
 */
function readDeclaredSeats(home = homeDir()) {
	const file = seatsFile(home);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return { seats: [], errors: [] };
		return {
			seats: [],
			errors: [`${file}: ${caught(err).message}`],
		};
	}
	return parseSeats(text, { home, file });
}

/**
 * @param {SeatList} list
 * @returns {boolean}
 */
const declaresOverflowSeat = (list) => overflowSeatsOf(list.seats).length > 0;

/**
 * @param {SeatList} list
 * @param {string} keyVar
 * @returns {OverflowSeat|null}
 */
function findOverflowSeat(list, keyVar) {
	return overflowSeatsOf(list.seats).find((s) => s.keyVar === keyVar) ?? null;
}

/**
 * @param {SeatList} list
 * @param {{dir: string, keyVar?: string}} asked
 * @param {string} [home]
 * @returns {Seat|{why: string}}
 */
function seatOfLaunch(list, { dir, keyVar }, home = homeDir()) {
	const want = seatDir(dir, home);
	if (keyVar) {
		const seat = findOverflowSeat(list, keyVar);
		if (!seat) return { why: `no overflow seat has key=${keyVar}` };
		return seat.dir === want
			? seat
			: { why: `key=${keyVar} is ${seat.dir}'s overflow seat, not ${want}'s` };
	}
	return { dir: want, kind: "plan" };
}

/** @typedef {{seat: string, keyVar?: string}} SeatId */

/**
 * @param {{seat: string, keyVar?: string|null}} of
 * @returns {SeatId}
 */
const seatIdOf = ({ seat, keyVar }) => (keyVar ? { seat, keyVar } : { seat });

/**
 * @param {{seat: string|null, keyVar?: string|null}} a
 * @param {{seat: string|null, keyVar?: string|null}} b
 */
const isSameSeat = (a, b) =>
	a.seat === b.seat && (a.keyVar || null) === (b.keyVar || null);

function readConfiguredSeats() {
	const { seats, errors } = readDeclaredSeats();
	const listed = errors.length > 0 ? [] : planSeatsOf(seats).map((s) => s.dir);
	if (listed.length > 0) return listed;
	return [configDir()];
}

/**
 * @param {string} seat
 * @param {string} [home]
 */
function buildSeatName(seat, home = homeDir()) {
	const rel = relativeUnder(home, seat);
	return rel ? `~/${rel}` : seat;
}

/**
 * @param {string} seat
 * @returns {import("./refill-decide.js").SeatReason}
 */
const buildMovedReason = (seat) => `moved from ${buildSeatName(seat)}`;

/**
 * @param {{dir: string, keyVar?: string|null}
 *   | {seat: string|null, keyVar?: string|null}} of
 */
function buildSeatLabel(of) {
	const dir = "dir" in of ? of.dir : of.seat;
	if (dir === null) return "the seat file";
	return of.keyVar ? `${dir} key=${of.keyVar}` : dir;
}

/**
 * @param {SeatList} list
 * @param {string} [home]
 * @returns {string[]}
 */
function readOmittedDirs(list, home = homeDir()) {
	const declared = new Set(list.seats.map((s) => realKey(s.dir)));
	let names;
	try {
		names = fs.readdirSync(home);
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
	return names
		.filter((n) => n.startsWith(".claude"))
		.map((n) => path.join(home, n))
		.filter(
			(d) =>
				fs.existsSync(path.join(d, ".credentials.json")) &&
				!declared.has(realKey(d)),
		)
		.sort();
}

/** @param {string[]} seats */
function unlistedSeats(seats) {
	const listed = new Set(sessionDirs().map(realKey));
	return seats.filter((s) => !listed.has(realKey(s)));
}

module.exports = {
	buildMovedReason,
	buildSeatLabel,
	buildSeatName,
	declaresOverflowSeat,
	findOverflowSeat,
	isSameSeat,
	overflowSeatsOf,
	planSeatsOf,
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
	seatIdOf,
	seatOfLaunch,
	unlistedSeats,
};
