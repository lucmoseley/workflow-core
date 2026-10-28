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
 * Each filing is recorded in this checkout's markers before the reply, so a
 * reply that fails is retried without filing again; a pid lock keeps a hand
 * run and a loop tick from both filing.
 *
 * Joins no §N3 family: a run whose filing or reply failed on gh exits 1, so
 * the loop that runs it retries.
 *
 * Caller: the refill loop, on every tick (lib/refill-tick.js).
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { parseErrLine, gh } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { fileThrough } = require("./lib/file-through.js");
const { writeFd } = require("./lib/write-fd.js");
const { readLedger } = require("./lib/delegated-decision.js");
const review = require("./lib/morning-review.js");
const reversal = require("./lib/review-reversal.js");
const { markersDir } = require("./lib/marker-root.js");
const { pidLock } = require("./lib/pid-lock.js");
const { discoverRepos, homeDir } = require("./lib/refill-repos.js");
const { readReviewIssues } = require("./lib/review-issues.js");
const { scriptIo } = require("./lib/tracker-ops.js");
const { requireKey } = require("./lib/workflow-core-config.js");
const { takesLabel } = require("./lib/takes-label.js");

const USAGE = "usage: node scripts/answer-review-reversals.js [--dry-run]";
const REVERSAL_LABEL = takesLabel("implement");
const DAY_MS = 24 * 60 * 60 * 1000;
/* Untraced: a review closed within two days is still read for reversals, so
 * a request written just before the close, or while no loop ran, is answered. */
const RECENTLY_CLOSED_MS = 2 * DAY_MS;
const FILED = "review-reversals.jsonl";
const LOCK = "review-reversals.lock";

const io = scriptIo("answer-review-reversals");

/**
 * What one run answering reversals carries: the review issue, each included
 * checkout by tracker, and this checkout's record of reversals already filed.
 * @typedef {{review: {repo: string, number: number,
 *   entries: ReturnType<typeof review.parseEntries>},
 *   roots: Map<string, string>, filed: Map<string, string>, dryRun: boolean}} Run
 */

/** @param {import("./lib/review-reversal.js").Request} r */
const requestKey = (r) => `${r.commentUrl} ${r.n}`;

/** This checkout's record of reversals filed: `owner/name#n` by request. */
function readFiled() {
	/** @type {Map<string, string>} */
	const filed = new Map();
	let text = "";
	try {
		text = fs.readFileSync(path.join(markersDir(hostRoot()), FILED), "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
	for (const line of text.split("\n")) {
		try {
			const r = JSON.parse(line);
			filed.set(requestKey(r), r.filed);
		} catch {
			/* A torn last line is a filing whose reply also never landed: the
			 * next run files it again, the duplicate this record narrows. */
		}
	}
	return filed;
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
	const entry = readLedger(root).lines.find(
		(l) => l.comment === listed.comment,
	);
	if (!entry)
		return {
			why: `no delegated-decision ledger line records ${listed.comment}`,
		};
	const ticket = reversal.buildReversalTicket({
		review: reviewIssue,
		request,
		entry,
	});
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
			"--standalone",
			`reverses entry ${request.n} of the morning review ${reviewIssue.repo}#${reviewIssue.number}`,
			"--body-file",
			"-",
		],
		ticket.body,
		root,
	);
	const n = /^Filed #(\d+)/m.exec(filed.stdout ?? "")?.[1];
	if (n) {
		const ref = `${listed.repo}#${n}`;
		fs.appendFileSync(
			path.join(markersDir(hostRoot()), FILED),
			`${JSON.stringify({ ...request, filed: ref })}\n`,
		);
		return { filed: ref };
	}
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
function rootsByTracker() {
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
	const pending = reviews.flatMap((i) => {
		const requests = reversal.pendingRequests(i.comments ?? []);
		return requests.length === 0 ? [] : [{ issue: i, requests }];
	});
	if (pending.length === 0) return 0;
	const lock = pidLock(
		path.join(markersDir(hostRoot()), LOCK),
		path.basename(__filename),
	);
	if (!dryRun && !lock.acquire()) {
		io.out("another run is answering reversals; left to it.\n");
		return 0;
	}
	try {
		const roots = rootsByTracker();
		const filed = readFiled();
		let code = 0;
		for (const { issue, requests } of pending) {
			/** @type {Run} */
			const run = {
				review: {
					repo: tracker,
					number: issue.number,
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

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	process.exitCode = answerReversals(
		io.trackerOrFail(),
		flags["--dry-run"] === true,
	);
}

if (require.main === module) main();
