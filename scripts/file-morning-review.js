#!/usr/bin/env node
/*
 * file-morning-review.js — file the day's morning review issue (#2011, spec
 * #1995 §The morning review issue): the still-caught delegated decisions, the
 * clear ones counted, the closes since the previous review issue with every
 * one-way close listed, each repo's open stall ticket, the issues
 * `urgent` for over 7 days, and every open `parked` issue with its age.
 *
 *   node scripts/file-morning-review.js [--dry-run]
 *
 * Files on the tracker of the checkout it runs in — the loop runs it in
 * workflow-core's — and reads every repo lib/refill-repos.js includes: each
 * one's delegated-decision ledger, its issues closed in the window with
 * their comments, for the `**Door:**` line, its open stall ticket
 * (lib/stall-ticket.js, #2692), its open `urgent` issues with each one's
 * timeline and pick-next's last run there (#2693), and its open `parked`
 * issues with each one's timeline (#2725), read only: it never writes or
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
 * MEMORY KILLS (#3094): the machine's earlyoom kills in the window, by kind,
 * each incident with its ticket — read once from this machine's journal
 * (lib/earlyoom-kills.js), not per repo.
 *
 * PRIMITIVES (#3465): each repo's check-primitives.js count line, and every
 * commit on its HEAD touching either standards file, with the file's text
 * either side, which
 * lib/morning-review.js diffs into row changes.
 *
 * CONCURRENCY (#3321): the 24-hour and 7-day readouts of lib/concurrency.js,
 * the core `npm run status` renders from, over the refill loop's tick record
 * and memwatch's minute record.
 *
 * IDLE EFFORTS (#3644, spec #3623): check-idle-efforts.js's `--json`
 * findings, which lib/morning-review.js renders through the lines
 * `npm run status` prints. A plain run, so it spends no session-start stamp.
 *
 * REVERSALS (#3388): after filing, it answers each unanswered `reverse <n>`
 * through scripts/answer-review-reversals.js (#2017), so a hand run while the
 * loop is stopped answers them too. `--dry-run` passes to both.
 *
 * Joins no §N3 family: it files an issue as `report-*` does, but a run whose
 * filing failed on gh exits 1, and one file-issue.js refused exits
 * with its code, so the loop that runs it can tell a filing from a failure.
 * The exit code is the worse of the filing's and the answering's.
 *
 * Caller: the refill loop, on its first tick after 07:00
 * (lib/refill-tick.js).
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { answerReversals } = require("./answer-review-reversals.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { parseErrLine, ghApiSlurp, ghIssueListAll } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { parseEnvelope } = require("./lib/check-envelope.js");
const { execGit } = require("./lib/git.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { STANDARDS_DOCS } = require("./lib/primitives-table.js");
const { coreRoot } = require("./lib/script-path.js");
const { fileThrough } = require("./lib/file-through.js");
const { writeFd } = require("./lib/write-fd.js");
const { readLedger } = require("./lib/delegated-decision.js");
const concurrency = require("./lib/concurrency.js");
const kills = require("./lib/earlyoom-kills.js");
const review = require("./lib/morning-review.js");
const { discoverRepos, homeDir } = require("./lib/refill-repos.js");
const { labelAge } = require("./lib/label-age.js");
const { PARKED_LABEL } = require("./lib/parked.js");
const { readSnapshot, whyNotLaunched } = require("./lib/pick-next-snapshot.js");
const { STALL_TITLE } = require("./lib/stall-ticket.js");
const { scriptIo } = require("./lib/tracker-ops.js");
const { requireKey } = require("./lib/workflow-core-config.js");
const { REVIEW_LABEL, readReviewIssues } = require("./lib/review-issues.js");

const USAGE = "usage: node scripts/file-morning-review.js [--dry-run]";
const DAY_MS = 24 * 60 * 60 * 1000;
const URGENT = "urgent";
/* Untraced: the count line runs every enforcing check over the whole tree. */
const COUNT_TIMEOUT_MS = 5 * 60 * 1000;
/* The session-start hook's own 60 s: one paged GraphQL read per tracker, run
 * side by side, measured 10 s across six trackers on 29 Oct (#3644). */
const IDLE_TIMEOUT_MS = 60 * 1000;

const io = scriptIo("file-morning-review");

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
		const primitives = readPrimitives(root, since);
		return {
			reading: {
				repo,
				entries: lines,
				closed,
				stalls: stalls.read,
				urgent: urgent.read,
				parked: parked.read,
				primitives,
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
			unread: [{ repo, why: parseErrLine(e) }],
		};
	}
}

/**
 * @param {string} root
 * @param {string} since
 * @returns {import("./lib/morning-review.js").PrimitivesReading}
 */
function readPrimitives(root, since) {
	return { count: readCountLine(root), history: readTableHistory(root, since) };
}

/**
 * @param {string} root
 * @returns {import("./lib/morning-review.js").PrimitivesReading["count"]}
 */
function readCountLine(root) {
	const read = readEnvelope(
		"check-primitives.js",
		["--root", root],
		COUNT_TIMEOUT_MS,
		root,
	);
	if ("why" in read) return read;
	return typeof read.envelope.countLine === "string"
		? { line: read.envelope.countLine }
		: { why: read.missing };
}

