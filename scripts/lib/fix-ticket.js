/*
 * fix-ticket.js — the ticket the queue lander files for a member it drops (#2404; #4485, spec #4458):
 * `takes:implement`, unassigned, naming the queue ref, its sha, the dropped
 * ref and the evidence, a sub-issue of the ticket its commits cite, or
 * standalone where they cite none.
 *
 * A cited ticket that is closed is reopened first. A filing file-issue.js
 * refuses under the cited ticket is filed standalone, naming the refusal. One
 * it refuses standalone too, exiting 2, throws a FilingRefusedError.
 */

const { citedIssues } = require("./cited-issues.js");
const { parseFiledLine } = require("./filed-line.js");
const { FilingRefusedError } = require("./filing-refused.js");
const { gh, parseErrLine } = require("./gh.js");
const { readTicketsByPrefix } = require("./incident-tickets.js");
const { spawnGitSync } = require("./git.js");
const { parseFirstLine } = require("./first-line.js");
const { short } = require("./lander-git.js");
const { QUEUE_PREFIX } = require("./landing-refs.js");
const { liveQueueDeps } = require("./queue-issue.js");
const { takesLabel } = require("./takes-label.js");
const { readOwnFilings, similarTitles } = require("./tracker-ops.js");
const { readSubIssues } = require("./issue-tree.js");
const { requireKey } = require("./workflow-core-config.js");

/* Untraced: room for the culprit's subject in a title a tracker list shows
 * whole. */
const SUBJECT_MAX = 72;

/**
 * The ticket the commit's subject cites. A citation in the body alone is
 * often a ruling or a precedent, never reopened on a guess.
 * @param {string} subject
 * @returns {number|null}
 */
function citedTicket(subject) {
	const [first] = citedIssues(subject);
	return first ?? null;
}

/** @param {string} subject */
const cutSubject = (subject) =>
	subject.length > SUBJECT_MAX
		? `${subject.slice(0, SUBJECT_MAX - 1)}…`
		: subject;

/* The subject sits in a code span, so file-issue's body checks never read it
 * as the ticket's own prose. */
const quoteSubject = (/** @type {string} */ subject) =>
	`\`${subject.replaceAll("`", "'")}\``;

/* A gate's output, fenced for the same reason, its backtick runs broken so
 * none closes the fence. */
const quoteBlock = (/** @type {string} */ text) =>
	`\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\``;

/**
 * @typedef {{status: number|null, stdout: string, stderr: string}} Ran
 * @typedef {object} FilerDeps
 * @property {(title: string) => {number: number, title: string}[]} similar
 *   the open issues whose titles resemble `title`
 * @property {(args: string[], input: string) => Ran} fileIssue runs
 *   file-issue.js with `args`, the body on stdin
 * @property {(n: number) => "open" | "closed"} stateOf the issue's state,
 *   throwing where it cannot be read
 * @property {(n: number, comment: string) => void} reopen
 */

/**
 * The ticket its member's commits cite: the newest commit's citation.
 * @param {readonly string[]} subjects newest first
 * @returns {number|null}
 */
const citedByAny = (subjects) =>
	subjects.map(citedTicket).find((n) => n !== null) ?? null;

/** @param {readonly string[]} files */
const buildFileList = (files) => files.map((f) => `- \`${f}\``).join("\n");

const NO_RUN =
	"no CI run fired for this tree, twice, where `main` passes, so its workflow's push triggers likely miss the lander's `lander/*` refs";

/** @param {import("./queue-lander.js").Drop} d */
function buildDropEvidence({ onto, cause }) {
	const alone = `merged alone onto \`main\` at ${onto}`;
	switch (cause.kind) {
		case "conflict":
			return `${alone}, it conflicts with \`main\` in:\n${buildFileList(cause.files)}`;
		case "refused":
			return `${alone}, its merge was refused, the refusal ending:\n\n${quoteBlock(cause.reason)}`;
		case "red":
			return `${alone} as ${cause.iso}, ${cause.noRun ? NO_RUN : `it failed ${cause.files.length > 0 ? `these files twice, which pass on \`main\` there:\n${buildFileList(cause.files)}` : "the whole suite twice, naming no file, where `main` passes it"}`}`;
		case "unrecorded":
			return `why is unknown, as the lander's drop record lost its entry; its commits are read off \`main\` at ${onto}`;
		case "collision": {
			const after = cause.after.map((n) => `\`${QUEUE_PREFIX}${n}\``);
			const failed =
				cause.files.length > 0
					? `failed twice:\n${buildFileList(cause.files)}`
					: "failed the whole suite twice, naming no file";
			return `each member of its batch passed alone, but merged onto \`main\` at ${onto}${after.length > 0 ? ` after ${after.join(", ")} landed,` : ""} as ${cause.step}, ${cause.noRun ? NO_RUN : `it ${failed}`}`;
		}
	}
}

