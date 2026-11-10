#!/usr/bin/env node
/*
 * answer-review-reversals.js — answer each unanswered `reverse <n>` comment
 * on a morning review issue open or closed in the last RECENTLY_CLOSED_MS
 * (#2017, spec #1995): lib/review-reversal.js reads the request, and this
 * files a `takes:implement` ticket in the entry's repo and replies with its
 * number. The review itself is scripts/file-morning-review.js's.
 *
 *   node scripts/answer-review-reversals.js [--dry-run]
 *
 * A delegated-decision entry's ticket is built from its ledger line; a
 * primitives-table entry's from the review line itself (#3465).
 *
 * Each filing is recorded before the reply, so a reply that fails is retried
 * without filing again; a filing that landed unrecorded is found on the entry's
 * tracker and recorded instead (#3828); a pid lock keeps a hand run and a loop
 * tick from both filing. Record and lock are one per tracker on this machine,
 * whichever checkout a run starts in.
 *
 * Joins no §N3 family: a run whose filing or reply failed on gh exits 1, so
 * the loop that runs it retries.
 */

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { parseErrLine, gh, ghIssuesUpdatedSince } = require("./lib/gh.js");
const { caught } = require("./lib/caught.js");
const { fileThrough } = require("./lib/file-through.js");
const { findFiledLine } = require("./lib/filed-line.js");
const { writeFd } = require("./lib/write-fd.js");
const { readJsonl } = require("./lib/jsonl.js");
const { readLedger } = require("./lib/delegated-decision.js");
const review = require("./lib/morning-review.js");
const reversal = require("./lib/review-reversal.js");
const { pidLock } = require("./lib/pid-lock.js");
const { refillPath } = require("./lib/refill-dir.js");
const { discoverRepos, homeDir } = require("./lib/refill-repos.js");
const { readReviewIssues } = require("./lib/review-issues.js");
const { scriptIo } = require("./lib/tracker-ops.js");
const { repoSlug, requireKey } = require("./lib/workflow-core-config.js");
const { takesLabel } = require("./lib/takes-label.js");

const USAGE = `usage: node ${scriptPath("answer-review-reversals.js")} [--dry-run]`;
const REVERSAL_LABEL = takesLabel("implement");
const DAY_MS = 24 * 60 * 60 * 1000;
/* Untraced: a review closed within two days is still read for reversals, so
 * a request written just before the close, or while no loop ran, is answered. */
const RECENTLY_CLOSED_MS = 2 * DAY_MS;
const RECORD_EXTENSION = "jsonl";
const LOCK_EXTENSION = "lock";
/* Each program answerReversals runs in, as a holder is read by its command
 * line (#3815). Residual: a third program requiring it must be listed here, or
 * its live holder reads as stale and is taken over. */
const ANSWERERS = [path.basename(__filename), "file-morning-review.js"];

const io = scriptIo("answer-review-reversals");

/**
 * What one run answering reversals carries: the review issue, each included
 * checkout by tracker, and the review tracker's record of reversals filed.
 * @typedef {{review: {repo: string, number: number, createdAt: string,
 *   entries: ReturnType<typeof review.parseEntries>},
 *   roots: Map<string, string>, filed: Map<string, string>, dryRun: boolean}} Run
 */

/** @param {import("./lib/review-reversal.js").Request} r */
const requestKey = (r) => `${r.commentUrl} ${r.n}`;

/**
 * A review tracker's reversal record or lock: outside any checkout, as one's
 * own markers would give two checkouts two of each.
 * @param {string} tracker
 * @param {string} extension
 */
function buildReversalPath(tracker, extension) {
	const slug = repoSlug(tracker).replaceAll("/", "__");
	return refillPath(`review-reversals-${slug}.${extension}`);
}

/**
 * The tracker's record of reversals filed: `owner/name#n` by request.
 * @param {string} tracker
 */
function readFiled(tracker) {
	/** @type {Map<string, string>} */
	const filed = new Map();
	const read = readJsonl(buildReversalPath(tracker, RECORD_EXTENSION));
	for (const r of read?.rows ?? [])
		if (typeof r.filed === "string")
			filed.set(
				requestKey(
					/** @type {import("./lib/review-reversal.js").Request} */ (r),
				),
				r.filed,
			);
	return filed;
}

