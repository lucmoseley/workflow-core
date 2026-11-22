#!/usr/bin/env node

const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group");
const {
	DATA_FILES,
	FIGURE_ID,
	ROUTE_ID,
	assertDataIdsKnown,
	citationMatcher,
	readConflictedPaths,
	roundedSectionBWords,
	entryPresentOnDisk,
	inScope,
	isDirty,
	loadRestatements,
	parseRetiredVocabularyText,
	newOverCapEntries,
	unrecordedAdmissions,
	HIGH_WATER_MARK_REMEDY,
	parseHighWaterMark,
	readHeadHighWaterMark,
	newIdsAtOrBelowMark,
	idsRemovedSinceHead,
	malformedExemptionMarkers,
	staleExemptionMarkers,
	grownExemptEntries,
	droppedExemptionMarkers,
	loadDocClasses,
	badClassEntries,
	badReaderEntries,
	pageSourceFaults,
	DOC_READERS,
	consumesFaults,
	pairScopeFaults,
	CLASSES_FILE,
	DOC_CLASSES,
	duplicateSidecarKeys,
	overCapRoles,
	renderSectionA,
	registerRowPaths,
	registerListPath,
	REGISTER_HEADER,
	ROLE_CAP_WORDS,
	overCapLedgerEntries,
	shedLedgerEntries,
	compactionVerdictFaults,
	VERDICT_MARKER,
	readParentRevs,
	readMapTextAt,
	LEDGER_ENTRY_CAP_BYTES,
	PROSE_CAP_WORDS,
	PAIRING_GRACE_MS,
	buildFileAgeReader,
	pairingHalfAgeMs,
	parseEntries,
	parseRoutes,
	registerPaths,
	figureHeadings,
	sectionAMatcher,
	BINARY_CLASS,
	coverageMatchers,
	readTrackedFiles,
	unresolvedSectionRefs,
	readUntrackedFiles,
	idNumber,
} = require("./lib/doc-map");

const {
	TRIGGER_VERDICT_MARKER,
	TRIGGER_VERDICT_MIN_WORDS,
	stagedPoolDelta,
	triggerVerdictFaults,
} = require("./lib/always-loaded-pool");
const { isCollectedTestOrConftest } = require("./lib/test-kind");
const {
	coreRoot,
	inCheckout,
	resolveScriptPaths,
	scriptPath,
} = require("./lib/script-path");
const { caught } = require("./lib/caught.js");
const { inCoreRepo } = require("./lib/core-repo.js");
const { withGitReadMemo } = require("./lib/git-read-memo.js");

/** @param {string} name */
const generatorCommand = (name) =>
	inCheckout()
		? `npm run gen:${name}`
		: `node ${scriptPath(`generate-${name}.js`)}`;

/**
 * @typedef {import("./lib/check").Ctx} Ctx
 * @typedef {{ route: string, path: string }} RoutePath
 */
/**
 * @typedef {import("./lib/doc-map").ConsumesFault} ConsumesFault
 * @typedef {{ entry: string, path: string }} RestatedPath
 */
/**
 * @typedef {{
 *   ctx: Ctx,
 *   underRoot: (p: string) => string,
 *   mapPath: string,
 *   dataDir: string,
 *   text: string,
 *   entries: string[],
 *   classesFile: string,
 *   classesText: string,
 *   classesJson: Record<string, unknown>,
 *   sidecarKeys: string[],
 *   allTracked: string[],
 *   resolvable: string[],
 *   tracked: string[],
 *   presentUntracked: (p: string) => boolean,
 * }} Run
 * @typedef {import("./lib/doc-map").Entry} Figure
 * @typedef {Record<string, import("./lib/doc-map").RestatementEntry>} Restatements
 * @typedef {ReturnType<typeof figureHeadings>} Headings
 * @typedef {ReturnType<typeof loadDocClasses> | null} Classes
 */

