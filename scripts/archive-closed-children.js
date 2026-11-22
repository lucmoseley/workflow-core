#!/usr/bin/env node

const { runCheck, brokenError } = require("./lib/check");
const { runLinkSync } = require("./lib/link-writer.js");
const {
	gh,
	ghJson,
	ghApiSlurp,
	ISSUE_LIST_LIMIT,
	parseErrLine,
	raiseGhFailure,
} = require("./lib/gh");
const {
	buildArchiveContainerTitle,
	subIssueTotal,
} = require("./lib/issue-tree");

/** @param {string | undefined} state */
const isClosed = (state) => (state ?? "").toLowerCase() === "closed";

runCheck({
	name: "archive-closed-children",
	usage: "node archive-closed-children.js <map> [--dry-run] [--json]",
	flags: ["--dry-run"],
	run: runBody,
});

/** @typedef {{number: number, id: number, state: string}} Container */

/**
 * @typedef {Container & {title: string, pull_request?: object,
 *   sub_issues_summary?: {total?: number}}} SubIssue
 */

/**
 * @param {string} title
 * @returns {Container | null}
 */
function findOrphanContainer(title) {
	/** @type {{number: number, title: string, id: number, state: string}[]} */
	let rows;
	try {
		rows = ghJson([
			"issue",
			"list",
			"--state",
			"all",
			"--search",
			`in:title "${title}"`,
			"--json",
			"number,title,id,state",
			"--limit",
			String(ISSUE_LIST_LIMIT),
		]);
	} catch (e) {
		return raiseGhFailure(
			e,
			"No child was archived; the archival container could not be searched for.",
		);
	}
	const matches = rows
		.filter((r) => r.title === title)
		.sort((a, b) => a.number - b.number);
	return matches[0] ?? null;
}

/** @param {import("./lib/check").Ctx} ctx */
function runBody(ctx) {
	const map = readMapArg(ctx);
	const dryRun = ctx.has("--dry-run");

	const kids = readSubIssues(map, "No child was archived.");

	const title = buildArchiveContainerTitle(map);
	const { container, alreadyLinked, orphan } = locateContainer(kids, title);

	if (kids.length === 0 && !container)
		return archiveResult(
			`#${map} has no sub-issues at all — nothing to archive.`,
			{
				map,
				moved: [],
				skipped7Layers: [],
				container: null,
			},
		);

	const { containerLike, closedDirect } = sortClosedChildren(kids, container);
	const containerLikeNote = noteContainerLike(containerLike);

	const containerNeedsRepair =
		!!container && (orphan || !isClosed(container.state));

	if (closedDirect.length === 0 && !containerNeedsRepair)
		return archiveResult(
			`#${map} has no closed direct children — nothing to archive.` +
				(container ? ` (container #${container.number} already stands.)` : "") +
				containerLikeNote,
			{
				map,
				moved: [],
				skipped7Layers: [],
				container: container?.number ?? null,
			},
		);

	if (dryRun)
		return dryRunResult({
			ctx,
			map,
			container,
			closedDirect,
			containerLikeNote,
		});

	const { containerNumber, created } = ensureContainer({
		ctx,
		map,
		title,
		container,
		orphan,
	});

	/** @param {string} tag @param {string} message @param {object} data */
	const failSay = (tag, message, data) => {
		ctx.fail(tag, message, data);
		ctx.say(`  ${tag}  ${message}`);
	};

	/** @type {ArchiveStep} */
	const archive = { ctx, map, containerNumber, failSay };

	const { moved, skipped7Layers } = moveChildren({ ...archive, closedDirect });

	const needsLink = created || orphan;
	const needsClose = created || !isClosed(container?.state);
	const { linked, linkFailed } = linkContainer({
		...archive,
		needsLink,
		alreadyLinked,
		movedCount: moved.length,
	});

	const closeFailed = closeContainer({ ...archive, linked, needsClose });

	const after = readSubIssues(
		map,
		`${moved.length} issue(s) moved into #${containerNumber}; the map's post-archive state could not be re-read.`,
	);
	verifyArchived({
		...archive,
		after,
		skipped7Layers,
		containerLike,
		expectLinked: linked && !linkFailed,
		closeFailed,
	});

	return archiveResult(
		`moved ${moved.length} closed child(ren) of #${map} into #${containerNumber}` +
			(skipped7Layers.length > 0
				? `; left ${skipped7Layers.length} at 7 layers deep as direct children`
				: "") +
			containerLikeNote +
			".",
		{ map, container: containerNumber, moved, skipped7Layers, created },
	);
}

/**
 * @param {string} okLine
 * @param {object} data
 */
