#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { parseErrLine, ghApiSlurp } = require("./lib/gh.js");
const { spawnGitSync } = require("./lib/git.js");
const {
	HEADER,
	doneShas,
	handOffFaults,
	parseHandOff,
} = require("./lib/hand-off.js");
const { parseOrExit } = require("./lib/cli-args");
const { parseIssueNumber } = require("./lib/issue-number.js");
const { repoRoot } = require("./lib/hook-block");
const { scriptPath } = require("./lib/script-path.js");
const { sessionTree } = require("./lib/host-root.js");
const { pushedRef } = require("./lib/landing-refs.js");
const { scriptIo } = require("./lib/tracker-ops.js");

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("read-hand-off");
const USAGE = `usage: node ${scriptPath("read-hand-off.js")} <issue-number>`;

/**
 * @param {string[]} args
 * @returns {{ok: boolean, out: string}}
 */
function git(args) {
	const r = spawnGitSync(args, {
		cwd: sessionTree({}) ?? repoRoot(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * @param {number} n
 * @param {string} diff
 */
function writeDiff(n, diff) {
	const sid = (process.env.CLAUDE_CODE_SESSION_ID ?? "nosession").slice(0, 8);
	const file = path.join(
		repoRoot(),
		".claude",
		"tmp",
		`hand-off-${String(n)}-${sid}.diff`,
	);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, diff);
	return file;
}

/**
 * @param {boolean} inTree
 * @param {string|null} diffFile
 */
function nextStep(inTree, diffFile) {
	if (inTree)
		return "Its diff is already in the working tree, applied in reverse; continue";
	if (diffFile)
		return `Apply its diff with \`git apply --3way ${diffFile}\`, then continue`;
	return "Continue";
}

/**
 * @param {import("./lib/hand-off.js").HandOff} h
 * @param {string|null} diffFile
 * @returns {{failed: string[], inTree: boolean}}
 */
function verdictChecks(h, diffFile) {
	/** @type {string[]} */
	const failed = [];
	let inTree = false;
	const base = h.fields.Base;
	if (!git(["merge-base", "--is-ancestor", base, "HEAD"]).ok)
		failed.push(`Base ${base} is not an ancestor of HEAD`);
	const pushed = pushedRef({ tree: sessionTree({}) ?? undefined });
	for (const sha of doneShas(h))
		if (!git(["merge-base", "--is-ancestor", sha, pushed]).ok)
			failed.push(`Done sha ${sha} is not on ${pushed}`);
	if (diffFile) {
		const applied = git(["apply", "--3way", "--check", diffFile]);
		const clean = applied.ok && !/with conflicts/i.test(applied.out);
		inTree = !clean && git(["apply", "--reverse", "--check", diffFile]).ok;
		if (!clean && !inTree)
			failed.push(
				`the diff does not apply cleanly (${applied.out.trim().split("\n").at(-1) ?? "no output"})`,
			);
	}
	return { failed, inTree };
}

function main() {
	const [arg] = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		max: 1,
	}).positionals;
	const n = parseIssueNumber(arg);
	if (n === null) io.fail(USAGE, 2);
	const repo = io.trackerOrFail();

	/** @type {{body?: string, html_url?: string}[]} */
	let comments = [];
	try {
		comments = ghApiSlurp([`repos/${repo}/issues/${String(n)}/comments`]);
	} catch (e) {
		io.fail(`could not read #${String(n)}'s comments (${parseErrLine(e)})`, 1);
	}
	const comment = comments.findLast(
		(c) => handOffFaults(c.body ?? "").length === 0,
	);
	const h = comment && parseHandOff(comment.body ?? "");
	if (!comment || !h) {
		const quoted = comments.some((c) => (c.body ?? "").includes(HEADER));
		io.out(
			`No ${quoted ? "well-formed " : ""}hand-off on #${String(n)}: start from the ticket.\n`,
		);
		return;
	}
	io.out(`Hand-off on #${String(n)} (${comment.html_url ?? "comment"}):\n\n`);
	io.out(`${h.block.replace(/<details>[\s\S]*$/, "").trim()}\n\n`);
	const diffFile = h.diff === null ? null : writeDiff(n, h.diff);
	if (diffFile) io.out(`Its diff: ${diffFile}\n`);

	const { failed, inTree } = verdictChecks(h, diffFile);
	if (failed.length === 0) {
		io.out(
			`Usable: every check passed. ${nextStep(inTree, diffFile)} from its Left: line.\n`,
		);
		return;
	}
	io.out(
		`Reference only: ${failed.join("; ")}. Say so on #${String(n)} before you go on, starting from HEAD and reading the record for what was meant.\n`,
	);
}

main();
