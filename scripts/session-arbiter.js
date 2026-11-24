#!/usr/bin/env node

const {
	listedSessionIds,
	sharedSessionIds,
	sweepSessionIds,
} = require("./lib/agent-liveness.js");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./lib/arbiter-store.js");
const { shellQuote } = require("./lib/sh-quote.js");
const waitMod = require("./lib/arbiter-wait.js");
const toolRecord = require("./lib/arbiter-tool-record.js");
const { parseOrCode } = require("./lib/cli-args");
const { recordRun, JOB_PRUNE_MARKERS } = require("./lib/detached-run.js");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { runProgram } = require("./lib/program-scope.js");
const { caught, ignoreFailure } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");
const { envelope } = require("./lib/hook-envelope.js");
const { readOwnPaths } = require("./lib/own-work.js");
const { FULL_SHA } = require("./lib/commit-sha.js");
const { appendRetained, DAY_MS } = require("./lib/retained-jsonl.js");

/** @returns {number} */
function detachPrune() {
	ignoreFailure(() => {
		const { spawnOutliving } = require("./lib/user-scope.js");
		const starter = require("./lib/session-id.js").fromEnv();
		const child = spawnOutliving(
			process.execPath,
			[__filename, "prune-markers", ...(starter ? ["--spare", starter] : [])],
			{ stdio: "ignore" },
		);
		child.unref();
		child.on("error", noop);
	});
	return 0;
}

/**
 * @typedef {import("./lib/arbiter-store.js").LockRecord} LockRecord
 * @typedef {import("./lib/arbiter-store.js").Identity} Identity
 * @typedef {import("./lib/arbiter-store.js").BreakRecord} BreakRecord
 * @typedef {import("./lib/arbiter-store.js").ListedLock} ListedLock
 * @typedef {import("./lib/arbiter-store.js").ClaimResult} ClaimResult
 * @typedef {import("./lib/arbiter-records.js").OwnHunks} OwnHunks
 * @typedef {import("./lib/arbiter-store.js").IssueClaimRecord} IssueClaimRecord
 */

/** @typedef {any} WantRecord */
const regions = require("./lib/doc-map-regions.js");
const {
	DATA_FILES,
	HIGH_WATER_MARK_REMEDY,
	idNumber,
	parseHighWaterMark,
} = require("./lib/doc-map.js");

// lucmoseley/mantahostels#411
// lucmoseley/mantahostels#1960
/** @type {ReturnType<typeof listedSessionIds>|undefined} */
let listedMemo;
function listedOnce() {
	if (listedMemo === undefined) listedMemo = listedSessionIds();
	return listedMemo;
}
/** @param {() => ReturnType<typeof listedSessionIds>} read */
function relistSessions(read) {
	listedMemo = read();
	return listedMemo;
}
function forgetListed() {
	listedMemo = undefined;
}

/**
 * @param {Map<string, string>|null|undefined} listed
 * @returns {SessionNames}
 */
function sessionNames(listed) {
	const registry = store.registryLookup();
	return {
		get: (id) => listed?.get(id) || registry(id)?.name || undefined,
	};
}

/** @typedef {{get: (id: string) => string|undefined}} SessionNames */

function holderNames() {
	return sessionNames(listedOnce().names);
}

function holderTerminal() {
	return listedOnce().terminal;
}

function nameResolver() {
	const names = holderNames();
	return (/** @type {string|null} */ id) =>
		(id && names.get(id)) || id || "an unidentified session";
}

/**
 * @param {string|null|undefined} id
 * @param {string|null} name
 * @param {{pid?: unknown, claimedAt?: string|null}|null} [lock]
 */
function describeSession(id, name, lock = null) {
	const parenthesised = [];
	if (name && id) parenthesised.push(`id ${id}`);
	if (lock) parenthesised.push(`pid ${lock.pid ?? "unknown"}`);
	const who = name || id || "an unidentified session";
	const when = lock?.claimedAt ? ` since ${lock.claimedAt}` : "";
	return parenthesised.length > 0
		? `${who} (${parenthesised.join(", ")})${when}`
		: `${who}${when}`;
}

/** @param {string|null|undefined} id */
const nameSession = (id) =>
	describeSession(id, (id && holderNames().get(id)) || null);

/** @param {LockRecord|null} lock @param {SessionNames} [names] */
function describeHolder(lock, names = holderNames()) {
	const id = lock?.sessionId;
	return describeSession(id, (id && names.get(id)) || null, lock ?? {});
}

/**
 * @param {string} rel
 * @param {LockRecord} lock
 * @param {SessionNames} [names]
 */
function buildContendedNotice(rel, lock, names) {
	const held = lock?.path || rel;
	const covered = held === rel ? "" : ` (it covers ${rel})`;
	return (
		`${held} is also held by session ${describeHolder(lock, names)}, which is still running${covered}. Your write goes ahead in your own worktree, unclaimed — but you are both changing it, so whichever of you lands second will likely meet a merge conflict there.\n` +
		`Keep this change small and land it soon, or do another part of your ticket first. See what is held: ${buildArbiterCommand`list`}`
	);
}

const CLOBBER_ROUTES =
	"a `cp`, a `git restore`, a heredoc, a script, or another session";

/** @param {string} rel @param {string|null} was @param {string} closing */
function buildClobberNotice(rel, was, closing) {
	return (
		`${rel} has changed since this session last wrote it, and no tool call of yours did it.\n\n` +
		`Something reached the file by a route no hook watches — ${CLOBBER_ROUTES}.\n\n` +
		`The version you last wrote is recoverable:\n  git cat-file -p ${was} > /tmp/recovered\n\n` +
		closing
	);
}

const CLOBBER_AT_WRITE =
	"This write is about to replace what is there now. Diff the recovered copy against the file before you continue.";

const CLOBBER_AT_RELEASE =
	"Whatever recorded those bytes — a claim, or the observation an unclaimed writer gets (mantahostels#2333) — is dropped either way. Diff the recovered copy against the file, and do it now: the pin went with the record, so git will prune that object in a fortnight.";

const CLOBBER_AT_REFUSED_RELEASE =
	"The release below refuses, so the claim and its pin both stand: the recovered copy keeps, rather than starting git's fortnight. Diff it against the file before you write to the path again.";

const CLOBBER_AT_COMMITTED_REFUSAL =
	"Nothing was released here, so the claim and its pin both stand — the recovered copy keeps, rather than starting git's fortnight. Diff it against the file before you write to the path again.";

const CLOBBER_AT_DIRTY_RELEASE =
	"The release below refuses, so the claim and its pin both stand. Diff the recovered copy against the file BEFORE you follow that refusal: committing what is there now puts somebody else's bytes under your own message (mantahostels#63).";

/**
 * @param {string} rel
 * @param {string|null|undefined} anchor
 * @param {string|number|null|undefined} anchorLength
 * @returns {{ subjects: string[], notes: string[] }}
 */
