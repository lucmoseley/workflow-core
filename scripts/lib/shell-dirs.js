/** @typedef {[string, ...string[]]} Dirs */

/** @typedef {{ path: string } | { empty: true } | null} Resolved */

/**
 * @typedef {object} Move
 * @property {Resolved} resolved
 * @property {"always" | "if-dir" | "maybe"} holds
 * @property {boolean} [afterFailed]
 * @property {boolean} [chained]
 * @property {boolean} [opensScope]
 * @property {number} [depth]
 * @property {number} [settles]
 */

/**
 * @typedef {object} DirsState
 * @property {Dirs} dirs
 * @property {{ dir: string, depth: number }[]} pending
 * @property {Set<string>} went
 */

/**
 * @param {Dirs} dirs
 * @returns {DirsState}
 */
const startDirs = (dirs) => ({ dirs, pending: [], went: new Set() });

/**
 * @param {string} at
 * @param {Resolved} resolved
 * @returns {string}
 */
function moveDir(at, resolved) {
	if (!resolved) return "";
	if ("empty" in resolved) return at;
	if (resolved.path.startsWith("/")) return resolved.path;
	return at && `${at}/${resolved.path}`;
}

/**
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
 * @template {{ pending: unknown[] }} T
 * @param {T} state
 * @returns {T}
 */
const openChainScope = (state) => ({ ...state, pending: [] });

/**
 * @param {Dirs} cwds
 * @param {Move[]} moves
 * @param {(path: string) => boolean} isDir
 * @returns {Dirs}
 */
const dirsAfter = (cwds, moves, isDir) =>
	moves.reduce((state, move) => {
		const from = move.opensScope ? openChainScope(state) : state;
		const next = stepDirs(from, move, isDir);
		return move.settles === undefined ? next : settleDirs(next, move.settles);
	}, startDirs(cwds)).dirs;

/**
 * @param {Move["holds"]} holds
 * @param {string} dir
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
	openChainScope,
	dirsAfter,
};