/**
 * The reversal ticket for one listed entry, or why none can be built.
 * @param {string} root the entry's checkout
 * @param {Run["review"]} reviewIssue
 * @param {import("./lib/review-reversal.js").Request} request
 * @param {import("./lib/morning-review.js").Entry} listed
 * @returns {{title: string, body: string} | {why: string}}
 */
function buildTicket(root, reviewIssue, request, listed) {
	if (listed.kind === "primitive")
		return reversal.buildPrimitiveReversalTicket({
			review: reviewIssue,
			request,
			entry: listed,
		});
	const entry = readLedger(root).lines.find(
		(l) => l.comment === listed.comment,
	);
	return entry
		? reversal.buildReversalTicket({ review: reviewIssue, request, entry })
		: { why: `no delegated-decision ledger line records ${listed.comment}` };
}

/**
 * The ticket this request already produced on `repo`, open or closed, whatever
 * the local record says: a create can land and report failure, or outlive the
 * run that started it. Read from the review's filing on, as no ticket for it can
 * be older. Residual: a create still in flight is not found, and that run files
 * a second ticket.
 * @param {string} repo
 * @param {Run["review"]} reviewIssue
 * @param {import("./lib/review-reversal.js").Request} request
 * @returns {{number: number} | undefined}
 */
function findLandedTicket(repo, reviewIssue, request) {
	const clause = reversal.buildRequestClause(reviewIssue, request);
	return ghIssuesUpdatedSince(repo, reviewIssue.createdAt).find(
		(/** @type {{body?: string | null}} */ i) => i.body?.includes(clause),
	);
}

/**
 * File one request's ticket in the entry's repo: the outcome to reply with,
 * or null where it failed on gh and is left for the next run.
 * @param {Run} run
 * @param {import("./lib/review-reversal.js").Request} request
 * @returns {import("./lib/review-reversal.js").Outcome | null}
 */
function fileReversal(run, request) {
	const { review: reviewIssue, roots, filed: filedBefore, dryRun } = run;
	const already = filedBefore.get(requestKey(request));
	if (already) return { filed: already };
	if (request.n === null)
		return {
			why: "no entry number read; write `reverse <entry number>` on a line of its own",
		};
	const listed = reviewIssue.entries.get(request.n);
	if (!listed) return { why: `the review lists no entry ${request.n}` };
	const root = roots.get(listed.repo);
	if (!root)
		return { why: `no included checkout here files on ${listed.repo}` };
	const ticket = buildTicket(root, reviewIssue, request, listed);
	if ("why" in ticket) return ticket;
	/** @param {number} number */
	const recordFiled = (number) => {
		const ref = `${listed.repo}#${number}`;
		if (!dryRun)
			fs.appendFileSync(
				buildReversalPath(reviewIssue.repo, RECORD_EXTENSION),
				`${JSON.stringify({ ...request, filed: ref })}\n`,
			);
		return { filed: ref };
	};
	let landed;
	try {
		landed = findLandedTicket(listed.repo, reviewIssue, request);
	} catch (e) {
		writeFd(
			2,
			`entry ${request.n} of #${reviewIssue.number}: could not look for a ticket already filed (${parseErrLine(e)}), left for the next run\n`,
		);
		return null;
	}
	if (landed !== undefined) return recordFiled(landed.number);
	if (dryRun) {
		io.out(`would file in ${listed.repo}: ${ticket.title}\n\n${ticket.body}\n`);
		return { filed: `${listed.repo}#<new>` };
	}
	const filed = fileThrough(
		[
			"--title",
			ticket.title,
			"--label",
			REVERSAL_LABEL,
			"--origin",
			"founder",
			"--no-fault",
			"--standalone",
			`reverses entry ${request.n} of the morning review ${reviewIssue.repo}#${reviewIssue.number}`,
			"--body-file",
			"-",
		],
		ticket.body,
		root,
	);
	const n = findFiledLine(filed.stdout ?? "")?.n;
	if (n !== undefined) return recordFiled(n);
	if (filed.status === 2)
		return {
			why: `file-issue.js refused it: ${buildQuotedFirstLine(filed.stderr ?? "")}`,
		};
	writeFd(
		2,
		`entry ${request.n} of #${reviewIssue.number}: filing failed, left for the next run\n${filed.stderr ?? ""}`,
	);
	return null;
}

