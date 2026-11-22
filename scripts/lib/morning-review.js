const { requiredGroup } = require("./regex-group.js");
const { byKind, incidentTitle, isOver } = require("./earlyoom-kills.js");
const { buildEpisodeTitle, countKilled } = require("./process-runaways.js");
const { NONE, SPREAD_CAP } = require("./concurrency.js");
const { DAY_MS } = require("./retained-jsonl.js");
const { rowChanges } = require("./primitives-table.js");
const { buildIdleLines } = require("./idle-efforts.js");
const { renderReadLine, renderUnreadLine } = require("./review-carry.js");
const { buildAlarmLine } = require("./queue-alarms.js");
const { buildStandaloneLine } = require("./standalone-line.js");

const TITLE = /^Morning review — (\d{4}-\d{2}-\d{2})$/;
const WINDOW_LINE = /^Window: \S+ → ([^\s,]+)/m;
const STANDALONE_REASON =
	"the day's away-mode review, outside every map (#1995)";
const HISTORY_LINE = /^Table history read to ([0-9a-f]{40}) in (\S+)\.$/gm;
// guess, #3827
const CLOSE_SETTLE_MS = 15 * 60 * 1000;
// guess, #2693
const STUCK_URGENT_DAYS = 7;
// guess, #3315
const CONCURRENCY_WINDOWS = {
	day: { ms: DAY_MS, span: "24 h" },
	week: { ms: 7 * DAY_MS, span: "7 days" },
};

/** @param {string} date */
const buildReviewTitle = (date) => `Morning review — ${date}`;

/** @param {string} title */
const parseReviewDate = (title) => TITLE.exec(title)?.[1] ?? null;

/**
 * @param {string} body
 * @returns {string | null}
 */
function parseWindowEnd(body) {
	const end = WINDOW_LINE.exec(body)?.[1];
	return end !== undefined && !Number.isNaN(Date.parse(end)) ? end : null;
}

/**
 * @param {{number: number, createdAt: string, body: string} | undefined} previous
 * @param {Date} now
 * @returns {{since: string, why: string | null}}
 */
function windowStart(previous, now) {
	if (!previous)
		return {
			since: new Date(now.getTime() - DAY_MS).toISOString(),
			why: null,
		};
	const end = parseWindowEnd(previous.body);
	return end === null
		? {
				since: previous.createdAt,
				why: `#${previous.number}'s Window line, so an event during its filing`,
			}
		: { since: end, why: null };
}

/**
 * @param {string} at
 * @returns {string}
 */
const closeEdge = (at) =>
	new Date(Date.parse(at) - CLOSE_SETTLE_MS).toISOString();

/**
 * @param {string | null} cursor
 * @param {boolean} isOnTip
 * @returns {string | null}
 */
function whyByTime(cursor, isOnTip) {
	if (cursor === null) return "no earlier review read this history";
	return isOnTip
		? null
		: `${cursor}, where the last review read to, is not on the branch read`;
}

/**
 * @param {{body: string}[]} reviews
 * @param {string} repo
 * @returns {string | null}
 */
function parseHistoryCursor(reviews, repo) {
	for (const { body } of reviews)
		for (const [, sha, named] of body.matchAll(HISTORY_LINE))
			if (named === repo) return sha ?? null;
	return null;
}

/** @param {{body: string}[]} comments */
function parseOneWayDoor(comments) {
	const door = /^[ \t]*\*\*Door:\*\*(.*)$/m;
	for (const { body } of [...comments].reverse()) {
		const m = door.exec(body ?? "");
		if (!m) continue;
		const text = requiredGroup(m, 1, door).trim();
		return /^one-way\b/.test(text)
			? text.replace(/^one-way\b[\s—–-]*/, "")
			: null;
	}
	return null;
}

