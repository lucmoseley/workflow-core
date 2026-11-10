/*
 * fix-ticket.js — the one ticket the queue lander keeps for a branch whose
 * owning session left a drop unlanded (#2404; #4485, spec #4458; #4950, spec
 * #4947): `takes:implement`, unassigned, titled `Fix queue/<name>,`, naming
 * the branch's newest drop, its evidence and every dropped ref the branch
 * holds, a sub-issue of the ticket its commits cite, or standalone where
 * they cite none.
 *
 * The title's prefix is the key: an open ticket carrying it is updated in
 * place, its body replaced and one comment added. Only a filing reopens a
 * closed cited ticket. A filing file-issue.js refuses under the cited ticket
 * is filed standalone, naming the refusal. One it refuses standalone too,
 * exiting 2, throws a FilingRefusedError.
 */

const { citedIssues } = require("./cited-issues.js");
const { buildCauseLine, buildDropEvidence } = require("./drop-evidence.js");
const { parseFiledLine } = require("./filed-line.js");
const { buildScriptFilerArgv } = require("./script-filer-argv.js");
const { FilingRefusedError } = require("./filing-refused.js");
const { gh, ghIssueListAll, parseErrLine } = require("./gh.js");
const { spawnGitSync } = require("./git.js");
const { parseMessageLine } = require("./first-line.js");
const { short } = require("./lander-git.js");
const { queueBranch } = require("./landing-refs.js");
const { liveQueueDeps } = require("./queue-issue.js");
const { takesLabel } = require("./takes-label.js");
const { readOwnFilings, similarTitles } = require("./tracker-ops.js");
const { readSubIssues } = require("./issue-tree.js");
const { requireKey } = require("./workflow-core-config.js");

/**
 * @typedef {import("./lander-records.js").Drop} Drop
 * @typedef {import("./queue-lander.js").DroppedRef} DroppedRef
 */

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

/**
 * @typedef {{status: number|null, stdout: string, stderr: string}} Ran
 * @typedef {import("./script-filer-argv.js").Placement} Placement
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

/**
 * What a red drop's change must pass: what it failed.
 * @param {{files: readonly string[], typecheck?: readonly string[]}} cause
 */
function buildOwedPass({ files, typecheck }) {
	const failed = [
		...(files.length > 0 ? ["each file above"] : []),
		...(typecheck ? ["the type-check"] : []),
	];
	return failed.length > 0 ? failed.join(" and ") : "the whole suite";
}

/** @param {Drop} d */
function buildDropAcceptance({ sha, name, cause }) {
	const queued = `\`${queueBranch(name)}\``;
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
				: `${short(sha)}'s change passes ${buildOwedPass(cause)} merged onto \`main\`, and is pushed to ${queued} again.`;
	}
}

/**
 * The title prefix of a branch's fix ticket, closed by its comma, so no
 * name's prefix opens another's.
 * @param {string} name after `queue/`
 */
const dropTicketPrefix = (name) => `Fix ${queueBranch(name)},`;

/**
 * @param {Drop} d the branch's newest drop
 * @param {readonly DroppedRef[]} held every dropped ref the branch holds
 * @param {string} subject its tip commit's
 * @returns {Omit<Ticket, "cited" | "checked">}
 */
function dropTicketIssue(d, held, subject) {
	const { name, sha } = d;
	const queued = queueBranch(name);
	const kept = held
		.map(
			(h) => `- \`${h.ref}\` at ${h.sha}${h.sha === sha ? ", this drop" : ""}`,
		)
		.join("\n");
	return {
		title: `${dropTicketPrefix(name)} dropped by the queue lander: ${cutSubject(subject)}`,
		citer: `a commit on ${queued}`,
		uncited: `No commit on ${queued} cites a ticket of this repo.`,
		reopenNote: `Reopened by the queue lander: ${queued} at ${sha}, which cites it, was dropped and its owning session was not read as working. Its fix ticket follows as a sub-issue.`,
		noun: "fix ticket",
		body: `## What to build

The queue lander (#4458) dropped \`${queued}\` at ${sha}: ${buildDropEvidence(d)}

Its owning session was not read as working on it. The lander keeps each drop of this branch at a dropped ref:

${kept}

It closes this ticket and deletes them once \`main\` holds the work, and replaces this body where the branch is dropped again.

Tip commit: ${quoteSubject(subject)}

## Acceptance criteria

- [ ] ${buildDropAcceptance(d)}
`,
	};
}

