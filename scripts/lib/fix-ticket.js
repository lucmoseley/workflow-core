/*
 * fix-ticket.js — the ticket the lander files for a commit it reverted
 * (#2404, spec #2261): `takes:implement`, naming the revert and the failing
 * files or CI jobs, a sub-issue of the ticket the culprit's subject cites, or standalone
 * where it cites none. Each later commit reverted with it, as its revert
 * conflicted with them (#4453), gets a re-land ticket of its own, filed first
 * so the culprit's can name them.
 *
 * A cited ticket that is closed is reopened first, its work having
 * been reverted: file-issue.js refuses a closed parent, whose children drop
 * off every map, and an open parent with an open child reads as a container,
 * leaving the fix ticket the one on the frontier. A filing file-issue.js
 * refuses under the cited ticket is filed standalone, naming the refusal.
 *
 * The queue lander's (#4458) is filed the same way for a queue ref it
 * dropped: naming the ref, its sha, the dropped ref and the files it
 * conflicted in or the refusal that stopped its merge, under the ticket its
 * newest citing commit's subject cites. `liveFilerDeps` gives both filers
 * their tracker, file-issue.js and git.
 */

const { citedIssues } = require("./cited-issues.js");
const { gh, parseErrLine } = require("./gh.js");
const { spawnGitSync } = require("./git.js");
const { parseFirstLine } = require("./first-line.js");
const { failingList, short } = require("./lander.js");
const { QUEUE_PREFIX } = require("./landing-refs.js");
const { liveQueueDeps } = require("./queue-issue.js");
const { scriptPath } = require("./script-path.js");
const { takesLabel } = require("./takes-label.js");
const { similarTitles } = require("./tracker-ops.js");
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

/**
 * The guard-registry rows the revert left stale, which the lander lands
 * rather than re-anchoring unread, or a line saying they could not be read
 * (#3127).
 * @param {import("./lander.js").RegistryRow[]|null} stale
 * @param {string} revert
 */
function buildRereadSection(stale, revert) {
	if (stale === null)
		return `
The lander could not read which guard-registry rows the revert left stale (#3127). Run \`node ${scriptPath("check-guard-registry.js")} --touched-by ${revert}\`, then re-read and re-anchor each row it names.
`;
	if (stale.length === 0) return "";
	return `
The revert left these guard-registry rows stale, which the lander lands rather than re-anchoring unread (#3127). Re-read each rule against the guard as reverted, correct any sentence no longer true, then re-anchor:
${stale.map((r) => `- \`${r.row}\`: \`${r.forward}\``).join("\n")}
`;
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
 * @param {Reland[]} relands
 */
function buildDependentsSection(relands) {
	if (relands.length === 0) return "";
	return `