function claimSubjects(rel, anchor, anchorLength) {
	if (!regions.isRegioned(rel)) return { subjects: [rel], notes: [] };
	const fallback = (/** @type {string|null} */ why) => {
		if (!anchor) return { subjects: [rel], notes: [] };
		store.logError(
			"region",
			new Error(`${rel}: ${why} — claiming the whole file`),
		);
		return {
			subjects: [rel],
			notes: [
				`This write claims the WHOLE of ${rel}, not one region of it: ${why}.\n\n` +
					"That blocks every other session on the file until this one ends or releases it, so release it as soon as you are done:\n" +
					`  ${buildArbiterCommand`release ${rel}`}`,
			],
		};
	};

	let text;
	try {
		text = fs.readFileSync(path.join(store.treeRoot(), rel), "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		return fallback(`the file could not be read (${code || message})`);
	}
	let resolved;
	try {
		resolved = regions.resolveRegion(text, anchor, Number(anchorLength), rel);
	} catch (e) {
		const { code, message } = caught(e);
		return fallback(`the region parser threw (${code || message})`);
	}
	if (resolved.region)
		return { subjects: [store.subjectFor(rel, resolved.region)], notes: [] };
	if (!resolved.regions || resolved.regions.length === 0)
		return fallback(resolved.why);
	return {
		subjects: resolved.regions.map((r) => store.subjectFor(rel, r)),
		notes: [],
	};
}

/** @param {string} file @param {string[]} subjects */
const buildStraddleNotice = (file, subjects) =>
	`This write claims ${subjects.length} regions of ${store.splitSubject(file).rel}, not one — the anchor straddles them, so the write holds every region it rewrites.\n\n` +
	"Release them as soon as you are done:\n" +
	subjects.map((s) => `  ${buildArbiterCommand`release ${s}`}`).join("\n");

/** @param {string} rel */
const buildWholeFileWriteNotice = (rel) =>
	`This write claims the WHOLE of ${rel}, not one region of it: it carries no anchor to place, so it takes every region, and every other session writing the file is warned of a likely merge conflict until this one ends or releases it.\n\n` +
	"A Write or a NotebookEdit belongs here — each rewrites the file entire. An Edit does not: it takes ONE region off its own anchor, so if this WAS an Edit its anchor could not be read (the file-claim guard drops one it cannot read), and making it again should narrow the claim.\n\n" +
	"Release it as soon as you are done:\n" +
	`  ${buildArbiterCommand`release ${rel}`}`;

/**
 * @param {string} file
 * @param {string|null|undefined} newIds
 * @param {string|null} sessionId
 */
function unallocatedEntryNotes(file, newIds, sessionId) {
	try {
		if (!regions.isRegioned(file)) return [];
		const ids = String(newIds || "")
			.split(",")
			.filter((id) => /^B\d+$/.test(id));
		if (ids.length === 0) return [];
		// lucmoseley/mantahostels#174
		const held = store.readHeldBy(sessionId);
		if (held === null || held.includes(file)) return [];
		const missing = ids.filter(
			(id) => !held.includes(store.subjectFor(file, id)),
		);
		if (missing.length === 0) return [];
		return [
			`This write adds ${missing.join(", ")} to ${file}, and this session holds no claim on ${missing.length > 1 ? "those ids" : "that id"}. An id and its append slot are taken together, so two sessions appending at once cannot both pick the same number — and a duplicate \`### B<n>\` cannot be renumbered away (mantahostels#892):\n  ${buildArbiterCommand`alloc-entry ${file}`}\n\n` +
				`Nothing is refused on this: a session re-typing a heading it already owns is warned too. If the id is genuinely new, allocate it before the commit — node ${scriptPath("check-doc-map.js")} FAILs a duplicate in pre-commit.`,
		];
	} catch (e) {
		const { code, message } = caught(e);
		store.logError(
			"region",
			new Error(
				`${file}: the unallocated-id check threw (${code || message}) — the write was not checked against its entry ids`,
			),
		);
		return [];
	}
}

/**
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {{ anchor?: string|null, anchorLength?: string|number|null, newIds?: string|null }} [edit]
 */
function cmdCheck(filePath, sessionId, { anchor, anchorLength, newIds } = {}) {
	if (filePath === undefined) throw new Error("check needs a path");
	const file = store.claimKey(filePath);
	if (file === null || !store.isWatched(file)) return;

	const { subjects, notes } = claimSubjects(file, anchor, anchorLength);

	const me = store.identify(sessionId);
	const { taken, contended, notices } = takeSet(subjects, me);
	const primary = taken[0];
	if (primary === undefined)
		throw new Error(`takeSet took nothing of ${subjects.join(", ")}`);

	notes.push(...notices.broken);
	const names = sessionNames(null);
	notes.push(
		...contended.map((c) => buildContendedNotice(c.rel, c.lock, names)),
	);
	const held = taken.filter((t) => isRealClaim(t.verdict)).map((t) => t.rel);
	notes.push(...subjectNotes(file, held, anchor, primary.verdict));
	notes.push(...writeClobberNotes(primary, me.sessionId));
	notes.push(...uncheckedNotes(notices.unchecked));

	notes.push(...unallocatedEntryNotes(file, newIds, me.sessionId));
	notes.push(...dirtyUnclaimedNotes(primary));

	if (notes.length > 0) {
		writeStdout(
			`${JSON.stringify(
				envelope("PreToolUse", { additionalContext: notes.join("\n\n") }),
			)}\n`,
		);
	}
}

/**
 * @param {string} file
 * @param {string[]} subjects
 * @param {string|null|undefined} anchor
 * @param {string} verdict
 * @returns {string[]}
 */
function subjectNotes(file, subjects, anchor, verdict) {
	if (subjects.length > 1) return [buildStraddleNotice(file, subjects)];
	if (!anchor && regions.isRegioned(file) && verdict === "claimed")
		return [buildWholeFileWriteNotice(file)];
	return [];
}

/**
 * @param {Acquired} primary
 * @param {string|null} sessionId
 * @returns {string[]}
 */
function writeClobberNotes({ rel, verdict, lock }, sessionId) {
	const claimed = isRealClaim(verdict) ? store.contentState(rel, lock) : null;
	const { state, was } =
		claimed && claimed.state !== "unknown"
			? claimed
			: store.observationState(rel, sessionId);
	return state === "changed"
		? [buildClobberNotice(rel, was, CLOBBER_AT_WRITE)]
		: [];
}

/** @param {string[]} unchecked */
function uncheckedNotes(unchecked) {
	return unchecked.map(
		(rel) =>
			`${rel} could not be checked: the file-claim store is unreadable, so this write is allowed but NOT protected, and no claim was taken.\n\n` +
			`Every session is unguarded on docs/, .claude/, CLAUDE.md and AGENTS.md until this is fixed. Check by hand before overwriting, and see the fault: node ${scriptPath("check-guard-errors.js")}`,
	);
}

/** @param {Acquired} primary @returns {string[]} */
function dirtyUnclaimedNotes({ rel, verdict, lock }) {
	if (
		verdict === "claimed" &&
		store.isWarned(rel) &&
		store.gitDirty(rel) === true &&
		!store.liveClaimElsewhereOnFile(rel, lock?.claimId)
	)
		return [
			`${rel} has uncommitted changes that no live session claims. Nobody holds it, so this write is allowed — but the edits are someone's work: a session that has since ended, one that released the file once its own hunks landed (workflow-core#2148), or a hand edit. They are not yours to commit. Read the diff before overwriting it.`,
		];
	return [];
}

// guess: the doc map held 113 regions on 24 Aug 2026, lucmoseley/mantahostels#1313
const REGIONS_SHOWN = 12;

/** @param {string} rel @param {string} region */
function buildUnknownRegionReason(rel, region) {
	let ids;
	try {
		const text = fs.readFileSync(path.join(store.treeRoot(), rel), "utf8");
		ids = [...new Set(regions.parseRegions(text, rel).map((r) => r.id))];
		if (ids.includes(region)) return null;
		const append = region.match(/^B(\d+)$/);
		if (
			append &&
			Number(append[1]) >=
				regions.nextEntryNumber(text, readHighWaterMarkFor(rel))
		)
			return null;
		if (region.startsWith(regions.ROW_PREFIX)) return null;
	} catch (e) {
		const { code, message } = caught(e);
		const why = `${rel} could not be read or parsed (${code || message})`;
		store.logError("region", new Error(`${why} — claiming unvalidated`));
		writeStderr(
			`session-arbiter: ${why}, so \`${region}\` was never checked against it — the claim was taken anyway, and may name a region that does not exist. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return null;
	}
	const asked = region.match(/^B(\d+)$/);
	const isEntry = (/** @type {string} */ id) => /^B\d+$/.test(id);
	const near = ids.filter(
		(id) =>
			!id.startsWith(regions.ROW_PREFIX) && isEntry(id) === Boolean(asked),
	);
	const below = asked
		? near.filter((id) => idNumber(id) < Number(asked[1])).length
		: 0;
	const from = Math.max(0, below - REGIONS_SHOWN + 2);
	const window = near.slice(from, from + REGIONS_SHOWN);
	const shown = window.join(", ");
	const rest = near.length - window.length;
	return (
		`session-arbiter: ${rel} has no region \`${region}\`, so no claim was taken and a write to it would be unprotected.\n` +
		`Its ${asked ? "entries" : "sections"} are: ${shown}${rest > 0 ? `, and ${rest} more` : ""}.\n` +
		"This is a fatal spelling error, not contention: RETRYING WILL NEVER CLEAR IT, so a poll loop must stop on exit 2 and only keep going on exit 1.\n" +
		`A NEW \`### B<n>\` entry takes its id and its claim together, and its slot is not a region yet:\n  ${buildArbiterCommand`alloc-entry ${rel}`}\n`
	);
}

/**
 * @param {string} rel
 * @param {string} region
 * @param {boolean} generator
 * @returns {string|null}
 */
function generatorOnlyRefusal(rel, region, generator) {
	if (generator || !regions.isGeneratorOnlyRegion(rel, region)) return null;
	return (
		`session-arbiter: ${rel}'s §A register tables are derived — rendered whole from ${regions.SIDECAR_PATH} — so \`${region}\` is not a subject to claim by name and no claim was taken.\n` +
		"This is a fatal spelling error, not contention: RETRYING WILL NEVER CLEAR IT.\n" +
		"Editing a register ROW means editing the sidecar key behind it and re-rendering:\n" +
		`  ${buildArbiterCommand`claim ${regions.SIDECAR_PATH}#${regions.ROW_PREFIX}<path>`}\n` +
		`  node ${scriptPath("generate-doc-map-section-a.js")}\n` +
		`Editing §A's own PROSE needs no claim of your own: an Edit or Write anchored in it takes \`${regions.REGISTER_SECTION}\` for you.\n`
	);
}

/** @param {string} rel @returns {string|null} */
function wholeFileRegionWarning(rel) {
	if (!regions.isRegioned(rel)) return null;
	let listing = "";
	let allocatable = false;
	try {
		const text = fs.readFileSync(path.join(store.treeRoot(), rel), "utf8");
		const ids = [...new Set(regions.parseRegions(text, rel).map((r) => r.id))];
		const rows = ids.filter((id) => id.startsWith(regions.ROW_PREFIX));
		const entries = ids
			.filter((id) => /^B\d+$/.test(id))
			.sort((a, b) => idNumber(a) - idNumber(b));
		const sections = ids.filter(
			(id) => !rows.includes(id) && !entries.includes(id),
		);
		const parts = [];
		if (sections.length > 0) parts.push(sections.join(", "));
		if (entries.length > 0)
			parts.push(
				`${entries.length} \`B<n>\` entries, ${entries[0]} to ${entries.at(-1)}`,
			);
		if (rows.length > 0)
			parts.push(
				`${rows.length} \`${regions.ROW_PREFIX}<path>\` register row${rows.length === 1 ? "" : "s"}`,
			);
		if (parts.length > 0) listing = `  Its regions: ${parts.join("; ")}.\n`;
		allocatable = entries.length > 0;
	} catch (e) {
		const { code, message } = caught(e);
		store.logError(
			"region",
			new Error(
				`${rel} could not be read or parsed (${code || message}) — warned without its region list`,
			),
		);
	}
	return (
		`session-arbiter: ${rel} is claimed per region, and this claim names none — so it takes the WHOLE file, and every other session's region claim on it is warned of until you release.\n` +
		listing +
		`  One region instead:\n    ${buildArbiterCommand`claim ${rel}#<region>`}\n` +
		(allocatable
			? `  A NEW \`### B<n>\` entry takes its id and its claim together, and its slot is not a region yet:\n    ${buildArbiterCommand`alloc-entry ${rel}`}\n`
			: "")
	);
}

/**
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {boolean} [generator]
 */
function cmdClaim(filePath, sessionId, generator = false) {
	if (filePath === undefined) return refuseUsage(usageOf("claim"));
	const rel = store.claimKey(filePath);
	if (rel === null || !store.isWatched(rel)) return 0;
	// lucmoseley/mantahostels#1313
	if (refuseClaimSubject(rel, generator)) return 2;
	const me = store.identify(sessionId);
	const { contended, notices } = takeSet([rel], me);
	sayEach(notices.broken);
	sayContended(contended);
	sayEach(
		notices.unchecked.map((r) =>
			buildUncheckedLine(r, "this write is unprotected and no claim was taken"),
		),
	);
	store.recordWrite(filePath, sessionId);
	return 0;
}

/** @param {string} rel @param {boolean} generator */
function refuseClaimSubject(rel, generator) {
	const named = store.splitSubject(rel);
	if (named.region === null) {
		// lucmoseley/mantahostels#1856
		const warning = wholeFileRegionWarning(named.rel);
		if (warning) writeStderr(warning);
		return false;
	}
	const why =
		generatorOnlyRefusal(named.rel, named.region, generator) ||
		buildUnknownRegionReason(named.rel, named.region);
	if (!why) return false;
	writeStderr(why);
	return true;
}

// workflow-core#1631 workflow-core#1635
/** @param {string} text */
function writeStdout(text) {
	writeFd(1, text);
}

/** @param {string} text */
function writeStderr(text) {
	writeFd(2, text);
}

/** @param {(string|null)[]} texts */
function sayEach(texts) {
	for (const text of texts) if (text) writeStderr(`session-arbiter: ${text}\n`);
}

/** @param {string} rel @param {string} consequence */
const buildUncheckedLine = (rel, consequence) =>
	`could not check ${rel} — the file-claim store is unreadable, so ${consequence}. See: node ${scriptPath("check-guard-errors.js")}`;

/** @param {string} verdict */
const isRealClaim = (verdict) =>
	verdict === "claimed" || verdict === "reentrant";

/**
 * @typedef {{rel: string, verdict: string, lock: any}} Acquired
 * @typedef {{broken: string[], unchecked: string[]}} ClaimNotices
 * @param {string[]} rels
 * @param {Identity} me
 * @returns {{rels: string[], taken: Acquired[], contended: Acquired[], notices: ClaimNotices}}
 */
function takeSet(rels, me) {
	const order = [...new Set(rels)].sort();
	/** @type {Acquired[]} */
	const taken = [];
	/** @type {string[]} */
	const broken = [];
	for (const rel of order) {
		const { verdict, lock } = store.acquire(rel, me);
		taken.push({ rel, verdict, lock });
		const notice = store.buildBreakNotice(rel, me.sessionId);
		if (notice) broken.push(notice);
	}
	return {
		rels: order,
		taken,
		contended: taken.filter(
			(t) => t.verdict === "held" && store.isWarned(t.rel),
		),
		notices: {
			broken,
			unchecked: taken
				.filter((t) => t.verdict === "unknown" && store.isWarned(t.rel))
				.map((t) => t.rel),
		},
	};
}

/** @param {Acquired[]} contended */
function sayContended(contended) {
	sayEach(contended.map((c) => buildContendedNotice(c.rel, c.lock)));
}

/** @param {string[]} filePaths @param {string} sessionId */
function cmdClaimAll(filePaths, sessionId) {
	const rels = [
		...new Set(
			/** @type {string[]} */ (
				filePaths
					.map((p) => store.claimKey(p))
					.filter((r) => r !== null && store.isWatched(r))
			),
		),
	].sort();
	if (rels.length === 0) return 0;

	// lucmoseley/mantahostels#1313
	for (const rel of rels) {
		const named = store.splitSubject(rel);
		if (named.region === null) continue;
		const why =
			generatorOnlyRefusal(named.rel, named.region, false) ||
			buildUnknownRegionReason(named.rel, named.region);
		if (why) {
			writeStderr(why);
			return 2;
		}
	}

	for (const rel of rels) {
		const named = store.splitSubject(rel);
		if (named.region !== null) continue;
		const warning = wholeFileRegionWarning(named.rel);
		if (warning) writeStderr(warning);
	}

	const me = store.identify(sessionId);
	const { contended, notices } = takeSet(rels, me);
	sayEach(notices.broken);
	sayContended(contended);
	sayEach(
		notices.unchecked.map((r) =>
			buildUncheckedLine(
				r,
				"no claim was taken on it and this subject is unprotected, though the rest of the set stands",
			),
		),
	);
	for (const rel of rels) store.recordWrite(rel, sessionId);
	return 0;
}

function issueClaimsReading() {
	const listed = store.listIssueClaims();
	return listed && !listed.why ? listed.claims : null;
}

function reportWaits() {
	const wants = store.readWants();
	if (wants === null) {
		writeStderr(
			`session-arbiter: the waiter register could not be read, so whether any session is blocked is unknown — not nothing. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return;
	}
	if (wants.length === 0) return;
	const nameOf = nameResolver();
	const claims = issueClaimsReading();
	const holdsOf = (/** @type {string} */ id) => holdingsOf(claims, id);

	const cycles = waitMod.findCycles(wants, claims);
	const inCycle = new Set(cycles.flat().map((w) => w.sessionId));
	for (const ring of cycles) printDeadlock(ring, nameOf, holdsOf);

	const stranded = wants.filter((w) => !inCycle.has(w.sessionId));
	if (stranded.length === 0) return;
	writeStdout("\n");
	for (const w of stranded) {
		const issue = waitMod.issueOfWant(w.wants);
		if (issue !== null)
			writeStdout(buildIssueWaitLine(w, issue, claims, nameOf));
	}
}

/** @param {IssueClaimRecord[]|null} claims @param {string} id */
function holdingsOf(claims, id) {
	return claims === null
		? ["issue claims UNKNOWN: the issue-claim store could not be read"]
		: claims
				.filter((/** @type {any} */ c) => c.sessionId === id)
				.map((/** @type {any} */ c) => waitMod.issueWant(c.issue));
}

/**
 * @param {WantRecord[]} ring
 * @param {ReturnType<typeof nameResolver>} nameOf
 * @param {(id: string) => string[]} holdsOf
 */
function printDeadlock(ring, nameOf, holdsOf) {
	writeStdout(
		`\nDEADLOCK  ${ring.length} session(s) are waiting on each other. None of them will ever release, so none will finish.\n`,
	);
	for (const w of ring) {
		const held = holdsOf(w.sessionId);
		writeStdout(
			`  ${nameOf(w.sessionId)}\n` +
				`      holds  ${held.length > 0 ? held.join(", ") : "(nothing)"}\n` +
				`      wants  ${w.wants}  (since ${w.since})\n`,
		);
	}
	writeStdout(
		`  Break it: any member releases an issue it claims — ${buildArbiterCommand`release-issue <n>`} — or ends its wait.\n`,
	);
}

/**
 * @param {WantRecord} w
 * @param {number} issue
 * @param {IssueClaimRecord[]|null} claims
 * @param {ReturnType<typeof nameResolver>} nameOf
 */
function buildIssueWaitLine(w, issue, claims, nameOf) {
	const holders = waitMod.issueHolders(claims, issue, w.sessionId);
	if (holders === null)
		return `WAITING  ${nameOf(w.sessionId)} wants ${w.wants} — whether anyone still claims it is UNKNOWN: the issue-claim store could not be read.\n`;
	if (holders.length > 0)
		return `WAITING  ${nameOf(w.sessionId)} wants ${w.wants}, claimed by ${holders.map((c) => nameOf(c.sessionId)).join(", ")}.\n`;
	return `WAITING  ${nameOf(w.sessionId)} wants ${w.wants} — no other session claims it now.\n`;
}

/** @param {string} rel @param {string|null} sessionId */
function readOwnSubjectsOn(rel, sessionId) {
	return (store.readHeldBy(sessionId) ?? []).filter(
		(subject) => store.splitSubject(subject).rel === rel,
	);
}

/**
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {{generator?: boolean, notMine?: boolean}} [opts]
 */
function cmdRelease(filePath, sessionId, opts = {}) {
	if (filePath === undefined) return refuseUsage(usageOf("release"));
	const rel = store.claimKey(filePath);
	if (rel !== null && store.splitSubject(rel).region === null) {
		const held = readOwnSubjectsOn(rel, store.identify(sessionId).sessionId);
		if (held.length > 0) {
			let code = 0;
			for (const subject of held)
				if (releaseSubject(subject, sessionId, opts) !== 0) code = 1;
			return code;
		}
	}
	return releaseSubject(rel, sessionId, opts);
}

/**
 * @param {string|null} filePath
 * @param {string} sessionId
 * @param {{generator?: boolean, notMine?: boolean}} [opts]
 */
function releaseSubject(
	filePath,
	sessionId,
	{ generator = false, notMine = false } = {},
) {
	const rel = filePath === null ? null : store.claimKey(filePath);
	if (rel === null || !store.isReleasable(rel)) return 0;

	const me = store.identify(sessionId);
	const result = store.release(rel, me, { generator, notMine });
	const { verdict } = result;

	/** @type {ReleaseOutcome} */
	const out = { ...result, rel, me };
	const first = RELEASE_FIRST[verdict];
	if (first) return first(out);
	if (out.observed?.state === "changed")
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, out.observed.was, CLOBBER_AT_RELEASE)}\n`,
		);
	const then = RELEASE_THEN[verdict];
	if (then) return then(out);
	return releaseUnproven(out);
}

/** @typedef {ClaimResult & {rel: string, me: Identity}} ReleaseOutcome */

/** @type {Record<string, (o: ReleaseOutcome) => number>} */
const RELEASE_FIRST = {
	released: (o) => {
		writeStdout(`Released ${o.rel}.${buildOthersDirtNote(o.own)}\n`);
		if (o.content?.state === "changed")
			writeStderr(
				`session-arbiter: ${buildClobberNotice(o.rel, o.content.was, CLOBBER_AT_RELEASE)}\n`,
			);
		return 0;
	},
};

/** @type {Record<string, (o: ReleaseOutcome) => number>} */
const RELEASE_THEN = {
	"not-held": (o) => {
		writeStdout(`No claim on ${o.rel}.\n`);
		return 0;
	},
	"held-by-other": (o) => {
		writeStderr(
			`session-arbiter: ${o.rel} is held by session ${describeHolder(o.lock)}, not by this session. ` +
				"Only its holder can release it; a claim you did not take is not yours to drop.\n" +
				(o.observed
					? "This session's own record of what it last wrote there is dropped; the next write takes a fresh one.\n"
					: ""),
		);
		return 1;
	},
	dirty: releaseDirty,
	unreadable: (o) => {
		writeStderr(
			`session-arbiter: could not read the claim store for ${o.rel}, so the claim stands rather than being reported gone (mantahostels#174).\n` +
				`See the fault: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	},
};

// lucmoseley/mantahostels#337
/** @param {ReleaseOutcome} o */
function releaseDirty({ rel, content, own }) {
	if (content?.state === "changed")
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, content.was, CLOBBER_AT_DIRTY_RELEASE)}\n`,
		);
	writeStderr(
		`session-arbiter: ${rel} ${DIRTY_HEADLINE[own ?? "unjudged"]}, so the claim stands.\n` +
			"Releasing a dirty claim hands the next session your unfinished edit to commit under its own message (mantahostels#63). " +
			"Commit or discard the change, then release. Re-claiming is automatic: your next write to it takes the file back.\n" +
			neighbourDirtExit(rel, own),
	);
	return 1;
}

/** @param {string} rel @param {OwnHunks|undefined} own */
function neighbourDirtExit(rel, own) {
	if (own === "unproven") return `${buildNotMineOffer(rel)}\n`;
	if (own === undefined)
		return "Is the dirt a live neighbour's rather than yours? Then leave the claim standing: it is broken automatically once this session's process ends (`breakStale`), so nothing inherits it and there is nothing here to do.\n";
	return "";
}

/** @type {Record<string, string>} */
const DIRTY_HEADLINE = {
	pending:
		"still holds an uncommitted change of this session's own — one HEAD does not have",
	unproven:
		"has uncommitted changes, and nothing here could prove they are all another session's",
	unjudged: "has uncommitted changes",
};

/** @param {string} rel */
function buildNotMineOffer(rel) {
	return `Is every one of them another session's, all of yours already committed? Then \`${buildArbiterCommand`release --not-mine ${rel}`}\` releases it on your word — and a change of yours it could not see goes with the file to the next session (mantahostels#63).`;
}

/** @param {OwnHunks|undefined} own */
function buildOthersDirtNote(own) {
	if (own === "landed")
		return " Every hunk this session wrote has landed; the uncommitted changes left in it are other sessions'.";
	if (own === "unproven")
		return " The uncommitted changes left in it are other sessions', on this session's word (--not-mine).";
	return "";
}

/** @param {ReleaseOutcome} o */
function releaseUnproven({ rel, verdict, content }) {
	if (
		content?.state === "changed" &&
		(verdict === "uncheckable" || verdict === "contended")
	)
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, content.was, CLOBBER_AT_REFUSED_RELEASE)}\n`,
		);
	if (verdict === "uncheckable") {
		writeStderr(
			`session-arbiter: could not read git status for ${rel}, so its cleanliness is unproven and the claim stands.\n`,
		);
		return 1;
	}
	writeStderr(
		`session-arbiter: the claim on ${rel} changed while releasing it; nothing was dropped.\n`,
	);
	return 1;
}

const KEPT_CLAIMS_RETAIN_MS = 30 * DAY_MS;

/**
 * @param {string} sessionId
 * @param {string[]} paths
 * @param {string|null} commit
 */
function cmdReleaseCommitted(sessionId, paths, commit) {
	if (!sessionId) return 0;
	const landed = new Set(
		paths.map((p) => store.claimKey(p)).filter((rel) => rel !== null),
	);
	const me = store.identify(sessionId);
	const held = store.readHeldBy(sessionId);
	if (!held) {
		writeStderr(
			"session-arbiter: could not read the claim store, so nothing was released after this commit; the claims stand (mantahostels#174).\n" +
				`See the fault: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 0;
	}

	const released = [];
	const leftDirty = [];
	const kept = [];
	/** @type {(subject: string, verdict: string, own?: OwnHunks) => void} */
	const logKept = (subject, verdict, own) => {
		appendRetained(
			store.paths.keptClaimsLog(),
			{
				at: new Date().toISOString(),
				path: subject,
				verdict,
				own: own ?? null,
				session: sessionId,
				commit,
			},
			KEPT_CLAIMS_RETAIN_MS,
		);
	};
	for (const subject of held) {
		const { rel, region } = store.splitSubject(subject);
		if (!landed.has(rel)) continue;
		if (region !== null) {
			kept.push(
				`Kept ${subject} — a region claim, which a commit never releases; \`${buildArbiterCommand`release ${subject}`}\` does.\n`,
			);
			logKept(subject, "region");
			continue;
		}
		const result = releaseLanded(rel, me);
		if (result.verdict === "released") {
			released.push(rel);
			if (result.own === "landed") leftDirty.push(rel);
		} else {
			kept.push(buildKeptLine(rel, result));
			logKept(rel, result.verdict, result.own);
		}
	}
	writeStdout(buildCommittedReport(released, leftDirty, kept, landed));
	return 0;
}

/**
 * @param {string[]} released
 * @param {string[]} leftDirty
 * @param {string[]} kept
 * @param {Set<string>} landed
 */
function buildCommittedReport(released, leftDirty, kept, landed) {
	if (released.length === 0 && kept.length === 0)
		return `Released nothing — this session holds no whole-file claim on ${landed.size === 0 ? "any path named" : [...landed].join(", ")}.\n`;
	if (released.length === 0) return kept.join("");
	const dirt =
		leftDirty.length > 0
			? ` Still carrying other sessions' uncommitted changes, none of this session's: ${leftDirty.join(", ")}.`
			: "";
	return `Released ${released.join(", ")} — the commit holding this session's work on ${released.length === 1 ? "it" : "them"} has landed.${dirt}\n${kept.join("")}`;
}

/** @param {string} rel @param {Identity} me @returns {ClaimResult} */
function releaseLanded(rel, me) {
	const result = store.release(rel, me);
	const { verdict, content, observed } = result;
	const closing =
		verdict === "released" ? CLOBBER_AT_RELEASE : CLOBBER_AT_COMMITTED_REFUSAL;
	if (content?.state === "changed" && content.was)
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, content.was, closing)}\n`,
		);
	else if (observed?.state === "changed")
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, observed.was, CLOBBER_AT_RELEASE)}\n`,
		);

	return result;
}

