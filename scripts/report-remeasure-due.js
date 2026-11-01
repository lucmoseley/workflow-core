#!/usr/bin/env node
/*
 * report-remeasure-due.js — tells the founder, through one filed issue, once
 * 15 commits on adopter-declared sensitive paths carry known defects, so the
 * focused-against-identical-runs question (#1545) is re-measured on real code
 * (#1625, spec #1612 §The re-measure trigger).
 *
 * A COUNTED COMMIT is a `**Review findings:** base <sha>, reviewed <tree>,
 * landed <sha>[, paths <paths>]` record (docs/agents/rules/review-tier-records.txt) on a
 * corpus ticket whose latest `**Review tier:**` line before it reads
 * escalated or mission-critical, and which has a known defect: a `- FIXED`
 * or `- TICKETED` line among the bullets under it (`- DECLINED`
 * does not count), or an `**Escaped defect:** <sha>` line anywhere in the
 * corpus naming its landed sha. One commit recorded twice, by a short sha or
 * a full one, is counted once, its defects summed. A commit a revert on
 * `main` names is not counted, unless that revert was itself reverted:
 * searched in the tracker's repo only once the count reaches the threshold
 * or an issue of TITLE exists to refresh, since dropping one can only lower
 * it (#3395). Residual: an adopter's code
 * repo apart from its tracker is not searched.
 *
 * A RECORD WHOSE LANDED SHA IS NOT ON `origin/main`, in the checkout on this
 * machine that tracks the record's repo, is not counted (#3846). One the pushed
 * ref (lib/landing-refs.js) holds is legal and silent, as a close posts it there
 * without waiting for the lander. One on neither, as a replay onto `landing` can
 * leave it, is reported as OFF MAIN each run until a record of the same review
 * on its ticket names a sha that is on one. Reads the remote-tracking refs as
 * they stand, never fetching. A sha that checkout does not hold is reported as
 * UNJUDGED and counted; a record with no such checkout is counted, unreported.
 *
 * A COMMIT CARRYING A `Review-Tier:` TRAILER, as .husky/prepare-commit-msg
 * writes from the review hold's marker (scripts/review-tier-trailer.sh), is
 * counted by it where no record names it, and once where one does (#3664).
 * Its trailer names no defect, so it counts only once an `**Escaped defect:**`
 * line names it, and its tree is the landed one, never the pinned pre-fix
 * tree. Read with `git log` in the checkout on this machine that tracks the
 * record's repo, at its HEAD, from TRAILER_FROM; there, a commit that changes
 * a path its `sensitivePaths` declares now and carries neither the trailer nor
 * a record is reported as UNRECORDED, each run until a record names it, a
 * trailer not in its form as UNPARSEABLE, and a checkout git cannot read as
 * UNREAD. Judged from that fixed instant, not the repo's own first trailer, as
 * a repo whose sessions never write a marker, or an adopter pinned before
 * #3664, would never have one (#3714).
 * Residual: a repo with no such checkout goes unread, and a commit from the
 * founder's own terminal, which the hold skips, or a linked worktree's whose
 * marker would not pass, is reported.
 *
 * ADOPTER AREAS ONLY (#3431): a commit recorded on this repo's own tracker is
 * never counted, its records still read for the reports below and its
 * `**Escaped defect:**` lines for an adopter's commit.
 *
 * AN UNPARSEABLE RECORD — a `**Review findings:**` not in backticks, under a
 * counted tier, that the record form does not match — counts nothing and is
 * reported, remedy included: one line to stderr and to the guard-error log,
 * which is what the daily run keeps, per record each run until it is
 * corrected (#3064). A note after the landed sha, as a record posted before
 * its commit landed carries, is unparseable too (#3541). Not one a parsed
 * record on its ticket supersedes, sharing its `reviewed <tree>`, or its
 * `base` and paths. Residual: two commits a ticket records from one base over
 * the same paths hide each other's unparseable record.
 *
 * A RECORD NAMING THE LANDED TREE — a counted commit with a `- FIXED` line
 * whose `reviewed` tree equals its landed commit's on the record's paths, the
 * marker's post-fix `tree=` copied in place of the pin — still counts, and is
 * reported the same way, since a replay finds none of its fixed defects
 * (#3444). A commit that fixed nothing lands its pre-fix tree, so is not
 * judged. Judged in the checkout on this machine that tracks the record's
 * repo; a record posted before PINNED_FROM, one naming no paths, and one
 * with no such checkout go unjudged. One whose diff there fails, a sha it
 * does not hold included, goes unjudged too and is reported as UNJUDGED
 * (#3544).
 * Residual: a session that never took the pin cannot correct its record,
 * which is reported each run.
 *
 * THE SEARCH. Every `corpus` tracker, one GraphQL search a page of 100
 * tickets, each with its comments, for "Review tier" or "Escaped defect"
 * since FLOOR, the day the record formats landed. Not "Review findings":
 * ordinary review reports match it (#1625), and a counted record needs a
 * tier line on its ticket anyway. A ticket past 100 comments has the rest
 * read by REST. A window holding more than search's 1,000-result cap is
 * halved by date until each half fits, a single day past it throwing, and a
 * window whose pages return fewer tickets than its count throws.
 *
 * AT THRESHOLD it files TITLE, `takes:wayfinder`, listing each counted
 * commit; while an issue of that title exists, open or closed, it only
 * rewrites that issue's body, never filing a second, below the threshold too,
 * since a gate reads the count from its first line (#3576). Found by title
 * alone, since the session that takes it may relabel it. Below the threshold
 * it prints nothing but those reports.
 *
 * WORKFLOW-CORE ONLY, by its repo-checks gate: one reading covers the whole
 * corpus, and Actions' token cannot read the private adopter repos.
 *
 * Exit 0 whether or not it files: a `gh` failure, a window that cannot be
 * read whole, an unreadable WFC_NOW, a refused `takes:` label or a failed
 * filing is one line in the arbiter's error log, and the next day's run
 * retries (#1698). Exit 2 only where lib/cli-args.js refuses the command line.
 */

