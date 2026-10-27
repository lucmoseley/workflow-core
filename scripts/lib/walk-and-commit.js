/*
 * walk-and-commit.js — the migration walk's reconciler wrapper (workflow-core#249, part of
 * workflow-core#238's adopter-upgrade spec). Wired into `reconcile-plugin.js` (workflow-core#247) so
 * the founder's next session opens on a repo that is current and clean,
 * rather than one carrying edits nobody explains.
 *
 * THE FOUR CONDITIONS THE WALK RUNS UNDER, all decided here rather than in
 * `lib/upgrade-walk.js`, which knows nothing about git or commits:
 *
 *   1. CLEAN TREE IN. `readDirtyTracked`/`readUntrackedFiles` (lib/dirty-tree.js) must
 *      both read empty before `upgrade()` is ever called — the walker's edits
 *      can never be mixed into the founder's own uncommitted work. Dirty:
 *      defer, commit nothing.
 *   2. ONE COMMIT OUT, made by pathspec (never `git add -A`), its body
 *      carrying `stepsOwed`'s additions from this walk alone.
 *   3. NEVER PUSHED. Nothing here ever calls `git push`.
 *   4. A REFUSING COMMIT HALTS THE WALK. The commit is attempted through
 *      the adopter's own hooks (`execFileSync`, no `--no-verify`); a
 *      non-zero exit — a rejecting pre-commit hook, a missing commit
 *      identity, a locked index, anything — is reported and nothing lands.
 *      No parseable signal tells those causes apart, so the report never
 *      claims a hook specifically where it cannot know that. The walk's own
 *      output is left uncommitted in the tree, which means condition 1
 *      defers every later attempt until a human clears it — deliberate for
 *      a hook refusal specifically: the mechanism cannot talk its way past
 *      the adopter's own gates, and stripping its own output back out is
 *      level with amending past them.
 *
 * THE HALF-WAY STOP. `upgrade()`'s `applyResidue` runs before its `Verify`,
 * so a note whose Verify fails leaves its residue written with `walkedTo`
 * not advanced past it. Two notes can rewrite the SAME file (the same
 * `.gitignore` block, the same `workflow-core.json`), so there is no
 * general way to discard "this note's writes" by diffing paths. Instead:
 * read `walkedTo` off disk the moment `upgrade()` returns (it is exactly the
 * last note that verified, however far the walk got), reset the whole tree
 * to clean — sound only because condition 1 already proved everything
 * dirty now is this run's own — and REPLAY the walk with `ceiling` capped at
 * that tag. `ceiling: null` replays nothing at all, for a first note that
 * itself failed.
 *
 * THE INVARIANT THIS BUYS: the committed `walkedTo` always describes the
 * committed tree, on both the clean and the half-way paths.
 */

const { execGit } = require("./git.js");
const fs = require("node:fs");
const path = require("node:path");
const { upgrade } = require("./upgrade-walk.js");
const { measurerFor } = require("./core-context-cost.js");
const { ghLabels } = require("./core-owned-files.js");
const { readDirtyTracked, readUntrackedFiles } = require("./dirty-tree.js");
const { readStepsOwed } = require("./steps-owed.js");
const { caught } = require("./caught.js");

const WFC_CONFIG_REL = path.join(".claude", "workflow-core.json");

/**
 * @param {string} root
 * @returns {string|null}
 */
function readWalkedTo(root) {
	try {
		const doc = JSON.parse(
			fs.readFileSync(path.join(root, WFC_CONFIG_REL), "utf8"),
		);
		return typeof doc.walkedTo === "string" ? doc.walkedTo : null;
	} catch {
		return null;
	}
}

/**
 * @param {string[]} args
 * @param {string} root
 */
