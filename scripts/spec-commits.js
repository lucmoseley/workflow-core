#!/usr/bin/env node
/*
 * spec-commits.js — the commits a spec's whole-spec review reads: every commit
 * on HEAD citing the spec or one of its tickets (#892, ruled at #880).
 *
 *   node scripts/spec-commits.js <spec> [--since <sha>] [--json]
 *
 * Prints the commits oldest first, the files they touched, the one `git show`
 * that is their combined diff, and the newest one's sha for the triage
 * comment's `**Reviewed through:**` line. No commit at all is a decision-only
 * spec, and the review is skipped.
 *
 * --since <sha> lists only the commits after that sha on HEAD: a spec back at
 * triage with its findings' fixes reviews those, not the whole spec again
 * (#897). The sha is the earlier triage comment's `**Reviewed through:**`.
 *
 * NOT A RANGE. A spec's commits interleave with other sessions' work, so
 * `<first>^..<last>` would review a neighbour's commits as the spec's.
 *
 * ONLY COMMITS SINCE THE SPEC WAS FILED. Commits from before the tracker split
 * cite the inherited tracker's issues bare, under the same numbers, so an
 * older bare `#N` is the inherited tracker's issue N, not ours.
 *
 * GENERATED FILES ARE MARKED, NOT DROPPED: a file docs/doc-map-classes.json
 * classes `generated-only` or `derived` is reviewed at its generator.
 *
 * Citation match: `#N` not preceded by a word character, `/`, `#` or `-`, so
 * `mantahostels#N` and `design-vault#N` are not ours. A commit that only
 * mentions a ticket is listed too; the reviewer drops it.
 *
 * IN NO SCRIPT FAMILY (docs/code-standards-base.md §N3): a read-only lister. Exit 0
 * listed (none found included), 1 the tracker unreadable, 2 bad usage or a
 * --since sha not on HEAD.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ghJson, errLine } = require("./lib/gh");
const { subIssuesOf } = require("./lib/issue-tree");
const { sectionAMatcher } = require("./lib/doc-map");
const { hostRoot } = require("./lib/host-root");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { cutAt } = require("./lib/cut-at");
const { citedIssues } = require("./lib/cited-issues.js");
const { commitSha } = require("./lib/commit-sha.js");

const USAGE =
	"usage: node scripts/spec-commits.js <spec> [--since <sha>] [--json]";

const GENERATED = new Set(["generated-only", "derived"]);
/* The whole history's log was 4.6 MB at 5,560 commits (8 Oct 2026); node's
 * 1 MB default would already throw on it. */
const LOG_MAX_BUFFER = 64e6;
const SHORT_SHA = 12;

/** @param {string} sha */
const short = (sha) => sha.slice(0, SHORT_SHA);

/** @param {number[]} ns */
const cite = (ns) => ns.map((x) => `#${x}`).join(" ");

/**
 * `git log` records — sha, subject, body, touched files — oldest first.
 * @param {string} raw output of the format `logArgs` asks for
 * @returns {{ sha: string, subject: string, message: string, files: string[] }[]}
 */
function parseLog(raw) {
	return raw
		.split("\x1e")
		.filter((r) => r.trim())
		.map((r) => {
			const [sha, message, rest = ""] = r.split("\x1f");
			if (sha === undefined || message === undefined)
				throw new Error(
					`git log record ${JSON.stringify(r)} has no message field`,
				);
			return {
				sha: sha.trim(),
				subject: cutAt(message, "\n")[0],
				message,
				files: rest.split("\n").filter(Boolean),
			};
		});
}

/** @param {string} filedAt ISO date @param {string | null} after sha */
const logArgs = (filedAt, after) => [
	"log",
	"--reverse",
	`--since=${filedAt}`,
	"--format=%x1e%H%x1f%B%x1f",
	"--name-only",
	after ? `${after}..HEAD` : "HEAD",
];

/** The full sha of `rev` where it is a commit HEAD contains, else null.
 *  @param {string} rev */
function ancestorOfHead(rev) {
	const sha = commitSha(process.cwd(), rev);
	if (sha === null) return null;
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
			stdio: "ignore",
		});
		return sha;
	} catch {
		/* Not on HEAD, or git failing alike. */
		return null;
	}
}

/**
 * The commits citing any of `numbers`, and the files they touched.
 * @param {ReturnType<typeof parseLog>} log
 * @param {Set<number>} numbers
 */
function specCommits(log, numbers) {
	const commits = log.filter((c) =>
		[...citedIssues(c.message)].some((n) => numbers.has(n)),
	);
	const files = [...new Set(commits.flatMap((c) => c.files))].sort();
	return { commits, files };
}

/** `null` where the class register is unreadable: the listing still stands,
 *  so it fails open, and says so in the output (#892).
 *  @param {string[]} files @returns {Set<string> | null} */
function generatedOf(files) {
	/** @type {Record<string, { class: string }>} */
	let classes;
	try {
		classes = JSON.parse(
			fs.readFileSync(
				path.join(hostRoot(), "docs", "doc-map-classes.json"),
				"utf8",
			),
		);
	} catch {
		return null;
	}
	const matchers = Object.entries(classes)
		.filter(([, e]) => GENERATED.has(e.class))
		.map(([k]) => sectionAMatcher(k));
	return new Set(files.filter((f) => matchers.some((m) => m(f))));
}