/** @param {string} rel @param {ClaimResult} result */
function buildKeptLine(rel, { verdict, own }) {
	if (verdict === "dirty" && own === "pending")
		return `Kept ${rel} — an uncommitted change of this session's own is still in it; the commit that lands it releases the claim.\n`;
	if (verdict === "dirty")
		return `Kept ${rel} — it carries uncommitted changes, and nothing here could prove they are all another session's. ${buildNotMineOffer(rel)}\n`;
	const why = {
		uncheckable: "git could not say whether it is clean",
		contended: "the claim changed while releasing it",
		unreadable: "the claim store would not read",
	}[verdict];
	return `Kept ${rel} — ${why ?? `the release answered ${verdict}`}.\n`;
}

/**
 * @param {string|undefined} filePath
 * @param {string} sessionId
 */
function cmdRecord(filePath, sessionId) {
	toolRecord.recordToolWrite(filePath, sessionId);
	return 0;
}

/** @param {string} sessionId */
function cmdRefresh(sessionId) {
	toolRecord.refreshAfterBash(sessionId);
	return 0;
}

/** @param {string} sessionId @param {boolean} committed */
function cmdWrites(sessionId, committed) {
	const paths = committed
		? store.readBilledPathsBy(sessionId, "writes --committed")
		: store.readWritesBy(sessionId);
	if (paths === null) return 1;
	for (const rel of paths) writeStdout(`${rel}\n`);
	return 0;
}

