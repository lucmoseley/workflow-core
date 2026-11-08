/*
 * refill-seats.js — the one reader of `~/.claude/refill-seats`, the machine's
 * seats in failover order (#2605, spec #2570).
 *
 * One seat per line; `#` comments and blank lines are skipped. A line that is
 * one path is a PLAN seat. An OVERFLOW seat, billed to a plan's API credits
 * through its own key, reads
 *
 *   <config dir> api key=<env var name> grant=<usd> cycle-day=<1-28>
 *
 * so a plan seat's path holds no whitespace. An overflow seat's config dir is
 * its plan seat's, which a plan line must also declare: its sessions run as
 * that plan dir's background jobs, billed to the key (#3701, spec #3691). Any
 * other line is malformed and refuses the whole file by name, never read as a
 * plan seat. A leading `~/` is the home dir.
 *
 * A seat's identity is its kind plus its dir for a plan seat, its key variable
 * for an overflow seat, which no two lines share. Plan and overflow seats may
 * share a dir, so no lookup goes by a dir alone (#3693).
 */

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
 * @typedef {{seats: Seat[], errors: string[]}} SeatList errors, each naming
 *   its line, refuse the list: a caller acts on none of `seats` while any is
 *   present
 */

const FIELDS = ["key", "grant", "cycle-day"];

/** @param {string} home */
const seatsFile = (home) => path.join(home, ".claude", "refill-seats");

/**
 * Each `name=value` word by name, or why the words are not those fields.
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
	/* 28: the last day every month has, so each month starts one cycle. */
	if (!/^\d+$/.test(day) || Number(day) < 1 || Number(day) > 28)
		return `cycle-day=${day} is not a day from 1 to 28`;
	return { keyVar, grantUsd: Number(grant), cycleDay: Number(day) };
}

/**
 * A line's overflow fields, none on a plan seat's, or why they refuse; a key
 * is the first line's to give it.
 * @param {string[]} words after the config dir
 * @param {number} lineNo
 * @param {Map<string, number>} keyLines accumulator: each key given so far, by
 *   its line
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
 * @param {{home: string, file: string}} at `file` names the lines in errors
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
	const planDirs = new Set(
		seats.flatMap((s) => (s.kind === "plan" ? [s.dir] : [])),
	);
	for (const { dir, where, named, line } of overflowLines)
		if (!planDirs.has(dir))
			errors.push(
				`${where}: ${named} has no plan seat line, and an overflow seat launches under its plan seat's config dir: ${line}`,
			);
	return { seats, errors };
}

/**
 * The seats the home dir's seat file declares; none where it is absent.
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
const declaresOverflowSeat = (list) =>
	list.seats.some((s) => s.kind === "overflow");

/**
 * @param {SeatList} list
 * @param {string} keyVar
 * @returns {OverflowSeat|null}
 */
function findOverflowSeat(list, keyVar) {
	for (const s of list.seats)
		if (s.kind === "overflow" && s.keyVar === keyVar) return s;
	return null;
}

/**
 * The seat a launch under `dir` asked for: the overflow seat `keyVar` names,
 * which must be on that dir, else the plan seat on it, declared or not; why
 * not where `keyVar` names none on `dir`.
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

/**
 * A seat's identity as a launch, park marker or pick carries it: its dir, and
 * its key where it is an overflow seat. No key is the plan seat on that dir.
 * @typedef {{seat: string, keyVar?: string}} SeatId
 */

/**
 * The identity `of` carries, with no key field on a plan seat's.
 * @param {{seat: string, keyVar?: string|null}} of
 * @returns {SeatId}
 */
const seatIdOf = ({ seat, keyVar }) => (keyVar ? { seat, keyVar } : { seat });

/**
 * Whether `a` and `b` carry one seat: a plan seat is never the overflow seat
 * that shares its dir (#4147).
 * @param {{seat: string, keyVar?: string|null}} a
 * @param {{seat: string, keyVar?: string|null}} b
 */
const isSameSeat = (a, b) =>
	a.seat === b.seat && (a.keyVar || null) === (b.keyVar || null);

/**
 * The plan seats readDeclaredSeats reads, in failover order, else the seat
 * this runs on, as where the seat file refuses. Overflow seats are read each
 * refill tick (#2611).
 */
function readConfiguredSeats() {
	const { seats, errors } = readDeclaredSeats();
	const listed =
		errors.length > 0
			? []
			: seats.filter((s) => s.kind === "plan").map((s) => s.dir);
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
 * The `.claude*` config dirs in the home dir holding credentials that the seat
 * file does not declare (#3767).
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

/**
 * The seats outside arbiter-core's sessionDirs(), so whose sessions no
 * listing shows.
 * @param {string[]} seats
 */
function unlistedSeats(seats) {
	const listed = new Set(sessionDirs().map(realKey));
	return seats.filter((s) => !listed.has(realKey(s)));
}

module.exports = {
	buildSeatName,
	declaresOverflowSeat,
	findOverflowSeat,
	isSameSeat,
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
	seatIdOf,
	seatOfLaunch,
	unlistedSeats,
};