/**
 * @typedef {import("./delegated-decision.js").LedgerLine} LedgerLine
 * @typedef {{number: number, title: string, url: string, closedAt: string,
 *   comments: {body: string}[]}} ClosedIssue
 * @typedef {{number: number, title: string}} OpenIssue
 * @typedef {{number: number, title: string, appliedAt: string,
 *   agedFromCreation: boolean,
 *   why: string | null}} UrgentIssue
 * @typedef {{number: number, title: string} & ({appliedAt: string}
 *   | {appliedAt: null, ageError: string})} ParkedIssue
 * @typedef {import("./primitives-table.js").Side} Side
 * @typedef {{sha: string, side: Side, before: string | null,
 *   after: string | null}} TableCommit
 * @typedef {{count: {line: string} | {why: string},
 *   history: {commits: TableCommit[], tip: string, whyByTime: string | null}
 *   | {why: string}}} PrimitivesReading
 * @typedef {{checkout: string, repo: string, closesSince: string,
 *   decisionsSince: string, entries: LedgerLine[] | null,
 *   closed: ClosedIssue[] | null, stalls: OpenIssue[],
 *   alarms: import("./queue-alarms.js").FiringAlarm[], urgent: UrgentIssue[],
 *   parked: ParkedIssue[], primitives: PrimitivesReading}} RepoReading
 * @typedef {{checkout: string, repo: string | null, act: string, issue: number | null,
 *   kind: import("./repo-holds.js").RepoHold["kind"], age: string,
 *   attached: number, notice: string}} OpenHold
 * @typedef {import("./review-carry.js").UnreadEvents} UnreadEvents
 * @typedef {{since: string, now: string, previous: number | null,
 *   repos: RepoReading[], failed: Unread[], unreadEvents: UnreadEvents[],
 *   holds: OpenHold[], throughput: ThroughputReading, kills: KillReading,
 *   runaways: RunawayReading,
 *   concurrency: ConcurrencyReading,
 *   idle: IdleReading, wslCurrency: WslCurrencyReading}} Reading
 * @typedef {{lines: string[]} | {why: string} | null} WslCurrencyReading
 * @typedef {{trackers: import("./idle-efforts.js").TrackerFinding[],
 *   loopRunning: boolean, damaged: string[]} | {why: string}} IdleReading
 * @typedef {ReturnType<typeof import("./concurrency.js").readout>} Readout
 * @typedef {Record<keyof typeof CONCURRENCY_WINDOWS, Readout>} ConcurrencyReading
 * @typedef {{incidents: import("./earlyoom-kills.js").Incident[],
 *   tickets: Map<string, number> | string, why: string | null}} KillReading
 * @typedef {{episodes: import("./process-runaways.js").Episode[],
 *   tickets: Map<string, number> | string, why: string | null}} RunawayReading
 * @typedef {{repo: string, why: string}} Unread
 * @typedef {import("./throughput-reads.js").RepoThroughput} RepoThroughput
 * @typedef {{repos: RepoThroughput[]} | {why: string}} ThroughputReading
 */

/** @param {string} text */
const quoted = (text) => `\`${text.replaceAll("`", "'")}\``;

/**
 * @param {WslCurrencyReading} reading
 * @returns {string[]}
 */
function renderWslCurrencyLines(reading) {
	if (reading === null) return [];
	return [
		"## WSL currency",
		"",
		...("why" in reading
			? [`Not read: ${quoted(reading.why)}`]
			: reading.lines.map((line) => `- ${quoted(line)}`)),
		"",
	];
}

/** @param {string} iso */
const searchTime = (iso) =>
	new Date(iso).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** @param {string} q */
const issueSearch = (q) =>
	`https://github.com/search?type=issues&q=${encodeURIComponent(q).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))}`;

/**
 * @param {number} n
 * @param {string} url
 * @param {string} [noun]
 */
const commentLink = (n, url, noun = "comment") => `[#${n} ${noun}](${url})`;

/**
 * @param {number} ms
 * @returns {string}
 */