/**
 * @param {string|undefined} from
 * @param {string|undefined} to
 * @param {string} sessionId
 */
function cmdOwnPaths(from, to, sessionId) {
	if (!from || !to) return refuseUsage(usageOf("own-paths"));
	if (!FULL_SHA.test(from) || !FULL_SHA.test(to)) {
		writeStderr("session-arbiter: own-paths takes two full shas.\n");
		return 2;
	}
	const own = readOwnPaths(store.paths.repoRoot(), from, {
		sessionId,
		tip: to,
		byPatch: true,
	});
	if (own === null) return 1;
	for (const rel of own.paths) writeStdout(`${rel}\n`);
	return 0;
}

/** @param {string|undefined} commit @param {string} sessionId */
function cmdRecordCommit(commit, sessionId) {
	if (!commit) return refuseUsage(usageOf("record-commit"));
	if (!sessionId) return 0;
	try {
		store.recordCommit(commit, sessionId);
	} catch (e) {
		store.logError("record commit", e);
	}
	return 0;
}

/** @param {string|undefined} filePath @param {string} sessionId */
function cmdVersions(filePath, sessionId) {
	if (filePath === undefined) return refuseUsage(usageOf("versions"));
	const rel = store.claimKey(filePath);
	if (rel === null) {
		writeStderr(`session-arbiter: ${filePath} is not in this repo\n`);
		return 2;
	}
	const held = store.claimVersions(rel);
	const observed = store.observedVersions(rel, sessionId);

	const unreadable = sayUnreadableRecords(rel, held, observed);
	const heldOk = held?.unreadable ? null : held;
	const observedOk = observed?.unreadable ? null : observed;

	if (!held && !observed) {
		writeStdout(`No claim on ${rel}, so no versions are recorded.\n`);
		return 0;
	}

	if (heldOk && heldOk.versions.length === 0)
		writeStdout(
			`${rel} is claimed by ${describeHolder(heldOk.lock)}, but the claim recorded no version.\n`,
		);
	else if (heldOk)
		printVersions(
			rel,
			`claimed by ${describeHolder(heldOk.lock)}`,
			heldOk.versions,
		);
	if (observedOk)
		printVersions(
			rel,
			"last written by THIS session, against no claim of its own (mantahostels#2333)",
			observedOk.versions,
		);
	return unreadable ? 1 : 0;
}

