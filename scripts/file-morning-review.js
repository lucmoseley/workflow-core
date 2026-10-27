#!/usr/bin/env node
/*
 * file-morning-review.js — file the day's morning review issue (workflow-core#2011, spec
 * workflow-core#1995 §The morning review issue): the still-caught delegated decisions, the
 * clear ones counted, the closes since the previous review issue with every
 * one-way close listed, each repo's open stall ticket, the issues
 * `urgent` for over 7 days, and every open `parked` issue with its age.
 *
 *   node scripts/file-morning-review.js [--dry-run] [--reversals-only]
 *
 * Files on the tracker of the checkout it runs in — the loop runs it in
 * workflow-core's — and reads every repo lib/refill-repos.js includes: each
 * one's delegated-decision ledger, its issues closed in the window with
 * their comments, for the `**Door:**` line, its open stall ticket
 * (lib/stall-ticket.js, workflow-core#2692), its open `urgent` issues with each one's
 * timeline and pick-next's last run there (workflow-core#2693), and its open `parked`
 * issues with each one's timeline (workflow-core#2725), read only: it never writes or
 * removes either label. A repo it cannot read is named in the body, not
 * dropped silently.
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
 * MEMORY KILLS (workflow-core#3094): the machine's earlyoom kills in the window, by kind,
 * each incident with its ticket — read once from this machine's journal
 * (lib/earlyoom-kills.js), not per repo.
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

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { parseErrLine, gh, ghApiSlurp, ghIssueListAll } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { fileThrough } = require("./lib/file-through.js");
const { writeFd } = require("./lib/write-fd.js");
const { readLedger } = require("./lib/delegated-decision.js");
const kills = require("./lib/earlyoom-kills.js");
const review = require("./lib/morning-review.js");
const reversal = require("./lib/review-reversal.js");
const { markersDir } = require("./lib/marker-root.js");
const { discoverRepos, homeDir } = require("./lib/refill-repos.js");
const { labelAge } = require("./lib/label-age.js");
const { PARKED_LABEL } = require("./lib/parked.js");
const { readSnapshot, whyNotLaunched } = require("./lib/pick-next-snapshot.js");
const { STALL_TITLE } = require("./lib/stall-ticket.js");
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
const URGENT = "urgent";
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
function readReviewIssues(
	repo,
	state,
	{ withComments = false, more = [] } = {},
) {
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
		const stalls = readStalls(repo);
		const urgent = readUrgent(root, repo);
		const parked = readParked(repo);
		return {
			reading: {
				repo,
				entries: lines,
				closed,
				stalls: stalls.read,
				urgent: urgent.read,
				parked: parked.read,
			},
			unread: [
				...(torn === 0
					? []
					: [{ repo, why: `${torn} torn ledger line(s) skipped` }]),
				...stalls.unread,
				...urgent.unread,
				...parked.unread,
			],
		};
	} catch (e) {
		return {
			reading: null,
			unread: [{ repo, why: parseErrLine(e) || caught(e).message }],
		};
	}
}

/**
 * One tracker's open stall ticket (lib/stall-ticket.js, workflow-core#2692); a failed read
 * is unread, leaving the rest of the repo's reading standing.
 * @param {string} repo
 * @returns {{read: import("./lib/morning-review.js").OpenIssue[], unread: Unread[]}}
 */
function readStalls(repo) {
	try {
		const read = ghIssueListAll("stall tickets", [
			"--repo",
			repo,
			"--state",
			"open",
			"--search",
			`in:title "${STALL_TITLE}"`,
			"--json",
			"number,title",
		]).filter((/** @type {{title: string}} */ i) => i.title === STALL_TITLE);
		return { read, unread: [] };
	} catch (e) {
		return {
			read: [],
			unread: [
				{ repo, why: `stall tickets: ${parseErrLine(e) || caught(e).message}` },
			],
		};
	}
}

/**
 * The machine's earlyoom incidents with a kill since `since`, and each one's
 * ticket on `tracker` (scripts/file-memory-kill-tickets.js, workflow-core#3094).
 * @param {string} tracker
 * @param {string} since
 * @returns {import("./lib/morning-review.js").KillReading}
 */