/**
 * Answer one `reverse <n>` request: file its ticket, then reply.
 * @param {Run} run
 * @param {import("./lib/review-reversal.js").Request} request
 * @returns {number} the exit code
 */
function answerRequest(run, request) {
	const outcome = fileReversal(run, request);
	if (outcome === null) return 1;
	const { review: reviewIssue } = run;
	const ack = reversal.buildAckComment(reviewIssue.number, request, outcome);
	if (run.dryRun) {
		io.out(`would reply on #${reviewIssue.number}:\n${ack}`);
		return 0;
	}
	try {
		gh(
			[
				"issue",
				"comment",
				String(reviewIssue.number),
				"--repo",
				reviewIssue.repo,
				"--body-file",
				"-",
			],
			{ input: ack, stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch (e) {
		writeFd(
			2,
			`entry ${request.n} of #${reviewIssue.number}: the reply failed (${parseErrLine(e)}); the next run replies again${"filed" in outcome ? `, naming ${outcome.filed} without filing it again` : ""}\n`,
		);
		return 1;
	}
	io.out(`${ack.split("\n")[0]}\n`);
	return 0;
}

/** @param {string} text */
const buildQuotedFirstLine = (text) =>
	review.quoted(text.split("\n").find((l) => l.trim()) ?? "no reason given");

/**
 * Each included checkout by the tracker it files on. One whose config cannot
 * be read is named on stderr, and its entries are answered as filed nowhere.
 */
function readRootsByTracker() {
	/** @type {Map<string, string>} */
	const roots = new Map();
	for (const root of discoverRepos(homeDir()).included) {
		try {
			roots.set(requireKey("tracker", { root }), root);
		} catch (e) {
			writeFd(2, `${root}: tracker unreadable (${caught(e).message})\n`);
		}
	}
	return roots;
}

/**
 * Answer every unanswered `reverse <n>` on the review issues open or closed
 * in the last RECENTLY_CLOSED_MS. The exit code, the worst of its requests'.
 * @param {string} tracker
 * @param {boolean} dryRun
 */
function answerReversals(tracker, dryRun) {
	let reviews;
	try {
		const since = review.searchTime(
			new Date(Date.now() - RECENTLY_CLOSED_MS).toISOString(),
		);
		reviews = [
			...readReviewIssues(tracker, "open", { withComments: true }),
			...readReviewIssues(tracker, "closed", {
				withComments: true,
				more: ["--search", `closed:>=${since}`],
			}),
		];
	} catch (e) {
		writeFd(
			2,
			`could not list ${tracker}'s review issues (${parseErrLine(e)}).\n`,
		);
		return 1;
	}
	/* A review closed between the two reads is in both, and one pass over it
	 * reads the filed record once. */
	const pending = [
		...new Map(reviews.map((i) => [i.number, i])).values(),
	].flatMap((i) => {
		const requests = reversal.pendingRequests(i.comments ?? []);
		return requests.length === 0 ? [] : [{ issue: i, requests }];
	});
	if (pending.length === 0) return 0;
	const lockFile = buildReversalPath(tracker, LOCK_EXTENSION);
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	const lock = pidLock(lockFile, ANSWERERS);
	if (!dryRun && !lock.acquire()) {
		io.out("another run is answering reversals; left to it.\n");
		return 0;
	}
	try {
		const roots = readRootsByTracker();
		const filed = readFiled(tracker);
		let code = 0;
		for (const { issue, requests } of pending) {
			/** @type {Run} */
			const run = {
				review: {
					repo: tracker,
					number: issue.number,
					createdAt: issue.createdAt,
					entries: review.parseEntries(issue.body ?? ""),
				},
				roots,
				filed,
				dryRun,
			};
			for (const request of requests)
				code = Math.max(code, answerRequest(run, request));
		}
		return code;
	} finally {
		if (!dryRun) lock.release();
	}
}

/** @param {string[]} argv */
function main(argv = process.argv.slice(2)) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	process.exitCode = answerReversals(
		io.trackerOrFail(),
		flags["--dry-run"] === true,
	);
}

if (require.main === module) main();

module.exports = { answerReversals, main };
