#!/usr/bin/env node
/*
 * check-release-lag.js — how far the newest release tag lags `origin/main`,
 * and how many adopters pin each tag (#4448). On `npm run status` the reading
 * is a standing; at SessionStart (`--notify`) it prints only past the
 * threshold.
 *
 * THE LAG IS MEASURED FROM THE TAG'S SOURCE, never the tag: release-plugin.js
 * cuts each release as a root commit, so `git rev-list <tag>..origin/main`
 * counts all of main's history. The source is the commit the release
 * message names (lib/release-tags.js's RENDERED_FROM). Days run from that
 * commit's committer date to `origin/main`'s, so an idle `main` ages nothing.
 *
 * LOCAL REFS ONLY, no fetch: a SessionStart hook pays for every network call.
 * A clone that has not fetched lately under-reads the lag.
 *
 * ADOPTERS are lib/refill-repos.js's: each main checkout under `$HOME` with a
 * `.claude/workflow-core.json`, its pin read from `.claude/settings.json` as
 * lib/plugin-state.js reads it. A pin that is no tag counts under its own
 * label.
 *
 * SKIPS outside workflow-core itself: an adopter cuts no release. Also where
 * the clone has no release tag or no `origin/main`. A tag whose source this
 * clone lacks is WARN, since the lag is then unread.
 *
 * The judging is lib/release-lag.js's; this reads git and the adopters'
 * settings. WFC_REPO_ROOT and HOME inject the repo and the adopters' home.
 *
 * IMPLICIT:  at every session start, reads the newest release tag's source, `origin/main` and each adopter checkout's pin, and where the source is more than LAG_WARN_DAYS behind `origin/main`, or unreadable, prints the lag and the adopters per tag; prints nothing otherwise.
 * JUSTIFIED: convenience — it only reports; nothing else says that no fix has reached an adopter.
 * DEFEAT:    none at the hook; cutting a release clears it.
 * TREE:      host — reads the main checkout's tags and `origin/main`, and the adopters' main checkouts
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	findPin,
	isCoreHost,
	isTagRef,
	readJsonSafe,
} = require("./lib/plugin-state.js");
const { homeDir, readAdopterCheckouts } = require("./lib/refill-repos.js");
const {
	LAG_WARN_DAYS,
	MAIN,
	formatAdopters,
	judgeLag,
	labelPin,
} = require("./lib/release-lag.js");
const { RENDERED_FROM, readReleaseTags } = require("./lib/release-tags.js");

const PLUGIN = "workflow-core";
const DAY_S = 86_400;

/** @param {string} root @param {string[]} args */
const git = (root, args) =>
	execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/** @param {string} root @param {string} ref @returns {string|null} */
function resolveCommit(root, ref) {
	try {
		return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	} catch {
		return null;
	}
}

/** @param {string} home @returns {string[]} */
function readAdopterLabels(home) {
	return readAdopterCheckouts(home)
		.included.filter((root) => !isCoreHost(root))
		.map((root) => {
			const settings =
				/** @type {import("./lib/plugin-state").AdopterSettings|null} */ (
					readJsonSafe(path.join(root, ".claude", "settings.json"))
				);
			return labelPin(findPin(settings, PLUGIN), isTagRef);
		});
}

/**
 * @param {string} root
 * @param {string} tag
 * @param {string} tip
 * @returns {import("./lib/release-lag").Reading}
 */
function readLag(root, tag, tip) {
	const source = RENDERED_FROM.exec(
		git(root, ["log", "-1", "--format=%B", tag]),
	)?.[1];
	if (!source) return { kind: "no-source" };
	if (!resolveCommit(root, source)) return { kind: "source-absent", source };
	const commits = Number(
		git(root, ["rev-list", "--count", `${source}..${tip}`]),
	);
	/** @param {string} c */
	const time = (c) => Number(git(root, ["log", "-1", "--format=%ct", c]));
	/* Committer dates need not rise along history (a skewed clock, a rebase),
	 * so a tip dated before its ancestor reads 0, not a negative lag. */
	const days = Math.max(0, Math.floor((time(tip) - time(source)) / DAY_S));
	return { kind: "measured", source, commits, days };
}

runCheck({
	name: "release-lag",
	usage: "node check-release-lag.js [--json]",
	/** @param {import("./lib/check").CheckContext} ctx */
	run(ctx) {
		const root = process.env.WFC_REPO_ROOT || hostRoot();
		if (!isCoreHost(root))
			ctx.skip("not workflow-core itself; an adopter cuts no release.");
		const tag = readReleaseTags(root).at(-1);
		if (!tag) ctx.skip("no release tag in this clone.");
		const tip = resolveCommit(root, MAIN);
		if (!tip)
			ctx.skip(`no ${MAIN} in this clone; \`git fetch origin\` makes one.`);
		/** @type {import("./lib/release-lag").Reading} */
		let reading;
		try {
			reading = readLag(root, tag, tip);
		} catch (e) {
			ctx.broken(`git could not measure ${tag}: ${caught(e).message}`);
		}
		const { state, line } = judgeLag(
			tag,
			reading,
			formatAdopters(readAdopterLabels(homeDir())),
		);
		const data = { tag, ...reading, state, threshold: LAG_WARN_DAYS };
		if (state === "WITHIN") return { okLine: line, data };
		const finding = state === "BEHIND" ? "RELEASE-LAG" : "LAG-UNREAD";
		/* lib/check.js records a finding but prints none of it. */
		ctx.warn(finding, line);
		ctx.say(`${finding} — ${line}`);
		return { noun: "release-lag finding(s)", data };
	},
});
