const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseErrorText } = require("./caught.js");
const { parseFiledLine } = require("./filed-line.js");
const { buildScriptFilerArgv } = require("./script-filer-argv.js");
const { parseFirstLine } = require("./first-line.js");
const { GH_TIMEOUT_MS, gh, ghIssueListAll } = require("./gh.js");
const { gateLinesOf } = require("./issue-gate.js");
const { buildStandaloneLine } = require("./standalone-line.js");
const { similarTitles } = require("./tracker-ops.js");
const { refresh: refreshBody } = require("./tracking-issue.js");
const { takesLabel } = require("./takes-label.js");
const { tickBeforeClose } = require("./ticket-criteria.js");
const { URGENT_LABEL } = require("./urgent-label.js");
const { requireKey } = require("./workflow-core-config.js");

const LABELS = [URGENT_LABEL, "bug", takesLabel("implement"), "kind:ticket"];

/**
 * @typedef {object} QueueIssueDeps
 * @property {(title: string) =>
 *   {number: number, labels: string[], body: string}|null} openIssue
 * @property {(title: string) => {number: number, title: string}[]} similar
 * @property {(args: string[], input: string) =>
 *   import("./fix-ticket.js").Ran} fileIssue
 * @property {(n: number, body: string) => string} refresh
 * @property {(n: number, labels: string[]) => void} addLabels
 * @property {(n: number, comment: string) => void} close
 * @typedef {object} QueueIssue
 * @property {string} title
 * @property {string} standalone
 * @property {string} noun
 * @property {string} subject
 * @property {string} origin
 */

/**
 * @param {QueueIssueDeps} deps
 * @returns {(issue: QueueIssue, body: string) => string}
 */
function queueIssueFiler({
	openIssue,
	similar,
	fileIssue,
	refresh,
	addLabels,
}) {
	return ({ title, standalone, noun, subject, origin }, text) => {
		const body = `${text.trimEnd()}\n\n${buildStandaloneLine(standalone)}\n`;
		const found = openIssue(title);
		if (found !== null) {
			const gateLines = gateLinesOf(found.body);
			const kept = gateLines === null ? body : `${body}\n${gateLines}\n`;
			return `${noun}: ${refresh(found.number, kept)}${relabel(found, addLabels)}`;
		}
		const listed = similar(title);
		const ran = fileIssue(
			buildScriptFilerArgv({
				title,
				labels: LABELS,
				placement: { standalone },
				origin,
				distinctFrom: listed.map((c) => c.number),
			}),
			body,
		);
		if (ran.status === 0) return parseFiledLine(ran.stdout).line;
		throw new Error(
			`file-issue refused it for ${subject}: ${parseFirstLine(ran.stderr)}`,
		);
	};
}

/**
 * @param {Pick<QueueIssueDeps, "openIssue" | "refresh" | "close">} deps
 * @returns {(title: string, criterion: string,
 *   why: (body: string) => string|null) => number|null}
 */
function queueIssueCloser({ openIssue, refresh, close }) {
	return (title, criterion, why) => {
		const found = openIssue(title);
		const comment = found === null ? null : why(found.body);
		if (found === null || comment === null) return null;
		tickBeforeClose(found.number, found.body, criterion, refresh);
		close(found.number, comment);
		return found.number;
	};
}

/**
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

// guess, #5644: a filing's create and its parent link, each one gh call
const FILING_TIMEOUT_MS = 2 * GH_TIMEOUT_MS;

/**
 * @param {string} root
 * @returns {QueueIssueDeps["fileIssue"]}
 */
const fileIssueIn = (root) => (args, input) => {
	const r = spawnSync(
		process.execPath,
		[path.join(__dirname, "..", "file-issue.js"), ...args],
		{ cwd: root, encoding: "utf8", input, timeout: FILING_TIMEOUT_MS },
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