const { writeFd } = require("./lib/write-fd.js");
const { logError } = require("./lib/arbiter-core");
const { parseOrExit } = require("./lib/cli-args");
const { now } = require("./lib/check");
const {
	parseErrLine,
	ghApiSlurp,
	parseGhFailureReason,
	ghJson,
	unreachableRemedy,
} = require("./lib/gh");
const { gitOutcome } = require("./lib/git");
const { matchSensitivePaths } = require("./lib/sensitive-paths");
const { hostRoot } = require("./lib/host-root");
const { homeDir, readCheckoutTracking } = require("./lib/refill-repos");
const { pushedRef, VERIFIED_REF } = require("./lib/landing-refs");
const { requiredGroup } = require("./lib/regex-group");
const {
	COUNTED_TIERS,
	day,
	isSameReview,
	isSameSha,
	parseIssue,
	pathListOf,
	readTicketComments,
} = require("./lib/review-findings");
const { takesLabel, takesRefusal } = require("./lib/takes-label");
const {
	createIssue,
	findTrackingIssue,
	refresh,
} = require("./lib/tracking-issue");
const { readConfig, resolveKey } = require("./lib/workflow-core-config");

const WHERE = "report-remeasure-due";
const TITLE = "Re-measure focused against identical review runs";
const LABEL = takesLabel("wayfinder");
/* #1556 Q4 (A)'s "about 15", made exact by spec #1612: a judgement of how
 * many commits the comparison needs, not a measurement. */
const THRESHOLD = 15;
const FLOOR = "2026-10-14";
/* The day the rule named the pre-fix tree (#3444). The records before it
 * stand as filed, #3425 charting which of their defects replay. */
const PINNED_FROM = "2026-10-29";
/* 591ef1a74's commit time (#3664): no commit before it carries a trailer. */
const TRAILER_FROM = "2026-10-29T22:57:18+08:00";
const SEARCH_CAP = 1000;
/* GitHub's largest page: GraphQL's, for tickets and each ticket's comments,
 * and REST search's, for reverts. */
const PAGE = 100;
const DAY_MS = 86_400_000;