/**
 * @param {string} rel
 * @param {ReturnType<typeof store.claimVersions>} held
 * @param {ReturnType<typeof store.observedVersions>} observed
 */
function sayUnreadableRecords(rel, held, observed) {
	let unreadable = false;
	for (const [whose, r] of /** @type {const} */ ([
		["claim", held],
		["observation", observed],
	])) {
		if (!r?.unreadable) continue;
		unreadable = true;
		const act =
			r.reason === "refused"
				? `  Check its permissions (ls -l ${shellQuote(r.file)}) and re-run. See: node ${scriptPath("check-guard-errors.js")}\n`
				: `  Its bytes are still there — cat ${shellQuote(r.file)} and read the sha out of "blob":"<sha>",\n  then: git cat-file -p <sha> > /tmp/recovered\n`;
		writeStdout(
			`The ${whose} record for ${rel} WOULD NOT READ (${r.reason}) — ${r.file}\n` +
				"  Any versions it holds are NOT shown below. This is a fault, not an absence.\n" +
				act,
		);
	}
	return unreadable;
}

/**
 * @param {string} rel
 * @param {string} whose
 * @param {{sha: string, at: string|null, gone: boolean}[]} versions
 */
function printVersions(rel, whose, versions) {
	writeStdout(`${rel}, ${whose} — newest first:\n`);
	for (const [i, v] of versions.entries()) {
		const when =
			i === 0 ? "current" : `replaced ${v.at ?? "at an unknown time"}`;
		writeStdout(
			v.gone
				? `  ${v.sha}  (${when})  GONE — git no longer has this object\n`
				: `  ${v.sha}  (${when})\n    git cat-file -p ${v.sha} > /tmp/recovered\n`,
		);
	}
}

/** @param {string} usage */
function refuseUsage(usage) {
	writeStderr(`${usage}\n`);
	return 2;
}

/** @param {string|undefined} issue */
function refuseIssue(issue) {
	writeStderr(
		`session-arbiter: ${issue ?? "(no issue)"} is not an issue number\n`,
	);
	return 2;
}

/** @param {string|undefined} issue @param {string} sessionId */
function cmdClaimIssue(issue, sessionId) {
	if (issue === undefined) return refuseIssue(issue);
	const me = store.identify(sessionId);
	const { status } = store.claimIssue(issue, me);
	if (status === "invalid") return refuseIssue(issue);
	if (status === "claimed") {
		writeStdout(
			`Recorded #${issue} as claimed by session ${nameSession(me.sessionId)}.\n`,
		);
		return 0;
	}
	writeStderr(
		status === "unidentified"
			? "session-arbiter: no session id, so #" +
					`${issue} was not recorded — it stays selectable in pick-next.\n`
			: `session-arbiter: could not record the claim on #${issue} — it stays selectable in pick-next. See: node ${scriptPath("check-guard-errors.js")}\n`,
	);
	return 0;
}

