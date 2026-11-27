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
const { readControlChecked, readControlFile } = require("./refill-files.js");
const { readState } = require("./refill-state.js");
const { readThroughputWindow } = require("./throughput-reads.js");
const { REVIEW_LABEL, readReviewIssues } = require("./review-issues.js");
const { freshReads, reviewReads } = require("./review-reads.js");
const { URGENT_LABEL } = require("./urgent-label.js");

const FILING_LOCK = ".morning-review-filing.pid";
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
 *   answer: (tracker: string, dryRun: boolean) => number,
 * }} Ports
 */
/**
 * @typedef {{ports: Ports, gh: ReturnType<typeof buildGhReaders>, now: Date,
 *   tracker: string, dryRun: boolean, reads: Reads}} Ctx
 */

/**
 * @param {{root: string, why: string}} faulted
 * @param {string} windowSince
 * @param {{number: number, body: string}[]} reviews
 */
function buildFaultedRepo({ root, why }, windowSince, reviews) {
	const checkout = path.basename(root);
	const start = carry.buildRepoStart(reviews[0], checkout, windowSince);
	const [line = ""] = why.split("\n");
	return carry.buildUnreadRepo(checkout, start, checkout, line);
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} windowSince
 * @param {{number: number, body: string}[]} reviews
 * @returns {import("./review-carry.js").RepoRead}
 */
function readRepo(ctx, root, windowSince, reviews) {
	const checkout = path.basename(root);
	const start = carry.buildRepoStart(reviews[0], checkout, windowSince);
	let repo = checkout;
	try {
		repo = requireKey("tracker", { root });
		const ledger = readDecisions(root, repo, start.decisions);
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
 * @param {string} root
 * @param {string} repo
 * @param {string} since
 * @returns {{entries: import("./morning-review.js").LedgerLine[] | null, unread: Unread[]}}
 */
function readDecisions(root, repo, since) {
	try {
		const { lines, torn, zeroed: all } = readLedger(root);
		const zeroed = all.filter(({ after }) => !isBefore(after, since));
		return {
			entries: lines,
			unread: [
				...(torn === 0
					? []
					: [{ repo, why: `${torn} torn ledger line(s) skipped` }]),
				...(zeroed.length === 0
					? []
					: [{ repo, why: buildZeroedText(zeroed) }]),
			],
		};
	} catch (e) {
		return {
			entries: null,
			unread: [{ repo, why: `ledger: ${parseErrLine(e)}` }],
		};
	}
}

/**
 * #5795
 * @param {string | null} after
 * @param {string} since
 */
const isBefore = (after, since) =>
	after !== null && Date.parse(after) < Date.parse(since);

/** @param {import("./delegated-decision.js").ZeroedRecord[]} zeroed */
const buildZeroedText = (zeroed) =>
	`${zeroed.length} ledger record(s) zeroed by a crash, written ${zeroed
		.map(
			({ before, after }) =>
				`between ${before ?? "the ledger's start"} and ${after ?? "its end"}`,
		)
		.join("; ")}`;

/**
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
 * @param {string | null} cursor
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

const LOG_LINE = /^([0-9a-f]+) ([0-9a-f]+) ?([0-9a-f]*)/;

/**
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
	/**
	 * @param {string} rev
	 * @param {string} file
	 */
	const textAt = (rev, file) =>
		git(["ls-tree", "--name-only", rev, "--", file]).trim() === ""
			? null
			: git(["show", `${rev}:${file}`]);
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
 * @param {string[]} included
 * @param {(line: string) => void} warn
 * @returns {string[]}
 */
function readHoldRoots(included, warn) {
	const scope = readControlFile(warn)?.scope;
	return [...new Set([...included, ...(scope?.repos ?? [])])];
}

/**
 * @param {string} since
 * @param {Date} now
 * @param {(line: string) => void} warn
 * @returns {import("./morning-review.js").ThroughputReading}
 */
function readServedThroughput(since, now, warn) {
	const { control, damaged } = readControlChecked(warn);
	if (damaged !== null) return { why: damaged };
	return {
		repos: readThroughputWindow({
			roots: control?.scope.repos ?? [],
			launches: readState(warn).launches,
			lo: Date.parse(since),
			hi: now.getTime(),
		}),
	};
}

/**
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

/** @param {string} root */
function readHoldTracker(root) {
	try {
		return requireKey("tracker", { root });
	} catch {
		return null;
	}
}

/**
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

/** @param {unknown} e */
const buildCrashLine = (e) =>
	`file-morning-review: ${e instanceof Error ? e.stack : String(e)}\n`;

/**
 * @param {{tracker: string, dryRun: boolean, ports: Ports}} at
 * @returns {Promise<number>}
 */
async function fileMorningReview({ tracker, dryRun, ports }) {
	let filed = 1;
	try {
		filed = await fileReview({
			ports,
			gh: buildGhReaders(ports.gh),
			now: ports.now(),
			tracker,
			dryRun,
			reads: freshReads(),
		});
	} catch (e) {
		ports.err(buildCrashLine(e));
	}
	return Math.max(filed, ports.answer(tracker, dryRun));
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
		throughput: readServedThroughput(since, now, (line) =>
			ports.err(`${line}\n`),
		),
		kills: readKills(ctx, since),
		runaways: readRunaways(ctx, since),
		concurrency: readConcurrency(now.getTime()),
		idle: await readIdle(idle),
		wslCurrency: await readWslCurrency(wslCurrency),
	});
}

/**
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

module.exports = { buildCrashLine, fileMorningReview };