/**
 * The spec number, --json and the resolved --since sha, or the exit code
 * where the arguments do not stand.
 * @param {string[]} argv
 * @returns {{ json: boolean, n: number, after: string | null } | number}
 */
function readArgs(argv) {
	const { flags, positionals } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--since": "value", "--json": "boolean" },
		min: 1,
	});
	const json = flags["--json"] === true;
	const sinceArg = flagValue(flags, "--since") ?? null;
	const [specArg] = positionals;
	if (specArg === undefined)
		throw new Error("parseOrExit passed no spec number despite min: 1");
	const n = /^\d+$/.test(specArg) ? Number(specArg) : 0;
	if (!n || (sinceArg !== null && !/^[0-9a-f]{7,40}$/i.test(sinceArg))) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	const after = sinceArg && ancestorOfHead(sinceArg);
	if (sinceArg && !after) {
		process.stderr.write(
			`--since ${sinceArg} is not a commit on HEAD. Pass the sha on the earlier triage comment's **Reviewed through:** line, or drop --since to review the whole spec.\n`,
		);
		return 2;
	}
	return { json, n, after };
}

/**
 * @typedef {object} SpecView
 * @property {number} n
 * @property {string | null} after
 * @property {{ number: number, state: string }[]} tickets
 * @property {number[]} open
 * @property {ReturnType<typeof parseLog>} commits
 * @property {string[]} files
 * @property {Set<string> | null} marked
 * @property {Set<string>} generated
 * @property {string | null} show
 * @property {string | null} reviewedThrough
 */

/** @param {SpecView} v */
function jsonReport(v) {
	return `${JSON.stringify(
		{
			spec: v.n,
			since: v.after,
			tickets: v.tickets.map((t) => t.number),
			open: v.open,
			commits: v.commits.map(({ sha, subject }) => ({ sha, subject })),
			files: v.files.map((f) => ({ path: f, generated: v.generated.has(f) })),
			generatedMarked: Boolean(v.marked),
			show: v.show,
			reviewedThrough: v.reviewedThrough,
		},
		null,
		2,
	)}\n`;
}

/** @param {SpecView} v */
function textReport({
	n,
	after,
	tickets,
	open,
	commits,
	files,
	marked,
	generated,
	show,
	reviewedThrough,
}) {
	const cites =
		tickets.length > 0
			? `#${n} or its ${tickets.length} ticket(s) (${cite(tickets.map((t) => t.number))})`
			: `#${n} (no ticket)`;
	const lines = [];
	if (open.length > 0)
		lines.push(
			`NOTE: ${cite(open)} still open — the spec is not finished, so this is not yet its whole diff.`,
		);
	if (commits.length === 0) {
		lines.push(
			after
				? `No commit after ${short(after)} cites ${cites}: nothing new to review. Say so in the triage comment, ending it with:\n  **Reviewed through:** ${after}`
				: `No commit since #${n} was filed cites ${cites}: a decision-only spec. Skip the review, and say so in the triage comment.`,
		);
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`${commits.length} commit(s)${after ? ` after ${short(after)}` : ""} cite ${cites}, oldest first:`,
	);
	for (const c of commits) lines.push(`  ${short(c.sha)} ${c.subject}`);
	lines.push("", `Files they touched (${files.length}):`);
	if (!marked)
		lines.push(
			"  NOTE: docs/doc-map-classes.json unreadable, so no generated file is marked.",
		);
	for (const f of files)
		lines.push(
			`  ${f}${generated.has(f) ? "  [generated — review its generator]" : ""}`,
		);
	lines.push(
		"",
		"Combined diff (the commits interleave with other work, so never a range):",
		`  ${show}`,
		"",
		"Record in the triage comment:",
		`  **Reviewed through:** ${reviewedThrough}`,
	);
	return `${lines.join("\n")}\n`;
}

/** @param {string[]} argv */
function main(argv) {
	const args = readArgs(argv);
	if (typeof args === "number") return args;
	const { json, n, after } = args;

	let spec;
	let kids;
	try {
		spec = ghJson(["api", `repos/{owner}/{repo}/issues/${n}`]);
		kids = subIssuesOf(n);
	} catch (e) {
		process.stderr.write(`#${n} unreadable: ${errLine(e)}\n`);
		return 1;
	}
	/* A sub-issue in another repo is not cited bare from this one. */
	const tickets = kids
		.filter((k) => !k.pull_request && k.repository_url === spec.repository_url)
		.map((k) => ({ number: k.number, state: k.state }));
	const numbers = new Set([n, ...tickets.map((t) => t.number)]);
	const open = tickets.filter((t) => t.state === "open").map((t) => t.number);

	const raw = execFileSync("git", logArgs(spec.created_at, after), {
		encoding: "utf8",
		maxBuffer: LOG_MAX_BUFFER,
	});
	const { commits, files } = specCommits(parseLog(raw), numbers);
	const marked = generatedOf(files);
	const generated = marked ?? new Set();
	const show =
		commits.length > 0
			? `git show ${commits.map((c) => short(c.sha)).join(" ")}`
			: null;
	/* With nothing new, the last pass's sha still stands. */
	const newest = commits.at(-1);
	const reviewedThrough = newest === undefined ? after : newest.sha;

	const view = {
		n,
		after,
		tickets,
		open,
		commits,
		files,
		marked,
		generated,
		show,
		reviewedThrough,
	};
	process.stdout.write(json ? jsonReport(view) : textReport(view));
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