const FIGURE = /(?<![\w#-])\d+(?:\.\d+)?(?![\w-])/g;

/**
 * @template T
 * @param {Ctx} ctx
 * @param {{
 *   tag: string,
 *   msg: string,
 *   key: string,
 *   items: T[],
 *   line?: (item: T) => string,
 *   id?: (item: T) => string,
 *   advice: string,
 *   severity?: "fail" | "warn",
 * }} fault
 */
function reportFault(
	ctx,
	{
		tag,
		msg,
		key,
		items,
		line = String,
		id = (item) => line(item).replace(FIGURE, "#"),
		advice,
		severity = "fail",
	},
) {
	if (items.length === 0) return;
	const ids = [...new Set(items.map(id))].sort();
	ctx[severity](tag, msg, { [key]: items }, [tag, ...ids].join("\t"));
	ctx.say(msg);
	for (const item of items) ctx.say(`  ${line(item)}`);
	ctx.say(`\n${resolveScriptPaths(advice)}`);
}

/** @param {number} ms */
const humanDuration = (ms) => {
	const totalMin = Math.max(0, Math.round(ms / 60_000));
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/**
 * @param {string[]} items
 * @param {(item: string) => number | null} dateItem
 */
const splitByGrace = (items, dateItem) => {
	/** @type {{ item: string, ageMs: number }[]} */
	const inGrace = [];
	/** @type {string[]} */
	const outOfGrace = [];
	for (const item of items) {
		const ageMs = dateItem(item);
		if (ageMs !== null && ageMs < PAIRING_GRACE_MS)
			inGrace.push({ item, ageMs });
		else outOfGrace.push(item);
	}
	return { inGrace, outOfGrace };
};

/** @param {Ctx} ctx */
function resolveLocations(ctx) {
	const rootFlag = ctx.value("--root");
	const root = rootFlag ? path.resolve(rootFlag) : null;
	const underRoot = (/** @type {string} */ p) =>
		root && !path.isAbsolute(p) ? path.join(root, p) : p;

	const mapArg = ctx.args[0] || "docs/doc-map.md";
	const mapPath = underRoot(mapArg);
	const dataDir = underRoot(ctx.value("--data-dir", path.dirname(mapArg)));
	return { root, underRoot, mapPath, dataDir };
}

/** @param {Ctx} ctx */
function skipOnConflict(ctx) {
	const conflicted = readConflictedPaths();
	if (conflicted.length > 0)
		ctx.skip(
			`the index holds ${conflicted.length} conflicted path(s), so there is ` +
				"no committed tree to count:\n" +
				conflicted.map((p) => `  ${p}`).join("\n") +
				"\nResolve them and commit, then re-run this check and paste the " +
				"header line it prints.",
		);
}

/**
 * @param {Ctx} ctx
 * @param {string} mapPath
 */
function readMap(ctx, mapPath) {
	let text;
	try {
		text = fs.readFileSync(mapPath, "utf8");
	} catch (e) {
		ctx.broken(`cannot read doc map at ${mapPath} — ${caught(e).message}`);
	}

	const stamp = text.match(/^v\d+\.\d+ · .+$/m);
	if (!stamp) ctx.broken(`no version stamp ("vN.N · <date>") in ${mapPath}`);

	const entries = registerPaths(text);

	if (entries.length === 0)
		ctx.broken(`no register entries parsed from ${mapPath} Section A`);
	return { text, stamp, entries };
}

/**
 * @param {Ctx} ctx
 * @param {{ dataDir: string, underRoot: (p: string) => string }} where
 */
function readClassSidecar(ctx, { dataDir, underRoot }) {
	const inDataDir = path.join(dataDir, CLASSES_FILE);
	const candidates = [
		...new Set([inDataDir, underRoot(`docs/${CLASSES_FILE}`)]),
	];
	const classesFile = candidates.find((f) => fs.existsSync(f)) || inDataDir;
	let classesText;
	try {
		classesText = fs.readFileSync(classesFile, "utf8");
	} catch (e) {
		ctx.broken(
			`cannot read the class sidecar at ${classesFile} — ${caught(e).message}. ` +
				"It is where every registered path lives, so no coverage " +
				"conclusion was drawn.",
		);
	}
	if (classesFile !== candidates[0])
		ctx.say(
			`\nno class sidecar in ${dataDir}, so coverage was read from the ` +
				`tracked ${classesFile} — the working tree's bytes, not this ` +
				"commit's.",
		);
	/** @type {Record<string, unknown>} */
	let classesJson = {};
	try {
		classesJson = JSON.parse(/** @type {string} */ (classesText));
	} catch (e) {
		ctx.broken(`${classesFile} is not JSON — ${caught(e).message}`);
	}
	if (
		!classesJson ||
		typeof classesJson !== "object" ||
		Array.isArray(classesJson)
	)
		ctx.broken(`${classesFile} does not hold an object keyed by path`);
	const sidecarKeys = Object.keys(classesJson);
	if (sidecarKeys.length === 0) ctx.broken(`${classesFile} holds no entries`);
	return {
		classesFile,
		classesText: /** @type {string} */ (classesText),
		classesJson,
		sidecarKeys,
	};
}

/**
 * @param {Ctx} ctx
 * @param {string | null} root
 */
function walkTree(ctx, root) {
	let allTracked;
	try {
		allTracked = readTrackedFiles(root);
	} catch (e) {
		const { message } = caught(e);
		ctx.broken(
			root
				? `could not walk the materialised tree at ${root} — ${message}. No coverage conclusion drawn.`
				: `git ls-files failed — ${message}. No coverage conclusion drawn.`,
		);
	}

	let resolvable = allTracked;
	if (!inCoreRepo())
		try {
			resolvable = [...allTracked, ...readTrackedFiles(coreRoot())];
		} catch (e) {
			ctx.broken(`could not walk the plugin root — ${caught(e).message}`);
		}
	return { allTracked, resolvable };
}

function untrackedMatcher() {
	/** @type {string[] | null} */
	let untrackedOnDisk = null;
	const presentUntracked = (/** @type {string} */ p) => {
		if (untrackedOnDisk === null) untrackedOnDisk = readUntrackedFiles();
		return untrackedOnDisk.some(citationMatcher(p));
	};
	return presentUntracked;
}

/** @param {Run} r */
function checkCoverage(r) {
	const { ctx, tracked, entries, sidecarKeys, mapPath } = r;
	const covered = coverageMatchers(sidecarKeys);
	const matchers = entries.map((e) => ({
		entry: e,
		test: sectionAMatcher(e),
	}));

	const uncovered = tracked.filter((f) => !covered.some((test) => test(f)));
	const missing = matchers.filter((m) => !tracked.some((f) => m.test(f)));
	const dead = missing
		.filter((m) => !entryPresentOnDisk(m.entry))
		.map((m) => m.entry);
	const untracked = missing
		.filter((m) => entryPresentOnDisk(m.entry))
		.map((m) => m.entry);

	const uncoveredSplit = splitByGrace(uncovered, buildFileAgeReader());
	const uncoveredAge = new Map(
		uncoveredSplit.inGrace.map((d) => [d.item, d.ageMs]),
	);

	reportFault(ctx, {
		tag: "UNCOVERED",
		msg: `${uncoveredSplit.outOfGrace.length} tracked file(s) in scope have no doc-map register entry:`,
		key: "files",
		items: uncoveredSplit.outOfGrace,
		advice:
			"Register each in the class sidecar — one command, one judgement, and " +
			"§A's row renders from it:\n" +
			"  node scripts/register-doc.js <path> --class <token> --section <name>\n" +
			`<token> is one of ${DOC_CLASSES.join(", ")}; <section> must spell a ` +
			"§A subsection that already exists, or add --new-section to mint one. " +
			"An unregistered document is one the update routine will never " +
			"consider.",
	});

	reportFault(ctx, {
		tag: "UNCOVERED-GRACE",
		msg:
			`${uncoveredSplit.inGrace.length} tracked file(s) in scope have no doc-map register ` +
			`entry yet, within the ${humanDuration(PAIRING_GRACE_MS)} grace window:`,
		key: "files",
		items: uncoveredSplit.inGrace.map((d) => d.item),
		id: String,
		line: (item) => {
			const ageMs = /** @type {number} */ (uncoveredAge.get(item));
			return (
				`${item} (introduced ${humanDuration(ageMs)} ago, ` +
				`${humanDuration(PAIRING_GRACE_MS - ageMs)} grace left — claim ` +
				`${CLASSES_FILE}#A:${item} and register it)`
			);
		},
		severity: "warn",
		advice:
			"Register it before the grace window expires, or the next sweep FAILs " +
			"it:\n" +
			"  node scripts/register-doc.js <path> --class <token> --section <name>",
	});

	const deadSplit = splitByGrace(dead, (/** @type {string} */ e) =>
		pairingHalfAgeMs(e, mapPath),
	);
	const deadAge = new Map(deadSplit.inGrace.map((d) => [d.item, d.ageMs]));

	reportFault(ctx, {
		tag: "DEAD-ENTRY",
		msg: `${deadSplit.outOfGrace.length} doc-map register entr(ies) match no tracked file:`,
		key: "entries",
		items: deadSplit.outOfGrace,
		advice: "The file was renamed or removed — update the register.",
	});

	reportFault(ctx, {
		tag: "DEAD-ENTRY-GRACE",
		msg:
			`${deadSplit.inGrace.length} doc-map register entr(ies) match no tracked file yet, ` +
			`within the ${humanDuration(PAIRING_GRACE_MS)} grace window:`,
		key: "entries",
		items: deadSplit.inGrace.map((d) => d.item),
		id: String,
		line: (item) => {
			const ageMs = /** @type {number} */ (deadAge.get(item));
			return (
				`${item} (row written ${humanDuration(ageMs)} ago, ` +
				`${humanDuration(PAIRING_GRACE_MS - ageMs)} grace left — commit the file ` +
				"the row names)"
			);
		},
		severity: "warn",
		advice:
			"Commit the file before the grace window expires, or the next sweep FAILs it.",
	});
	return { uncoveredSplit, deadSplit, untracked };
}

/** @param {Run} r */
function checkSidecarVocabulary(r) {
	const { ctx, classesJson } = r;
	const badClasses = badClassEntries(classesJson);
	reportFault(ctx, {
		tag: "UNKNOWN-CLASS",
		msg: `${badClasses.length} sidecar entr(ies) carry a class outside the documented vocabulary:`,
		key: "entries",
		items: badClasses,
		line: (e) => `${e.path} — \`${e.cls}\``,
		advice:
			`The vocabulary is exactly ${DOC_CLASSES.join(", ")} ` +
			"(.claude/workflow-core.doc-map.md §Authority classes), and §A's rendered Update route " +
			"is derived from it, so a seventh value would render a row nothing " +
			"knows how to edit. A dual-class judgement goes in `classQualifier`, " +
			"which is free prose beside a real token — never in `class` itself. " +
			"Fix the token in the sidecar and regenerate:\n" +
			`  ${generatorCommand("doc-map-section-a")}`,
	});

	const badReaders = badReaderEntries(classesJson);
	reportFault(ctx, {
		tag: "UNKNOWN-READER",
		msg: `${badReaders.unknown.length} sidecar entr(ies) carry a reader outside the vocabulary:`,
		key: "entries",
		items: badReaders.unknown,
		line: (e) => `${e.path} — ${e.reader}`,
		advice: `The vocabulary is exactly ${DOC_READERS.join(", ")} (docs/doc-pages.md §Authority). Fix the token in the sidecar.`,
	});
	reportFault(ctx, {
		tag: "MISSING-READER",
		msg: `${badReaders.missing.length} .md or .html sidecar key(s) carry no reader:`,
		key: "paths",
		items: badReaders.missing,
		advice:
			"Every prose document states who reads it — a judgement per document, " +
			`one of ${DOC_READERS.join(", ")}. A new registration writes it:\n` +
			"  node scripts/register-doc.js <path> --class <token> --section <name> --reader <token>\n" +
			"and an already-registered key takes it as a direct sidecar edit. A " +
			"generated page takes its source's value.",
	});
	reportFault(ctx, {
		tag: "READER-ON-NON-PROSE",
		msg: `${badReaders.misplaced.length} sidecar key(s) carry a reader but are not a .md or .html document:`,
		key: "paths",
		items: badReaders.misplaced,
		advice:
			"`reader` applies to a prose document only; a wildcard key registers " +
			"many files and states no reader for any of them. Delete the field.",
	});

	const badPages = pageSourceFaults(classesJson);
	reportFault(ctx, {
		tag: "PAGE-SOURCE",
		msg: `${badPages.length} documentation page key(s) name a source that may not have a page:`,
		key: "pages",
		items: badPages,
		line: (p) => `${p.page} — source ${p.source} ${p.why}`,
		advice:
			"A page exists only for a registered source read by `human` or " +
			"`both` (docs/doc-pages.md §Which documents). Delete the page and its key, or correct the " +
			"source's key where its judgement is the thing that is wrong.",
	});
	return { badClasses, badReaders };
}

/**
 * @param {Ctx} ctx
 * @param {string[]} untracked
 */
function reportUntrackedEntries(ctx, untracked) {
	reportFault(ctx, {
		tag: "UNTRACKED-ENTRY",
		msg:
			`${untracked.length} doc-map register entr(ies) name a file present ` +
			"on disk but not yet tracked by git:",
		key: "entries",
		items: untracked,
		severity: "warn",
		advice:
			"Likely mid-ticket: the register edit and the file's own commit are " +
			"separate steps. Commit the file, or drop the entry if it was never " +
			"meant to land.",
	});
}

/**
 * @param {Run} r
 * @param {ReturnType<typeof parseRoutes>[number]} route
 * @returns {{dead: RoutePath[], untracked: RoutePath[], reached: string[]}}
 */
function classifyRoutePaths(r, route) {
	const { resolvable, presentUntracked } = r;
	/** @type {{dead: RoutePath[], untracked: RoutePath[], reached: string[]}} */
	const sorted = { dead: [], untracked: [], reached: [] };
	for (const { path: p, destination } of route.paths) {
		const hits = resolvable.filter(citationMatcher(p));
		if (hits.length === 0)
			(presentUntracked(p) ? sorted.untracked : sorted.dead).push({
				route: route.id,
				path: p,
			});
		if (destination) sorted.reached.push(...hits);
	}
	return sorted;
}

/** @param {Run} r */
function checkRoutes(r) {
	const { ctx, text, mapPath } = r;
	const routes = parseRoutes(text);

	/** @type {RoutePath[]} */
	const deadRoutes = [];
	/** @type {RoutePath[]} */
	const untrackedRoutes = [];
	/** @type {Set<string>} */
	const reached = new Set();
	for (const route of routes) {
		const sorted = classifyRoutePaths(r, route);
		deadRoutes.push(...sorted.dead);
		untrackedRoutes.push(...sorted.untracked);
		for (const f of sorted.reached) reached.add(f);
	}

	reportFault(ctx, {
		tag: "DEAD-ROUTE",
		msg: `${deadRoutes.length} Section C route path(s) in ${mapPath} point at no tracked file:`,
		key: "routes",
		items: deadRoutes,
		line: (d) => `${d.route} → ${d.path}`,
		advice: "The file was renamed or removed — send the route somewhere real.",
	});

	reportFault(ctx, {
		tag: "UNTRACKED-ROUTE",
		msg:
			`${untrackedRoutes.length} Section C route path(s) in ${mapPath} ` +
			"name a file present on disk but not yet tracked by git:",
		key: "routes",
		items: untrackedRoutes,
		line: (d) => `${d.route} → ${d.path}`,
		severity: "warn",
		advice: "Commit the file, or drop the route until it lands.",
	});
	return { routes, reached, deadRoutes, untrackedRoutes };
}

/** @param {string} text */
function collectRouteIds(text) {
	/** @type {string[]} */
	const routeIds = [];
	let fencedRoute = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fencedRoute = !fencedRoute;
			continue;
		}
		if (fencedRoute) continue;
		const heading = line.match(ROUTE_ID);
		if (heading) routeIds.push(requiredGroup(heading, 1, ROUTE_ID));
	}
	return routeIds;
}

/** @param {Run} r */
function checkRouteIds(r) {
	const { ctx, text, mapPath } = r;
	const routeIds = collectRouteIds(text);

	const heldRouteIds = new Set(routeIds);
	const highestRoute = Math.max(0, ...routeIds.map((id) => idNumber(id)));
	/** @type {{ id: string, why: string }[]} */
	const routeIdFaults = [];
	for (let n = 1; n <= highestRoute; n++)
		if (!heldRouteIds.has(`C${n}`))
			routeIdFaults.push({ id: `C${n}`, why: "no route carries this id" });
	for (const id of heldRouteIds)
		if (routeIds.filter((other) => other === id).length > 1)
			routeIdFaults.push({ id, why: "heads more than one route" });
	for (const id of heldRouteIds)
		if (/^C0/.test(id))
			routeIdFaults.push({
				id,
				why: "ids run from C1 and carry no leading zero",
			});

	reportFault(ctx, {
		tag: "ROUTE-ID-GAP",
		msg:
			`${mapPath}'s Section C route ids must be the dense run ` +
			`C1-C${highestRoute}, its highest id. Out of place:`,
		key: "ids",
		items: routeIdFaults,
		line: (f) => `${f.id} — ${f.why}`,
		advice:
			"Route ids are permanent, and documents outside §C cite them by " +
			"name, so closing a gap by renumbering breaks those citers (mantahostels#1229). " +
			"A route whose document moved is repointed, never deleted — a dead " +
			"path in a route FAILs above (mantahostels#212). A duplicate or a malformed id " +
			"takes the next free number.",
	});
	return routeIdFaults;
}

/**
 * @param {Ctx} ctx
 * @param {string} dataFile
 * @param {Figure[]} figures
 */
function readRestatements(ctx, dataFile, figures) {
	let restatementData = null;
	try {
		restatementData = loadRestatements(dataFile, {
			allowEmpty: figures.length === 0,
		});
	} catch (e) {
		const { code, message } = caught(e);
		ctx.broken(
			code === "ENOENT"
				? `restatement data file ${dataFile} is missing — §B's restatement ` +
						"paths live there, so there is nothing to check against."
				: `restatement data file unreadable — ${message}`,
		);
	}
	return restatementData;
}

/** @param {Run} r */
function checkRestatements(r) {
	const { ctx, text, mapPath, dataDir, resolvable } = r;
	const dataFile = path.join(dataDir, DATA_FILES.restatements);
	const figures = parseEntries(text, FIGURE_ID);
	const restatementData = readRestatements(ctx, dataFile, figures);

	/** @type {RestatedPath[]} */
	const deadRestatements = [];
	assertDataIdsKnown(ctx, restatementData, figures, dataFile);
	let restatementPaths = 0;
	let figuresRestated = 0;
	for (const [id, entry] of Object.entries(restatementData)) {
		restatementPaths += entry.paths.length;
		figuresRestated++;
		for (const item of entry.paths)
			if (!resolvable.some(citationMatcher(item.path)))
				deadRestatements.push({ entry: id, path: item.path });
	}

	reportFault(ctx, {
		tag: "DEAD-RESTATEMENT",
		msg: `${deadRestatements.length} Section B restated-in path(s) in ${mapPath} point at no tracked file:`,
		key: "restatements",
		items: deadRestatements,
		line: (d) => `${d.entry} → ${d.path}`,
		advice:
			"The file was renamed or removed — a restatement dropped from the " +
			"list is a stale copy the propagation pass will never reach.",
	});
	return {
		restatementData,
		figures,
		restatementPaths,
		figuresRestated,
		deadRestatements,
	};
}

/** @param {import("./lib/doc-map").RestatementEntry} entry */
function locatorFields(entry) {
	/** @type {[string, string | undefined][]} */
	const fields = [["note", entry.note]];
	for (const item of entry.paths)
		for (const field of /** @type {const} */ (["locator", "gloss"]))
			fields.push([`${field} on \`${item.path}\``, item[field]]);
	return fields;
}

/**
 * @param {Run} r
 * @param {{ restatementData: Restatements, figures: Figure[] }} sources
 */
function checkLineLocators(r, { restatementData, figures }) {
	const { ctx } = r;
	const citedExt =
		"md|py|sh|ts|tsx|js|mjs|cjs|json|jsonl|html|yml|yaml|css|csv|txt";
	const lineToken = new RegExp(
		"(?<![A-Za-z\\d])L\\d+(?![\\w-])" +
			`|(?<![\\w/.-])(?:[\\w.-]*/)*[\\w.-]*\\.(?:${citedExt}):\\d+(?:-\\d+)?(?![\\w-])` +
			"|(?<![\\w/.-])[\\w.-]+(?:/[\\w.-]+)+:\\d+(?:-\\d+)?(?![\\w-])",
	);
	/** @type {{ entry: string, where: string, token: string }[]} */
	const lineLocators = [];
	for (const [id, entry] of Object.entries(restatementData)) {
		for (const [where, value] of locatorFields(entry)) {
			const m = typeof value === "string" ? lineToken.exec(value) : null;
			if (m) lineLocators.push({ entry: id, where, token: m[0] });
		}
	}
	for (const fig of figures) {
		const m = lineToken.exec(fig.lines.join("\n"));
		if (m)
			lineLocators.push({ entry: fig.id, where: "entry prose", token: m[0] });
	}
	reportFault(ctx, {
		tag: "LINE-LOCATOR",
		msg: `${lineLocators.length} line-number locator(s) in §B or ${DATA_FILES.restatements}:`,
		key: "lineLocators",
		items: lineLocators,
		line: (d) => `${d.entry} — ${d.token} in ${d.where}`,
		advice:
			"A line number drifts on every edit above it and nothing re-derives " +
			"it (mantahostels#3151). Pin the sentence with its `§` section, a verbatim " +
			'"quoted phrase" the file holds, or both — §B\'s preamble has the form.',
	});
	return lineLocators;
}

/**
 * @param {Run} r
 * @param {{ id: string, item: import("./lib/doc-map").RestatementPath }} at
 * @param {Map<string, string>} anchorFileText
 * @returns {{ entry: string, path: string, phrase: string }[]}
 */
function collectDeadAnchors(r, { id, item }, anchorFileText) {
	const { allTracked, underRoot } = r;
	if (typeof item.locator !== "string" || !item.locator.includes('"'))
		return [];
	const [file, other] = allTracked.filter(citationMatcher(item.path));
	if (file === undefined || other !== undefined) return [];
	if (!anchorFileText.has(file))
		anchorFileText.set(file, fs.readFileSync(underRoot(file), "utf8"));
	const body = /** @type {string} */ (anchorFileText.get(file));
	const quoted = /"([^"]+)"/g;
	/** @type {{ entry: string, path: string, phrase: string }[]} */
	const dead = [];
	for (const m of item.locator.matchAll(quoted)) {
		const phrase = requiredGroup(m, 1, quoted);
		if (!body.includes(phrase))
			dead.push({ entry: id, path: item.path, phrase });
	}
	return dead;
}

