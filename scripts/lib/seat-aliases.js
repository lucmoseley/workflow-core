const path = require("node:path");
const { seatDir } = require("./config-dir.js");
const { readText } = require("./file-read.js");
const { expandShellHome } = require("./home-path.js");
const { isUnder } = require("./is-under.js");
const { requiredGroup } = require("./regex-group.js");
const { homeDir } = require("./refill-repos.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {{alias: string, dir: string, seat: string}} SeatAlias
 * @typedef {ReturnType<typeof import("./concurrency.js").readConcurrencyStatus>} ConcurrencyStatus
 * @typedef {Omit<ConcurrencyStatus, "waiting"> & {waiting:
 *   (import("./concurrency.js").Waiting & {alias: string|null})[]|null}} ConcurrencyView
 */

const ALIAS_LINE =
	/^\s*alias\s+([\w.-]+)='\(\s*cd\s+(\S+)\s+&&\s+CLAUDE_CONFIG_DIR=(\S+)\s+_wfc_agents\s*\)'/;

/**
 * @param {string} word
 * @param {string} home
 */
const resolveShellPath = (word, home) =>
	path.resolve(expandShellHome(word, home) ?? word);

/**
 * @param {string} text
 * @param {string} home
 * @returns {SeatAlias[]}
 */
function parseSeatAliases(text, home) {
	return text.split("\n").flatMap((line) => {
		const m = ALIAS_LINE.exec(line);
		if (!m) return [];
		return [
			{
				alias: requiredGroup(m, 1, ALIAS_LINE),
				dir: resolveShellPath(requiredGroup(m, 2, ALIAS_LINE), home),
				seat: seatDir(
					resolveShellPath(requiredGroup(m, 3, ALIAS_LINE), home),
					home,
				),
			},
		];
	});
}

/**
 * @param {string} [home]
 * @returns {SeatAlias[]}
 */
function readSeatAliases(home = homeDir()) {
	const file = path.join(home, ".bashrc");
	const read = readText(file);
	if (read.state === "read") return parseSeatAliases(read.data, home);
	if (read.state === "unreadable")
		writeFd(2, `seat-aliases: ${file} did not read: ${read.message}\n`);
	return [];
}

/**
 * @param {SeatAlias[]} aliases
 * @param {string} seat
 * @param {string|null} cwd
 */
function aliasFor(aliases, seat, cwd) {
	const onSeat = aliases.filter((a) => a.seat === seat);
	const inRepo = cwd ? onSeat.find((a) => isUnder(cwd, [a.dir])) : undefined;
	return (inRepo ?? onSeat[0])?.alias ?? null;
}

/**
 * @param {ConcurrencyStatus} concurrency
 * @param {SeatAlias[]} aliases
 * @returns {ConcurrencyView}
 */
const withWaitingAliases = (concurrency, aliases) => ({
	...concurrency,
	waiting:
		concurrency.waiting?.map((w) => ({
			...w,
			alias: aliasFor(aliases, w.seat, w.cwd),
		})) ?? null,
});

module.exports = { readSeatAliases, withWaitingAliases };
