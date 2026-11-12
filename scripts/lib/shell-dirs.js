/**
 * shell-dirs.js — the directory model: every directory a command may stand in after the moves
 * made before it, each move handed in already classified and its directory
 * word already resolved (#5074). The walk's `cd`s, a wrapper's directory and a
 * `-c` string's `cd` all step one state through stepDirs.
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
 * @property {boolean} [opensScope] the first move inside a subshell: a chain
 *   opened before its `(` waits on that move alone, so no chain end inside
 *   settles it (#5102)
 * @property {number} [depth] how many `{ … }` groups it runs inside, 0 where
 *   none (#5095)
 * @property {number} [settles] a `&&` chain ends after it, before the next
 *   move, this many groups deep, 0 outside every group: dirsAfter settles
 *   there each move as deep or deeper (#5082, #5095)
 */

/**
 * @typedef {object} DirsState
 * @property {Dirs} dirs
 * @property {{ dir: string, depth: number }[]} pending where a `&&` chain's
 *   moves may not have been made, each with its move's depth
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
 * unnamed.
 * @param {DirsState} state
 * @param {Move} move
 * @param {(path: string) => boolean} isDir
 * @returns {DirsState}
 */
function stepDirs(state, move, isDir) {
	const left = move.afterFailed ? state.went : new Set();
	const unsure = left.has("");
	/** @param {string} from */
	const step = (from) => {
		const at = moveDir(from, move.resolved);
		const held =
			at === from ||
			(!unsure && !left.has(from) && holdsAt(move.holds, at, isDir));
		return { from, at, held };
	};
	const [head, ...tail] = state.dirs;
	const headStep = step(head);
	const tailSteps = tail.map(step);
	const unmade = [headStep, ...tailSteps]
		.filter((s) => !s.held)
		.map((s) => s.from);
	/** @type {Dirs} */
	const moved = [headStep.at, ...tailSteps.map((s) => s.at)];
	const [first, ...rest] = moved;
	return {
		dirs: distinct(first, move.chained ? rest : [...rest, ...unmade]),
		pending: move.chained
			? [
					...state.pending,
					...unmade.map((dir) => ({ dir, depth: move.depth ?? 0 })),
				]
			: state.pending,
		went: new Set(moved),
	};
}

/**
 * A `&&` chain's end `depth` groups deep: from here on, a move as deep or
 * deeper that opened a chain may not have been made, the deepest settled
 * first, as one chain end per group would settle them. A chain a shallower
 * move opened runs on past the group's `}` (#5095).
 * @param {DirsState} state
 * @param {number} [depth]
 * @returns {DirsState}
 */
function settleDirs(state, depth = 0) {
	const ended = state.pending
		.filter((p) => p.depth >= depth)
		.sort((a, b) => b.depth - a.depth);
	if (ended.length === 0) return state;
	const [first, ...rest] = state.dirs;
	return {
		...state,
		dirs: distinct(first, [...rest, ...ended.map((p) => p.dir)]),
		pending: state.pending.filter((p) => p.depth < depth),
	};
}

/**
 * A subshell's opening: a `&&` chain open outside waits on what runs before
 * it, so no chain end inside settles it (#5093).
 * @param {DirsState} state
 * @returns {DirsState}
 */
const openDirsScope = (state) => ({ ...state, pending: [] });

/**
 * Every directory a command may stand in after `moves`, made from each of
 * `cwds` in order. A chained move's unmade stay out until a move that settles
 * its chain: past none, the command is in the chain.
 * @param {Dirs} cwds
 * @param {Move[]} moves
 * @param {(path: string) => boolean} isDir
 * @returns {Dirs}
 */
const dirsAfter = (cwds, moves, isDir) =>
	moves.reduce((state, move) => {
		const from = move.opensScope ? openDirsScope(state) : state;
		const next = stepDirs(from, move, isDir);
		return move.settles === undefined ? next : settleDirs(next, move.settles);
	}, startDirs(cwds)).dirs;

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

module.exports = {
	startDirs,
	moveDir,
	stepDirs,
	settleDirs,
	openDirsScope,
	dirsAfter,
};