/**
 * @param {Run} r
 * @param {Restatements} restatementData
 */
function checkDeadAnchors(r, restatementData) {
	const { ctx } = r;
	/** @type {{ entry: string, path: string, phrase: string }[]} */
	const deadAnchors = [];
	/** @type {Map<string, string>} */
	const anchorFileText = new Map();
	for (const [id, entry] of Object.entries(restatementData))
		for (const item of entry.paths)
			deadAnchors.push(...collectDeadAnchors(r, { id, item }, anchorFileText));
	reportFault(ctx, {
		tag: "DEAD-ANCHOR",
		msg: `${deadAnchors.length} quoted locator phrase(s) in ${DATA_FILES.restatements} that the file no longer holds:`,
		key: "deadAnchors",
		items: deadAnchors,
		line: (d) => `${d.entry} → ${d.path}: "${d.phrase}"`,
		advice:
			"Re-quote the phrase from the sentence as it now reads. Where the " +
			"sentence is gone, the copy has moved or been cut — that is the " +
			"propagation pass's visit, not a locator edit.",
	});
	return deadAnchors;
}

/** @param {Run} r */
function checkSectionRefs(r) {
	const { ctx, text, classesJson, allTracked, underRoot } = r;
	const refExempt = Object.entries(classesJson)
		.filter(
			([, v]) => /** @type {{ class?: unknown }} */ (v)?.class === BINARY_CLASS,
		)
		.map(([k]) => sectionAMatcher(k));
	/** @type {{ file: string, text: string }[]} */
	const refFiles = [];
	for (const file of allTracked) {
		if (isCollectedTestOrConftest(file) || refExempt.some((t) => t(file)))
			continue;
		let body;
		try {
			body = fs.readFileSync(underRoot(file), "utf8");
		} catch {
			continue;
		}
		if (body.includes("doc-map.md")) refFiles.push({ file, text: body });
	}
	const deadRefs = unresolvedSectionRefs(text, refFiles);
	reportFault(ctx, {
		tag: "DEAD-SECTION-REF",
		msg: `${deadRefs.length} reference(s) to a docs/doc-map.md section that does not exist:`,
		key: "sectionRefs",
		items: deadRefs,
		line: (d) => `${d.file}: ${d.ref}`,
		advice:
			"Point the reference at a heading the map carries — §A, §B and §C " +
			"name their Sections, `§<n>` the one `### <n>.` subsection carrying " +
			"that number, `§X §<n>` the `### <n>.` under §X — or give the map " +
			"the section it names. A `§X preamble` needs prose under §X's " +
			"heading before its first sub-heading.",
	});
	return deadRefs;
}

