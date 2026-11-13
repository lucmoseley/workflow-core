/*
 * review-tier-trailer-host.js — lib/review-tier-trailer.js's production
 * ports: git over the committing repo in `cwd`, the message file, this
 * session's stamp in the git directory, the review hold run in-process on
 * the same repo, and the fail-open log. A ports file of its own, so the
 * core's module cases cross these adapters over real git in a temp repo
 * (#5153, #2733).
 */

const fs = require("node:fs");
const { readText } = require("./file-read.js");
const { spawnGitSync } = require("./git.js");
const { commitRoute } = require("./commit-route.js");
const { reviewTierStamp } = require("./review-tier-stamp.js");
const { runHold } = require("./review-hold.js");
const { buildHoldPorts } = require("./review-hold-host.js");
const { scriptPath } = require("./script-path.js");

/**
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts
 * @returns {import("./review-tier-trailer.js").TrailerPorts}
 */
function buildTrailerPorts({ cwd, env }) {
	/** @param {string[]} args */
	const run = (args) => spawnGitSync(args, { cwd, env, encoding: "utf8" });
	/** @param {string[]} args @returns {string} "" where git fails */
	const out = (args) => {
		const r = run(args);
		return r.status === 0 ? String(r.stdout) : "";
	};
	const tree = () => {
		const r = run(["write-tree"]);
		if (r.status !== 0) throw new Error(String(r.stderr).trim());
		return String(r.stdout).trim();
	};
	return {
		sessionId: env.CLAUDE_CODE_SESSION_ID ?? "",
		gitDir: () => out(["rev-parse", "--absolute-git-dir"]).trim(),
		route: (gitDir) => commitRoute("prepare-commit-msg", gitDir, { env }),
		readMessage: (msg) => fs.readFileSync(msg, "utf8"),
		writeMessage: (msg, text) => fs.writeFileSync(msg, text),
		vouching: (route) => {
			if (route === "cherry-pick")
				return out(["log", "-1", "--format=%B", "CHERRY_PICK_HEAD"]);
			if (route === "rebase") return "";
			const head = out(["rev-parse", "-q", "--verify", "HEAD^{tree}"]).trim();
			let staged = "";
			try {
				staged = tree();
			} catch {
				/* No staged tree vouches for nothing. */
			}
			return head !== "" && head === staged
				? out(["log", "-1", "--format=%B", "HEAD"])
				: "";
		},
		stampPath: (gitDir) => reviewTierStamp(gitDir, env.CLAUDE_CODE_SESSION_ID),
		readStamp: (stamp) => {
			const read = readText(stamp);
			if (read.state === "absent") return null;
			return read.state === "read" ? read.data : "";
		},
		removeStamp: (stamp) => fs.rmSync(stamp, { force: true }),
		writeTree: tree,
		hold: () => runHold(buildHoldPorts({ cwd, env })),
		interpretTrailers: (msg, value) => {
			const r = run([
				"interpret-trailers",
				"--in-place",
				"--if-exists",
				"replace",
				"--trailer",
				`Review-Tier: ${value}`,
				msg,
			]);
			return {
				ok: r.status === 0,
				out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
			};
		},
		commitPaths: scriptPath("commit-paths.js"),
		log: (what, detail) => {
			try {
				require("./arbiter-core.js").logError(
					"review-tier-trailer.js",
					what,
					detail || undefined,
				);
			} catch {
				/* A log that cannot be written must not break the trailer. */
			}
		},
	};
}

module.exports = { buildTrailerPorts };