function git(args, root) {
	return execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * Discards every uncommitted change in `root` — tracked and untracked, never
 * ignored (`clean -fd`, not `-fdx`). Sound only because the caller has
 * already proven the tree was clean before this run began: everything
 * discarded here is this run's own write, never the founder's.
 * @param {string} root
 */
function resetToClean(root) {
	git(["checkout", "--", "."], root);
	git(["clean", "-fd", "--"], root);
}

/**
 * Every currently-dirty path, tracked and untracked, sorted and
 * de-duplicated — the pathspec the walk's commit is made by.
 * @param {string} root
 * @returns {string[]|null} null where git could not answer
 */
function readDirtyPaths(root) {
	const tracked = readDirtyTracked(root);
	const untracked = readUntrackedFiles(root);
	if (tracked === null || untracked === null) return null;
	return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Stages and commits exactly `paths`, by pathspec. `git add` first — a
 * `git commit -- <pathspec>` cannot be trusted alone to pick up a path that
 * was never in the index (workflow-core#249's fixture found residue that CREATES
 * `.claude/workflow-core.json` and `.gitignore` on a first walk).
 *
 * `stage` and `commit` are reported as SEPARATE failure kinds: only a
 * refusal at the commit step can be a rejecting hook — `git add` never runs
 * one. No parseable signal tells a hook's own exit apart from a missing
 * commit identity or a locked index, so the report never asserts which one.
 * @param {{root: string, paths: string[], message: string}} at
 * @returns {{ok: true}|{ok: false, step: "stage"|"commit", reason: string}}
 */
function commitPaths({ root, paths, message }) {
	/** @param {unknown} err */
	const reasonOf = (err) => {
		const e = caught(err);
		return e.stderr ?? e.message;
	};
	try {
		git(["add", "--", ...paths], root);
	} catch (err) {
		return { ok: false, step: "stage", reason: reasonOf(err) };
	}
	try {
		git(["commit", "-q", "-m", message, "--", ...paths], root);
	} catch (err) {
		return { ok: false, step: "commit", reason: reasonOf(err) };
	}
	return { ok: true };
}

/**
 * The whole reconciler-side wrapper around `upgrade()`: precondition, the
 * walk itself, the half-way replay where it stopped short, and the single
 * commit.
 * Given `claudeBin`, the core's context-cost measurer is built here from this
 * file's own `core-context-cost.js` and reaches both `upgrade()` calls, so a
 * replay seeds the row the reset discarded (workflow-core#679). Without it no row is
 * seeded and no `claude` is called. The tracker's labels are synced through
 * the live `gh` on both calls (workflow-core#1501).
 *
 * THESE PARAMETER NAMES ARE A CONTRACT BETWEEN RELEASES (workflow-core#682): an older
 * release's reconciler loads this walker from the newer install and passes
 * plain data under exactly these names. A renamed parameter throws nothing,
 * so the reconciler's fallback never fires — the value is just dropped.
 * @param {{root: string, pluginRoot: string, out?: (line: string) => void,
 *   claudeBin?: string, configDir?: string}} at
 * @returns {{action: "dirty"|"unreadable"|"broken"|"committed"|"up-to-date",
 *   lines: string[]}}
 */
function walkAndCommit({
	root,
	pluginRoot,
	out = () => {
		/* silent unless a caller wants progress */
	},
	claudeBin,
	configDir,
}) {
	const measureCore = claudeBin
		? measurerFor({ root, claudeBin, configDir })
		: undefined;
	const labels = ghLabels(root);
	/** @type {string[]} */
	const lines = [];
	/** @param {string} line */
	const say = (line) => {
		lines.push(line);
		out(line);
	};

	const before = readDirtyPaths(root);
	if (before === null) {
		say(
			"migration walk: could not read the adopter tree's git status — skipped.",
		);
		return { action: "unreadable", lines };
	}
	if (before.length > 0) {
		say(
			"migration walk: the adopter tree is not clean — deferring to the next session's exit. " +
				"The walker's edits can never be mixed into the founder's own uncommitted work.",
		);
		return { action: "dirty", lines };
	}

	const stepsBefore = readStepsOwed(root);
	const walkLines = /** @type {string[]} */ ([]);
	const result = upgrade({
		root,
		pluginRoot,
		out: (l) => walkLines.push(l),
		measureCore,
		labels,
	});

	if (result.status === 2) {
		say(`migration walk: ${result.reason}`);
		return { action: "broken", lines };
	}

	if (result.status === 1) {
		const replayFault = replayFailure({
			root,
			pluginRoot,
			measureCore,
			labels,
		});
		if (replayFault !== null) {
			say(replayFault);
			return { action: "broken", lines };
		}
	}

	const after = readDirtyPaths(root);
	if (after === null) {
		say(
			"migration walk: could not read the adopter tree's git status after walking — skipped.",
		);
		return { action: "unreadable", lines };
	}

	const reasons = walkReasons(result);

	if (after.length === 0) {
		for (const line of reasons) say(line);
		say("migration walk: nothing to commit.");
		return { action: "up-to-date", lines };
	}

	const walkedTo = readWalkedTo(root);
	const message = buildCommitMessage(
		walkedTo,
		readStepsOwed(root),
		stepsBefore.length,
	);

	const committed = commitPaths({ root, paths: after, message });
	if (!committed.ok) {
		say(
			`migration walk: ${REFUSAL_CAUSE[committed.step]} — ${committed.reason}. Nothing committed; ` +
				"the walk's output is left in the tree for inspection, and the next " +
				"session's exit will not retry until it is cleared by hand.",
		);
		return { action: "broken", lines };
	}

	for (const line of reasons) say(line);
	say(
		walkedTo
			? `migration walk: committed, reaching ${walkedTo}.`
			: "migration walk: committed housekeeping output (no note verified).",
	);
	return { action: "committed", lines };
}

/**
 * Resets the tree and replays the walk through the last note it verified,
 * after it stopped half-way.
 * @param {{root: string, pluginRoot: string,
 *   measureCore: import("./core-context-cost.js").Measurer|undefined,
 *   labels: import("./core-owned-files.js").Labels}} at
 * @returns {string|null} the line saying the replay failed, or null where it
 *   reproduced cleanly
 */
function replayFailure({ root, pluginRoot, measureCore, labels }) {
	const lastVerified = readWalkedTo(root);
	resetToClean(root);
	const replay = upgrade({
		root,
		pluginRoot,
		ceiling: lastVerified,
		out: () => {
			/* the replay's progress is not reported, only whether it failed */
		},
		measureCore,
		labels,
	});
	if (replay.status === 0) return null;
	return (
		`migration walk: the half-way replay through ${lastVerified ?? "the start"} ` +
		`did not reproduce cleanly (${replay.reason ?? replay.status}) — ` +
		"leaving the tree as the replay left it for inspection."
	);
}

/**
 * What an unfinished walk owes the founder whether or not it commits: a gap's
 * reason, then a half-way stop's.
 * @param {{status: 0|1|2|3, reason?: string}} result
 * @returns {string[]}
 */
function walkReasons(result) {
	const halfWayReason = result.status === 1 ? result.reason : null;
	const gapReason = result.status === 3 ? result.reason : null;
	return [gapReason, halfWayReason]
		.filter(Boolean)
		.map((reason) => `migration walk: ${reason}`);
}

/**
 * @param {string|null} walkedTo
 * @param {ReturnType<typeof readStepsOwed>} owedNow
 * @param {number} owedBefore how many steps were owed before the walk
 * @returns {string}
 */
function buildCommitMessage(walkedTo, owedNow, owedBefore) {
	const newlyOwed = owedNow.slice(owedBefore);
	const summary = walkedTo
		? `migration walk: reached ${walkedTo}`
		: "migration walk: housekeeping only, no note verified";
	const body =
		newlyOwed.length > 0
			? [
					"",
					"stepsOwed:",
					...newlyOwed.map((s) => `- [${s.type}] (${s.tag}) ${s.text}`),
				]
			: [];
	return [summary, ...body].join("\n");
}

/** Why the walk's commit failed, by the step `commitPaths` failed at. */
const REFUSAL_CAUSE = {
	commit:
		"the commit was refused — a rejecting pre-commit hook, a missing " +
		"commit identity, or another git problem",
	stage: "staging the walk's output failed",
};

module.exports = { walkAndCommit };