Reverted with it, as its revert conflicted with them (#4453), each with a re-land ticket of its own to land after this one:
${relands.map((r) => `- ${short(r.dependent.commit)}, reverted in ${r.dependent.revert}: ${FILED_ISSUE.exec(r.filed)?.[0] ?? r.filed}`).join("\n")}
`;
}

const FILED_ISSUE = /#\d+/;

/**
 * @typedef {{dependent: import("./lander.js").Dependent, filed: string}}
 *   Reland a dependent and the line its re-land ticket's filing printed
 */

/**
 * @param {import("./lander.js").Dependent} d
 * @param {{culprit: string, revert: string, subject: string}} with the culprit
 *   and its revert, and the dependent's own subject
 * @returns {{title: string, body: string}}
 */
function buildDependentIssue(
	{ commit, revert, files },
	{ culprit, subject, ...t },
) {
	return {
		title: `Re-land ${short(commit)}, reverted with ${short(culprit)} by the lander: ${cutSubject(subject)}`,
		body: `## What to build

The lander (#2261) found ${culprit} red on \`landing\`. Its revert conflicted with ${commit}, a later commit${files.length > 0 ? ` that changed ${files.map((f) => `\`${f}\``).join(", ")}` : ""}, so the lander reverted ${short(commit)} in ${revert} and then ${short(culprit)} in ${t.revert} (#4453). ${short(commit)} was not found red itself.

Reverted commit: ${quoteSubject(subject)}

## Acceptance criteria

- [ ] ${short(commit)}'s change is pushed to \`landing\` again, after ${short(culprit)}'s own re-land ticket lands.
`,
	};
}

/**
 * @param {import("./lander.js").FixTicket & {subject: string, relands: Reland[]}} t
 * @returns {{title: string, body: string}}
 */
function fixTicketIssue({
	culprit,
	parent,
	revert,
	files,
	jobs,
	failures,
	stale,
	subject,
	relands,
}) {
	return {
		title: `Re-land ${short(culprit)}, reverted by the lander: ${cutSubject(subject)}`,
		body: `## What to build

The lander (#2261) found ${culprit} red on \`landing\` and reverted it in ${revert}. Its work is off \`landing\` until it is re-landed with these passing.

Failing at ${short(culprit)}, red twice, with ${parent ? `its parent ${short(parent)}` : "no parent"} green:
${failingList({ files, jobs, failures })}

Reverted commit: ${quoteSubject(subject)}
${buildDependentsSection(relands)}${buildRereadSection(stale, revert)}
## Acceptance criteria

- [ ] ${short(culprit)}'s change is pushed to \`landing\` again, with each failing test above passing.
${stale === null || stale.length > 0 ? "- [ ] Each stale row above is re-read and re-anchored.\n" : ""}`,
	};
}

/**
 * @typedef {{status: number|null, stdout: string, stderr: string}} Ran
 * @typedef {object} FilerDeps
 * @property {(sha: string) => string} messageOf the commit's full message,
 *   throwing where git cannot read it
 * @property {(title: string) => {number: number, title: string}[]} similar
 *   the open issues whose titles resemble `title`
 * @property {(args: string[], input: string) => Ran} fileIssue runs
 *   file-issue.js with `args`, the body on stdin
 * @property {(n: number) => "open" | "closed"} stateOf the issue's state,
 *   throwing where it cannot be read
 * @property {(n: number, comment: string) => void} reopen
 */

/**
 * @param {FilerDeps} deps
 * @returns {Pick<import("./lander.js").LanderTracker, "fileFixTicket">}
 */
function ticketFiler(deps) {
	return {
		fileFixTicket(t) {
			/* A dependent's filing that throws leaves the culprit's unfiled too:
			 * the lander holds on it and files again, each one already filed
			 * then found open rather than filed twice. */
			const relands = (t.dependents ?? []).map((dependent) => {
				const subject = parseFirstLine(deps.messageOf(dependent.commit));
				return {
					dependent,
					filed: fileReland(deps, {
						sha: dependent.commit,
						subject,
						...buildDependentIssue(dependent, { ...t, subject }),
						reopenNote: `Reopened by the lander: ${dependent.commit} is reverted in ${dependent.revert} with ${t.culprit}, which was red on \`landing\` and whose revert conflicted with it. Its re-land ticket follows as a sub-issue.`,
					}),
				};
			});
			const subject = parseFirstLine(deps.messageOf(t.culprit));
			const filed = fileReland(deps, {
				sha: t.culprit,
				subject,
				...fixTicketIssue({ ...t, subject, relands }),
				reopenNote: `Reopened by the lander: ${t.culprit} was red on \`landing\` and is reverted in ${t.revert}. Its fix ticket follows as a sub-issue.`,
			});
			return [...relands.map((r) => r.filed), filed].join("\n");
		},
	};
}

/**
 * The ticket its member's commits cite: the newest commit's citation, as
 * the subject that cites it names the work it carries.
 * @param {readonly string[]} subjects newest first
 * @returns {number|null}
 */
const citedByAny = (subjects) =>
	subjects.map(citedTicket).find((n) => n !== null) ?? null;

/**
 * The evidence a drop's merge left: the files it conflicted in, or the
 * refusal that stopped it.
 * @param {import("./queue-lander.js").Unmerged} cause
 */
const buildDropEvidence = (cause) =>
	cause.kind === "conflict"
		? `it conflicts with \`main\` in:\n${cause.files.map((f) => `- \`${f}\``).join("\n")}`
		: `its merge was refused: ${quoteSubject(cause.reason)}`;

/**
 * @param {import("./queue-lander.js").Drop & {subject: string}} d
 * @returns {{title: string, body: string}}
 */
function dropTicketIssue({ name, sha, ref, onto, cause, subject }) {
	const queued = `${QUEUE_PREFIX}${name}`;
	return {
		title: `Fix ${queued} at ${short(sha)}, dropped by the queue lander: ${cutSubject(subject)}`,
		body: `## What to build

The queue lander (#4458) dropped \`${queued}\` at ${sha}: merged alone onto \`main\` at ${onto}, ${buildDropEvidence(cause)}

Its commits are kept at \`${ref}\`, which the lander deletes once this ticket closes.

Tip commit: ${quoteSubject(subject)}

## Acceptance criteria

- [ ] ${short(sha)}'s change merges onto \`main\`${cause.kind === "conflict" ? ", each file above settled," : ""} and is pushed to \`${queued}\` again.
`,
	};
}

