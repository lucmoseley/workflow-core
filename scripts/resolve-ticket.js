#!/usr/bin/env node
const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { hostRoot, worktreeRoot } = require("./lib/host-root.js");
const { buildLineRe, hasLine } = require("./lib/marker-line.js");
const { writeFd } = require("./lib/write-fd.js");
const issueBody = require("./issue-body.js");
const { parseErrLine, gh } = require("./lib/gh.js");
const outstandingLine = require("./lib/outstanding-line.js");
const { unmetCriteria } = require("./lib/ticket-criteria.js");
const { ticketedRefusal } = require("./lib/ticketed-tags.js");
const { openChildrenRefusal } = require("./lib/open-children.js");
const { isOpenChild, readSubIssues } = require("./lib/issue-tree.js");
const {
	censusRefusal,
	readExpiredRows,
	hasCensusLine,
} = require("./lib/census-digest.js");
const {
	hasUnlandedLine,
	readUnlandedCommits,
	unlandedRefusal,
} = require("./lib/unlanded-commits.js");
const {
	alreadyCommented,
	isCardOwnIssue,
	readIssue,
	readParent,
	releaseCleanFileClaims,
	releaseOwnClaim,
	scriptIo,
} = require("./lib/tracker-ops.js");
const { recordOwnAct } = require("./lib/own-acts.js");
const {
	buildFindingsRefusal,
	hasRecordMention,
	readTicketComments,
} = require("./lib/review-findings.js");
const {
	buildCompactionsLine,
	COMPACTIONS_MARKER,
	countCompactions,
	hasSessionCompactionsLine,
} = require("./lib/compaction-set.js");
const { caught } = require("./lib/caught.js");
const { decisionMarks, isDecisionTicket } = require("./lib/decision-labels.js");
const { guessRefusal } = require("./lib/values-guesses.js");
const { fromEnv: sessionFromEnv } = require("./lib/session-id.js");
const { parseIssueNumber } = require("./lib/issue-number.js");

const USAGE = `usage: node ${scriptPath("resolve-ticket.js")} <n> --comment-file F|- [--decision "<one line>"] [--reason completed|"not planned"]`;

const REASONS = ["completed", "not planned"];

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("resolve-ticket");

// cli-args-exempt: workflow-core#5540
/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {{n?: number, commentFile?: string, decision?: string, reason: string}} */
	const a = { reason: "completed" };
	let i = 0;
	for (let arg = argv[i]; arg !== undefined; arg = argv[++i]) {
		const n = parseIssueNumber(arg);
		if (n !== null && a.n === undefined) {
			a.n = n;
			continue;
		}
		if (!["--comment-file", "--decision", "--reason"].includes(arg))
			io.fail(`unexpected argument '${arg}'. ${USAGE}`, 2);
		const value = argv[++i];
		if (value === undefined) io.fail(`${arg} takes a value. ${USAGE}`, 2);
		if (arg === "--comment-file") a.commentFile = value;
		else if (arg === "--reason") a.reason = value;
		else a.decision = value;
	}
	return requireArgs(a);
}

/**
 * @param {{n?: number, commentFile?: string, decision?: string, reason: string}} a
 */
function requireArgs(a) {
	if (a.n === undefined) io.fail(`an issue number is required. ${USAGE}`, 2);
	if (a.commentFile === undefined)
		io.fail(
			`--comment-file is required — a file, or - for standard input. ${USAGE}`,
			2,
		);
	if (!REASONS.includes(a.reason))
		io.fail(`--reason is completed or "not planned", not '${a.reason}'.`, 2);
	return /** @type {{n: number, commentFile: string, decision?: string, reason: string}} */ (
		a
	);
}

/** @param {string} file */
function readComment(file) {
	try {
		return fs.readFileSync(file === "-" ? 0 : file, "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		return io.fail(
			`could not read the comment from ${file} (${code ?? message}).`,
			2,
		);
	}
}

/**
 * @param {string} repo
 * @param {number} map
 * @param {number} n
 * @param {string} decision
 */
function appendMapLine(repo, map, n, decision) {
	const argv = [
		"append-decision",
		String(map),
		"--child",
		String(n),
		"--gist",
		decision,
		"--repo",
		repo,
	];
	try {
		return issueBody.main(argv);
	} catch (e) {
		writeFd(2, `${caught(e).message}\n`);
		return 1;
	}
}