const wholeDays = (ms) => {
	if (ms < DAY_MS) return "under a day";
	const days = Math.floor(ms / DAY_MS);
	return `${days} ${days === 1 ? "day" : "days"}`;
};

/**
 * @param {import("./earlyoom-kills.js").Incident} i
 * @param {KillReading["tickets"]} tickets
 * @param {number} now
 */
function ticketText(i, tickets, now) {
	if (typeof tickets === "string") return `ticket unread: ${quoted(tickets)}`;
	const n = tickets.get(incidentTitle(i));
	if (n !== undefined) return `#${n}`;
	return isOver(i, now)
		? "no ticket filed yet"
		: "no ticket yet: the incident is not over";
}

/**
 * @param {KillReading} r
 * @param {number} lo
 * @param {number} hi
 * @returns {string[]}
 */
function renderKillLines({ incidents, tickets, why }, lo, hi) {
	if (why !== null) return [`Not read: ${quoted(why)}.`];
	/** @param {KillReading["incidents"][number]} i */
	const killsIn = (i) =>
		i.kills.filter((k) => Date.parse(k.at) > lo && Date.parse(k.at) <= hi);
	const inWindow = incidents.flatMap(killsIn);
	if (inWindow.length === 0) return ["None in the window."];
	return [
		`${inWindow.length} in the window — ${byKind(inWindow)}.`,
		"",
		...incidents
			.filter((i) => killsIn(i).length > 0)
			.map(
				(i) =>
					`- ${quoted(incidentTitle(i))} — ${i.kills.length} ${i.kills.length === 1 ? "kill" : "kills"}: ${byKind(i.kills)}${i.unjoined === null ? "" : ` — headless runs not joined: ${quoted(i.unjoined)}`} — ${ticketText(i, tickets, hi)}`,
			),
	];
}

/**
 * @param {RunawayReading["episodes"][number]} e
 * @param {RunawayReading["tickets"]} tickets
 */
function episodeTicket(e, tickets) {
	if (typeof tickets === "string") return `ticket unread: ${quoted(tickets)}`;
	const n = tickets.get(buildEpisodeTitle(e));
	return n === undefined ? "no ticket filed yet" : `#${n}`;
}

/**
 * @param {RunawayReading} r
 * @param {number} lo
 * @param {number} hi
 * @returns {string[]}
 */
function renderRunawayLines({ episodes, tickets, why }, lo, hi) {
	if (why !== null) return [`Not read: ${quoted(why)}.`];
	const inWindow = episodes.filter((e) =>
		e.firings.some((f) => Date.parse(f.ts) > lo && Date.parse(f.ts) <= hi),
	);
	if (inWindow.length === 0) return ["None in the window."];
	return inWindow.map(
		(e) =>
			`- ${quoted(buildEpisodeTitle(e))} — ${quoted(e.argv)} — killed ${countKilled(e.firings)} — ${episodeTicket(e, tickets)}`,
	);
}

/** @param {number} h */
const hours = (h) => `${h.toFixed(1)} h`;

/**
 * @param {Readout} r
 * @param {string} span
 */
function buildSustainedText(r, span) {
	if (!r.minutesRead)
		return `unread over the last ${span} — memwatch's minute record did not read`;
	return r.sustained === null
		? `no session recorded working over the last ${span}`
		: `${r.sustained.toFixed(1)} over the last ${span} (${r.activeHours.toFixed(1)} h with any session working)`;
}

/**
 * @param {ConcurrencyReading} c
 * @returns {string[]}
 */
