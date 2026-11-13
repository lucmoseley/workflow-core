/*
 * morning-review-filing.js — scripts/file-morning-review.js's core (#5148,
 * spec #5135): the day's morning review issue (#2011, spec #1995 §The morning
 * review issue), read, rendered through lib/morning-review.js and filed. It
 * writes each line through the `out` and `err` ports as it goes and returns
 * the exit code.
 *
 * Ports (§T7): `now`, the clock; `out` and `err`, the two streams; `gh`, lib/gh.js's `gh(args, opts)`; `file`,
 * file-issue.js through lib/file-through.js; `runChecker` and
 * `startChecker`, a core checker's `--json` run, the second left running
 * beside the reads. The filesystem, git and journalctl are read in place, and
 * the filing lock and the day's kept reads are written in place:
 * #2733's boundary table gives the filesystem no fake, git runs real in a
 * test's temp directory, and journalctl is reached at WFC_JOURNALCTL, its
 * owned fake held by journalctl.contract.test.ts.
 *
 * The review holds the still-caught delegated decisions, the clear ones
 * counted, the closes since the previous review issue with every one-way close
 * listed, each repo's open stall ticket and off-machine queue alarms firing
 * (lib/queue-alarms.js, #4772), the issues `urgent` for over 7 days, and every
 * open `parked` issue with its age.
 *
 * Files on the tracker it is handed — the loop runs it in workflow-core's —
 * and reads every repo lib/refill-repos.js includes: each one's
 * delegated-decision ledger, its closes (a span 15 minutes behind the window,
 * lib/morning-review.js's CLOSE_SETTLE_MS) with their comments, for the
 * `**Door:**` line, its open stall ticket (lib/stall-ticket.js, #2692), its
 * open `urgent` issues with each one's timeline and pick-next's last run there
 * (#2693), and its open `parked` issues with each one's timeline (#2725), read
 * only: it never writes or removes either label. A repo it cannot read is
 * named in the body, not dropped silently.
 *
 * ONCE A DAY: a review issue titled with today's machine-local date, open or
 * closed, files nothing — a hand run after the founder closed today's would
 * otherwise file a second. A filing holds a machine-wide lock (#3813) from
 * before that look until its issue exists, so a hand run and the loop's run
 * cannot both pass it. The one that finds the lock held files nothing and
 * exits 1, so the loop's next tick retries in case the holder fails.
 *
 * WINDOW (#3813): `since` is where the previous review's window ended, off its
 * body, and `now` is fixed before this run's reads, so no event falls between
 * two reviews however long a filing runs (lib/morning-review.js's
 * windowStart). That file's header gives each source's edge for an event
 * readable after this run's reads (#3827). A repo that does not read, or whose
 * config discovery will not read (#3834), is named in the body with where its
 * events went unread from, and the next review starts that repo there (#3831).
 * So is one carrying such a line that discovery no longer lists, its `.git` or
 * config missing; the review that finds its directory gone, or its start over
 * 30 days old, names what that gives up and ends the line (#3835). A checkout
 * the previous review read counts as one carrying a line from its window's
 * end, so its first absence loses nothing (#3844). Closes that will not read
 * on a second try, or a ledger that will not, cost and carry that kind alone
 * (#3928).
 * Residual: one its owner opted out is neither named nor carried, so a start
 * it carried ends there (#3834). A linked worktree likewise (#3835).
 *
 * Files through file-issue.js, so the `takes:` and known-label refusals bind
 * this script as they bind a session: no hook sees a gh call a script makes.
 * ONCE A DAY above already rules out a second review, so it names the open
 * earlier reviews `--distinct-from` up front: while the founder is away they
 * stay open and would refuse every filing. Refused for any other lookalike,
 * such as the away-mode spec, lib/file-through.js re-runs naming that too.
 *
 * MEMORY KILLS (#3094): the machine's earlyoom kills in the window, by kind,
 * each incident with its ticket — read once from this machine's journal
 * (lib/earlyoom-kills.js), not per repo.
 *
 * PROCESS RUNAWAYS (#3807): memwatch's firings in the window, each episode
 * with what it killed and its ticket, read once from this machine's log
 * (lib/process-runaways.js).
 *
 * PRIMITIVES (#3465): each repo's check-primitives.js count line, and every
 * commit on its default branch since the last review's read touching either
 * standards file, with the file's text either side, which
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
 * WSL CURRENCY (#4082): check-wsl-currency.js's `--json` lines, in a section
 * of its own, and none where the checker SKIPs: not WSL.
 * Both machine-wide checkers start before the repo reads and run beside them
 * (#4601).
 *
 * KEPT READS (#3765): each repo's count line and each label age, once read,
 * are kept for the day (lib/review-reads.js), so a run killed part way
 * resumes from them. A dry run neither takes nor keeps them (#3813).
 *
 * REPO HOLDS (#3865): each served checkout's open holds, in a section of their
 * own only where one is open. Read apart from readRepo, so a tracker outage,
 * when a hold is likeliest, costs none of them.
 *
 * Exit: 0 for a filing or a day already filed; 1 where the review issues will
 * not list, the filing lock is held or the filing failed on gh; file-issue.js's
 * own code where it refused.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseErrLine, buildGhReaders, retryingOnceSync } = require("./gh.js");
const { parseEnvelope } = require("./check-envelope.js");
const { caught } = require("./caught.js");
const { execGit } = require("./git.js");
const { requiredGroup } = require("./regex-group.js");
const { STANDARDS_DOCS } = require("./primitives-table.js");
const { buildScriptFilerArgv } = require("./script-filer-argv.js");
const { readLedger } = require("./delegated-decision.js");
const concurrency = require("./concurrency.js");
const kills = require("./earlyoom-kills.js");
const runaways = require("./process-runaways.js");
const { localDate } = require("./local-date.js");
const review = require("./morning-review.js");
const carry = require("./review-carry.js");
const { readAbsence, discoverRepos, homeDir } = require("./refill-repos.js");
const { labelAge } = require("./label-age.js");
const { PARKED_LABEL } = require("./parked.js");
const { readSnapshot, whyNotLaunched } = require("./pick-next-snapshot.js");
const { readFiringAlarms } = require("./queue-alarms.js");
const { STALL_TITLE } = require("./queue-tickets.js");
const { buildAgeText } = require("./hold-age.js");
const { buildNoticeText, readHolds } = require("./repo-holds.js");
const { requireKey } = require("./workflow-core-config.js");
const { pidLock } = require("./pid-lock.js");
const { refillPath } = require("./refill-dir.js");
const { readControlFile } = require("./refill-files.js");
const { REVIEW_LABEL, readReviewIssues } = require("./review-issues.js");
const { freshReads, reviewReads } = require("./review-reads.js");
const { URGENT_LABEL } = require("./urgent-label.js");

const FILING_LOCK = ".morning-review-filing.pid";
/* The lock's holder is read off its command line, so the program's name. */
const LOCK_NAME = "file-morning-review.js";
const IDLE_SCRIPT = "check-idle-efforts.js";
const WSL_CURRENCY_SCRIPT = "check-wsl-currency.js";