/**
 * @param {Run} r
 * @param {{
 *   restatementPaths: number,
 *   figuresRestated: number,
 *   figures: Figure[],
 *   reached: Set<string>,
 * }} census
 */
function reportCensus(
	r,
	{ restatementPaths, figuresRestated, figures, reached },
) {
	const { ctx, tracked } = r;
	ctx.say(
		`\n${restatementPaths} restatement path(s) across ` +
			`${figuresRestated} of ${figures.length} §B entries ` +
			"(existence checked, completeness not — not a failure).",
	);

	const unreached = tracked.filter((f) => !reached.has(f));
	if (unreached.length > 0) {
		ctx.say(
			`\nReached by no Section C route (${unreached.length} of ${tracked.length} in-scope files, not a failure):`,
		);
		for (const f of unreached) ctx.say(`  ${f}`);
	}
	return unreached;
}

/** @param {Run} r */
function checkDuplicateIds(r) {
	const { ctx, text } = r;
	/** @type {Map<string, string>} */
	const seen = new Map();
	/** @type {string[]} */
	const duplicates = [];
	const headings = figureHeadings(text.split("\n"));
	for (const { id, line } of headings) {
		if (seen.has(id)) duplicates.push(`${id} — first as: ${seen.get(id)}`);
		else seen.set(id, line);
	}

	reportFault(ctx, {
		tag: "DUPLICATE-ENTRY-ID",
		msg: `${duplicates.length} Section B entry id(s) appear more than once:`,
		key: "ids",
		items: duplicates,
		advice:
			"Ids are permanent and are never reused or renumbered (mantahostels#892), " +
			"and doc-map-restatements.json, -retired-vocabulary.json and " +
			"-superseded.json all key off them — so a duplicate hands one entry's " +
			"rows to another. Give the newer entry the next free id:\n" +
			`  ${buildArbiterCommand`alloc-entry docs/doc-map.md`}\n` +
			"which allocates it atomically and claims the append slot with it.",
	});
	return { headings, seen, duplicates };
}

/** @param {Run} r */
function checkDuplicateKeys(r) {
	const { ctx, classesText, classesFile } = r;
	const rowDuplicates = duplicateSidecarKeys(classesText);
	reportFault(ctx, {
		tag: "DUPLICATE-REGISTER-KEY",
		msg: `${rowDuplicates.length} key(s) appear twice in ${classesFile}:`,
		key: "paths",
		items: rowDuplicates,
		advice:
			"A key is its arbiter region id (`A:<path>`, lib/doc-map-regions.js), " +
			"so a repeat hands two entries one lock and puts their two writers " +
			"back in contention — and JSON.parse keeps the last of them, so the " +
			"class the earlier one records is silently gone. One key per " +
			"document: delete the duplicate, keeping the entry that records the " +
			"class you meant.",
	});
	return rowDuplicates;
}

/** @param {Run} r */
function checkCanonicalSidecar(r) {
	const { ctx, classesText, classesJson, classesFile } = r;
	const canonicalClasses = `${JSON.stringify(
		Object.fromEntries(
			Object.keys(classesJson)
				.sort()
				.map((k) => [k, classesJson[k]]),
		),
		null,
		"\t",
	)}\n`;
	const classesDrift = [];
	if (classesText !== canonicalClasses) {
		const have = classesText.replace(/\n$/, "").split("\n");
		const want = canonicalClasses.replace(/\n$/, "").split("\n");
		let differing = 0;
		for (let i = 0; i < Math.max(have.length, want.length); i++)
			if (have[i] !== want[i]) differing++;
		classesDrift.push(
			`${differing} of ${want.length} line(s) differ from the canonical form`,
		);
	}
	reportFault(ctx, {
		tag: "SIDECAR-NOT-CANONICAL",
		msg: `${classesFile} is not register-doc.js's canonical serialisation:`,
		key: "lines",
		items: classesDrift,
		advice:
			"A \\u00a7 or \\u2014 in the diff is the signature of a " +
			"writer defaulting to ASCII-safe JSON (Python's json.dump, " +
			"ensure_ascii=True by default) rather than register-doc.js's " +
			"unescaped JSON.stringify. Re-run the edit through:\n" +
			"  node scripts/register-doc.js <path> --class <token> --section <name>\n" +
			"or hand-fix the file so it round-trips: parse it, then write back " +
			"`JSON.stringify(Object.fromEntries(Object.keys(parsed).sort()." +
			'map(k => [k, parsed[k]])), null, "\\t") + "\\n"`.',
	});
	return classesDrift;
}

/**
 * @param {Ctx} ctx
 * @param {Headings} headings
 */
function checkStrays(ctx, headings) {
	/** @type {string[]} */
	const strays = headings
		.filter((h) => h.stray)
		.map((h) => `${h.id} — line ${h.index + 1}, outside Section B`);

	reportFault(ctx, {
		tag: "STRAY-ENTRY",
		msg: `${strays.length} Section B entry heading(s) sit outside Section B:`,
		key: "ids",
		items: strays,
		advice:
			"Section B is read as the line range from `## Section B` to the next " +
			"`## ` heading, so an entry appended below it is missing from every " +
			"figure taken over that range — §B's word count here, and the " +
			"80,000-word budget report — which then read low rather than wrong. " +
			"The entry parsers are whole-file, so the drain queue and the " +
			"duplicate-id check above still see it. Move the entry into the " +
			"range, in id order, block intact: it is a relocation, never a " +
			"rewrite, and the mover is\n" +
			"  node scripts/move-stray-doc-map-entries.js docs/doc-map.md",
	});
	return strays;
}

/**
 * @param {Ctx} ctx
 * @param {Figure[]} figures
 */
function checkSettledAt(ctx, figures) {
	/** @type {string[]} */
	const settledMissing = figures
		.filter(
			(f) =>
				!/^[^\S\n\r\u2028\u2029]*-\s*\*\*Settled at/m.test(f.lines.join("\n")),
		)
		.map((f) => f.id);

	reportFault(ctx, {
		tag: "SETTLED-AT-MISSING",
		msg: `${settledMissing.length} Section B entr(ies) carry no \`Settled at\` bullet:`,
		key: "ids",
		items: settledMissing,
		advice:
			"Every entry names the ticket that decided its figure — that ticket is " +
			"where each derivation cut from the entry was sent, so an entry " +
			"without one strands its own working. Two spellings, and only two:\n" +
			"  - **Settled at #<n>**, <date>.\n" +
			"  - **Settled at:** none — <why nothing decided it>.\n" +
			"Never merely absent (mantahostels#1219).",
	});
	return settledMissing;
}

const pointerPaths =
	/^- \*\*Restated in:\*\* (\d+) paths?, in `docs\/doc-map-restatements\.json`\.( ⚠ \*\*Restated-in is known incomplete\*\*\.)?$/;
const pointerNone =
	/^- \*\*Restated in:\*\* none — .+?\.( ⚠ \*\*Restated-in is known incomplete\*\*\.)?$/;
const pointerSupersedes =
	/^- \*\*Supersedes( \([^)]*\))?:\*\* see `docs\/doc-map-superseded\.json`\.$/;

/**
 * @param {Ctx} ctx
 * @param {string} dataDir
 */
