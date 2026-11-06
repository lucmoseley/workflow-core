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
const { execGit } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	findPin,
	isCoreHost,
	isTagRef,
	readJsonSafe,
} = require("./lib/plugin-state.js");
const { homeDir, readAdopterCheckouts } = require("./lib/refill-repos.js");
const { RENDERED_FROM, readReleaseTags } = require("./lib/release-tags.js");

/**
 * Warn once the newest release's source is more than this many days behind
 * `origin/main`. Seven exceeds every gap between consecutive release sources
 * from v1.1.18 to v2.0.1 (the longest: 7 days, v2.0.0 to v2.0.1), so it fires
 * only on a lag the release habit has not produced before. Days, not commits:
 * the commits per release ran from 2 to 1,729 over the same span.
 */
const LAG_WARN_DAYS = 7;

const PLUGIN = "workflow-core";
const MAIN = "origin/main";
const DAY_S = 86_400;

/** @param {string} root @param {string[]} args */
const git = (root, args) =>
	execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/** @param {string} root @param {string} ref @returns {string|null} */
function resolve(root, ref) {
	try {
		return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	} catch {
		return null;
	}
}

/**
 * The tag each adopter pins, counted per label.
 * @param {string} home
 * @returns {Map<string, number>}
 */
function countAdopters(home) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const root of readAdopterCheckouts(home).included) {
		if (isCoreHost(root)) continue;
		const settings = readJsonSafe(path.join(root, ".claude", "settings.json"));
		const { ref, source } = findPin(/** @type {any} */ (settings), PLUGIN);
		let label = "no pin";
		if (source?.source === "directory") label = "directory";
		else if (isTagRef(ref)) label = /** @type {string} */ (ref);
		else if (ref) label = `untagged ref ${ref}`;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return counts;
}

/** @param {Map<string, number>} counts */
function formatAdopters(counts) {
	if (counts.size === 0) return "no adopter checkout found.";
	const parts = [...counts]
		.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
		.map(([label, n]) => `${label} ×${n}`);
	return `${parts.join(", ")}.`;
}

/**
 * A warning, printed: lib/check.js records a finding but says nothing of it.
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} tag
 * @param {string} message
 */
function report(ctx, tag, message) {
	ctx.warn(tag, message);
	ctx.say(`${tag} — ${message}`);
}

runCheck({
	name: "release-lag",
	usage: "node check-release-lag.js [--json]",
	run(ctx) {
		const root = process.env.WFC_REPO_ROOT || hostRoot();
		if (!isCoreHost(root))
			ctx.skip("not workflow-core itself; an adopter cuts no release.");
		const tag = readReleaseTags(root).at(-1);
		if (!tag) ctx.skip("no release tag in this clone.");
		const tip = resolve(root, MAIN);
		if (!tip) ctx.skip(`no ${MAIN} in this clone.`);
		const adopters = `Adopters per tag: ${formatAdopters(countAdopters(homeDir()))}`;

		const source = RENDERED_FROM.exec(
			git(root, ["log", "-1", "--format=%B", String(tag)]),
		)?.[1];
		if (!source || !resolve(root, source)) {
			const why = source
				? `its source ${source.slice(0, 9)} is not in this clone`
				: "its message names no rendered-from source";
			report(ctx, "LAG-UNREAD", `${tag}'s lag is unread: ${why}. ${adopters}`);
			return { noun: "release-lag finding(s)", data: { tag, source } };
		}

		let commits;
		let days;
		try {
			commits = Number(git(root, ["rev-list", "--count", `${source}..${tip}`]));
			/** @param {string} c */
			const time = (c) => Number(git(root, ["log", "-1", "--format=%ct", c]));
			days = Math.max(
				0,
				Math.floor((time(String(tip)) - time(source)) / DAY_S),
			);
		} catch (e) {
			ctx.broken(`git could not measure ${tag}: ${caught(e).message}`);
		}
		const line = `${tag} (from ${source.slice(0, 9)}) is ${commits} commit(s) and ${days} day(s) behind ${MAIN}. ${adopters}`;
		const data = { tag, source, commits, days, threshold: LAG_WARN_DAYS };
		if (Number(days) > LAG_WARN_DAYS) {
			report(
				ctx,
				"RELEASE-LAG",
				`${line} Past the ${LAG_WARN_DAYS}-day threshold: no fix since reaches an adopter until a release is cut (\`node scripts/release-plugin.js\`).`,
			);
			return { noun: "release-lag finding(s)", data };
		}
		return { okLine: line, data };
	},
});