/** @typedef {import("./morning-review.js").Unread} Unread */
/** @typedef {Pick<ReturnType<typeof reviewReads>, "read">} Reads */
/** @typedef {import("./checker-run.js").CheckerRun} CheckerRun */
/** @typedef {import("./checker-run.js").Started} Started */
/**
 * @typedef {{
 *   now: () => Date,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   gh: typeof import("./gh.js").gh,
 *   file: (argv: string[], body: string) => {status: number | null, stdout?: string | null, stderr?: string | null, error?: Error},
 *   runChecker: (script: string, args: string[], cwd: string) => CheckerRun,
 *   startChecker: (script: string) => Started,
 * }} Ports
 */
/**
 * What every step is handed: the ports, the gh readers over `ports.gh`, the
 * run's fixed `now`, the tracker it files on, whether it is a dry run, and
 * the day's kept reads once the window is read.
 * @typedef {{ports: Ports, gh: ReturnType<typeof buildGhReaders>, now: Date,
 *   tracker: string, dryRun: boolean, reads: Reads}} Ctx
 */

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
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} windowSince
 * @param {{number: number, body: string}[]} reviews newest first
 * @returns {import("./review-carry.js").RepoRead}
 */
function readRepo(ctx, root, windowSince, reviews) {
	const checkout = path.basename(root);
	const start = carry.buildRepoStart(reviews[0], checkout, windowSince);
	let repo = checkout;
	try {
		repo = requireKey("tracker", { root });
		const ledger = readDecisions(root, repo);
		const closes = readCloses(ctx, repo, start.closes);
		const stalls = readStalls(ctx, repo);
		const alarms = readAlarms(root, repo);
		const urgent = readUrgent(ctx, root, repo);
		const parked = readParked(ctx, repo);
		const primitives = readPrimitives(
			ctx,
			root,
			carry.buildHistoryStart(start),
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
 * carried (#3928). Torn lines are named and lost.
 * @param {string} root
 * @param {string} repo
 * @returns {{entries: import("./morning-review.js").LedgerLine[] | null, unread: Unread[]}}
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
 * where a second try fails too (#3928).
 * @param {Ctx} ctx
 * @param {string} repo
 * @param {string} since
 * @returns {{closed: import("./morning-review.js").ClosedIssue[] | null, unread: Unread[]}}
 */
function readCloses(ctx, repo, since) {
	const read = retryingOnceSync(() =>
		ctx.gh.ghIssueListAll("closed issues", [
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
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} since
 * @param {string | null} cursor the commit an earlier review read to
 * @returns {import("./morning-review.js").PrimitivesReading}
 */
function readPrimitives(ctx, root, since, cursor) {
	return {
		count: ctx.reads.read(
			`count-line ${root}`,
			() => readCountLine(ctx, root),
			(count) => "line" in count,
		),
		history: readTableHistory(root, since, cursor),
	};
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {import("./morning-review.js").PrimitivesReading["count"]}
 */
function readCountLine(ctx, root) {
	const script = "check-primitives.js";
	const read = judgeEnvelope(
		script,
		ctx.ports.runChecker(script, ["--root", root], root),
	);
	if ("why" in read) return read;
	return typeof read.envelope.countLine === "string"
		? { line: read.envelope.countLine }
		: { why: read.missing };
}

/**
 * @param {string} script
 * @param {CheckerRun} r
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
 * @returns {import("./morning-review.js").PrimitivesReading["history"]}
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
	 * holds, which merge-base exits 128 on (#3827). */
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
	/** @type {import("./morning-review.js").TableCommit[]} */
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
 * @param {(line: string) => void} warn
 * @returns {string[]}
 */
function readHoldRoots(included, warn) {
	const scope = readControlFile(warn)?.scope;
	return [...new Set([...included, ...(scope?.repos ?? [])])];
}

/**
 * One checkout's open repo holds, off its local store. What will not read is
 * named in the review and stops nothing else (#3865).
 * @param {string} root
 * @param {number} now
 * @returns {{read: import("./morning-review.js").OpenHold[], unread: Unread[]}}
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
 * hold reports, costs its holds only their issue's repo name (#3865).
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
 * One tracker's open stall ticket (lib/stall-ticket.js, #2692); a failed read
 * is unread, leaving the rest of the repo's reading standing.
 * @param {Ctx} ctx
 * @param {string} repo
 * @returns {{read: import("./morning-review.js").OpenIssue[], unread: Unread[]}}
 */
function readStalls(ctx, repo) {
	try {
		const read = ctx.gh
			.ghIssueListAll("stall tickets", [
				"--repo",
				repo,
				"--state",
				"open",
				"--search",
				`in:title "${STALL_TITLE}"`,
				"--json",
				"number,title",
			])
			.filter((/** @type {{title: string}} */ i) => i.title === STALL_TITLE);
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
 * #4772); a failed read is unread, as readStalls'.
 * @param {string} root
 * @param {string} repo
 * @returns {{read: import("./queue-alarms.js").FiringAlarm[], unread: Unread[]}}
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
 * ticket on the tracker (scripts/file-memory-kill-tickets.js, #3094).
 * @param {Ctx} ctx
 * @param {string} since
 * @returns {import("./morning-review.js").KillReading}
 */
function readKills(ctx, since) {
	const { incidents, why } = kills.readIncidents(Date.parse(since));
	if (why !== null || incidents.length === 0)
		return { incidents, tickets: new Map(), why };
	try {
		return {
			incidents,
			tickets: kills.readIncidentTickets(ctx.tracker, ctx.ports.gh),
			why,
		};
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
 * one's ticket on the tracker (scripts/file-process-runaway-tickets.js, #3807).
 * @param {Ctx} ctx
 * @param {string} since
 * @returns {import("./morning-review.js").RunawayReading}
 */
function readRunaways(ctx, since) {
	const { episodes, why } = runaways.readEpisodes(Date.parse(since));
	if (why !== null || episodes.length === 0)
		return { episodes, tickets: new Map(), why };
	try {
		return {
			episodes,
			tickets: runaways.readEpisodeTickets(ctx.tracker, ctx.ports.gh),
			why,
		};
	} catch (e) {
		return { episodes, tickets: parseErrLine(e), why };
	}
}

/**
 * The concurrency readouts over each review window ending `now`.
 * @param {number} now
 * @returns {import("./morning-review.js").ConcurrencyReading}
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
 * @param {Started} started
 * @returns {Promise<import("./morning-review.js").IdleReading>}
 */
async function readIdle(started) {
	const read = judgeEnvelope(IDLE_SCRIPT, await started.settle());
	if ("why" in read) return read;
	const { trackers, loopRunning, damaged } = read.envelope;
	return Array.isArray(trackers) &&
		typeof loopRunning === "boolean" &&
		Array.isArray(damaged)
		? { trackers, loopRunning, damaged }
		: { why: read.missing };
}

/**
 * @param {Started} started
 * @returns {Promise<import("./morning-review.js").WslCurrencyReading>}
 */
async function readWslCurrency(started) {
	const read = judgeEnvelope(WSL_CURRENCY_SCRIPT, await started.settle());
	if ("why" in read) return read;
	if (read.envelope.outcome === "SKIP") return null;
	return Array.isArray(read.envelope.lines)
		? { lines: read.envelope.lines }
		: { why: read.missing };
}

/**
 * One checkout's open `urgent` issues, each with when its timeline last
 * records the label applied and why pick-next's last run there left it
 * unlaunched (#2693). One whose timeline records no application is aged from
 * its creation, an upper bound (#3760); one whose timeline will not read is
 * unread, never dropped or taken as fresh. Residual: an old issue made urgent
 * yesterday by a route the timeline does not record lists as stuck.
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} repo
 * @returns {{read: import("./morning-review.js").UrgentIssue[], unread: Unread[]}}
 */
function readUrgent(ctx, root, repo) {
	const { snapshot, why } = readSnapshot(root, repo);
	/** @type {import("./morning-review.js").UrgentIssue[]} */
	const read = [];
	/** @type {Unread[]} */
	const unread =
		why === null ? [] : [{ repo, why: `pick-next's last run: ${why}` }];
	const listed = readOpenLabelled(ctx, repo, URGENT_LABEL);
	if ("why" in listed) return { read, unread: [...unread, listed] };
	for (const { number, title, createdAt } of listed.open) {
		const age = readLabelAgeOn(ctx, repo, number, URGENT_LABEL);
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
 * records the label applied (#2725). One whose start will not read is listed
 * with its age unknown, never dropped.
 * @param {Ctx} ctx
 * @param {string} repo
 * @returns {{read: import("./morning-review.js").ParkedIssue[], unread: Unread[]}}
 */
function readParked(ctx, repo) {
	const listed = readOpenLabelled(ctx, repo, PARKED_LABEL);
	if ("why" in listed) return { read: [], unread: [listed] };
	const read = listed.open.map(({ number, title }) => {
		const age = readLabelAgeOn(ctx, repo, number, PARKED_LABEL);
		return age.unknown
			? { number, title, appliedAt: null, ageError: String(age.error) }
			: { number, title, appliedAt: age.appliedAt };
	});
	return { read, unread: [] };
}

/**
 * One tracker's open issues carrying `label`, or why they did not read.
 * @param {Ctx} ctx
 * @param {string} repo
 * @param {string} label
 * @returns {{open: {number: number, title: string, createdAt: string}[]} | Unread}
 */
function readOpenLabelled(ctx, repo, label) {
	try {
		return {
			open: ctx.gh.ghIssueListAll(`${label} issues`, [
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
 * @param {Ctx} ctx
 * @param {string} repo
 * @param {number} number
 * @param {string} label
 */
function readLabelAgeOn(ctx, repo, number, label) {
	return ctx.reads.read(
		`label-age ${repo}#${number} ${label}`,
		() => readTimelineAge(ctx, repo, number, label),
		(age) => !age.unknown,
	);
}

/**
 * @param {Ctx} ctx
 * @param {string} repo
 * @param {number} number
 * @param {string} label
 */
function readTimelineAge(ctx, repo, number, label) {
	/** @type {Parameters<typeof labelAge>[0]} */
	let timeline;
	try {
		timeline = {
			ok: true,
			events: ctx.gh.ghApiSlurp([`repos/${repo}/issues/${number}/timeline`]),
		};
	} catch (e) {
		timeline = { ok: false, error: parseErrLine(e) };
	}
	return labelAge(timeline, label, ctx.now.getTime());
}

/**
 * File today's review unless one carries today's date or another run is
 * filing it; a dry run files nothing, so it takes no lock. The exit code.
 * @param {{tracker: string, dryRun: boolean, ports: Ports}} at
 * @returns {Promise<number>}
 */
function fileMorningReview({ tracker, dryRun, ports }) {
	return fileReview({
		ports,
		gh: buildGhReaders(ports.gh),
		now: ports.now(),
		tracker,
		dryRun,
		reads: freshReads(),
	});
}

/** @param {Ctx} ctx */
async function fileReview(ctx) {
	if (ctx.dryRun) return fileUnlessFiledToday(ctx);
	const file = refillPath(FILING_LOCK);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = pidLock(file, LOCK_NAME);
	if (!lock.acquire()) {
		ctx.ports.err(
			`another run is filing today's review (pid ${lock.holder()}). Nothing filed: re-run once it ends.\n`,
		);
		return 1;
	}
	try {
		return await fileUnlessFiledToday(ctx);
	} finally {
		lock.release();
	}
}

/**
 * @param {{ctx: Ctx, since: string, why: string | null, previous: any,
 *   reviews: any[], idle: Started, wslCurrency: Started}} at
 */
async function renderWindow({
	ctx,
	since,
	why,
	previous,
	reviews,
	idle,
	wslCurrency,
}) {
	const { now, tracker, dryRun, ports } = ctx;
	const withReads = {
		...ctx,
		reads: dryRun ? freshReads() : reviewReads(localDate(now)),
	};
	const home = homeDir();
	const { included, faulted } = discoverRepos(home);
	const read = [
		...included.map((root) => readRepo(withReads, root, since, reviews)),
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
	const holds = readHoldRoots(included, (line) => ports.err(`${line}\n`)).map(
		(root) => readOpenHolds(root, now.getTime()),
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
		kills: readKills(ctx, since),
		runaways: readRunaways(ctx, since),
		concurrency: readConcurrency(now.getTime()),
		idle: await readIdle(idle),
		wslCurrency: await readWslCurrency(wslCurrency),
	});
}

/**
 * Read the window and file its review, unless one carries today's date. The
 * exit code.
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function fileUnlessFiledToday(ctx) {
	const { now, ports, tracker, dryRun } = ctx;
	const title = review.buildReviewTitle(localDate(now));

	let reviews;
	try {
		reviews = readReviewIssues(tracker, "all", { run: ports.gh });
	} catch (e) {
		ports.err(
			`could not list ${tracker}'s review issues (${parseErrLine(e)}). Nothing filed.\n`,
		);
		return 1;
	}
	const today = reviews.find((i) => i.title === title);
	if (today) {
		ports.out(
			`#${today.number} is today's review issue already. Nothing filed.\n`,
		);
		return 0;
	}
	const [previous] = reviews;
	const { since, why } = review.windowStart(previous, now);
	const idle = ports.startChecker(IDLE_SCRIPT);
	const wslCurrency = ports.startChecker(WSL_CURRENCY_SCRIPT);
	/** @type {string} */
	let body;
	try {
		body = await renderWindow({
			ctx,
			since,
			why,
			previous,
			reviews,
			idle,
			wslCurrency,
		});
	} finally {
		idle.stop();
		wslCurrency.stop();
	}

	if (dryRun) {
		ports.out(`${title}\n\n${body}`);
		return 0;
	}
	const earlier = reviews
		.filter((i) => i.state === "OPEN")
		.map((i) => i.number);
	const filed = ports.file(
		buildScriptFilerArgv({
			title,
			labels: [REVIEW_LABEL],
			placement: { standalone: review.STANDALONE_REASON },
			origin: "morning-review-script",
			distinctFrom: earlier,
		}),
		body,
	);
	ports.out(filed.stdout ?? "");
	ports.err(filed.stderr || (filed.error ? `${filed.error.message}\n` : ""));
	return filed.status ?? 1;
}

module.exports = { fileMorningReview };
