#!/usr/bin/env node
/*
 * file-morning-review.js — file the day's morning review issue (workflow-core#2011, spec
 * workflow-core#1995 §The morning review issue): the still-caught delegated decisions, the
 * clear ones counted, the closes since the previous review issue with every
 * one-way close listed, each repo's open stall ticket and off-machine queue
 * alarms firing (lib/queue-alarms.js, workflow-core#4772), the issues
 * `urgent` for over 7 days, and every open `parked` issue with its age.
 *
 *   node scripts/file-morning-review.js [--dry-run]
 *
 * Files on the tracker of the checkout it runs in — the loop runs it in
 * workflow-core's — and reads every repo lib/refill-repos.js includes: each
 * one's delegated-decision ledger, its closes (a span 15 minutes behind the
 * window, lib/morning-review.js's CLOSE_SETTLE_MS) with their comments, for the `**Door:**` line, its open stall ticket
 * (lib/stall-ticket.js, workflow-core#2692), its open `urgent` issues with each one's
 * timeline and pick-next's last run there (workflow-core#2693), and its open `parked`
 * issues with each one's timeline (workflow-core#2725), read only: it never writes or
 * removes either label. A repo it cannot read is named in the body, not
 * dropped silently.
 *
 * ONCE A DAY: a review issue titled with today's machine-local date, open or
 * closed, files nothing — a hand run after the founder closed today's would
 * otherwise file a second. A filing holds a machine-wide lock (workflow-core#3813) from
 * before that look until its issue exists, so a hand run and the loop's run
 * cannot both pass it. The one that finds the lock held files nothing and exits 1, so the
 * loop's next tick retries in case the holder fails.
 *
 * WINDOW (workflow-core#3813): `since` is where the previous review's window ended, off its
 * body, and `now` is fixed before this run's reads, so no event falls between two
 * reviews however long a filing runs (lib/morning-review.js's windowStart). That
 * file's header gives each source's edge for an event readable after this run's
 * reads (workflow-core#3827). A repo that does not read, or whose config discovery will not
 * read (workflow-core#3834), is named in the body with where its events went unread from, and
 * the next review starts that repo there (workflow-core#3831). So is one carrying such a line
 * that discovery no longer lists, its `.git` or config missing; the review that
 * finds its directory gone, or its start over 30 days old, names what that gives
 * up and ends the line (workflow-core#3835). A checkout the previous review read counts as one
 * carrying a line from its window's end, so its first absence loses nothing (workflow-core#3844).
 * Closes that will not read on a second try, or a ledger that will not, cost and
 * carry that kind alone (workflow-core#3928).
 * Residual: one its owner opted out is neither named nor carried, so a start it
 * carried ends there (workflow-core#3834). A linked worktree likewise (workflow-core#3835).
 *
 * Files through file-issue.js, so the `takes:` and known-label refusals bind
 * this script as they bind a session: no hook sees a gh call a script makes.
 * ONCE A DAY above already rules out a second review, so it names the open
 * earlier reviews `--distinct-from` up front: while the founder is away they
 * stay open and would refuse every filing. Refused for any other lookalike,
 * such as the away-mode spec, it re-runs naming that too, as
 * check-orphaned-edits.js does.
 *
 * MEMORY KILLS (workflow-core#3094): the machine's earlyoom kills in the window, by kind,
 * each incident with its ticket — read once from this machine's journal
 * (lib/earlyoom-kills.js), not per repo.
 *
 * PROCESS RUNAWAYS (workflow-core#3807): memwatch's firings in the window, each episode with
 * what it killed and its ticket, read once from this machine's log
 * (lib/process-runaways.js).
 *
 * PRIMITIVES (workflow-core#3465): each repo's check-primitives.js count line, and every
 * commit on its default branch since the last review's read touching either
 * standards file, with the file's text
 * either side, which
 * lib/morning-review.js diffs into row changes.
 *
 * CONCURRENCY (workflow-core#3321): the 24-hour and 7-day readouts of lib/concurrency.js,
 * the core `npm run status` renders from, over the refill loop's tick record
 * and memwatch's minute record.
 *
 * IDLE EFFORTS (workflow-core#3644, spec workflow-core#3623): check-idle-efforts.js's `--json`
 * findings, which lib/morning-review.js renders through the lines
 * `npm run status` prints. A plain run, so it spends no session-start stamp.
 *
 * WSL CURRENCY (workflow-core#4082): check-wsl-currency.js's `--json` lines, in a section of
 * its own, and none where the checker SKIPs: not WSL.
 * Both machine-wide checkers start before the repo reads and run beside them
 * (workflow-core#4601).
 *
 * KEPT READS (workflow-core#3765): each repo's count line and each label age, once read,
 * are kept for the day (lib/review-reads.js), so a run killed part way
 * resumes from them. `--dry-run` neither takes nor keeps them (workflow-core#3813).
 *
 * REVERSALS (workflow-core#3388): after filing, it answers each unanswered `reverse <n>`
 * through scripts/answer-review-reversals.js (workflow-core#2017), so a hand run while the
 * loop is stopped answers them too. `--dry-run` passes to both.
 *
 * REPO HOLDS (workflow-core#3865): each served checkout's open holds, in a section of their
 * own only where one is open. Read apart from readRepo, so a tracker outage, when
 * a hold is likeliest, costs none of them.
 *
 * Joins no §N3 family: it files an issue as `report-*` does, but a run whose
 * filing failed on gh or found the filing lock held exits 1, and one file-issue.js refused exits
 * with its code, so the loop that runs it can tell a filing from a failure.
 * The exit code is the worse of the filing's and the answering's.
 */