/**
 * @typedef {{number: number, title: string, body: string}} OpenTicket
 * @typedef {FilerDeps & {subjectsOf: (base: string,
 *   tip: string) => string[], openUnits: (parent: number|null) => number[],
 *   openTitled: (prefix: string) => OpenTicket[],
 *   refresh: (n: number, body: string) => void,
 *   comment: (n: number, text: string) => void,
 *   hasComment: (n: number, text: string) => boolean,
 *   close: (n: number, comment: string) => void}} DropFilerDeps `subjectsOf`
 *   the subjects of the commits on `tip` and not on `base`, newest first;
 *   `openUnits` the tickets rule:size-line weighs a new one under `parent`
 *   against: its sub-issues and this session's filings; `openTitled` the
 *   open issues whose titles start with `prefix`, read live; `refresh`
 *   replaces the issue's body; `comment` adds one; `hasComment` whether
 *   a comment on it holds `text`; `close` closes it with `comment`
 */

/**
 * The subjects of the drop's commits off the `main` it was merged onto,
 * newest first; throws where it has none.
 * @param {DropFilerDeps} deps
 * @param {Drop} d
 * @returns {[string, ...string[]]}
 */
function readDropSubjects(deps, d) {
	const [tip, ...rest] = deps.subjectsOf(d.onto, d.sha);
	if (tip === undefined)
		throw new Error(
			`${queueBranch(d.name)} at ${short(d.sha)} has no commit off ${short(d.onto)}`,
		);
	return [tip, ...rest];
}

/**
 * The lowest-numbered open ticket of the branch.
 * @param {DropFilerDeps} deps
 * @param {string} name
 * @returns {OpenTicket|null}
 */
function readOpenDropTicket(deps, name) {
	const [first] = deps
		.openTitled(dropTicketPrefix(name))
		.sort((a, b) => a.number - b.number);
	return first ?? null;
}

/**
 * The queue lander's keeper of a branch's fix ticket: filed, updated in
 * place where the branch's ticket is open, and closed once `main` holds the
 * work. Each branch is its own fix, so every ticket
 * rule:size-line would weigh a filing against is named checked.
 * @param {DropFilerDeps} deps
 * @returns {Pick<import("./queue-lander.js").QueueTracker,
 *   "fileDropTicket" | "findDropTicket" | "refreshDropTicket"
 *   | "closeDropTicket">}
 */
function dropTicketFiler(deps) {
	return {
		findDropTicket: (name) => readOpenDropTicket(deps, name)?.number ?? null,
		fileDropTicket(d, held) {
			const subjects = readDropSubjects(deps, d);
			const [subject] = subjects;
			const issue = dropTicketIssue(d, held, subject);
			const open = readOpenDropTicket(deps, d.name);
			if (open !== null) return updateTicket(deps, open, d, issue.body);
			const { n, line } = fileTicket(deps, {
				...issue,
				cited: citedByAny(subjects),
				checked: deps.openUnits,
			});
			return { number: n, line };
		},
		refreshDropTicket(ticket, d, held) {
			const [subject] = readDropSubjects(deps, d);
			deps.refresh(ticket, dropTicketIssue(d, held, subject).body);
		},
		closeDropTicket(ticket, d, main) {
			if (deps.stateOf(ticket) === "closed") return;
			deps.close(
				ticket,
				`Closed by the queue lander: \`main\` at ${main} holds the work of \`${queueBranch(d.name)}\` dropped at ${d.sha}.`,
			);
		},
	};
}

/**
 * The branch's open ticket made to name `d`: one comment added, then its
 * body replaced, or left alone where its body names `d`'s sha already, as a
 * filing whose number a crash kept from the drop record does. An update cut
 * short between the two finds its comment and adds no second.
 * @param {DropFilerDeps} deps
 * @param {OpenTicket} open
 * @param {Drop} d
 * @param {string} body
 * @returns {{number: number, line: string}}
 */
