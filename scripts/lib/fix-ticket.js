const { citedIssues } = require("./cited-issues.js");
const {
	buildCauseLine,
	buildDropAcceptance,
	buildDropEvidence,
} = require("./drop-evidence.js");
const { parseFiledLine } = require("./filed-line.js");
const { buildScriptFilerArgv } = require("./script-filer-argv.js");
const { FilingRefusedError } = require("./filing-refused.js");
const { gh, ghIssueListAll, parseErrLine } = require("./gh.js");
const { spawnGitSync } = require("./git.js");
const { parseMessageLine } = require("./first-line.js");
const { LANDER_GIT_TIMEOUT_MS, short } = require("./lander-git.js");
const { queueBranch } = require("./landing-refs.js");
const { liveQueueDeps } = require("./queue-issue.js");
const { takesLabel } = require("./takes-label.js");
const { tickBeforeClose } = require("./ticket-criteria.js");
const { similarTitles } = require("./tracker-ops.js");
const { readOwnFilings } = require("./own-acts.js");
const { readSubIssues } = require("./issue-tree.js");
const { requireKey } = require("./workflow-core-config.js");

/**
 * @typedef {import("./lander-records.js").Drop} Drop
 * @typedef {import("./queue-lander.js").DroppedRef} DroppedRef
 */

// guess, workflow-core#5529
const SUBJECT_MAX = 72;

/**
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

const quoteSubject = (/** @type {string} */ subject) =>
	`\`${subject.replaceAll("`", "'")}\``;

/**
 * @typedef {{status: number|null, stdout: string, stderr: string}} Ran
 * @typedef {import("./script-filer-argv.js").Placement} Placement
 * @typedef {object} FilerDeps
 * @property {(title: string) => {number: number, title: string}[]} similar
 * @property {(args: string[], input: string) => Ran} fileIssue
 * @property {(n: number) => "open" | "closed"} stateOf
 * @property {(n: number, comment: string) => void} reopen
 */

/**
 * @param {readonly string[]} subjects
 * @returns {number|null}
 */
const citedByAny = (subjects) =>
	subjects.map(citedTicket).find((n) => n !== null) ?? null;

/**
 * @param {string} name
 */
const dropTicketPrefix = (name) => `Fix ${queueBranch(name)},`;

/**
 * @param {Drop} d
 * @param {readonly DroppedRef[]} held
 * @param {string} subject
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

The queue lander (workflow-core#4458) dropped \`${queued}\` at ${sha}: ${buildDropEvidence(d)}

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
 *   bodyOf: (n: number) => string,
 *   openTitled: (prefix: string) => OpenTicket[],
 *   refresh: (n: number, body: string) => void,
 *   comment: (n: number, text: string) => void,
 *   hasComment: (n: number, text: string) => boolean,
 *   close: (n: number, comment: string) => void}} DropFilerDeps
 */

/**
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
			tickBeforeClose(
				ticket,
				deps.bodyOf(ticket),
				buildDropAcceptance(d),
				deps.refresh,
			);
			deps.close(
				ticket,
				`Closed by the queue lander: \`main\` at ${main} holds the work of \`${queueBranch(d.name)}\` dropped at ${d.sha}.`,
			);
		},
	};
}

/**
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
 * @typedef {object} Ticket
 * @property {string} title
 * @property {string} body
 * @property {number|null} cited
 * @property {string} citer
 * @property {string} uncited
 * @property {string} reopenNote
 * @property {string} noun
 * @property {(parent: number|null) => readonly number[]} checked
 */

/**
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
	const r = spawnGitSync(args, {
		cwd: root,
		encoding: "utf8",
		timeout: LANDER_GIT_TIMEOUT_MS,
	});
	if (r.status !== 0)
		throw new Error(
			`git ${args[0]} could not read ${args.at(-1)}: ${r.stderr.trim() || r.error?.message}`,
		);
	return r.stdout;
}

/**
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
		similar: (title) => similarTitles(repo(), title).found,
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
		bodyOf: (n) =>
			gh([
				"issue",
				"view",
				String(n),
				"--repo",
				repo(),
				"--json",
				"body",
				"--jq",
				".body",
			]),
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
