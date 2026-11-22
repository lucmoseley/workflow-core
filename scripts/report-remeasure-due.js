#!/usr/bin/env node

const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
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
	SEARCH_CAP,
} = require("./lib/gh");
const { readCommit } = require("./lib/commit-sha");
const { gitOutcome, gitReader } = require("./lib/git");
const { matchSensitivePaths } = require("./lib/sensitive-paths");
const { hostRoot } = require("./lib/host-root");
const { homeDir, readCheckoutTracking } = require("./lib/refill-repos");
const { QUEUE_REFSPEC, QUEUE_TRACKING_GLOB } = require("./lib/landing-refs");
const { requiredGroup } = require("./lib/regex-group");
const {
	COUNTED_TIERS,
	day,
	group,
	HEX_RUN,
	isSameReview,
	isSameSha,
	parseIssue,
	pathListOf,
	readTicketComments,
	readRecordFaults,
	RULE_COMMAND,
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
// #1612 guess
const THRESHOLD = 15;
const FLOOR = "2026-10-14";
const PINNED_FROM = "2026-10-29";
const TRAILER_FROM = "2026-10-29T22:57:18+08:00";
// GitHub's largest page is 100: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
const PAGE = 100;
const DAY_MS = 86_400_000;

const PHRASES = '("Review tier" OR "Review findings" OR "Escaped defect")';
const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { number comments(first: ${PAGE}) { totalCount nodes { body createdAt } } } }
  }
}`;
const TRAILER =
	/^(escalated|mission-critical);\s*areas=[^;]*;\s*base=([0-9a-f]{40});\s*tree=([0-9a-f]{40});\s*paths=(.+)$/;
const REVERTS = /^This reverts commit ([0-9a-f]{40})\b/gm;
const JUDGED_REF = "refs/remotes/origin/main";
const LANDED_CLAUSE = new RegExp(`\\blanded\\b[^,]*?\\b(${HEX_RUN})\\b`);

const DELETE_RECORD =
	"edit the old comment to delete that record's **Review findings:** head and its list";
const SHARES_REVIEW = "sharing its reviewed tree, or its base and paths";

const COUNT_LINE = /^(\d+) commits\b/;

/**
 * @typedef {import("./lib/review-findings").Comment} Comment
 * @typedef {import("./lib/review-findings").ReviewRecord} ReviewRecord
 * @typedef {import("./lib/review-findings").Unparsed} Unparsed
 * @typedef {import("./lib/review-findings").RecordFault} RecordFault
 * @typedef {{ records: ReviewRecord[], unparsed: Unparsed[] }} Parsed
 * @typedef {{ tag: "UNRECORDED" | "UNPARSEABLE" | "UNREAD" | "UNLOCATED" | "UNCOUNTED", fault: string }} Unseen
 * @typedef {{ tag: Unseen["tag"] | RecordFault["tag"] | "UNKNOWN TIER" | "LANDED TREE" | "OFF MAIN" | "HELD", fault: string }} Report
 * @typedef {{ isCoveredBy: (r: ReviewRecord, sha: string, message: string, root: string) => boolean, isRangeLost: (r: ReviewRecord, message: string) => boolean, rangeFaults: Unseen[] }} RecordCover
 * @typedef {{ isCovered: (sha: string, message: string) => boolean, isOnCountedRecord: (sha: string, message: string) => boolean }} CommitJudge
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
 * @param {string} repo
 * @param {string} from
 * @param {string} to
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
 * @param {ReviewRecord} seen
 * @param {ReviewRecord} from
 */
function takeReplay(seen, from) {
	if (from.landed.length > seen.landed.length) seen.landed = from.landed;
	if (seen.paths === null && from.paths !== null)
		Object.assign(seen, {
			issue: from.issue,
			base: from.base,
			tree: from.tree,
			paths: from.paths,
			posted: from.posted,
		});
}

/**
 * @param {ReviewRecord} seen
 * @param {ReviewRecord} r
 */
function mergeRecord(seen, r) {
	seen.fixed += r.fixed;
	seen.fixes += r.fixes;
	takeReplay(seen, r);
}

/**
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

/** @param {string} root */
function fetchJudgedRef(root) {
	return gitOutcome(
		[
			"fetch",
			"--quiet",
			"--no-tags",
			"--no-auto-maintenance",
			"--prune",
			"origin",
			`+refs/heads/main:${JUDGED_REF}`,
			QUEUE_REFSPEC,
		],
		[],
		root,
	);
}

/** @returns {RecordCover} */
function buildRecordCover() {
	/** @type {Unseen[]} */
	const rangeFaults = [];
	/** @type {Map<ReviewRecord, string[]>} */
	const ranges = new Map();
	/** @type {Set<ReviewRecord>} */
	const lost = new Set();
	/**
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
 * @param {string} repo
 * @param {Parsed} parsed
 * @param {RecordCover} cover
 * @param {string} root
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
				misspelt: 0,
				escapes: [],
			});
			continue;
		}
		if (trailer !== "") {
			unseen.push({
				tag: "UNPARSEABLE",
				fault: `${repo}@${sha} has a Review-Tier: trailer not in scripts/review-hold-gate.js's form, so it is not counted by it: ${trailer}`,
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
				fault: `${repo}@${sha} changes the sensitive area${areas.length > 1 ? "s" : ""} ${areas.join(", ")} and carries neither a Review-Tier: trailer nor a **Review findings:** record, so nothing answers for it until a record names it as landed, or its message cites that record's ticket within the record's base..landed; ${RULE_COMMAND} gives the record's form`,
			});
	}
	return { trailers, unseen };
}

