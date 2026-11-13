/*
 * review-hold-host.js — lib/review-hold.js's production ports: git over the
 * committing repo in `cwd`, the review-tier stamp in its git directory, the
 * session's marker under the host root, the rule-text store and the
 * fail-open log. Every git read runs under `env`, which carries the
 * GIT_INDEX_FILE and GIT_REFLOG_ACTION git hands the hook.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnGitSync } = require("./git.js");
const { commitRoute } = require("./commit-route.js");
const {
	reviewTierStamp,
	sweepReviewTierStamps,
} = require("./review-tier-stamp.js");
const { heldAreas } = require("./sensitive-paths.js");
const { readConfig } = require("./workflow-core-config.js");

const LOG_LABEL = "review-hold-gate.js";

/**
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, now?: () => number }} opts
 * @returns {import("./review-hold.js").HoldPorts}
 */
function buildHoldPorts({ cwd, env, now = Date.now }) {
	const gitEnv = { ...env };
	/* git hands a plain commit's hook `.git/index`, relative to this cwd. */
	if (gitEnv.GIT_INDEX_FILE && !path.isAbsolute(gitEnv.GIT_INDEX_FILE))
		gitEnv.GIT_INDEX_FILE = path.join(cwd, gitEnv.GIT_INDEX_FILE);
	/** @param {string[]} args */
	const run = (args) =>
		spawnGitSync(args, { cwd, env: gitEnv, encoding: "utf8" });
	/** @param {string[]} args @returns {string} throws on a non-zero exit */
	const read = (args) => {
		const r = run(args);
		if (r.status !== 0)
			throw new Error(`git ${args[0]}: ${String(r.stderr ?? r.error).trim()}`);
		return String(r.stdout);
	};
	/** @param {string} rev @returns {string} "" where it names nothing */
	const verify = (rev) => {
		const r = run(["rev-parse", "-q", "--verify", rev]);
		return r.status === 0 ? String(r.stdout).trim() : "";
	};
	/**
	 * A diff with what only says where it applies removed: context, blob ids
	 * and hunk positions, which differ once the base has moved.
	 * @param {string[]} args
	 */
	const changeOf = (args) =>
		read([
			"-c",
			"core.quotePath=false",
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--binary",
			"-U0",
			...args,
		])
			.split("\n")
			.filter((l) => !l.startsWith("index "))
			.map((l) => (l.startsWith("@@ ") ? "@@" : l))
			.join("\n");
	/** @param {string} rev "HEAD", or "" for the index */
	const declaration = (rev) => () => {
		try {
			return readConfig({ root: cwd, rev, quiet: true }).sensitivePaths;
		} catch (e) {
			/* An unborn HEAD holds no copy, which declares nothing. */
			if (rev !== "" && String(e).includes("names no commit")) return;
			throw e;
		}
	};
	const gitPath = (/** @type {string} */ name) =>
		read(["rev-parse", "--path-format=absolute", "--git-path", name]).trim();

	return {
		sessionId: env.CLAUDE_CODE_SESSION_ID ?? "",
		pluginRoot: env.WFC_PLUGIN_ROOT ?? "",
		gitDir: () => read(["rev-parse", "--absolute-git-dir"]).trim(),
		route: (gitDir) => commitRoute("pre-commit", gitDir, { env: gitEnv }),
		stampPath: (gitDir) => reviewTierStamp(gitDir, env.CLAUDE_CODE_SESSION_ID),
		removeStamp: (stamp) => fs.rmSync(stamp, { force: true }),
		sweepStamps: (gitDir) => sweepReviewTierStamps(gitDir, now()),
		stagedPaths: () =>
			read([
				"-c",
				"core.quotePath=false",
				"diff",
				"--cached",
				"--name-only",
				"--no-renames",
				"-z",
			])
				.split("\0")
				.filter((p) => p !== ""),
		writeTree: () => read(["write-tree"]).trim(),
		unreplayed: (paths) => {
			const pick = verify("CHERRY_PICK_HEAD");
			if (!pick) throw new Error("no CHERRY_PICK_HEAD");
			const parent = verify(`${pick}^`);
			if (!parent) return paths;
			return paths.filter(
				(p) =>
					changeOf(["--cached", "HEAD", "--", p]) !==
					changeOf([parent, pick, "--", p]),
			);
		},
		offMergedSides: (paths, gitDir) => {
			const sides = mergedSides(gitDir);
			if (sides === null) return paths;
			return paths.filter((p) => {
				const staged = verify(`:0:${p}`);
				return !sides.some((side) => verify(`${side}:${p}`) === staged);
			});
		},
		heldAreas: (paths) =>
			heldAreas(declaration("HEAD"), declaration(""), paths),
		markerPath: () => {
			const { hostRoot } = require("./host-root.js");
			const { markersDir } = require("./marker-root.js");
			return path.join(
				markersDir(hostRoot(cwd)),
				`.codereview-pass-${env.CLAUDE_CODE_SESSION_ID}`,
			);
		},
		readMarker: (marker) => {
			try {
				return fs.readFileSync(marker, "utf8");
			} catch {
				return null;
			}
		},
		writeStamp: (stamp, text) => fs.writeFileSync(stamp, text),
		dropStamp: (stamp) => fs.rmSync(stamp, { force: true }),
		ruleText: () => {
			let root;
			try {
				root = require("./host-root.js").hostRoot(cwd);
			} catch {
				/* readRuleTextOr resolves it from process.cwd(), the cwd the entry
				 * passes, and falls back there (#3142). */
			}
			return require("./rule-text.js").readRuleTextOr(
				"review-hold",
				"A commit on a declared sensitive path is held until its pre-commit review is recorded",
				LOG_LABEL,
				root,
			);
		},
		log: (what, detail) => {
			try {
				require("./arbiter-core.js").logError(
					LOG_LABEL,
					what,
					detail || undefined,
				);
			} catch {
				/* A log that cannot be written must not break the hold. */
			}
		},
	};

	/**
	 * The commits this merge brings in, null where they cannot be read or a
	 * side is on no remote-tracking ref, since only a pushed commit went
	 * through its maker's hold.
	 * @param {string} gitDir
	 * @returns {string[] | null}
	 */
	function mergedSides(gitDir) {
		const sides = namedSides(gitDir);
		if (sides === null || sides.length === 0) return null;
		const pushed = sides.every(
			(side) =>
				String(
					run(["rev-list", "-n", "1", side, "--not", "--remotes"]).stdout ?? "",
				).trim() === "",
		);
		return pushed ? sides : null;
	}

	/**
	 * MERGE_HEAD's lines on a conflict's resolving commit; at
	 * pre-merge-commit, beside the AUTO_MERGE git writes before MERGE_HEAD,
	 * the names `git merge` took, which GIT_REFLOG_ACTION carries as
	 * `merge <name>…`. Null where neither reads.
	 * @param {string} gitDir
	 * @returns {string[] | null}
	 */
	function namedSides(gitDir) {
		let file;
		try {
			file = gitPath("MERGE_HEAD");
		} catch {
			return null;
		}
		if (fs.existsSync(file))
			return fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => l !== "");
		const action = gitEnv.GIT_REFLOG_ACTION ?? "";
		if (
			!(
				fs.existsSync(path.join(gitDir, "AUTO_MERGE")) &&
				action.startsWith("merge ")
			)
		)
			return null;
		const sides = action
			.slice("merge ".length)
			.split(/\s+/)
			.filter((n) => n !== "")
			.map((name) => verify(`${name}^{commit}`));
		return sides.includes("") ? null : sides;
	}
}

module.exports = { buildHoldPorts };
