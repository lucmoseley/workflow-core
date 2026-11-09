#!/usr/bin/env node
/*
 * check-release-lag.js — how far the newest release tag lags `origin/main`,
 * and how many adopters pin each tag (#4448).
 *
 * THE LAG IS MEASURED FROM THE TAG'S SOURCE, never the tag: release-plugin.js
 * cuts each release as a root commit, so `git rev-list <tag>..origin/main`
 * counts all of main's history. The source is the commit the release
 * message names (lib/release-tags.js's RENDERED_FROM). Days run from that
 * commit's committer date to `origin/main`'s, so an idle `main` ages nothing.
 *
 * LOCAL REFS ONLY, no fetch. A clone that has not fetched lately under-reads
 * the lag.
 *
 * ADOPTERS are lib/refill-repos.js's: each main checkout under `$HOME` with a
 * `.claude/workflow-core.json`, its pin read from `.claude/settings.json` as
 * lib/plugin-state.js reads it. A pin that is no tag counts under its own
 * label.
 *
 * WFC_REPO_ROOT and HOME inject the repo and the adopters' home.
 *
 * IMPLICIT:  at every session start, reads the newest release tag's source, `origin/main` and each adopter checkout's pin, and where the source is more than LAG_WARN_DAYS behind `origin/main`, or unreadable, prints the lag and the adopters per tag; prints nothing otherwise.
 * JUSTIFIED: convenience — it only reports; nothing else says that no fix has reached an adopter.
 * DEFEAT:    none at the hook; cutting a release clears it.
 * TREE:      host — reads the main checkout's tags and `origin/main`, and the adopters' main checkouts
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { readCommitOrBroken } = require("./lib/commit-sha.js");
const { execGit } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { findPin, isCoreHost, readJsonSafe } = require("./lib/plugin-state.js");
const { homeDir, readAdopterCheckouts } = require("./lib/refill-repos.js");
const {
	LAG_WARN_DAYS,
	MAIN,
	formatAdopters,
	judgeLag,
	labelPin,
	readLag,
} = require("./lib/release-lag.js");

const PLUGIN = "workflow-core";

/** @param {string} root @param {string[]} args */
const git = (root, args) =>
	execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/**
 * @param {string} root
 * @param {RegExp} renderedFrom
 * @returns {import("./lib/release-lag").GitPort}
 */
const gitPort = (root, renderedFrom) => ({
	sourceOf: (tag) =>
		renderedFrom.exec(git(root, ["log", "-1", "--format=%B", tag]))?.[1] ??
		null,
	hasCommit: (sha) => readCommitOrBroken(sha, root) !== null,
	count: (range) => Number(git(root, ["rev-list", "--count", range])),
	time: (rev) => Number(git(root, ["log", "-1", "--format=%ct", rev])),
});

/** @param {string} home @returns {string[]} */
function readAdopterLabels(home) {
	return readAdopterCheckouts(home)
		.included.filter((root) => !isCoreHost(root))
		.map((root) => {
			const settings =
				/** @type {import("./lib/plugin-state").AdopterSettings|null} */ (
					readJsonSafe(path.join(root, ".claude", "settings.json"))
				);
			return labelPin(findPin(settings, PLUGIN));
		});
}

runCheck({
	name: "release-lag",
	usage: "node check-release-lag.js [--json]",
	/** @param {import("./lib/check").CheckContext} ctx */
	run(ctx) {
		const root = process.env.WFC_REPO_ROOT || hostRoot();
		if (!isCoreHost(root))
			ctx.skip("not workflow-core itself; an adopter cuts no release.");
		/* Required past the check above: the release never ships it. */
		const { RENDERED_FROM, readReleaseTags } = require("./lib/release-tags.js");
		const tag = readReleaseTags(root).at(-1);
		if (!tag) ctx.skip("no release tag in this clone.");
		const tip = readCommitOrBroken(MAIN, root);
		if (!tip)
			ctx.skip(`no ${MAIN} in this clone; \`git fetch origin\` makes one.`);
		/** @type {import("./lib/release-lag").Reading} */
		let reading;
		try {
			reading = readLag(gitPort(root, RENDERED_FROM), tag, tip);
		} catch (e) {
			ctx.broken(`git could not measure ${tag}: ${caught(e).message}`);
		}
		const { state, finding, line } = judgeLag(
			tag,
			reading,
			formatAdopters(readAdopterLabels(homeDir())),
		);
		const data = { tag, ...reading, state, threshold: LAG_WARN_DAYS };
		if (finding === null) return { okLine: line, data };
		/* lib/check.js records a finding but prints none of it. */
		ctx.warn(finding, line);
		ctx.say(`${finding} — ${line}`);
		return { noun: "release-lag finding(s)", data };
	},
});