/**
 * @param {ReviewRecord[]} commits
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
 * @param {string} s
 * @param {string} root
 * @returns {{ ok: true, sha: string | null, message: string } | { ok: false, why: string }}
 */
function readEscapedCommit(s, root) {
	const resolved = readCommit(gitReader(root), s);
	if (!resolved.ok) return resolved;
	const { sha } = resolved;
	if (sha === null) return { ok: true, sha, message: "" };
	const read = gitOutcome(["log", "-1", "--format=%B", sha], [], root);
	return read.ok ? { ok: true, sha, message: read.out } : read;
}

/**
 * @param {string} s
 * @param {ReviewRecord[]} commits
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
		if (sha === null) continue;
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
				fault: `${repo}: an **Escaped defect:** names ${s}, which no counted record covers, so it counts on nothing until a record covers it or the line is edited in its comment`,
			});
	}
	return { isAccountedFor, faults, undercounts };
}

/**
 * @param {ReviewRecord[]} commits
 * @param {string[]} escaped
 * @param {Reading} reading
 * @returns {{ faults: Unseen[], undercounts: boolean }}
 */
function creditEscapes(commits, escaped, reading) {
	const checkouts = reading.trackers.flatMap((repo) => {
		const checkout = readCheckoutTracking(repo, reading.home);
		return "root" in checkout ? [{ repo, root: checkout.root }] : [];
	});
	/** @type {Map<string, Unseen>} */
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
			const fault = `an **Escaped defect:** names ${s}, which no counted record names as landed and no checkout on this machine holds, so it counts on no record until a checkout holds it or the line is edited in its comment`;
			faults.set(fault, { tag: "UNLOCATED", fault });
		}
	}
	return { undercounts, faults: [...faults.values()] };
}

/**
 * @param {ReviewRecord} c
 * @param {string} home
 * @returns {{ at: "main" | "queued" | "off" | "unread" } | { at: "unheld", fault: Report }}
 */
function readLandedAt(c, home) {
	const checkout = readCheckoutTracking(c.repo, home);
	if (!("root" in checkout)) return { at: "unread" };
	const { root } = checkout;
	/** @param {string} ref */
	const walk = (ref) =>
		gitOutcome(["rev-list", "--max-count=1", c.landed, "--not", ref], [], root);
	const onMain = walk(JUDGED_REF);
	const onPushed =
		onMain.ok && onMain.out !== ""
			? walk(`--glob=${QUEUE_TRACKING_GLOB}`)
			: onMain;
	if (!onPushed.ok)
		return {
			at: "unheld",
			fault: {
				tag: "UNJUDGED",
				fault: `${c.repo}#${c.issue}: could not walk landed ${c.landed} against ${JUDGED_REF} and ${QUEUE_TRACKING_GLOB} in ${root}, so its commit is not counted until that checkout holds it or a record under a counted tier, ${SHARES_REVIEW}, names a sha it holds; where the correction changes both, ${DELETE_RECORD} — ${onPushed.why}`,
			},
		};
	if (onMain.ok && onMain.out === "") return { at: "main" };
	return { at: onPushed.out === "" ? "queued" : "off" };
}

