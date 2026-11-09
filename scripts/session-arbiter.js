#!/usr/bin/env node
/*
 * session-arbiter.js — the file-claim CLI.
 *
 * THE SUBCOMMANDS ARE THE WHOLE PRODUCTION INTERFACE (mantahostels#158).
 * This file exports NOTHING. lib/file-claim.js calls `check`,
 * concision-backstop.sh calls `writes`, lib/code-signal.sh calls `own-paths`,
 * settings.json calls `prune-markers --detach`, lib/resume-io.js calls
 * `move-issue`, and a session calls `release` and `wait` (#540) for itself; .husky/post-commit calls
 * `release-committed` and `record-commit`.
 *
 * What is left here is POLICY and PRESENTATION: which store operation a
 * subcommand runs, what it prints, and what it exits with.
 *
 * WHAT A CLAIM IS (mantahostels#99). A file is taken because a live session *wrote* it, not
 * because anyone declared an intent. The claim runs from the first write until
 * the holder releases it, its own commit lands all its hunks (#2058, #2148), or its
 * process ends. A clean tree alone never ends it: a file reads clean between one
 * session's own writes (mantahostels#66, an incident in its closing comment —
 * its title names other work).
 *
 * RELEASE IS THE SECOND EXIT, AFTER PROCESS DEATH (mantahostels#121).
 * `release` drops a claim the caller holds, and only if the path is provably
 * clean — releasing a dirty file hands the next claimant the holder's unfinished
 * edit to commit by pathspec (mantahostels#63 by a new route). It is not inferred from
 * anything: no idle release (mantahostels#411, which carries why `idle` is not liveness),
 * no timeout under any name (mantahostels#104), and never from a clean tree alone (mantahostels#99).
 *
 * CHECK AND CLAIM ARE ONE OPERATION (mantahostels#103 §3). The entry is created by hard-
 * linking a temp file into place, which fails when the target exists.
 *
 * NO UNCONFIRMED-CLAIM EXPIRY — ruled on mantahostels#113. A PreToolUse claim followed by no
 * write (declined prompt, tool error) holds a file its session never touched. It
 * is not given a timeout: any expiry is the timeout mantahostels#104 rejected wearing another
 * name, and it would fire on precisely the long tool calls.
 *
 * IMPLICIT:  wired at SessionStart as `prune-markers --detach`, which launches a detached `prune-markers` as no session's process, naming this session as its report owner, in a systemd user scope of its own stopped after 45 minutes where a user manager answers (#4706), and returns at once; that child sweeps EVERY session's expired markers, breaks, observations, snapshots, pinned blob refs, wants and issue claims — not just this session's.
 * JUSTIFIED: fail-safe — each record pins a git blob open, so an unswept store grows without bound; a run that cannot tell live from finished deletes nothing.
 * DEFEAT:    `--detach` is the registration's only flag and changes who runs the sweep, never what it sweeps; the sweep always exits 0.
 * TREE:      host — every record it sweeps is the host root's store.
 */

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
const { caught } = require("./lib/caught.js");
const { envelope } = require("./lib/hook-envelope.js");
const { readOwnPaths } = require("./lib/own-work.js");
const { FULL_SHA } = require("./lib/commit-sha.js");
const { appendRetained, DAY_MS } = require("./lib/retained-jsonl.js");

/* How this CLI's own output names it, at the plugin root in an install (#1110). */

/**
 * Launch a `prune-markers` of our own through the outliving launch, and return
 * 0 at once (mantahostels#1899, #4706): in a session of its own, so a harness
 * that kills the hook's process group on timeout does not take the sweep
 * mid-pass, and outside this session's scope, so a short session's end does
 * not either.
 *
 * Never throws and never waits: a session start must not break, or block, on
 * housekeeping nothing in it reads.
 *
 * The hook always succeeds, so the child's own completion record is the only
 * thing that says the sweep ran: `prune-markers` files one through
 * lib/detached-run.js, and check-hook-liveness.js reports a row that opened and
 * never closed (mantahostels#1910). Nothing here waits to find out.
 * @returns {number}
 */
function detachPrune() {
	try {
		const { spawnOutliving } = require("./lib/user-scope.js");
		const child = spawnOutliving(
			process.execPath,
			[__filename, "prune-markers"],
			{ stdio: "ignore" },
		);
		child.unref();
		/* An ENOENT on the spawn itself surfaces asynchronously, so it is caught
		 * here rather than by the try above — and swallowed, for the same reason
		 * the sweep's own faults are: nothing waits on this. */
		child.on("error", () => {
			/* nothing waits on the sweep */
		});
	} catch {
		/* no node, no fork budget — the next session start retries */
	}
	return 0;
}

/**
 * The store's own shapes, borrowed rather than restated: a record described in
 * two places drifts in one of them.
 * @typedef {import("./lib/arbiter-store.js").LockRecord} LockRecord
 * @typedef {import("./lib/arbiter-store.js").Identity} Identity
 * @typedef {import("./lib/arbiter-store.js").BreakRecord} BreakRecord
 * @typedef {import("./lib/arbiter-store.js").ListedLock} ListedLock
 * @typedef {import("./lib/arbiter-store.js").ClaimResult} ClaimResult
 * @typedef {import("./lib/arbiter-records.js").OwnHunks} OwnHunks
 * @typedef {import("./lib/arbiter-store.js").IssueClaimRecord} IssueClaimRecord
 */

/**
 * @typedef {any} WantRecord One waiter's record, as `store.readWants()` hands
 * it back. `any` because it is JSON.parse's output, unvalidated, and no record
 * typedef names a want's shape; only `sessionId`, `wants` and `since` are read.
 */
const regions = require("./lib/doc-map-regions.js");
const {
	DATA_FILES,
	HIGH_WATER_MARK_REMEDY,
	idNumber,
	parseHighWaterMark,
} = require("./lib/doc-map.js");

/*
 * NOT ON THE HOOK PATH. cmdCheck names from the registry alone: the oracle costs
 * ~465 ms, which mantahostels#411 bars from a PreToolUse hook, and that hook runs on every
 * Write and Edit.
 */
/*
 * ONE ORACLE READ FOR THE WHOLE PROCESS, and every field a report needs comes
 * off it. `oracle-cache.js` is single-flight, not a plain cache (mantahostels#1960), so a
 * second reader here would pay a second ~465 ms spawn rather than a hit.
 * `wait` alone replaces it, every 30 s off the shared reading (#3561), its
 * command outliving any one read.
 */
/** @type {ReturnType<typeof listedSessionIds>|undefined} */
let listedMemo;
function listedOnce() {
	if (listedMemo === undefined) listedMemo = listedSessionIds();
	return listedMemo;
}
/**
 * `wait`'s re-read, kept as the memo so a verdict naming the holder pays no second read.
 * @param {() => ReturnType<typeof listedSessionIds>} read
 */
function relistSessions(read) {
	listedMemo = read();
	return listedMemo;
}

/**
 * The id-to-name lookup every line naming a session reads: the oracle's name,
 * then the sessions registry's, so an oracle that times out under load still
 * names the holder (#3557). Absent where neither names it, which leaves the id.
 * @param {Map<string, string>|null|undefined} listed the oracle's names, or
 *   none where the route must not read it
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

/**
 * The session ids the oracle lists but has marked done, failed or stopped —
 * undefined where it refused, which labels nothing (mantahostels#2774).
 */
function holderTerminal() {
	return listedOnce().terminal;
}

/** The id-to-name reading every report shares, degrading to the id itself. */
function nameResolver() {
	const names = holderNames();
	return (/** @type {string|null} */ id) =>
		(id && names.get(id)) || id || "an unidentified session";
}

/**
 * THE ONE CONVENTION FOR WRITING A SESSION BY NAME (mantahostels#2452): the name leads and
 * the id follows in parentheses (`docs/working-contract.md`).
 *
 * `name` is null for a session with no title; a caller passes null rather than
 * the id, or the id would render twice.
 * @param {string|null|undefined} id
 * @param {string|null} name
 * @param {{pid?: unknown, claimedAt?: string|null}|null} [lock] PRESENCE is the
 *   flag and the fields are the data: anything non-null asks for the pid
 *   trailer, an empty object included, which is how describeHolder keeps
 *   printing `pid unknown` on its own null-lock limb. Structural rather than a
 *   `LockRecord`, because two fields is all the trailer reads
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

/**
 * A session named the one way, its id behind the name where one is known.
 * @param {string|null|undefined} id
 */
const nameSession = (id) =>
	describeSession(id, (id && holderNames().get(id)) || null);

/**
 * How a denial names its holder, so the message says who to go and ask.
 *
 * The null limb is UNVERIFIED and, from the CLI, unreachable: every verdict
 * that reaches a call here carries a lock. It is typed in because ClaimResult
 * cannot say which verdicts those are, and this file exports nothing, so no
 * test can drive the limb that would prove it.
 * @param {LockRecord|null} lock
 * @param {SessionNames} [names]
 */
