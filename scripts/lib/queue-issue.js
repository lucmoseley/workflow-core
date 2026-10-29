/*
 * queue-issue.js — the one open issue the landing queue keeps per condition
 * (#2406, #2692): the lander's held-queue issue, the refill loop's stall
 * ticket. Both are `urgent` and `bug`, so the refill loop launches them first
 * (#2694, ruled at #2672). Found among the open issues by its fixed title,
 * filed through file-issue.js where none is open, else its body refreshed. The
 * body carries its own `Standalone:` line, so file-issue.js adds none and a
 * refresh of an unchanged condition finds it current. A refresh replaces the
 * whole body, carrying over a `**Gated on:**` line a session wrote there
 * (#3636).
 *
 * Residual: a retitled open issue is not found, and the next filing files a
 * second.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseErrorText } = require("./caught.js");
const { parseFirstLine } = require("./first-line.js");
const { gh, ghIssueListAll } = require("./gh.js");
const { gateOnLineOf } = require("./issue-gate.js");
const { similarTitles } = require("./tracker-ops.js");
const { refresh: refreshBody } = require("./tracking-issue.js");
const { takesLabel } = require("./takes-label.js");
const { requireKey } = require("./workflow-core-config.js");

const LABELS = ["urgent", "bug", takesLabel("implement"), "kind:ticket"];

/**
 * @typedef {object} QueueIssueDeps
 * @property {(title: string) =>
 *   {number: number, labels: string[], body: string}|null} openIssue the open
 *   issue with exactly `title`, throwing where the tracker cannot be read
 * @property {(title: string) => {number: number, title: string}[]} similar
 * @property {(args: string[], input: string) =>
 *   import("./fix-ticket.js").Ran} fileIssue
 * @property {(n: number, body: string) => string} refresh replaces the
 *   issue's body where it differs, returning what it did
 * @property {(n: number, labels: string[]) => void} addLabels
 * @property {(n: number, comment: string) => void} close
 * @typedef {object} QueueIssue
 * @property {string} title
 * @property {string} standalone why it sits under no parent
 * @property {string} noun what a refresh line calls it
 * @property {string} subject what a refusal names it filed for
 */

/**
 * @param {QueueIssueDeps} deps
 * @returns {(issue: QueueIssue, body: string) => string} files or refreshes
 *   the issue, returning a line naming it
 */
function queueIssueFiler({
	openIssue,
	similar,
	fileIssue,
	refresh,
	addLabels,
}) {
	return ({ title, standalone, noun, subject }, text) => {
		const body = `${text.trimEnd()}\n\nStandalone: ${standalone}\n`;
		const found = openIssue(title);
		if (found !== null) {
			const gate = gateOnLineOf(found.body);
			const kept = gate === null ? body : `${body}\n${gate}\n`;
			return `${noun}: ${refresh(found.number, kept)}${relabel(found, addLabels)}`;
		}
		const listed = similar(title);
		const ran = fileIssue(
			[
				"--title",
				title,
				...LABELS.flatMap((l) => ["--label", l]),
				"--standalone",
				standalone,
				...(listed.length > 0
					? ["--distinct-from", listed.map((c) => c.number).join(",")]
					: []),
				"--body-file",
				"-",
			],
			body,
		);
		if (ran.status === 0) return ran.stdout.trim();
		throw new Error(
			`file-issue refused it for ${subject}: ${parseFirstLine(ran.stderr)}`,
		);
	};
}

/**
 * @param {Pick<QueueIssueDeps, "openIssue" | "close">} deps
 * @returns {(title: string, why: (body: string) => string|null) =>
 *   number|null} closes the open issue titled `title` with the comment `why`
 *   makes of its body, returning its number, or null where none is open or
 *   `why` gives none
 */
function queueIssueCloser({ openIssue, close }) {
	return (title, why) => {
		const found = openIssue(title);
		const comment = found === null ? null : why(found.body);
		if (found === null || comment === null) return null;
		close(found.number, comment);
		return found.number;
	};
}

/**
 * A failed edit reports rather than throws, as the body has already landed.
 *
 * Residual: the issue stays without the missing labels until the next refresh,
 * which for the held-queue issue is the next hold.
 *
 * @param {{number: number, labels: string[]}} found
 * @param {QueueIssueDeps["addLabels"]} addLabels
 */
function relabel({ number, labels }, addLabels) {
	const missing = LABELS.filter((l) => !labels.includes(l));
	if (missing.length === 0) return "";
	try {
		addLabels(number, missing);
	} catch (e) {
		return ` Could not re-add ${missing.join(", ")}: ${parseFirstLine(parseErrorText(e))}`;
	}
	return ` Re-added ${missing.join(", ")}.`;
}

/**
 * @param {string} root
 * @returns {QueueIssueDeps["fileIssue"]}
 */
const fileIssueIn = (root) => (args, input) => {
	const r = spawnSync(
		process.execPath,
		[path.join(__dirname, "..", "file-issue.js"), ...args],
		{ cwd: root, encoding: "utf8", input },
	);
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr || r.error?.message || "",
	};
};

/**
 * @param {string} root
 * @returns {QueueIssueDeps}
 */
function liveQueueDeps(root) {
	const repo = () => requireKey("tracker", { root });
	return {
		openIssue: (title) => {
			/** @type {{number: number, title: string, body: string, labels: {name: string}[]}|undefined} */
			const found = ghIssueListAll("issues", [
				"--repo",
				repo(),
				"--state",
				"open",
				"--json",
				"number,title,labels,body",
			]).find((/** @type {{title: string}} */ r) => r.title === title);
			return found
				? {
						number: found.number,
						labels: found.labels.map((l) => l.name),
						body: found.body,
					}
				: null;
		},
		similar: (title) => {
			try {
				return similarTitles(repo(), title).found;
			} catch {
				/* file-issue.js runs the same check itself and refuses on it
				 * (#2406). */
				return [];
			}
		},
		fileIssue: fileIssueIn(root),
		refresh: (n, body) => refreshBody(n, body, { repo: repo() }),
		addLabels: (n, labels) => {
			gh([
				"issue",
				"edit",
				String(n),
				"--repo",
				repo(),
				...labels.flatMap((l) => ["--add-label", l]),
			]);
		},
		close: (n, comment) => {
			gh(["issue", "close", String(n), "--repo", repo(), "--comment", comment]);
		},
	};
}

module.exports = { queueIssueFiler, queueIssueCloser, liveQueueDeps };
