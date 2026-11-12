/*
 * run-steadiness.js — is path p's content now what the run read?
 *
 * The tree watch opens a watch as a run begins and closes it as the run
 * ends; what the close returns is one value, a run's `Steadiness`, plain
 * JSON a kept run carries as it is. The pass store asks of it once it has
 * read every content id (#5018): read before them, a change made before
 * they were read would go unseen. So the value holds evidence, and
 * `readSteady` is the question, asked at the moment the reader chooses.
 *
 * A PATH IS STEADY where the watch saw it hold still: not rewritten between
 * the start and end snapshots (lib/tree-drift.js's `drift`), its change time
 * no later than the mark the run began on (`markStart`, which also sees a
 * file changed and put back), and not gitignored, since the snapshots list
 * tracked and untracked paths alone. An untracked path the watch saw counts
 * as moved: a snapshot names it without its content. Where HEAD moved, or
 * there was no start snapshot, the watch saw nothing and no path is steady;
 * nor is any where there was no mark.
 *
 * THE TREE IS SETTLED where it still stands as the end snapshot found it.
 * The watch's window closes there, so a path rewritten after it is steady by
 * every rule above and holds content no test read (#4993).
 */

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
 *   built and read here alone: `drifted` the paths the watch saw move, null
 *   where it saw nothing; `after` the end snapshot; `mark` the start mark
 *   in decimal, so the value is JSON as it stands
 * @typedef {{before: Snapshot|null, after: Snapshot|null,
 *   drifted: ReturnType<typeof drift>, steadiness: Steadiness}} Closed
 *   the snapshots and drift the tree watch's warning and marker read, and
 *   the run's steadiness
 * @typedef {{close: () => Closed}} Watch
 * @typedef {{known: boolean, settled: boolean,
 *   isSteady: (p: string) => boolean}} Steady
 *   `known` whether the watch saw the run through; `settled` whether the
 *   tree stands as the end snapshot found it; `isSteady` of a path asked
 *   about, false of any other
 */

/**
 * Open a watch on `root` as a run begins: the mark `scripts/run-vitest.js`
 * handed, else one taken now, and the start snapshot.
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

/**
 * The watch of a run whose start nothing saw, as where the tree watch's
 * setup never ran.
 * @param {string} root
 * @returns {Watch}
 */
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
 * Of `paths` under `root`, which are steady, asked now: call it once every
 * content id the answer vouches for has been read. A null `steadiness` is
 * a run nothing watched.
 * @param {Steadiness|null} steadiness
 * @param {string} root
 * @param {string[]} paths repo-relative
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

/**
 * Whether no path at or under `top` moved while the run ran, as far as the
 * watch saw: a file removed then is in neither the index nor the working
 * tree once the run ends, though a walk saw it (#4993). It reads the value
 * alone, so a reader may ask it before reading any id.
 * @param {Steadiness|null} steadiness
 * @param {string} top
 */
const isSteadyUnder = (steadiness, top) =>
	steadiness?.drifted != null &&
	!steadiness.drifted.some((p) => top === "." || isUnder(p, [top]));

/**
 * What moved since the end snapshot: null where the tree stands as it found
 * it, "unknown" where either snapshot will not read.
 * @param {Steadiness} steadiness
 * @param {string} root
 * @returns {ReturnType<typeof drift>|"unknown"}
 */
function readMovedSinceEnd(steadiness, root) {
	const now = readTreeSnapshot(root);
	if (steadiness.after == null || now === null) return "unknown";
	return drift(steadiness.after, now);
}

/**
 * Which of `paths` git ignores at `root`, or will not judge: a path through a
 * tracked symlink fails the whole call, so a failed call is asked again a path
 * at a time, and only the paths git refuses count. A tracked path is never
 * ignored.
 * @param {string} root
 * @param {string[]} paths
 * @returns {Set<string>}
 */
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
			// 1: none of them is ignored.
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
