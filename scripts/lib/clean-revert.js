/*
 * clean-revert.js — whether a commit is the lander's clean revert of a
 * culprit (#3127), the one thing the two guard-registry gates exempt from
 * their staleness refusal, and the one commit every direction gate also
 * judges against the culprit's parent (#4451).
 *
 * The lander names the culprit in WFC_LANDER_REVERT on its revert's commit and
 * on its push. The name only asks: a gate grants the exemption where the tree
 * it judges is what `git revert` of that culprit makes on the judged commit's
 * parent, recomputed here with `git merge-tree`, whose ort merge is the one
 * `git revert` runs.
 *
 * A CONFLICT ONLY IN ANCHOR FILES STILL COUNTS AS CLEAN (#3935). `git merge-file
 * --ours` settles the file for the side the revert is made on. Regenerating it
 * instead would write a read nobody made (#3127). A kept digest can only read
 * stale: the fix ticket owes a guard-registry row's re-read, and a census row
 * reports on the full run.
 *
 * A CONFLICT IN A REGENERATED FILE COUNTS AS CLEAN TOO (#4452): one
 * lib/regenerated-files.js lists, which the revert's tree holds as its
 * generator renders it there. Its output on that tree is the one right value,
 * as the file records nothing but its inputs.
 *
 * The guard registry's file is settled by its merge driver's own per-row merge
 * (#4171), so a revert and its recomputation agree whether or not the git they
 * run under defines the driver: where it does, the file never conflicts and
 * `merge-tree` writes those bytes itself.
 *
 * RESIDUAL: anyone may set it, an agent session included, and a clean revert
 * of any commit then lands with the rows it leaves stale and the faults the
 * culprit's parent carried. Both stay findings on every full run.
 */

const { commitSha } = require("./commit-sha.js");
const { spawnGitSync } = require("./git.js");
const {
	REGISTRY_ANCHORS,
	buildMergedAnchors,
} = require("./registry-anchors-merge.js");
const { parseErrorText } = require("./caught.js");
const { REGENERATED_FILES } = require("./regenerated-files.js");

/** @typedef {import("./regenerated-files.js").Regenerated} Regenerated */

const LANDER_REVERT_ENV = "WFC_LANDER_REVERT";

/* The culprit's parent a direction gate also judges against (#4451). Set on a
 * gate's run only by buildRevertBaseEnv, which .husky/pre-commit reaches
 * through scripts/lander-revert-base.js and assigns on every run. */
const REVERT_BASE_ENV = "WFC_LANDER_REVERT_BASE";

const ANCHOR_FILES = new Set([
	REGISTRY_ANCHORS,
	"scripts/code-standards-anchors.json",
	"scripts/code-standards-base-anchors.json",
	"scripts/instruction-surface-anchors.json",
]);

/** @param {string} sha */
const buildRevertLine = (sha) => `This reverts commit ${sha}.`;

/** The culprit WFC_LANDER_REVERT names, or null where it is unset. */
const readLanderRevert = (env = process.env) => env[LANDER_REVERT_ENV] || null;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null} stdout, or null on a non-zero exit
 */
function gitOut(cwd, args) {
	const r = spawnGitSync(["-C", cwd, ...args], { encoding: "utf8" });
	return r.status === 0 ? String(r.stdout) : null;
}

/**
 * How the revert settles each path in `conflicted`: an anchor file's bytes,
 * its conflicted hunks keeping `onto`'s side, in `kept`; a regenerated file's
 * entry in `regenerated`, rendered once the rest of the tree is settled. Null
 * where a path is neither, an anchor's three versions do not all exist or its
 * result is not JSON, a regenerated file is gone from `onto`, or `conflicted`
 * is empty.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, side: string}} revert `side` the
 *   parent of `culprit` the revert restores
 * @param {string[]} conflicted
 * @returns {{kept: Map<string, string>, regenerated: Map<string, Regenerated>}|null}
 */
