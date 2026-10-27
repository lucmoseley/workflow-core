/*
 * The shape of a tracked issue, shared rather than copied per caller — a second
 * copy lets callers drift while each side's own tests pass.
 *
 * ONE ISSUE PER STANDING CONDITION (`fileOrRefresh`) — the shape mantahostels#389 ruled
 * for the operating manual and mantahostels#971 reused for docs/doc-map.md §B's word
 * budget. A standing condition is repo state that no push causes and no push
 * cures: the manual is behind the roadmap, or §B is over budget. Gating
 * push/pull_request on one reddens commits that neither caused it nor could
 * fix it (mantahostels#389), so the scheduled sweep files ONE issue and keeps its body
 * current instead.
 *
 * The rotating shape that lived here — a fresh issue per reading — is gone with
 * its only caller (mantahostels#2880): the cost-per-unit series it served now appends to a
 * tracked file, and mantahostels#2757's rotation was a way of keeping a perpetual condition
 * in the tracker without leaving one issue permanently open.
 *
 * `issue-body.js` is located beside this file, so a caller may run from any
 * cwd (#343).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gh, ghIssueListAll } = require("./gh");

/** WFC_ISSUE_BODY replaces the path for tests only, whose stub sits under their own cwd (#341). */
const issueBodyScript = () =>
	process.env.WFC_ISSUE_BODY || path.join(__dirname, "..", "issue-body.js");

/**
 * The issue tracking this condition in `state`, or null.
 *
 * Matched on label AND exact title: the label alone would collide with every
 * other issue a human files under it. With no label, on the title alone — for
 * an issue whose label the session that takes it may change (#1104).
 *
 * `labels` rides along on the same query rather than costing a second call —
 * `reconcileTakes` below needs the issue's current `takes:` value, and asking
 * for one more JSON field here is free (mantahostels#1079). `closedAt` rides
 * along the same way, for a filer that re-arms only after a close (#1219);
 * null on an open issue. `createdAt` too, for a filer that asks whether
 * anything followed the issue's filing (#1378).
 *
 * @param {{ title: string, label?: string }} spec
 * @param {"open" | "closed" | "all"} state `all` for a filer that stops once
 *   its issue exists, open or closed (#1104); `closed` for one that asks how
 *   its newest closed issue was closed (#1378)
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {{ number: number, title: string, labels: string[], closedAt: string | null, createdAt: string } | null}
 */
function findTrackingIssue({ title, label }, state, opts = {}) {
	/** @type {{ number: number, title: string, labels: { name: string }[], closedAt?: string | null, createdAt: string }[]} */
	const rows = ghIssueListAll(
		"issues",
		[
			"--state",
			state,
			...(label ? ["--label", label] : []),
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
 * @param {{ title: string, label?: string }} spec
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 */
const openTrackingIssue = (spec, opts = {}) =>
	findTrackingIssue(spec, "open", opts);

const takesValues = (/** @type {string[]} */ labels) =>
	labels.filter((l) => l.startsWith("takes:"));

/**
 * Move the tracking issue's `takes:` label to `wanted`.
 *
 * A tracking issue's actionable state changes under it — mantahostels#1079's drain queue
 * empties and refills without anyone touching the issue — and `takes:` is what
 * `scripts/pick-next.js` reads to decide which command it offers.
 *
 * Reconciled on every refresh, not only on a change of state: the label is the
 * reporter's to own, so a hand-set value is overwritten rather than respected.
 *
 * **The label is not the run's job — the body is.** A failed `gh issue edit`
 * therefore reports and returns rather than throwing: the body has already
 * landed by the time this is called, and letting the edit's error out would
 * cost the caller its refresh line and exit 2 on a run that did the work. The
 * residual is a label left stale until the next sweep, which recomputes it from
 * scratch and so needs no repair.
 *
 * @param {number} number
 * @param {string[]} current every label the issue carries now
 * @param {string} wanted the single `takes:` value it should carry
 * @returns {string} what happened, for the caller to print
 */
function reconcileTakes(number, current, wanted) {
	const present = takesValues(current);
	if (present.length === 1 && present[0] === wanted) return "";
	const stale = present.filter((l) => l !== wanted);
	try {
		gh([
			"issue",
			"edit",
			String(number),
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
 * Bring an open tracking issue's body up to date.
 *
 * The body, never a comment: a body edit notifies nobody, so a debt taking weeks
 * to clear updates silently instead of mailing every morning. Written through
 * `scripts/issue-body.js`, the only sanctioned route to a body (mantahostels#131). Its
 * `replace` only refuses a write landing during the call itself — a body
 * someone has annotated by hand since the last refresh is silently
 * overwritten, not protected.
 *
 * @param {number} number
 * @param {string} wanted
 * @param {{repo?: string}} [opts] the tracker, where it is not the cwd's
 * @returns {string} what happened, for the caller to print
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
			// Run, not printed, so located absolutely rather than via scriptPath().
			[
				issueBodyScript(),
				"replace",
				String(number),
				...repoArgs,
				"--file",
				tmp,
			],
			{ encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
		);
		return `Refreshed #${number}.`;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/**
 * `gh issue create`, trimmed. The one shape `fileOrRefresh` files with — kept
 * separate from it so a second filing caller cannot drift from the first.
 *
 * @param {{ title: string, labels: string[], body: string }} spec
 * @returns {string} the created issue's URL
 */
function createIssue({ title, labels, body }) {
	return gh([
		"issue",
		"create",
		"--title",
		title,
		...labels.flatMap((l) => ["--label", l]),
		"--body",
		body,
	]).trim();
}

/**
 * File the tracking issue, or refresh the one already open.
 *
 * `labels` carries the `takes:` value as well as the finding label: every open
 * issue needs one naming what opens it, and a create from inside a workflow is
 * invisible to the guard-issue-create-label core, which sees Bash tool calls
 * only (mantahostels#470). `labels` applies at CREATE only; `takes`, optional, is what
 * keeps the value right on a REFRESH, when the condition's actionable state has
 * moved since the issue was filed (mantahostels#1079). A caller passing `takes` need not
 * repeat it in `labels` — it is added to the create's labels here, so the two
 * cannot be made to disagree. With no `label`, the open issue is found by its
 * title alone, as `findTrackingIssue` says.
 *
 * @param {{ title: string, label?: string, labels: string[], takes?: string, body: string }} spec
 * @returns {string} what happened, for the caller to print
 */
function fileOrRefresh({ title, label, labels, takes, body }) {
	const existing = openTrackingIssue({ title, label });
	if (existing)
		return (
			refresh(existing.number, body) +
			(takes ? reconcileTakes(existing.number, existing.labels, takes) : "")
		);

	const wanted = takes && !labels.includes(takes) ? [...labels, takes] : labels;
	return `Filed ${createIssue({ title, labels: wanted, body })}`;
}

module.exports = {
	createIssue,
	findTrackingIssue,
	openTrackingIssue,
	refresh,
	fileOrRefresh,
};