function archiveResult(okLine, data) {
	return { okLine, noun: "issue(s) that could not be archived", data };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {number}
 */
function readMapArg(ctx) {
	const mapArg = ctx.args[0];
	if (!mapArg || !/^\d+$/.test(mapArg))
		ctx.usageError("give the map's issue number as the first argument.");
	return Number(mapArg);
}

/**
 * @param {number} map
 * @param {string} conclusion
 * @returns {SubIssue[]}
 */
function readSubIssues(map, conclusion) {
	try {
		return ghApiSlurp([`repos/{owner}/{repo}/issues/${map}/sub_issues`]);
	} catch (e) {
		return raiseGhFailure(e, conclusion);
	}
}

/**
 * @param {SubIssue[]} kids
 * @param {string} title
 * @returns {{container: Container | null, alreadyLinked: boolean, orphan: boolean}}
 */
function locateContainer(kids, title) {
	/** @type {Container | null} */
	let container = kids.find((k) => k.title === title) || null;
	const alreadyLinked = !!container;
	let orphan = false;
	if (!container) {
		container = findOrphanContainer(title);
		orphan = !!container;
	}
	return { container, alreadyLinked, orphan };
}

/**
 * @param {SubIssue[]} kids
 * @param {Container | null} container
 * @returns {{containerLike: SubIssue[], closedDirect: SubIssue[]}}
 */
function sortClosedChildren(kids, container) {
	const closedDirectAll = kids.filter(
		(k) => k.state === "closed" && !k.pull_request && k !== container,
	);
	const containerLike = closedDirectAll.filter((k) => subIssueTotal(k) > 0);
	const closedDirect = closedDirectAll.filter(
		(k) => !containerLike.includes(k),
	);
	return { containerLike, closedDirect };
}

/**
 * @param {SubIssue[]} containerLike
 * @returns {string}
 */
function noteContainerLike(containerLike) {
	return containerLike.length > 0
		? ` (left ${containerLike.length} closed direct child(ren) alone — already holding sub-issues of their own: ${containerLike.map((k) => `#${k.number}`).join(", ")})`
		: "";
}

/**
 * @param {{ctx: import("./lib/check").Ctx, map: number, container: Container | null, closedDirect: SubIssue[], containerLikeNote: string}} a
 */
function dryRunResult({
	ctx,
	map,
	container,
	closedDirect,
	containerLikeNote,
}) {
	const into = container ? `#${container.number}` : "a new archival container";
	ctx.say(
		closedDirect.length > 0
			? `would move ${closedDirect.length} closed child(ren) of #${map} into ${into}: ${closedDirect
					.map((k) => `#${k.number}`)
					.join(", ")}${containerLikeNote}`
			: `would link and/or close ${into} — no new closed child(ren) to move${containerLikeNote}`,
	);
	return archiveResult(
		`${closedDirect.length} issue(s) named above; --dry-run wrote nothing.`,
		{
			map,
			moved: [],
			skipped7Layers: [],
			container: container?.number ?? null,
			dryRun: true,
		},
	);
}

/**
 * @param {{ctx: import("./lib/check").Ctx, map: number, title: string, container: Container | null, orphan: boolean}} a
 * @returns {{containerNumber: number | null, containerId: number | null, created: boolean}}
 */
function ensureContainer({ ctx, map, title, container, orphan }) {
	let containerNumber = container?.number ?? null;
	let containerId = container ? container.id : null;
	const created = !containerNumber;

	if (created) {
		({ number: containerNumber, id: containerId } = createContainer(
			ctx,
			map,
			title,
		));
	} else if (orphan) {
		ctx.say(
			`found #${containerNumber} ${title} unlinked from #${map} — reusing it`,
		);
	}
	return { containerNumber, containerId, created };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {number} map
 * @param {string} title
 * @returns {{number: number, id: number}}
 */
function createContainer(ctx, map, title) {
	let url;
	try {
		url = gh([
			"issue",
			"create",
			"--title",
			title,
			"--body",
			`Archival container for the closed children of #${map} — holds no work of its own (docs/agents/issue-tracker.md §Placing a new issue). Created by scripts/archive-closed-children.js.`,
		]).trim();
	} catch (e) {
		return raiseGhFailure(
			e,
			"No child was archived; no container was created.",
		);
	}
	const m = /\/issues\/(\d+)\s*$/.exec(url);
	if (!m)
		throw brokenError(
			`gh issue create printed no issue URL (got '${url}') — no container was created.`,
		);
	const number = Number(m[1]);
	let id;
	try {
		id = ghJson([
			"api",
			`repos/{owner}/{repo}/issues/${number}`,
			"--jq",
			".id",
		]);
	} catch (e) {
		raiseGhFailure(
			e,
			`#${number} was created but its database id could not be read — link and close it by hand.`,
		);
	}
	ctx.say(`created #${number} ${title}`);
	return { number, id };
}

/**
 * @callback FailSay
 * @param {string} tag
 * @param {string} message
 * @param {object} data
 * @returns {void}
 */

