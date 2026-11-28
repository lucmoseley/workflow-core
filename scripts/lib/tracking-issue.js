const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GH_TIMEOUT_MS, gh, ghIssueListAll } = require("./gh");

const issueBodyScript = () =>
	process.env.WFC_ISSUE_BODY || path.join(__dirname, "..", "issue-body.js");

/**
 * @param {{ title: string, label?: string, repo?: string }} spec
 * @param {"open" | "closed" | "all"} state
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {{ number: number, title: string, labels: string[], closedAt: string | null, createdAt: string } | null}
 */
function findTrackingIssue({ title, label, repo }, state, opts = {}) {
	/** @type {{ number: number, title: string, labels: { name: string }[], closedAt?: string | null, createdAt: string }[]} */
	const rows = ghIssueListAll(
		"issues",
		[
			"--state",
			state,
			...(label ? ["--label", label] : []),
			...(repo ? ["--repo", repo] : []),
			"--json",
			"number,title,labels,closedAt,createdAt",
		],
		opts,
	);
	const found = rows.find((r) => r.title === title);
	if (!found) return null;
	return {
		number: found.number,
		title: found.title,
		labels: (found.labels || []).map((l) => l.name),
		closedAt: found.closedAt || null,
		createdAt: found.createdAt,
	};
}

/**
 * @param {{ title: string, label?: string, repo?: string }} spec
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 */
const openTrackingIssue = (spec, opts = {}) =>
	findTrackingIssue(spec, "open", opts);

const takesValues = (/** @type {string[]} */ labels) =>
	labels.filter((l) => l.startsWith("takes:"));

/** @param {number} number @param {string[]} current @param {string} wanted @param {string} [repo] @returns {string} */
function reconcileTakes(number, current, wanted, repo) {
	const present = takesValues(current);
	if (present.length === 1 && present[0] === wanted) return "";
	const stale = present.filter((l) => l !== wanted);
	try {
		gh([
			"issue",
			"edit",
			String(number),
			...(repo ? ["--repo", repo] : []),
			"--add-label",
			wanted,
			...stale.flatMap((l) => ["--remove-label", l]),
		]);
	} catch (e) {
		return ` Could not set ${wanted} — ${e instanceof Error ? e.message : String(e)}`;
	}
	return ` ${stale.length > 0 ? `${stale.join(", ")} → ` : "Labelled "}${wanted}.`;
}

/**
 * @param {number} number
 * @param {string} wanted
 * @param {{repo?: string}} [opts]
 * @returns {string}
 */
function refresh(number, wanted, { repo } = {}) {
	const repoArgs = repo ? ["--repo", repo] : [];
	const current = gh([
		"issue",
		"view",
		String(number),
		...repoArgs,
		"--json",
		"body",
		"--jq",
		".body",
	]);
	if (current.trim() === wanted.trim())
		return `#${number} is open and current.`;

	const tmp = path.join(os.tmpdir(), `tracking-issue-${process.pid}.md`);
	fs.writeFileSync(tmp, wanted);
	try {
		execFileSync(
			"node",
			[
				issueBodyScript(),
				"replace",
				String(number),
				...repoArgs,
				"--file",
				tmp,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "inherit", "inherit"],
				timeout: GH_TIMEOUT_MS,
			},
		);
		return `Refreshed #${number}.`;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** @param {{ title: string, labels: string[], body: string, repo?: string }} spec @returns {string} */
function createIssue({ title, labels, body, repo }) {
	return gh([
		"issue",
		"create",
		...(repo ? ["--repo", repo] : []),
		"--title",
		title,
		...labels.flatMap((l) => ["--label", l]),
		"--body",
		body,
	]).trim();
}

/** @typedef {{ title: string, label?: string, labels: string[], takes?: string, body: string, repo?: string }} TrackingSpec */

/**
 * @param {TrackingSpec} spec
 * @returns {{ number: number | null, text: string }}
 */
function fileOrRefresh({ title, label, labels, takes, body, repo }) {
	const existing = openTrackingIssue({ title, label, repo });
	if (existing)
		return {
			number: existing.number,
			text:
				refresh(existing.number, body, { repo }) +
				(takes
					? reconcileTakes(existing.number, existing.labels, takes, repo)
					: ""),
		};

	const wanted = takes && !labels.includes(takes) ? [...labels, takes] : labels;
	const url = createIssue({ title, labels: wanted, body, repo });
	const n = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
	return { number: Number.isInteger(n) ? n : null, text: `Filed ${url}` };
}

module.exports = {
	createIssue,
	findTrackingIssue,
	openTrackingIssue,
	refresh,
	fileOrRefresh,
};