const PHRASES = '("Review tier" OR "Escaped defect")';
const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { number comments(first: ${PAGE}) { totalCount nodes { body createdAt } } } }
  }
}`;
/* review-tier-trailer.sh's value, the hold's tier, areas, tree and paths. */
const TRAILER =
	/^(escalated|mission-critical);\s*areas=[^;]*;\s*base=([0-9a-f]{40});\s*tree=([0-9a-f]{40});\s*paths=(.+)$/;
/* `git revert`'s own message line, which names the full sha. */
const REVERTS = /^This reverts commit ([0-9a-f]{40})\b/gm;

/**
 * @typedef {import("./lib/review-findings").Comment} Comment
 * @typedef {import("./lib/review-findings").ReviewRecord} ReviewRecord
 * @typedef {import("./lib/review-findings").Unparsed} Unparsed
 * @typedef {{ tag: "UNRECORDED" | "UNPARSEABLE" | "UNREAD", fault: string }} Unseen
 * @typedef {{ tag: Unseen["tag"] | "LANDED TREE" | "OFF MAIN" | "UNJUDGED", fault: string }} RecordFault
 */

/**
 * @param {string} q
 * @param {string | null} after
 * @returns {{ issueCount: number, pageInfo: { hasNextPage: boolean, endCursor: string },
 *   nodes: { number?: number, comments?: { totalCount: number, nodes: Comment[] } }[] }}
 */
function searchPage(q, after) {
	return ghJson([
		"api",
		"graphql",
		"-f",
		`query=${SEARCH}`,
		"-f",
		`q=${q}`,
		...(after ? ["-f", `after=${after}`] : []),
	]).data.search;
}

/**
 * Every ticket in `repo` the search finds updated from `from` to `to`, with
 * its comments, halving the window while it holds more than the cap.
 *
 * @param {string} repo
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @returns {{ issue: number, comments: Comment[] }[]}
 */
function searchTickets(repo, from, to) {
	const q = `${PHRASES} in:comments is:issue repo:${repo} updated:${from}..${to}`;
	let page = searchPage(q, null);
	const total = page.issueCount;
	if (total > SEARCH_CAP) {
		const a = Date.parse(from);
		const b = Date.parse(to);
		if (a >= b)
			throw new Error(
				`${repo}: ${total} hits on ${from} alone, past search's ${SEARCH_CAP}-result cap`,
			);
		const mid = a + Math.floor((b - a) / DAY_MS / 2) * DAY_MS;
		return [
			...searchTickets(repo, from, day(mid)),
			...searchTickets(repo, day(mid + DAY_MS), to),
		];
	}
	const nodes = [...page.nodes];
	while (page.pageInfo.hasNextPage) {
		page = searchPage(q, page.pageInfo.endCursor);
		nodes.push(...page.nodes);
	}
	const tickets = nodes.flatMap((n) =>
		n.number === undefined || !n.comments
			? []
			: [{ issue: n.number, comments: n.comments }],
	);
	if (tickets.length !== total)
		throw new Error(
			`${repo} ${from}..${to}: search returned ${tickets.length} of ${total} hits`,
		);
	return tickets.map(({ issue, comments }) => ({
		issue,
		comments:
			comments.totalCount > comments.nodes.length
				? readTicketComments(repo, issue)
				: comments.nodes,
	}));
}

/**
 * Folds `r`, a later record of the same commit, into `seen`.
 *
 * @param {ReviewRecord} seen accumulator: `fixed` and `fixes` are written, `landed` where
 *   `r`'s is longer, and `issue`, `base`, `tree`, `paths` and `posted` where `seen` names
 *   no paths and `r` does
 * @param {ReviewRecord} r
 */
function mergeRecord(seen, r) {
	seen.fixed += r.fixed;
	seen.fixes += r.fixes;
	if (r.landed.length > seen.landed.length) seen.landed = r.landed;
	/* The issue, base, tree and paths are one replay, so a record naming paths
	 * replaces a pathless one's whole, never its paths alone (#2083). Where
	 * both name paths, the first stands. */
	if (seen.paths === null && r.paths !== null)
		Object.assign(seen, {
			issue: r.issue,
			base: r.base,
			tree: r.tree,
			paths: r.paths,
			posted: r.posted,
		});
}

/**
 * The commits from TRAILER_FROM at HEAD in the checkout under `home` that
 * tracks `repo`, those carrying a trailer as records, and the sensitive ones
 * carrying neither it nor one of `records`; none where no checkout tracks it.
 *
 * @param {string} repo
 * @param {ReviewRecord[]} records every record parsed, of any tier
 * @param {string} home
 * @returns {{ trailers: ReviewRecord[], unseen: Unseen[] }}
 */
