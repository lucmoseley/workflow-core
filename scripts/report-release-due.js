#!/usr/bin/env node

const path = require("node:path");
const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { caught } = require("./lib/caught.js");
const { hostRoot } = require("./lib/host-root");
const { isCoreHost } = require("./lib/plugin-state.js");
const { readCommitOrBroken } = require("./lib/commit-sha.js");
const { execGit } = require("./lib/git.js");
const { MAIN } = require("./lib/release-lag.js");
const { CUT_TITLE, judgeCut } = require("./lib/release-due.js");
const { parseSteps } = require("./lib/migration-note.js");
const { MIGRATIONS_DIR } = require("./lib/workflow-core-config.js");
const { takesLabel, takesRefusal } = require("./lib/takes-label");
const {
	fileOrRefresh,
	openTrackingIssue,
	refresh,
} = require("./lib/tracking-issue");
const { buildStandaloneLine } = require("./lib/standalone-line.js");

const LABEL = takesLabel("implement");

/**
 * @param {string} root
 * @param {string[]} args
 */
const git = (root, args) =>
	execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/**
 * @param {string} root
 * @param {string} tag
 * @returns {import("./lib/release-due.js").OwedNote[]}
 */
function readOwedNotes(root, tag) {
	const { TAG_RE, newestTag } = require("./lib/release-tags.js");
	const listing = git(root, [
		"ls-tree",
		"--name-only",
		MAIN,
		`${MIGRATIONS_DIR}/`,
	]);
	/** @type {import("./lib/release-due.js").OwedNote[]} */
	const owed = [];
	for (const note of listing.split("\n")) {
		const version = path.basename(note, ".md");
		if (!note.endsWith(".md") || !TAG_RE.test(version)) continue;
		if (version === tag || newestTag([tag, version]) !== version) continue;
		const steps = parseSteps(git(root, ["show", `${MAIN}:${note}`])).filter(
			(s) => s.type !== "notice",
		).length;
		if (steps > 0) owed.push({ note, steps });
	}
	return owed;
}

/**
 * @param {string} root
 * @returns {import("./lib/release-due.js").CutReading}
 */
function readCut(root) {
	const { readCutTime, readReleaseTags } = require("./lib/release-tags.js");
	const tag = readReleaseTags(root).at(-1);
	if (!tag) throw new Error("no release tag in this clone");
	if (!readCommitOrBroken(MAIN, root))
		throw new Error(`no ${MAIN} in this clone; \`git fetch origin\` makes one`);
	return {
		tag,
		cutSec: readCutTime(root, tag),
		owed: readOwedNotes(root, tag),
	};
}

/**
 * @param {string} tag
 * @param {string} why
 */
function buildBody(tag, why) {
	return [
		`Filed automatically by \`${scriptPath("report-release-due.js")}\`, from the daily repo-checks run, the refill loop's gate sweep, or a session naming a trigger with \`--because\`, each of which rewrites this body while a cut is due. **Edit it by hand and the next run silently overwrites it** — put anything you want kept in a comment.`,
		"",
		"## A release cut is due",
		"",
		`${tag} is the last release, and ${why}.`,
		"",
		"## What to do",
		"",
		`1. Choose the version by what changed since ${tag}, and write \`migrations/v<version>.md\` with what an adopter must do; a major bump refuses without one.`,
		"2. Point `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` at it, then land the change.",
		`3. From a worktree whose HEAD is on \`origin/main\`, run \`node ${scriptPath("release-plugin.js")} --push --file-bump-issues\`.`,
		`4. Close this issue with \`node ${scriptPath("resolve-ticket.js")}\`, naming the tag and the bump issues filed.`,
		"",
		buildStandaloneLine("the on-demand release triggers (#5538)."),
	].join("\n");
}

/** @param {string} tag */
function buildLandedBody(tag) {
	return [
		`Filed automatically by \`${scriptPath("report-release-due.js")}\`, from the daily repo-checks run and the refill loop's gate sweep. **Edit it by hand and the next run silently overwrites it** — put anything you want kept in a comment.`,
		"",
		"## The cut this issue asked for has landed",
		"",
		`${tag} was cut after this issue was filed. Close this issue with \`node ${scriptPath("resolve-ticket.js")}\`, naming ${tag}.`,
		"",
		buildStandaloneLine("the on-demand release triggers (#5538)."),
	].join("\n");
}

/**
 * @param {string} root
 * @param {string} [because]
 * @returns {string}
 */
function fileRun(root, because) {
	const reading = readCut(root);
	const verdict = because ? { due: true, why: because } : judgeCut(reading);
	if (!verdict.due) {
		const open = openTrackingIssue({ title: CUT_TITLE }, { cwd: root });
		if (!open || Date.parse(open.createdAt) >= reading.cutSec * 1000)
			return `${verdict.why}: nothing filed.`;
		return `${verdict.why}. ${refresh(open.number, buildLandedBody(reading.tag))}`;
	}
	const body = buildBody(reading.tag, verdict.why);
	const refused = takesRefusal([LABEL], body);
	if (refused) throw new Error(refused);
	return `${verdict.why}. ${fileOrRefresh({ title: CUT_TITLE, labels: [LABEL], body })}`;
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("report-release-due.js")} [--because <trigger>]`,
		flags: { "--because": /** @type {const} */ ("value") },
	});
	const because = flagValue(flags, "--because")?.trim() || undefined;
	const root = process.env.WFC_REPO_ROOT || hostRoot();
	if (!isCoreHost(root)) {
		writeFd(2, "SKIP: not workflow-core itself; an adopter cuts no release.\n");
		return;
	}
	try {
		writeFd(1, `${fileRun(root, because)}\n`);
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
}

if (require.main === module) main();
