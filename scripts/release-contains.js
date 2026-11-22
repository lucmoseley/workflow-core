#!/usr/bin/env node

const { parseOrCode } = require("./lib/cli-args");
const { readReleaseTags, readTagCarry } = require("./lib/release-tags.js");
const { caught } = require("./lib/caught.js");
const { commitSha } = require("./lib/commit-sha.js");

/**
 * @param {string} sha
 * @param {string[]} tags
 */
function sortTags(sha, tags) {
	/** @type {string[]} */
	const carrying = [];
	/** @type {string[]} */
	const unread = [];
	for (const tag of tags) {
		const r = readTagCarry(process.cwd(), tag, sha);
		if ("unread" in r) unread.push(r.unread);
		else if (r.carries) carrying.push(tag);
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
	const tags = readReleaseTags(process.cwd());
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
