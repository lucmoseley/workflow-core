#!/usr/bin/env node
const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { ghApiSlurp, ghJson, parseErrLine } = require("./lib/gh");
const {
	buildArchiveContainerTitle,
	readSubIssues,
	subIssueTotal,
} = require("./lib/issue-tree");
const { DIGEST_HEX_LENGTH } = require("./lib/census-digest.js");
const { sectionAMatcher } = require("./lib/doc-map");
const { hostRoot } = require("./lib/host-root");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { cutAt } = require("./lib/cut-at");
const { citedIssues } = require("./lib/cited-issues.js");
const { commitSha } = require("./lib/commit-sha.js");
const { HEX_WORD_RE, hasSha } = require("./lib/outstanding-line.js");
const { readNamedCommits } = require("./lib/unlanded-commits.js");
const { execGit, gitReader } = require("./lib/git.js");
const { readPatchIds } = require("./lib/patch-ids.js");
const { VERIFIED_BRANCH } = require("./lib/landing-refs.js");
const { caught } = require("./lib/caught.js");

const USAGE = `usage: node ${scriptPath("spec-commits.js")} <spec> [--since <sha>] [--json]`;

const GENERATED = new Set(["generated-only", "derived"]);
// spawnSync's maxBuffer defaults to 1 MB: https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options
const LOG_MAX_BUFFER = 64e6;
const SHORT_SHA = 12;
const HEX_WORDS_RE = new RegExp(HEX_WORD_RE.source, "g");
const LOG_FORMAT = "--format=%x1e%H%x1f%aI%x1f%B%x1f";
const DOOR_LINE = /^[ \t]*\*\*Door:\*\*/m;

/** @param {string} sha */
const short = (sha) => sha.slice(0, SHORT_SHA);

/** @param {number[]} ns */
const cite = (ns) => ns.map((x) => `#${x}`).join(" ");

/**
 * @param {string} raw
 * @returns {{ sha: string, authored: string, subject: string, message: string, files: string[] }[]}
 */
function parseLog(raw) {
	return raw
		.split("\x1e")
		.filter((r) => r.trim())
		.map((r) => {
			const [sha, authored, message, rest = ""] = r.split("\x1f");
			if (sha === undefined || authored === undefined || message === undefined)
				throw new Error(
					`git log record ${JSON.stringify(r)} has no message field`,
				);
			return {
				sha: sha.trim(),
				authored,
				subject: cutAt(message, "\n")[0],
				message,
				files: rest.split("\n").filter(Boolean),
			};
		});
}

/**
 * @param {string} filedAt
 * @param {string} range
 */
const logArgs = (filedAt, range) => [
	"log",
	"--reverse",
	`--since=${filedAt}`,
	LOG_FORMAT,
	"--name-only",
	range,
];

/** @param {string} rev */
function ancestorOfHead(rev) {
	const sha = commitSha(process.cwd(), rev);
	if (sha === null) return null;
	try {
		execGit(["merge-base", "--is-ancestor", sha, "HEAD"], {
			stdio: "ignore",
		});
		return sha;
	} catch {
		return null;
	}
}

