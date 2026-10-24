#!/usr/bin/env node
/*
 * release-contains.js — which releases carry a commit (#797).
 *
 * Usage:
 *   node scripts/release-contains.js <sha>
 *
 * `git tag --contains <sha>` CANNOT ANSWER THIS: release-plugin.js cuts every
 * release as a root commit, so no `main` commit is in any tag's history and
 * the answer is always empty. Each release commit's message names its source
 * instead (lib/release-tags.js's `releaseMessage`), and a release carries
 * `<sha>` where `<sha>` is an ancestor of that source.
 *
 * Joins no §N3 family: it answers a question and gates nothing. Exits 0 where
 * some release carries `<sha>`, 1 where none does, 2 where it cannot ask —
 * a usage error, a `<sha>` that names no commit here, or git failing. A tag
 * whose message carries no rendered-from line, or whose source this clone
 * lacks, is named and counted as not carrying it.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const { parseOrCode } = require("./lib/cli-args");
const { RENDERED_FROM, releaseTags } = require("./lib/release-tags.js");
const { caught } = require("./lib/caught.js");
const { commitSha } = require("./lib/commit-sha.js");

/** @param {string[]} args */
const git = (...args) =>
	execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/**
 * @param {string} ancestor
 * @param {string} descendant
 */
const isAncestor = (ancestor, descendant) => {
	const r = spawnSync("git", [
		"merge-base",
		"--is-ancestor",
		ancestor,
		descendant,
	]);
	if (r.status === 0 || r.status === 1) return r.status === 0;
	throw new Error(`git merge-base failed on ${descendant}`);
};

/**
 * Splits the release tags into those carrying `sha` and those it cannot read.
 * @param {string} sha
 * @param {string[]} tags
 */
function sortTags(sha, tags) {
	/** @type {string[]} */
	const carrying = [];
	/** @type {string[]} */
	const unread = [];
	for (const tag of tags) {
		const source = RENDERED_FROM.exec(
			git("log", "-1", "--format=%B", tag),
		)?.[1];
		if (!source)
			unread.push(`${tag}: its message carries no rendered-from line`);
		else if (commitSha(process.cwd(), source) === null)
			unread.push(`${tag}: its source ${source} is not in this clone`);
		else if (isAncestor(sha, source)) carrying.push(tag);
	}
	return { carrying, unread };
}

const USAGE = "usage: node scripts/release-contains.js <sha>";

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrCode(argv, { usage: USAGE, min: 1 });
	if (typeof parsed === "number") return parsed;
	const { positionals } = parsed;
	const [ref] = positionals;
	if (ref === undefined)
		throw new Error("parse passed no <sha> despite min: 1");
	const sha = commitSha(process.cwd(), ref);
	if (sha === null) {
		process.stderr.write(`${ref} names no commit in this clone\n`);
		return 2;
	}
	const tags = releaseTags(process.cwd());
	const { carrying, unread } = sortTags(sha, tags);
	const short = sha.slice(0, 8);
	if (carrying.length > 0) {
		process.stdout.write(
			`${short} is carried by ${carrying.join(", ")}\nfirst release carrying it: ${carrying[0]}\n`,
		);
	} else {
		process.stdout.write(
			`No release carries ${short}${tags.length === 0 ? " — this clone has no release tags" : ""}\n`,
		);
	}
	for (const line of unread) process.stdout.write(`unread: ${line}\n`);
	return carrying.length > 0 ? 0 : 1;
}

if (require.main === module) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`cannot ask: ${caught(e).message}\n`);
		process.exitCode = 2;
	}
}