/** @typedef {import("./lib/tracker-ops.js").Issue} Issue */

/**
 * @param {string} comment
 * @param {boolean} notPlanned
 */
function checkCommentOrFail(comment, notPlanned) {
	if (!comment.trim()) io.fail("the comment is empty. Nothing written.", 2);
	if (!hasLine(comment, "Bound", "\\S"))
		io.fail(
			"the comment has no **Bound:** line, or an empty one — say on that line what you read in full and what you only sampled or cited. Nothing written.",
			2,
		);
	const ticketed = ticketedRefusal(comment);
	if (ticketed)
		io.fail(
			`the comment is a whole-spec review that tickets a finding naming no exception:\n${ticketed} Nothing written.`,
			2,
		);
	if (notPlanned) return;
	if (!hasLine(comment, "Values", "\\S"))
		io.fail(
			'the comment has no **Values:** line, or an empty one — list on it each value the comment relies on that is house or untraced, "**Values:** <value> — house: #<the ruling that made it a house decision>; <value> — untraced", or "**Values:** none". A sourced value is not listed; its source stays inline. Only a --reason "not planned" close is exempt. Nothing written.',
			2,
		);
	if (!hasLine(comment, "Practice", "\\S"))
		io.fail(
			'the comment has no **Practice:** line, or an empty one — declare the Leading practice call in one of four forms: "**Practice:** ran — <note>", "**Practice:** covered — <note>, <Researched date>", "**Practice:** skipped — <exempt kind>", or "**Practice:** none-fits — nearest <craft>". Only a --reason "not planned" close is exempt. Nothing written.',
			2,
		);
	if (
		outstandingLine.hasSha(comment) &&
		!hasLine(comment, "Door", "(two|one)-way\\b")
	)
		io.fail(
			'the comment names a commit sha but has no **Door:** line reading two-way or one-way — "**Door:** two-way — <what undoing it takes>", or "**Door:** one-way — <which entry on the one-way list in docs/agents/issue-tracker.md>; <what undoing it takes, or that it cannot be undone>". Only a --reason "not planned" close is exempt. Nothing written.',
			2,
		);
}

const REPLY_SKIP = buildLineRe(
	"Practice",
	"skipped\\b[^\\n]*\\ba reply that only answers a question",
	"im",
);

/**
 * @param {string} comment
 * @param {Issue} issue
 */
function checkPracticeKindOrFail(comment, issue) {
	if (isDecisionTicket(issue.labels) && REPLY_SKIP.test(comment))
		io.fail(
			`#${issue.number} is a decision ticket (${decisionMarks(issue.labels).join(", ")}), and its **Practice:** line declares "skipped — a reply that only answers a question". A decision ticket's resolution is a decision, not a reply: run the research pass ("**Practice:** ran — <note>"), cite a current note ("**Practice:** covered — <note>, <Researched date>"), or name another exempt kind that fits. Nothing written.`,
			2,
		);
}

/**
 * @param {string} comment
 * @param {Issue} issue
 */
function checkValuesGuessesOrFail(comment, issue) {
	const refusal = guessRefusal(issue.number, issue.labels, comment);
	if (refusal) io.fail(`${refusal} Nothing written.`, 2);
}

/**
 * @param {string} repo
 * @param {number} n
 * @returns {Issue}
 */
function readIssueOrFail(repo, n) {
	let issue;
	try {
		issue = readIssue(repo, n);
	} catch (e) {
		io.fail(
			`could not read #${n} from ${repo} (${parseErrLine(e)}). Nothing written.`,
			1,
		);
	}
	if (issue.isPullRequest) io.fail(`#${n} is a pull request, not an issue.`, 2);
	return issue;
}

/**
 * @param {Issue} issue
 * @param {number} n
 */
