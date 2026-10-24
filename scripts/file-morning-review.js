#!/usr/bin/env node
/*
 * file-morning-review.js — file the day's morning review issue (workflow-core#2011, spec
 * workflow-core#1995 §The morning review issue): the still-caught delegated decisions, the
 * clear ones counted, and the closes since the previous review issue with
 * every one-way close listed.
 *
 *   node scripts/file-morning-review.js [--dry-run] [--reversals-only]
 *
 * Files on the tracker of the checkout it runs in — the loop runs it in
 * workflow-core's — and reads every repo lib/refill-repos.js includes: each
 * one's delegated-decision ledger, and its issues closed in the window with
 * their comments, for the `**Door:**` line. A repo it cannot read is named in
 * the body, not dropped silently.
 *
 * ONCE A DAY: a review issue titled with today's machine-local date, open or
 * closed, files nothing — a hand run after the founder closed today's would
 * otherwise file a second.
 *
 * Files through file-issue.js, so the `takes:` and known-label refusals bind
 * this script as they bind a session: no hook sees a gh call a script makes.
 * Refused for open issues whose titles resemble the review's, it re-runs
 * naming them `--distinct-from`, as check-orphaned-edits.js does: ONCE A DAY
 * above already rules out a second review, and a standing lookalike such as
 * the away-mode spec would otherwise refuse every run.
 *
 * REVERSALS (workflow-core#2017): every run then answers each unanswered `reverse <n>`
 * comment on a review issue open or closed in the last RECENTLY_CLOSED_MS —
 * lib/review-reversal.js — filing a `takes:implement` ticket in the entry's
 * repo and replying with its number. `--reversals-only` skips the filing, for
 * the refill loop's other ticks. Each filing is recorded in this checkout's
 * markers before the reply, so a reply that fails is retried without filing
 * again; a pid lock keeps a hand run and a loop tick from both filing.
 *
 * Joins no §N3 family: it files an issue as `report-*` does, but a run whose
 * filing or reversal failed on gh exits 1, and one file-issue.js refused exits
 * with its code, so the loop that runs it can tell a filing from a failure.
 *
 * Caller: the refill loop, the full run on its first tick after 07:00 and
 * `--reversals-only` on every other (scripts/refill-loop.js).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { errLine, gh, ghIssueListAll } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { writeFd } = require("./lib/write-fd.js");
const { readLedger } = require("./lib/delegated-decision.js");
const review = require("./lib/morning-review.js");
const reversal = require("./lib/review-reversal.js");
const { markersDir } = require("./lib/marker-root.js");
const {
	checkoutEnv,
	discoverRepos,
	homeDir,
} = require("./lib/refill-repos.js");
const { readDistinctFromHint } = require("./lib/similar-titles.js");
const { scriptIo } = require("./lib/tracker-ops.js");
const { requireKey } = require("./lib/workflow-core-config.js");
const { takesLabel } = require("./lib/takes-label.js");

const USAGE =
	"usage: node scripts/file-morning-review.js [--dry-run] [--reversals-only]";
/* Spec workflow-core#1995: the founder answers the review inside a /wayfinder session. */
const LABEL = takesLabel("wayfinder");
const REVERSAL_LABEL = takesLabel("implement");
const DAY_MS = 24 * 60 * 60 * 1000;
/* Untraced: a review closed within two days is still read for reversals, so
 * a request written just before the close, or while no loop ran, is answered. */
const RECENTLY_CLOSED_MS = 2 * DAY_MS;
const FILED = "review-reversals.jsonl";
const LOCK = "review-reversals.lock";

const io = scriptIo("file-morning-review");

/**
 * The review issues on `repo` in `state`, newest first, with their body and
 * comments where `withComments`, for the reversals. Read off the label list,
 * not search, whose index lags a fresh create and would let a quick re-run
 * file twice.
 * @param {string} repo
 * @param {"all" | "open" | "closed"} state
 * @param {{withComments?: boolean, more?: string[]}} [opts]
 * @returns {{number: number, title: string, state: string, createdAt: string,
 *   body?: string, comments?: import("./lib/review-reversal.js").Comment[]}[]}
 */
function reviewIssues(repo, state, { withComments = false, more = [] } = {}) {
	return ghIssueListAll("review issues", [
		"--repo",
		repo,
		"--state",
		state,
		"--label",
		LABEL,
		...more,
		"--json",
		`number,title,state,createdAt${withComments ? ",body,comments" : ""}`,
	])
		.filter((/** @type {{title: string}} */ i) =>
			review.parseReviewDate(i.title),
		)
		.sort(
			(
				/** @type {{createdAt: string}} */ a,
				/** @type {{createdAt: string}} */ b,
			) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
		);
}

/** @typedef {import("./lib/morning-review.js").Unread} Unread */

/**
 * One included checkout's ledger and closes, and what of it could not be read.
 * @param {string} root
 * @param {string} since
 * @returns {{reading: import("./lib/morning-review.js").RepoReading | null, unread: Unread[]}}
 */