function readTrailers(repo, records, home) {
	const checkout = readCheckoutTracking(repo, home);
	if (!("root" in checkout)) return { trailers: [], unseen: [] };
	const log = gitOutcome(
		[
			"-c",
			"core.quotePath=false",
			"log",
			"--no-merges",
			"--no-renames",
			`--since=${TRAILER_FROM}`,
			"--format=%x00%H%x1f%(trailers:key=Review-Tier,valueonly,unfold)%x1f",
			"--name-only",
			"HEAD",
		],
		[],
		checkout.root,
	);
	let declared;
	try {
		declared = readConfig({ root: checkout.root, quiet: true }).sensitivePaths;
	} catch (e) {
		declared = parseErrLine(e);
	}
	if (!log.ok || typeof declared === "string")
		return {
			trailers: [],
			unseen: [
				{
					tag: "UNREAD",
					fault: `${repo}: could not read its commits' Review-Tier: trailers in ${checkout.root}, so none is counted and none unrecorded reported — ${log.ok ? declared : log.why}`,
				},
			],
		};
	return parseTrailerLog(repo, log.out, declared, records);
}

/**
 * readTrailers's reading of `out`, the `git log` it ran.
 *
 * @param {string} repo
 * @param {string} out
 * @param {import("./lib/workflow-core-config").SensitivePath[] | undefined} declared
 * @param {ReviewRecord[]} records
 * @returns {{ trailers: ReviewRecord[], unseen: Unseen[] }}
 */
function parseTrailerLog(repo, out, declared, records) {
	const commits = out
		.split("\0")
		.slice(1)
		.map((chunk) => {
			const [sha = "", value = "", names = ""] = chunk.split("\x1f");
			const [trailer = ""] = value.split("\n");
			return { sha, trailer: trailer.trim(), names };
		});
	/** @type {ReviewRecord[]} */
	const trailers = [];
	/** @type {Unseen[]} */
	const unseen = [];
	for (const { sha, trailer, names } of commits) {
		const m = TRAILER.exec(trailer);
		if (m) {
			trailers.push({
				repo,
				issue: null,
				base: requiredGroup(m, 2, TRAILER),
				tree: requiredGroup(m, 3, TRAILER),
				landed: sha,
				paths: requiredGroup(m, 4, TRAILER),
				posted: "",
				tier: requiredGroup(m, 1, TRAILER),
				fixed: 0,
				fixes: 0,
				cutOff: 0,
				escaped: 0,
			});
			continue;
		}
		if (trailer !== "") {
			unseen.push({
				tag: "UNPARSEABLE",
				fault: `${repo}@${sha} has a Review-Tier: trailer not in scripts/review-tier-trailer.sh's form, so it is not counted by it: ${trailer}`,
			});
			continue;
		}
		const areas = matchSensitivePaths(
			declared,
			names.split("\n").filter(Boolean),
		).matched.map((a) => a.name);
		if (
			areas.length > 0 &&
			!records.some((r) => r.repo === repo && isSameSha(r.landed, sha))
		)
			unseen.push({
				tag: "UNRECORDED",
				fault: `${repo}@${sha} changes the sensitive area${areas.length > 1 ? "s" : ""} ${areas.join(", ")} and carries neither a Review-Tier: trailer nor a **Review findings:** record, so it is not counted until a record names it, as \`scripts/lib/rule-text.sh review-tier-records\` says`,
			});
	}
	return { trailers, unseen };
}

/**
 * Appends to `commits` each commit known by its trailer alone, returning the
 * sensitive commits no record or trailer names, and the checkouts unread.
 *
 * @param {ReviewRecord[]} commits accumulator: each trailer commit no record
 *   names is appended
 * @param {string[]} trackers
 * @param {ReviewRecord[]} records
 * @param {string} home
 * @returns {Unseen[]}
 */
function addTrailerCommits(commits, trackers, records, home) {
	/** @type {Unseen[]} */
	const unseen = [];
	for (const repo of trackers) {
		const found = readTrailers(repo, records, home);
		unseen.push(...found.unseen);
		for (const t of found.trailers)
			if (
				!commits.some((c) => c.repo === repo && isSameSha(c.landed, t.landed))
			)
				commits.push(t);
	}
	return unseen;
}

