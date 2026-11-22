const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
const { spawnGitSync } = require("./git.js");
const { commitRoute } = require("./commit-route.js");
const { ignoreFailure, orFallback } = require("./caught.js");
const {
	reviewTierStamp,
	sweepReviewTierStamps,
} = require("./review-tier-stamp.js");
const { heldAreas } = require("./sensitive-paths.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts
 * @returns {import("./review-hold.js").HoldPorts}
 */
function buildHoldPorts({ cwd, env }) {
	const gitEnv = { ...env };
	if (gitEnv.GIT_INDEX_FILE && !path.isAbsolute(gitEnv.GIT_INDEX_FILE))
		gitEnv.GIT_INDEX_FILE = path.join(cwd, gitEnv.GIT_INDEX_FILE);
	/** @param {string[]} args */
	const run = (args) =>
		spawnGitSync(args, { cwd, env: gitEnv, encoding: "utf8" });
	/**
	 * @param {string[]} args
	 * @returns {string}
	 */
	const read = (args) => {
		const r = run(args);
		if (r.status !== 0)
			throw new Error(`git ${args[0]}: ${String(r.stderr ?? r.error).trim()}`);
		return String(r.stdout);
	};
	/**
	 * @param {string} rev
	 * @returns {string}
	 */
	const verify = (rev) => {
		const r = run(["rev-parse", "-q", "--verify", rev]);
		return r.status === 0 ? String(r.stdout).trim() : "";
	};
	/** @param {string[]} args */
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
	/** @param {string} rev */
	const declaration = (rev) => () => {
		try {
			return readConfig({ root: cwd, rev, quiet: true }).sensitivePaths;
		} catch (e) {
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
		sweepStamps: (gitDir) => sweepReviewTierStamps(gitDir, Date.now()),
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
			const found = readText(marker);
			if (found.state === "absent") return null;
			return found.state === "read" ? found.data : "";
		},
		writeStamp: (stamp, text) => fs.writeFileSync(stamp, text),
		dropStamp: (stamp) =>
			ignoreFailure(() => fs.rmSync(stamp, { force: true })),
		ruleText: () => {
			const root = orFallback(
				() => require("./host-root.js").hostRoot(cwd),
				undefined,
			);
			return require("./rule-text.js").readRuleTextOr(
				"review-hold",
				"A commit on a declared sensitive path is held until its pre-commit review is recorded",
				"review-hold-gate.js",
				root,
			);
		},
		log: (what, detail) =>
			ignoreFailure(() =>
				require("./arbiter-core.js").logError(
					"review-hold-gate.js",
					what,
					detail || undefined,
				),
			),
	};

	/**
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
		const heads = readText(file);
		if (heads.state === "unreadable") return null;
		if (heads.state === "read")
			return heads.data.split("\n").filter((l) => l !== "");
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
