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
 * so a plan seat's path holds no whitespace. Any other line is malformed and
 * refuses the whole file by name, never read as a plan seat. A leading `~/`
 * is the home dir.
 */

const path = require("node:path");
const fs = require("node:fs");
const { caught } = require("./caught.js");
const { configDir } = require("./config-dir.js");
const { homeDir } = require("./refill-repos.js");
const { scriptPath } = require("./script-path.js");
const { writeFd } = require("./write-fd.js");

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

/** @param {string} p @param {string} home */
function expanded(p, home) {
	return path.resolve(p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
}

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
 * @param {string} text
 * @param {{home: string, file: string}} at `file` names the lines in errors
 * @returns {SeatList}
 */
function parseSeats(text, { home, file }) {
	/** @type {Seat[]} */
	const seats = [];
	const errors = [];
	for (const [i, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const [first, ...rest] = line.split(/\s+/);
		if (first === undefined) continue;
		const dir = expanded(first, home);
		const fields = rest.length === 0 ? null : overflowFields(rest);
		if (typeof fields === "string") {
			errors.push(`${file}:${i + 1}: ${fields}: ${line}`);
			continue;
		}
		seats.push(
			fields === null
				? { dir, kind: "plan" }
				: { dir, kind: "overflow", ...fields },
		);
	}
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
 * The seat a config dir is: its declaration, else a plan seat.
 * @param {SeatList} list
 * @param {string} dir
 * @param {string} [home]
 * @returns {Seat}
 */
function seatOf(list, dir, home = homeDir()) {
	const want = expanded(dir, home);
	return list.seats.find((s) => s.dir === want) ?? { dir: want, kind: "plan" };
}

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

module.exports = { readConfiguredSeats, readDeclaredSeats, seatOf };

/*
 * CLI mode, for the dispatcher.
 *
 *   kind <config dir>   prints `plan` or `overflow`; 2, each malformed line
 *                       on stderr, where the seat file refuses
 */
if (require.main === module) {
	const [command, dir] = process.argv.slice(2);
	if (command !== "kind" || !dir) {
		writeFd(
			2,
			`usage: node ${scriptPath("lib/refill-seats.js")} kind <config dir>\n`,
		);
		process.exit(2);
	}
	const list = readDeclaredSeats();
	if (list.errors.length > 0) {
		for (const e of list.errors) writeFd(2, `${e}\n`);
		process.exit(2);
	}
	writeFd(1, `${seatOf(list, dir).kind}\n`);
}
