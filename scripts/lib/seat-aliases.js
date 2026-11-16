/*
 * seat-aliases.js — the founder's shell aliases that open a seat's agents view
 * (#5293), read from `~/.bashrc`, where he keeps one per repo and seat:
 *
 *   alias manta2='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude2 _wfc_agents)'
 *
 * Each seat is put in the seat file's form, so it compares equal to a listing
 * record's. A line of any other shape is skipped, and an absent `.bashrc` gives
 * none: the panel then names the seat alone. One that will not read says so on
 * stderr, as no alias then looks the same as none defined.
 */

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
 * @typedef {ReturnType<typeof import("./concurrency.js").readConcurrencyStatus>}
 *   ConcurrencyStatus
 * @typedef {Omit<ConcurrencyStatus, "waiting"> & {waiting:
 *   (import("./concurrency.js").Waiting & {alias: string|null})[]|null}}
 *   ConcurrencyView  the status, each waiting seat with the alias that opens it
 */

const ALIAS_LINE =
	/^\s*alias\s+([\w.-]+)='\(\s*cd\s+(\S+)\s+&&\s+CLAUDE_CONFIG_DIR=(\S+)\s+_wfc_agents\s*\)'/;

/**
 * `word` with its leading home read against `home`, resolved.
 * @param {string} word
 * @param {string} home
 */
const resolveShellPath = (word, home) =>
	path.resolve(expandShellHome(word, home) ?? word);

/**
 * Each agents-view alias `text` defines, in file order.
 * @param {string} text a `.bashrc`
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
 * The aliases `home`'s `.bashrc` defines, none where it is absent or will not
 * read.
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
 * The alias that opens `seat`'s view: the one for the repo holding `cwd`, else
 * the seat's first; null where none opens it.
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
 * `concurrency` with each waiting seat's alias.
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
