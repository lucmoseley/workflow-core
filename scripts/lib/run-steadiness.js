const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const { isUnder } = require("./is-under.js");
const {
	drift,
	markStart,
	readChangedSince,
	readHandedMark,
	readTreeSnapshot,
} = require("./tree-drift.js");

/**
 * @typedef {import("./tree-drift.js").Snapshot} Snapshot
 * @typedef {{drifted: string[]|null, after: Snapshot|null,
 *   mark: string|null}} Steadiness
 * @typedef {{before: Snapshot|null, after: Snapshot|null,
 *   drifted: ReturnType<typeof drift>, steadiness: Steadiness}} Closed
 * @typedef {{close: () => Closed}} Watch
 * @typedef {{known: boolean, settled: boolean,
 *   isSteady: (p: string) => boolean}} Steady
 */

/**
 * @param {string} root
 * @param {{env?: NodeJS.ProcessEnv, err?: {write: (s: string) => unknown},
 *   fs?: typeof import("node:fs")}} [options]
 * @returns {Watch}
 */
function watchRun(root, { env = process.env, err = process.stderr, fs } = {}) {
	const mark = readHandedMark(env) ?? markStart(root, fs ? { fs } : {});
	if (mark === null)
		err.write(
			"vitest-tree-watch: no start mark could be taken in this tree, so this run records no pass (#5018)\n",
		);
	return openWatch(root, mark, readTreeSnapshot(root));
}

/** @param {string} root @returns {Watch} */
const unwatchedRun = (root) => openWatch(root, null, null);

/**
 * @param {string} root
 * @param {bigint|null} mark
 * @param {Snapshot|null} before
 * @returns {Watch}
 */
function openWatch(root, mark, before) {
	return {
		close() {
			const after = readTreeSnapshot(root);
			const drifted = drift(before, after);
			const untracked = [before, after].flatMap((s) => s?.untracked ?? []);
			return {
				before,
				after,
				drifted,
				steadiness: {
					drifted:
						before === null || drifted?.headMoved
							? null
							: [...(drifted?.moved ?? []).map((e) => e.path), ...untracked],
					after,
					mark: mark === null ? null : String(mark),
				},
			};
		},
	};
}

/**
 * @param {Steadiness|null} steadiness
 * @param {string} root
 * @param {string[]} paths
 * @returns {Steady}
 */
function readSteady(steadiness, root, paths) {
	const asked = [...new Set(paths)];
	const drifted =
		steadiness?.drifted == null ? null : new Set(steadiness.drifted);
	const mark = steadiness?.mark == null ? null : BigInt(steadiness.mark);
	const changed = readChangedSince(root, asked, mark);
	const ignored = readIgnored(root, asked);
	const askedSet = new Set(asked);
	return {
		known: drifted !== null,
		settled:
			steadiness !== null && readMovedSinceEnd(steadiness, root) === null,
		isSteady: (p) =>
			askedSet.has(p) &&
			drifted !== null &&
			changed !== null &&
			!drifted.has(p) &&
			!changed.has(p) &&
			!ignored.has(p),
	};
}

/** @param {Steadiness|null} steadiness @param {string} top */
const isSteadyUnder = (steadiness, top) =>
	steadiness?.drifted != null &&
	!steadiness.drifted.some((p) => top === "." || isUnder(p, [top]));

/**
 * @param {Steadiness} steadiness
 * @param {string} root
 * @returns {ReturnType<typeof drift>|"unknown"}
 */
function readMovedSinceEnd(steadiness, root) {
	const now = readTreeSnapshot(root);
	if (steadiness.after == null || now === null) return "unknown";
	return drift(steadiness.after, now);
}

/** @param {string} root @param {string[]} paths @returns {Set<string>} */
function readIgnored(root, paths) {
	const ask = (/** @type {string[]} */ some) => {
		try {
			return String(
				execGit(["check-ignore", "--stdin", "-z"], {
					cwd: root,
					input: some.map((p) => `${p}\0`).join(""),
					encoding: "utf8",
					stdio: ["pipe", "pipe", "ignore"],
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: CHILD_MAX_BUFFER,
				}),
			)
				.split("\0")
				.filter(Boolean);
		} catch (e) {
			return caught(e).status === 1 ? [] : null;
		}
	};
	const all = ask(paths);
	if (all) return new Set(all);
	return new Set(paths.filter((p) => (ask([p])?.length ?? 1) > 0));
}

module.exports = {
	watchRun,
	unwatchedRun,
	readSteady,
	isSteadyUnder,
	readMovedSinceEnd,
};
