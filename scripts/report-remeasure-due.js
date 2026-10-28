#!/usr/bin/env node
/*
 * report-remeasure-due.js — tells the founder, through one filed issue, once
 * 15 sensitive-path commits carry known defects, so the focused-against-
 * identical-runs question (#1545) is re-measured on real code (#1625, spec
 * #1612 §The re-measure trigger).
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
 * searched only once the count reaches the threshold, since dropping one can
 * only lower it, in the tracker's repo and, for this repo's own tracker, its
 * `codeRepo` too, whose history before 2.0.0 lives in the tracker (#3395).
 * Residual: an adopter's code repo apart from its tracker is not searched,
 * and the landed sha is taken as on `main`, never checked against it.
 *
 * AN UNPARSEABLE RECORD — a `**Review findings:**` not in backticks, under a
 * counted tier, that the record form does not match — counts nothing and is
 * reported, remedy included: one line to stderr and to the guard-error log,
 * which is what the daily run keeps, per record each run until it is
 * corrected (#3064). Not one whose `reviewed <tree>` a parsed record on its
 * ticket shares: a close draft holding a placeholder for the landed
 * sha, superseded by the close.
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
 * rewrites that issue's body, never filing a second. Found by title alone,
 * since the session that takes it may relabel it. Below the threshold it
 * prints nothing but those reports, and calls no tracker but the search.
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
const { hostRoot } = require("./lib/host-root");
const { requiredGroup } = require("./lib/regex-group");
const { takesLabel, takesRefusal } = require("./lib/takes-label");
const {
	createIssue,
	findTrackingIssue,
	refresh,
} = require("./lib/tracking-issue");
const { resolveKey } = require("./lib/workflow-core-config");

const WHERE = "report-remeasure-due";
const TITLE = "Re-measure focused against identical review runs";
const LABEL = takesLabel("wayfinder");
/* #1556 Q4 (A)'s "about 15", made exact by spec #1612: a judgement of how
 * many commits the comparison needs, not a measurement. */
const THRESHOLD = 15;
const FLOOR = "2026-10-14";
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
    nodes { ... on Issue { number comments(first: ${PAGE}) { totalCount nodes { body } } } }
  }
}`;
const SHA = "`?([0-9a-f]{7,40})(?![0-9a-z])`?";
const RECORD_HEAD = "\\*\\*Review findings:\\*\\*";
const REVIEWED_TREE = `reviewed\\s+${SHA}`;
const FINDINGS = new RegExp(
	`${RECORD_HEAD}\\s*base\\s+${SHA},\\s*${REVIEWED_TREE},\\s*landed\\s+${SHA}(?:,[ \\t]*paths[ \\t]+([^\\n]+))?`,
	"g",
);
const TIER = /\*\*Review tier:\*\*\s*`?([A-Za-z-]+)/g;
const COUNTED_TIERS = new Set(["escalated", "mission-critical"]);
const BULLET = /^\s*-\s/;
const KNOWN = /^\s*-\s*(?:FIXED|TICKETED)\b/;
const BLANK = /^\s*$/;
/* A list ends at the next record, even one bulleted or indented, so its
 * defects are never counted under this one too. */
const RECORD_START = new RegExp(RECORD_HEAD);
/* A backticked one names the format, as a review comment quoting it does.
 * Residual: an unbackticked mention in bold prose under a counted tier is
 * reported, and a record backticked whole is skipped unreported. */
const RECORD_MENTION = new RegExp(`(?<!\`)${RECORD_HEAD}`, "g");
const REVIEWED = new RegExp(REVIEWED_TREE);
const INDENTED = /^\s+\S/;
const ESCAPED = new RegExp(`\\*\\*Escaped defect:\\*\\*\\s*${SHA}`, "g");
/* `git revert`'s own message line, which names the full sha. */
const REVERTS = /^This reverts commit ([0-9a-f]{40})\b/gm;

/**
 * @typedef {{ repo: string, issue: number, base: string, tree: string,
 *   landed: string, paths: string | null, tier: string, fixed: number, escaped: number }} ReviewRecord
 * @typedef {{ repo: string, issue: number, line: string }} Unparsed
 * @typedef {{ at: number, tier: string } | { at: number, record: RegExpExecArray }
 *   | { at: number, unparsed: string }} Mark
 */

/** @param {RegExpExecArray} m @param {number} n @param {RegExp} re */
const group = (m, n, re) => requiredGroup(m, n, re).toLowerCase();

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {string} q
 * @param {string | null} after
 * @returns {{ issueCount: number, pageInfo: { hasNextPage: boolean, endCursor: string },
 *   nodes: { number?: number, comments?: { totalCount: number, nodes: { body: string }[] } }[] }}
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
 * its comments' bodies, halving the window while it holds more than the cap.
 *
 * @param {string} repo
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @returns {{ issue: number, bodies: string[] }[]}
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
		bodies:
			comments.totalCount > comments.nodes.length
				? ghApiSlurp([`repos/${repo}/issues/${issue}/comments`]).map(
						(/** @type {{ body: string | null }} */ c) => c.body ?? "",
					)
				: comments.nodes.map((c) => c.body),
	}));
}