function readSupersededData(ctx, dataDir) {
	const supersededFile = path.join(dataDir, DATA_FILES.supersededNeedles);
	/** @type {Record<string, unknown> | null} */
	let supersededData = null;
	try {
		supersededData = JSON.parse(fs.readFileSync(supersededFile, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT")
			ctx.broken(`superseded data file unreadable — ${message}`);
	}
	return { supersededFile, supersededData };
}

/**
 * @param {Ctx} ctx
 * @param {string} dataDir
 */
function readVocabData(ctx, dataDir) {
	const vocabFile = path.join(dataDir, DATA_FILES.retiredVocabulary);
	/** @type {Record<string, { phrases?: unknown[] }> | null} */
	let vocabData = null;
	try {
		vocabData = JSON.parse(fs.readFileSync(vocabFile, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT")
			ctx.broken(`retired-vocabulary data file unreadable — ${message}`);
	}
	return { vocabFile, vocabData };
}

/**
 * @typedef {{
 *   f: Figure,
 *   restatementData: Restatements,
 *   supersededData: Record<string, unknown> | null,
 *   vocabData: Record<string, { phrases?: unknown[] }> | null,
 * }} PointerScope
 */

/**
 * @param {PointerScope} s
 * @param {string} line
 * @returns {string[]}
 */
function restatedInFaults({ f, restatementData }, line) {
	const m = line.match(pointerPaths);
	if (m) {
		const key = restatementData[f.id];
		if (!key)
			return [
				`${f.id} — points at ${DATA_FILES.restatements}, which holds no key for it`,
			];
		if (Number(m[1]) !== key.paths.length)
			return [
				`${f.id} — pointer says ${m[1]} path(s), the sidecar holds ${key.paths.length}`,
			];
		return [];
	}
	if (pointerNone.test(line)) {
		const held = restatementData[f.id];
		return held
			? [
					`${f.id} — says \`none\` while ${DATA_FILES.restatements} holds ${held.paths.length} path(s)`,
				]
			: [];
	}
	return [
		`${f.id} — \`Restated in\` matches no template: ${line.trim().slice(0, 80)}`,
	];
}

/**
 * @param {PointerScope} s
 * @param {string} line
 * @returns {string[]}
 */
function supersedesFaults({ f, supersededData }, line) {
	if (!pointerSupersedes.test(line))
		return [
			`${f.id} — \`Supersedes\` matches no template: ${line.trim().slice(0, 80)}`,
		];
	if (supersededData && !supersededData[f.id])
		return [
			`${f.id} — \`Supersedes\` points at ${DATA_FILES.supersededNeedles}, which holds no key for it`,
		];
	return [];
}

/**
 * @param {PointerScope} s
 * @returns {string[]}
 */
function vocabCountFaults({ f, vocabData }) {
	const vocabText = parseRetiredVocabularyText(f.lines);
	if (vocabText === null) return [];
	const m = vocabText.match(/(?<!\d)(\d+)\s+phrases?\b/i);
	const vocabPhrases = vocabData?.[f.id]?.phrases;
	if (!m)
		return [`${f.id} — \`Retired vocabulary\` bullet states no phrase count`];
	if (Array.isArray(vocabPhrases) && Number(m[1]) !== vocabPhrases.length)
		return [
			`${f.id} — \`Retired vocabulary\` bullet says ${m[1]} phrase(s), ` +
				`${DATA_FILES.retiredVocabulary} holds ${vocabPhrases.length}`,
		];
	return [];
}

/**
 * @param {PointerScope} s
 * @returns {string[]}
 */
function figurePointerFaults(s) {
	const { f, restatementData, supersededData } = s;
	/** @type {string[]} */
	const faults = [];
	const body = f.lines;
	let sawRestated = false;
	let sawSupersedes = false;
	for (const line of body) {
		if (/^\s*-\s*\*\*Restated in/.test(line)) {
			sawRestated = true;
			faults.push(...restatedInFaults(s, line));
		}
		if (/^\s*-\s*\*\*Supersedes/.test(line)) {
			sawSupersedes = true;
			faults.push(...supersedesFaults(s, line));
		}
	}

	faults.push(...vocabCountFaults(s));

	if (!sawRestated && restatementData[f.id])
		faults.push(
			`${f.id} — ${DATA_FILES.restatements} holds a key for it, and the entry carries no \`Restated in\` bullet`,
		);
	if (!sawSupersedes && supersededData?.[f.id])
		faults.push(
			`${f.id} — ${DATA_FILES.supersededNeedles} holds a key for it, and the entry carries no \`Supersedes\` bullet`,
		);
	return faults;
}

/**
 * @param {Run} r
 * @param {{ restatementData: Restatements, figures: Figure[] }} sources
 */
function checkPointerShapes(r, { restatementData, figures }) {
	const { ctx, dataDir } = r;
	const { supersededFile, supersededData } = readSupersededData(ctx, dataDir);
	const { vocabFile, vocabData } = readVocabData(ctx, dataDir);

	const pointerFaults = figures.flatMap((f) =>
		figurePointerFaults({ f, restatementData, supersededData, vocabData }),
	);
	return {
		pointerFaults,
		supersededFile,
		supersededData,
		vocabFile,
		vocabData,
	};
}

/**
 * @param {Ctx} ctx
 * @param {string} mapPath
 */
function isMapDirty(ctx, mapPath) {
	return ctx.has("--map-dirty") || isDirty(mapPath);
}

/**
 * @param {Run} r
 * @param {Figure[]} figures
 * @param {ReturnType<typeof checkPointerShapes>} pointers
 * @returns {string[]}
 */
function reconcilePointerSidecars(
	r,
	figures,
	{ supersededFile, supersededData, vocabFile, vocabData },
) {
	const { ctx, mapPath } = r;
	/** @type {string[]} */
	const pointerFaults = [];
	if (supersededData) {
		const held = new Set(figures.map((f) => f.id));
		for (const id of Object.keys(supersededData))
			if (!held.has(id))
				pointerFaults.push(
					`${id} — ${DATA_FILES.supersededNeedles} keys it, and ${mapPath} holds no such entry`,
				);
	}

	if (!supersededData)
		ctx.say(
			`\n${supersededFile} is absent, so a \`Supersedes\` pointer's key ` +
				"was not reconciled — shape alone was checked.",
		);

	if (vocabData === null)
		ctx.say(
			`\n${vocabFile} is absent, so a \`Retired vocabulary\` bullet's ` +
				"phrase count was not reconciled — the bullet's own template was " +
				"still checked.",
		);
	return pointerFaults;
}

/**
 * @param {Ctx} ctx
 * @param {string} markFile
 * @returns {number}
 */
function readHighWaterMark(ctx, markFile) {
	let raw;
	try {
		raw = fs.readFileSync(markFile, "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		ctx.broken(
			code === "ENOENT"
				? `high-water mark file ${markFile} is missing. ${HIGH_WATER_MARK_REMEDY}`
				: `high-water mark file unreadable — ${message}`,
		);
	}
	const mark = parseHighWaterMark(raw);
	if (mark === null)
		ctx.broken(
			`high-water mark file ${markFile} holds no \`highWaterMark\` that is ` +
				"a non-negative integer.",
		);
	return mark;
}

/** @param {Run} r */
function checkHighWaterMark(r) {
	const { ctx, text, mapPath, dataDir } = r;
	const markFile = path.join(dataDir, DATA_FILES.highWater);
	const mark = readHighWaterMark(ctx, markFile);

	const reusedOrNull = newIdsAtOrBelowMark(text, mapPath, mark);
	const removedOrNull = idsRemovedSinceHead(text, mapPath);
	if (reusedOrNull === null || removedOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so whether ` +
				"this commit adds or removes a §B entry could not be read — the " +
				"high-water mark was not checked against it.",
		);
	reportFault(ctx, {
		tag: "REUSED-ENTRY-ID",
		msg: `${(reusedOrNull || []).length} §B id(s) new since HEAD sit at or below the high-water mark, B${mark}:`,
		key: "ids",
		items: reusedOrNull || [],
		advice:
			"Ids are permanent (mantahostels#892): an id at or below the mark may " +
			"have been held by a removed entry, and a reference to that entry " +
			"would resolve to this one. Give the entry the next free id instead:\n" +
			`  ${buildArbiterCommand`alloc-entry ${mapPath}`}`,
	});

	const headMark = readHeadHighWaterMark(markFile);
	const removedAbove = (removedOrNull || []).filter(
		(id) => idNumber(id) > mark,
	);
	/** @type {string[]} */
	const markFaults = removedAbove.map(
		(id) => `${id} leaves the map, above the mark B${mark}`,
	);
	if (headMark !== null && mark < headMark)
		markFaults.push(`the mark falls from HEAD's B${headMark} to B${mark}`);
	const wanted = Math.max(
		mark,
		headMark ?? 0,
		...removedAbove.map((id) => idNumber(id)),
	);
	reportFault(ctx, {
		tag: "HIGH-WATER-MARK",
		msg: `${DATA_FILES.highWater} does not hold the highest §B id ever removed:`,
		key: "faults",
		items: markFaults,
		advice:
			`Set \`highWaterMark\` in ${markFile} to ${wanted}, in the commit ` +
			"that removes the entry. The mark never falls: lowered, it lets a " +
			"later commit reuse an id a removed entry held.",
	});
}

const buildConsumesLine = (/** @type {ConsumesFault} */ d) =>
	`${d.doc} → ${d.ref} — ${d.why}`;

/**
 * @param {Run} r
 * @param {{
 *   headings: Headings,
 *   mapDirty: boolean,
 * }} state
 */
function checkConsumes(r, { headings, mapDirty }) {
	const {
		ctx,
		classesJson,
		classesFile,
		mapPath,
		resolvable,
		presentUntracked,
	} = r;
	const consumes = consumesFaults(classesJson, {
		tracked: resolvable,
		presentUntracked,
		liveFigures: new Set(headings.map((h) => h.id)),
	});

	const malformedConsumes = consumes.dead.filter((d) => d.shape);
	const unresolvedConsumes = consumes.dead.filter((d) => !d.shape);

	reportFault(ctx, {
		tag: "MALFORMED-CONSUMES",
		msg:
			`${malformedConsumes.length} \`consumes\` reference(s) in ${classesFile} ` +
			"are not typed references at all:",
		key: "references",
		items: malformedConsumes,
		line: buildConsumesLine,
		advice:
			"A reference is `{ kind, ref, gloss? }`, `kind` one of path, glob, " +
			"figure, issue, external, note. The sidecar will not load until " +
			"every element spells that.",
	});

	reportFault(ctx, {
		tag: "DEAD-CONSUMES",
		msg:
			`${unresolvedConsumes.length} typed \`consumes\` reference(s) in ${classesFile} ` +
			"resolve to nothing:",
		key: "references",
		items: unresolvedConsumes,
		line: buildConsumesLine,
		severity: mapDirty ? "warn" : "fail",
		advice: mapDirty
			? `${mapPath} has uncommitted edits, so the sidecar may not have been ` +
				"written yet. Land the edit, then re-run."
			: "The target was renamed or removed — send the reference " +
				"somewhere real, or retype it as `note` where it was never a " +
				"pointer. §A renders from this file, so regenerate after fixing:\n" +
				`  ${generatorCommand("doc-map-section-a")}`,
	});

	reportFault(ctx, {
		tag: "UNTRACKED-CONSUMES",
		msg:
			`${consumes.untracked.length} typed \`consumes\` reference(s) in ${classesFile} ` +
			"name a file present on disk but not yet tracked by git:",
		key: "references",
		items: consumes.untracked,
		line: buildConsumesLine,
		severity: "warn",
		advice: "Commit the file, or drop the reference until it lands.",
	});
	return malformedConsumes;
}

/** @param {Run} r */
function checkPairScope(r) {
	const { ctx, classesJson, classesFile } = r;
	const pairScope = pairScopeFaults(classesJson);
	reportFault(ctx, {
		tag: "PAIR-SCOPE",
		msg:
			`${pairScope.length} \`consumes\` gloss(es) in ${classesFile} open with a ` +
			"`with <other-ref>:` prefix naming the wrong neighbour:",
		key: "references",
		items: pairScope,
		line: buildConsumesLine,
		advice:
			"A pair-scoped gloss reaches back exactly one reference, so the " +
			"prefix spells the one immediately before it, exactly as §A " +
			"prints it (`with §B243:`, `with mantahostels#631:`, a path in its backticks). " +
			"Repoint the prefix, move the reference back beside it, or drop " +
			"the prefix where the gloss no longer covers a neighbour. §A " +
			"renders from this file, so regenerate after fixing:\n" +
			`  ${generatorCommand("doc-map-section-a")}`,
	});
}

/**
 * @param {Run} r
 * @param {string[]} pointerFaults
 * @param {boolean} mapDirty
 */
function reportPointerShape(r, pointerFaults, mapDirty) {
	const { ctx, mapPath } = r;
	reportFault(ctx, {
		tag: "POINTER-SHAPE",
		msg: `${pointerFaults.length} Section B pointer bullet(s) disagree with their sidecar:`,
		key: "pointers",
		items: pointerFaults,
		severity: mapDirty ? "warn" : "fail",
		advice: mapDirty
			? `${mapPath} has uncommitted edits — a half-rewritten entry is a live ` +
				"session mid-edit. Finish the edit and re-run."
			: "A `Restated in` or `Supersedes` bullet is a pointer and nothing " +
				"else: the prose lives in the sidecar it names, per path. Three " +
				"templates, and only three:\n" +
				"  - **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.\n" +
				"  - **Restated in:** none — <one clause saying why>.\n" +
				"  - **Supersedes:** see `docs/doc-map-superseded.json`.\n" +
				"Each of the first two may carry one suffix, the bare marker " +
				"` ⚠ **Restated-in is known incomplete**.`, which is what ages the " +
				"entry. Fix the count by editing the sidecar or the pointer — " +
				"never by deleting the bullet, which strands the key. A `Retired " +
				"vocabulary` bullet's free-text phrase count is held to the same " +
				"rule (mantahostels#2293): fix the count by editing " +
				"docs/doc-map-retired-vocabulary.json or the prose, whichever is " +
				"wrong.",
	});
}

/** @param {Run} r */
function checkNewEntryCap(r) {
	const { ctx, text, mapPath } = r;
	const newOverCapOrNull = newOverCapEntries(text, mapPath);
	const newOverCap = newOverCapOrNull || [];
	if (newOverCapOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so whether ` +
				"this commit ADDS a §B entry could not be read — the 300-word " +
				"new-entry prose cap was not checked.",
		);

	reportFault(ctx, {
		tag: "NEW-ENTRY-OVER-CAP",
		msg:
			`${newOverCap.length} §B entr(ies) new since HEAD exceed the ` +
			`${PROSE_CAP_WORDS}-word prose cap:`,
		key: "entries",
		items: newOverCap,
		line: (e) =>
			`${e.id} — ${e.words} prose words, ${e.excess} over the ${PROSE_CAP_WORDS}-word cap`,
		advice:
			"Cut PROSE from the entry until it is at or under " +
			`${PROSE_CAP_WORDS} words, then commit again. Never cut \`Inputs\`, ` +
			"`Restated in`, `Supersedes`, `Settled at` or `Owner` — the skeleton " +
			"bullets are uncapped.\n" +
			"This refuses the entry's FIRST commit only (mantahostels#1350): editing an " +
			"existing over-cap entry is not gated. Do not pay by declining to " +
			"write the entry — CLAUDE.md's " +
			"duty to record a settled load-bearing fact is unconditional. A " +
			"`Over cap by ruling (#n)` marker never lifts this gate: no ruling " +
			"can predate the entry it exempts (mantahostels#2058).",
	});
	return newOverCap;
}

/**
 * @param {Run} r
 * @param {Figure[]} figures
 */
function checkAdmissions(r, figures) {
	const { ctx, text, mapPath, dataDir } = r;
	const admissionsFile = path.join(dataDir, DATA_FILES.admissions);
	/** @type {Record<string, unknown> | null} */
	let admissionsData = null;
	let admissionsAbsent = false;
	try {
		admissionsData = JSON.parse(fs.readFileSync(admissionsFile, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT") admissionsAbsent = true;
		else ctx.broken(`admissions data file unreadable — ${message}`);
	}
	if (admissionsAbsent)
		ctx.say(
			`\nNo ${DATA_FILES.admissions} in this commit's tree. If you wrote ` +
				"the row and committed the map by pathspec, the sidecar went " +
				"unstaged — commit it with the map rather than writing the row " +
				"again.",
		);

	/** @type {Record<string, number[]>} */
	const settledIssues = {};
	for (const f of figures) {
		const nums = [
			...f.lines
				.join("\n")
				.matchAll(
					/^[^\S\n\r\u2028\u2029]*-\s*\*\*Settled at(?:[^\n#]|#(?!\d))*#(\d+)/gm,
				),
		].map((m) => Number(m[1]));
		if (nums.length > 0) settledIssues[f.id] = nums;
	}

	const unrecordedOrNull = unrecordedAdmissions(
		text,
		mapPath,
		admissionsData,
		settledIssues,
	);
	const unrecorded = unrecordedOrNull || [];
	if (unrecordedOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so whether ` +
				"this commit ADDS a §B entry could not be read — the admission " +
				"record was not checked.",
		);

	reportFault(ctx, {
		tag: "UNRECORDED-ADMISSION",
		msg:
			`${unrecorded.length} §B entr(ies) new since HEAD carry no conforming ` +
			`row in ${DATA_FILES.admissions}:`,
		key: "entries",
		items: unrecorded,
		line: (e) => `${e.id} — ${e.why}`,
		advice:
			"An entry enters §B when the founder confirms it belongs " +
			"(docs/doc-map.md §B preamble, on mantahostels#1728), and the confirmation is " +
			`written down before the entry is (mantahostels#2884). Add the row to ${DATA_FILES.admissions}:\n` +
			'  "B<n>": { "settledAt": <issue>, "confirmed": "<his answer>", ' +
			'"commentUrl": "https://github.com/<owner>/<repo>/issues/<issue>#issuecomment-<id>" }\n' +
			"`confirmed` is his answer verbatim, or the bare option letter where " +
			"he answered a lettered round — never your paraphrase of what he " +
			"meant. `commentUrl` is the comment recording it, on the issue " +
			"`settledAt` names: POST THAT COMMENT FIRST, because the permalink " +
			"does not exist until you have.\n" +
			"A CAP SPLIT is not an admission (mantahostels#2920), and its row says so — " +
			'`{ "capSplit": true, "from": "B<n>", "settledAt": <issue> }`, no ' +
			"confirmation, because nobody confirmed anything.\n" +
			"This refuses the entry's FIRST commit only, on assertion 14's " +
			"scope. Do not pay by declining to write the entry — CLAUDE.md's " +
			"duty to record a settled load-bearing fact is unconditional; the " +
			"payment is asking him, then writing down what he said.\n" +
			"WHAT THIS DOES NOT BUY (mantahostels#2884): the row is written by the same " +
			"session that writes the " +
			"entry, so it cannot prove the founder spoke. It buys a dated " +
			"primary artefact naming who confirmed what, and a URL that makes a " +
			"fabrication checkable in one click.",
	});
	return { unrecorded, unrecordedOrNull };
}

/** @param {Run} r */
function checkStaleMarkers(r) {
	const { ctx, text } = r;
	const staleMarkers = staleExemptionMarkers(text);
	reportFault(ctx, {
		tag: "STALE-OVER-CAP-MARKER",
		msg:
			`${staleMarkers.length} §B entr(ies) carry an over-cap marker but ` +
			"are no longer over cap:",
		key: "entries",
		items: staleMarkers,
		line: (e) =>
			`${e.id} — ${e.words} prose words, marked exempt by #${e.exemptedAt}`,
		advice:
			"Drop the `Over cap by ruling (#n)` bullet: the entry now reads at " +
			`or under ${PROSE_CAP_WORDS} words without it, so nothing exempts ` +
			"it any longer. An entry carrying no marker asserts nothing about " +
			"whether its claims are cuttable (docs/doc-map.md §B preamble).",
	});
	return staleMarkers;
}

/** @param {Run} r */
function checkMalformedMarkers(r) {
	const { ctx, text } = r;
	const malformedMarkers = malformedExemptionMarkers(text);
	reportFault(ctx, {
		tag: "MALFORMED-OVER-CAP-MARKER",
		severity: "warn",
		msg:
			`${malformedMarkers.length} §B line(s) look like an over-cap ` +
			"marker but do not parse as one:",
		key: "lines",
		items: malformedMarkers,
		line: (e) => `${e.id} — ${e.line}`,
		advice:
			"Respell the bullet exactly `- **Over cap by ruling (#n):**` — a " +
			"top-level bullet, the whole leader bold, the colon INSIDE the " +
			"bold, and a bare issue number after the `#`. Where the line is " +
			"prose rather than an attempted " +
			"marker, reword its opening so it does not read as one.",
	});
}

/** @param {Run} r */
function checkGrownEntries(r) {
	const { ctx, text, mapPath } = r;
	const grownOrNull = grownExemptEntries(text, mapPath);
	const grown = grownOrNull || [];
	if (grownOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so this ` +
				"commit has no baseline and growth in an over-cap-by-ruling entry " +
				"was not checked.",
		);

	reportFault(ctx, {
		tag: "OVER-CAP-ENTRY-GREW",
		severity: "warn",
		msg:
			`${grown.length} §B entr(ies) marked over cap by ruling grew in ` +
			"this commit:",
		key: "entries",
		items: grown,
		line: (e) =>
			`${e.id} — ${e.was} → ${e.words} prose words, +${e.growth}, marked exempt by #${e.exemptedAt}`,
		advice:
			"Pay for the addition inside the same entry: cut surplus wording " +
			`until the entry is no larger than it was, per ${"`"}docs/doc-map.md${"`"} §B ` +
			"preamble. Never cut a claim to get there (mantahostels#1911, mantahostels#1935). Where the " +
			"entry genuinely holds no surplus left, the addition stands: nothing " +
			"here refuses the commit, and the next commit's baseline is the entry " +
			"as this one leaves it.",
	});
}

/** @param {Run} r */
function checkDroppedMarkers(r) {
	const { ctx, text, mapPath } = r;
	const droppedOrNull = droppedExemptionMarkers(text, mapPath);
	const dropped = droppedOrNull || [];
	if (droppedOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so this ` +
				"commit has no baseline and a dropped over-cap-by-ruling marker " +
				"was not checked.",
		);

	reportFault(ctx, {
		tag: "OVER-CAP-MARKER-DROPPED",
		severity: "warn",
		msg:
			`${dropped.length} over-cap §B entr(ies) lost the marker the ` +
			"baseline carried:",
		key: "entries",
		items: dropped,
		line: (e) =>
			`${e.id} — ${e.words} prose words, marked exempt by #${e.exemptedAt} until this commit`,
		advice:
			"Deleted by accident? Put the `- **Over cap by ruling (#n):**` " +
			"bullet back. MISSPELLED rather than deleted — a " +
			"MALFORMED-OVER-CAP-MARKER above naming the same entry — then " +
			"respell that line and add no second bullet: a valid one beside it " +
			"silences that block and leaves the bad line in the file. " +
			"Un-marked on purpose, the ruling revisited? The entry is back in " +
			"the drain queue and this WARN is the whole of it: nothing refuses " +
			"the commit, and draining to " +
			`${PROSE_CAP_WORDS} words or fewer is not reported here at all. ` +
			"What the marker was holding: it is the ratchet's baseline, so an " +
			"entry that loses it may grow unwatched, and re-adding it later is " +
			"exempt as a first marking.",
	});
}

/** @param {Run} r */
function checkLedgerCap(r) {
	const { ctx, text, mapPath } = r;
	const overCapLedgerOrNull = overCapLedgerEntries(text);
	const overCapLedger = overCapLedgerOrNull || [];
	if (overCapLedgerOrNull === null)
		ctx.say(
			`\n${mapPath} carries no \`Sheds paid, most recent first:\` line, so ` +
				`the ${LEDGER_ENTRY_CAP_BYTES} B shed-ledger entry cap was not checked.`,
		);

	reportFault(ctx, {
		tag: "LEDGER-ENTRY-OVER-CAP",
		msg:
			`${overCapLedger.length} shed-ledger entr(ies) exceed the ` +
			`${LEDGER_ENTRY_CAP_BYTES} B cap:`,
		key: "entries",
		items: overCapLedger,
		line: (e) =>
			`${e.label} — ${e.bytes} B, ${e.excess} over the ${LEDGER_ENTRY_CAP_BYTES} B cap`,
		advice:
			"Only the NEWEST entry is written in full. Compact each of the others " +
			"to five things: the tranche's issue number, its " +
			"date, its net byte figure, what it did in one clause, and its named " +
			"residual — the conclusion about a shed candidate that stops a later " +
			"session re-proposing it. Where the displaced entry carried a " +
			"prediction, its verdict is a sixth element beside the residual, " +
			"never inside it (mantahostels#1864); nothing else.\n" +
			"The full narrative stays recoverable from the tranche's own issue " +
			"and from `git log -p`.",
	});
	return { overCapLedger, overCapLedgerOrNull };
}

/** @param {Run} r */
function checkTriggerVerdict(r) {
	const { ctx, text, mapPath } = r;
	const revs = readParentRevs();
	const poolDelta = stagedPoolDelta(revs);
	const ledgerEntries = shedLedgerEntries(text);
	/** @type {{ label: string, fault: string }[]} */
	let triggerFaults = [];
	if (poolDelta === null)
		ctx.say(
			"\nNo committed rev resolves, so whether this commit adds " +
				"always-loaded pool bytes could not be read — the §5 trigger " +
				"verdict was not checked.",
		);
	else if (ledgerEntries === null)
		ctx.say(
			`\n${mapPath} carries no \`Sheds paid, most recent first:\` line, so ` +
				"the §5 trigger verdict was not checked.",
		);
	else if (poolDelta > 0)
		triggerFaults = triggerVerdictFaults(
			ledgerEntries,
			revs
				.map((rev) => shedLedgerEntries(readMapTextAt(rev, mapPath) || ""))
				.filter((e) => e !== null),
		);

	reportFault(ctx, {
		tag: "LEDGER-TRIGGER-VERDICT",
		msg:
			`this commit adds ${poolDelta} B to the always-loaded pool and §5's ` +
			"ledger does not answer the placement test's step 2:",
		key: "entries",
		items: triggerFaults,
		line: (e) => `${e.label} — ${e.fault}`,
		advice:
			".claude/workflow-core.doc-map.md §Capture and placement §4 already obliges a tranche " +
			"adding pool bytes to name its shed in the same commit. This adds one " +
			"line to that entry: the trigger the rule binds behind, written\n" +
			`  ${TRIGGER_VERDICT_MARKER} <the nearest observable event — a tool ` +
			"call, or class of calls — before the decision the rule binds>\n" +
			"or, where §3's step 2 names none — which is the pool's only " +
			"entrance —\n" +
			`  ${TRIGGER_VERDICT_MARKER} none nameable — <one clause saying why>\n` +
			"It sits in the NEWEST entry, which assertion 15 exempts from the " +
			`${LEDGER_ENTRY_CAP_BYTES} B cap, so this costs no compaction. ` +
			"Nothing here judges whether " +
			"the trigger really fires: the gate is that step 2 was answered.",
	});
	return { poolDelta, ledgerEntries, triggerFaults };
}

/**
 * @param {Run} r
 * @param {string[][] | null} ledgerEntries
 */
function checkCompactionVerdict(r, ledgerEntries) {
	const { ctx, mapPath } = r;
	const compactionFaults =
		ledgerEntries === null
			? []
			: compactionVerdictFaults(
					ledgerEntries,
					shedLedgerEntries(readMapTextAt("HEAD", mapPath) || ""),
				);

	reportFault(ctx, {
		tag: "LEDGER-COMPACTION-VERDICT",
		msg:
			"this commit compacts a ledger entry that carried a prediction, and " +
			"§5's verdict is not there to find:",
		key: "entries",
		items: compactionFaults,
		line: (e) => `${e.label} — ${e.fault}`,
		advice:
			"§5: a tranche compacted to five elements carries a SIXTH where the " +
			"entry it displaces carried a prediction — the verdict, beside the " +
			"named residual and never inside it (mantahostels#1864), so a marker is there " +
			"to find it by. Write it onto the compacted entry:\n" +
			`  ${VERDICT_MARKER}: held** — <subject> fired <N> times since <date>\n` +
			"It asserts RETRIEVAL and nothing else (mantahostels#1887). Where the prediction " +
			"has not ripened, the audit stamp is the verdict — " +
			`\`${VERDICT_MARKER}: not yet ripe**\` plus the reading — and the live ` +
			"claim is carried forward into your own entry (mantahostels#1888).\n" +
			`The floor is ${TRIGGER_VERDICT_MIN_WORDS} words after the marker, so ` +
			"a pasted marker does not clear the gate. The verdict costs 77-152 B " +
			`against the ${LEDGER_ENTRY_CAP_BYTES} B cap assertion 15 gates (mantahostels#1889).`,
	});
}

/**
 * @param {Run} r
 * @param {{
 *   badClasses: ReturnType<typeof badClassEntries>,
 *   badReaders: ReturnType<typeof badReaderEntries>,
 *   malformedConsumes: ConsumesFault[],
 * }} faults
 */
function loadClassesUnlessFaulted(
	r,
	{ badClasses, badReaders, malformedConsumes },
) {
	const { ctx, classesFile } = r;
	const classes =
		badClasses.length > 0 ||
		badReaders.unknown.length > 0 ||
		malformedConsumes.length > 0
			? null
			: loadDocClasses(classesFile);
	if (!classes)
		ctx.say(
			`\n${badClasses.length} unknown class token(s), ` +
				`${badReaders.unknown.length} unknown reader token(s) and ` +
				`${malformedConsumes.length} malformed \`consumes\` reference(s) in ` +
				`${classesFile}, so §A's rendered bytes and the \`role\` word cap ` +
				"were not checked.",
		);
	return classes;
}

const aboveSectionB = (/** @type {string} */ t) => {
	const [above] = t.split(/^## Section B/m);
	if (above === undefined)
		throw new Error("splitting the map at Section B yielded no part");
	return above;
};
const parseRowLines = (/** @type {string} */ t) => {
	const region = aboveSectionB(t).split(/^## Section A/m)[1] || "";
	/** @type {Map<string, string>} */
	const byPath = new Map();
	for (const line of region.split("\n")) {
		const [rowPath] = registerRowPaths(line);
		const listed = registerListPath(line);
		if (rowPath !== undefined) byPath.set(rowPath, line);
		else if (listed) byPath.set(listed, line);
	}
	return byPath;
};

/**
 * @param {string} mapPath
 * @param {string} text
 * @param {string} renderedText
 */
function sectionAFaults(mapPath, text, renderedText) {
	/** @type {{ path: string, fault: string }[]} */
	const renderFaults = [];
	if (renderedText === text) return renderFaults;
	const have = parseRowLines(text);
	const want = parseRowLines(renderedText);
	for (const [p, line] of want)
		if (have.get(p) !== line)
			renderFaults.push({
				path: p,
				fault: have.has(p) ? "row differs" : "row missing",
			});
	for (const p of have.keys())
		if (!want.has(p))
			renderFaults.push({ path: p, fault: "row has no sidecar key" });
	if (renderFaults.length === 0)
		renderFaults.push({
			path: mapPath,
			fault: "row order or subsection placement differs",
		});
	return renderFaults;
}

/**
 * @param {Run} r
 * @param {Classes} classes
 */
function checkSectionA(r, classes) {
	const { ctx, text, mapPath, classesFile } = r;
	const hasRegisterTable = aboveSectionB(text)
		.split(/^## Section A/m)
		.slice(1)
		.some((section) => section.includes(REGISTER_HEADER));
	if (classes && !hasRegisterTable)
		ctx.say(
			`\n${mapPath} §A carries no \`${REGISTER_HEADER}\` table, so its ` +
				"rendered bytes were not checked.",
		);

	const renderedText =
		classes && hasRegisterTable ? renderSectionA(text, classes) : text;
	const renderFaults = sectionAFaults(mapPath, text, renderedText);

	reportFault(ctx, {
		tag: "SECTION-A-DRIFT",
		msg: `§A does not match what the generator renders from ${classesFile}:`,
		key: "renderFaults",
		items: renderFaults,
		line: (e) => `${e.path} — ${e.fault}`,
		advice:
			"§A is rendered, not hand-written (docs/doc-map.md §Authority " +
			"classes). Put the change in the sidecar, then regenerate:\n" +
			`  ${generatorCommand("doc-map-section-a")}\n` +
			"A NEW document is registered with `node scripts/register-doc.js " +
			"<path> --class <token> --section <name>`, which writes the key the " +
			"row renders from. `--section` must spell a subsection §A already " +
			"has; add `--new-section` to mint one.",
	});
	return { hasRegisterTable, renderFaults };
}

/**
 * @param {Ctx} ctx
 * @param {Classes} classes
 */
function checkRoleCap(ctx, classes) {
	const overCapRoleList = classes ? overCapRoles(classes) : [];
	reportFault(ctx, {
		tag: "ROLE-OVER-CAP",
		msg:
			`${overCapRoleList.length} \`role\` override(s) exceed the ` +
			`${ROLE_CAP_WORDS}-word cap:`,
		key: "overCapRoles",
		items: overCapRoleList,
		line: (e) =>
			`${e.path} — ${e.words} words, ${e.excess} over the ${ROLE_CAP_WORDS}-word cap`,
		advice:
			"A `role` override exists to carry what the generated default " +
			"cannot: a ⚠ correction or supersession, a ruling citation, or a " +
			"research note's date and headline (mantahostels#1850's keep rule). Cut it back " +
			"to that, in the sidecar, and regenerate. The document itself is " +
			"where the detail belongs — §A points at it, never restates it.",
	});
	return overCapRoleList;
}

/** @param {Ctx} ctx */
function countFailItems(ctx) {
	const failItemCount = ctx.findings.reduce((total, finding) => {
		if (finding.severity !== "FAIL") return total;
		const items = Object.values(finding).find((v) => Array.isArray(v));
		if (items) return total + items.length;
		ctx.say(
			`${finding.tag} carries no item list — counted as one problem, and ` +
				"the summary count may now under-report.",
		);
		return total + 1;
	}, 0);
	return failItemCount;
}

runCheck({
	name: "doc-map",
	usage:
		"node check-doc-map.js [<doc-map.md>] [--data-dir <dir>] [--root <dir>]",
	valueFlags: ["--data-dir", "--root"],
	flags: ["--map-dirty"],
	run: (/** @type {Ctx} */ ctx) => withGitReadMemo(() => runChecks(ctx)),
});

/** @param {Ctx} ctx */
function runChecks(ctx) {
	const { root, underRoot, mapPath, dataDir } = resolveLocations(ctx);
	skipOnConflict(ctx);
	const { text, stamp, entries } = readMap(ctx, mapPath);
	const sidecar = readClassSidecar(ctx, { dataDir, underRoot });
	const { allTracked, resolvable } = walkTree(ctx, root);
	/** @type {Run} */
	const r = {
		ctx,
		underRoot,
		mapPath,
		dataDir,
		text,
		entries,
		...sidecar,
		allTracked,
		resolvable,
		tracked: inScope(allTracked),
		presentUntracked: untrackedMatcher(),
	};
	const { tracked } = r;

	const { uncoveredSplit, deadSplit, untracked } = checkCoverage(r);
	const { badClasses, badReaders } = checkSidecarVocabulary(r);
	reportUntrackedEntries(ctx, untracked);
	const { routes, reached, deadRoutes, untrackedRoutes } = checkRoutes(r);
	const routeIdFaults = checkRouteIds(r);
	const {
		restatementData,
		figures,
		restatementPaths,
		figuresRestated,
		deadRestatements,
	} = checkRestatements(r);
	const lineLocators = checkLineLocators(r, { restatementData, figures });
	const deadAnchors = checkDeadAnchors(r, restatementData);
	const deadRefs = checkSectionRefs(r);
	const unreached = reportCensus(r, {
		restatementPaths,
		figuresRestated,
		figures,
		reached,
	});

	const sectionBWords = roundedSectionBWords(text);

	const { headings, seen, duplicates } = checkDuplicateIds(r);
	const rowDuplicates = checkDuplicateKeys(r);
	const classesDrift = checkCanonicalSidecar(r);
	const strays = checkStrays(ctx, headings);
	const settledMissing = checkSettledAt(ctx, figures);
	const pointers = checkPointerShapes(r, { restatementData, figures });
	const mapDirty = isMapDirty(ctx, mapPath);
	const pointerFaults = [
		...pointers.pointerFaults,
		...reconcilePointerSidecars(r, figures, pointers),
	];
	checkHighWaterMark(r);
	const malformedConsumes = checkConsumes(r, { headings, mapDirty });
	checkPairScope(r);
	reportPointerShape(r, pointerFaults, mapDirty);
	const newOverCap = checkNewEntryCap(r);
	const { unrecorded, unrecordedOrNull } = checkAdmissions(r, figures);
	const staleMarkers = checkStaleMarkers(r);
	checkMalformedMarkers(r);
	checkGrownEntries(r);
	checkDroppedMarkers(r);
	const { overCapLedger, overCapLedgerOrNull } = checkLedgerCap(r);
	const { poolDelta, ledgerEntries, triggerFaults } = checkTriggerVerdict(r);
	checkCompactionVerdict(r, ledgerEntries);
	const classes = loadClassesUnlessFaulted(r, {
		badClasses,
		badReaders,
		malformedConsumes,
	});
	const { hasRegisterTable, renderFaults } = checkSectionA(r, classes);
	const overCapRoleList = checkRoleCap(ctx, classes);
	const failItemCount = countFailItems(ctx);

	return {
		okLine:
			`doc map covers all ${tracked.length} tracked files in scope ` +
			`(${entries.length} register entries, ${routes.length} question routes ` +
			"with no id gap, " +
			"every route path and every §B restatement path live, no line-number locator, every quoted anchor held, every doc-map section reference live; " +
			`${seen.size} distinct §B entry ids, each with a \`Settled at\` bullet ` +
			"and a sidecar-agreeing pointer; no id at or below the high-water mark reused, and none removed above it; " +
			`no entry new since HEAD over the ${PROSE_CAP_WORDS}-word prose cap; ` +
			(unrecordedOrNull === null
				? ""
				: "every entry new since HEAD carrying an admission row; ") +
			"no stale over-cap marker" +
			(overCapLedgerOrNull === null
				? ""
				: "; every shed-ledger entry but the newest at or under " +
					`${LEDGER_ENTRY_CAP_BYTES} B`) +
			(poolDelta !== null && poolDelta > 0 && ledgerEntries !== null
				? `; §5's newest ledger entry answers step 2 for this commit's ` +
					`${poolDelta} B of new pool bytes`
				: "") +
			(classes && hasRegisterTable
				? "; §A matches the generator against " +
					`${Object.keys(classes).length} sidecar rows, every \`role\` ` +
					`override at or under ${ROLE_CAP_WORDS} words, every ` +
					"pair-scope prefix naming the reference beside it"
				: "") +
			"); " +
			`§B ~${sectionBWords.toLocaleString("en-GB")} ` +
			`words — ${stamp[0].split(" · ")[0]}`,
		noun: "doc-map problem(s)",
		count: failItemCount,
		data: {
			uncovered: uncoveredSplit.outOfGrace,
			dead: deadSplit.outOfGrace,
			untracked,
			duplicates,
			strays,
			rowDuplicates,
			pointerFaults,
			deadRoutes,
			untrackedRoutes,
			deadRestatements,
			lineLocators,
			deadAnchors,
			sectionRefs: deadRefs,
			routeIdFaults,
			settledMissing,
			newOverCap,
			unrecorded,
			staleMarkers,
			overCapLedger,
			triggerFaults,
			renderFaults,
			overCapRoles: overCapRoleList,
			classesDrift,
			unreached,
			tracked: tracked.length,
			entries: entries.length,
			routes: routes.length,
		},
	};
}