/** @param {string} sha */
function isOnMain(sha) {
	if (commitSha(process.cwd(), VERIFIED_BRANCH) === null) return null;
	try {
		execGit(["merge-base", "--is-ancestor", sha, VERIFIED_BRANCH], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		return true;
	} catch (e) {
		const { status, stderr, message } = caught(e);
		if (status === 1) return false;
		// #3240
		process.stderr.write(
			`spec-commits: could not tell whether ${sha} is on ${VERIFIED_BRANCH}: ${(stderr ?? message).trim()}\n`,
		);
		return null;
	}
}

/** @param {{ authored: string, subject: string }} c */
const twinKey = (c) => `${c.authored} ${c.subject}`;

/**
 * @typedef {{ by: "cites" } | { by: "named", ticket: number } | { by: "twin", ticket: number, of: string }} Route
 * @typedef {ReturnType<typeof parseLog>[number] & { ticket: number }} NamedElsewhere
 * @typedef {{ ticket: number, sha: string, subject: string | null }} Missing
 * @typedef {{ onHead: Map<string, number>, elsewhere: NamedElsewhere[], unresolved: Missing[] }} Named
 * @typedef {{ number: number, title: string, total: number }} Unexpanded
 */

/**
 * @param {number} n
 * @param {string} repositoryUrl
 * @returns {{ tickets: { number: number, state: string }[], unexpanded: Unexpanded[] }}
 */
function readTickets(n, repositoryUrl) {
	const kids = readSubIssues(n)
		.flatMap((k) =>
			k.title === buildArchiveContainerTitle(n) ? readSubIssues(k.number) : [k],
		)
		.filter((k) => !k.pull_request && k.repository_url === repositoryUrl);
	return {
		tickets: kids.map((k) => ({ number: k.number, state: k.state })),
		unexpanded: kids
			.map((k) => ({
				number: k.number,
				title: k.title,
				total: subIssueTotal(k),
			}))
			.filter((u) => u.total > 0),
	};
}

/**
 * @param {{ number: number, state: string }[]} tickets
 * @returns {{ ticket: number, text: string }[]}
 */
function readCloses(tickets) {
	return tickets
		.filter((t) => t.state === "closed")
		.map((t) => {
			/** @type {string[]} */
			const bodies = ghApiSlurp([
				`repos/{owner}/{repo}/issues/${t.number}/comments`,
			]).map((c) => c.body ?? "");
			const doors = bodies.filter((b) => DOOR_LINE.test(b));
			const text =
				doors.length > 0
					? doors.join("\n")
					: (bodies.findLast((b) => hasSha(b)) ?? "");
			return { ticket: t.number, text };
		});
}

/** @param {string} sha */
function isOnHead(sha) {
	try {
		execGit(["merge-base", "--is-ancestor", sha, "HEAD"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		return true;
	} catch (e) {
		const { status, stderr, message } = caught(e);
		if (status === 1) return false;
		throw new Error(`merge-base on ${sha}: ${(stderr ?? message).trim()}`, {
			cause: e,
		});
	}
}

/** @param {string} word */
const isDigestLength = (word) => word.length === DIGEST_HEX_LENGTH;

/**
 * @param {{ ticket: number, text: string }[]} closes
 * @returns {Named}
 */
function resolveNamed(closes) {
	const read = gitReader(process.cwd());
	/** @type {Named} */
	const named = { onHead: new Map(), elsewhere: [], unresolved: [] };
	/** @type {Set<string>} */
	const seen = new Set();
	for (const { ticket, text } of closes)
		for (const word of new Set(text.match(HEX_WORDS_RE) ?? [])) {
			const shas = readNamedCommits(read, word);
			if (shas.length === 0 && hasSha(word) && !isDigestLength(word))
				named.unresolved.push({ ticket, sha: word, subject: null });
			for (const sha of shas.filter((x) => !seen.has(x))) {
				seen.add(sha);
				placeNamed(named, sha, ticket);
			}
		}
	return named;
}

/**
 * @param {Named} named
 * @param {string} sha
 * @param {number} ticket
 */
function placeNamed(named, sha, ticket) {
	if (isOnHead(sha)) {
		named.onHead.set(sha, ticket);
		return;
	}
	const log = execGit(["log", "-1", LOG_FORMAT, sha], { encoding: "utf8" });
	for (const c of parseLog(log)) named.elsewhere.push({ ...c, ticket });
}

/**
 * @param {ReturnType<typeof parseLog>} log
 * @param {Set<number>} numbers
 * @param {Named} named
 */
function specCommits(log, numbers, named) {
	/** @type {Map<string, NamedElsewhere>} */
	const byKey = new Map(named.elsewhere.map((o) => [twinKey(o), o]));
	return log.flatMap((c) => {
		/** @type {Route | null} */
		let route = null;
		const ticket = named.onHead.get(c.sha);
		const twinOf = byKey.get(twinKey(c));
		if ([...citedIssues(c.message)].some((n) => numbers.has(n)))
			route = { by: "cites" };
		else if (ticket !== undefined) route = { by: "named", ticket };
		else if (twinOf !== undefined)
			route = { by: "twin", ticket: twinOf.ticket, of: twinOf.sha };
		return route === null ? [] : [{ ...c, route }];
	});
}

/**
 * @param {Named} named
 * @param {ReturnType<typeof specCommits>} listed
 * @returns {Missing[]}
 */
function missingNamed(named, listed) {
	const held = new Set(listed.map(twinKey));
	return [
		...named.elsewhere
			.filter((o) => !held.has(twinKey(o)))
			.map(({ ticket, sha, subject }) => ({ ticket, sha, subject })),
		...named.unresolved,
	];
}

/**
 * @typedef {{ sha: string, patchDiffers: boolean }} Twin
 * @typedef {ReturnType<typeof specCommits>[number] & { twin: Twin | null }} Listed
 */

/**
 * @param {ReturnType<typeof specCommits>} commits
 * @param {ReturnType<typeof specCommits>} reviewed
 * @returns {{ commits: Listed[], twinsRead: boolean }}
 */
function markTwins(commits, reviewed) {
	const unmarked = commits.map((c) => ({ ...c, twin: null }));
	if (commits.length === 0 || reviewed.length === 0)
		return { commits: unmarked, twinsRead: true };
	const ids = readPatchIds(
		[...commits, ...reviewed].map((c) => c.sha),
		process.cwd(),
	);
	if (ids === null) return { commits: unmarked, twinsRead: false };
	/** @type {Map<string, string>} */
	const byPatch = new Map();
	/** @type {Map<string, string>} */
	const bySubject = new Map();
	for (const r of reviewed) {
		const id = ids.get(r.sha);
		if (id !== undefined) byPatch.set(id, r.sha);
		bySubject.set(twinKey(r), r.sha);
	}
	const marked = commits.map((c) => {
		const id = ids.get(c.sha);
		const patchTwin = id === undefined ? undefined : byPatch.get(id);
		if (patchTwin !== undefined)
			return { ...c, twin: { sha: patchTwin, patchDiffers: false } };
		const subjectTwin = bySubject.get(twinKey(c));
		return {
			...c,
			twin:
				subjectTwin === undefined
					? null
					: { sha: subjectTwin, patchDiffers: true },
		};
	});
	return { commits: marked, twinsRead: true };
}

/** @param {Listed} c */
const isUnreviewed = (c) => c.twin === null || c.twin.patchDiffers;

/**
 * @param {string[]} files
 * @returns {Set<string> | null}
 */
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
 * @property {Listed[]} commits
 * @property {Missing[]} missing
 * @property {Unexpanded[]} unexpanded
 * @property {boolean} twinsRead
 * @property {string[]} files
 * @property {Set<string> | null} marked
 * @property {Set<string>} generated
 * @property {string | null} show
 * @property {string | null} reviewedThrough
 * @property {boolean | null} throughOnMain
 */

/** @param {SpecView} v */
function buildJsonReport(v) {
	return `${JSON.stringify(
		{
			spec: v.n,
			since: v.after,
			tickets: v.tickets.map((t) => t.number),
			open: v.open,
			commits: v.commits.map(({ sha, subject, route, twin }) => ({
				sha,
				subject,
				route,
				twin,
			})),
			missing: v.missing,
			unexpanded: v.unexpanded,
			twinsRead: v.twinsRead,
			files: v.files.map((f) => ({ path: f, generated: v.generated.has(f) })),
			generatedMarked: Boolean(v.marked),
			show: v.show,
			reviewedThrough: v.reviewedThrough,
			throughOnMain: v.throughOnMain,
		},
		null,
		2,
	)}\n`;
}

/**
 * @param {string | null} sha
 * @param {boolean | null} onMain
 */
const buildReviewedThroughLines = (sha, onMain) => [
	"  (a sha main keeps: one from a worktree not yet landed is rebased away, and the next --since reads its landed twin as new)",
	`  **Reviewed through:** ${sha}`,
	...(onMain === false && sha
		? [
				`  WARNING: ${short(sha)} is not on main. Land the spec's commits and re-run this on main for the sha to record.`,
			]
		: []),
];

/** @param {Twin | null} twin */
function buildTwinMark(twin) {
	if (twin === null) return "";
	return twin.patchDiffers
		? `  [rebased, patch differs (twin ${short(twin.sha)}) — read this landed form]`
		: `  [already reviewed (twin ${short(twin.sha)})]`;
}

/** @param {Route} route */
function buildRouteMark(route) {
	if (route.by === "cites") return "";
	return route.by === "named"
		? `  [named in #${route.ticket}'s close]`
		: `  [landed twin of ${short(route.of)}, named in #${route.ticket}'s close]`;
}

/** @param {Missing} m */
const buildMissingNote = (m) =>
	m.subject === null
		? `NOTE: #${m.ticket}'s close names ${m.sha}, which names no commit in this clone — another repository's, unfetched, or rebased away; not reviewed.`
		: `NOTE: #${m.ticket}'s close names ${short(m.sha)} ${m.subject}, which HEAD holds under neither its hash nor its author date and subject — not landed here, so not reviewed.`;

/** @param {Unexpanded} u */
const buildUnexpandedNote = (u) =>
	`NOTE: #${u.number} "${u.title}" holds ${u.total} sub-issue(s), whose commits are listed only where they cite this spec or its tickets. A hand-made container's or a sub-spec's work belongs in this review; a ticket's follow-up may not. List them: gh api repos/{owner}/{repo}/issues/${u.number}/sub_issues`;

/** @param {number[]} open @param {Missing[]} missing @param {Unexpanded[]} unexpanded */
const buildNotes = (open, missing, unexpanded) => [
	...(open.length > 0
		? [
				`NOTE: ${cite(open)} still open — the spec is not finished, so this is not yet its whole diff.`,
			]
		: []),
	...missing.map(buildMissingNote),
	...unexpanded.map(buildUnexpandedNote),
];

/**
 * @param {number} n
 * @param {string | null} after
 * @param {string} cites
 * @param {boolean} hasUnread
 */
function buildNoCommitLine(n, after, cites, hasUnread) {
	if (after)
		return `No commit after ${short(after)} cites ${cites} or is named in a closed ticket's resolution: nothing new to review. Say so in the triage comment, ending it with:`;
	const found = `No commit since #${n} was filed cites ${cites} or is named in a closed ticket's resolution`;
	return hasUnread
		? `${found}. Read the sub-issues noted above before calling this a decision-only spec.`
		: `${found}: a decision-only spec. Skip the review, and say so in the triage comment.`;
}

/** @param {SpecView} v */
function buildTextReport({
	n,
	after,
	tickets,
	open,
	commits,
	missing,
	unexpanded,
	twinsRead,
	files,
	marked,
	generated,
	show,
	reviewedThrough,
	throughOnMain,
}) {
	const cites =
		tickets.length > 0
			? `#${n} or its ${tickets.length} ticket(s) (${cite(tickets.map((t) => t.number))})`
			: `#${n} (no ticket)`;
	const lines = buildNotes(open, missing, unexpanded);
	if (commits.length === 0) {
		lines.push(
			buildNoCommitLine(n, after, cites, unexpanded.length > 0),
			...(after ? buildReviewedThroughLines(after, throughOnMain) : []),
		);
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`${commits.length} commit(s)${after ? ` after ${short(after)}` : ""} cite ${cites} or are named in a closed ticket's resolution, oldest first:`,
	);
	if (!twinsRead)
		lines.push(
			"  NOTE: git gave no patch-ids, so no twin of a reviewed commit is marked.",
		);
	for (const c of commits)
		lines.push(
			`  ${short(c.sha)} ${c.subject}${buildRouteMark(c.route)}${buildTwinMark(c.twin)}`,
		);
	if (show === null) {
		lines.push(
			"",
			"Each is a twin of a reviewed commit: nothing new to review. Say so in the triage comment, ending it with:",
			...buildReviewedThroughLines(reviewedThrough, throughOnMain),
		);
		return `${lines.join("\n")}\n`;
	}
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
		...buildReviewedThroughLines(reviewedThrough, throughOnMain),
	);
	return `${lines.join("\n")}\n`;
}

/** @param {string[]} argv */
function main(argv) {
	const args = readArgs(argv);
	if (typeof args === "number") return args;
	const { json, n, after } = args;

	/** @type {{ created_at: string, repository_url: string }} */
	let spec;
	let tickets;
	let unexpanded;
	let closes;
	try {
		spec = ghJson(["api", `repos/{owner}/{repo}/issues/${n}`]);
		({ tickets, unexpanded } = readTickets(n, spec.repository_url));
		closes = readCloses(tickets);
	} catch (e) {
		process.stderr.write(`#${n} unreadable: ${parseErrLine(e)}\n`);
		return 1;
	}
	let named;
	try {
		named = resolveNamed(closes);
	} catch (e) {
		process.stderr.write(
			`git could not resolve the shas the closes name: ${caught(e).message}\n`,
		);
		return 1;
	}
	const numbers = new Set([n, ...tickets.map((t) => t.number)]);
	const open = tickets.filter((t) => t.state === "open").map((t) => t.number);

	/** @param {string} range */
	const readSpecCommits = (range) =>
		specCommits(
			parseLog(
				execGit(logArgs(spec.created_at, range), {
					encoding: "utf8",
					maxBuffer: LOG_MAX_BUFFER,
				}),
			),
			numbers,
			named,
		);
	const found = readSpecCommits(after ? `${after}..HEAD` : "HEAD");
	const reviewed = after ? readSpecCommits(after) : [];
	const { commits, twinsRead } = markTwins(found, reviewed);
	const missing = missingNamed(named, [...reviewed, ...found]);
	const unread = commits.filter(isUnreviewed);
	const files = [...new Set(unread.flatMap((c) => c.files))].sort();
	const marked = generatedOf(files);
	const generated = marked ?? new Set();
	const show =
		unread.length > 0
			? `git show ${unread.map((c) => short(c.sha)).join(" ")}`
			: null;
	const newest = commits.at(-1);
	const reviewedThrough = newest === undefined ? after : newest.sha;

	const view = {
		n,
		after,
		tickets,
		open,
		commits,
		missing,
		unexpanded,
		twinsRead,
		files,
		marked,
		generated,
		show,
		reviewedThrough,
		throughOnMain: reviewedThrough === null ? null : isOnMain(reviewedThrough),
	};
	process.stdout.write(json ? buildJsonReport(view) : buildTextReport(view));
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