function describeHolder(lock, names = holderNames()) {
	const id = lock?.sessionId;
	return describeSession(id, (id && names.get(id)) || null, lock ?? {});
}

/**
 * What a session writing a subject a live neighbour holds is told (#4249).
 * Each session edits its own worktree, so the write cannot touch the
 * neighbour's bytes and goes ahead unclaimed; the clash it signals is the
 * merge, where the second of them to land will likely meet a conflict.
 *
 * The subject actually HELD is named, which is not always the one written
 * (mantahostels#970): a neighbour holding the whole of docs/doc-map.md covers
 * every `### B<n>` entry of it.
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

/** The routes that reach a file past every hook. */
const CLOBBER_ROUTES =
	"a `cp`, a `git restore`, a heredoc, a script, or another session";

/**
 * What a session is told when the file changed under the record naming its own
 * bytes — its claim, or the observation an unclaimed writer gets (mantahostels#295, mantahostels#332,
 * mantahostels#2333). It names no claim, so it reads true for either.
 * @param {string} rel
 * @param {string|null} was
 * @param {string} closing
 */
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

// The committed path's refusal (mantahostels#2370).
const CLOBBER_AT_COMMITTED_REFUSAL =
	"Nothing was released here, so the claim and its pin both stand — the recovered copy keeps, rather than starting git's fortnight. Diff it against the file before you write to the path again.";

const CLOBBER_AT_DIRTY_RELEASE =
	"The release below refuses, so the claim and its pin both stand. Diff the recovered copy against the file BEFORE you follow that refusal: committing what is there now puts somebody else's bytes under your own message (mantahostels#63).";

/**
 * Which CLAIM SUBJECTS a write to `rel` anchored on `anchor` takes — `rel`
 * itself, or `rel#<region>` where the region is certain (mantahostels#848, built at mantahostels#970).
 *
 * A LIST, and longer than one only where the anchor straddles a known pair of
 * regions (mantahostels#1685): that edit really does rewrite both, so it holds both, and the
 * caller takes them all-or-none. The file entire is a lock four times too wide
 * there — it blocks every other region on the map for an edit that touches two.
 *
 * `notes` carries a notice whenever an anchor was offered and could not be placed:
 * mantahostels#970's rule is that the fall back to the whole file is never SILENT, because a
 * whole-file claim on docs/doc-map.md blocks every other session on it and a
 * session that did not know it had taken one cannot know to release it.
 *
 * Every failure here falls OPEN to the whole-file claim and logs, per mantahostels#103 §6 —
 * the same fail-open contract lib/file-claim.js runs under, writing to the
 * same guard-errors.log lib/guard-log.sh appends to, so `npm run
 * check:guard-errors` reports both.
 * @param {string} rel
 * @param {string|null|undefined} anchor
 * @param {string|number|null|undefined} anchorLength
 * @returns {{ subjects: string[], notes: string[] }}
 */