/**
 * @typedef {Omit<FilerDeps, "messageOf"> & {subjectsOf: (base: string,
 *   tip: string) => string[]}} DropFilerDeps `subjectsOf` the subjects of
 *   the commits on `tip` and not on `base`, newest first
 */

/**
 * The queue lander's filer of a dropped member's fix ticket: `takes:implement`,
 * unassigned, under the ticket its commits cite, else standalone.
 * @param {DropFilerDeps} deps
 * @returns {Pick<import("./queue-lander.js").QueueTracker, "fileDropTicket">}
 */
function dropTicketFiler(deps) {
	return {
		fileDropTicket(d) {
			const subjects = deps.subjectsOf(d.onto, d.sha);
			const queued = `${QUEUE_PREFIX}${d.name}`;
			return fileTicket(deps, {
				...dropTicketIssue({ ...d, subject: subjects[0] ?? "" }),
				cited: citedByAny(subjects),
				citer: `a commit on ${queued}`,
				uncited: `No commit on ${queued} cites a ticket of this repo.`,
				reopenNote: `Reopened by the queue lander: ${queued} at ${d.sha}, which cites it, was dropped. Its fix ticket follows as a sub-issue.`,
				noun: "fix ticket",
				filedAs: `Fix ${queued} at ${short(d.sha)},`,
			});
		},
	};
}

/**
 * Files the re-land ticket of the reverted commit `sha` under the ticket its
 * subject cites, else standalone, returning the line naming it.
 * @param {FilerDeps} deps
 * @param {{sha: string, subject: string, title: string, body: string,
 *   reopenNote: string}} ticket
 * @returns {string}
 */
function fileReland(deps, { sha, subject, ...ticket }) {
	const cited = citedTicket(subject);
	return fileTicket(deps, {
		...ticket,
		cited,
		citer: short(sha),
		uncited: `${short(sha)}'s subject cites no ticket of this repo.`,
		noun: "re-land ticket",
		filedAs: `Re-land ${short(sha)},`,
	});
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
 */

/**
 * Files `t` under the ticket its work cites, else standalone, returning the
 * line naming it; an open one whose title starts `filedAs` is named instead.
 * @param {Omit<FilerDeps, "messageOf">} deps
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
	/** @param {string[]} placement */
	const file = (placement) =>
		deps.fileIssue(
			[
				"--title",
				t.title,
				"--label",
				takesLabel("implement"),
				"--label",
				"kind:ticket",
				...placement,
				...distinct,
				"--body-file",
				"-",
			],
			t.body,
		);
	const placed = fileUnderCited(t, file, deps);
	if ("filed" in placed) return placed.filed;
	const ran = file(["--standalone", placed.why]);
	if (ran.status === 0) return ran.stdout.trim();
	throw new Error(
		`${t.noun} for ${t.citer} not filed: ${parseFirstLine(ran.stderr)}`,
	);
}

/**
 * Files the ticket under the cited one: what file-issue printed, or why it
 * goes standalone.
 * @param {Ticket} t
 * @param {(placement: string[]) => Ran} file
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {{filed: string} | {why: string}}
 */
function fileUnderCited(t, file, deps) {
	if (t.cited === null) return { why: t.uncited };
	const unready = underCited(t.cited, t, deps);
	if (unready !== null) return { why: unready };
	const ran = file(["--parent", String(t.cited)]);
	if (ran.status === 0) return { filed: ran.stdout.trim() };
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
 * The tracker, file-issue.js and git both filers run on, in `root`.
 * @param {string} root
 * @returns {FilerDeps & DropFilerDeps}
 */
function liveFilerDeps(root) {
	const repo = () => requireKey("tracker", { root });
	return {
		messageOf: (sha) => readGitIn(root, ["log", "-1", "--format=%B", sha]),
		subjectsOf: (base, tip) =>
			readGitIn(root, ["log", "--format=%s", `${base}..${tip}`])
				.split("\n")
				.filter(Boolean),
		/* Throws on an unread list, unlike liveQueueDeps's: a retried ticket
		 * that reached the tracker must not be filed a second time. */
		similar: (title) => similarTitles(repo(), title).found,
		fileIssue: liveQueueDeps(root).fileIssue,
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

module.exports = { dropTicketFiler, liveFilerDeps, ticketFiler };