/**
 * The counted commits across `trackers`, in corpus order, then by ticket,
 * then those known by their trailer alone; the unparseable records under a
 * counted tier; and the faults of what was read: the sensitive commits no record
 * or trailer names, then each record's own.
 *
 * @param {string[]} trackers
 * @param {string} today YYYY-MM-DD
 * @param {string} home
 * @returns {{ commits: ReviewRecord[], unparsed: Unparsed[], faults: RecordFault[] }}
 */
function countedCommits(trackers, today, home) {
	/** @type {ReviewRecord[]} */
	const records = [];
	/** @type {string[]} */
	const escaped = [];
	/** @type {Unparsed[]} */
	const unparsed = [];
	for (const repo of trackers) {
		const tickets = searchTickets(repo, FLOOR, today).sort(
			(a, b) => a.issue - b.issue,
		);
		for (const { issue, comments } of tickets) {
			const found = parseIssue(repo, issue, comments);
			records.push(...found.records);
			escaped.push(...found.escaped);
			unparsed.push(...found.unparsed);
		}
	}
	/** @type {ReviewRecord[]} */
	const recorded = [];
	for (const r of records) {
		if (!COUNTED_TIERS.has(r.tier)) continue;
		const seen = recorded.find(
			(c) => c.repo === r.repo && isSameSha(c.landed, r.landed),
		);
		if (seen) mergeRecord(seen, r);
		else recorded.push({ ...r });
	}
	const { commits, recordFaults } = judgeRecords(recorded, home);
	const unseen = addTrailerCommits(commits, trackers, records, home);
	/* Across repos, not within one: the line sits on the fixing ticket, which
	 * may live in another repo, and a 7-hex prefix colliding is negligible. */
	for (const c of commits)
		c.escaped = escaped.filter((s) => isSameSha(s, c.landed)).length;
	return {
		commits: commits.filter((c) => c.fixed + c.escaped > 0),
		unparsed,
		faults: [...unseen, ...recordFaults],
	};
}

/**
 * Where `c`'s landed sha sits in the checkout under `home` that tracks its repo:
 * on `main`, on the pushed ref alone, or on neither; "unread" with no such
 * checkout, or with an UNJUDGED fault where git fails there.
 *
 * @param {ReviewRecord} c
 * @param {string} home
 * @returns {{ at: "main" | "landing" | "off" } | { at: "unread", fault: RecordFault | null }}
 */
function readLandedAt(c, home) {
	const checkout = readCheckoutTracking(c.repo, home);
	if (!("root" in checkout)) return { at: "unread", fault: null };
	const { root } = checkout;
	/** @param {string} ref */
	const walk = (ref) =>
		gitOutcome(["rev-list", "--max-count=1", c.landed, "--not", ref], [], root);
	const pushed = pushedRef({ root });
	const onMain = walk(VERIFIED_REF);
	const onPushed = onMain.ok && onMain.out !== "" ? walk(pushed) : onMain;
	if (!onPushed.ok)
		return {
			at: "unread",
			fault: {
				tag: "UNJUDGED",
				fault: `${c.repo}#${c.issue}: could not walk landed ${c.landed} against ${VERIFIED_REF} and ${pushed} in ${root}, so whether it reached main is not judged until that checkout holds it — ${onPushed.why}`,
			},
		};
	if (onMain.ok && onMain.out === "") return { at: "main" };
	return { at: onPushed.out === "" ? "landing" : "off" };
}

/**
 * `recorded` less each commit `origin/main` does not hold, and the reports its
 * records owe: a sha off every ref that no later review corrects, and the
 * header's A RECORD NAMING THE LANDED TREE. One line where both find git failing
 * on one commit (#3544).
 *
 * @param {ReviewRecord[]} recorded
 * @param {string} home
 * @returns {{ commits: ReviewRecord[], recordFaults: RecordFault[] }}
 */