/**
 * A core checker's `--json` envelope, or why it gave none.
 * @param {string} script
 * @param {string[]} args
 * @param {number} timeout ms
 * @param {string} [cwd]
 * @returns {{envelope: Record<string, any>, missing: string} | {why: string}}
 *   `missing` is the `why` to give where the envelope lacks a field wanted
 */
function readEnvelope(script, args, timeout, cwd) {
	const r = spawnSync(
		process.execPath,
		[path.join(coreRoot(), "scripts", script), "--json", ...args],
		{
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout,
			maxBuffer: CHILD_MAX_BUFFER,
		},
	);
	if (r.error) return { why: `${script}: ${r.error.message}` };
	const envelope = parseEnvelope(r.stdout ?? "");
	const missing = `${script}: ${envelope?.summary ?? `no --json envelope (exit ${r.status})`}`;
	return envelope === null ? { why: missing } : { envelope, missing };
}

/* A `git log` line: full sha, short sha, commit time, then the parents. */
const LOG_LINE = /^([0-9a-f]+) ([0-9a-f]+) (\S+) ?([0-9a-f]*)/;

/**
 * An adopter's history holds no base file, so its base log is empty. A git
 * failure is the history's `why`, never read as an absent file (base §N5).
 * @param {string} root
 * @param {string} since
 * @returns {import("./lib/morning-review.js").PrimitivesReading["history"]}
 */
function readTableHistory(root, since) {
	/** @param {string[]} args */
	const git = (args) =>
		String(
			execGit(args, {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
	/** The file's text at `rev`, null where the tree there holds none.
	 * @param {string} rev @param {string} file */
	const textAt = (rev, file) =>
		git(["ls-tree", "--name-only", rev, "--", file]).trim() === ""
			? null
			: git(["show", `${rev}:${file}`]);
	/** @type {import("./lib/morning-review.js").TableCommit[]} */
	const commits = [];
	try {
		for (const side of /** @type {const} */ (["base", "local"])) {
			const file = STANDARDS_DOCS[side];
			const log = git([
				"log",
				"--reverse",
				"--format=%H %h %cI %P",
				`--since=${since}`,
				"HEAD",
				"--",
				file,
			]);
			for (const line of log.split("\n").filter(Boolean)) {
				const m = LOG_LINE.exec(line);
				if (!m) throw new Error(`unreadable log line: ${line}`);
				const parent = m[4];
				commits.push({
					sha: requiredGroup(m, 2, LOG_LINE),
					at: requiredGroup(m, 3, LOG_LINE),
					side,
					before: parent ? textAt(parent, file) : null,
					after: textAt(requiredGroup(m, 1, LOG_LINE), file),
				});
			}
		}
	} catch (e) {
		return { why: `git: ${parseErrLine(e)}` };
	}
	return { commits };
}

/**
 * One tracker's open stall ticket (lib/stall-ticket.js, #2692); a failed read
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
			unread: [{ repo, why: `stall tickets: ${parseErrLine(e)}` }],
		};
	}
}

/**
 * The machine's earlyoom incidents with a kill since `since`, and each one's
 * ticket on `tracker` (scripts/file-memory-kill-tickets.js, #3094).
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
			tickets: parseErrLine(e),
			why,
		};
	}
}

/**
 * The concurrency readouts over each review window ending `now`.
 * @param {number} now
 * @returns {import("./lib/morning-review.js").ConcurrencyReading}
 */
function readConcurrency(now) {
	const records = concurrency.readRecords();
	const { day, week } = review.CONCURRENCY_WINDOWS;
	return {
		day: concurrency.readout({ ...records, now, windowMs: day.ms }),
		week: concurrency.readout({ ...records, now, windowMs: week.ms }),
	};
}

/** @returns {import("./lib/morning-review.js").IdleReading} */
function readIdle() {
	const read = readEnvelope("check-idle-efforts.js", [], IDLE_TIMEOUT_MS);
	if ("why" in read) return read;
	const { trackers, loopRunning } = read.envelope;
	return Array.isArray(trackers) && typeof loopRunning === "boolean"
		? { trackers, loopRunning }
		: { why: read.missing };
}

/**
 * One checkout's open `urgent` issues, each with when its timeline last
 * records the label applied and why pick-next's last run there left it
 * unlaunched (#2693). An issue whose application date will not read is
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
	const listed = readOpenLabelled(repo, URGENT);
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
 * records the label applied (#2725). One whose start will not read is listed
 * with its age unknown, never dropped.
 * @param {string} repo
 * @returns {{read: import("./lib/morning-review.js").ParkedIssue[], unread: Unread[]}}
 */
function readParked(repo) {
	const listed = readOpenLabelled(repo, PARKED_LABEL);
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
function readOpenLabelled(repo, label) {
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
			why: `${label} issues: ${parseErrLine(e)}`,
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
		timeline = { ok: false, error: parseErrLine(e) };
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
		concurrency: readConcurrency(now.getTime()),
		idle: readIdle(),
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
			REVIEW_LABEL,
			"--standalone",
			"the day's away-mode review, outside every map (#1995)",
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

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const tracker = io.trackerOrFail();
	const dryRun = flags["--dry-run"] === true;
	/* A filing that throws still answers before the throw ends the run. */
	let filed = 1;
	try {
		filed = fileReview(tracker, dryRun);
	} finally {
		process.exitCode = Math.max(filed, answerReversals(tracker, dryRun));
	}
}

if (require.main === module) main();