function readRepo(root, since) {
	let repo = path.basename(root);
	try {
		repo = requireKey("tracker", { root });
		const { lines, torn } = readLedger(root);
		const closed = ghIssueListAll("closed issues", [
			"--repo",
			repo,
			"--state",
			"closed",
			"--search",
			`closed:>=${review.searchTime(since)}`,
			"--json",
			"number,title,url,closedAt,comments",
		]);
		return {
			reading: { repo, entries: lines, closed },
			unread:
				torn === 0
					? []
					: [{ repo, why: `${torn} torn ledger line(s) skipped` }],
		};
	} catch (e) {
		return {
			reading: null,
			unread: [{ repo, why: errLine(e) || caught(e).message }],
		};
	}
}

/**
 * file-issue.js run with `args` on `body`, in checkout `root`. Refused for
 * open lookalike titles, it re-runs naming them `--distinct-from`: the
 * duplicate that check exists to catch is ruled out by the caller — the
 * date-titled lookup for a review, the acknowledgement for a reversal.
 * @param {string[]} args
 * @param {string} body
 * @param {string} root
 */
function fileThrough(args, body, root) {
	const spawnFiler = (/** @type {string[]} */ a) =>
		spawnSync(process.execPath, [path.join(__dirname, "file-issue.js"), ...a], {
			input: body,
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
			cwd: root,
			env: checkoutEnv(root),
		});
	const filed = spawnFiler(args);
	const hint =
		filed.status === 2 ? readDistinctFromHint(filed.stderr || "") : null;
	return hint ? spawnFiler([...args, "--distinct-from", hint]) : filed;
}

/**
 * File today's review unless one carries today's date. The exit code.
 * @param {string} tracker
 * @param {boolean} dryRun
 */
function fileReview(tracker, dryRun) {
	const now = new Date();
	const title = review.reviewTitle(review.localDate(now));

	let reviews;
	try {
		reviews = reviewIssues(tracker, "all");
	} catch (e) {
		writeFd(
			2,
			`could not list ${tracker}'s review issues (${errLine(e)}). Nothing filed.\n`,
		);
		return 1;
	}
	const today = reviews.find((i) => i.title === title);
	if (today) {
		io.out(
			`#${today.number} is today's review issue already. Nothing filed.\n`,
		);
		return 0;
	}
	const [previous] = reviews;
	const since =
		previous?.createdAt ?? new Date(now.getTime() - DAY_MS).toISOString();

	const read = discoverRepos(homeDir()).included.map((root) =>
		readRepo(root, since),
	);
	const body = review.renderReview({
		since,
		now: now.toISOString(),
		previous: previous?.number ?? null,
		repos: read.flatMap((r) => (r.reading ? [r.reading] : [])),
		failed: read.flatMap((r) => r.unread),
	});

	if (dryRun) {
		io.out(`${title}\n\n${body}`);
		return 0;
	}
	const filed = fileThrough(
		[
			"--title",
			title,
			"--label",
			LABEL,
			"--standalone",
			"the day's away-mode review, outside every map (workflow-core#1995)",
			"--body-file",
			"-",
		],
		body,
		hostRoot(),
	);
	io.out(filed.stdout ?? "");
	writeFd(2, filed.stderr || (filed.error ? `${filed.error.message}\n` : ""));
	return filed.status ?? 1;
}

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
			why: `file-issue.js refused it: ${quotedFirstLine(filed.stderr ?? "")}`,
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
			`entry ${request.n} of #${reviewIssue.number}: the reply failed (${errLine(e)}); the next run replies again${"filed" in outcome ? `, naming ${outcome.filed} without filing it again` : ""}\n`,
		);
		return 1;
	}
	io.out(`${ack.split("\n")[0]}\n`);
	return 0;
}

/** @param {string} text */
const quotedFirstLine = (text) =>
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
 * Take the reversal lock: false where a live run holds it. A dead holder's
 * lock is taken over.
 * @param {string} lock
 */
function takeLock(lock) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
			return true;
		} catch (e) {
			if (caught(e).code !== "EEXIST") throw e;
			const pid = Number(fs.readFileSync(lock, "utf8").trim());
			try {
				if (pid > 0) {
					process.kill(pid, 0);
					return false;
				}
			} catch {
				/* Its holder is gone. */
			}
			fs.rmSync(lock, { force: true });
		}
	}
	return false;
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
			...reviewIssues(tracker, "open", { withComments: true }),
			...reviewIssues(tracker, "closed", {
				withComments: true,
				more: ["--search", `closed:>=${since}`],
			}),
		];
	} catch (e) {
		writeFd(2, `could not list ${tracker}'s review issues (${errLine(e)}).\n`);
		return 1;
	}
	const pending = reviews.flatMap((i) => {
		const requests = reversal.pendingRequests(i.comments ?? []);
		return requests.length === 0 ? [] : [{ issue: i, requests }];
	});
	if (pending.length === 0) return 0;
	const lock = path.join(markersDir(hostRoot()), LOCK);
	if (!dryRun && !takeLock(lock)) {
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
		if (!dryRun) fs.rmSync(lock, { force: true });
	}
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean", "--reversals-only": "boolean" },
	});
	const tracker = io.trackerOrFail();
	const dryRun = flags["--dry-run"] === true;
	const filed = flags["--reversals-only"] ? 0 : fileReview(tracker, dryRun);
	process.exitCode = Math.max(filed, answerReversals(tracker, dryRun));
}

if (require.main === module) main();
