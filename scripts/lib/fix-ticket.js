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
 */

const { citedIssues } = require("./cited-issues.js");
const { parseErrLine } = require("./gh.js");
const { parseFirstLine } = require("./first-line.js");
const { failingList, short } = require("./lander.js");
const { scriptPath } = require("./script-path.js");
const { takesLabel } = require("./takes-label.js");

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
 * The fix ticket's section naming the dependents reverted with the culprit
 * and each one's re-land ticket, empty where there are none.
 * @param {Reland[]} relands
 */
function buildDependentsSection(relands) {
	if (relands.length === 0) return "";
	return `
Reverted with it, as its revert conflicted with them (#4453), each with a re-land ticket of its own to land after this one:
${relands.map((r) => `- ${short(r.dependent.commit)}, reverted in ${r.dependent.revert}: ${FILED_ISSUE.exec(r.filed)?.[0] ?? r.filed}`).join("\n")}
`;
}

/** The issue a filing line names. */
const FILED_ISSUE = /#\d+/;

/**
 * @typedef {{dependent: import("./lander.js").Dependent, filed: string}}
 *   Reland a dependent and the line its re-land ticket's filing printed
 */

/**
 * The re-land ticket of a later commit reverted with `culprit` (#4453).
 * @param {import("./lander.js").Dependent} d
 * @param {{culprit: string, revert: string, subject: string}} with the culprit
 *   and its revert, and the dependent's own subject
 * @returns {{title: string, body: string}}
 */
function dependentIssue({ commit, revert, files }, { culprit, subject, ...t }) {
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
			const relands = (t.dependents ?? []).map((dependent) => {
				const subject = parseFirstLine(deps.messageOf(dependent.commit));
				return {
					dependent,
					filed: fileReland(deps, {
						sha: dependent.commit,
						subject,
						...dependentIssue(dependent, { ...t, subject }),
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
 * Files the re-land ticket of the reverted commit `sha` under the ticket its
 * subject cites, else standalone, returning the line naming it; one already
 * open is named, never filed again.
 * @param {FilerDeps} deps
 * @param {{sha: string, subject: string, title: string, body: string,
 *   reopenNote: string}} ticket
 * @returns {string}
 */
function fileReland(deps, { sha, subject, title, body, reopenNote }) {
	const listed = deps.similar(title);
	const filed = listed.find((c) =>
		c.title.startsWith(`Re-land ${short(sha)},`),
	);
	if (filed) return `fix ticket already open: #${filed.number}`;
	const distinct =
		listed.length > 0
			? ["--distinct-from", listed.map((c) => c.number).join(",")]
			: [];
	/** @param {string[]} placement */
	const file = (placement) =>
		deps.fileIssue(
			[
				"--title",
				title,
				"--label",
				takesLabel("implement"),
				"--label",
				"kind:ticket",
				...placement,
				...distinct,
				"--body-file",
				"-",
			],
			body,
		);
	const placed = fileUnderCited(
		citedTicket(subject),
		{ sha, reopenNote },
		file,
		deps,
	);
	if ("filed" in placed) return placed.filed;
	const ran = file(["--standalone", placed.why]);
	if (ran.status === 0) return ran.stdout.trim();
	throw new Error(
		`fix ticket for ${short(sha)} not filed: ${parseFirstLine(ran.stderr)}`,
	);
}

/**
 * Files the ticket under the cited one: what file-issue printed, or why it
 * goes standalone.
 * @param {number|null} cited
 * @param {{sha: string, reopenNote: string}} t the reverted commit, and the
 *   comment a closed cited ticket is reopened with
 * @param {(placement: string[]) => Ran} file
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {{filed: string} | {why: string}}
 */
function fileUnderCited(cited, t, file, deps) {
	if (cited === null)
		return {
			why: `${short(t.sha)}'s subject cites no ticket of this repo.`,
		};
	const unready = underCited(cited, t, deps);
	if (unready !== null) return { why: unready };
	const ran = file(["--parent", String(cited)]);
	if (ran.status === 0) return { filed: ran.stdout.trim() };
	return {
		why: `file-issue refused it under #${cited}, which ${short(t.sha)} cites: ${parseFirstLine(ran.stderr)}`,
	};
}

/**
 * Readies the cited ticket as the fix ticket's parent, reopening it where
 * closed; null where it is ready, else why it cannot be.
 * @param {number} cited
 * @param {{sha: string, reopenNote: string}} t
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {string|null}
 */
function underCited(cited, t, { stateOf, reopen }) {
	try {
		if (stateOf(cited) === "closed") reopen(cited, t.reopenNote);
		return null;
	} catch (err) {
		return `#${cited}, which ${short(t.sha)} cites, could not be read or reopened: ${parseErrLine(err)}`;
	}
}

module.exports = { ticketFiler };
