#!/usr/bin/env node
/*
 * archive-closed-children.js — the archival-container recipe of
 * docs/agents/issue-tracker.md §Placing a new issue, as a script (workflow-core#92; workflow-core#76
 * declined the alternative — a `map:<n>` label scheme — because no map on any
 * adopter's tracker has ever held more than 30 OPEN children, so only closed
 * history ever reaches GitHub's 100-sub-issue cap, and the core already had
 * this remedy by hand).
 *
 * Named `archive-`, not `check-`/`guard-`/`generate-`/`report-` (§N3): it
 * takes `runCheck`'s five-outcome contract without joining the `check-*`
 * family, per §G4.
 *
 * Moves a map's direct CLOSED children into an archival container, creating
 * the container the first time and reusing it on every later run. The
 * container is found among the map's own children by its TITLE, never a
 * label: a closed container needs no `wayfinder:<type>`
 * (docs/agents/issue-tracker.md:252), and a new label would drag in
 * triage-labels.md's vocabulary and check-issue-labels.js's contradictions for
 * a container that scans as open in neither (workflow-core#76's resolution comment).
 *
 * ORPHAN RECOVERY: if no container sits among the map's current children, a
 * repo-wide title search (`gh issue list --search`) still might find one —
 * created on an earlier run whose link or close step then failed. That
 * container is reused (linked and/or closed as needed) rather than left to
 * spawn a duplicate.
 *
 * CLOSED CHILDREN THAT ARE THEMSELVES CONTAINERS (a `sub_issues_summary.total`
 * above zero) are never moved. A hand-made archival container predating this
 * script — mantahostels#1459 is one, closed and titled its own way — would otherwise be
 * nested a layer deeper on the very first run. Reported, not fatal.
 *
 * ORDER IS LOAD-BEARING: the container exists (created or found) before
 * anything moves into it, children move before the container is linked, and
 * the container links under the map before it closes. Each move
 * reparents a child away from the map, so the map's own count is already
 * falling by the time the container joins it — linking first risks the exact
 * cap this script exists to relieve.
 *
 * IDEMPOTENT. A run that finds no closed direct child does nothing — in
 * particular it never creates an empty container. A run that finds the
 * container already linked and closed reuses it rather than making a second
 * one, moving in only whatever has closed since; one found linked but not yet
 * closed, or found only by the orphan search, is self-healed in place.
 *
 * THE 7-LAYER CAP IS HIT, NOT WALKED. Moving a closed child into the
 * container adds a layer to its own subtree; a child whose subtree already
 * reaches 7 layers gets a 422 whose prose names "7 layers" back, and this
 * script leaves that one as a direct child of the map, reported, not fatal —
 * the same prose match scripts/link-sub-issue.sh reads for the same cap, and
 * the same residual: a reword of GitHub's message demotes it to a generic
 * failure.
 *
 * NOT HANDLED: the container itself reaching the 100-child cap. Chaining a
 * second container was not built because nothing yet needs it (workflow-core#76's
 * measurement). A POST that 422s on the container's own cap fails loudly
 * (ARCHIVE-MOVE-FAILED).
 *
 * VERIFIED FROM A SEPARATE READ, never from the mutating calls' own exit
 * codes: the map's sub_issues are re-fetched once, after every move and the
 * link/close attempt, and any closed issue still sitting there — one skipped
 * for 7 layers excepted — is a FAIL, as is the container itself missing or
 * still open where this run expected it linked.
 *
 * Usage: node archive-closed-children.js <map> [--dry-run] [--json]
 */

const { runCheck, brokenError } = require("./lib/check");
const {
	gh,
	ghJson,
	ghApiSlurp,
	parseErrLine,
	raiseGhFailure,
} = require("./lib/gh");
const { ISSUE_LIST_LIMIT } = require("./lib/gh-limits.js");

/** @param {number} map */
const buildContainerTitle = (map) => `Archive: closed children of #${map}`;

// `gh api` and `gh issue list --json state` disagree on case ("closed" vs
// "CLOSED"), and the orphan search goes through the latter.
/** @param {string | undefined} state */
const isClosed = (state) => (state ?? "").toLowerCase() === "closed";

runCheck({
	name: "archive-closed-children",
	usage: "node archive-closed-children.js <map> [--dry-run] [--json]",
	flags: ["--dry-run"],
	run: runBody,
});

/**
 * An archival container as the title search finds it.
 * @typedef {{number: number, id: number, state: string}} Container
 */

/**
 * One of the map's sub-issues, as GitHub's REST API returns it — the fields
 * this script reads.
 * @typedef {Container & {title: string, pull_request?: object,
 *   sub_issues_summary?: {total?: number}}} SubIssue
 */