/** @param {import("./queue-lander.js").Drop} d */
function buildDropAcceptance({ sha, name, cause }) {
	const queued = `\`${QUEUE_PREFIX}${name}\``;
	switch (cause.kind) {
		case "conflict":
			return `${short(sha)}'s change merges onto \`main\`, each file above settled, and is pushed to ${queued} again.`;
		case "refused":
			return `${short(sha)}'s change merges onto \`main\` and is pushed to ${queued} again.`;
		case "unrecorded":
			return `${short(sha)}'s change merges onto \`main\`, passes the whole suite there, and is pushed to ${queued} again.`;
		default:
			return cause.noRun
				? `${short(sha)}'s change, merged onto \`main\`, fires a CI run on the lander's refs that passes the whole suite, and is pushed to ${queued} again.`
				: `${short(sha)}'s change passes ${cause.files.length > 0 ? "each file above" : "the whole suite"} merged onto \`main\`, and is pushed to ${queued} again.`;
	}
}

/**
 * @param {string} name
 * @param {string} sha
 */
const dropTicketPrefix = (name, sha) =>
	`Fix ${QUEUE_PREFIX}${name} at ${short(sha)},`;

/**
 * @param {import("./queue-lander.js").Drop & {subject: string}} d
 * @returns {Omit<Ticket, "cited" | "checked">}
 */
function dropTicketIssue(d) {
	const { name, sha, ref, subject } = d;
	const queued = `${QUEUE_PREFIX}${name}`;
	const filedAs = dropTicketPrefix(name, sha);
	return {
		title: `${filedAs} dropped by the queue lander: ${cutSubject(subject)}`,
		filedAs,
		citer: `a commit on ${queued}`,
		uncited: `No commit on ${queued} cites a ticket of this repo.`,
		reopenNote: `Reopened by the queue lander: ${queued} at ${sha}, which cites it, was dropped. Its fix ticket follows as a sub-issue.`,
		noun: "fix ticket",
		body: `## What to build

The queue lander (#4458) dropped \`${queued}\` at ${sha}: ${buildDropEvidence(d)}

Its commits are kept at \`${ref}\`, which the lander deletes once this ticket closes.

Tip commit: ${quoteSubject(subject)}

## Acceptance criteria

- [ ] ${buildDropAcceptance(d)}
`,
	};
}

/**
 * @typedef {FilerDeps & {subjectsOf: (base: string,
 *   tip: string) => string[], openUnits: (parent: number|null) => number[],
 *   readTicketsTitled: (prefix: string) => Map<string, number>}}
 *   DropFilerDeps `subjectsOf` the subjects of the commits on `tip` and not
 *   on `base`, newest first; `openUnits` the tickets rule:size-line weighs a
 *   new one under `parent` against: its sub-issues and this session's
 *   filings; `readTicketsTitled` the issues, open and closed, whose titles
 *   start with `prefix`, by title
 */

/**
 * The queue lander's filer of a dropped member's fix ticket: `takes:implement`,
 * unassigned, under the ticket its commits cite, else standalone. Each drop
 * is its own fix, so every ticket rule:size-line would weigh it against is
 * named checked.
 * @param {DropFilerDeps} deps
 * @returns {Pick<import("./queue-lander.js").QueueTracker,
 *   "fileDropTicket" | "findDropTicket">}
 */
function dropTicketFiler(deps) {
	return {
		findDropTicket(name, sha) {
			const found = [
				...deps.readTicketsTitled(dropTicketPrefix(name, sha)).values(),
			];
			return found.length > 0 ? Math.min(...found) : null;
		},
		fileDropTicket(d) {
			const subjects = deps.subjectsOf(d.onto, d.sha);
			const [subject] = subjects;
			if (subject === undefined)
				throw new Error(
					`${QUEUE_PREFIX}${d.name} at ${short(d.sha)} has no commit off ${short(d.onto)}`,
				);
			return fileTicket(deps, {
				...dropTicketIssue({ ...d, subject }),
				cited: citedByAny(subjects),
				checked: deps.openUnits,
			});
		},
	};
}

/**
 * @typedef {object} Ticket a ticket to file under the one its work cites
 * @property {string} title
 * @property {string} body
 * @property {number|null} cited the ticket its work cites, null for none
 * @property {string} citer what cites it, as a standalone reason names it
 * @property {string} uncited the standalone reason where it cites none
 * @property {string} reopenNote the comment a closed cited ticket is reopened
 *   with
 * @property {string} noun what the line naming an open one calls it
 * @property {string} filedAs the title prefix an open ticket already filed
 *   for the same work starts with
 * @property {(parent: number|null) => readonly number[]} checked the open
 *   tickets it is named its own build unit beside under `parent`, past
 *   rule:size-line
 */

