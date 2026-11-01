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
 * corpus naming its landed sha or a commit it covers (below). One commit
 * recorded twice, by a short sha or a full one, is counted once, its defects
 * summed. A commit a revert on `main` names is not counted, unless that revert
 * was itself reverted: searched in the tracker's repo only once the count
 * reaches the threshold or an issue of TITLE exists to refresh, since dropping
 * one can only lower it (#3395). Residual: an adopter's code
 * repo apart from its tracker is not searched.
 *
 * A RECORD WHOSE LANDED SHA IS NOT ON `origin/main`, once fetched, in the
 * checkout on this machine that tracks the record's repo, is not counted
 * (#3846). One the pushed ref (lib/landing-refs.js), fetched with it, holds is
 * legal and silent, as a close posts it there without waiting for the lander.
 * One on neither, as a replay onto `landing` can leave it, is reported as OFF
 * MAIN each run until a record of the same review on its ticket names a sha
 * that is on one. A sha that checkout does not hold is reported as UNJUDGED and
 * counted; a record with no such checkout is counted, unreported. A checkout
 * that cannot fetch is judged at the refs it last fetched, and reported as
 * UNREAD.
 *
 * AN ESCAPE ON A COVERED COMMIT counts once on the first counted record
 * covering it, where no counted commit names it as landed (#3832). A commit
 * carrying a trailer that a counted record covers adds no row of its own, so
 * its escape counts on that record. A revert takes only what it names (#3832):
 * of a covered commit, the escape credited through it, its record standing as
 * its tip is on `main`; of the tip, the record's findings and an escape on the
 * tip, a row standing only on an escape through a commit still there, marked
 * as its tip reverted. An escape no checkout on this machine holds, and no
 * counted commit names, is reported as UNLOCATED, and one on an adopter's commit
 * no counted record covers, a merge or a lower tier's included, as UNCOUNTED,
 * each run until the line is corrected or something answers for it.
 *
 * A COMMIT CARRYING A `Review-Tier:` TRAILER, whose value the review hold
 * builds from its marker (scripts/review-hold-gate.sh) and
 * .husky/prepare-commit-msg writes (scripts/review-tier-trailer.sh), is
 * counted by it where no counted record covers it, and once where one does (#3664).
 * Its trailer names no defect, so it counts only once an `**Escaped defect:**`
 * line names it, and its tree is the landed one, never the pinned pre-fix
 * tree. Read with `git log` in the checkout on this machine that tracks the
 * record's repo, at `origin/main` once fetched, from TRAILER_FROM, since the
 * lander moves `main` and nothing obliges that checkout's HEAD to hold the
 * commits being judged (#3819); there, a commit that changes a path
 * `sensitivePaths` declares at that ref and carries neither the trailer nor a
 * record is reported as UNRECORDED, each run until a record covers it, a
 * trailer not in its form as UNPARSEABLE, and a checkout git cannot fetch or
 * read as UNREAD. Judged from that fixed instant, not the repo's own first
 * trailer, as a repo whose sessions never write a marker, or an adopter pinned
 * before #3664, would never have one (#3714).
 * A RECORD COVERS ITS TICKET'S COMMITS, so one record owes no twin per commit:
 * its landed sha, and each commit in its `base..landed` whose message cites
 * its ticket, a citation alone reaching a later commit's passing mention and
 * the range alone a neighbour's (#3819). A commit an unparseable record names
 * as landed is reported by that record, never as UNRECORDED too.
 * A record whose range git cannot read there covers only its landed sha, and
 * is reported as UNREAD.
 * Residual: a repo with no such checkout goes unread, a repo whose branch is
 * not `main` reads as UNREAD, an `origin` that is a fork of the tracked repo is
 * judged as it, a record's range spans landing merges so a neighbour's commit
 * there citing its ticket reads as covered, and a commit from the founder's own terminal, which
 * the hold skips, or a linked worktree's whose marker would not pass, is
 * reported.
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
 * A RECORD WITH CUT-OFF LINES — `- FIXED` or `- TICKETED` lines, under a counted
 * tier, past a line that ends its list, which resolve-ticket.js refuses at a close
 * and a separate `gh issue comment` can still post — counts none of those lines
 * and is reported each run until a later record restates it (#3847): one under a
 * counted tier with none cut off, at least as many lines as the earlier held in
 * all, and the same reviewed tree, or the same base, paths and landed sha, as two
 * commits from one base over the same paths are separate reviews here. What the
 * earlier one did count is then dropped rather than summed with the restatement.
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
 * ordinary review reports match it (#1625). A ticket past 100 comments has the rest
 * read by REST. A window holding more than search's 1,000-result cap is
 * halved by date until each half fits, a single day past it throwing, and a
 * window whose pages return fewer tickets than its count throws.
 *
 * AT THRESHOLD it files TITLE, `takes:wayfinder`, listing each counted
 * commit; while an issue of that title exists, open or closed, it only
 * rewrites that issue's body, never filing a second, below the threshold too,
 * since a gate reads the count from its first line (#3576). Found by title
 * alone, since the session that takes it may relabel it. Below the threshold
 * it prints nothing but those reports. A run that undercounts — an adopter's
 * checkout UNREAD, or an escape on an adopter's commit that a git failure or a
 * citing record's unread range leaves unplaced — leaves an issue whose first
 * line it would lower, reported as HELD, and the next run retries (#3832). This
 * repo's own tracker holds nothing, its commits never being counted. A record's
 * unread range that no escape rests on holds nothing. Residual: a real drop
 * waits until the read recovers, and a repo with no checkout at all lowers the
 * count, as a corpus tracker this machine never held is no failed read.
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
	gh,
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
const { LANDING_REF, pushedRef } = require("./lib/landing-refs");
const { requiredGroup } = require("./lib/regex-group");
const {
	COUNTED_TIERS,
	day,
	describeCutOff,
	group,
	HEX_RUN,
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
/* review-hold-gate.sh's value: the hold's tier, areas, base, tree and paths. */
const TRAILER =
	/^(escalated|mission-critical);\s*areas=[^;]*;\s*base=([0-9a-f]{40});\s*tree=([0-9a-f]{40});\s*paths=(.+)$/;
/* `git revert`'s own message line, which names the full sha. */
const REVERTS = /^This reverts commit ([0-9a-f]{40})\b/gm;
const JUDGED_REF = "refs/remotes/origin/main";
/* An unparseable record's landed clause, a sha anywhere in it: "landed pending
 * (5d3f65283 on `landing`)". Residual: a hex-only word ahead of the sha reads
 * as it, so that commit stays reported as UNRECORDED too. */
const LANDED_CLAUSE = new RegExp(`\\blanded\\b[^,]*?\\b(${HEX_RUN})\\b`);

/* buildBody's first line, whose count a gate reads (#3576). */
const COUNT_LINE = /^(\d+) commits\b/;

/**
 * @typedef {import("./lib/review-findings").Comment} Comment
 * @typedef {import("./lib/review-findings").ReviewRecord} ReviewRecord
 * @typedef {import("./lib/review-findings").Unparsed} Unparsed
 * @typedef {{ records: ReviewRecord[], unparsed: Unparsed[] }} Parsed every
 *   record parsed, of any tier, and the unparseable ones under a counted tier
 * @typedef {{ tag: "UNRECORDED" | "UNPARSEABLE" | "UNREAD" | "UNLOCATED" | "UNCOUNTED", fault: string }} Unseen
 * @typedef {{ tag: Unseen["tag"] | "CUT OFF" | "LANDED TREE" | "UNJUDGED" | "OFF MAIN" | "HELD", fault: string }} Report
 * @typedef {{ isCoveredBy: (r: ReviewRecord, sha: string, message: string, root: string) => boolean,
 *   isRangeLost: (r: ReviewRecord, message: string) => boolean,
 *   rangeFaults: Unseen[] }} RecordCover
 * @typedef {{ isCovered: (sha: string, message: string) => boolean,
 *   isOnCountedRecord: (sha: string, message: string) => boolean }} CommitJudge
 * @typedef {{ trackers: string[], own: unknown, parsed: Parsed, cover: RecordCover, home: string }} Reading
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
 * @param {ReviewRecord[]} commits
 * @param {ReviewRecord} r
 */
const findCommitRow = (commits, r) =>
	commits.find((c) => c.repo === r.repo && isSameSha(c.landed, r.landed));

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
 * The commits from TRAILER_FROM at a fresh `origin/main` in the checkout under
 * `home` that tracks `repo`, those carrying a trailer as records, and the
 * sensitive ones no record covers; none where no checkout tracks it.
 *
 * @param {string} repo
 * @param {Reading} reading
 * @returns {{ trailers: ReviewRecord[], unseen: Unseen[] }}
 */
function readTrailers(repo, { parsed, cover, home }) {
	const checkout = readCheckoutTracking(repo, home);
	/** @param {string} where @param {string} why @returns {{ trailers: ReviewRecord[], unseen: Unseen[] }} */
	const buildUnread = (where, why) => ({
		trailers: [],
		unseen: [
			{
				tag: "UNREAD",
				fault: `${repo}: could not read its commits' Review-Tier: trailers ${where}, so none is counted and none unrecorded reported — ${why}`,
			},
		],
	});
	if (!("root" in checkout))
		return checkout.unreadable
			? buildUnread(`under ${home}`, checkout.why)
			: { trailers: [], unseen: [] };
	const { root } = checkout;
	const inRoot = `in ${root}`;
	const fetched = fetchJudgedRef(root);
	if (!fetched.ok) return buildUnread(inRoot, fetched.why);
	const log = gitOutcome(
		[
			"-c",
			"core.quotePath=false",
			"log",
			"--no-merges",
			"--no-renames",
			`--since=${TRAILER_FROM}`,
			"--format=%x00%H%x1f%(trailers:key=Review-Tier,valueonly,unfold)%x1f%B%x1f",
			"--name-only",
			JUDGED_REF,
		],
		[],
		root,
	);
	if (!log.ok) return buildUnread(inRoot, log.why);
	let declared;
	try {
		declared = readConfig({
			root,
			rev: JUDGED_REF,
			quiet: true,
		}).sensitivePaths;
	} catch (e) {
		return buildUnread(inRoot, parseErrLine(e));
	}
	return parseTrailerLog(
		repo,
		log.out,
		declared,
		buildCommitJudge(repo, parsed, cover, root),
	);
}

/**
/**
 * Moves JUDGED_REF and the pushed ref to the remote's branches, in a checkout
 * other sessions share.
 *
 * @param {string} root
 */
function fetchJudgedRef(root) {
	return gitOutcome(
		[
			"fetch",
			"--quiet",
			"--no-tags",
			/* A daily reader starts no gc under its neighbours. */
			"--no-auto-maintenance",
			"origin",
			`+refs/heads/main:${JUDGED_REF}`,
			...(pushedRef({ root }) === LANDING_REF
				? [`+refs/heads/landing:refs/remotes/${LANDING_REF}`]
				: []),
		],
		[],
		root,
	);
}

/**
 * The header's A RECORD COVERS ITS TICKET'S COMMITS, one per run so a record's
 * range is read, and its fault reported, once.
 *
 * @returns {RecordCover}
 */
function buildRecordCover() {
	/** @type {Unseen[]} */
	const rangeFaults = [];
	/** @type {Map<ReviewRecord, string[]>} */
	const ranges = new Map();
	/** @type {Set<ReviewRecord>} */
	const lost = new Set();
	/**
	 * The lookbehind leaves another repo's `mantahostels#9` to that repo.
	 *
	 * @param {ReviewRecord} r
	 * @param {string} message
	 */
	const isCited = (r, message) =>
		new RegExp(`(?<![\\w/#-])#${r.issue}(?!\\d)`).test(message);
	/** @param {ReviewRecord} r @param {string} root */
	const readRange = (r, root) => {
		let shas = ranges.get(r);
		if (!shas) {
			const read = gitOutcome(
				["rev-list", "--no-merges", `${r.base}..${r.landed}`],
				[],
				root,
			);
			shas = read.ok ? read.out.split("\n") : [];
			if (!read.ok) {
				lost.add(r);
				rangeFaults.push({
					tag: "UNREAD",
					fault: `${r.repo}#${r.issue}: could not read its record's range ${r.base}..${r.landed} in ${root}, so it covers only its landed sha — ${read.why}`,
				});
			}
			ranges.set(r, shas);
		}
		return shas;
	};
	return {
		isCoveredBy: (r, sha, message, root) =>
			isSameSha(r.landed, sha) ||
			(isCited(r, message) && readRange(r, root).includes(sha)),
		isRangeLost: (r, message) => lost.has(r) && isCited(r, message),
		rangeFaults,
	};
}

/**
 * Whether a commit is one a record of `repo` covers, or an unparseable
 * record's report already names; and whether a counted record covers it.
 *
 * @param {string} repo
 * @param {Parsed} parsed
 * @param {RecordCover} cover
 * @param {string} root the checkout git reads each record's range in
 * @returns {CommitJudge}
 */
function buildCommitJudge(repo, { records, unparsed }, cover, root) {
	const own = records.filter((r) => r.repo === repo);
	const reported = unparsed
		.filter((u) => u.repo === repo)
		.flatMap((u) => {
			const m = LANDED_CLAUSE.exec(u.line);
			return m ? [group(m, 1, LANDED_CLAUSE)] : [];
		});
	return {
		isCovered: (sha, message) =>
			reported.some((s) => isSameSha(s, sha)) ||
			own.some((r) => cover.isCoveredBy(r, sha, message, root)),
		isOnCountedRecord: (sha, message) =>
			own.some(
				(r) =>
					COUNTED_TIERS.has(r.tier) &&
					(cover.isCoveredBy(r, sha, message, root) ||
						cover.isRangeLost(r, message)),
			),
	};
}

/**
 * readTrailers's reading of `out`, the `git log` it ran.
 *
 * @param {string} repo
 * @param {string} out
 * @param {import("./lib/workflow-core-config").SensitivePath[] | undefined} declared
 * @param {CommitJudge} judge
 * @returns {{ trailers: ReviewRecord[], unseen: Unseen[] }}
 */
function parseTrailerLog(repo, out, declared, judge) {
	const commits = out
		.split("\0")
		.slice(1)
		.map((chunk) => {
			const [sha, value = "", message = "", names = ""] = chunk.split("\x1f");
			if (!sha) throw new Error(`${repo}: a git log entry named no sha`);
			const [trailer = ""] = value.split("\n");
			return { sha, trailer: trailer.trim(), message, names };
		});
	/** @type {ReviewRecord[]} */
	const trailers = [];
	/** @type {Unseen[]} */
	const unseen = [];
	for (const { sha, trailer, message, names } of commits) {
		const m = TRAILER.exec(trailer);
		if (m) {
			if (judge.isOnCountedRecord(sha, message)) continue;
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
				escapes: [],
			});
			continue;
		}
		if (trailer !== "") {
			unseen.push({
				tag: "UNPARSEABLE",
				fault: `${repo}@${sha} has a Review-Tier: trailer not in scripts/review-hold-gate.sh's form, so it is not counted by it: ${trailer}`,
			});
			continue;
		}
		const areas = matchSensitivePaths(
			declared,
			names.split("\n").filter(Boolean),
		).matched.map((a) => a.name);
		if (areas.length > 0 && !judge.isCovered(sha, message))
			unseen.push({
				tag: "UNRECORDED",
				fault: `${repo}@${sha} changes the sensitive area${areas.length > 1 ? "s" : ""} ${areas.join(", ")} and carries neither a Review-Tier: trailer nor a **Review findings:** record, so nothing answers for it until a record names it as landed, or its message cites that record's ticket within the record's base..landed; \`scripts/lib/rule-text.sh review-tier-records\` gives the record's form`,
			});
	}
	return { trailers, unseen };
}

/**
 * Appends to `commits` each commit known by its trailer alone, returning the
 * sensitive commits no record or trailer names, and the checkouts unread.
 *
 * @param {ReviewRecord[]} commits accumulator: each trailer commit no counted
 *   record covers is appended
 * @param {Reading} reading
 * @returns {{ unseen: Unseen[], undercounts: boolean }}
 */
function addTrailerCommits(commits, reading) {
	/** @type {Unseen[]} */
	const unseen = [];
	let undercounts = false;
	for (const repo of reading.trackers) {
		const found = readTrailers(repo, reading);
		unseen.push(...found.unseen);
		commits.push(...found.trailers);
		undercounts ||=
			repo !== reading.own && found.unseen.some((u) => u.tag === "UNREAD");
	}
	return { unseen, undercounts };
}

/**
 * The commit `s` names in the checkout at `root`, its `sha` empty where that
 * checkout holds none.
 *
 * @param {string} s
 * @param {string} root
 * @returns {{ ok: true, sha: string, message: string } | { ok: false, why: string }}
 */
function readEscapedCommit(s, root) {
	const resolved = gitOutcome(
		["rev-parse", "--verify", "--quiet", `${s}^{commit}`],
		[1],
		root,
	);
	if (!resolved.ok) return resolved;
	const sha = resolved.out.trim();
	if (sha === "") return { ok: true, sha, message: "" };
	const read = gitOutcome(["log", "-1", "--format=%B", sha], [], root);
	return read.ok ? { ok: true, sha, message: read.out } : read;
}

/**
 * Places `s`, an escaped sha no commit names as landed, on the first counted
 * record covering it in the checkouts that hold it.
 *
 * @param {string} s
 * @param {ReviewRecord[]} commits accumulator: the credited commit's `escapes`
 *   gains the sha
 * @param {{ repo: string, root: string }[]} checkouts
 * @param {Reading} reading
 * @returns {{ isAccountedFor: boolean, faults: Unseen[], undercounts: boolean }}
 */
function placeEscape(s, commits, checkouts, { parsed, cover, own }) {
	/** @type {Unseen[]} */
	const faults = [];
	let isAccountedFor = false;
	let undercounts = false;
	for (const { repo, root } of checkouts) {
		const read = readEscapedCommit(s, root);
		if (!read.ok) {
			undercounts ||= repo !== own;
			isAccountedFor = true;
			faults.push({
				tag: "UNREAD",
				fault: `${repo}: could not read escaped ${s} in ${root}, so it counts on no record it covers — ${read.why}`,
			});
			continue;
		}
		const { sha, message } = read;
		if (sha === "") continue;
		isAccountedFor = true;
		const counted = parsed.records.filter(
			(c) => COUNTED_TIERS.has(c.tier) && c.repo === repo,
		);
		const r = counted.find((c) => cover.isCoveredBy(c, sha, message, root));
		const commit = r && findCommitRow(commits, r);
		if (commit) {
			commit.escapes.push(s);
			return { isAccountedFor, faults, undercounts: false };
		}
		if (counted.some((c) => cover.isRangeLost(c, message)))
			undercounts ||= repo !== own;
		else if (repo !== own)
			faults.push({
				tag: "UNCOUNTED",
				fault: `${repo}: an **Escaped defect:** names ${s}, which no counted record covers, so it counts on nothing until a record covers it or the line is corrected`,
			});
	}
	return { isAccountedFor, faults, undercounts };
}

/**
 * Credits each escaped sha to the commits naming it as landed, or else as the
 * header's AN ESCAPE ON A COVERED COMMIT says. Across repos, not within one:
 * the line sits on the fixing ticket, which may live in another repo, and a
 * 7-hex prefix colliding is negligible.
 *
 * @param {ReviewRecord[]} commits accumulator: each credited commit's `escapes`
 *   gains the sha
 * @param {string[]} escaped
 * @param {Reading} reading
 * @returns {{ faults: Unseen[], undercounts: boolean }}
 */
function creditEscapes(commits, escaped, reading) {
	const checkouts = reading.trackers.flatMap((repo) => {
		const checkout = readCheckoutTracking(repo, reading.home);
		return "root" in checkout ? [{ repo, root: checkout.root }] : [];
	});
	/** @type {Map<string, Unseen>} one report a fault, however often it is named */
	const faults = new Map();
	let undercounts = false;
	for (const s of escaped) {
		const named = commits.filter((c) => isSameSha(s, c.landed));
		for (const c of named) c.escapes.push(s);
		if (named.length > 0) continue;
		const placed = placeEscape(s, commits, checkouts, reading);
		undercounts ||= placed.undercounts;
		for (const f of placed.faults) faults.set(f.fault, f);
		if (!placed.isAccountedFor) {
			const fault = `an **Escaped defect:** names ${s}, which no counted record names as landed and no checkout on this machine holds, so it counts on no record until a checkout holds it or the line is corrected`;
			faults.set(fault, { tag: "UNLOCATED", fault });
		}
	}
	return { undercounts, faults: [...faults.values()] };
}

/**
 * Where `c`'s landed sha is, in the checkout under `home`: read after
 * readTrailers's fetch. "unread" with no fault where no checkout tracks its repo.
 *
 * @param {ReviewRecord} c
 * @param {string} home
 * @returns {{ at: "main" | "landing" | "off" } | { at: "unread", fault: Report | null }}
 */
function readLandedAt(c, home) {
	const checkout = readCheckoutTracking(c.repo, home);
	if (!("root" in checkout)) return { at: "unread", fault: null };
	const { root } = checkout;
	/** @param {string} ref */
	const walk = (ref) =>
		gitOutcome(["rev-list", "--max-count=1", c.landed, "--not", ref], [], root);
	const pushed = pushedRef({ root });
	const onMain = walk(JUDGED_REF);
	const onPushed = onMain.ok && onMain.out !== "" ? walk(pushed) : onMain;
	if (!onPushed.ok)
		return {
			at: "unread",
			fault: {
				tag: "UNJUDGED",
				fault: `${c.repo}#${c.issue}: could not walk landed ${c.landed} against ${JUDGED_REF} and ${pushed} in ${root}, so whether it reached main is not judged until that checkout holds it — ${onPushed.why}`,
			},
		};
	if (onMain.ok && onMain.out === "") return { at: "main" };
	return { at: onPushed.out === "" ? "landing" : "off" };
}

/**
 * The rows the header's A RECORD WHOSE LANDED SHA IS NOT ON `origin/main` leaves
 * counted, a trailer's row being on it by its reading, and the reports each
 * record owes, that and A RECORD NAMING THE LANDED TREE's.
 *
 * @param {ReviewRecord[]} commits
 * @param {string} home
 * @returns {{ commits: ReviewRecord[], reports: Report[] }}
 */
function judgeRecords(commits, home) {
	const recorded = commits.filter((c) => c.issue !== null);
	const landed = new Map(recorded.map((c) => [c, readLandedAt(c, home)]));
	const reports = recorded.flatMap((c) => {
		const tree = landedTreeReport(c, home);
		const place = landed.get(c);
		/** @type {Report[]} */
		const owed = tree ? [tree] : [];
		if (place?.at === "unread") {
			if (place.fault && tree?.tag !== "UNJUDGED") owed.push(place.fault);
		} else if (
			place?.at === "off" &&
			!recorded.some(
				(o) =>
					o !== c &&
					o.repo === c.repo &&
					o.issue === c.issue &&
					landed.get(o)?.at !== "off" &&
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
		commits: commits.filter((c) => {
			const at = landed.get(c)?.at;
			return at === undefined || at === "main" || at === "unread";
		}),
		reports,
	};
}

/**
 * Whether `later` restates `r`, as the header's A RECORD WITH CUT-OFF LINES says.
 *
 * @param {ReviewRecord} later
 * @param {ReviewRecord} r
 */
const restates = (later, r) =>
	later.cutOff === 0 &&
	COUNTED_TIERS.has(later.tier) &&
	later.fixed >= r.fixed + r.cutOff &&
	isSameReview(later, r) &&
	(isSameSha(later.tree, r.tree) || isSameSha(later.landed, r.landed));

/**
 * One ticket's records as counted, and the reports the header's A RECORD WITH
 * CUT-OFF LINES owes them.
 *
 * @param {ReviewRecord[]} found in comment order
 * @returns {{ records: ReviewRecord[], faults: Report[] }}
 */
function settleCutOff(found) {
	/** @type {Report[]} */
	const faults = [];
	const records = found.map((r, i) => {
		if (r.cutOff === 0) return r;
		if (found.slice(i + 1).some((later) => restates(later, r)))
			return { ...r, fixed: 0, fixes: 0 };
		if (COUNTED_TIERS.has(r.tier))
			faults.push({
				tag: "CUT OFF",
				fault: `${r.repo}#${r.issue} has a record, landed ${r.landed}, with ${describeCutOff(r.cutOff)}, so they count 0 until it is corrected: post a record of the same review with its whole list straight under it and the prose after, as \`scripts/lib/rule-text.sh review-tier-records\` says`,
			});
		return r;
	});
	return { records, faults };
}

/**
 * The counted commits across `trackers`, in corpus order, then by ticket,
 * then those known by their trailer alone; the unparseable records under a
 * counted tier; and the faults of what was read: the cut-off records, the
 * sensitive commits no record or trailer names, then each record's own.
 *
 * @param {string[]} trackers
 * @param {string} today YYYY-MM-DD
 * @param {string} home
 * @param {unknown} own this repo's own tracker
 * @returns {{ commits: ReviewRecord[], unparsed: Unparsed[], reports: Report[], undercounts: boolean }}
 */
function countedCommits(trackers, today, home, own) {
	/** @type {ReviewRecord[]} */
	const records = [];
	/** @type {string[]} */
	const escaped = [];
	/** @type {Unparsed[]} */
	const unparsed = [];
	/** @type {Report[]} */
	const cutOffFaults = [];
	for (const repo of trackers) {
		const tickets = searchTickets(repo, FLOOR, today).sort(
			(a, b) => a.issue - b.issue,
		);
		for (const { issue, comments } of tickets) {
			const found = parseIssue(repo, issue, comments);
			const settled = settleCutOff(found.records);
			records.push(...settled.records);
			cutOffFaults.push(...settled.faults);
			escaped.push(...found.escaped);
			unparsed.push(...found.unparsed);
		}
	}
	/** @type {ReviewRecord[]} */
	const commits = [];
	for (const r of records) {
		if (!COUNTED_TIERS.has(r.tier)) continue;
		const seen = findCommitRow(commits, r);
		if (seen) mergeRecord(seen, r);
		else commits.push({ ...r });
	}
	const cover = buildRecordCover();
	const reading = {
		trackers,
		own,
		parsed: { records, unparsed },
		cover,
		home,
	};
	const trailered = addTrailerCommits(commits, reading);
	const credited = creditEscapes(commits, escaped, reading);
	const judged = judgeRecords(commits, home);
	return {
		commits: judged.commits.filter((c) => c.fixed + c.escapes.length > 0),
		unparsed,
		reports: [
			...cutOffFaults,
			...cover.rangeFaults,
			...trailered.unseen,
			...credited.faults,
			...judged.reports,
		],
		undercounts: credited.undercounts || trailered.undercounts,
	};
}

/**
 * The report the header's A RECORD NAMING THE LANDED TREE owes `c`'s record,
 * judged in the checkout under `home`: UNJUDGED where git fails there (#3544),
 * null where it owes none.
 *
 * @param {ReviewRecord} c
 * @param {string} home
 * @returns {Report | null}
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
			const target = group(m, 1, REVERTS);
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
	return commits.flatMap((c) => {
		/** @param {string} sha */
		const isGone = (sha) =>
			reverted.get(c.repo)?.some((s) => isSameSha(s, sha)) ?? false;
		const fixed = isGone(c.landed) ? 0 : c.fixed;
		const escapes = c.escapes.filter((s) => !isGone(s));
		return fixed + escapes.length > 0
			? [{ ...c, fixed, escapes, isTipReverted: isGone(c.landed) }]
			: [];
	});
}

/** @param {ReviewRecord[]} commits */
function buildBody(commits) {
	return [
		`${commits.length} commits on adopter-declared sensitive paths, reviewed at the escalated or mission-critical tier, now carry a known defect: a finding fixed or ticketed, or an escaped defect recorded later. At ${THRESHOLD}, focused against identical review runs (#1545) is re-measured on real code (spec #1612 §The re-measure trigger).`,
		"",
		...commits.map((c) =>
			c.issue === null
				? `- ${c.repo}@${c.landed}: Review-Tier: trailer alone, base ${c.base}, landed tree ${c.tree}, paths ${c.paths}; ${c.escapes.length} escaped`
				: `- ${c.repo}#${c.issue}: landed ${c.landed}, base ${c.base}, tree ${c.tree}${c.paths === null ? "" : `, paths ${c.paths}`}; ${c.fixed} fixed or ticketed, ${c.escapes.length} escaped${c.isTipReverted ? ", its tip reverted" : ""}`,
		),
		"",
		"Kept current daily by `scripts/report-remeasure-due.js` (#1625), which never files a second.",
	].join("\n");
}

/**
 * The count on the first line of issue `number`'s body, null where it holds
 * none.
 *
 * @param {number} number
 */
function readFiledCount(number) {
	const m = COUNT_LINE.exec(
		gh(["issue", "view", String(number), "--json", "body", "--jq", ".body"]),
	);
	return m ? Number(m[1]) : null;
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
 * A fault, or a refresh held: one line to stderr and to the guard-error log.
 *
 * @param {Report} report
 */
function writeReport({ tag, fault }) {
	logError(WHERE, fault);
	writeFd(2, `${tag}: ${fault}\n`);
}

/**
 * Files the tracking issue at the threshold, or refreshes `existing`, unless
 * the header's AT THRESHOLD holds it.
 *
 * @param {{ number: number } | null} existing
 * @param {ReviewRecord[]} commits
 * @param {boolean} undercounts
 */
function fileOrHold(existing, commits, undercounts) {
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
		if (existing && undercounts) {
			const filed = readFiledCount(existing.number);
			if (filed !== null && commits.length < filed) {
				writeReport({
					tag: "HELD",
					fault: `#${existing.number} stays at ${filed} commits, this run reading ${commits.length}; the next day's run retries`,
				});
				return;
			}
		}
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

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: "usage: node scripts/report-remeasure-due.js",
	});
	const root = hostRoot();
	const home = homeDir();
	const own = resolveKey("tracker", { root });
	let commits;
	let unparsed;
	let reports;
	let undercounts;
	try {
		({ commits, unparsed, reports, undercounts } = countedCommits(
			/** @type {string[]} */ (resolveKey("corpus", { root })),
			day(now()),
			home,
			own,
		));
	} catch (e) {
		failOpen(
			`could not read the corpus — ${parseErrLine(e)}`,
			`${remedy(e)}Nothing was filed; the next day's run retries.`,
		);
		return;
	}
	for (const u of unparsed)
		writeReport({
			tag: "UNPARSEABLE",
			fault: `${u.repo}#${u.issue} has a record not in \`scripts/lib/rule-text.sh review-tier-records\`'s form, so its commit is not counted until it is corrected: ${u.line}`,
		});
	for (const r of reports) writeReport(r);
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
	fileOrHold(existing, commits, undercounts);
}

if (require.main === module) main();