function renderConcurrencyLines({ day, week }) {
	const t = day.lastTick;
	const charged = Object.entries(day.hours)
		.sort(([, a], [, b]) => b - a)
		.map(
			([limit, h]) =>
				`- ${limit === NONE ? "nothing (a slot was free)" : limit}: ${hours(h)}`,
		);
	const spread = Object.entries(day.spread)
		.sort(([a], [b]) => Number(a) - Number(b))
		.map(
			([n, share]) =>
				`- ${Number(n) === SPREAD_CAP ? `${n} or more` : n} working: ${Math.round(share * 100)}%`,
		);
	return [
		"Sustained concurrency, the founder's own sessions counted:",
		"",
		`- ${buildSustainedText(week, CONCURRENCY_WINDOWS.week.span)}`,
		"",
		t
			? `Admission ceiling: ${t.ceiling ?? "unread"} at the last refill-loop tick (${t.at}).`
			: "Admission ceiling: no refill-loop tick recorded.",
		"",
		...(charged.length === 0
			? [
					day.minutesRead
						? `No session worked over the last ${CONCURRENCY_WINDOWS.day.span}, so no hours to charge or spread.`
						: "Hours by binding limit and their spread: unread, as memwatch's minute record did not read.",
				]
			: [
					`Hours with any session working over the last ${CONCURRENCY_WINDOWS.day.span}, by the limit binding then:`,
					"",
					...charged,
					"",
					"Share of those hours by how many sessions were working:",
					"",
					...spread,
				]),
	];
}

/**
 * @param {number} n
 * @param {string} repo
 * @param {TableCommit} commit
 * @param {import("./primitives-table.js").RowChange} c
 */
const renderPrimitiveLine = (n, repo, { side, sha }, c) =>
	`${n}. ${repo} — ${side} row ${c.change}${c.cells.length > 0 ? ` (${c.cells.join(", ")})` : ""}: ${quoted(c.primitive)} — job ${quoted(c.job)} — ${sha}`;

/**
 * @param {string} repo
 * @param {{commits: TableCommit[]}} history
 * @param {() => number} next
 * @returns {string[]}
 */
function renderRowChanges(repo, history, next) {
	return history.commits.flatMap((commit) => {
		const read = rowChanges(commit.side, commit.before, commit.after);
		return "unreadable" in read
			? [
					`- ${commit.sha}: the ${commit.side} table did not read — ${quoted(read.unreadable)}`,
				]
			: read.changes.map((c) => renderPrimitiveLine(next(), repo, commit, c));
	});
}

/**
 * @param {string} repo
 * @param {PrimitivesReading["history"]} history
 * @param {() => number} next
 * @returns {string[]}
 */
function renderHistoryLines(repo, history, next) {
	if ("why" in history)
		return [`Row changes not read: ${quoted(history.why)}.`];
	const changed = renderRowChanges(repo, history, next);
	return [
		...(changed.length === 0
			? ["No row changed since the last read."]
			: changed),
		...(history.whyByTime === null
			? []
			: [
					"",
					`Found by commit time, as ${history.whyByTime}: a commit that reached the branch after its window may be missing.`,
				]),
	];
}

/**
 * @param {RepoReading[]} repos
 * @param {number} first
 * @returns {string[]}
 */
function renderPrimitivesLines(repos, first) {
	let n = first;
	return repos.flatMap(({ repo, primitives: { count, history } }) => [
		`### ${repo}`,
		"",
		"line" in count
			? quoted(count.line)
			: `Count line not read: ${quoted(count.why)}.`,
		"",
		...renderHistoryLines(repo, history, () => n++),
		"",
	]);
}

/**
 * @param {RepoReading[]} repos
 * @returns {string[]}
 */
function renderBookkeepingLines(repos) {
	if (repos.length === 0) return [];
	return [
		"",
		"<!--",
		...repos.flatMap(({ repo, primitives: { history } }) =>
			"why" in history
				? []
				: [`Table history read to ${history.tip} in ${repo}.`],
		),
		...repos.map(({ checkout }) => renderReadLine(checkout)),
		"-->",
	];
}

/**
 * @param {OpenHold[]} holds
 * @returns {string[]}
 */
