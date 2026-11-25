#!/usr/bin/env node

const { flagValue, parseOrCode } = require("./lib/cli-args");
const { readReleaseTags, readTagCarry } = require("./lib/release-tags.js");
const { caught } = require("./lib/caught.js");
const { commitSha } = require("./lib/commit-sha.js");
const { gh, parseErrLine } = require("./lib/gh.js");
const { findPin, sameRelease } = require("./lib/plugin-state.js");

const CORE_PLUGIN = "workflow-core";

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

const USAGE =
	"usage: node scripts/release-contains.js <sha> [--pinned-by <owner/repo>]";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * #5697
 * @param {string} repo
 * @returns {{ref: string} | {why: string}}
 */
function readLivePin(repo) {
	let raw;
	try {
		raw = gh([
			"api",
			"-H",
			"Accept: application/vnd.github.raw+json",
			`repos/${repo}/contents/.claude/settings.json`,
		]);
	} catch (e) {
		return { why: `GitHub did not serve its settings: ${parseErrLine(e)}` };
	}
	let settings;
	try {
		settings = JSON.parse(raw);
	} catch {
		return { why: "its .claude/settings.json is not JSON" };
	}
	const { ref } = findPin(settings, CORE_PLUGIN);
	return typeof ref === "string" && ref
		? { ref }
		: { why: `its .claude/settings.json pins no ${CORE_PLUGIN} ref` };
}

/**
 * @param {string} repo
 * @param {string} short
 * @param {{tags: string[], carrying: string[]}} read
 * @returns {{line: string, code: number}}
 */
function pinVerdict(repo, short, { tags, carrying }) {
	const pin = readLivePin(repo);
	if ("why" in pin)
		return { line: `cannot read ${repo}'s pin: ${pin.why}`, code: 2 };
	const seen = `${repo} pins ${pin.ref}, read from GitHub now`;
	const tag = tags.find((t) => sameRelease(t, pin.ref));
	if (tag === undefined)
		return {
			line: `${seen}; ${pin.ref} is no release tag in this clone, so whether it carries ${short} is unread`,
			code: 2,
		};
	return carrying.includes(tag)
		? { line: `met: ${seen}, which carries ${short}`, code: 0 }
		: { line: `unmet: ${seen}, which does not carry ${short}`, code: 1 };
}

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		min: 1,
		max: 1,
		flags: { "--pinned-by": "value" },
	});
	if (typeof parsed === "number") return parsed;
	const { positionals, flags } = parsed;
	const [ref] = positionals;
	if (ref === undefined)
		throw new Error("parse passed no <sha> despite min: 1");
	const pinnedBy = flagValue(flags, "--pinned-by");
	if (pinnedBy !== undefined && !OWNER_REPO.test(pinnedBy)) {
		process.stderr.write(`--pinned-by takes <owner/repo>, not ${pinnedBy}\n`);
		return 2;
	}
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
	if (pinnedBy === undefined) return carrying.length > 0 ? 0 : 1;
	const { line, code } = pinVerdict(pinnedBy, short, { tags, carrying });
	process.stdout.write(`${line}\n`);
	return code;
}

if (require.main === module) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`cannot ask: ${caught(e).message}\n`);
		process.exitCode = 2;
	}
}