function readSettledConflicts(cwd, { culprit, onto, side }, conflicted) {
	if (conflicted.length === 0) return null;
	/** @type {Map<string, string>} */
	const kept = new Map();
	/** @type {Map<string, Regenerated>} */
	const regenerated = new Map();
	for (const file of conflicted) {
		const generated = REGENERATED_FILES.get(file);
		if (generated) {
			/* Deleted on `onto`, it is a delete conflict, which a render settles wrongly. */
			if (gitOut(cwd, ["cat-file", "-e", `${onto}:${file}`]) === null)
				return null;
			regenerated.set(file, generated);
			continue;
		}
		if (!ANCHOR_FILES.has(file)) return null;
		const merged =
			file === REGISTRY_ANCHORS
				? readRegistryMerge(cwd, { culprit, onto, side })
				: gitOut(cwd, [
						"merge-file",
						"-p",
						"--ours",
						"--object-id",
						`${onto}:${file}`,
						`${culprit}:${file}`,
						`${side}:${file}`,
					]);
		if (merged === null || !isJson(merged)) return null;
		kept.set(file, merged);
	}
	return { kept, regenerated };
}

/**
 * A regenerated file's bytes as its generator renders them on `tree`, else
 * why the render failed.
 * @param {string} cwd
 * @param {Regenerated} generated
 * @param {string} tree a commit or tree
 * @returns {{bytes: string} | {failed: string}}
 */
function renderRegenerated(cwd, generated, tree) {
	try {
		return { bytes: generated.renderAt(cwd, tree) };
	} catch (err) {
		return { failed: parseErrorText(err) };
	}
}

/**
 * The registry file's per-row revert, its moved-on-both rows keeping `onto`'s
 * digest, or null where a version is missing or not JSON digests.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, side: string}} revert
 * @returns {string|null}
 */
function readRegistryMerge(cwd, { culprit, onto, side }) {
	/** @param {string} rev */
	const readBlobAt = (rev) =>
		gitOut(cwd, ["cat-file", "blob", `${rev}:${REGISTRY_ANCHORS}`]);
	const base = readBlobAt(culprit);
	const ours = readBlobAt(onto);
	const theirs = readBlobAt(side);
	if (base === null || ours === null || theirs === null) return null;
	return buildMergedAnchors(base, ours, theirs);
}

