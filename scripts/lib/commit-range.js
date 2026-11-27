const { cutAt } = require("./cut-at.js");
const { readCommit } = require("./commit-sha.js");
const { execGit, gitReader } = require("./git.js");

// guess, lucmoseley/mantahostels#905
const LONG_RANGE = 8;

// guess, workflow-core#5529
const MAX_LISTED = 120;

// guess, workflow-core#5529
const TOP_FILES = 10;

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
 * @param {unknown} e
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
 * @param {RangeResult} range
 * @param {{good?: string, bad?: string, workflow?: string, repoFlag?: string}} [ends]
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