function readKills(tracker, since) {
	const { incidents, why } = kills.readIncidents(Date.parse(since));
	if (why !== null || incidents.length === 0)
		return { incidents, tickets: new Map(), why };
	try {
		return { incidents, tickets: kills.readIncidentTickets(tracker), why };
	} catch (e) {
		return {
			incidents,
			tickets: parseErrLine(e) || caught(e).message,
			why,
		};
	}
}

/**
 * One checkout's open `urgent` issues, each with when its timeline last
 * records the label applied and why pick-next's last run there left it
 * unlaunched (workflow-core#2693). An issue whose application date will not read is
 * unread, never dropped or taken as fresh.
 * @param {string} root
 * @param {string} repo
 * @returns {{read: import("./lib/morning-review.js").UrgentIssue[], unread: Unread[]}}
 */
function readUrgent(root, repo) {
	const { snapshot, why } = readSnapshot(root, repo);
	/** @type {import("./lib/morning-review.js").UrgentIssue[]} */
	const read = [];
	/** @type {Unread[]} */
	const unread =
		why === null ? [] : [{ repo, why: `pick-next's last run: ${why}` }];
	const listed = openLabelled(repo, URGENT);
	if ("why" in listed) return { read, unread: [...unread, listed] };
	for (const { number, title } of listed.open) {
		const age = readLabelAgeOn(repo, number, URGENT);
		if (age.unknown)
			unread.push({ repo, why: `#${number}'s urgent age: ${age.error}` });
		else
			read.push({
				number,
				title,
				appliedAt: age.appliedAt,
				why: whyNotLaunched(snapshot, number),
			});
	}
	return { read, unread };
}

/**
 * One checkout's open `parked` issues, each with when its timeline last
 * records the label applied (workflow-core#2725). One whose start will not read is listed
 * with its age unknown, never dropped.
 * @param {string} repo
 * @returns {{read: import("./lib/morning-review.js").ParkedIssue[], unread: Unread[]}}
 */
function readParked(repo) {
	const listed = openLabelled(repo, PARKED_LABEL);
	if ("why" in listed) return { read: [], unread: [listed] };
	const read = listed.open.map(({ number, title }) => {
		const age = readLabelAgeOn(repo, number, PARKED_LABEL);
		return age.unknown
			? { number, title, appliedAt: null, ageError: String(age.error) }
			: { number, title, appliedAt: age.appliedAt };
	});
	return { read, unread: [] };
}

/**
 * One tracker's open issues carrying `label`, or why they did not read.
 * @param {string} repo
 * @param {string} label
 * @returns {{open: {number: number, title: string}[]} | Unread}
 */
function openLabelled(repo, label) {
	try {
		return {
			open: ghIssueListAll(`${label} issues`, [
				"--repo",
				repo,
				"--state",
				"open",
				"--label",
				label,
				"--json",
				"number,title",
			]),
		};
	} catch (e) {
		return {
			repo,
			why: `${label} issues: ${parseErrLine(e) || caught(e).message}`,
		};
	}
}

/**
 * `label`'s age on issue `number`, off its timeline.
 * @param {string} repo
 * @param {number} number
 * @param {string} label
 */
function readLabelAgeOn(repo, number, label) {
	/** @type {Parameters<typeof labelAge>[0]} */
	let timeline;
	try {
		timeline = {
			ok: true,
			events: ghApiSlurp([`repos/${repo}/issues/${number}/timeline`]),
		};
	} catch (e) {
		timeline = { ok: false, error: parseErrLine(e) || caught(e).message };
	}
	return labelAge(timeline, label);
}

/**
 * File today's review unless one carries today's date. The exit code.
 * @param {string} tracker
 * @param {boolean} dryRun
 */
function fileReview(tracker, dryRun) {
	const now = new Date();
	const title = review.buildReviewTitle(review.localDate(now));

	let reviews;
	try {
		reviews = readReviewIssues(tracker, "all");
	} catch (e) {
		writeFd(
			2,
			`could not list ${tracker}'s review issues (${parseErrLine(e)}). Nothing filed.\n`,
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
		kills: readKills(tracker, since),
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