// guess, workflow-core#4535
const UNIT_READ_MS = 10_000;

/** @param {number} n @param {string|null} sid @returns {string|null} */
function heldUnitRefusal(n, sid) {
	if (!sid || !store.readClaimedIssues(sid).includes(n)) return null;
	const heldUnit = require("./lib/held-unit.js");
	if (require("./lib/parked.js").readParkedBlockedIssue(sid) === n) return null;
	if (!heldUnit.isCitedByOwnCommit(sid, n)) return null;
	const tracker = require("./lib/outstanding-line.js").trackerOf();
	if (!tracker) return null;
	try {
		if (!heldUnit.isUnfinishedUnitIn(tracker, n, { timeout: UNIT_READ_MS }))
			return null;
	} catch (e) {
		store.logError(`release-issue ${n} read`, e);
		writeStderr(
			`session-arbiter: #${n} would not read, so whether it is an unfinished build unit went unchecked.\n`,
		);
		return null;
	}
	return `session-arbiter: refusing to release #${n}: it is ${heldUnit.UNFINISHED} (workflow-core#4495, workflow-core#4991). No ticket comment or body note moves a unit's boundary. Finish it and close it with ${scriptPath("resolve-ticket.js")}, which releases the claim itself; or leave it by one of the four exits: ${heldUnit.EXITS}.\n`;
}

/** @param {string|undefined} issue @param {string} sessionId */
function cmdReleaseIssue(issue, sessionId) {
	if (issue === undefined) return refuseIssue(issue);
	const me = store.identify(sessionId);
	const n = Number(issue);
	const refusal = Number.isInteger(n) ? heldUnitRefusal(n, me.sessionId) : null;
	if (refusal) {
		writeStderr(refusal);
		return 2;
	}
	const { status } = store.releaseIssue(issue, me);
	if (status === "invalid") return refuseIssue(issue);
	if (status === "released") {
		writeStdout(`Released the claim on #${issue}.\n`);
		return 0;
	}
	if (status === "none") {
		writeStdout(`No claim of this session's on #${issue}.\n`);
		return 0;
	}
	writeStderr(
		status === "unidentified"
			? `session-arbiter: no session id, so no claim on #${issue} could be identified as this session's\n`
			: `session-arbiter: could not drop the claim on #${issue}, so it still stands. See: node ${scriptPath("check-guard-errors.js")}\n`,
	);
	return 1;
}

/**
 * @param {string|undefined} issue
 * @param {string|undefined} to
 * @param {string} sessionId
 */