/**
 * How many of the bullets under a record dispose a finding fixed or ticketed.
 * The list runs past blank lines and indented continuation lines (#1698), and
 * stops at the first other line.
 *
 * @param {string} after the text following the record's own line
 */
function knownDefects(after) {
	let n = 0;
	for (const line of after.split("\n").slice(1)) {
		if (RECORD_START.test(line)) break;
		if (KNOWN.test(line)) n++;
		else if (!BULLET.test(line) && !BLANK.test(line) && !INDENTED.test(line))
			break;
	}
	return n;
}

/**
 * A record's reviewed paths, null on one written before #1926.
 *
 * @param {RegExpExecArray} m
 */
const pathsOf = (m) =>
	m[4] === undefined ? null : m[4].replace(/`/g, "").trim();

/**
 * @param {string} body
 * @returns {Mark[]}
 */
function parseMarks(body) {
	const found = [...body.matchAll(FINDINGS)];
	const parsed = new Set(found.map((m) => m.index));
	return [
		...[...body.matchAll(TIER)].map((m) => ({
			at: m.index,
			tier: group(m, 1, TIER),
		})),
		...found.map((m) => ({ at: m.index, record: m })),
		...[...body.matchAll(RECORD_MENTION)]
			.filter((m) => !parsed.has(m.index))
			.map((m) => ({
				at: m.index,
				unparsed: body.slice(m.index).replace(/\n[\s\S]*/, ""),
			})),
	].sort((x, y) => x.at - y.at);
}

/**
 * The records, escaped-defect shas and unparseable records under a counted
 * tier in one ticket's comments, read in order so each record takes the tier
 * last declared above it.
 *
 * @param {string} repo
 * @param {number} issue
 * @param {string[]} bodies
 * @returns {{ records: ReviewRecord[], escaped: string[], unparsed: Unparsed[] }}
 */
function parseIssue(repo, issue, bodies) {
	/** @type {ReviewRecord[]} */
	const records = [];
	/** @type {string[]} */
	const escaped = [];
	/** @type {Unparsed[]} */
	const unparsed = [];
	let tier = "";
	for (const body of bodies) {
		for (const m of body.matchAll(ESCAPED)) escaped.push(group(m, 1, ESCAPED));
		const marks = parseMarks(body);
		for (const mark of marks) {
			if ("tier" in mark) {
				tier = mark.tier;
				continue;
			}
			if ("unparsed" in mark) {
				if (COUNTED_TIERS.has(tier))
					unparsed.push({ repo, issue, line: mark.unparsed });
				continue;
			}
			const m = mark.record;
			records.push({
				repo,
				issue,
				base: group(m, 1, FINDINGS),
				tree: group(m, 2, FINDINGS),
				landed: group(m, 3, FINDINGS),
				paths: pathsOf(m),
				tier,
				fixed: knownDefects(body.slice(m.index)),
				escaped: 0,
			});
		}
	}
	return {
		records,
		escaped,
		unparsed: unparsed.filter((u) => !isSuperseded(u, records)),
	};
}

/**
 * Whether `u` is the superseded close draft the header exempts.
 *
 * @param {Unparsed} u
 * @param {ReviewRecord[]} records
 */
function isSuperseded(u, records) {
	const m = REVIEWED.exec(u.line);
	if (!m) return false;
	const tree = group(m, 1, REVIEWED);
	return records.some((r) => isSameSha(r.tree, tree));
}

/** @param {string} a @param {string} b */
const isSameSha = (a, b) => a.startsWith(b) || b.startsWith(a);

/**
 * Folds `r`, a later record of the same commit, into `seen`.
 *
 * @param {ReviewRecord} seen accumulator: `fixed` is written, `landed` where
 *   `r`'s is longer, and `issue`, `base`, `tree` and `paths` where `seen` names
 *   no paths and `r` does
 * @param {ReviewRecord} r
 */
function mergeRecord(seen, r) {
	seen.fixed += r.fixed;
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
		});
}

/**
 * The counted commits across `trackers`, in corpus order, then by ticket,
 * and the unparseable records under a counted tier.
 *
 * @param {string[]} trackers
 * @param {string} today YYYY-MM-DD
 * @returns {{ commits: ReviewRecord[], unparsed: Unparsed[] }}
 */
function countedCommits(trackers, today) {
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
		for (const { issue, bodies } of tickets) {
			const found = parseIssue(repo, issue, bodies);
			records.push(...found.records);
			escaped.push(...found.escaped);
			unparsed.push(...found.unparsed);
		}
	}
	/** @type {ReviewRecord[]} */
	const commits = [];
	for (const r of records) {
		if (!COUNTED_TIERS.has(r.tier)) continue;
		const seen = commits.find(
			(c) => c.repo === r.repo && isSameSha(c.landed, r.landed),
		);
		if (seen) mergeRecord(seen, r);
		else commits.push({ ...r });
	}
	/* Across repos, not within one: the line sits on the fixing ticket, which
	 * may live in another repo, and a 7-hex prefix colliding is negligible. */
	for (const c of commits)
		c.escaped = escaped.filter((s) => isSameSha(s, c.landed)).length;
	return {
		commits: commits.filter((c) => c.fixed + c.escaped > 0),
		unparsed,
	};
}

/**
 * The shas the reverts on `repos`' default branches since FLOOR name, less
 * each whose revert was itself reverted. Commit search reads the default
 * branch alone.
 *
 * @param {string[]} repos
 */
function readRevertedShas(repos) {
	/** @type {Map<string, string[]>} each target to the commits reverting it */
	const reverts = new Map();
	for (const repo of repos) {
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
	}
	/** @param {string} sha @returns {boolean} */
	const isReverted = (sha) =>
		(reverts.get(sha) ?? []).some((r) => !isReverted(r));
	return [...reverts.keys()].filter(isReverted);
}

/**
 * @param {ReviewRecord[]} commits
 * @param {string} own this repo's tracker
 * @param {string} code this repo's code repo
 */
function withoutReverted(commits, own, code) {
	const reverted = new Map(
		[...new Set(commits.map((c) => c.repo))].map((tracker) => [
			tracker,
			readRevertedShas(
				tracker === own && code !== own ? [tracker, code] : [tracker],
			),
		]),
	);
	return commits.filter(
		(c) => !reverted.get(c.repo)?.some((s) => isSameSha(s, c.landed)),
	);
}

/** @param {ReviewRecord[]} commits */
function buildBody(commits) {
	return [
		`${commits.length} commits on declared sensitive paths, reviewed at the escalated or mission-critical tier, now carry a known defect: a finding fixed or ticketed, or an escaped defect recorded later. At ${THRESHOLD}, focused against identical review runs (#1545) is re-measured on real code (spec #1612 §The re-measure trigger).`,
		"",
		...commits.map(
			(c) =>
				`- ${c.repo}#${c.issue}: landed ${c.landed}, base ${c.base}, tree ${c.tree}${c.paths === null ? "" : `, paths ${c.paths}`}; ${c.fixed} fixed or ticketed, ${c.escaped} escaped`,
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

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: "usage: node scripts/report-remeasure-due.js",
	});
	const root = hostRoot();
	let commits;
	let unparsed;
	try {
		({ commits, unparsed } = countedCommits(
			/** @type {string[]} */ (resolveKey("corpus", { root })),
			day(now()),
		));
	} catch (e) {
		failOpen(
			`could not read the corpus — ${parseErrLine(e)}`,
			`${remedy(e)}Nothing was filed; the next day's run retries.`,
		);
		return;
	}
	for (const u of unparsed) {
		const fault = `${u.repo}#${u.issue} has a record not in \`scripts/lib/rule-text.sh review-tier-records\`'s form, so its commit is not counted until it is corrected: ${u.line}`;
		logError(WHERE, fault);
		writeFd(2, `UNPARSEABLE: ${fault}\n`);
	}
	if (commits.length < THRESHOLD) return;
	try {
		commits = withoutReverted(
			commits,
			/** @type {string} */ (resolveKey("tracker", { root })),
			/** @type {string} */ (resolveKey("codeRepo", { root })),
		);
	} catch (e) {
		failOpen(
			`could not read the corpus's reverts — ${parseErrLine(e)}`,
			`${remedy(e)}Nothing was filed; the next day's run retries.`,
		);
		return;
	}
	if (commits.length < THRESHOLD) return;
	const text = buildBody(commits);
	/* No PreToolUse hook sees a script's own gh call, so the create guard's
	 * takes: check is made here. */
	const refused = takesRefusal([LABEL], text);
	if (refused) {
		failOpen(refused, "Nothing was filed.");
		return;
	}
	try {
		const existing = findTrackingIssue({ title: TITLE }, "all");
		if (existing) refresh(existing.number, text);
		const did = existing
			? `Refreshed #${existing.number}`
			: `Filed ${createIssue({ title: TITLE, labels: [LABEL], body: text })}`;
		console.log(`Re-measure due: ${commits.length} counted commits. ${did}.`);
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