/**
 * A repo-wide title search for a container an earlier run created but never
 * linked. `gh issue list --search` is not exact, so results are filtered to
 * the literal title.
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
		raiseGhFailure(
			e,
			"No child was archived; the archival container could not be searched for.",
		);
	}
	const matches = rows
		.filter((r) => r.title === title)
		.sort((a, b) => a.number - b.number);
	// Exact-title duplicates should not exist; the lowest number wins rather
	// than failing, and a genuine duplicate goes unreported here.
	return matches[0] ?? null;
}

/** @param {import("./lib/check").Ctx} ctx */
function runBody(ctx) {
	const map = readMapArg(ctx);
	const dryRun = ctx.has("--dry-run");

	const kids = readSubIssues(map, "No child was archived.");

	const title = buildContainerTitle(map);
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

	// A container found unlinked (orphan) or linked but still open needs
	// repair even where nothing new has closed — the very state a prior
	// run's failed link or close leaves behind.
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

	const { containerNumber, containerId, created } = ensureContainer({
		ctx,
		map,
		title,
		container,
		orphan,
	});

	// Findings do not print themselves: every ctx.fail() below is paired
	// with the ctx.say() that makes it visible outside --json.
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
		containerId,
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
 * The run's result record, under the one noun every outcome counts its
 * findings in.
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
 * The map's sub-issues; a gh failure raises with `conclusion`.
 * @param {number} map
 * @param {string} conclusion
 * @returns {SubIssue[]}
 */
function readSubIssues(map, conclusion) {
	try {
		return ghApiSlurp([`repos/{owner}/{repo}/issues/${map}/sub_issues`]);
	} catch (e) {
		raiseGhFailure(e, conclusion);
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
	// A prior run's failed link can leave the map with NO direct children at
	// all (the one child it had moved into an unlinked container) — the
	// orphan search runs even here, before the empty-kids bailout below.
	if (!container) {
		container = findOrphanContainer(title);
		orphan = !!container;
	}
	return { container, alreadyLinked, orphan };
}

/**
 * The map's closed direct children, split into those that hold sub-issues
 * of their own (never moved) and the rest.
 * @param {SubIssue[]} kids
 * @param {Container | null} container
 * @returns {{containerLike: SubIssue[], closedDirect: SubIssue[]}}
 */
function sortClosedChildren(kids, container) {
	const closedDirectAll = kids.filter(
		(k) => k.state === "closed" && !k.pull_request && k !== container,
	);
	const containerLike = closedDirectAll.filter(
		(k) => (k.sub_issues_summary?.total ?? 0) > 0,
	);
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
		raiseGhFailure(e, "No child was archived; no container was created.");
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
 * Moves each closed child into the container; a child already 7 layers deep
 * is left where it is.
 * @param {ArchiveStep & {closedDirect: SubIssue[]}} a
 * @returns {{moved: number[], skipped7Layers: number[]}}
 */
function moveChildren({ ctx, map, containerNumber, closedDirect, failSay }) {
	const moved = [];
	const skipped7Layers = [];
	for (const child of closedDirect) {
		try {
			gh([
				"api",
				"--method",
				"POST",
				`repos/{owner}/{repo}/issues/${containerNumber}/sub_issues`,
				"-F",
				`sub_issue_id=${child.id}`,
				"-F",
				"replace_parent=true",
			]);
			moved.push(child.number);
			ctx.say(`  moved #${child.number} into #${containerNumber}`);
		} catch (e) {
			const line = parseErrLine(e);
			if (/7 layers/.test(line)) {
				skipped7Layers.push(child.number);
				ctx.say(
					`  left #${child.number} as a direct child of #${map} — its own subtree is already 7 layers deep`,
				);
				continue;
			}
			failSay(
				"ARCHIVE-MOVE-FAILED",
				`#${child.number} could not be moved into #${containerNumber}: ${line}`,
				{ child: child.number, container: containerNumber },
			);
		}
	}
	return { moved, skipped7Layers };
}

/**
 * Links the container under the map where it is new or orphaned.
 * @param {ArchiveStep & {containerId: number | null, needsLink: boolean,
 *   alreadyLinked: boolean, movedCount: number}} a
 * @returns {{linked: boolean, linkFailed: boolean}}
 */
function linkContainer({
	map,
	containerNumber,
	containerId,
	needsLink,
	alreadyLinked,
	movedCount,
	failSay,
}) {
	let linked = alreadyLinked;
	let linkFailed = false;
	if (!needsLink) return { linked, linkFailed };
	try {
		gh([
			"api",
			"--method",
			"POST",
			`repos/{owner}/{repo}/issues/${map}/sub_issues`,
			"-F",
			`sub_issue_id=${containerId}`,
		]);
		linked = true;
	} catch (e) {
		linkFailed = true;
		failSay(
			"ARCHIVE-LINK-FAILED",
			`#${containerNumber} could not be linked under #${map}: ${parseErrLine(e)} — it holds ${movedCount} moved issue(s) but is not yet part of the map; a re-run will find it by title and retry`,
			{ container: containerNumber, map },
		);
	}
	return { linked, linkFailed };
}

/**
 * @param {ArchiveStep & {linked: boolean, needsClose: boolean}} a
 * @returns {boolean} whether the close was tried and failed
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
