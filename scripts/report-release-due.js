#!/usr/bin/env node
/*
 * report-release-due.js — the weekly release cut's filer (#5435): files the
 * one *Release cut due* issue once CADENCE_DAYS have passed since the last
 * tag and `origin/main` holds a commit no release carries
 * (lib/release-due.js), so the refill loop launches the cut and a ticket gated
 * on a release opens on time.
 *
 * Run by the daily repo-checks run, in workflow-core alone (its registry
 * gate); elsewhere it SKIPs. While an issue of TITLE is open, found by title
 * alone, it only rewrites that issue's body, never filing a second.
 *
 * LOCAL REFS ONLY, no fetch, as check-release-lag.js reads them: a tag cut on
 * this machine is in the clone at once, and an `origin/main` behind the remote
 * only delays a filing to a later reading.
 *
 * Exit 0 whether or not a cut is due. Exit 2 where it cannot judge — no
 * release tag, no `origin/main`, a tag whose source git cannot read — or
 * cannot file, and on a command line lib/cli-args.js refuses.
 */

const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args");
const { now } = require("./lib/clock.js");
const { caught } = require("./lib/caught.js");
const { hostRoot } = require("./lib/host-root");
const { isCoreHost } = require("./lib/plugin-state.js");
const { readCommitOrBroken } = require("./lib/commit-sha.js");
const { MAIN, readLag } = require("./lib/release-lag.js");
const { CADENCE_DAYS, CUT_TITLE, judgeCut } = require("./lib/release-due.js");
const { takesLabel, takesRefusal } = require("./lib/takes-label");
const { fileOrRefresh } = require("./lib/tracking-issue");
const { buildStandaloneLine } = require("./lib/standalone-line.js");

const LABEL = takesLabel("implement");

/**
 * The last tag's reading, or why there is none to judge.
 *
 * @param {string} root
 * @returns {import("./lib/release-due.js").CutReading}
 */
function readCut(root) {
	/* Required past the core check: the release never ships it. */
	const {
		readCutTime,
		readReleaseTags,
		releaseLagPort,
	} = require("./lib/release-tags.js");
	const tag = readReleaseTags(root).at(-1);
	if (!tag) throw new Error("no release tag in this clone");
	const tip = readCommitOrBroken(MAIN, root);
	if (!tip)
		throw new Error(`no ${MAIN} in this clone; \`git fetch origin\` makes one`);
	const reading = readLag(releaseLagPort(root), tag, tip);
	if (reading.kind === "no-source")
		throw new Error(`${tag}'s message names no rendered-from source`);
	if (reading.kind === "source-absent")
		throw new Error(
			`${tag}'s source ${reading.source} is not in this clone; \`git fetch origin\` brings it`,
		);
	return { tag, cutSec: readCutTime(root, tag), commits: reading.commits };
}

/**
 * Carries no figure that moves between readings, so a reading that finds the
 * cut still due leaves the body as it stands.
 *
 * @param {string} tag
 */
function buildBody(tag) {
	return [
		`Filed automatically by \`${scriptPath("report-release-due.js")}\`, from the daily repo-checks run, which rewrites this body while a cut is due. **Edit it by hand and the next run silently overwrites it** — put anything you want kept in a comment.`,
		"",
		"## The weekly release cut is due",
		"",
		`${tag} is the last release, cut ${CADENCE_DAYS} or more days ago, and \`origin/main\` holds commits it does not carry (\`node ${scriptPath("check-release-lag.js")}\` counts them). Releases are batched about once a week (#5223 Q1 (A)).`,
		"",
		"## What to do",
		"",
		`1. Choose the version by what changed since ${tag}, and write \`migrations/v<version>.md\` with what an adopter must do; a major bump refuses without one.`,
		"2. Point `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` at it, then land the change.",
		`3. From a worktree whose HEAD is on \`origin/main\`, run \`node ${scriptPath("release-plugin.js")} --push --file-bump-issues\`.`,
		`4. Close this issue with \`node ${scriptPath("resolve-ticket.js")}\`, naming the tag and the bump issues filed.`,
		"",
		buildStandaloneLine(
			"the weekly release cadence's standing condition (#5435).",
		),
	].join("\n");
}

/**
 * @param {string} root
 * @param {number} nowMs
 * @returns {string} what happened, for the run to print
 */
function fileRun(root, nowMs) {
	const reading = readCut(root);
	const verdict = judgeCut(reading, nowMs);
	if (!verdict.due) return `${verdict.why}: nothing filed.`;
	const body = buildBody(reading.tag);
	/* No PreToolUse hook sees a script's own gh call, so the create guard's
	 * takes: check is made here. */
	const refused = takesRefusal([LABEL], body);
	if (refused) throw new Error(refused);
	return `${verdict.why}. ${fileOrRefresh({ title: CUT_TITLE, labels: [LABEL], body })}`;
}

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("report-release-due.js")}`,
	});
	const root = process.env.WFC_REPO_ROOT || hostRoot();
	if (!isCoreHost(root)) {
		writeFd(2, "SKIP: not workflow-core itself; an adopter cuts no release.\n");
		return;
	}
	try {
		writeFd(1, `${fileRun(root, now())}\n`);
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
}

if (require.main === module) main();

module.exports = { LABEL };
