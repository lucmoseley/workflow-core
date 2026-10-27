/*
 * commit-range.js — the git half of a red-batch report (mantahostels#945).
 *
 * One scheduled sweep now covers every commit since the last one, so a red run
 * accuses a RANGE rather than a sha (mantahostels#907, which ruled how a batch red gets
 * attributed: report the range well, escalate to a hand-fired bisect only when
 * the read fails).
 *
 * Its own module, and gh-free on purpose: the range report is pure git, so it
 * is testable against real commits in this repo without stubbing a CLI.
 *
 * REPORTS ONLY. Every failure here returns { ok: false, reason }; nothing
 * throws, because a range this cannot read must still leave the caller able to
 * print the red run it already knows about.
 */

const { cutAt } = require("./cut-at.js");
const { readCommit } = require("./commit-sha.js");
const { execGit, gitReader } = require("./git.js");

/* Above this many commits, per-commit file LISTS are replaced by a file COUNT
 * plus one aggregate. At the range sizes mantahostels#905 measured, the long form is the
 * normal one. */
const LONG_RANGE = 8;

/* A hard ceiling on printed commits, whatever the range. Not a measured
 * figure. */
const MAX_LISTED = 120;

/* How many entries the aggregate names in the long form. */
const TOP_FILES = 10;

/* Field and record separators git will never emit inside a subject or a path.
 * NUL and unit-separator rather than a tab or a newline, both of which are
 * legal in a commit subject and would split a record in the wrong place.
 *
 * Asked for as git's OWN `%x00`/`%x1f` placeholders, never as the bytes: Node
 * refuses an argv string containing a NUL outright, so a literal separator in
 * --format makes every call throw before git sees it. */
const FIELD = "\x1f";
const RECORD = "\x00";
const FORMAT = "%x00%h%x1f%s";

/**
 * @typedef {{short: string, subject: string, files: string[]}} Commit
 * @typedef {{ok: true, count: number, commits: Commit[], truncated: number}
 *   | {ok: false, reason: string}} RangeResult
 */

/**
 * @param {string[]} args
 * @param {string|undefined} cwd
 * @returns {string}
 */