function checkCompletableOrFail(issue, n) {
	if (isCardOwnIssue(issue))
		io.fail(
			`#${n} is roadmap card ${issue.title.split(" — ")[0]}'s own issue: close it with /card-close ${n}, which marks the card done first — or, abandoning it, re-run with --reason "not planned". Nothing written.`,
			2,
		);

	const unmet = unmetCriteria(issue.body);
	if (unmet.length > 0)
		io.fail(
			`#${n} has ${unmet.length} unticked acceptance criteri${unmet.length === 1 ? "on" : "a"} with no **waived:** note:\n${unmet.map((i) => `  - [ ] ${i.text}`).join("\n")}\nTick each one you verified (issue-body.js tick), or annotate it **waived:** <why>. Nothing written.`,
			2,
		);
}

/**
 * @param {string} repo
 * @param {number} n
 */
function checkNoOpenChildOrFail(repo, n) {
	let kids;
	try {
		kids = readSubIssues(n, repo);
	} catch (e) {
		io.fail(
			`could not read #${n}'s sub-issues (${parseErrLine(e)}). Nothing written.`,
			1,
		);
	}
	const refusal = openChildrenRefusal(
		String(n),
		`https://github.com/${repo}/issues/`,
		kids.map((k) => ({
			number: String(k.number),
			title: String(k.title),
			url: String(k.html_url),
			open: isOpenChild(k),
		})),
	);
	if (refusal) io.fail(`${refusal} Nothing written.`, 2);
}

/**
 * @param {string} comment
 * @param {number} n
 */
function checkCensusOrFail(comment, n) {
	if (hasCensusLine(comment)) return;
	checkRefusalOrFail("census", n, () => {
		const rows = readExpiredRows(hostRoot(), n);
		return rows.length > 0 ? censusRefusal(n, rows) : "";
	});
}

/**
 * @param {string} comment
 * @param {number} n
 */
function checkLandedOrFail(comment, n) {
	if (hasUnlandedLine(comment)) return;
	checkRefusalOrFail("landing", n, () => {
		const unlanded = readUnlandedCommits(worktreeRoot(), n, comment);
		return unlanded.commits.length > 0 ? unlandedRefusal(n, unlanded) : "";
	});
}

/**
 * @param {string} comment
 * @param {string} repo
 * @param {number} n
 */
function checkFindingsOrFail(comment, repo, n) {
	if (!hasRecordMention(comment)) return;
	checkRefusalOrFail("review record", n, () =>
		buildFindingsRefusal(
			n,
			readTicketComments(repo, n),
			comment,
			worktreeRoot(),
		),
	);
}

/**
 * @param {string} check
 * @param {number} n
 * @param {() => string} refuse
 */
function checkRefusalOrFail(check, n, refuse) {
	let refusal;
	try {
		refusal = refuse();
	} catch (e) {
		// workflow-core#1876 workflow-core#3101
		io.out(
			`#${n}: ${check} check skipped — ${caught(e).message.split("\n")[0]}.\n`,
		);
		return;
	}
	if (refusal) io.fail(`${refusal} Nothing written.`, 2);
}

/**
 * @param {string} comment
 * @param {string} repo
 * @param {number} n
 */
function checkOutstandingOrFail(comment, repo, n) {
	const verdict = outstandingLine.judge(comment, {
		grammar: "outstanding",
		tracker: repo,
		self: n,
	});
	for (const note of verdict.unchecked)
		io.out(`#${n}: Outstanding open-check skipped — ${note}.\n`);
	if (!verdict.ok)
		io.fail(
			`the comment's **Outstanding:** line does not pass:\n${outstandingLine.buildRefusalText(verdict)} Only a --reason "not planned" close is exempt. Nothing written.`,
			2,
		);
}

/**
 * @param {Issue} issue
 * @param {number} n
 * @param {string | undefined} decision
 * @returns {Issue | null}
 */