function judgeRecords(recorded, home) {
	const landed = new Map(recorded.map((c) => [c, readLandedAt(c, home)]));
	const atOf = (/** @type {ReviewRecord} */ c) => landed.get(c)?.at;
	const recordFaults = recorded.flatMap((c) => {
		const tree = landedTreeReport(c, home);
		const at = landed.get(c);
		/** @type {RecordFault[]} */
		const owed = tree ? [tree] : [];
		if (at?.at === "unread") {
			if (at.fault && tree?.tag !== "UNJUDGED") owed.push(at.fault);
		} else if (
			at?.at === "off" &&
			!recorded.some(
				(o) =>
					o !== c &&
					o.repo === c.repo &&
					o.issue === c.issue &&
					atOf(o) !== "off" &&
					isSameReview(o, c),
			)
		)
			owed.push({
				tag: "OFF MAIN",
				fault: `${c.repo}#${c.issue} has a record naming landed ${c.landed}, which never reached main, so its commit is not counted until it is corrected: post a record naming the sha it landed under, as \`scripts/lib/rule-text.sh review-tier-records\` says`,
			});
		return owed;
	});
	return {
		commits: recorded.filter((c) => atOf(c) === "main" || atOf(c) === "unread"),
		recordFaults,
	};
}

/**
 * The report the header's A RECORD NAMING THE LANDED TREE owes `c`'s record,
 * judged in the checkout under `home`: UNJUDGED where git fails there (#3544),
 * null where it owes none.
 *
 * @param {ReviewRecord} c
 * @param {string} home
 * @returns {RecordFault | null}
 */
function landedTreeReport(c, home) {
	if (c.fixes === 0 || c.paths === null || c.posted < PINNED_FROM) return null;
	const checkout = readCheckoutTracking(c.repo, home);
	if (!("root" in checkout)) return null;
	const paths = pathListOf(c.paths);
	const diff = gitOutcome(
		[
			"--literal-pathspecs",
			"diff",
			"--name-only",
			c.tree,
			c.landed,
			"--",
			...paths,
		],
		[],
		checkout.root,
	);
	if (!diff.ok)
		return {
			tag: "UNJUDGED",
			fault: `${c.repo}#${c.issue}: could not diff reviewed ${c.tree} against landed ${c.landed} in ${checkout.root}, so whether its record names the landed tree is not judged until that checkout holds both — ${diff.why}`,
		};
	if (diff.out !== "") return null;
	return {
		tag: "LANDED TREE",
		fault: `${c.repo}#${c.issue} has a record naming reviewed ${c.tree}, the tree landed ${c.landed} carries on its paths, so a replay finds none of its fixed defects: name the tree pinned before the first round's dispatch, as \`scripts/lib/rule-text.sh review-tier-records\` says`,
	};
}

/**
 * The shas the reverts on `repo`'s default branch since FLOOR name, less
 * each whose revert was itself reverted. Commit search reads the default
 * branch alone.
 *
 * @param {string} repo
 */
function readRevertedShas(repo) {
	/** @type {Map<string, string[]>} each target to the commits reverting it */
	const reverts = new Map();
	/* A revert postdates its target, which postdates FLOOR. */
	const q = `"This reverts commit" repo:${repo} committer-date:>=${FLOOR}`;
	/** @type {{ total_count: number, items: { sha: string, commit: { message: string } }[] }[]} */
	const pages = ghApiSlurp([
		`search/commits?q=${encodeURIComponent(q)}&per_page=${PAGE}`,
	]);
	const first = pages[0];
	if (!first) throw new Error(`${repo}: revert search returned no page`);
	const items = pages.flatMap((p) => p.items);
	if (items.length !== first.total_count)
		throw new Error(
			`${repo}: revert search returned ${items.length} of ${first.total_count} hits`,
		);
	for (const c of items)
		for (const m of c.commit.message.matchAll(REVERTS)) {
			const target = requiredGroup(m, 1, REVERTS);
			reverts.set(target, [...(reverts.get(target) ?? []), c.sha]);
		}
	/** @param {string} sha @returns {boolean} */
	const isReverted = (sha) =>
		(reverts.get(sha) ?? []).some((r) => !isReverted(r));
	return [...reverts.keys()].filter(isReverted);
}

/** @param {ReviewRecord[]} commits */
function withoutReverted(commits) {
	const reverted = new Map(
		[...new Set(commits.map((c) => c.repo))].map((tracker) => [
			tracker,
			readRevertedShas(tracker),
		]),
	);
	return commits.filter(
		(c) => !reverted.get(c.repo)?.some((s) => isSameSha(s, c.landed)),
	);
}