function updateTicket(deps, open, d, body) {
	const { number } = open;
	if (open.body.includes(d.sha))
		return { number, line: `fix ticket already open: #${number}` };
	if (!deps.hasComment(number, d.sha))
		deps.comment(
			number,
			`The queue lander dropped \`${queueBranch(d.name)}\` again, at ${d.sha}: ${buildCauseLine(d.cause)}. This ticket's body now describes that drop.`,
		);
	deps.refresh(number, body);
	return {
		number,
		line: `fix ticket updated: #${number} now names ${queueBranch(d.name)} at ${short(d.sha)}`,
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
 * @property {string} noun what a refusal calls it
 * @property {(parent: number|null) => readonly number[]} checked the open
 *   tickets it is named its own build unit beside under `parent`, past
 *   rule:size-line
 */

/**
 * Files `t` under the ticket its work cites, else standalone, returning its
 * number and the line naming it.
 * @param {FilerDeps} deps
 * @param {Ticket} t
 * @returns {{line: string, n: number}}
 */
function fileTicket(deps, t) {
	const listed = deps.similar(t.title);
	/** @param {Placement} placement */
	const file = (placement) =>
		deps.fileIssue(
			buildScriptFilerArgv({
				title: t.title,
				labels: [takesLabel("implement"), "kind:ticket"],
				placement,
				origin: "lander-script",
				distinctFrom: listed.map((c) => c.number),
				sizeLineChecked: t.checked(
					"parent" in placement ? placement.parent : null,
				),
			}),
			t.body,
		);
	const placed = fileUnderCited(t, file, deps);
	if ("filed" in placed) return placed.filed;
	const ran = file({ standalone: placed.why });
	if (ran.status === 0) return parseFiledLine(ran.stdout);
	const why = `${t.noun} for ${t.citer} not filed: ${parseMessageLine(ran.stderr)}`;
	throw ran.status === 2 ? new FilingRefusedError(why) : new Error(why);
}

/**
 * Files the ticket under the cited one: what file-issue printed, or why it
 * goes standalone.
 * @param {Ticket} t
 * @param {(placement: Placement) => Ran} file
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {{filed: {line: string, n: number}} | {why: string}}
 */
function fileUnderCited(t, file, deps) {
	if (t.cited === null) return { why: t.uncited };
	const unready = underCited(t.cited, t, deps);
	if (unready !== null) return { why: unready };
	const ran = file({ parent: t.cited });
	if (ran.status === 0) return { filed: parseFiledLine(ran.stdout) };
	return {
		why: `file-issue refused it under #${t.cited}, which ${t.citer} cites: ${parseMessageLine(ran.stderr)}`,
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
	const queue = liveQueueDeps(root);
	return {
		subjectsOf: (base, tip) =>
			readGitIn(root, ["log", "--format=%s", `${base}..${tip}`])
				.split("\n")
				.filter(Boolean),
		/* Throws on an unread list: a retried ticket that reached the tracker
		 * must not be filed a second time. */
		similar: (title) => similarTitles(repo(), title).found,
		/* The open issues listed, never searched: a search can miss a ticket
		 * filed moments ago, and a second would be filed beside it. */
		openTitled: (prefix) =>
			ghIssueListAll("drop fix tickets", [
				"--repo",
				repo(),
				"--state",
				"open",
				"--json",
				"number,title,body",
			]).filter((/** @type {OpenTicket} */ i) => i.title.startsWith(prefix)),
		refresh: queue.refresh,
		comment: (n, text) => {
			gh(["issue", "comment", String(n), "--repo", repo(), "--body", text]);
		},
		hasComment: (n, text) =>
			gh([
				"issue",
				"view",
				String(n),
				"--repo",
				repo(),
				"--json",
				"comments",
				"--jq",
				".comments[].body",
			]).includes(text),
		close: queue.close,
		fileIssue: queue.fileIssue,
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
	dropTicketFiler,
	liveFilerDeps,
};