function readMapOrFail(issue, n, decision) {
	let parent;
	try {
		parent = readParent(issue);
	} catch (e) {
		io.fail(
			`could not read #${n}'s parent (${issue.parentPath}) (${parseErrLine(e)}). Nothing written.`,
			1,
		);
	}
	const map = parent?.labels.includes("wayfinder:map") ? parent : null;
	if (!map) return map;
	if (!decision)
		io.fail(
			`#${n}'s parent #${map.number} is a map, so --decision "<one line>" is required for its Decisions so far. Nothing written.`,
			2,
		);
	if (decision.includes("\n"))
		io.fail("--decision spans more than one line. Nothing written.", 2);
	if (!/^##\s+decisions so far\s*$/im.test(map.body))
		io.fail(
			`map #${map.number} has no '## Decisions so far' section — add it to the map by hand, then re-run. Nothing written.`,
			1,
		);
	return map;
}

/**
 * @param {string} comment
 * @param {Issue} issue
 */
function withCompactionsLine(comment, issue) {
	if (!issue.labels.includes("kind:ticket")) return comment;
	const sid = sessionFromEnv();
	if (!sid) {
		io.out(
			`No session id (CLAUDE_CODE_SESSION_ID is unset), so #${issue.number}'s comment carries no **${COMPACTIONS_MARKER}:** line.\n`,
		);
		return comment;
	}
	if (hasSessionCompactionsLine(comment, sid)) return comment;
	return `${comment.trimEnd()}\n\n${buildCompactionsLine(countCompactions(sid), sid)}\n`;
}

/**
 * @param {string} repo
 * @param {number} n
 * @param {string} comment
 */
function postCommentOnce(repo, n, comment) {
	let posted;
	try {
		posted = alreadyCommented(repo, n, comment);
	} catch (e) {
		io.fail(
			`could not read #${n}'s comments to rule out a second post (${parseErrLine(e)}). Nothing written — re-run.`,
			1,
		);
	}
	if (posted) {
		io.out(
			`#${n}: your latest comment is this one already — not posted again.\n`,
		);
		return;
	}
	try {
		gh(["issue", "comment", String(n), "--repo", repo, "--body-file", "-"], {
			input: comment,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (e) {
		io.fail(
			`posting the comment on #${n} failed (${parseErrLine(e)}). Nothing else written — re-run; a comment that landed anyway is not posted twice.`,
			1,
		);
	}
	io.out(`#${n}: comment posted.\n`);
}

/**
 * @param {string} repo
 * @param {number} n
 * @param {string} reason
 */
function closeOrFail(repo, n, reason) {
	let state;
	try {
		gh(["issue", "close", String(n), "--repo", repo, "--reason", reason]);
		state = readIssue(repo, n).state;
	} catch (e) {
		io.fail(
			`the comment is on #${n}, but closing it failed or could not be read back (${parseErrLine(e)}). Re-run to finish.`,
			1,
		);
	}
	if (state !== "closed")
		io.fail(
			`gh closed #${n} without error, but it reads back as ${state}. Re-run to finish.`,
			1,
		);
	io.out(`#${n}: closed as ${reason}.\n`);
}

function main() {
	const a = parseArgs(process.argv.slice(2));
	const { n } = a;
	const notPlanned = a.reason === "not planned";

	const comment = readComment(a.commentFile);
	checkCommentOrFail(comment, notPlanned);

	const repo = io.trackerOrFail();

	const issue = readIssueOrFail(repo, n);

	if (issue.state !== "closed") {
		checkNoOpenChildOrFail(repo, n);
		checkFindingsOrFail(comment, repo, n);
	}

	if (!notPlanned) {
		checkPracticeKindOrFail(comment, issue);
		checkValuesGuessesOrFail(comment, issue);
		checkCompletableOrFail(issue, n);
		checkCensusOrFail(comment, n);
		checkLandedOrFail(comment, n);
	}

	if (!notPlanned && issue.state !== "closed")
		checkOutstandingOrFail(comment, repo, n);

	const decision = a.decision?.trim();
	const map = readMapOrFail(issue, n, decision);

	if (issue.state === "closed") {
		io.out(`#${n} is already closed — comment and close skipped.\n`);
	} else {
		postCommentOnce(repo, n, withCompactionsLine(comment, issue));
		closeOrFail(repo, n, a.reason);
		recordOwnAct("close", repo, n);
	}

	let code = releaseOwnClaim(io, n);
	if (releaseCleanFileClaims(io) !== 0) code = 1;

	if (map) {
		if (
			appendMapLine(repo, map.number, n, /** @type {string} */ (decision)) !== 0
		)
			code = 1;
	} else if (decision) {
		io.out(
			`#${n} has no map parent, so --decision was not written anywhere.\n`,
		);
	}
	// process.exit can cut a pending stdout write on a pipe short: https://nodejs.org/api/process.html#processexit
	process.exitCode = code;
}

main();
