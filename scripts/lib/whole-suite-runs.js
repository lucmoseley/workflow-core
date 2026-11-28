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

/** @param {Marker} m */
const isFullShard = (m) => Boolean(shardOf(m)) && isUnnarrowedScope(m.scope);

/**
 * @param {Marker} m
 * @returns {m is TimedMarker}
 */
function isWholeKill(m) {
	if (suiteOf(m) !== DEFAULT_SUITE || !m.ceilingKill) return false;
	if (typeof m.durationMs !== "number") return false;
	const argv = m.argv ?? [];
	if (!m.scope?.full && fullFlagWord(argv) === null) return false;
	return isFullRunArgv(stripWrapperFlags(argv));
}

/**
 * @param {Marker} a
 * @param {Marker} b
 */
function byAt(a, b) {
	const [x, y] = [a.at ?? "", b.at ?? ""];
	if (x === y) return 0;
	return x < y ? -1 : 1;
}

/** @param {Marker} m */
const isDefaultWorkers = (m) =>
	!(m.argv ?? []).some((w) => /^--max-?workers/i.test(w));

/**
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