/** @param {ReviewRecord[]} commits */
function buildBody(commits) {
	return [
		`${commits.length} commits on adopter-declared sensitive paths, reviewed at the escalated or mission-critical tier, now carry a known defect: a finding fixed or ticketed, or an escaped defect recorded later. At ${THRESHOLD}, focused against identical review runs (#1545) is re-measured on real code (spec #1612 §The re-measure trigger).`,
		"",
		...commits.map((c) =>
			c.issue === null
				? `- ${c.repo}@${c.landed}: Review-Tier: trailer alone, base ${c.base}, landed tree ${c.tree}, paths ${c.paths}; ${c.escaped} escaped`
				: `- ${c.repo}#${c.issue}: landed ${c.landed}, base ${c.base}, tree ${c.tree}${c.paths === null ? "" : `, paths ${c.paths}`}; ${c.fixed} fixed or ticketed, ${c.escaped} escaped`,
		),
		"",
		"Kept current daily by `scripts/report-remeasure-due.js` (#1625), which never files a second.",
	].join("\n");
}

/** @param {unknown} e */
const remedy = (e) =>
	parseGhFailureReason(e) === "unreachable" ? `${unreachableRemedy(e)} ` : "";

/**
 * A fault on the filing run (#1698): one line in the arbiter's error log,
 * which `npm run check:guard-errors` reports.
 *
 * @param {string} fault
 * @param {string} next what was left undone and what retries it
 */
function failOpen(fault, next) {
	logError(WHERE, fault);
	writeFd(
		2,
		`FAILED OPEN: ${fault} — recorded in the guard-error log.\n${next}\n`,
	);
}

/**
 * A faulty record, or one its checkout cannot judge: one line to stderr and
 * to the guard-error log, each run until it is corrected or can be judged.
 *
 * @param {RecordFault} record
 */
function reportRecord({ tag, fault }) {
	logError(WHERE, fault);
	writeFd(2, `${tag}: ${fault}\n`);
}

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: "usage: node scripts/report-remeasure-due.js",
	});
	const root = hostRoot();
	const home = homeDir();
	let commits;
	let unparsed;
	let faults;
	try {
		({ commits, unparsed, faults } = countedCommits(
			/** @type {string[]} */ (resolveKey("corpus", { root })),
			day(now()),
			home,
		));
	} catch (e) {
		failOpen(
			`could not read the corpus — ${parseErrLine(e)}`,
			`${remedy(e)}Nothing was filed; the next day's run retries.`,
		);
		return;
	}
	for (const u of unparsed)
		reportRecord({
			tag: "UNPARSEABLE",
			fault: `${u.repo}#${u.issue} has a record not in \`scripts/lib/rule-text.sh review-tier-records\`'s form, so its commit is not counted until it is corrected: ${u.line}`,
		});
	for (const r of faults) reportRecord(r);
	const own = resolveKey("tracker", { root });
	commits = commits.filter((c) => c.repo !== own);
	let existing;
	try {
		existing = findTrackingIssue({ title: TITLE }, "all");
	} catch (e) {
		failOpen(
			`could not file or refresh "${TITLE}" — ${parseErrLine(e)}`,
			`${remedy(e)}The next day's run retries.`,
		);
		return;
	}
	if (!existing && commits.length < THRESHOLD) return;
	try {
		commits = withoutReverted(commits);
	} catch (e) {
		failOpen(
			`could not read the corpus's reverts — ${parseErrLine(e)}`,
			`${remedy(e)}Nothing was filed; the next day's run retries.`,
		);
		return;
	}
	const due = commits.length >= THRESHOLD;
	if (!existing && !due) return;
	const text = buildBody(commits);
	/* No PreToolUse hook sees a script's own gh call, so the create guard's
	 * takes: check is made here. */
	const refused = takesRefusal([LABEL], text);
	if (refused) {
		failOpen(refused, "Nothing was filed.");
		return;
	}
	try {
		if (existing) refresh(existing.number, text);
		const did = existing
			? `Refreshed #${existing.number}`
			: `Filed ${createIssue({ title: TITLE, labels: [LABEL], body: text })}`;
		if (due)
			writeFd(
				1,
				`Re-measure due: ${commits.length} counted commits. ${did}.\n`,
			);
	} catch (e) {
		/* Not e.message: a failed gh call's message holds its whole argv, the body
		 * included. */
		failOpen(
			`could not file or refresh "${TITLE}" — ${parseErrLine(e)}`,
			`${remedy(e)}The next day's run retries.`,
		);
	}
}

if (require.main === module) main();