/**
 * Files `t` under the ticket its work cites, else standalone, returning the
 * line naming it; an open one whose title starts `filedAs` is named instead.
 * @param {FilerDeps} deps
 * @param {Ticket} t
 * @returns {string}
 */
function fileTicket(deps, t) {
	const listed = deps.similar(t.title);
	const filed = listed.find((c) => c.title.startsWith(t.filedAs));
	if (filed) return `${t.noun} already open: #${filed.number}`;
	const distinct =
		listed.length > 0
			? ["--distinct-from", listed.map((c) => c.number).join(",")]
			: [];
	/** @param {number|null} parent @param {string[]} placement */
	const file = (parent, placement) => {
		const checked = t.checked(parent);
		return deps.fileIssue(
			[
				"--title",
				t.title,
				"--label",
				takesLabel("implement"),
				"--label",
				"kind:ticket",
				...placement,
				"--origin",
				"lander-script",
				"--no-fault",
				...distinct,
				...(checked.length > 0
					? ["--size-line-checked", checked.join(",")]
					: []),
				"--body-file",
				"-",
			],
			t.body,
		);
	};
	const placed = fileUnderCited(t, file, deps);
	if ("filed" in placed) return placed.filed;
	const ran = file(null, ["--standalone", placed.why]);
	if (ran.status === 0) return parseFiledLine(ran.stdout).line;
	const why = `${t.noun} for ${t.citer} not filed: ${parseFirstLine(ran.stderr)}`;
	throw ran.status === 2 ? new FilingRefusedError(why) : new Error(why);
}

/**
 * Files the ticket under the cited one: what file-issue printed, or why it
 * goes standalone.
 * @param {Ticket} t
 * @param {(parent: number|null, placement: string[]) => Ran} file
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {{filed: string} | {why: string}}
 */
function fileUnderCited(t, file, deps) {
	if (t.cited === null) return { why: t.uncited };
	const unready = underCited(t.cited, t, deps);
	if (unready !== null) return { why: unready };
	const ran = file(t.cited, ["--parent", String(t.cited)]);
	if (ran.status === 0) return { filed: parseFiledLine(ran.stdout).line };
	return {
		why: `file-issue refused it under #${t.cited}, which ${t.citer} cites: ${parseFirstLine(ran.stderr)}`,
	};
}

/**
 * Readies the cited ticket as the ticket's parent, reopening it where
 * closed; null where it is ready, else why it cannot be.
 * @param {number} cited
 * @param {Pick<Ticket, "citer" | "reopenNote">} t
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {string|null}
 */
function underCited(cited, t, { stateOf, reopen }) {
	try {
		if (stateOf(cited) === "closed") reopen(cited, t.reopenNote);
		return null;
	} catch (err) {
		return `#${cited}, which ${t.citer} cites, could not be read or reopened: ${parseErrLine(err)}`;
	}
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function readGitIn(root, args) {
	const r = spawnGitSync(args, { cwd: root, encoding: "utf8" });
	if (r.status !== 0)
		throw new Error(
			`git ${args[0]} could not read ${args.at(-1)}: ${r.stderr.trim()}`,
		);
	return r.stdout;
}

/**
 * The tracker, file-issue.js and git the filer runs on, in `root`.
 * @param {string} root
 * @returns {DropFilerDeps}
 */
function liveFilerDeps(root) {
	const repo = () => requireKey("tracker", { root });
	return {
		subjectsOf: (base, tip) =>
			readGitIn(root, ["log", "--format=%s", `${base}..${tip}`])
				.split("\n")
				.filter(Boolean),
		/* Throws on an unread list: a retried ticket that reached the tracker
		 * must not be filed a second time. */
		similar: (title) => similarTitles(repo(), title).found,
		/* Search, not the cached title corpus, which can miss a ticket closed
		 * within its refresh hour (closed-title-cache.js). An open ticket the
		 * search has yet to index is still found by `similar`'s live read
		 * before a second is filed. */
		readTicketsTitled: (prefix) =>
			readTicketsByPrefix(repo(), "drop fix tickets", prefix),
		fileIssue: liveQueueDeps(root).fileIssue,
		openUnits: (parent) => [
			...(parent === null
				? []
				: readSubIssues(parent, repo()).map(
						(/** @type {{number: number}} */ k) => k.number,
					)),
			...readOwnFilings(repo()).numbers,
		],
		stateOf: (n) =>
			gh([
				"issue",
				"view",
				String(n),
				"--repo",
				repo(),
				"--json",
				"state",
				"--jq",
				".state",
			]).trim() === "CLOSED"
				? "closed"
				: "open",
		reopen: (n, comment) => {
			gh([
				"issue",
				"reopen",
				String(n),
				"--repo",
				repo(),
				"--comment",
				comment,
			]);
		},
	};
}

module.exports = {
	buildFileList,
	dropTicketFiler,
	liveFilerDeps,
};