/**
 * @param {ReviewRecord[]} commits
 * @param {string} home
 * @param {unknown} own
 * @returns {{ commits: ReviewRecord[], reports: Report[], undercounts: boolean }}
 */
function judgeRecords(commits, home, own) {
	const recorded = commits.filter((c) => c.issue !== null);
	const landed = new Map(recorded.map((c) => [c, readLandedAt(c, home)]));
	/** @param {ReviewRecord} c */
	const isCorrected = (c) =>
		recorded.some((o) => {
			const at = landed.get(o)?.at;
			return (
				o !== c &&
				o.repo === c.repo &&
				o.issue === c.issue &&
				at !== "off" &&
				at !== "unheld" &&
				isSameReview(o, c)
			);
		});
	const reports = recorded.flatMap((c) => {
		const place = landed.get(c);
		if (place?.at === "unheld") return isCorrected(c) ? [] : [place.fault];
		const tree = landedTreeReport(c, home);
		/** @type {Report[]} */
		const owed = tree ? [tree] : [];
		if (place?.at === "off" && !isCorrected(c))
			owed.push({
				tag: "OFF MAIN",
				fault: `${c.repo}#${c.issue} has a record naming landed ${c.landed}, which never reached main, so its commit is not counted until it is corrected: post a record naming the sha it landed under, under a counted tier, ${SHARES_REVIEW}, as ${RULE_COMMAND} says; where the correction changes both, ${DELETE_RECORD}`,
			});
		return owed;
	});
	return {
		commits: commits.filter((c) => {
			const at = landed.get(c)?.at;
			return at === undefined || at === "main" || at === "unread";
		}),
		reports,
		undercounts: recorded.some(
			(c) =>
				c.repo !== own &&
				c.fixed + c.escapes.length > 0 &&
				landed.get(c)?.at === "unheld" &&
				!isCorrected(c),
		),
	};
}

/**
 * @param {ReviewRecord} later
 * @param {ReviewRecord} r
 */
const isRestatement = (later, r) =>
	COUNTED_TIERS.has(later.tier) &&
	later.fixed >= r.fixed + r.cutOff + r.misspelt &&
	isSameReview(later, r) &&
	(isSameSha(later.tree, r.tree) || isSameSha(later.landed, r.landed));

/**
 * @param {ReviewRecord[]} found
 * @param {string | null} root
 * @returns {{ records: ReviewRecord[], faults: Report[] }}
 */
function settleRecords(found, root) {
	/** @type {Report[]} */
	const faults = [];
	const judged = found.map((r) => ({
		r,
		owed: readRecordFaults(r, root),
		standing: { ...r },
	}));
	const records = judged.flatMap(({ r, owed, standing }, i) => {
		const withoutStray = owed.some((f) => f.tag === "NOT PATHS")
			? { ...standing, paths: null }
			: standing;
		const replacer = judged
			.slice(i + 1)
			.find(
				(later) =>
					later.owed.length === 0 &&
					(owed.length === 0 || isRestatement(later.r, r)) &&
					isSameSha(later.r.landed, r.landed) &&
					isSameReview(later.r, r),
			);
		if (replacer) {
			takeReplay(replacer.standing, withoutStray);
			return [];
		}
		if (owed.length === 0) return [standing];
		if (
			judged
				.slice(i + 1)
				.some((later) => later.owed.length === 0 && isRestatement(later.r, r))
		)
			return [{ ...withoutStray, fixed: 0, fixes: 0 }];
		for (const f of owed)
			faults.push({
				tag: f.tag,
				fault: `${r.repo}#${r.issue} has a record, landed ${r.landed}, ${f.what} until it is corrected: post a record of the same review ${f.fix}, as ${RULE_COMMAND} says. Of the same review means under a counted tier, sharing its reviewed tree, or its base, paths and landed sha, and holding all its FIXED and TICKETED lines. Where none can be posted, as a standard review owes none or a correction changes its tree and its base or paths, ${DELETE_RECORD}`,
			});
		return [withoutStray];
	});
	return { records, faults };
}