/**
 * @typedef {{ctx: import("./lib/check").Ctx, map: number,
 *   containerNumber: number | null, failSay: FailSay}} ArchiveStep
 */

/**
 * @param {ArchiveStep & {closedDirect: SubIssue[]}} a
 * @returns {{moved: number[], skipped7Layers: number[]}}
 */
function moveChildren({ ctx, map, containerNumber, closedDirect, failSay }) {
	const moved = [];
	const skipped7Layers = [];
	for (const child of closedDirect) {
		const r = runLinkSync(
			"sub-issue",
			[String(containerNumber), String(child.number), "--replace-parent"],
			{ repo: "{owner}/{repo}" },
		);
		if (r.warning) ctx.say(`  ${r.warning}`);
		if (r.code === 0) {
			moved.push(child.number);
			ctx.say(`  moved #${child.number} into #${containerNumber}`);
		} else {
			if (r.reason === "layers") {
				skipped7Layers.push(child.number);
				ctx.say(
					`  left #${child.number} as a direct child of #${map} — its own subtree is already 7 layers deep`,
				);
				continue;
			}
			failSay(
				"ARCHIVE-MOVE-FAILED",
				`#${child.number} could not be moved into #${containerNumber}: ${r.err}`,
				{ child: child.number, container: containerNumber },
			);
		}
	}
	return { moved, skipped7Layers };
}

/**
 * @param {ArchiveStep & {needsLink: boolean, alreadyLinked: boolean,
 *   movedCount: number}} a
 * @returns {{linked: boolean, linkFailed: boolean}}
 */
function linkContainer({
	ctx,
	map,
	containerNumber,
	needsLink,
	alreadyLinked,
	movedCount,
	failSay,
}) {
	let linked = alreadyLinked;
	let linkFailed = false;
	if (!needsLink) return { linked, linkFailed };
	const r = runLinkSync("sub-issue", [String(map), String(containerNumber)], {
		repo: "{owner}/{repo}",
	});
	if (r.warning) ctx.say(`  ${r.warning}`);
	if (r.code === 0) linked = true;
	else {
		linkFailed = true;
		failSay(
			"ARCHIVE-LINK-FAILED",
			`#${containerNumber} could not be linked under #${map}: ${r.err} — it holds ${movedCount} moved issue(s) but is not yet part of the map; a re-run will find it by title and retry`,
			{ container: containerNumber, map },
		);
	}
	return { linked, linkFailed };
}

/**
 * @param {ArchiveStep & {linked: boolean, needsClose: boolean}} a
 * @returns {boolean}
 */
function closeContainer({
	ctx,
	map,
	containerNumber,
	linked,
	needsClose,
	failSay,
}) {
	let closeFailed = false;
	if (linked && needsClose) {
		try {
			gh([
				"issue",
				"close",
				String(containerNumber),
				"--comment",
				"Archival container — holds no work of its own.\n\n**Outstanding:** none.",
			]);
		} catch (e) {
			closeFailed = true;
			failSay(
				"ARCHIVE-CLOSE-FAILED",
				`#${containerNumber} could not be closed: ${parseErrLine(e)} — a re-run will retry`,
				{ container: containerNumber },
			);
		}
	} else if (needsClose && !linked) {
		ctx.say(
			`  left #${containerNumber} open — it is not yet linked under #${map}, so closing it now would hide it from the map with no way back`,
		);
	}
	return closeFailed;
}

/**
 * @param {ArchiveStep & {after: SubIssue[], skipped7Layers: number[],
 *   containerLike: SubIssue[], expectLinked: boolean, closeFailed: boolean}} a
 */
function verifyArchived({
	after,
	map,
	containerNumber,
	skipped7Layers,
	containerLike,
	expectLinked,
	closeFailed,
	failSay,
}) {
	const stillDirectClosed = after.filter(
		(k) =>
			k.state === "closed" && !k.pull_request && k.number !== containerNumber,
	);
	for (const k of stillDirectClosed) {
		if (skipped7Layers.includes(k.number)) continue;
		if (containerLike.some((c) => c.number === k.number)) continue;
		failSay(
			"ARCHIVE-VERIFY-FAILED",
			`#${k.number} is still a direct closed child of #${map} after archiving`,
			{ child: k.number, map },
		);
	}

	if (!expectLinked) return;
	const containerAfter = after.find((k) => k.number === containerNumber);
	if (!containerAfter) {
		failSay(
			"ARCHIVE-VERIFY-FAILED",
			`#${containerNumber} is not a direct child of #${map} after archiving`,
			{ container: containerNumber, map },
		);
	} else if (containerAfter.state !== "closed" && !closeFailed) {
		failSay(
			"ARCHIVE-VERIFY-FAILED",
			`#${containerNumber} is a direct child of #${map} but is not closed`,
			{ container: containerNumber, map },
		);
	}
}
