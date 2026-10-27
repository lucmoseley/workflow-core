/*
 * fix-ticket.js — the ticket the lander files for a commit it reverted
 * (#2404, spec #2261): `takes:implement`, naming the revert and the failing
 * files, a sub-issue of the ticket the culprit's subject cites, or standalone
 * where it cites none.
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
const { short } = require("./lander.js");
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

/**
 * @param {import("./lander.js").FixTicket & {subject: string}} t
 * @returns {{title: string, body: string}}
 */
function fixTicketIssue({ culprit, parent, revert, files, stale, subject }) {
	const cut =
		subject.length > SUBJECT_MAX
			? `${subject.slice(0, SUBJECT_MAX - 1)}…`
			: subject;
	const failing =
		files.length > 0
			? files.map((f) => `- \`${f}\``).join("\n")
			: "- the whole suite (the tester named no failing file)";
	/* The subject sits in a code span, so file-issue's body checks never read
	 * it as this ticket's own prose. */
	return {
		title: `Re-land ${short(culprit)}, reverted by the lander: ${cut}`,
		body: `## What to build

The lander (#2261) found ${culprit} red on \`landing\` and reverted it in ${revert}. Its work is off \`landing\` until it is re-landed with these passing.

Failing at ${short(culprit)}, red twice, with ${parent ? `its parent ${short(parent)}` : "no parent"} green:
${failing}

Reverted commit: \`${subject.replaceAll("`", "'")}\`
${buildRereadSection(stale, revert)}
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
function ticketFiler({ messageOf, similar, fileIssue, stateOf, reopen }) {
	return {
		fileFixTicket(t) {
			const subject = parseFirstLine(messageOf(t.culprit));
			const { title, body } = fixTicketIssue({ ...t, subject });
			const listed = similar(title);
			const filed = listed.find((c) => c.title.includes(short(t.culprit)));
			if (filed) return `fix ticket already open: #${filed.number}`;
			const distinct =
				listed.length > 0
					? ["--distinct-from", listed.map((c) => c.number).join(",")]
					: [];
			/** @param {string[]} placement */
			const file = (placement) =>
				fileIssue(
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
			const placed = fileUnderCited(citedTicket(subject), t, file, {
				stateOf,
				reopen,
			});
			if ("filed" in placed) return placed.filed;
			const ran = file(["--standalone", placed.why]);
			if (ran.status === 0) return ran.stdout.trim();
			throw new Error(
				`fix ticket for ${short(t.culprit)} not filed: ${parseFirstLine(ran.stderr)}`,
			);
		},
	};
}

/**
 * Files the ticket under the cited one: what file-issue printed, or why it
 * goes standalone.
 * @param {number|null} cited
 * @param {import("./lander.js").FixTicket} t
 * @param {(placement: string[]) => Ran} file
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {{filed: string} | {why: string}}
 */
function fileUnderCited(cited, t, file, deps) {
	if (cited === null)
		return {
			why: `${short(t.culprit)}'s subject cites no ticket of this repo.`,
		};
	const unready = underCited(cited, t, deps);
	if (unready !== null) return { why: unready };
	const ran = file(["--parent", String(cited)]);
	if (ran.status === 0) return { filed: ran.stdout.trim() };
	return {
		why: `file-issue refused it under #${cited}, which ${short(t.culprit)} cites: ${parseFirstLine(ran.stderr)}`,
	};
}

/**
 * Readies the cited ticket as the fix ticket's parent, reopening it where
 * closed; null where it is ready, else why it cannot be.
 * @param {number} cited
 * @param {import("./lander.js").FixTicket} t
 * @param {Pick<FilerDeps, "stateOf" | "reopen">} deps
 * @returns {string|null}
 */
function underCited(cited, t, { stateOf, reopen }) {
	try {
		if (stateOf(cited) === "closed")
			reopen(
				cited,
				`Reopened by the lander: ${t.culprit} was red on \`landing\` and is reverted in ${t.revert}. Its fix ticket follows as a sub-issue.`,
			);
		return null;
	} catch (err) {
		return `#${cited}, which ${short(t.culprit)} cites, could not be read or reopened: ${parseErrLine(err)}`;
	}
}

module.exports = { ticketFiler };