/**
 * @param {string[]} trackers
 * @param {string} today
 * @param {string} home
 * @param {unknown} own
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
	const settledFaults = [];
	for (const repo of trackers) {
		const checkout = readCheckoutTracking(repo, home);
		const root = "root" in checkout ? checkout.root : null;
		const tickets = searchTickets(repo, FLOOR, today).sort(
			(a, b) => a.issue - b.issue,
		);
		for (const { issue, comments } of tickets) {
			const found = parseIssue(repo, issue, comments);
			const settled = settleRecords(found.records, root);
			records.push(...settled.records);
			settledFaults.push(
				...found.unknownTiers.map((u) => ({
					tag: /** @type {Report["tag"]} */ ("UNKNOWN TIER"),
					fault: `${repo}#${issue} has a tier in no known word, so no record under it is counted until a line of standard, escalated or mission-critical follows, as ${RULE_COMMAND} says: ${u.line}`,
				})),
				...settled.faults,
			);
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
	const judged = judgeRecords(commits, home, own);
	return {
		commits: judged.commits.filter((c) => c.fixed + c.escapes.length > 0),
		unparsed,
		reports: [
			...settledFaults,
			...cover.rangeFaults,
			...trailered.unseen,
			...credited.faults,
			...judged.reports,
		],
		undercounts:
			credited.undercounts || trailered.undercounts || judged.undercounts,
	};
}

/**
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
			fault: `${c.repo}#${c.issue}: could not diff reviewed ${c.tree} against landed ${c.landed} in ${checkout.root}, so whether its record names the landed tree is not judged until that checkout holds both, or a record under a counted tier with its base, paths and landed sha names a tree it holds — ${diff.why}`,
		};
	if (diff.out !== "") return null;
	return {
		tag: "LANDED TREE",
		fault: `${c.repo}#${c.issue} has a record naming reviewed ${c.tree}, the tree landed ${c.landed} carries on its paths, so a replay finds none of its fixed defects: post, under a counted tier, a record naming the tree pinned before the first round's dispatch, with its base, paths and landed sha, as ${RULE_COMMAND} says; where the correction changes its base or paths too, ${DELETE_RECORD}; with no pin taken, no correction exists, so this line stays`,
	};
}

/** @param {string} repo */
function readRevertedShas(repo) {
	/** @type {Map<string, string[]>} */
	const reverts = new Map();
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
				? `- ${c.repo}@${c.landed}: Review-Tier: trailer alone, base ${c.base}, committed tree ${c.tree}, paths ${c.paths}; ${c.escapes.length} escaped`
				: `- ${c.repo}#${c.issue}: landed ${c.landed}, base ${c.base}, tree ${c.tree}${c.paths === null ? "" : `, paths ${c.paths}`}; ${c.fixed} fixed or ticketed, ${c.escapes.length} escaped${c.isTipReverted ? ", its tip reverted" : ""}`,
		),
		"",
		"Kept current daily by `scripts/report-remeasure-due.js` (#1625), which never files a second.",
	].join("\n");
}

/** @param {number} number */
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
 * @param {string} fault
 * @param {string} next
 */
function failOpen(fault, next) {
	logError(WHERE, fault);
	writeFd(
		2,
		`FAILED OPEN: ${fault} — recorded in the guard-error log.\n${next}\n`,
	);
}

/** @param {Report} report */
function writeReport({ tag, fault }) {
	logError(WHERE, fault);
	writeFd(2, `${tag}: ${fault}\n`);
}

/**
 * @param {{ number: number } | null} existing
 * @param {ReviewRecord[]} commits
 * @param {boolean} undercounts
 */
function fileOrHold(existing, commits, undercounts) {
	const due = commits.length >= THRESHOLD;
	if (!existing && !due) return;
	const text = buildBody(commits);
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
		failOpen(
			`could not file or refresh "${TITLE}" — ${parseErrLine(e)}`,
			`${remedy(e)}The next day's run retries.`,
		);
	}
}

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("report-remeasure-due.js")}`,
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
			fault: `${u.repo}#${u.issue} has a record not in ${RULE_COMMAND}'s form, so its commit is not counted until it is corrected: edit it, or post a record in that form ${SHARES_REVIEW}: ${u.line}`,
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
