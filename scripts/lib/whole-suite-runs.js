/*
 * whole-suite-runs.js — which pass and fail markers record a whole vitest
 * suite, or a shard of one, and how long it took: the read
 * `check-suite-margin.js` judges the target on and the quiet bench's due read
 * (lib/quiet-bench-tick.js, #4931) times the ladder bench on.
 */

const {
	fullFlagWord,
	isFullRunArgv,
	stripWrapperFlags,
} = require("./launch-route.js");
const {
	DEFAULT_SUITE,
	isFullRun,
	isUnnarrowedScope,
	suiteOf,
} = require("./test-pass-marker.js");

/** @typedef {import("./test-pass-marker.js").Marker} Marker */
/** @typedef {Marker & {durationMs: number}} TimedMarker */

/**
 * @param {Marker} m
 * @returns {m is TimedMarker}
 */
const isGreenFull = (m) =>
	suiteOf(m) === DEFAULT_SUITE &&
	Boolean(m.scope?.full) &&
	!m.scope?.failures?.length &&
	!m.ceilingKill &&
	typeof m.durationMs === "number";

/**
 * The `--shard=k/n` a launch typed: every lander shard run before #3090
 * carries its argv but no `scope.shard`.
 * @param {string[]} [argv]
 * @returns {{index: number, count: number}|null}
 */
function parseArgvShard(argv = []) {
	const at = argv.findIndex((w) => w === "--shard" || w.startsWith("--shard="));
	if (at < 0) return null;
	const word = argv[at] ?? "";
	const spelled =
		word === "--shard" ? argv[at + 1] : word.slice("--shard=".length);
	const k = /^(\d+)\/(\d+)$/.exec(spelled ?? "");
	return k ? { index: Number(k[1]), count: Number(k[2]) } : null;
}

/** @param {Marker} m */
const shardOf = (m) => m.scope?.shard ?? parseArgvShard(m.argv);

/**
 * A `--shard=k/n` part of a whole suite, narrowed by nothing but the shard.
 * @param {Marker} m
 */
const isFullShard = (m) => Boolean(shardOf(m)) && isUnnarrowedScope(m.scope);

/**
 * A whole suite or a shard of one, killed at the ceiling. The kill record has
 * no scope, the run never having reported, so its selection is read off the
 * launch: `full` where run-vitest recorded it (#3237), else a typed `--full` word,
 * and argv the launch route reads as full-shaped.
 * @param {Marker} m
 * @returns {m is TimedMarker}
 */
function isWholeKill(m) {
	if (suiteOf(m) !== DEFAULT_SUITE || !m.ceilingKill) return false;
	if (typeof m.durationMs !== "number") return false;
	const argv = m.argv ?? [];
	if (!m.full && fullFlagWord(argv) === null) return false;
	return isFullRunArgv(stripWrapperFlags(argv));
}

/** Oldest first; the two stores are separate files.
 * @param {Marker} a @param {Marker} b */
function byAt(a, b) {
	const [x, y] = [a.at ?? "", b.at ?? ""];
	if (x === y) return 0;
	return x < y ? -1 : 1;
}

/**
 * Run at the whole suite's own worker count: a launch that typed its own
 * `--maxWorkers` (or vitest's `--max-workers`), as each bench suite does,
 * was sized for something else.
 * @param {Marker} m
 */
const isDefaultWorkers = (m) =>
	!(m.argv ?? []).some((w) => /^--max-?workers/i.test(w));

/**
 * The latest lone whole suite — unsharded, at the default worker count —
 * green or killed at the ceiling, or null where none is recorded.
 * @param {Marker[]} markers
 * @param {Marker[]} failures
 * @returns {TimedMarker|null}
 */
function latestLoneSuite(markers, failures) {
	const lone = [
		...markers.filter(isGreenFull).filter(isFullRun),
		...failures.filter(isWholeKill),
	]
		.filter((m) => !shardOf(m) && isDefaultWorkers(m))
		.sort(byAt);
	return lone.at(-1) ?? null;
}

module.exports = {
	byAt,
	isFullShard,
	isGreenFull,
	isWholeKill,
	latestLoneSuite,
	shardOf,
};