/** @param {string} text */
function isJson(text) {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `tree` is the revert of `culprit` against `side` on `onto`: the
 * merge's own tree, or that tree with its conflicts settled.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, side: string, tree: string}} judged
 */
function isRevertTree(cwd, { culprit, onto, side, tree }) {
	const merged = spawnGitSync(
		[
			"-C",
			cwd,
			"merge-tree",
			"--write-tree",
			"--name-only",
			`--merge-base=${culprit}`,
			onto,
			side,
		],
		{ encoding: "utf8" },
	);
	/* Prints the tree, then on a conflict the conflicted paths up to a blank line. */
	const [made, ...rest] = String(merged.stdout).split("\n");
	if (merged.status === 0) return made === tree;
	if (merged.status !== 1 || !made) return false;
	const settled = readSettledConflicts(
		cwd,
		{ culprit, onto, side },
		rest.slice(0, rest.indexOf("")),
	);
	if (settled === null) return false;
	const { kept, regenerated } = settled;
	/** @param {string} file */
	const readJudged = (file) =>
		gitOut(cwd, ["cat-file", "blob", `${tree}:${file}`]);
	const differing = gitOut(cwd, ["diff-tree", "-r", "--name-only", made, tree]);
	return (
		differing
			?.split("\n")
			.filter(Boolean)
			.every((file) => kept.has(file) || regenerated.has(file)) &&
		[...kept].every(([file, bytes]) => readJudged(file) === bytes) &&
		[...regenerated].every(([file, generated]) => {
			const rendered = renderRegenerated(cwd, generated, tree);
			return "bytes" in rendered && readJudged(file) === rendered.bytes;
		})
	);
}

/**
 * The parent of `culprit` that `tree` is its clean revert onto `onto` against,
 * or why there is none. A merge culprit may be reverted against any of its
 * parents, as the lander reverts against the one its bisect stepped from.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, tree: string}} judged
 * @returns {{side: string} | {why: string}}
 */
function judgeCleanRevert(cwd, { culprit, onto, tree }) {
	const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", culprit]);
	if (parents === null) return { why: `${culprit} is not a commit here` };
	const sides = parents.trim().split(" ").slice(1);
	if (sides.length === 0) return { why: `${culprit} is a root commit` };
	const side = sides.find((s) =>
		isRevertTree(cwd, { culprit, onto, side: s, tree }),
	);
	return side
		? { side }
		: { why: `its tree is not the clean revert of ${culprit} on ${onto}` };
}

/**
 * Why `tree` is not a clean revert of `culprit` made on `onto`, or null where it
 * is.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, tree: string}} judged
 * @returns {string|null}
 */
function whyNotCleanRevert(cwd, judged) {
	const verdict = judgeCleanRevert(cwd, judged);
	return whyOf(verdict);
}

/**
 * The commit `sha`, pushed onto `tip`, judged as the lander's revert of
 * `culprit`: its one parent is `tip`, its message carries git's revert line
 * for `culprit`, and its tree is the clean revert.
 * @param {string} cwd
 * @param {{culprit: string, sha: string, tip: string}} pushed
 * @returns {{side: string} | {why: string}}
 */
function judgeLanderRevert(cwd, { culprit, sha, tip }) {
	const [full, head, base] = [culprit, sha, tip].map((rev) =>
		commitSha(cwd, rev),
	);
	if (!full) return { why: `${culprit} is not a commit here` };
	if (!head || !base) return { why: `${sha} or ${tip} is not a commit here` };
	const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", head]);
	if (parents?.trim() !== `${head} ${base}`)
		return { why: `${sha} is not one commit on ${tip}` };
	const line = buildRevertLine(full);
	const message = gitOut(cwd, ["log", "-1", "--format=%B", head]) ?? "";
	if (!message.includes(line))
		return { why: `${sha}'s message does not carry "${line}"` };
	const tree = gitOut(cwd, ["rev-parse", `${head}^{tree}`]);
	if (tree === null) return { why: `${sha}'s tree cannot be read` };
	return judgeCleanRevert(cwd, {
		culprit: full,
		onto: base,
		tree: tree.trim(),
	});
}

/**
 * Why the commit `sha`, pushed onto `tip`, is not the lander's revert of
 * `culprit`, or null where it is.
 * @param {string} cwd
 * @param {{culprit: string, sha: string, tip: string}} pushed
 * @returns {string|null}
 */
function whyNotLanderRevert(cwd, pushed) {
	const verdict = judgeLanderRevert(cwd, pushed);
	return whyOf(verdict);
}

/**
 * The second baseline a direction gate judges a verified lander revert of
 * `culprit` against (#4451): the culprit's parent the revert restores, or null
 * where the judged side is no clean revert of it. The judged side is the
 * commit `head` pushed onto `onto`, else the index committed onto `onto`.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, head?: string}} judged
 * @returns {string|null}
 */
function readRevertBase(cwd, { culprit, onto, head }) {
	if (head) {
		const verdict = judgeLanderRevert(cwd, { culprit, sha: head, tip: onto });
		return sideOf(verdict);
	}
	const [full, base] = [culprit, onto].map((rev) => commitSha(cwd, rev));
	const tree = gitOut(cwd, ["write-tree"]);
	if (!full || !base || tree === null) return null;
	const verdict = judgeCleanRevert(cwd, {
		culprit: full,
		onto: base,
		tree: tree.trim(),
	});
	return sideOf(verdict);
}

/** @param {{side: string} | {why: string}} verdict */
const whyOf = (verdict) => ("why" in verdict ? verdict.why : null);
/** @param {{side: string} | {why: string}} verdict */
const sideOf = (verdict) => ("side" in verdict ? verdict.side : null);

/**
 * The environment a direction gate judges `onto` (or `head` pushed onto it)
 * in: `env` with WFC_LANDER_REVERT_BASE set to the base readRevertBase finds
 * for the culprit `env` names, else emptied.
 * @param {string} cwd
 * @param {{onto: string, head?: string}} judged
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
function buildRevertBaseEnv(cwd, { onto, head }, env = process.env) {
	const culprit = readLanderRevert(env);
	const base = culprit ? readRevertBase(cwd, { culprit, onto, head }) : null;
	return { ...env, [REVERT_BASE_ENV]: base ?? "" };
}

module.exports = {
	LANDER_REVERT_ENV,
	REVERT_BASE_ENV,
	buildRevertBaseEnv,
	buildRevertLine,
	readLanderRevert,
	readSettledConflicts,
	renderRegenerated,
	whyNotCleanRevert,
	whyNotLanderRevert,
};
