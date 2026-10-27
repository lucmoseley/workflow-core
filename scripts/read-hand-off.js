#!/usr/bin/env node
/*
 * read-hand-off.js — the pick-up step for a ticket a parked session left a
 * `**Hand-off:**` block on (#2391, built at #2700). `/implement` and
 * `/wayfinder` run it right after claim-issue.js.
 *
 *   node scripts/read-hand-off.js <n>
 *
 * Reads the newest comment on #n carrying the block (lib/hand-off.js), prints
 * it, writes its diff to `.claude/tmp/`, and runs three checks before the
 * record is used:
 *   Base   an ancestor of HEAD
 *   Done   each sha in it on main
 *   diff   `git apply --3way --check` applies it with no conflict
 * `--3way --check` exits 0 on a patch it would apply with conflicts (git
 * 2.43), so its "with conflicts" line fails the check too. A diff that
 * applies in reverse is already in the working tree, as where the refill
 * loop handed off a session that left its files in place (#2659), and
 * passes.
 *
 * Only a well-formed block counts (lib/hand-off.js's `handOffFaults`), so a
 * comment quoting the header in prose is passed over. The last line is the
 * verdict: usable, reference only (naming the failed checks, to be said on
 * the ticket), or no hand-off.
 *
 * Joins no §N3 family: its exits are claim-issue.js's tracker-script three —
 * 0 any verdict, 1 the comments could not be read, 2 a usage error.
 */

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
const { repoRoot } = require("./lib/hook-block");
const { scriptIo } = require("./lib/tracker-ops.js");

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("read-hand-off");
const USAGE = "usage: node scripts/read-hand-off.js <issue-number>";

/**
 * Run git in the repo root; whether it exited 0, and its output on both
 * streams — `git apply` reports a conflict on stderr at exit 0.
 * @param {string[]} args
 * @returns {{ok: boolean, out: string}}
 */
function git(args) {
	const r = spawnGitSync(args, {
		cwd: repoRoot(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * Write the diff where `git apply` and the session can read it.
 * @param {number} n
 * @param {string} diff
 */
function writeDiff(n, diff) {
	/* The house scratch name carries the session id's first 8 characters (#1167). */
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
 * What a usable hand-off's reader does with its diff before going on.
 * @param {boolean} inTree  its diff already in the working tree
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
 * The failed checks on a parsed hand-off, one clause each, and whether its
 * diff is already in the working tree.
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
	for (const sha of doneShas(h))
		if (!git(["merge-base", "--is-ancestor", sha, "main"]).ok)
			failed.push(`Done sha ${sha} is not on main`);
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
	if (!arg || !/^#?\d+$/.test(arg)) io.fail(USAGE, 2);
	const n = Number(arg.replace(/^#/, ""));
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
