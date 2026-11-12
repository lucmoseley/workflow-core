/**
 * The directory model: every directory a command may stand in after the moves
 * made before it, each move handed in already classified and its directory
 * word already resolved (#5074). The walk's `cd`s, a wrapper's directory and a
 * `-c` string's `cd` all step one state through stepDirs, so whether a move
 * holds is decided here alone.
 */

/**
 * @typedef {[string, ...string[]]} Dirs the directories a command may stand
 *   in, the first where every move before it was made, each other once; each
 *   "" where unknown
 */

/**
 * @typedef {{ path: string } | { empty: true } | null} Resolved a move's
 *   directory word as pathArg reads it: null where it will not resolve, and
 *   `{ empty: true }` for one that stays put (#301)
 */

/**
 * @typedef {object} Move one move, classified
 * @property {Resolved} resolved
 * @property {"always" | "if-dir" | "maybe"} holds whether the command surely
 *   stands where the move puts it: "always" where nothing runs past its
 *   failure, "if-dir" where it surely ran had its directory been there,
 *   "maybe" where it may not have run
 * @property {boolean} [afterFailed] after `||` whose left side is the move
 *   before: it runs only where that one did not move (#5010)
 * @property {boolean} [chained] a `&&` chains the next command off it, so each
 *   directory it may not have moved from waits in `pending` until settleDirs
 *   (#4009)
 */

/**
 * @typedef {object} DirsState
 * @property {Dirs} dirs
 * @property {string[]} pending where a `&&` chain's moves may not have been
 *   made, which nothing in the chain stands in
 * @property {Set<string>} went where the move before may have gone
 */

/**
 * @param {Dirs} dirs
 * @returns {DirsState}
 */
const startDirs = (dirs) => ({ dirs, pending: [], went: new Set() });

/**
 * Where a move to a directory word puts a command standing at `at`: an
 * absolute one replacing it, a relative one joined to it, an empty one staying
 * put (#4869).
 * @param {string} at "" where unknown
 * @param {Resolved} resolved
 * @returns {string} "" where unknown
 */
function moveDir(at, resolved) {
	if (!resolved) return "";
	if ("empty" in resolved) return at;
	if (resolved.path.startsWith("/")) return resolved.path;
	return at && `${at}/${resolved.path}`;
}

/**
 * The state after one move: each directory moved, and each it is not sure to
 * hold also left unmade (#4980) — one an `afterFailed` move makes from where
 * the move before went, or from anywhere where that one went somewhere
 * unnamed. A chained move's unmade wait in `pending`.
 * @param {DirsState} state
 * @param {Move} move
 * @param {(path: string) => boolean} isDir
 * @returns {DirsState}
 */
function stepDirs(state, move, isDir) {
	const left = move.afterFailed ? state.went : new Set();
	const unsure = left.has("");
	const moved = state.dirs.map((from) => moveDir(from, move.resolved));
	const unmade = state.dirs.filter((from, i) => {
		const to = moved[i] ?? "";
		const held =
			to === from ||
			(holdsAt(move.holds, to, isDir) && !unsure && !left.has(from));
		return !held;
	});
	const [first = "", ...rest] = moved;
	return {
		dirs: distinct(first, move.chained ? rest : [...rest, ...unmade]),
		pending: move.chained ? [...state.pending, ...unmade] : state.pending,
		went: new Set(moved),
	};
}

/**
 * A `&&` chain's end: from here on, a move that opened it may not have been
 * made.
 * @param {DirsState} state
 * @returns {DirsState}
 */
function settleDirs(state) {
	if (state.pending.length === 0) return state;
	const [first, ...rest] = state.dirs;
	return {
		...state,
		dirs: distinct(first, [...rest, ...state.pending]),
		pending: [],
	};
}

/**
 * Every directory a command may stand in after `moves`, made from each of
 * `cwds` in order. A chained move's unmade stay out: the command is in its
 * chain.
 * @param {Dirs} cwds
 * @param {Move[]} moves
 * @param {(path: string) => boolean} isDir
 * @returns {Dirs}
 */
const dirsAfter = (cwds, moves, isDir) =>
	moves.reduce((state, move) => stepDirs(state, move, isDir), startDirs(cwds))
		.dirs;

/**
 * @param {Move["holds"]} holds
 * @param {string} dir where the move put it; "" where that will not resolve
 * @param {(path: string) => boolean} isDir
 */
const holdsAt = (holds, dir, isDir) =>
	holds === "always" || (holds === "if-dir" && dir !== "" && isDir(dir));

/**
 * @param {string} first
 * @param {string[]} rest
 * @returns {Dirs}
 */
const distinct = (first, rest) => [
	first,
	...new Set(rest.filter((d) => d !== first)),
];

module.exports = { startDirs, moveDir, stepDirs, settleDirs, dirsAfter };