function git(args, cwd) {
	return execGit(args, {
		encoding: "utf8",
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * The one line carrying git's reason, not the whole stderr dump.
 *
 * @param {unknown} e What git's failure threw — an exec exception in practice,
 *   but a `catch` binding promises nothing, so it is narrowed here.
 * @returns {string}
 */
const parseGitLine = (e) => {
	const err = /** @type {{stderr?: unknown, message?: unknown}} */ (e || {});
	return (
		(
			(err.stderr || "").toString().trim() ||
			(err.message || "").toString().trim()
		)
			.split("\n")
			.filter(Boolean)
			.pop() || "git failed with no message"
	);
};

/**
 * Every commit in `good..bad`, newest first, with the files each touched.
 *
 * Returns { ok: true, count, commits, truncated } or { ok: false, reason }.
 * A sha the local clone has never fetched is the expected failure here — the
 * red run names shas from `origin/main`, and this machine may be behind — so it
 * is reported as a reason to fetch, never as a broken check. A git that will
 * not answer is named as that failure instead (workflow-core#3152).
 *
 * @param {{good?: string|null, bad?: string|null, cwd?: string,
 *   maxListed?: number}} ends
 * @returns {RangeResult}
 */
function readRange({ good, bad, cwd, maxListed = MAX_LISTED }) {
	if (!good || !bad) return { ok: false, reason: "no range to read" };

	/** @type {[string, string][]} */
	const ends = [
		["good", good],
		["bad", bad],
	];
	for (const [label, sha] of ends) {
		const r = readCommit(gitReader(cwd ?? process.cwd()), sha);
		if (!r.ok)
			return {
				ok: false,
				reason: `git would not resolve ${sha.slice(0, 7)} (the ${label} end): ${r.why}`,
			};
		if (r.sha === null)
			return {
				ok: false,
				reason: `this clone has no commit ${sha.slice(0, 7)} (the ${label} end) — \`git fetch origin\` and re-run`,
			};
	}

	/* Ancestry checked before the log: `git log a..b` over two unrelated tips
	 * happily prints b's whole side of the fork, which would read as a range
	 * nobody meant to name. */
	try {
		git(["merge-base", "--is-ancestor", good, bad], cwd);
	} catch {
		return {
			ok: false,
			reason: `${good.slice(0, 7)} is not an ancestor of ${bad.slice(0, 7)}, so the two are not one line of history`,
		};
	}

	let count;
	try {
		count = Number(git(["rev-list", "--count", `${good}..${bad}`], cwd).trim());
	} catch (e) {
		return { ok: false, reason: parseGitLine(e) };
	}
	if (!count) return { ok: true, count: 0, commits: [], truncated: 0 };

	let out;
	try {
		out = git(
			[
				"log",
				`--max-count=${maxListed}`,
				`--format=${FORMAT}`,
				"--name-only",
				/* A merge shows no files under --name-only without this, so its
				 * commits would print an empty file list rather than the union of
				 * what it brought in. -m would list each parent separately instead. */
				"--first-parent",
				`${good}..${bad}`,
			],
			cwd,
		);
	} catch (e) {
		return { ok: false, reason: parseGitLine(e) };
	}

	const commits = [];
	for (const record of out.split(RECORD)) {
		if (!record.trim()) continue;
		const [header, body] = cutAt(record, "\n");
		const [short, tail] = cutAt(header, FIELD);
		const [subject] = cutAt(tail, FIELD);
		commits.push({
			short,
			subject,
			files: body
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean),
		});
	}

	return {
		ok: true,
		count,
		commits,
		truncated: Math.max(0, count - commits.length),
	};
}

/**
 * How many commits `good..bad` holds, and nothing else.
 *
 * Returns null rather than a reason: the one caller prints a different sentence
 * when it cannot count, not the reason it could not.
 *
 * @param {{good?: string|null, bad?: string|null, cwd?: string}} ends
 * @returns {number|null}
 */
function countRange({ good, bad, cwd }) {
	if (!good || !bad) return null;
	try {
		git(["merge-base", "--is-ancestor", good, bad], cwd);
		return Number(git(["rev-list", "--count", `${good}..${bad}`], cwd).trim());
	} catch {
		return null;
	}
}

/**
 * The files the range touched most, commonest first.
 *
 * @param {Commit[]} commits
 * @param {number} [limit]
 * @returns {[string, number][]}
 */
function topFiles(commits, limit = TOP_FILES) {
	const seen = new Map();
	for (const c of commits)
		for (const f of c.files) seen.set(f, (seen.get(f) || 0) + 1);
	return [...seen.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit);
}

/**
 * The range, as the lines a reader sees. Returned rather than printed so the
 * caller keeps its own stream discipline (check.js reserves stdout for machine
 * readers except under --notify).
 *
 * Both ends are required. The `= {}` default this carried was dead: every line
 * past the unavailable-range one reads `good` and `bad`, so a call without them
 * threw the moment the range was readable at all.
 *
 * @param {RangeResult} range
 * @param {{good: string, bad: string, longRange?: number}} ends
 * @returns {string[]}
 */
function renderRange(range, { good, bad, longRange = LONG_RANGE }) {
	if (!range.ok) return [`Commit range unavailable: ${range.reason}.`];

	const span = `${good.slice(0, 7)}..${bad.slice(0, 7)}`;
	if (!range.count)
		return [
			`No commits between the last green run and this one (${span}) — the same`,
			"tree went green and then red, so suspect flakiness or the runner, not a commit.",
		];

	const lines = [
		`${range.count} commit(s) since the last green run, ${span}:`,
		"",
	];

	const long = range.count > longRange;
	for (const c of range.commits) lines.push(...buildCommitLines(c, long));

	if (range.truncated)
		lines.push(
			`  … and ${range.truncated} more, not listed. Read them with: git log --oneline ${span}`,
		);

	if (long) lines.push(...buildTopFileLines(range.commits));

	return lines;
}

/**
 * One commit's lines: subject and file count for a long range, else the
 * subject and each file beneath it.
 *
 * @param {Commit} c
 * @param {boolean} long
 * @returns {string[]}
 */
function buildCommitLines(c, long) {
	if (long) return [`  ${c.short}  ${c.subject}  (${c.files.length} file(s))`];
	return [
		`  ${c.short}  ${c.subject}`,
		...c.files.map((f) => `           ${f}`),
	];
}

/**
 * The most-touched-files block, or none where the range touched no file.
 *
 * @param {Commit[]} commits
 * @returns {string[]}
 */
function buildTopFileLines(commits) {
	const top = topFiles(commits);
	if (top.length === 0) return [];
	return [
		"",
		"Most-touched files in the range:",
		...top.map(([file, n]) => `  ${n}x  ${file}`),
	];
}

/**
 * The bisect hand-off, as lines — or none at all.
 *
 * Offered only where a bisect could say something the range above has not. At
 * one commit the range IS the answer and at zero there is no commit to find, so
 * firing one costs a bisect (mantahostels#947) to reprint what the reader already has. A
 * range this could not read still gets the offer: the runner has the history
 * this clone is missing.
 *
 * @param {RangeResult} range
 * @param {{good?: string, bad?: string, workflow?: string, repoFlag?: string}} [ends]
 *   `repoFlag` is appended to the command, ` --repo <codeRepo>` where gh's
 *   default repo holds no runs (workflow-core#1963)
 * @returns {string[]}
 */
function buildBisectAdvice(
	range,
	{ good, bad, workflow = "bisect.yml", repoFlag = "" } = {},
) {
	if (range.ok && range.count <= 1) return [];
	const lead =
		range.ok && range.count > LONG_RANGE
			? "Too many to read? Name the commit"
			: "Name the commit by bisect";
	/* Full shas, not short ones: bisect.yml resolves whatever it is handed
	 * against its own checkout, and an abbreviation that is unique here can be
	 * ambiguous there. */
	return [
		"",
		`${lead}:`,
		`  gh workflow run ${workflow} -f good=${good} -f bad=${bad}${repoFlag}`,
		"  A flaky or order-dependent test makes that answer wrong rather than merely",
		"  unhelpful (mantahostels#947) — re-run it and compare before acting on it.",
	];
}

module.exports = {
	readRange,
	countRange,
	renderRange,
	buildBisectAdvice,
};