const { execFile, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { answerReversals } = require("./answer-review-reversals.js");
const { parseOrExit } = require("./lib/cli-args.js");
const {
	parseErrLine,
	ghApiSlurp,
	ghIssueListAll,
	retryingOnceSync,
} = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { parseEnvelope } = require("./lib/check-envelope.js");
const { caught } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { STANDARDS_DOCS } = require("./lib/primitives-table.js");
const { coreRoot, scriptPath } = require("./lib/script-path.js");
const { fileThrough } = require("./lib/file-through.js");
const { buildScriptFilerArgv } = require("./lib/script-filer-argv.js");
const { writeFd } = require("./lib/write-fd.js");
const { readLedger } = require("./lib/delegated-decision.js");
const concurrency = require("./lib/concurrency.js");
const kills = require("./lib/earlyoom-kills.js");
const runaways = require("./lib/process-runaways.js");
const { localDate } = require("./lib/local-date.js");
const review = require("./lib/morning-review.js");
const carry = require("./lib/review-carry.js");
const {
	readAbsence,
	discoverRepos,
	homeDir,
} = require("./lib/refill-repos.js");
const { labelAge } = require("./lib/label-age.js");
const { PARKED_LABEL } = require("./lib/parked.js");
const { readSnapshot, whyNotLaunched } = require("./lib/pick-next-snapshot.js");
const { readFiringAlarms } = require("./lib/queue-alarms.js");
const { STALL_TITLE } = require("./lib/queue-tickets.js");
const { scriptIo } = require("./lib/tracker-ops.js");
const { buildAgeText } = require("./lib/hold-age.js");
const { buildNoticeText, readHolds } = require("./lib/repo-holds.js");
const { requireKey } = require("./lib/workflow-core-config.js");
const { pidLock } = require("./lib/pid-lock.js");
const { refillPath } = require("./lib/refill-dir.js");
const { readControlFile } = require("./lib/refill-files.js");
const { REVIEW_LABEL, readReviewIssues } = require("./lib/review-issues.js");
const { freshReads, reviewReads } = require("./lib/review-reads.js");
const { URGENT_LABEL } = require("./lib/urgent-label.js");

const USAGE = `usage: node ${scriptPath("file-morning-review.js")} [--dry-run]`;
const FILING_LOCK = ".morning-review-filing.pid";
/* Untraced: the count line runs every enforcing check over the whole tree. */
const COUNT_TIMEOUT_MS = 5 * 60 * 1000;
/* One paged GraphQL read per tracker, run side by side. Measured on 1 Nov
 * across six trackers: 10-16 s in six runs, 71 s in another. 2.5x that worst
 * run, the multiplier a guess (workflow-core#3771), and well inside refill-review-run.js's
 * REVIEW_TIMEOUT_MS. */
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/** Above the check's own worst case, 196 s: wsl.exe's 3 tries at 12 s, two gh reads at 80 s. */
const WSL_CURRENCY_TIMEOUT_MS = 4 * 60 * 1000;

const io = scriptIo("file-morning-review");

/** @typedef {import("./lib/morning-review.js").Unread} Unread */
/** @typedef {Pick<ReturnType<typeof reviewReads>, "read">} Reads */

/**
 * The review's part for a checkout whose config discovery would not read.
 * @param {{root: string, why: string}} faulted
 * @param {string} windowSince
 * @param {{number: number, body: string}[]} reviews newest first
 */
function buildFaultedRepo({ root, why }, windowSince, reviews) {
	const checkout = path.basename(root);
	const start = carry.buildRepoStart(reviews[0], checkout, windowSince);
	/* A JSON error quotes the config, newlines and all. */
	const [line = ""] = why.split("\n");
	return carry.buildUnreadRepo(checkout, start, checkout, line);
}

/**
 * One included checkout's ledger and closes, and what of it could not be read.
 * @param {string} root
 * @param {string} windowSince
 * @param {Reads} reads
 * @param {{number: number, body: string}[]} reviews newest first
 * @returns {import("./lib/review-carry.js").RepoRead}
 */
function readRepo(root, windowSince, reads, reviews) {
	const checkout = path.basename(root);
	const start = carry.buildRepoStart(reviews[0], checkout, windowSince);
	let repo = checkout;
	try {
		repo = requireKey("tracker", { root });
		const ledger = readDecisions(root, repo);
		const closes = readCloses(repo, start.closes);
		const stalls = readStalls(repo);
		const alarms = readAlarms(root, repo);
		const urgent = readUrgent(root, repo, reads);
		const parked = readParked(repo, reads);
		const primitives = readPrimitives(
			root,
			carry.buildHistoryStart(start),
			reads,
			review.parseHistoryCursor(reviews, repo),
		);
		return {
			reading: {
				checkout,
				repo,
				closesSince: start.closes,
				decisionsSince: start.decisions,
				entries: ledger.entries,
				closed: closes.closed,
				stalls: stalls.read,
				alarms: alarms.read,
				urgent: urgent.read,
				parked: parked.read,
				primitives,
			},
			unread: [
				...carry.buildStartFaults(checkout, start),
				...ledger.unread,
				...closes.unread,
				...stalls.unread,
				...alarms.unread,
				...urgent.unread,
				...parked.unread,
			],
			unreadEvents: carry.buildCarryLines(checkout, start, {
				closes: closes.closed === null,
				decisions: ledger.entries === null,
			}),
		};
	} catch (e) {
		return carry.buildUnreadRepo(checkout, start, repo, parseErrLine(e));
	}
}

/**
 * A checkout's ledger, or null where it will not read, which is named and
 * carried (workflow-core#3928). Torn lines are named and lost.
 * @param {string} root
 * @param {string} repo
 * @returns {{entries: import("./lib/morning-review.js").LedgerLine[] | null, unread: Unread[]}}
 */
function readDecisions(root, repo) {
	try {
		const { lines, torn } = readLedger(root);
		return {
			entries: lines,
			unread:
				torn === 0
					? []
					: [{ repo, why: `${torn} torn ledger line(s) skipped` }],
		};
	} catch (e) {
		return {
			entries: null,
			unread: [{ repo, why: `ledger: ${parseErrLine(e)}` }],
		};
	}
}

/**
 * One tracker's closes from `since`, with their comments, or null named as unread
 * where a second try fails too (workflow-core#3928).
 * @param {string} repo
 * @param {string} since
 * @returns {{closed: import("./lib/morning-review.js").ClosedIssue[] | null, unread: Unread[]}}
 */
function readCloses(repo, since) {
	const read = retryingOnceSync(() =>
		ghIssueListAll("closed issues", [
			"--repo",
			repo,
			"--state",
			"closed",
			"--search",
			`closed:>=${review.searchTime(review.closeEdge(since))}`,
			"--json",
			"number,title,url,closedAt,comments",
		]),
	);
	return read.ok
		? { closed: read.out, unread: [] }
		: { closed: null, unread: [{ repo, why: `closes: ${read.error}` }] };
}

/**
 * @param {string} root
 * @param {string} since
 * @param {Reads} reads
 * @param {string | null} cursor the commit an earlier review read to
 * @returns {import("./lib/morning-review.js").PrimitivesReading}
 */
function readPrimitives(root, since, reads, cursor) {
	return {
		count: reads.read(
			`count-line ${root}`,
			() => readCountLine(root),
			(count) => "line" in count,
		),
		history: readTableHistory(root, since, cursor),
	};
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
	return judgeEnvelope(
		script,
		spawnSync(process.execPath, buildCheckerArgv(script, args), {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout,
			maxBuffer: CHILD_MAX_BUFFER,
		}),
	);
}

/**
 * A checker started now and left running. Its bound starts at `settle`, not at the start: those reads block
 * the event loop, so a timer started with the child would fire on a checker
 * that finished long since, before its output was read. `stop` kills it,
 * for a caller that throws before settling.
 * @param {string} script
 */
function startEnvelope(script) {
	const stop = new AbortController();
	/** @type {NodeJS.Timeout | undefined} */
	let bound;
	/** @type {number} */
	let timeout = 0;
	let ended = false;
	/** @type {Promise<{envelope: Record<string, any>, missing: string} | {why: string}>} */
	const answer = new Promise((resolve) => {
		const child = execFile(
			process.execPath,
			buildCheckerArgv(script, []),
			{ encoding: "utf8", maxBuffer: CHILD_MAX_BUFFER, signal: stop.signal },
			(error, stdout) => {
				ended = true;
				clearTimeout(bound);
				resolve(
					judgeEnvelope(script, {
						error: whyStartFailed(error, timeout),
						stdout,
						status: child.exitCode,
					}),
				);
			},
		);
		child.stdin?.end();
	});
	return {
		/** @param {number} ms */
		settle(ms) {
			timeout = ms;
			if (!ended) bound = setTimeout(() => stop.abort(), ms);
			return answer;
		},
		stop: () => stop.abort(),
	};
}

/**
 * What failed where execFile reports an error, or undefined where the error
 * is only a non-zero exit: that is the checker's verdict.
 * @param {import("node:child_process").ExecFileException | null} error
 * @param {number} timeout ms, the bound `settle` set
 */
function whyStartFailed(error, timeout) {
	if (!error || typeof error.code === "number") return;
	if (error.name === "AbortError")
		return new Error(`killed at its ${timeout} ms bound`);
	if (error.signal) return new Error(`killed by ${error.signal}`);
	return error;
}

/**
 * @param {string} script
 * @param {string[]} args
 */
const buildCheckerArgv = (script, args) => [
	path.join(coreRoot(), "scripts", script),
	"--json",
	...args,
];

/**
 * @param {string} script
 * @param {{error?: Error | null, stdout?: string | null, status: number | null}} r
 * @returns {{envelope: Record<string, any>, missing: string} | {why: string}}
 */
function judgeEnvelope(script, r) {
	if (r.error) return { why: `${script}: ${r.error.message}` };
	const envelope = parseEnvelope(r.stdout ?? "");
	const missing = `${script}: ${envelope?.summary ?? `no --json envelope (exit ${r.status})`}`;
	return envelope === null ? { why: missing } : { envelope, missing };
}

/* A `git log` line: full sha, short sha, then the parents. */
const LOG_LINE = /^([0-9a-f]+) ([0-9a-f]+) ?([0-9a-f]*)/;

/**
 * The table commits that reached the default branch since `cursor`, however old
 * their stamps, whichever branch is checked out; HEAD's where the checkout names
 * no default. With no cursor on it, the commits stamped since `since`, saying
 * why. An adopter's history holds no base file, so its base log is empty. A git
 * failure is the history's `why`, never read as an absent file (base §N5).
 * @param {string} root
 * @param {string} since
 * @param {string | null} cursor
 * @returns {import("./lib/morning-review.js").PrimitivesReading["history"]}
 */
function readTableHistory(root, since, cursor) {
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
	/* A "no" from git, against a fault: exit 1, or a commit the repo no longer
	 * holds, which merge-base exits 128 on (workflow-core#3827). */
	/** @param {string[]} args */
	const gitAnswer = (args) => {
		try {
			return git(args);
		} catch (e) {
			const { status, stderr } = caught(e);
			if (status === 1 || /not a valid/i.test(stderr ?? "")) return null;
			throw e;
		}
	};
	/** @type {import("./lib/morning-review.js").TableCommit[]} */
	const commits = [];
	try {
		const remoteHead = gitAnswer([
			"symbolic-ref",
			"--short",
			"-q",
			"refs/remotes/origin/HEAD",
		]);
		const branch = remoteHead?.trim().replace(/^origin\//, "") ?? "HEAD";
		const tip = git(["rev-parse", branch]).trim();
		const why = review.whyByTime(
			cursor,
			cursor !== null &&
				gitAnswer(["merge-base", "--is-ancestor", cursor, tip]) !== null,
		);
		const range =
			why === null ? [`${cursor}..${tip}`] : [`--since=${since}`, tip];
		for (const side of /** @type {const} */ (["base", "local"])) {
			const file = STANDARDS_DOCS[side];
			const log = git([
				"log",
				"--reverse",
				"--format=%H %h %P",
				...range,
				"--",
				file,
			]);
			for (const line of log.split("\n").filter(Boolean)) {
				const m = LOG_LINE.exec(line);
				if (!m) throw new Error(`unreadable log line: ${line}`);
				const parent = m[3];
				commits.push({
					sha: requiredGroup(m, 2, LOG_LINE),
					side,
					before: parent ? textAt(parent, file) : null,
					after: textAt(requiredGroup(m, 1, LOG_LINE), file),
				});
			}
		}
		return { commits, tip, whyByTime: why };
	} catch (e) {
		return { why: `git: ${parseErrLine(e)}` };
	}
}

/**
 * The checkouts whose holds the review lists: discovery's, and the loop's
 * ticked repos.
 * @param {string[]} included
 * @returns {string[]}
 */
function readHoldRoots(included) {
	const scope = readControlFile((line) => writeFd(2, `${line}\n`))?.scope;
	return [...new Set([...included, ...(scope?.repos ?? [])])];
}

/**
 * One checkout's open repo holds, off its local store. What will not read is
 * named in the review and stops nothing else (workflow-core#3865).
 * @param {string} root
 * @param {number} now
 * @returns {{read: import("./lib/morning-review.js").OpenHold[], unread: Unread[]}}
 */
function readOpenHolds(root, now) {
	const checkout = path.basename(root);
	const tracker = readHoldTracker(root);
	const repo = tracker ?? checkout;
	try {
		const { holds, unread } = readHolds(root);
		return {
			read: holds.map(({ act, issue, kind, raisedAt, sessions, notice }) => ({
				checkout,
				repo: tracker,
				act,
				issue,
				kind,
				age: buildAgeText(now - raisedAt),
				attached: sessions.length,
				notice: buildNoticeText(notice),
			})),
			unread: unread.map((why) => ({
				repo,
				why: `repo holds: ${why}`,
			})),
		};
	} catch (e) {
		return {
			read: [],
			unread: [{ repo, why: `repo holds: ${parseErrLine(e)}` }],
		};
	}
}

/**
 * The checkout's tracker, or null: one read off a broken origin, which a probe
 * hold reports, costs its holds only their issue's repo name (workflow-core#3865).
 * @param {string} root
 */
function readHoldTracker(root) {
	try {
		return requireKey("tracker", { root });
	} catch {
		return null;
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
			unread: [{ repo, why: `stall tickets: ${parseErrLine(e)}` }],
		};
	}
}

/**
 * The checkout's off-machine queue alarms firing (lib/queue-alarms.js,
 * workflow-core#4772); a failed read is unread, as readStalls'.
 * @param {string} root
 * @param {string} repo
 * @returns {{read: import("./lib/queue-alarms.js").FiringAlarm[], unread: Unread[]}}
 */
function readAlarms(root, repo) {
	try {
		return { read: readFiringAlarms(root).alarms, unread: [] };
	} catch (e) {
		return {
			read: [],
			unread: [{ repo, why: `queue alarms: ${parseErrLine(e)}` }],
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
			tickets: parseErrLine(e),
			why,
		};
	}
}

/**
 * The machine's process-runaway episodes with a firing since `since`, and each
 * one's ticket on `tracker` (scripts/file-process-runaway-tickets.js, workflow-core#3807).
 * @param {string} tracker
 * @param {string} since
 * @returns {import("./lib/morning-review.js").RunawayReading}
 */
function readRunaways(tracker, since) {
	const { episodes, why } = runaways.readEpisodes(Date.parse(since));
	if (why !== null || episodes.length === 0)
		return { episodes, tickets: new Map(), why };
	try {
		return { episodes, tickets: runaways.readEpisodeTickets(tracker), why };
	} catch (e) {
		return { episodes, tickets: parseErrLine(e), why };
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

/**
 * @param {ReturnType<typeof startEnvelope>} started
 * @returns {Promise<import("./lib/morning-review.js").IdleReading>}
 */
async function readIdle(started) {
	const read = await started.settle(IDLE_TIMEOUT_MS);
	if ("why" in read) return read;
	const { trackers, loopRunning, damaged } = read.envelope;
	return Array.isArray(trackers) &&
		typeof loopRunning === "boolean" &&
		Array.isArray(damaged)
		? { trackers, loopRunning, damaged }
		: { why: read.missing };
}

/**
 * @param {ReturnType<typeof startEnvelope>} started
 * @returns {Promise<import("./lib/morning-review.js").WslCurrencyReading>}
 */
async function readWslCurrency(started) {
	const read = await started.settle(WSL_CURRENCY_TIMEOUT_MS);
	if ("why" in read) return read;
	if (read.envelope.outcome === "SKIP") return null;
	return Array.isArray(read.envelope.lines)
		? { lines: read.envelope.lines }
		: { why: read.missing };
}

/**
 * One checkout's open `urgent` issues, each with when its timeline last
 * records the label applied and why pick-next's last run there left it
 * unlaunched (workflow-core#2693). One whose timeline records no application is aged from
 * its creation, an upper bound (workflow-core#3760); one whose timeline will not read is
 * unread, never dropped or taken as fresh. Residual: an old issue made urgent
 * yesterday by a route the timeline does not record lists as stuck.
 * @param {string} root
 * @param {string} repo
 * @param {Reads} reads
 * @returns {{read: import("./lib/morning-review.js").UrgentIssue[], unread: Unread[]}}
 */
function readUrgent(root, repo, reads) {
	const { snapshot, why } = readSnapshot(root, repo);
	/** @type {import("./lib/morning-review.js").UrgentIssue[]} */
	const read = [];
	/** @type {Unread[]} */
	const unread =
		why === null ? [] : [{ repo, why: `pick-next's last run: ${why}` }];
	const listed = readOpenLabelled(repo, URGENT_LABEL);
	if ("why" in listed) return { read, unread: [...unread, listed] };
	for (const { number, title, createdAt } of listed.open) {
		const age = readLabelAgeOn(repo, number, URGENT_LABEL, reads);
		const unlaunched = { number, title, why: whyNotLaunched(snapshot, number) };
		if (!age.unknown)
			read.push({
				...unlaunched,
				appliedAt: age.appliedAt,
				agedFromCreation: false,
			});
		else if (age.unrecorded)
			read.push({
				...unlaunched,
				appliedAt: createdAt,
				agedFromCreation: true,
			});
		else unread.push({ repo, why: `#${number}'s urgent age: ${age.error}` });
	}
	return { read, unread };
}

/**
 * One checkout's open `parked` issues, each with when its timeline last
 * records the label applied (workflow-core#2725). One whose start will not read is listed
 * with its age unknown, never dropped.
 * @param {string} repo
 * @param {Reads} reads
 * @returns {{read: import("./lib/morning-review.js").ParkedIssue[], unread: Unread[]}}
 */
function readParked(repo, reads) {
	const listed = readOpenLabelled(repo, PARKED_LABEL);
	if ("why" in listed) return { read: [], unread: [listed] };
	const read = listed.open.map(({ number, title }) => {
		const age = readLabelAgeOn(repo, number, PARKED_LABEL, reads);
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
 * @returns {{open: {number: number, title: string, createdAt: string}[]} | Unread}
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
				"number,title,createdAt",
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
 * `label`'s age on issue `number`, off its timeline, kept for the day once read.
 * @param {string} repo
 * @param {number} number
 * @param {string} label
 * @param {Reads} reads
 */
function readLabelAgeOn(repo, number, label, reads) {
	return reads.read(
		`label-age ${repo}#${number} ${label}`,
		() => readTimelineAge(repo, number, label),
		(age) => !age.unknown,
	);
}

/**
 * @param {string} repo
 * @param {number} number
 * @param {string} label
 */
function readTimelineAge(repo, number, label) {
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
 * File today's review unless one carries today's date or another run is filing
 * it. A dry run files nothing, so it takes no lock. The exit code.
 * @param {string} tracker
 * @param {boolean} dryRun
 */
async function fileReview(tracker, dryRun) {
	if (dryRun) return fileUnlessFiledToday(tracker, true);
	const file = refillPath(FILING_LOCK);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = pidLock(file, path.basename(__filename));
	if (!lock.acquire()) {
		writeFd(
			2,
			`another run is filing today's review (pid ${lock.holder()}). Nothing filed: re-run once it ends.\n`,
		);
		return 1;
	}
	try {
		return await fileUnlessFiledToday(tracker, false);
	} finally {
		lock.release();
	}
}

/**
 * @param {{tracker: string, since: string, why: string | null, now: Date,
 *   previous: any, reviews: any[], dryRun: boolean,
 *   idle: ReturnType<typeof startEnvelope>,
 *   wslCurrency: ReturnType<typeof startEnvelope>}} at
 */
async function renderWindow({
	tracker,
	since,
	why,
	now,
	previous,
	reviews,
	dryRun,
	idle,
	wslCurrency,
}) {
	const reads = dryRun ? freshReads() : reviewReads(localDate(now));
	const home = homeDir();
	const { included, faulted } = discoverRepos(home);
	const read = [
		...included.map((root) => readRepo(root, since, reads, reviews)),
		...faulted.map((f) => buildFaultedRepo(f, since, reviews)),
		...carry.buildAbsentRepos({
			previous,
			listed: new Set(
				[...included, ...faulted.map((f) => f.root)].map((root) =>
					path.basename(root),
				),
			),
			since,
			nowMs: now.getTime(),
			readAbsence: (/** @type {string} */ checkout) =>
				readAbsence(path.join(home, checkout)),
		}),
	];
	const holds = readHoldRoots(included).map((root) =>
		readOpenHolds(root, now.getTime()),
	);
	return review.renderReview({
		since,
		now: now.toISOString(),
		previous: previous?.number ?? null,
		repos: read.flatMap((r) => (r.reading ? [r.reading] : [])),
		failed: [
			...(why === null ? [] : [{ repo: tracker, why }]),
			...read.flatMap((r) => r.unread),
			...holds.flatMap((h) => h.unread),
		],
		unreadEvents: read.flatMap((r) => r.unreadEvents),
		holds: holds.flatMap((h) => h.read),
		kills: readKills(tracker, since),
		runaways: readRunaways(tracker, since),
		concurrency: readConcurrency(now.getTime()),
		idle: await readIdle(idle),
		wslCurrency: await readWslCurrency(wslCurrency),
	});
}

/**
 * Read the window and file its review, unless one carries today's date. The
 * exit code.
 * @param {string} tracker
 * @param {boolean} dryRun
 * @returns {Promise<number>}
 */
async function fileUnlessFiledToday(tracker, dryRun) {
	const now = new Date();
	const title = review.buildReviewTitle(localDate(now));

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
	const { since, why } = review.windowStart(previous, now);
	const idle = startEnvelope("check-idle-efforts.js");
	const wslCurrency = startEnvelope("check-wsl-currency.js");
	/** @type {string} */
	let body;
	try {
		body = await renderWindow({
			tracker,
			since,
			why,
			now,
			previous,
			reviews,
			dryRun,
			idle,
			wslCurrency,
		});
	} finally {
		idle.stop();
		wslCurrency.stop();
	}

	if (dryRun) {
		io.out(`${title}\n\n${body}`);
		return 0;
	}
	const earlier = reviews
		.filter((i) => i.state === "OPEN")
		.map((i) => i.number);
	const filed = fileThrough(
		buildScriptFilerArgv({
			title,
			labels: [REVIEW_LABEL],
			placement: { standalone: review.STANDALONE_REASON },
			origin: "morning-review-script",
			distinctFrom: earlier,
		}),
		body,
		hostRoot(),
	);
	io.out(filed.stdout ?? "");
	writeFd(2, filed.stderr || (filed.error ? `${filed.error.message}\n` : ""));
	return filed.status ?? 1;
}

/** @param {string[]} argv */
async function main(argv = process.argv.slice(2)) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const tracker = io.trackerOrFail();
	const dryRun = flags["--dry-run"] === true;
	/* A filing that throws still answers before the throw ends the run. */
	let filed = 1;
	try {
		filed = await fileReview(tracker, dryRun);
	} finally {
		process.exitCode = Math.max(filed, answerReversals(tracker, dryRun));
	}
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		writeFd(
			2,
			`file-morning-review: ${e instanceof Error ? e.stack : String(e)}\n`,
		);
		/* main's finally has already set the answering's code; a failure is no better. */
		process.exitCode = Math.max(1, Number(process.exitCode ?? 0));
	});