function claimSubjects(rel, anchor, anchorLength) {
	if (!regions.isRegioned(rel)) return { subjects: [rel], notes: [] };
	const fallback = (/** @type {string|null} */ why) => {
		// No anchor at all is a whole-file Write or a NotebookEdit, which really is
		// a whole-file write: expected, not a fault, and so not LOGGED. It is still
		// announced — buildWholeFileWriteNotice (mantahostels#2334).
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
	// The notice belongs to the CALLER, not here: only cmdCheck knows which of
	// these regions the session really took, and a contended one it did not.
	return {
		subjects: resolved.regions.map((r) => store.subjectFor(rel, r)),
		notes: [],
	};
}

/**
 * What a straddling write is told about the pair it just took (mantahostels#1685) — SAID,
 * like the whole-file fallback claimSubjects falls to and for mantahostels#970's reason: a
 * session that did not know which claims it took cannot know to release them.
 * Not logged, though — the extent is known, so nothing went wrong.
 * @param {string} file  the path every subject is a region of
 * @param {string[]} subjects
 */
const buildStraddleNotice = (file, subjects) =>
	`This write claims ${subjects.length} regions of ${store.splitSubject(file).rel}, not one — the anchor straddles them, so the write holds every region it rewrites.\n\n` +
	"Release them as soon as you are done:\n" +
	subjects.map((s) => `  ${buildArbiterCommand`release ${s}`}`).join("\n");

/**
 * What a whole-file Write to a REGIONED path is told (mantahostels#2334) — SAID, like
 * buildStraddleNotice above and for mantahostels#970's reason.
 *
 * NOT logged, unlike the fallback claimSubjects falls to.
 * @param {string} rel
 */
const buildWholeFileWriteNotice = (rel) =>
	`This write claims the WHOLE of ${rel}, not one region of it: it carries no anchor to place, so it takes every region, and every other session writing the file is warned of a likely merge conflict until this one ends or releases it.\n\n` +
	"A Write or a NotebookEdit belongs here — each rewrites the file entire. An Edit does not: it takes ONE region off its own anchor, so if this WAS an Edit its anchor could not be read (the file-claim guard drops one it cannot read), and making it again should narrow the claim.\n\n" +
	"Release it as soon as you are done:\n" +
	`  ${buildArbiterCommand`release ${rel}`}`;

/**
 * The `### B<n>` ids this write introduces that the session never allocated —
 * one note per id, or none (mantahostels#1424).
 *
 * `alloc-entry` hands out an id and claims its append slot in one atomic step,
 * which is what stops two sessions both writing `### B190` — a duplicate mantahostels#892
 * made unfixable, ids being permanent. Nothing could SEE whether a session used
 * it: appending a heading by hand takes a region claim on wherever the edit
 * anchor landed and no id-level protection at all.
 *
 * WARN, NEVER DENY. The check cannot tell an id nobody allocated from one this
 * session is legitimately re-typing — repairing a heading it already owns, or
 * moving an entry — so a refusal would block real work. `check-doc-map.js`
 * assertion 6 stays the thing that actually FAILs a duplicate, in pre-commit;
 * this is the earlier, cheaper signal.
 *
 * A WHOLE-FILE claim covers every id: `alloc-entry` itself refuses while one is
 * held, so its holder has already excluded the neighbour a duplicate needs.
 *
 * FAILS OPEN on every arm (mantahostels#103 §6), like the rest of this path: a store that
 * cannot be read says nothing rather than accusing a session that did allocate.
 * @param {string} file the plain repo-relative path, no region tail
 * @param {string|null|undefined} newIds comma-joined, as the guard sends them
 * @param {string|null} sessionId
 */
function unallocatedEntryNotes(file, newIds, sessionId) {
	try {
		if (!regions.isRegioned(file)) return [];
		const ids = String(newIds || "")
			.split(",")
			.filter((id) => /^B\d+$/.test(id));
		if (ids.length === 0) return [];
		// null is "the store could not be read", never "this session holds
		// nothing" (mantahostels#174) — the difference between silence and a false accusation.
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
		// An unexpected throw still allows the write, per the fail-open contract
		// above — but it is LOGGED, or a broken check would look exactly like a
		// session that allocated properly (§N5). check-guard-errors.js reports it.
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
 * The hook path. Prints the PreToolUse JSON and always exits 0: it never
 * refuses, so a non-zero exit here would mean the guard itself broke.
 *
 * `newIds` is the `### B<n>` ids this write introduces (mantahostels#1424).
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {{ anchor?: string|null, anchorLength?: string|number|null,
 *   newIds?: string|null }} [edit]
 */
function cmdCheck(filePath, sessionId, { anchor, anchorLength, newIds } = {}) {
	if (filePath === undefined) throw new Error("check needs a path");
	const file = store.claimKey(filePath);
	// The WATCHED union, not the warning tier: a scripts/ path takes a claim so
	// its content is recorded (mantahostels#287, mantahostels#295).
	if (file === null || !store.isWatched(file)) return;

	// Every note rides one emission: a second JSON object on stdout is a second
	// hook response, and only one is read.
	const { subjects, notes } = claimSubjects(file, anchor, anchorLength);

	const me = store.identify(sessionId);
	// Through the seam claim-all runs on (mantahostels#1685). Every arm but the
	// straddling one hands over a single subject.
	const { taken, contended, notices } = takeSet(subjects, me);
	// The notices below are FILE-level facts — this file's dirt, the
	// bytes a clobber would take — and a straddling write's subjects are regions
	// of one file, so they are read off the first of them rather than repeated
	// per region. `lock` is the one whose pin answers for the file's content.
	//
	// RESIDUAL: `verdict` is per SUBJECT. A straddling pair whose first region is
	// reentrant and whose second is freshly claimed reads as reentrant, so the
	// dirt notice is skipped — which is the once-per-session-per-file budget it
	// is gated to anyway, reentrant meaning this session wrote that region
	// earlier and was told then. The facts that are NOT the primary's to answer
	// are read per subject: the neighbours' claims and the unreadable-store
	// report.
	const primary = taken[0];
	if (primary === undefined)
		throw new Error(`takeSet took nothing of ${subjects.join(", ")}`);

	// The break notice leads: a session whose claim was broken usually meets
	// whoever broke it as the neighbour below (mantahostels#349).
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
 * Which subject the write took, said where it is not the obvious one.
 * @param {string} file
 * @param {string[]} subjects the ones this session holds after the write
 * @param {string|null|undefined} anchor
 * @param {string} verdict the primary subject's
 * @returns {string[]}
 */
function subjectNotes(file, subjects, anchor, verdict) {
	if (subjects.length > 1) return [buildStraddleNotice(file, subjects)];
	// The anchorless arm: no anchor on a regioned path can only have fallen to the
	// whole file (mantahostels#2334). Gated on a FRESH claim (mantahostels#122): a session writing the map
	// five times has one claim and needs telling once.
	if (!anchor && regions.isRegioned(file) && verdict === "claimed")
		return [buildWholeFileWriteNotice(file)];
	return [];
}

/**
 * The clobber report (mantahostels#295), on BOTH tiers — the detect-only tier's whole
 * content, since nothing there is ever refused.
 *
 * On a path a NEIGHBOUR holds, it reads this session's own observation, never
 * that lock (mantahostels#363), which records the neighbour's writes and would name the
 * neighbour's bytes as ours to recover.
 *
 * A FRESH claim carries no record of its own, so it answers "unknown" for a
 * path this session had already been writing from Bash. That session's scan
 * baseline is the only record naming its own bytes (mantahostels#419).
 *
 * That observation exists for a writer that took NO claim either (mantahostels#2333) —
 * the guard's fail-opens — so this report reaches it too (mantahostels#2353).
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

/**
 * The remaining notes stay on the refusing tier. Both speak of claims being
 * enforced, and the dirty-and-unclaimed one would fire on most writes to
 * scripts/, the repo's busiest directory — noise mantahostels#287 declined to buy.
 *
 * The store could not be read or written, so the write goes through unchecked
 * (mantahostels#103 §6) — but the session is told, rather than being left to read the
 * silence as "nobody holds this file" (mantahostels#174).
 * Per SUBJECT, not off the primary: a set whose second region went unchecked
 * while its first was claimed would otherwise read as wholly taken, which is
 * mantahostels#174's silence again.
 * @param {string[]} unchecked the claim step's
 */
function uncheckedNotes(unchecked) {
	return unchecked.map(
		(rel) =>
			`${rel} could not be checked: the file-claim store is unreadable, so this write is allowed but NOT protected, and no claim was taken.\n\n` +
			`Every session is unguarded on docs/, .claude/, CLAUDE.md and AGENTS.md until this is fixed. Check by hand before overwriting, and see the fault: node ${scriptPath("check-guard-errors.js")}`,
	);
}

/**
 * mantahostels#99's signal 2 — dirty and unclaimed — names nobody, so it can only warn
 * (mantahostels#103). It yields a false "taken" (a finished session's leftovers) but
 * never a false "free".
 * @param {Acquired} primary
 * @returns {string[]}
 */
function dirtyUnclaimedNotes({ rel, verdict, lock }) {
	if (
		verdict === "claimed" &&
		store.isWarned(rel) &&
		store.gitDirty(rel) === true &&
		// gitDirty is whole-file even for a region subject, so on a regioned path
		// the dirt may belong to a live claimant of ANOTHER region — this session's
		// earlier edit included. Saying "nobody holds it" then is simply false.
		!store.liveClaimElsewhereOnFile(rel, lock?.claimId)
	)
		return [
			`${rel} has uncommitted changes that no live session claims. Nobody holds it, so this write is allowed — but the edits are someone's work: a session that has since ended, one that released the file once its own hunks landed (#2148), or a hand edit. They are not yours to commit. Read the diff before overwriting it.`,
		];
	return [];
}

/**
 * How many region ids a refusal prints before truncating: docs/doc-map.md held
 * 113 of them on 24 Aug 2026. A first guess, and stated as one.
 */
const REGIONS_SHOWN = 12;

/**
 * Why a `claim docs/doc-map.md#<region>` naming a region the document has no
 * such thing as should be refused — or null where the id is claimable. A claim
 * on a region that does not exist contends with nobody: protection in the
 * reading, none in fact (mantahostels#1313).
 *
 * THE APPEND SLOT IS NOT IN THE DOCUMENT, so the test lives here and not in
 * lib/doc-map-regions.js: it is a policy of the claim, not a fact about the
 * file. `alloc-entry` hands out a `B<n>` before the entry is written, and a
 * session re-running `claim …#B<n>` after it must not be refused, so any `B<n>`
 * at or above the next free id passes.
 *
 * FAIL OPEN, never on the id (mantahostels#103 §6): neither an unreadable docs/doc-map.md
 * nor a parser that throws may turn a claim into a refusal, matching
 * claimSubjects' own contract above. Both say so.
 *
 * **Residual:** the check is point-in-time, and the vocabulary is open at the
 * top. A region deleted after its claim was taken reaches mantahostels#1313's failure by a
 * slower route; any `B<n>` above the high-water mark — `#B900` — passes as an
 * append slot nobody allocated; and every `A:` id on the SIDECAR passes as a row
 * slot, so a mistyped register path is never caught here at all.
 * @param {string} rel
 * @param {string} region
 */
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
		// A SIDECAR KEY SLOT, on the append slot's own reasoning (mantahostels#1414). The key's
		// region does not exist until the key is written, and the session claiming
		// it is the one about to write it — so refusing here would send every
		// session registering a new document back to a whole-file claim.
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
	// THE NEIGHBOURHOOD OF THE ID ASKED FOR, not the first twelve in document
	// order: those are always `head, stamp, section-*, B1..B7`, so a mistyped
	// `#B196` would be shown a list with nothing near it in. An entry typo gets
	// the entries, anything else the sections.
	const asked = region.match(/^B(\d+)$/);
	const isEntry = (/** @type {string} */ id) => /^B\d+$/.test(id);
	// `A:` ids are excluded from BOTH buckets: the sidecar carries ~300 of them,
	// and leaving them in the non-entry bucket would fill a mistyped section's
	// suggestion list with register keys (mantahostels#1414). Nothing is lost — every `A:` id
	// passes as a key slot above.
	const near = ids.filter(
		(id) =>
			!id.startsWith(regions.ROW_PREFIX) && isEntry(id) === Boolean(asked),
	);
	// The window ENDS where the number asked for would sort, so `#B196` against a
	// map running to B190 is shown B181..B190 rather than B1..B12. Two slots of
	// headroom, so an id just above the typo shows too.
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
 * The refusal a §A subject on the map earns when it is asked for by name, or
 * null where the subject is anybody's to take (mantahostels#2422).
 *
 * `regions.isGeneratorOnlyRegion` carries why. This is the by-name route only —
 * `claim docs/doc-map.md#section-a`, typed or scripted — and it is exactly the
 * route the generator uses, so the generator says so with `--generator` and is
 * let through. A forgeable flag on purpose: this refuses an accident.
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

/**
 * The stderr warning a regioned path claimed WITHOUT a region earns (mantahostels#1856):
 * `claim docs/doc-map.md` is legitimate and stays legitimate, but it takes the
 * whole file and so denies every region claim on it, which the bare command
 * says nothing about. WARN, NEVER REFUSE — the exit code is the claim's.
 *
 * Silent on an unregioned path: nothing outside `regions.REGIONED` has a
 * whole-file/one-region choice to tell anybody about.
 *
 * The region list is SUMMARISED, not enumerated — docs/doc-map.md carries ~450
 * regions, and a message that prints them all is one nobody reads. `rel` is
 * passed to the parser because the sidecar's keys parse under a different
 * reader (mantahostels#1848); without it every one of its regions is invisible.
 *
 * FAIL OPEN on the listing, like buildUnknownRegionReason above: an unreadable or
 * unparseable document costs the reader the list, never the claim. The
 * whole-file fact itself is read off `regions.isRegioned`, so it survives.
 * @param {string} rel
 * @returns {string|null}
 */
function wholeFileRegionWarning(rel) {
	if (!regions.isRegioned(rel)) return null;
	let listing = "";
	// False until the parse proves otherwise, so an unreadable document is never
	// offered an append slot this call could not verify it has.
	let allocatable = false;
	try {
		const text = fs.readFileSync(path.join(store.treeRoot(), rel), "utf8");
		const ids = [...new Set(regions.parseRegions(text, rel).map((r) => r.id))];
		const rows = ids.filter((id) => id.startsWith(regions.ROW_PREFIX));
		// Sorted NUMERICALLY for the range below: document order need not be
		// numeric order, and a range read off the ends of the document would name a
		// pair of ids the file does not run between.
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
		// The append slot exists only where `B<n>` entries do. Offered on the
		// sidecar, `alloc-entry` is not inert: cmdAllocEntry gates on isRegioned
		// alone, so pasting it hands out a B1 the JSON file can never carry.
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
 * The script path: a script that writes a tracked file claims it here, and is
 * warned where a live neighbour also holds it (#4249).
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {boolean} [generator] the §A generator saying so — see
 *   generatorOnlyRefusal, the only thing that reads it
 */
function cmdClaim(filePath, sessionId, generator = false) {
	if (filePath === undefined) return refuseUsage(usageOf("claim"));
	// A script naming its own region spells the subject out —
	// `claim docs/doc-map.md#B42` — rather than handing over an anchor it would
	// have to quote through a shell.
	const rel = store.claimKey(filePath);
	// The watched union, so a script writing a scripts/ file takes a claim and so
	// gets a content record (mantahostels#295).
	if (rel === null || !store.isWatched(rel)) return 0;
	// Before acquire(), so a misspelt region takes no lock at all (mantahostels#1313).
	if (refuseClaimSubject(rel, generator)) return 2;
	const me = store.identify(sessionId);
	const { contended, notices } = takeSet([rel], me);
	sayEach(notices.broken);
	sayContended(contended);
	// Exit 0, like every other fail-open: a broken store must not stop a script
	// that writes a tracked doc, or one unreadable directory halts the roadmap
	// pipeline for every session (mantahostels#174).
	sayEach(
		notices.unchecked.map((r) =>
			buildUncheckedLine(r, "this write is unprotected and no claim was taken"),
		),
	);
	// No PostToolUse fires for a file written from Bash, so this is the only
	// chance to attribute it.
	store.recordWrite(filePath, sessionId);
	return 0;
}

/**
 * `claim`'s checks on the subject itself, ahead of acquire(): a refusal is
 * written here and answers true, for an exit 2. A whole-file claim on a regioned
 * path is warned of and answers false.
 * @param {string} rel
 * @param {boolean} generator
 */
function refuseClaimSubject(rel, generator) {
	const named = store.splitSubject(rel);
	if (named.region === null) {
		// Beside the misspelt-region check and BEFORE acquire(), so the reader is
		// told which subject the call asked for whether or not it is then denied —
		// which is exactly when knowing costs most (mantahostels#1856).
		const warning = wholeFileRegionWarning(named.rel);
		if (warning) writeStderr(warning);
		return false;
	}
	// Ahead of the spelling check: `#A:docs/x.md` on the map is a well-formed
	// id that buildUnknownRegionReason waves through as a row slot.
	const why =
		generatorOnlyRefusal(named.rel, named.region, generator) ||
		buildUnknownRegionReason(named.rel, named.region);
	if (!why) return false;
	writeStderr(why);
	return true;
}

/*
 * Every write goes through writeFd (lib/write-fd.js), never process.stdout or
 * process.stderr: every subcommand, `wait` included, returns into the file's
 * single process.exit, which drops what a pipe still has buffered, and an
 * agent reads both through a pipe (§N6, #1631, #1635).
 */
/** @param {string} text */
function writeStdout(text) {
	writeFd(1, text);
}

/** @param {string} text */
function writeStderr(text) {
	writeFd(2, text);
}

/**
 * Print each of the claim and release steps' notices on the CLI routes'
 * channel.
 * @param {(string|null)[]} texts
 */
function sayEach(texts) {
	for (const text of texts) if (text) writeStderr(`session-arbiter: ${text}\n`);
}

/**
 * A CLI route's report of a subject the claim step left `unknown`.
 * @param {string} rel
 * @param {string} consequence what the route took, or did not, as a result
 */
const buildUncheckedLine = (rel, consequence) =>
	`could not check ${rel} — the file-claim store is unreadable, so ${consequence}. See: node ${scriptPath("check-guard-errors.js")}`;

/**
 * A verdict under which this session now holds the subject: claimed fresh, or
 * held already.
 * @param {string} verdict
 */
const isRealClaim = (verdict) =>
	verdict === "claimed" || verdict === "reentrant";

/**
 * THE CLAIM STEP (#1487): every subject in `rels` taken where it is free, and
 * the notices due handed back. Every
 * route that takes a claim runs on it — the write hook, `claim`, `claim-all`
 * and `alloc-entry` — and chooses only where to print.
 *
 * A subject a live neighbour holds is NOT refused (#4249): each session edits
 * its own worktree, so the claim protects no bytes, and the subject comes back
 * in `contended` for the route to warn that the merge will likely conflict.
 * Only the guarded tier is warned on; a scripts/ path is detect-only
 * (mantahostels#287).
 *
 * Subjects are taken in one sorted order, so two sessions asking for an
 * overlapping set meet on the same subject first.
 *
 * `unchecked` is the subjects themselves rather than texts: each route words
 * that one its own way.
 * @typedef {{rel: string, verdict: string, lock: any}} Acquired one subject as
 * this call left it.
 * @typedef {{broken: string[], unchecked: string[]}} ClaimNotices
 * @param {string[]} rels sorted and de-duplicated here, not by the caller
 * @param {Identity} me
 * @returns {{rels: string[], taken: Acquired[], contended: Acquired[],
 *   notices: ClaimNotices}}
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

/**
 * A CLI route's report of the subjects a live neighbour holds, one line each.
 * @param {Acquired[]} contended
 */
function sayContended(contended) {
	sayEach(contended.map((c) => buildContendedNotice(c.rel, c.lock)));
}

/**
 * Every subject this session needs, in one call — the CLI over takeSet above.
 * A subject a live neighbour holds is warned of, never refused (#4249).
 *
 * @param {string[]} filePaths
 * @param {string} sessionId
 */
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

	// Every misspelt region is rejected before ANY lock is taken. Checking them
	// one at a time as the loop reached them would leave the earlier subjects held
	// by a call that then exits 2 (mantahostels#1313's reason, applied to a set).
	for (const rel of rels) {
		const named = store.splitSubject(rel);
		if (named.region === null) continue;
		// A derived §A subject is refused here too, and for the same reason a
		// misspelt one is: one unclaimable member stops the set before any lock
		// is taken (mantahostels#2422). `claim-all` has no
		// --generator: the generator takes its one subject with `claim`.
		const why =
			generatorOnlyRefusal(named.rel, named.region, false) ||
			buildUnknownRegionReason(named.rel, named.region);
		if (why) {
			writeStderr(why);
			return 2;
		}
	}

	// PER OFFENDING SUBJECT, and in a second pass: a set naming both the doc map
	// and an unregioned path warns about the doc map alone, and warning only once
	// every misspelt region in the set has been rejected keeps the exit-2 refusal
	// above from stranding a warning nobody needed (mantahostels#1856).
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
	// Exit 0 like every other fail-open, and never silently: a set reported as
	// taken while one member was never checked is the reading mantahostels#174 exists to
	// prevent.
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

/** The issue claims as one reading, null where the store would not read whole. */
function issueClaimsReading() {
	const listed = store.listIssueClaims();
	return listed && !listed.why ? listed.claims : null;
}

/**
 * The cycle report, printed under `list`. Diagnosis only: it releases nothing,
 * and a register it cannot read costs the report but never the listing above
 * it (mantahostels#1195).
 */
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

/**
 * Every issue one session claims, for its DEADLOCK line.
 * @param {IssueClaimRecord[]|null} claims the issue claims, null where the store would not read
 * @param {string} id
 */
function holdingsOf(claims, id) {
	return claims === null
		? ["issue claims UNKNOWN: the issue-claim store could not be read"]
		: claims
				.filter((/** @type {any} read off disk */ c) => c.sessionId === id)
				.map((/** @type {any} */ c) => waitMod.issueWant(c.issue));
}

/**
 * One DEADLOCK block under `list`: the ring's members, what each holds and
 * wants, and how to break it.
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
 * The WAITING line for a session waiting outside any ring on an issue.
 * @param {WantRecord} w its want
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

/**
 * The subjects `sessionId` holds on `rel` — the whole file, its regions, or
 * both. Only ever your own: a bare release walks no neighbour's claim.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function readOwnSubjectsOn(rel, sessionId) {
	return (store.readHeldBy(sessionId) ?? []).filter(
		(subject) => store.splitSubject(subject).rel === rel,
	);
}

/**
 * The finished-with-it path (mantahostels#126). Exit 0 when there is nothing of ours left on
 * the path; every refusal exits 1 with its reason on stderr.
 *
 * `generator` is `--generator`, symmetric with the claim's (mantahostels#2428): it waives
 * the dirty refusal on §A of the map alone, whose holder is a generator whose
 * own write made it dirty.
 *
 * `notMine` is `--not-mine`: the holder's word that every uncommitted change
 * left in the file is another session's, taken only where the arbiter could
 * not prove it either way (#2148) — store.release's header.
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {{generator?: boolean, notMine?: boolean}} [opts]
 */
function cmdRelease(filePath, sessionId, opts = {}) {
	if (filePath === undefined) return refuseUsage(usageOf("release"));
	const rel = store.claimKey(filePath);
	if (rel !== null && store.splitSubject(rel).region === null) {
		// A bare regioned path means "everything I hold on this file". A session
		// holding three §B entries would otherwise have to remember and spell out
		// all three, and mantahostels#121's whole complaint is that releases get forgotten.
		//
		// THIS SESSION'S OWN, never every lock on the file: walking a neighbour's
		// region claim earns a "not by this session" refusal for a claim the
		// caller never asked about.
		//
		// EVERY subject of the file, the bare path included: a session that wrote
		// the file entire and then edited one entry holds both, and stopping at
		// the regions would leave the file-wide claim standing behind a release
		// that printed nothing but successes (mantahostels#121, mantahostels#126).
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
 * cmdRelease's body: one subject, whole file or single region.
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
	// The watched union: a scripts/ path takes a claim now (mantahostels#295), so its holder
	// must be able to give it back. PLUS the exempt paths, which take no new
	// claim but can still carry one minted before the exemption landed (mantahostels#2103) —
	// gating on isWatched alone would freeze those for ever, returning 0 having
	// dropped nothing while the stranded-claim report went on naming them.
	if (rel === null || !store.isReleasable(rel)) return 0; // never claimed, nothing to drop

	const me = store.identify(sessionId);
	const result = store.release(rel, me, { generator, notMine });
	const { verdict } = result;

	/** @type {ReleaseOutcome} */
	const out = { ...result, rel, me };
	const first = RELEASE_FIRST[verdict];
	if (first) return first(out);
	// Both exits below dropped this session's own observation, if it had one, so
	// this is its last reporting site (mantahostels#363).
	if (out.observed?.state === "changed")
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, out.observed.was, CLOBBER_AT_RELEASE)}\n`,
		);
	const then = RELEASE_THEN[verdict];
	if (then) return then(out);
	return releaseUnproven(out);
}

/**
 * One release()'s answer, with what releaseSubject asked it about.
 * @typedef {ClaimResult & {rel: string, me: Identity}} ReleaseOutcome
 */

/**
 * The verdicts releaseSubject answers before the observation report: each
 * prints its own outcome and returns the exit code.
 * @type {Record<string, (o: ReleaseOutcome) => number>}
 */
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

/**
 * The verdicts releaseSubject answers after the observation report.
 * @type {Record<string, (o: ReleaseOutcome) => number>}
 */
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

/**
 * `dirty`: the claim stands. The clobber goes FIRST, because the refusal that
 * follows it says to commit or discard, and a clobber makes both of those
 * destructive (mantahostels#337). The verdict is unchanged: still a refusal, still exit 1.
 * @param {ReleaseOutcome} o
 */
function releaseDirty({ rel, content, own }) {
	if (content?.state === "changed")
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, content.was, CLOBBER_AT_DIRTY_RELEASE)}\n`,
		);
	writeStderr(
		`session-arbiter: ${rel} ${DIRTY_HEADLINE[own ?? "unjudged"]}, so the claim stands.\n` +
			"Releasing a dirty claim hands the next session your unfinished edit to commit under its own message (mantahostels#63). " +
			"Commit or discard the change, then release. Re-claiming is automatic: your next write to it takes the file back.\n" +
			// The other exit: committing dirt that may be a neighbour's lands
			// their bytes under your message (mantahostels#2318).
			neighbourDirtExit(rel, own),
	);
	return 1;
}

/**
 * releaseDirty's last line: the exit for dirt that may be a neighbour's. A
 * pending hunk is proven the holder's own, so it is offered none.
 * @param {string} rel
 * @param {OwnHunks|undefined} own
 */
function neighbourDirtExit(rel, own) {
	if (own === "unproven") return `${buildNotMineOffer(rel)}\n`;
	if (own === undefined)
		return "Is the dirt a live neighbour's rather than yours? Then leave the claim standing: it is broken automatically once this session's process ends (`breakStale`), so nothing inherits it and there is nothing here to do.\n";
	return "";
}

/**
 * What a `dirty` refusal says the dirt is, by store.release's `own`;
 * `unjudged` for a region subject, which that test never reaches.
 * @type {Record<string, string>}
 */
const DIRTY_HEADLINE = {
	pending:
		"still holds an uncommitted change of this session's own — one HEAD does not have",
	unproven:
		"has uncommitted changes, and nothing here could prove they are all another session's",
	unjudged: "has uncommitted changes",
};

/**
 * The exit for a holder whose own hunks have all landed in a file the arbiter
 * could not prove it of (#2148): named on every refusal that can block one.
 * @param {string} rel
 */
function buildNotMineOffer(rel) {
	return `Is every one of them another session's, all of yours already committed? Then \`${buildArbiterCommand`release --not-mine ${rel}`}\` releases it on your word — and a change of yours it could not see goes with the file to the next session (mantahostels#63).`;
}

/**
 * The trailer on a release that left other sessions' dirt behind, so the holder
 * knows the file it gave back is not clean (#2148).
 * @param {OwnHunks|undefined} own
 */
function buildOthersDirtNote(own) {
	if (own === "landed")
		return " Every hunk this session wrote has landed; the uncommitted changes left in it are other sessions'.";
	if (own === "unproven")
		return " The uncommitted changes left in it are other sessions', on this session's word (--not-mine).";
	return "";
}

/**
 * The last two refusals, `uncheckable` and `contended` — and anything else.
 * Both computed a content answer, and both report it ahead of themselves
 * (mantahostels#420) — an answer this has does not go unsaid.
 * @param {ReleaseOutcome} o
 */
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

/* 30 days, chosen and not measured: the span queue-exit-log.js keeps for the
 * same kind of incident trace. */
const KEPT_CLAIMS_RETAIN_MS = 30 * DAY_MS;

/**
 * The third exit, after process death and an explicit `release` (mantahostels#2336, #2058).
 *
 * The commit is the real boundary: work on a file is finished when it lands, and
 * a claim held past it blocks a neighbour on a file nobody is editing. Not a
 * timer and not an idle window — mantahostels#104 and mantahostels#411 both
 * refused those, and an idle holder mid-review is indistinguishable from an
 * abandoned one. A release that comes too early self-heals: the holder's next
 * write re-claims the file (mantahostels#121).
 *
 * Every whole-file subject this session holds on a landed path, on both tiers:
 * a detect-only claim blocks nobody, but a finished one still crowds `list`.
 * A file still carrying other sessions' uncommitted hunks releases too, once
 * this session's own have all landed (#2148) — store.release's header.
 * A region claim stays: it blocks one region and is cheap, so dropping it costs
 * the holder its protection and buys nothing.
 *
 * Residual: a `--patch` commit leaving part of the edit out, a commit mid-replay
 * (post-commit stands down) and a file finished without a commit all keep the
 * claim until a hand `release` or the process ends.
 *
 * NEVER SILENT (#2148). It names what it released and, one line each, what it
 * kept and why, with the command that releases where there is one. Not
 * `release`'s recovery ladder, which after every commit would be wallpaper.
 * The thing a refusal can be the LAST chance to say is said as well: a
 * clobber of the holder's own bytes (mantahostels#420). The one silent exit
 * is a commit with no session behind it, a person's in a terminal.
 *
 * Each keep is also a line of `kept-claims.jsonl` in the state directory (#3746).
 * @param {string} sessionId
 * @param {string[]} paths the landed commit's paths, absolute or repo-relative
 * @param {string|null} commit the commit that landed them; null on a hand release
 */
function cmdReleaseCommitted(sessionId, paths, commit) {
	// Ahead of identify(), which would otherwise log "no live session entry for
	// (no session id)" after every commit a person makes in a terminal.
	if (!sessionId) return 0;
	const landed = new Set(
		paths.map((p) => store.claimKey(p)).filter((rel) => rel !== null),
	);
	const me = store.identify(sessionId);
	const held = store.readHeldBy(sessionId);
	// Fail open, and SAY SO: an unreadable store means the claim stands rather
	// than being reported gone (mantahostels#174), and post-commit lets this reach a human.
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
 * release-committed's whole report: one line for every path released however
 * many — a many-file commit is routine — then one per path kept.
 * @param {string[]} released
 * @param {string[]} leftDirty the released paths other sessions' dirt still sits in
 * @param {string[]} kept buildKeptLine's lines
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

/**
 * Release one landed subject, its refusal left for buildKeptLine to word.
 * @param {string} rel
 * @param {Identity} me
 * @returns {ClaimResult}
 */
function releaseLanded(rel, me) {
	const result = store.release(rel, me);
	const { verdict, content, observed } = result;
	// AHEAD OF THE REFUSAL BRANCH, and both records, for the reason the hook
	// leaves stderr unswallowed: a clobber by a route no hook watches is
	// reported on the release that finds it, released or refused (mantahostels#332, mantahostels#420),
	// and a refusal that dropped this session's observation is its last site
	// (mantahostels#363).
	//
	// A refused release keeps the CLAIM, so `dropContentRef` never runs and the
	// pin stands; the observation branch below is reached only on `not-held` and
	// `held-by-other`, where `dropObservation` took the record and its pin
	// whatever the verdict was (mantahostels#2370).
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

/**
 * What release-committed kept and why (#2148).
 * @param {string} rel
 * @param {ClaimResult} result releaseLanded's refusal
 */
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

/**
 * The reader's path: one repo-relative path per line, for a shell `grep -Fx`.
 *
 * Exit 1 with nothing on stdout is the callers' contract: non-zero means
 * *unavailable*, never *wrote nothing*.
 *
 * The status must be produced at or below this function. The module runner
 * catches to fail open (mantahostels#103 §6), so an error left to propagate out of
 * readWritesBy() would be turned back into exit 0 with empty stdout (mantahostels#135).
 *
 * concision-backstop.sh (mantahostels#137) stays silent on it, since a hook with
 * no attribution has no session to bill.
 *
 * `--committed` adds every path the session's own commits touched, for the
 * review backstop and the push review warning (#2390): lib/arbiter-ledger.js's
 * readBilledPathsBy, which the review tier reads too.
 * @param {string} sessionId
 * @param {boolean} committed
 */
function cmdWrites(sessionId, committed) {
	const paths = committed
		? store.readBilledPathsBy(sessionId, "writes --committed")
		: store.readWritesBy(sessionId);
	if (paths === null) return 1;
	for (const rel of paths) writeStdout(`${rel}\n`);
	return 0;
}

/**
 * `own-paths` (#3099): the paths this session's own commits in `<from>..<to>`
 * touched, one a line, by #1154's rule narrowed by patch (lib/own-work.js,
 * #3108), for code-signal.sh's review_uncovered to bill a review marker's
 * newer base= with. Exit 1 with
 * nothing on stdout where the range or the ledger will not read, which the
 * caller must not take for "made none".
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

/**
 * `record-commit` (#766): post-commit's call, adding the commit just landed to
 * this session's commit ledger, which guard-unpushed-commits.js reads at Stop.
 *
 * 0 but on usage, and silent with no session id: the commit has landed, and a
 * missed record costs one missed warning.
 * @param {string|undefined} commit
 * @param {string} sessionId
 */
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

/**
 * The versions a claimed path has passed through, newest first, each with the
 * command that gets it back (mantahostels#438).
 *
 * This is the answer to the holder's own clobber: a `cp` the holder ran is
 * trusted by the post-Bash refresh and re-pins the clobbered bytes, so nothing
 * reports it — but the sha it replaced is kept, and this prints it.
 *
 * A version another session's claim recorded prints too. The holder is named, so
 * the reader knows whose bytes they are (mantahostels#420).
 *
 * THIS SESSION'S OWN OBSERVATION PRINTS BESIDE THE CLAIM'S (mantahostels#2374).
 * @param {string|undefined} filePath
 * @param {string} sessionId
 */
function cmdVersions(filePath, sessionId) {
	if (filePath === undefined) return refuseUsage(usageOf("versions"));
	const rel = store.claimKey(filePath);
	if (rel === null) {
		writeStderr(`session-arbiter: ${filePath} is not in this repo\n`);
		return 2;
	}
	const held = store.claimVersions(rel);
	// Whole-file, as the record is: `observedVersions` strips any region itself.
	const observed = store.observedVersions(rel, sessionId);

	/*
	 * A RECORD THAT WOULD NOT READ IS SAID, NEVER FOLDED INTO "no claim" (mantahostels#2382),
	 * and said FIRST, above whichever half did read.
	 */
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
	// 1 on a record that would not read, on cmdList's mantahostels#174 precedent: a command
	// whose answer is incomplete must not exit as though it were whole.
	return unreadable ? 1 : 0;
}

/**
 * Say each version record that would not read, and whether any did not.
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
 * One block of `versions`' report: a record's versions, newest first, each
 * with the command that recovers it.
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

/**
 * Record that this session is working a GitHub issue (mantahostels#645), so pick-next.js can
 * tell a live claim from a dead assignee, which would otherwise hide the issue for good.
 *
 * Always exit 0. The record is an aid to selection, not a gate on anything, and
 * a failure to write one leaves the issue selectable — the fail-open direction
 * mantahostels#633 chose the option for.
 * @param {string|undefined} issue
 * @param {string} sessionId
 */
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

/* A session runs release-issue for itself, so this bounds a hung `gh`, not a
 * hook budget. A first guess, unmeasured. */
const UNIT_READ_MS = 10_000;

/**
 * The refusal for dropping this session's claim on issue `n` while it is an
 * unfinished build unit it has started, or null where the release goes ahead:
 * the session holds no claim on it, no commit of its own cites it,
 * park-blocked.sh is parking it (its record, written first, names `n`), no
 * tracker is declared, or the issue will not read — which fails open, saying
 * so on stderr.
 * @param {number} n
 * @param {string|null} sid
 * @returns {string|null}
 */
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
	return `session-arbiter: refusing to release #${n}: it is an open \`kind:ticket\` with an unticked, unwaived acceptance criterion and no \`parked\` label (#4495). No ticket comment or body note moves a unit's boundary. Finish it and close it with ${scriptPath("resolve-ticket.js")}, which releases the claim itself; or leave it by one of the four exits: ${heldUnit.EXITS}.\n`;
}

/**
 * Drop this session's own claim on an issue. Another session's is left alone.
 * Refused, exit 2, on an unfinished build unit (`heldUnitRefusal`).
 * @param {string|undefined} issue
 * @param {string} sessionId
 */
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
 * Move this session's own claim on an issue to session `to`. The issue stays
 * claimed, so a move to a running session takes none of release-issue's gate;
 * a move to one the sessions registry shows not running would let go of the
 * unit, and takes it.
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

/** The issue-claim store, for a person. Liveness is pick-next's to judge. */
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
	// Non-zero on a partial read (mantahostels#1186): stdout still prints every record
	// read, for a person who sees the stderr warning, but a script checking
	// the exit code alone must not read a partial list as complete.
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

/*
 * `wait`'s verdicts (#540). Each has its own exit code, so a background job's
 * notification says which fired before anything is read. 1 and 2 keep the
 * meanings every other subcommand gives them: a fault, and a usage error.
 */
const WAIT_EXIT = {
	RELEASED: 0,
	"NOT-HELD": 4,
	CEILING: 5,
	"HOLDER-ENDED": 6,
	DEADLOCK: 7,
};

// A bound #542 set, not derived: each read costs ~465 ms (mantahostels#317).
const WAIT_ORACLE_EVERY_S = 30;

// A GUESS, unmeasured: above the ~18-minute median wait
// docs/research/waiting-stall-forensics.md §5 found, below the point where
// carrying on with other work is the better move (#535).
const WAIT_CEILING_S = 30 * 60;

// A GUESS too. A poll reads the issue-claim store, so it costs milliseconds;
// this only bounds how late a release is noticed.
const WAIT_POLL_S = Number(process.env.WFC_ARBITER_WAIT_POLL_S) || 2;

/**
 * One `wait`'s target and its running state, shared by its steps.
 * @typedef {object} WaitRun
 * @property {number} issue
 * @property {string} subject
 * @property {number} ceiling seconds
 * @property {Identity} me
 * @property {string} myId
 * @property {IssueClaimRecord|null} holder poll's `held`
 * @property {number} oracleDue
 * @property {string|null} oracleDoubt the last oracle read's refusal, for CEILING
 */

/**
 * One poll's reading: `held` with every claimant in `holders` and the `claims`
 * they were read from, `free` (null) where no other session claims the issue,
 * or `doubt` — `fault` marking a store that would not open, which ends a wait
 * before it starts and only clouds one that is running.
 * @typedef {{held?: IssueClaimRecord, free?: null, doubt?: string, fault?: boolean, holders?: IssueClaimRecord[], claims?: IssueClaimRecord[]}} WaitPoll
 */

/**
 * `wait`'s target and ceiling, or the exit code a bad argv ends on — its
 * message printed here.
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
 * Print one `wait` verdict and hand back its exit code.
 * @param {WaitRun} w
 * @param {import("./lib/arbiter-wait.js").Verdict} verdict
 * @param {string} text
 */
function waitSay(w, verdict, text) {
	writeStdout(`${verdict}  ${w.subject} — ${text}\n`);
	return WAIT_EXIT[verdict];
}

/**
 * One poll of `wait`'s issue.
 * @param {WaitRun} w
 * @returns {WaitPoll}
 */
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

/**
 * How a verdict names a holder: one oracle read, paid only at exit.
 * @param {IssueClaimRecord|null} h poll's `held`
 */
function buildWaitHolderText(h) {
	if (!h?.sessionId) return "a holder that could not be identified";
	return describeSession(h.sessionId, holderNames().get(h.sessionId) || null);
}

/**
 * This session's want, null where it has none, undefined where unread.
 * @param {string} myId
 */
function readOwnWantOf(myId) {
	const wants = store.readWants();
	if (wants === null) return;
	return wants.find((x) => x.sessionId === myId)?.wants ?? null;
}

/**
 * Put `wait`'s own want on the register.
 * @param {WaitRun} w
 */
function recordWaitWant(w) {
	store.recordWant(w.subject, w.me);
}

/**
 * Drop `wait`'s own want — only where it is still this wait's, so a second
 * wait this session started since stands. An unreadable register drops too: a
 * wait that has ended must not be left listed as WAITING.
 * @param {WaitRun} w
 */
function dropWaitWant(w) {
	const own = readOwnWantOf(w.myId);
	if (own === w.subject || own === undefined) store.dropWant(w.myId);
}

/**
 * Drop the want on a hangup, interrupt or terminate, then exit as the signal would.
 * @param {WaitRun} w
 */
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

/**
 * The ring this session is a member of, or null, judged on the poll's own
 * issue-claim reading.
 * @param {WaitRun} w
 * @param {WaitPoll} s a held poll
 */
function ringThroughMe(w, s) {
	const wants = store.readWants();
	if (!wants) return null;
	const cycles = waitMod.findCycles(wants, s.claims ?? issueClaimsReading());
	return waitMod.ringThrough(cycles, w.myId);
}

/**
 * DEADLOCK's chain, read from this session round the ring.
 * @param {{sessionId: string, wants: string}[]} ring
 * @param {string} myId
 */
function deadlockChain(ring, myId) {
	const nameOf = nameResolver();
	const at = ring.findIndex((x) => x.sessionId === myId);
	return [...ring.slice(at), ...ring.slice(0, at)]
		.map((x) => `${nameOf(x.sessionId)} wants ${x.wants}`)
		.join(" -> ");
}

/**
 * HOLDER-ENDED's oracle read: the terminal sessions, or undefined where the
 * oracle refused. The caller keeps the WAIT_ORACLE_EVERY_S cadence.
 *
 * OFF THE SHARED READING (#3561), so N waiters start one listing per cache
 * TTL between them. That reading can be a TTL old, and a holder it calls
 * ended may have resumed since, so a reading that would end the wait is
 * confirmed by a fresh one first. RESIDUAL: it stays the memo, so a verdict
 * line's names and ENDED labels can be that TTL old; they inform, never act.
 * @param {WaitRun} w accumulator: oracleDue and oracleDoubt are advanced
 * @param {WaitPoll} poll the poll the verdict is judged on
 */
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

/**
 * CEILING's text, saying which of the last reads were doubtful.
 * @param {WaitRun} w
 * @param {WaitPoll} state the last poll
 */
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

/**
 * Each verdict's line after its name, from the run, the poll it fired on and,
 * for DEADLOCK, the ring.
 * @type {Record<import("./lib/arbiter-wait.js").Verdict, (w: WaitRun, state: WaitPoll, ring: WantRecord[]) => string>}
 */
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
 * Print a verdict the module gave, and hand back its exit code.
 * @param {WaitRun} w
 * @param {WaitPoll} state
 * @param {{verdict: import("./lib/arbiter-wait.js").Verdict, ring?: WantRecord[]}} v
 */
function sayVerdict(w, state, v) {
	return waitSay(w, v.verdict, VERDICT_TEXT[v.verdict](w, state, v.ring ?? []));
}

/**
 * Poll until the module gives a verdict; the ceiling is one of them.
 * @param {WaitRun} w accumulator: holder follows each poll; the rest is read
 * @returns {Promise<number>}
 */
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
 * `wait <issue> [ceiling-seconds]` (#540): block until every other session's
 * claim on the issue is gone, and say how. Run in the background, so its exit
 * is the notification that wakes the session.
 *
 * IT REPORTS AND NEVER ACTS. It releases and claims nothing.
 *
 * DOUBT NEVER FREES. A store or oracle that will not read keeps the wait
 * going, and the CEILING line says the last read was doubtful.
 *
 * TWO EARLY EXITS (#542). HOLDER-ENDED is the oracle's `terminal` set — the
 * test `list`'s ENDED applies — and the only liveness an issue claim, carrying
 * no pid, gets. DEADLOCK is `list`'s cycle walk finding this session in a ring.
 *
 * THE WANT is this session's entry in the waiter register, so `list` prints
 * WAITING while this runs. RESIDUAL: a SIGKILL skips the drop, and the want
 * outlives the wait until the session ends or the age sweep takes it.
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

/**
 * The five-character status column `list` prints for a readable lock — padded
 * here rather than by the caller so the three words stay the same width.
 *
 * `ENDED` is checked FIRST: a lock can be both alive by pid and terminal by the
 * oracle, and that pairing is exactly the case worth naming (mantahostels#2774).
 *
 * @param {{alive?: boolean, sessionId?: string|null}} lock
 * @param {Set<string> | undefined} terminal `holderTerminal()`'s answer, or
 *   undefined where the oracle refused — then no row is called ended.
 */
function holderLabel(lock, terminal) {
	if (!lock.alive) return "STALE";
	if (lock.sessionId && terminal?.has(lock.sessionId)) return "ENDED";
	return "HELD ";
}

/**
 * The trailing marker a region claim carries in `list`, so a `HELD
 * docs/doc-map.md#B190` line is not read as the whole file being taken (mantahostels#1313).
 *
 * A TRAILING FIELD, not a change to the path column: the column is what a
 * reader greps for a filename, and `session-arbiter list | grep doc-map.md`
 * is already a documented move (docs/research/docmap-read-pattern.md).
 * @param {string} subject
 */
function regionMarker(subject) {
	const { rel, region } = store.splitSubject(subject);
	return region === null
		? ""
		: `\tONE REGION (${region}) of ${rel} — its other regions are free`;
}

/**
 * What is claimed. LIVE claims only by default (mantahostels#1814): a STALE row warns
 * nobody — only a live holder's claim does, and a resumed holder counts as
 * alive (arbiter-store.js's resumedHolderTest), so hiding them hides nothing
 * the reader would have been warned of.
 *
 * An unreadable lock row is NOT a dead one and stays in both views: liveness
 * could not be judged, so it cannot be judged absent.
 *
 * RESIDUAL: every other site in the repo naming this command names the bare
 * `list`, and all of them ask after a LIVE holder, which the default answers. A
 * future site asking after a dead one has to say `--all` for itself; nothing
 * checks that it did.
 *
 * `holderAlive` judges by pid and process-start time, so a background session
 * the oracle has marked done, failed or stopped still reads HELD until the
 * reaper takes its process — and a reader judging whether its merge will
 * conflict would be weighing a session that will write no more. The row is
 * still shown, still counted live for the `--all` filter, and a write to it is
 * still warned of: this is display wording, never a release mechanism
 * (mantahostels#318, mantahostels#2765, mantahostels#2774).
 *
 * IT COSTS NO EXTRA ORACLE READ: `holderTerminal()` shares the one memoised
 * call `describeHolder` already makes on this path, so `list` still spawns
 * `claude agents --json` exactly once.
 * @param {boolean} all  `--all`; main refuses any other argument
 */
function cmdList(all = false) {
	const { locks: held, registryUnreadable } = store.listLocksJudged();
	// Never "No files are claimed." on a store that would not open (mantahostels#174).
	if (held === null) {
		writeStderr(
			`session-arbiter: could not read the lock store at ${store.paths.locksDir()}, so what is held is unknown — not nothing.\n` +
				`See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	if (held.length === 0) {
		writeStdout("No files are claimed.\n");
		// Still read: a session waiting on an issue claim holds no file (#540).
		reportWaits();
		return 0;
	}
	const shown = all ? held : held.filter((l) => l.unreadable || l.alive);
	const hidden = held.length - shown.length;
	// FIRST, not among the rows: every other line here restates a lock still on
	// disk; this one is the ONLY place the reader learns the view is partial
	// (mantahostels#174).
	if (hidden)
		writeStdout(
			`${hidden} stale claim(s) hidden — ${buildArbiterCommand`list --all`}\n`,
		);
	// The other way this view is partial (#273). The column below is a boolean,
	// so a holder resumed onto a fresh process — which only the sessions
	// registry knows about — is judged STALE, and the default view then hides
	// it. The block under the rows says UNKNOWN about the same lock, going
	// through store.whoHolds instead.
	//
	// RESIDUAL: the two read the registry separately, so a registry that opens
	// here and fails when store.whoHolds first asks prints UNKNOWN below with no
	// caveat above. Seeding one from the other is the fix; it is not taken,
	// because OR-ing them at print time would move this line under the rows,
	// which is where a reader stops looking.
	if (registryUnreadable)
		writeStdout(
			`The sessions registry could not be read, so a claim judged STALE may be a live holder resumed onto a fresh process — including one this view has hidden. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
	if (shown.length === 0)
		writeStdout("No files are claimed by a live session.\n");
	// BELOW the empty-view guard, not above it: a default view whose every holder
	// is dead shows no row to label, and the oracle spawn would be paid for
	// nothing. `describeHolder`'s own read is lazy for the same reason.
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

/**
 * The high-water mark in the data file beside the map at `rel`, or 0 where it
 * is absent or unreadable: allocation then falls back to max + 1, and
 * check-doc-map.js's assertion 12 is what refuses a reused id (#2339).
 * @param {string} rel
 */
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

/**
 * Hand out the next free `### B<n>` id, and claim the append slot with it
 * (mantahostels#848's third piece, built at mantahostels#970).
 *
 * Sessions adding a NEW entry contend on one shared resource — the next id and
 * the place it goes — rather than on an entry. Two reading `nextEntryNumber` in
 * the same second both write `### B190`, which mantahostels#892 forbids outright.
 *
 * ATOMICITY IS THE LOCK'S, not this loop's: the claim is created by hard-linking
 * a temp file into place, which the kernel refuses when the name exists
 * (measured at mantahostels#970). So the session that wins `B190`'s lock owns B190, and the
 * loser walks on to B191.
 * @param {string|undefined} filePath
 * @param {string} sessionId
 */
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
	// Enough to walk past every id a plausible burst of neighbours holds at once;
	// far short of looping.
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
			// The store could not be used, so nothing here is atomic and an id handed
			// out now may be handed to a neighbour too. Refuse rather than collide:
			// mantahostels#892 made a duplicate id unfixable, ids being permanent.
			writeStderr(
				`session-arbiter: the claim store is unreadable, so no id can be allocated without risking a duplicate — and a duplicate \`### B<n>\` cannot be renumbered away (mantahostels#892). See: node ${scriptPath("check-guard-errors.js")}\n`,
			);
			return 1;
		}
		// Held by somebody. A WHOLE-FILE holder blocks every id equally, so walking
		// on would be 64 pointless rounds against one neighbour.
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

/**
 * A usage block naming each line's form, the first under `usage:`.
 * @param {string[]} lines  each after `session-arbiter.js `
 */
const buildUsage = (lines) =>
	lines
		.map((l, i) => `${i ? "      " : "usage:"} session-arbiter.js ${l}`)
		.join("\n");

/**
 * Subcommands whose argv is not the caller's own flags, so they are never
 * parsed (#1137): `check` takes an Edit's old_string from the hook every write
 * runs, `record` rides the same hook, and `release-committed` takes git's
 * committed paths, any of which may open `--`, behind a `--commit <full sha>`
 * it reads by hand. lib/cli-args.js would read that as a flag and refuse it,
 * or print usage on a `--help` inside it. So a mistyped flag on these still
 * passes unrefused.
 * @type {Record<string, string>}
 */
const PASS_THROUGH = {
	check: "check <path> [session-id] [<anchor> <anchor-length> <new-ids>]",
	record: "record <path> [session-id]",
	"release-committed": "release-committed [--commit <sha>] <path> [<path>...]",
};

/**
 * @typedef {{ line: string, flags?: Record<string, "boolean">, max?: number }} Form
 *   `line` is the usage after `session-arbiter.js `. `min` is left at 0
 *   throughout: each handler answers a missing argument itself, some of them on
 *   a hook path that must not change its exit code.
 */

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
		line: "prune-markers [--detach]",
		flags: { "--detach": "boolean" },
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

/** A command with no handler: a spec added without its `case`. */
function refuseUnhandled() {
	writeStderr(`${USAGE}\n`);
	return 2;
}

/**
 * `prune-markers [--detach]`: sweep the stores, or launch a detached sweep.
 * @param {unknown} detach the `--detach` flag
 */
function cmdPruneMarkers(detach) {
	/*
	 * `--detach` is the SessionStart registration, and it does no sweeping:
	 * it launches a `prune-markers` of its own and returns (mantahostels#1899).
	 *
	 * The sweep's cost tracks the backlog, not the session — it stats
	 * every observation record, and collects one pinned blob ref per claim
	 * that has ended — so it runs against a 10 s hook budget it cannot be
	 * shown to fit inside. Nothing in the starting session reads a byte of
	 * this: the sweep prints nothing, and it drains the store for the
	 * session AFTER this one. The same reasoning, and the same outliving
	 * launch, as session-start-sweeps.sh's (mantahostels#1251, #4706).
	 */
	if (detach) return detachPrune();
	// Which families, and the order the pin-holding ones have to run in:
	// arbiter-store.js's SWEPT_FAMILIES and pruneAll (mantahostels#1796).
	//
	// The oracle goes in as a function, not a reading: it is slow (mantahostels#317),
	// and the store calls it only where something is actually old enough to
	// sweep. sweepSessionIds, NOT listedSessionIds (mantahostels#710): this runs at
	// SessionStart, where the starting session is not yet listed and the
	// strict reader refuses.
	//
	// Wrapped so the detached child leaves a record of having returned: this
	// is the branch --detach spawns, and nothing else can see whether it
	// finished (mantahostels#1910, lib/detached-run.js).
	recordRun(JOB_PRUNE_MARKERS, () => store.pruneAll(sweepSessionIds));
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
		// No positional session id: the set is claimed for the session asking, and
		// every trailing argument is a path, so there is nowhere to put one anyway.
		case "claim-all":
			return cmdClaimAll(rest, sessionId);
		// No positional session id, unlike check/claim/record: those are called by
		// hooks, which are handed the session id in their event JSON and pass it on.
		// Release has no hook — a session runs it for itself — so taking one from
		// argv would only offer a caller an easy way to drop somebody else's claim.
		case "release":
			return cmdRelease(rest[0], sessionId, {
				generator: flags["--generator"] === true,
				notMine: flags["--not-mine"] === true,
			});
		// No positional session id, for release's reason: a session records the
		// issue IT is working.
		case "claim-issue":
			return cmdClaimIssue(rest[0], sessionId);
		case "release-issue":
			return cmdReleaseIssue(rest[0], sessionId);
		// The target session is positional: the caller can move only its own
		// claim.
		case "move-issue":
			return cmdMoveIssue(rest[0], rest[1], sessionId);
		case "issue-claims":
			return cmdIssueClaims();
		// No positional session id, for release's reason: a session waits on its
		// own behalf, and its own claims are what the wait must not count.
		case "wait":
			return cmdWait(rest, sessionId);
		// The refresh-claims core's work after every Bash call, run by hand for
		// a deliberate re-pin; it takes the session id positionally the way the
		// other hook paths do.
		case "refresh":
			return cmdRefresh(rest[0] || sessionId);
		case "writes":
			return cmdWrites(rest[0] || sessionId, flags["--committed"] === true);
		case "own-paths":
			return cmdOwnPaths(rest[0], rest[1], rest[2] || sessionId);
		// The caller is .husky/post-commit, for release-committed's reason.
		case "record-commit":
			return cmdRecordCommit(rest[0], sessionId);
		case "list":
			return cmdList(flags["--all"] === true);
		// The claim block is read whoever holds it; the session id selects the
		// SECOND block — this reader's own observation of the path (mantahostels#2374). It comes
		// from the env, never argv, because every caller is the reader itself.
		case "versions":
			return cmdVersions(rest[0], sessionId);
		// Always 0: a session start must not break on housekeeping.
		case "prune-markers":
			return cmdPruneMarkers(flags["--detach"]);
		// No positional session id, for release's reason: the slot is claimed for
		// the session doing the allocating and nobody else.
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
		// The third and fourth positionals are the EDIT ANCHOR — Edit's own
		// old_string, which is what places the write in a `### B<n>` entry (mantahostels#970) —
		// and its ORIGINAL length, which says whether the guard truncated it.
		// Write and NotebookEdit carry neither, and a whole-file write claims the
		// whole file.
		//
		// The sixth is the `### B<n>` ids the write INTRODUCES — new_string's
		// headings less old_string's, extracted in jq so nothing can truncate
		// (mantahostels#1424).
		case "check":
			cmdCheck(rest[0], rest[1] || sessionId, {
				anchor: rest[2],
				anchorLength: rest[3],
				newIds: rest[4],
			});
			return 0;
		// No positional session id, for release's reason — and the caller is
		// .husky/post-commit, which inherits CLAUDE_CODE_SESSION_ID from the
		// session that ran `git commit`. Every argument after `--commit <full sha>`,
		// which the hook passes and a hand release has none of, is a committed path.
		case "release-committed":
			return rest[0] === "--commit" && FULL_SHA.test(rest[1] ?? "")
				? cmdReleaseCommitted(sessionId, rest.slice(2), rest[1] ?? null)
				: cmdReleaseCommitted(sessionId, rest, null);
		case "record":
			return cmdRecord(rest[0], rest[1] || sessionId);
	}
	return refuseUnhandled();
}

/** @type {number|Promise<number>} */
let code = 0;
try {
	code = main(process.argv.slice(2));
} catch (e) {
	// Fail open (mantahostels#103 §6).
	store.logError(process.argv.slice(2).join(" "), e);
	code = 0;
}
// `wait` alone returns a promise; every other subcommand still exits in the
// same tick, which lib/run-in-process.js relies on. The wait's fault exits 1,
// never the fail-open 0, which is RELEASED's code and would wake the session
// onto an issue still claimed.
if (typeof code === "number") process.exit(code);
else
	code.then(
		(c) => process.exit(c),
		(/** @type {unknown} */ e) => {
			store.logError(process.argv.slice(2).join(" "), e);
			process.exit(1);
		},
	);