function cmdMoveIssue(issue, to, sessionId) {
	if (issue === undefined) return refuseIssue(issue);
	if (!to) {
		writeStderr(
			"session-arbiter: move-issue needs the session to move the claim to\n",
		);
		return 2;
	}
	const me = store.identify(sessionId);
	const n = Number(issue);
	if (!me.sessionId || !store.readClaimedIssues(me.sessionId).includes(n)) {
		writeStdout(`No claim of this session's on #${issue}.\n`);
		return 0;
	}
	const live = require("./lib/arbiter-core.js").readLiveSessionIds();
	const refusal =
		live && !live.has(to) ? heldUnitRefusal(n, me.sessionId) : null;
	if (refusal) {
		writeStderr(
			`session-arbiter: session ${to} is not running, so moving the claim to it would drop it. ${refusal.replace(/^session-arbiter: /, "")}`,
		);
		return 2;
	}
	const claimed = store.claimIssue(issue, { sessionId: to });
	if (claimed.status !== "claimed") {
		writeStderr(
			`session-arbiter: could not record #${issue}'s claim for session ${to}, so this session's still stands. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	const { status } = store.releaseIssue(issue, me);
	if (status === "released" || status === "none") {
		writeStdout(`Moved the claim on #${issue} to session ${to}.\n`);
		return 0;
	}
	writeStderr(
		`session-arbiter: #${issue} is claimed for session ${to}, but this session's claim could not be dropped, so it stands too. See: node ${scriptPath("check-guard-errors.js")}\n`,
	);
	return 1;
}

function cmdIssueClaims() {
	const listed = store.listIssueClaims();
	if (listed === null) {
		writeStderr(
			`session-arbiter: could not read the issue-claim store at ${store.paths.issueClaimsDir()}, so what is claimed is unknown — not nothing.\n` +
				`See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	if (listed.why)
		writeStderr(
			`session-arbiter: ${listed.why}.\nSee: node ${scriptPath("check-guard-errors.js")}\n`,
		);
	const claims = listed.claims;
	if (claims.length === 0) {
		writeStdout("No issues are claimed.\n");
		return listed.why ? 1 : 0;
	}
	for (const c of claims.sort((a, b) => a.issue - b.issue))
		writeStdout(
			`#${c.issue}\t${nameSession(c.sessionId)}\tsince ${c.claimedAt}\n`,
		);
	return listed.why ? 1 : 0;
}

const WAIT_EXIT = {
	RELEASED: 0,
	"NOT-HELD": 4,
	CEILING: 5,
	"HOLDER-ENDED": 6,
	DEADLOCK: 7,
};

// workflow-core#542 guess
const WAIT_ORACLE_EVERY_S = 30;

// workflow-core#535 guess
const WAIT_CEILING_S = 30 * 60;

// workflow-core#540 guess
const WAIT_POLL_S = Number(process.env.WFC_ARBITER_WAIT_POLL_S) || 2;

/**
 * @typedef {object} WaitRun
 * @property {number} issue
 * @property {string} subject
 * @property {number} ceiling
 * @property {Identity} me
 * @property {string} myId
 * @property {IssueClaimRecord|null} holder
 * @property {number} oracleDue
 * @property {string|null} oracleDoubt
 */

/** @typedef {{held?: IssueClaimRecord, free?: null, doubt?: string, fault?: boolean, holders?: IssueClaimRecord[], claims?: IssueClaimRecord[]}} WaitPoll */

/**
 * @param {string[]} argv
 * @returns {{code: number} | {issue: number, subject: string, ceiling: number}}
 */
function waitTarget(argv) {
	const [target, ceilingArg, ...extra] = argv;
	const ceiling =
		ceilingArg === undefined ? WAIT_CEILING_S : Number(ceilingArg);
	if (
		!target ||
		extra.length > 0 ||
		!(ceiling > 0 && Number.isFinite(ceiling))
	) {
		writeStderr(`${usageOf("wait")}\n`);
		return { code: 2 };
	}
	if (!/^[1-9]\d*$/.test(target)) {
		writeStderr(
			`session-arbiter: ${target} is not an issue number — wait takes one.\n${usageOf("wait")}\n`,
		);
		return { code: 2 };
	}
	const issue = Number(target);
	return { issue, subject: waitMod.issueWant(issue), ceiling };
}

/**
 * @param {WaitRun} w
 * @param {import("./lib/arbiter-wait.js").Verdict} verdict
 * @param {string} text
 */
function waitSay(w, verdict, text) {
	writeStdout(`${verdict}  ${w.subject} — ${text}\n`);
	return WAIT_EXIT[verdict];
}

/** @param {WaitRun} w @returns {WaitPoll} */
function pollWait(w) {
	const claims = issueClaimsReading();
	const holders = waitMod.issueHolders(claims, w.issue, w.myId);
	if (claims === null || holders === null)
		return {
			doubt: "the issue-claim store could not be read",
			fault: true,
		};
	return holders.length > 0
		? { held: holders[0], holders, claims }
		: { free: null };
}

/** @param {IssueClaimRecord|null} h */
function buildWaitHolderText(h) {
	if (!h?.sessionId) return "a holder that could not be identified";
	return describeSession(h.sessionId, holderNames().get(h.sessionId) || null);
}

/** @param {string} myId */
function readOwnWantOf(myId) {
	const wants = store.readWants();
	if (wants === null) return;
	return wants.find((x) => x.sessionId === myId)?.wants ?? null;
}

/** @param {WaitRun} w */
function recordWaitWant(w) {
	store.recordWant(w.subject, w.me);
}

/** @param {WaitRun} w */
function dropWaitWant(w) {
	const own = readOwnWantOf(w.myId);
	if (own === w.subject || own === undefined) store.dropWant(w.myId);
}

/** @param {WaitRun} w */
function dropWantOnSignal(w) {
	for (const [sig, code] of Object.entries({
		SIGHUP: 129,
		SIGINT: 130,
		SIGTERM: 143,
	}))
		process.on(sig, () => {
			dropWaitWant(w);
			process.exit(code);
		});
}

/** @param {WaitRun} w @param {WaitPoll} s */
function ringThroughMe(w, s) {
	const wants = store.readWants();
	if (!wants) return null;
	const cycles = waitMod.findCycles(wants, s.claims ?? issueClaimsReading());
	return waitMod.ringThrough(cycles, w.myId);
}

/** @param {{sessionId: string, wants: string}[]} ring @param {string} myId */
function deadlockChain(ring, myId) {
	const nameOf = nameResolver();
	const at = ring.findIndex((x) => x.sessionId === myId);
	return [...ring.slice(at), ...ring.slice(0, at)]
		.map((x) => `${nameOf(x.sessionId)} wants ${x.wants}`)
		.join(" -> ");
}

/** @param {WaitRun} w @param {WaitPoll} poll */
function readOracle(w, poll) {
	w.oracleDue = Date.now() + WAIT_ORACLE_EVERY_S * 1000;
	const shared = relistSessions(sharedSessionIds);
	const holders = poll.holders ?? (poll.held ? [poll.held] : []);
	const ended =
		holders.length > 0 &&
		holders.every(
			(h) => h.sessionId !== null && shared.terminal?.has(h.sessionId),
		);
	const listed = ended ? relistSessions(listedSessionIds) : shared;
	w.oracleDoubt = listed.why ?? null;
	return listed.terminal;
}

/** @param {WaitRun} w @param {WaitPoll} state */
function buildCeilingText(w, state) {
	const doubt =
		(state.doubt
			? ` Whether it is still held is UNKNOWN at the last read: ${state.doubt}.`
			: "") +
		(w.oracleDoubt
			? ` Whether its session has ended is UNKNOWN: ${w.oracleDoubt}`
			: "");
	return `still held by ${buildWaitHolderText(w.holder)} after ${w.ceiling}s.${doubt} Next: carry on with other work.`;
}

/** @type {Record<import("./lib/arbiter-wait.js").Verdict, (w: WaitRun, state: WaitPoll, ring: WantRecord[]) => string>} */
const VERDICT_TEXT = {
	"NOT-HELD": () => "no other session claims it.",
	RELEASED: (w) => `${buildWaitHolderText(w.holder)} released its claim.`,
	DEADLOCK: (w, _state, ring) =>
		`${deadlockChain(ring, w.myId)} -> held by you. Each waits on the next, so none will release. Next: release the issue you hold — ${buildArbiterCommand`release-issue <n>`} — then wait again.`,
	"HOLDER-ENDED": (w) =>
		`${buildWaitHolderText(w.holder)} has ended, so its claim is stale and nothing will release it. Next: treat the issue as unclaimed.`,
	CEILING: buildCeilingText,
};

/**
 * @param {WaitRun} w
 * @param {WaitPoll} state
 * @param {{verdict: import("./lib/arbiter-wait.js").Verdict, ring?: WantRecord[]}} v
 */
function sayVerdict(w, state, v) {
	return waitSay(w, v.verdict, VERDICT_TEXT[v.verdict](w, state, v.ring ?? []));
}

/** @param {WaitRun} w @returns {Promise<number>} */
async function waitLoop(w) {
	const deadline = Date.now() + w.ceiling * 1000;
	for (;;) {
		const pause = Math.min(WAIT_POLL_S * 1000, deadline - Date.now());
		await new Promise((r) => setTimeout(r, Math.max(0, pause)));
		const poll = pollWait(w);
		if (poll.held) w.holder = poll.held;
		if (poll.free === undefined && readOwnWantOf(w.myId) === null)
			recordWaitWant(w);
		const v = waitMod.nextVerdict({
			poll,
			ring: () => ringThroughMe(w, poll),
			terminal:
				Date.now() < w.oracleDue ? undefined : () => readOracle(w, poll),
			left: () => deadline - Date.now(),
		});
		if (v) return sayVerdict(w, poll, v);
	}
}

/**
 * @param {string[]} argv
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
async function cmdWait(argv, sessionId) {
	const target = waitTarget(argv);
	if ("code" in target) return target.code;
	const me = store.identify(sessionId);
	const myId = me.sessionId;
	if (!myId) {
		writeStderr(
			"session-arbiter: no session id, so this session's own claims cannot be told from a neighbour's — not waiting.\n",
		);
		return 1;
	}
	/** @type {WaitRun} */
	const w = {
		...target,
		me,
		myId,
		holder: null,
		oracleDue: 0,
		oracleDoubt: null,
	};

	const state = pollWait(w);
	if (state.fault) {
		writeStderr(
			`session-arbiter: ${state.doubt}, so who holds ${w.subject} is unknown — not nothing (mantahostels#174). Not waiting. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	const first = waitMod.nextVerdict({ poll: state, first: true });
	if (first) return sayVerdict(w, state, first);

	w.holder = state.held ?? null;
	dropWantOnSignal(w);
	recordWaitWant(w);
	try {
		return await waitLoop(w);
	} finally {
		dropWaitWant(w);
	}
}

// lucmoseley/mantahostels#2774
/**
 * @param {{alive?: boolean, sessionId?: string|null}} lock
 * @param {Set<string> | undefined} terminal
 */
function holderLabel(lock, terminal) {
	if (!lock.alive) return "STALE";
	if (lock.sessionId && terminal?.has(lock.sessionId)) return "ENDED";
	return "HELD ";
}

/** @param {string} subject */
function regionMarker(subject) {
	const { rel, region } = store.splitSubject(subject);
	return region === null
		? ""
		: `\tONE REGION (${region}) of ${rel} — its other regions are free`;
}

/** @param {boolean} all */
function cmdList(all = false) {
	const { locks: held, registryUnreadable } = store.listLocksJudged();
	if (held === null) {
		writeStderr(
			`session-arbiter: could not read the lock store at ${store.paths.locksDir()}, so what is held is unknown — not nothing.\n` +
				`See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	if (held.length === 0) {
		writeStdout("No files are claimed.\n");
		reportWaits();
		return 0;
	}
	const shown = all ? held : held.filter((l) => l.unreadable || l.alive);
	const hidden = held.length - shown.length;
	// lucmoseley/mantahostels#174
	if (hidden)
		writeStdout(
			`${hidden} stale claim(s) hidden — ${buildArbiterCommand`list --all`}\n`,
		);
	if (registryUnreadable)
		writeStdout(
			`The sessions registry could not be read, so a claim judged STALE may be a live holder resumed onto a fresh process — including one this view has hidden. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
	if (shown.length === 0)
		writeStdout("No files are claimed by a live session.\n");
	const terminal = shown.length > 0 ? holderTerminal() : undefined;
	for (const l of shown) {
		writeStdout(
			l.unreadable
				? `?????  (unreadable lock file ${l.file})\n`
				: `${holderLabel(l, terminal)}  ${l.path}\t${describeHolder(l)}${regionMarker(l.path)}\n`,
		);
	}
	reportWaits();
	return 0;
}

/** @param {string} rel */
function readHighWaterMarkFor(rel) {
	const file = path.join(
		store.treeRoot(),
		path.dirname(rel),
		DATA_FILES.highWater,
	);
	try {
		const mark = parseHighWaterMark(fs.readFileSync(file, "utf8"));
		if (mark !== null) return mark;
		writeStderr(
			`session-arbiter: ${file} holds no \`highWaterMark\`, so the id below may be one a removed entry held; check-doc-map.js will refuse it if so.\n`,
		);
	} catch (e) {
		const { code, message } = caught(e);
		writeStderr(
			code === "ENOENT"
				? `session-arbiter: ${file} is missing, so the id below may be one a removed entry held, and check-doc-map.js reads the map BROKEN until it exists. ${HIGH_WATER_MARK_REMEDY}\n`
				: `session-arbiter: ${file} could not be read (${code || message}), so the id below may be one a removed entry held; check-doc-map.js will refuse it if so.\n`,
		);
	}
	return 0;
}

/** @param {string|undefined} filePath @param {string} sessionId */
function cmdAllocEntry(filePath, sessionId) {
	const rel = store.claimKey(filePath || "docs/doc-map.md");
	if (rel === null || !regions.isRegioned(rel)) {
		writeStderr(
			`session-arbiter: ${filePath} takes no per-entry claim, so there is no id to allocate. Only docs/doc-map.md does (mantahostels#848).\n`,
		);
		return 2;
	}

	let text;
	try {
		text = fs.readFileSync(path.join(store.treeRoot(), rel), "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		writeStderr(
			`session-arbiter: could not read ${rel} (${code || message}), so the next free id is unknown. Nothing was claimed.\n`,
		);
		return 1;
	}

	const me = store.identify(sessionId);
	const first = regions.nextEntryNumber(text, readHighWaterMarkFor(rel));
	let n = first;
	for (let tries = 0; tries < 64; tries++, n++) {
		const subject = store.subjectFor(rel, `B${n}`);
		const { taken, notices } = takeSet([subject], me);
		const [t] = taken;
		if (!t) throw new Error(`takeSet took nothing of ${subject}`);
		const { verdict, lock } = t;
		sayEach(notices.broken);
		if (isRealClaim(verdict)) {
			writeStdout(`B${n}\n`);
			writeStderr(
				`session-arbiter: B${n} is yours — the append slot is claimed, so write the entry as \`### B${n} · <title>\` and release it when the commit lands:\n  ${buildArbiterCommand`release ${subject}`}\n`,
			);
			return 0;
		}
		if (verdict === "unknown") {
			writeStderr(
				`session-arbiter: the claim store is unreadable, so no id can be allocated without risking a duplicate — and a duplicate \`### B<n>\` cannot be renumbered away (mantahostels#892). See: node ${scriptPath("check-guard-errors.js")}\n`,
			);
			return 1;
		}
		if (lock && store.splitSubject(lock.path).region === null) {
			writeStderr(
				`session-arbiter: no id can be allocated — ${rel} is held whole by session ${describeHolder(lock)}, so every append slot in it is covered.\n` +
					`Try again once that session releases it or ends: ${buildArbiterCommand`list`}\n`,
			);
			return 1;
		}
	}
	writeStderr(
		`session-arbiter: B${first}..B${n - 1} are all claimed by live sessions. Nothing was allocated; try again once one of them lands: ${buildArbiterCommand`list`}\n`,
	);
	return 1;
}

/** @param {string[]} lines */
const buildUsage = (lines) =>
	lines
		.map((l, i) => `${i ? "      " : "usage:"} session-arbiter.js ${l}`)
		.join("\n");

// workflow-core#1137
/** @type {Record<string, string>} */
const PASS_THROUGH = {
	check: "check <path> [session-id] [<anchor> <anchor-length> <new-ids>]",
	record: "record <path> [session-id]",
	"release-committed": "release-committed [--commit <sha>] <path> [<path>...]",
};

/** @typedef {{ line: string, flags?: Record<string, "boolean" | "value">, max?: number }} Form */

/** @satisfies {Record<string, Form>} */
const COMMANDS = {
	claim: {
		line: "claim <path> [session-id] [--generator]",
		flags: { "--generator": "boolean" },
		max: 2,
	},
	"claim-all": {
		line: "claim-all <path> [<path>...]",
		max: Number.POSITIVE_INFINITY,
	},
	release: {
		line: "release [--generator] [--not-mine] <path>",
		flags: {
			"--generator": "boolean",
			"--not-mine": "boolean",
		},
		max: 1,
	},
	"claim-issue": { line: "claim-issue <issue-number>", max: 1 },
	"release-issue": { line: "release-issue <issue-number>", max: 1 },
	"move-issue": { line: "move-issue <issue-number> <session-id>", max: 2 },
	"issue-claims": { line: "issue-claims" },
	wait: { line: "wait <issue-number> [ceiling-seconds]", max: 2 },
	refresh: { line: "refresh [session-id]", max: 1 },
	writes: {
		line: "writes [session-id] [--committed]",
		flags: { "--committed": "boolean" },
		max: 1,
	},
	"own-paths": {
		line: "own-paths <from-sha> <to-sha> [session-id]",
		max: 3,
	},
	"record-commit": { line: "record-commit <commit>", max: 1 },
	list: { line: "list [--all]", flags: { "--all": "boolean" } },
	versions: { line: "versions <path>", max: 1 },
	"alloc-entry": { line: "alloc-entry [docs/doc-map.md]", max: 1 },
	"prune-markers": {
		line: "prune-markers [--detach] [--spare <session-id>]",
		flags: { "--detach": "boolean", "--spare": "value" },
	},
};

/** @param {keyof typeof COMMANDS} name */
const usageOf = (name) => buildUsage([COMMANDS[name].line]);

/**
 * @param {Record<string, Form>} forms
 * @returns {Record<string, import("./lib/cli-args").CommandSpec>}
 */
const buildSpecs = (forms) =>
	Object.fromEntries(
		Object.entries(forms).map(([name, { line, flags = {}, max = 0 }]) => [
			name,
			{ usage: buildUsage([line]), flags, max },
		]),
	);

/** @param {Record<string, Form>} forms */
const linesOf = (forms) => Object.values(forms).map((f) => f.line);

const USAGE = buildUsage([
	...Object.values(PASS_THROUGH),
	...linesOf(COMMANDS),
]);
const CLI = { usage: USAGE, commands: buildSpecs(COMMANDS) };

function refuseUnhandled() {
	writeStderr(`${USAGE}\n`);
	return 2;
}

/** @param {unknown} detach @param {unknown} spare */
function cmdPruneMarkers(detach, spare) {
	if (detach) return detachPrune();
	const starter = typeof spare === "string" ? spare : undefined;
	recordRun(JOB_PRUNE_MARKERS, () =>
		store.pruneAll(() => sweepSessionIds(undefined, starter)),
	);
	return 0;
}

/** @param {string[]} argv */
function main(argv) {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID || "";
	const [command] = argv;
	if (command !== undefined && Object.hasOwn(PASS_THROUGH, command))
		return passThrough(argv, sessionId);

	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const { flags, positionals: rest } = parsed;

	switch (parsed.command) {
		case "claim":
			return cmdClaim(
				rest[0],
				rest[1] || sessionId,
				flags["--generator"] === true,
			);
		case "claim-all":
			return cmdClaimAll(rest, sessionId);
		case "release":
			return cmdRelease(rest[0], sessionId, {
				generator: flags["--generator"] === true,
				notMine: flags["--not-mine"] === true,
			});
		case "claim-issue":
			return cmdClaimIssue(rest[0], sessionId);
		case "release-issue":
			return cmdReleaseIssue(rest[0], sessionId);
		case "move-issue":
			return cmdMoveIssue(rest[0], rest[1], sessionId);
		case "issue-claims":
			return cmdIssueClaims();
		case "wait":
			return cmdWait(rest, sessionId);
		case "refresh":
			return cmdRefresh(rest[0] || sessionId);
		case "writes":
			return cmdWrites(rest[0] || sessionId, flags["--committed"] === true);
		case "own-paths":
			return cmdOwnPaths(rest[0], rest[1], rest[2] || sessionId);
		case "record-commit":
			return cmdRecordCommit(rest[0], sessionId);
		case "list":
			return cmdList(flags["--all"] === true);
		case "versions":
			return cmdVersions(rest[0], sessionId);
		case "prune-markers":
			return cmdPruneMarkers(flags["--detach"], flags["--spare"]);
		case "alloc-entry":
			return cmdAllocEntry(rest[0], sessionId);
	}
	return refuseUnhandled();
}

/**
 * @param {string[]} argv
 * @param {string} sessionId
 */
function passThrough(argv, sessionId) {
	const [command, ...rest] = argv;
	switch (command) {
		case "check":
			cmdCheck(rest[0], rest[1] || sessionId, {
				anchor: rest[2],
				anchorLength: rest[3],
				newIds: rest[4],
			});
			return 0;
		case "release-committed":
			return rest[0] === "--commit" && FULL_SHA.test(rest[1] ?? "")
				? cmdReleaseCommitted(sessionId, rest.slice(2), rest[1] ?? null)
				: cmdReleaseCommitted(sessionId, rest, null);
		case "record":
			return cmdRecord(rest[0], rest[1] || sessionId);
	}
	return refuseUnhandled();
}

/** @param {string[]} argv @returns {number|Promise<number>} */
function runCli(argv) {
	// workflow-core#5208
	forgetListed();
	try {
		return main(argv);
	} catch (e) {
		store.logError(argv.join(" "), e);
		return 0;
	}
}

/** @param {{ cwd: string, env: NodeJS.ProcessEnv, args: string[] }} io */
const PROGRAM = (io) => {
	if (io.args[0] === "wait")
		throw new Error("session-arbiter.js wait runs in its own process.");
	return runProgram(io, () => /** @type {number} */ (runCli(io.args)));
};

module.exports = { PROGRAM };

if (require.main === module) {
	const argv = process.argv.slice(2);
	const code = runCli(argv);
	if (typeof code === "number") process.exit(code);
	else
		code.then(
			(c) => process.exit(c),
			(/** @type {unknown} */ e) => {
				store.logError(argv.join(" "), e);
				process.exit(1);
			},
		);
}