function renderHoldLines(holds) {
	if (holds.length === 0) return [];
	return [
		"## Open repo holds",
		"",
		"Each founder act holding shared state, with its issue, kind, age, the sessions attached and whether its phone notices went:",
		"",
		...holds.map(
			(h) =>
				`- ${h.checkout}: ${quoted(h.act)} — ${h.issue === null ? "no issue filed yet" : `${h.repo ?? ""}#${h.issue}`} — ${h.kind === "probe" ? "probe, which stops launches" : h.kind} — age ${h.age} — ${h.attached} attached — notice: ${h.notice}`,
		),
		"",
	];
}

/** @param {RepoThroughput} r */
const isThroughputFlagged = (r) =>
	(r.state !== null && r.state.state !== "closed") ||
	(r.events ?? []).some(
		(e) => e.event !== "trial-start" && e.event !== "close",
	);

/** @param {import("./refill-breaker.js").BreakerState | null} state */
function buildBreakerText(state) {
	if (state === null) return "breaker not read";
	if (state.state === "closed") return "breaker closed";
	const since = new Date(state.since).toISOString();
	return state.state === "open"
		? `breaker open since ${since}`
		: `breaker trial running or waiting to land${state.ticket === null ? "" : ` (#${state.ticket})`}, open since ${since}`;
}

/** @param {import("./refill-breaker.js").BreakerEvent[]} events */
function buildTransitionsText(events) {
	const count = (/** @type {string} */ name) =>
		events.filter((e) => e.event === name).length;
	const parks = events.filter((e) => e.event === "budget-park");
	return [
		`${count("open")} opened, ${count("reopen")} reopened on a failed trial`,
		parks.length === 0
			? "no budget park"
			: `budget parks: ${parks.map((e) => (e.ticket === undefined ? `session ${e.session}` : `#${e.ticket}`)).join(", ")}`,
	];
}

/**
 * @param {RepoThroughput} r
 */
function buildThroughputLine(r) {
	const rate =
		r.commits === null || r.workingHours === 0
			? "no rate"
			: `${(r.commits / r.workingHours).toFixed(2)} per working session-hour`;
	return [
		`- ${isThroughputFlagged(r) ? "**flagged** " : ""}${r.checkout}: ${r.commits === null ? "commits not read" : `${r.commits} commits`}, ${hours(r.workingHours)} working, ${rate}, ${r.gateRuns === null ? "gate runs not read" : `${r.gateRuns} gate runs`}`,
		buildBreakerText(r.state),
		...(r.events === null ? [] : buildTransitionsText(r.events)),
	].join(" — ");
}

/**
 * @param {ThroughputReading} reading
 * @returns {string[]}
 */
function renderThroughputLines(reading) {
	const rows = "why" in reading ? [] : reading.repos;
	const unread =
		"why" in reading
			? [`- ${quoted(reading.why)}`]
			: rows.flatMap((r) => {
					const what = [
						...(r.events === null ? ["breaker record"] : []),
						...(r.gateRuns === null ? ["gate-run record"] : []),
						...(r.jobsRead ? [] : ["loop-job record"]),
						...r.timelinesUnread,
					];
					return what.length === 0
						? []
						: [`- ${r.checkout}: ${what.join(" and ")}`];
				});
	const ordered = [
		...rows.filter(isThroughputFlagged),
		...rows.filter((r) => !isThroughputFlagged(r)),
	];
	return [
		"## Throughput",
		"",
		"Each served repo's commits on `origin/main` in the window and its breaker at filing; one whose breaker is open or on trial, or opened, reopened or parked a session, is flagged and listed first:",
		"",
		...(rows.length === 0 && !("why" in reading)
			? ["No served repo."]
			: ordered.map(buildThroughputLine)),
		...(unread.length === 0 ? [] : ["", "Not read:", "", ...unread]),
		"",
	];
}

/**
 * @param {{repo: string, closesSince: string, closed: ClosedIssue[] | null}[]} readings
 * @param {string} since
 * @param {string} closedTo
 * @returns {string[]}
 */
function renderClosedLines(readings, since, closedTo) {
	const isPartial = readings.some((r) => r.closed === null);
	const closedCount = readings.reduce(
		(sum, r) => sum + (r.closed?.length ?? 0),
		0,
	);
	const perRepo = readings.map((r) => {
		const from = closeEdge(r.closesSince);
		const search = `[search](${issueSearch(
			`repo:${r.repo} is:issue is:closed closed:>=${searchTime(from)}`,
		)})`;
		if (r.closed === null)
			return `- ${r.repo}: not read, so the next review to read them lists them — ${search}`;
		return `- ${r.repo}: ${r.closed.length}${r.closesSince === since ? "" : ` from ${from}, as the reviews since did not read it`} — ${search}`;
	});
	const oneWay = readings.flatMap(({ repo, closed }) =>
		(closed ?? []).flatMap((c) => {
			const door = parseOneWayDoor(c.comments);
			return door === null
				? []
				: [
						`- ${repo}#${c.number} — ${quoted(c.title)} — ${quoted(door || "one-way")}`,
					];
		}),
	);
	return [
		"## Closed tickets",
		"",
		`${closedCount} closed across ${isPartial ? "the repos read" : "included repos"}, ${closeEdge(since)} → ${closedTo}, ${CLOSE_SETTLE_MS / 60_000} minutes behind the window so that GitHub's search holds them:`,
		"",
		...perRepo,
		"",
		"One-way closes:",
		"",
		...(oneWay.length === 0
			? [isPartial ? "None in the repos read." : "None."]
			: oneWay),
		"",
	];
}

/**
 * @param {Reading} r
 * @returns {string}
 */
function renderReview({
	since,
	now,
	previous,
	repos,
	failed,
	unreadEvents,
	holds,
	throughput,
	kills,
	runaways,
	concurrency,
	idle,
	wslCurrency,
}) {
	const lo = Date.parse(since);
	const hi = Date.parse(now);
	/** @param {string} from @param {string} to */
	const between = (from, to) => (/** @type {string} */ at) =>
		Date.parse(at) > Date.parse(from) && Date.parse(at) <= Date.parse(to);
	const closedTo = closeEdge(now);

	const readings = repos.map(
		({ repo, closesSince, decisionsSince, entries, closed }) => {
			const decided = (entries ?? []).filter((e) =>
				between(decisionsSince, now)(e.at),
			);
			const isClosedInSpan = between(closeEdge(closesSince), closedTo);
			return {
				repo,
				closesSince,
				decisionsSince,
				caught: decided.filter((e) => e.stillClose),
				clear: decided.filter((e) => !e.stillClose).length,
				closed:
					closed === null
						? null
						: closed.filter((c) => isClosedInSpan(c.closedAt)),
			};
		},
	);

	const numbered = readings.flatMap(({ repo, caught }) =>
		caught.map((e) => ({ repo, e })),
	);
	const caughtLines = numbered.flatMap(({ repo, e }, i) => [
		...(i === 0 || numbered[i - 1]?.repo !== repo ? [`### ${repo}`, ""] : []),
		`${i + 1}. ${repo}#${e.issue} — ${quoted(e.question)} — taken: ${quoted(e.taken.option)} (${e.taken.figure}%) — ${commentLink(e.issue, e.comment)}`,
		...(numbered[i + 1]?.repo === repo ? [] : [""]),
	]);

	const ledgersUnread = repos.flatMap((r) =>
		r.entries === null
			? [`- ${r.repo}: not read, so the next review to read it lists them`]
			: [],
	);
	const noDecisions =
		ledgersUnread.length === 0
			? "None in the window."
			: "None in the repos read.";
	const clearCount = readings.reduce((sum, r) => sum + r.clear, 0);
	const clearRepos = readings.filter((r) => r.clear > 0);
	const clearFrom = clearRepos.reduce(
		(earliest, r) =>
			Date.parse(r.decisionsSince) < Date.parse(earliest)
				? r.decisionsSince
				: earliest,
		since,
	);
	// #2594

	const clearLine =
		clearCount === 0
			? noDecisions
			: `${clearCount} made ${clearFrom === since ? "in the window" : `since ${clearFrom}, as a review since did not read a repo`} — [search](${issueSearch(
					`${clearRepos.map((r) => `repo:${r.repo}`).join(" ")} ("Still caught: no" OR "Still close: no") in:comments updated:>=${searchTime(clearFrom)}`,
				)}).`;

	const stuck = repos.flatMap(({ repo, urgent }) =>
		urgent.flatMap((i) => {
			const age = hi - Date.parse(i.appliedAt);
			return age > STUCK_URGENT_DAYS * DAY_MS
				? [
						`- ${repo}#${i.number} — ${quoted(i.title)} — ${i.agedFromCreation ? "at most " : ""}${wholeDays(age)} — ${i.why === null ? "pick-next does not say why" : quoted(i.why)}`,
					]
				: [];
		}),
	);
	const stalls = repos.flatMap(({ repo, stalls: open, alarms }) => [
		...open.map((i) => `- ${repo}#${i.number} — ${quoted(i.title)}`),
		...alarms.map((a) => `- ${repo} — ${buildAlarmLine(a, hi)}`),
	]);
	const parked = repos.flatMap(({ repo, parked: open }) =>
		open.map(
			(i) =>
				`- ${repo}#${i.number} — ${quoted(i.title)} — ${i.appliedAt === null ? `age unknown: ${quoted(i.ageError)}` : wholeDays(hi - Date.parse(i.appliedAt))}`,
		),
	);

	const idleLines =
		"why" in idle
			? [`Not read: ${quoted(idle.why)}`]
			: buildIdleLines(idle.trackers, idle.loopRunning, idle.damaged).map(
					({ text, nested }) => `${nested ? "  " : ""}- ${quoted(text)}`,
				);

	return [
		"## Question",
		"",
		"Do you want any delegated decision or primitives-table change below reversed? Read the still-caught entries, the primitives-table changes and the one-way closes, comment `reverse <entry number>` against any you disagree with, then close this issue.",
		"",
		`Window: ${since} → ${now}${previous === null ? " (no previous review issue: the last 24 hours)" : `, from #${previous}, the previous review issue`}.`,
		...(failed.length === 0
			? []
			: [
					"",
					"**Not read, so missing below:**",
					...failed.map((f) => `- ${f.repo}: ${quoted(f.why)}`),
				]),
		...(unreadEvents.length === 0
			? []
			: [
					"",
					"The next review to read each of these lists what it names, events being both closes and decisions:",
					"",
					...unreadEvents.map(renderUnreadLine),
				]),
		"",
		...renderHoldLines(holds),
		...renderThroughputLines(throughput),
		"## Landing stalls",
		"",
		...(stalls.length === 0 ? ["None open."] : stalls),
		"",
		"## Memory kills",
		"",
		...renderKillLines(kills, lo, hi),
		"",
		"## Process runaways",
		"",
		...renderRunawayLines(runaways, lo, hi),
		"",
		"## Concurrency",
		"",
		...renderConcurrencyLines(concurrency),
		"",
		"## Parked",
		"",
		"Open issues labelled `parked`, with how long each has been parked:",
		"",
		...(parked.length === 0 ? ["None."] : parked),
		"",
		"## Idle efforts",
		"",
		"Each tracker's open efforts nothing has launched lately, the oldest, and why the refill loop skips it:",
		"",
		...idleLines,
		"",
		...renderWslCurrencyLines(wslCurrency),
		"## Still-caught delegated decisions",
		"",
		...(caughtLines.length === 0 ? [noDecisions, ""] : caughtLines),
		...(ledgersUnread.length === 0 ? [] : [...ledgersUnread, ""]),
		"## Clear delegated decisions",
		"",
		clearLine,
		"",
		...(ledgersUnread.length === 0 ? [] : [...ledgersUnread, ""]),
		"## Primitives",
		"",
		"Each repo's count line, then each primitives-table row added, removed or rewritten since the last review's read, with its commit:",
		"",
		...renderPrimitivesLines(repos, numbered.length + 1),
		...renderClosedLines(readings, since, closedTo),
		"## Stuck urgent",
		"",
		`Open issues labelled \`urgent\` more than ${STUCK_URGENT_DAYS} days ago, with why pick-next's last run in that checkout left each unlaunched:`,
		"",
		...(stuck.length === 0 ? ["None."] : stuck),
		"",
		"## How to reverse",
		"",
		"Comment `reverse <entry number>` on this issue, one per line. Each becomes a `takes:implement` ticket in that entry's repo carrying the entry's reversal recipe.",
		"",
		buildStandaloneLine(STANDALONE_REASON),
		...renderBookkeepingLines(repos),
		"",
	].join("\n");
}

const ENTRY_LINE = /^(\d+)\. (\S+)#(\d+) — .* — \[#\3 comment\]\((\S+)\)$/;
const PRIMITIVE_LINE =
	/^(\d+)\. (\S+) — (base|local) row (added|removed|rewritten)(?: \(([^)]*)\))?: `([^`]*)` — job `([^`]*)` — ([0-9a-f]+)$/;

/**
 * @typedef {{kind: "decision", repo: string, issue: number, comment: string}
 *   | ({kind: "primitive", repo: string, side: Side, sha: string}
 *   & import("./primitives-table.js").RowChange)} Entry
 */

/**
 * @param {string} line
 * @returns {[number, Entry] | null}
 */
function parseEntryLine(line) {
	const m = ENTRY_LINE.exec(line);
	if (m)
		return [
			Number(requiredGroup(m, 1, ENTRY_LINE)),
			{
				kind: "decision",
				repo: requiredGroup(m, 2, ENTRY_LINE),
				issue: Number(requiredGroup(m, 3, ENTRY_LINE)),
				comment: requiredGroup(m, 4, ENTRY_LINE),
			},
		];
	const p = PRIMITIVE_LINE.exec(line);
	if (!p) return null;
	const cells = p[5];
	return [
		Number(requiredGroup(p, 1, PRIMITIVE_LINE)),
		{
			kind: "primitive",
			repo: requiredGroup(p, 2, PRIMITIVE_LINE),
			side: /** @type {Side} */ (requiredGroup(p, 3, PRIMITIVE_LINE)),
			change: /** @type {Extract<Entry, {kind: "primitive"}>["change"]} */ (
				requiredGroup(p, 4, PRIMITIVE_LINE)
			),
			cells: cells === undefined ? [] : cells.split(", "),
			primitive: requiredGroup(p, 6, PRIMITIVE_LINE),
			job: requiredGroup(p, 7, PRIMITIVE_LINE),
			sha: requiredGroup(p, 8, PRIMITIVE_LINE),
		},
	];
}

/**
 * @param {string} body
 * @returns {Map<number, Entry>}
 */
function parseEntries(body) {
	/** @type {Map<number, Entry>} */
	const entries = new Map();
	for (const line of body.split("\n")) {
		const e = parseEntryLine(line);
		if (e) entries.set(...e);
	}
	return entries;
}

module.exports = {
	CONCURRENCY_WINDOWS,
	commentLink,
	parseEntries,
	parseReviewDate,
	quoted,
	renderReview,
	STANDALONE_REASON,
	buildReviewTitle,
	closeEdge,
	parseHistoryCursor,
	whyByTime,
	windowStart,
	searchTime,
};
