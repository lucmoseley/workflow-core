/*
 * seat-aliases.js — the founder's shell aliases that open a seat's agents view
 * (#5293), read from `~/.bashrc`, where he keeps one per repo and seat:
 *
 *   alias manta2='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude2 _wfc_agents)'
 *
 * `~` and `$HOME` are expanded and each seat put in the seat file's form, so it
 * compares equal to a listing record's. A line of any other shape is skipped, and
 * a `.bashrc` that will not read gives none: the panel then names the seat alone.
 */

const fs = require("node:fs");
const path = require("node:path");
const { seatDir } = require("./config-dir.js");
const { isUnder } = require("./is-under.js");
const { homeDir } = require("./refill-repos.js");

/**
 * @typedef {{alias: string, dir: string, seat: string}} SeatAlias
 * @typedef {ReturnType<typeof import("./concurrency.js").readConcurrencyStatus>}
 *   ConcurrencyStatus
 * @typedef {Omit<ConcurrencyStatus, "waiting"> & {waiting:
 *   (import("./concurrency.js").Waiting & {alias: string|null})[]}}
 *   ConcurrencyView  the status, each waiting seat with the alias that opens it
 */

const ALIAS_LINE =
	/^\s*alias\s+([\w.-]+)='\(\s*cd\s+(\S+)\s+&&\s+CLAUDE_CONFIG_DIR=(\S+)\s+_wfc_agents\s*\)'/;

/**
 * `p` with a leading `~` or `$HOME` read as `home`.
 * @param {string} p
 * @param {string} home
 */
const expandShellHome = (p, home) =>
	p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);

/**
 * Each agents-view alias `text` defines, in file order.
 * @param {string} text a `.bashrc`
 * @param {string} home
 * @returns {SeatAlias[]}
 */
function parseSeatAliases(text, home) {
	return text.split("\n").flatMap((line) => {
		const [, alias, dir, seat] = ALIAS_LINE.exec(line) ?? [];
		if (!alias || !dir || !seat) return [];
		return [
			{
				alias,
				dir: path.resolve(expandShellHome(dir, home)),
				seat: seatDir(expandShellHome(seat, home), home),
			},
		];
	});
}

/**
 * The aliases `home`'s `.bashrc` defines, none where it will not read.
 * @param {string} [home]
 * @returns {SeatAlias[]}
 */
function readSeatAliases(home = homeDir()) {
	try {
		return parseSeatAliases(
			fs.readFileSync(path.join(home, ".bashrc"), "utf8"),
			home,
		);
	} catch {
		return [];
	}
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
	waiting: concurrency.waiting.map((w) => ({
		...w,
		alias: aliasFor(aliases, w.seat, w.cwd),
	})),
});

module.exports = {
	aliasFor,
	parseSeatAliases,
	readSeatAliases,
	withWaitingAliases,
};
