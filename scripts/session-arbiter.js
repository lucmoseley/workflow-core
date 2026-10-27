#!/usr/bin/env node
/*
 * session-arbiter.js — the file-claim CLI.
 *
 * THE SUBCOMMANDS ARE THE WHOLE PRODUCTION INTERFACE (mantahostels#158).
 * This file exports NOTHING. lib/file-claim.js calls `check`,
 * concision-backstop.sh calls `writes`, lib/code-signal.sh calls `own-paths`,
 * settings.json calls `prune-markers --detach`, and a session calls `release`,
 * `debt` and `wait` (#540) for itself. stale-write-back-gate.sh, a pre-commit
 * gate, calls `stale-check --staged`; `accept-head` is that gate's escape,
 * which a session runs for itself;
 * .husky/post-commit calls `release-committed`, `advance-bases` and
 * `record-commit`.
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
 * IMPLICIT:  wired at SessionStart as `prune-markers --detach`, which records HEAD as the session's fallback base (#110) and launches a detached `prune-markers` and returns at once; that child sweeps EVERY session's expired markers, breaks, observations, snapshots, pinned blob refs, wants, requests, issue claims, bases and accept-head logs — not just this session's.
 * JUSTIFIED: fail-safe — each record pins a git blob open, so an unswept store grows without bound; a run that cannot tell live from finished deletes nothing.
 * DEFEAT:    `--detach` is the registration's only flag and changes who runs the sweep, never what it sweeps; the sweep always exits 0.
 */

const {
	listedSessionIds,
	sweepSessionIds,
} = require("./lib/agent-liveness.js");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./lib/arbiter-store.js");
const waitMod = require("./lib/arbiter-wait.js");
const toolRecord = require("./lib/arbiter-tool-record.js");
const { parseOrCode } = require("./lib/cli-args");
const {
	recordRun,
	JOB_PRUNE_MARKERS,
	JOB_DEBT_SWEEP,
} = require("./lib/detached-run.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { caught } = require("./lib/caught.js");
const { readOwnPaths } = require("./lib/own-work.js");
const { FULL_SHA } = require("./lib/commit-sha.js");

/* How this CLI's own output names it, at the plugin root in an install (#1110). */
const ARBITER = scriptPath("session-arbiter.js");

/**
 * Launch a `prune-markers` of our own, detached, and return 0 at once (mantahostels#1899).
 *
 * setsid for sweep-debts-detached.sh's reason: a plain background child stays
 * in the hook shell's process group, so a harness that kills the group on
 * timeout kills the sweep mid-pass — which is the very failure this exists to
 * end. A machine without setsid falls back to a plain detached spawn.
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
		const { spawn } = require("node:child_process");
		const setsid = spawnable("setsid");
		const child = setsid
			? spawn("setsid", [process.execPath, __filename, "prune-markers"], {
					detached: true,
					stdio: "ignore",
				})
			: spawn(process.execPath, [__filename, "prune-markers"], {
					detached: true,
					stdio: "ignore",
				});
		child.unref();
		/* An ENOENT on the spawn itself surfaces asynchronously, so it is caught
		 * here rather than by the try above — and swallowed, for the same reason
		 * the sweep's own faults are: nothing waits on this. */
		child.on("error", () => {
			/* nothing waits on the sweep */
		});
	} catch {
		/* no node, no setsid, no fork budget — the next session start retries */
	}
	return 0;
}

/**
 * The `session_id` of the hook event JSON on stdin, or "" — for a hook whose
 * environment carries no CLAUDE_CODE_SESSION_ID. A terminal is never read: it
 * would wait on the keyboard. RESIDUAL: a non-TTY stdin held open with no EOF
 * blocks here until the hook's own timeout; the harness closes it.
 */
function readHookSessionId() {
	if (process.stdin.isTTY) return "";
	try {
		const id = JSON.parse(fs.readFileSync(0, "utf8")).session_id;
		return typeof id === "string" ? id : "";
	} catch {
		return "";
	}
}

/** Whether `bin` is on PATH, answered without running it. */
/** @param {string} bin */
function spawnable(bin) {
	const { spawnSync } = require("node:child_process");
	return (
		spawnSync("command", ["-v", bin], { shell: true, stdio: "ignore" })
			.status === 0
	);
}

/**
 * The store's own shapes, borrowed rather than restated: a record described in
 * two places drifts in one of them.
 * @typedef {import("./lib/arbiter-store.js").LockRecord} LockRecord
 * @typedef {import("./lib/arbiter-store.js").Identity} Identity
 * @typedef {import("./lib/arbiter-store.js").DebtRecord} DebtRecord
 * @typedef {import("./lib/arbiter-store.js").BreakRecord} BreakRecord
 * @typedef {import("./lib/arbiter-store.js").ListedLock} ListedLock
 * @typedef {import("./lib/arbiter-store.js").ClaimResult} ClaimResult
 * @typedef {import("./lib/arbiter-records.js").OwnHunks} OwnHunks
 * @typedef {import("./lib/arbiter-store.js").RequestRecord} RequestRecord
 * @typedef {import("./lib/arbiter-store.js").IssueClaimRecord} IssueClaimRecord
 */

/**
 * @typedef {any} WantRecord One waiter's record, as `store.readWants()` hands
 * it back. `any` because it is JSON.parse's output, unvalidated, and no record
 * typedef names a want's shape; only `sessionId`, `wants` and `since` are read.
 */
const regions = require("./lib/doc-map-regions.js");
const { DATA_FILES, parseHighWaterMark } = require("./lib/doc-map.js");

/*
 * NOT ON THE HOOK PATH. cmdCheck stays on the bare id: the oracle costs ~465 ms,
 * which mantahostels#411 bars from a PreToolUse hook, and that hook runs on every Write and
 * Edit.
 *
 * A refusal degrades to the id.
 */
/*
 * ONE ORACLE READ FOR THE WHOLE PROCESS, and every field a report needs comes
 * off it. `oracle-cache.js` is single-flight, not a plain cache (mantahostels#1960), so a
 * second reader here would pay a second ~465 ms spawn rather than a hit.
 * `wait` alone replaces it, every 30 s, its command outliving any one read.
 */
/** @type {ReturnType<typeof listedSessionIds>|undefined} */
let listedMemo;
function listedOnce() {
	if (listedMemo === undefined) listedMemo = listedSessionIds();
	return listedMemo;
}
/** `wait`'s re-read, kept as the memo so a verdict naming the holder pays no second read. */
function relistSessions() {
	listedMemo = listedSessionIds();
	return listedMemo;
}

function holderNames() {
	return listedOnce().names || null;
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
		(id && names?.get(id)) || id || "an unidentified session";
}

/** When a holder hears a request: every requester-facing text says it so (#855). */
const HOLDER_HEARS =
	"at its own next write to the file, or its release of it, or at its next turn, where the delivery mod runs";

/**
 * The delivery mod's `held-requests` notice for `rel`: the hook write path's,
 * word for word and said once with it (#855).
 * @param {string} rel the subject held
 * @param {string|null} sessionId the holder
 * @param {(id: string|null) => string} nameOf store.registryNames(), never
 *   nameResolver(): its docstring holds why
 */
const writeNotice = (rel, sessionId, nameOf) =>
	store.buildRequestNotice(rel, sessionId, {
		nameOf,
		dirty: () => store.subjectDirty(rel) === true,
	});

/**
 * The request notice due to the holder of `subject` (mantahostels#1783), null where
 * none is.
 *
 * NAME RESOLUTION IS LAZY. `nameResolver()` reads the ~465 ms liveness oracle
 * (mantahostels#317), and the common case is no request standing, so it is called from
 * inside the store's formatter rather than before the read that decides
 * whether there is anything to format.
 * @param {string} subject
 * @param {string|null} sessionId
 * @param {{dirty: () => boolean, freed?: boolean,
 *   resolve?: () => (id: string|null) => string}} opts `freed`: the caller
 *   has just given the subject up; `resolve`: the route's name resolver
 */
function requestNoticeFor(
	subject,
	sessionId,
	{ dirty, freed = false, resolve = nameResolver },
) {
	/** @type {((id: string|null) => string)|null} */
	let nameOf = null;
	return store.buildRequestNotice(subject, sessionId, {
		nameOf: (id) => {
			nameOf ??= resolve();
			return nameOf(id);
		},
		dirty,
		freed,
	});
}

/**
 * THE RELEASE STEP (#1487), shared by `release` and `release-committed`: the
 * request notice owed on a subject this session has just released or tried
 * to, and — where the path is now free — every request against it dropped, so
 * none survives to reach the next holder, who inherits no obligation
 * (mantahostels#1702 story 17).
 *
 * The notice is read BEFORE the drop, which destroys the record: a request
 * unheard here is unheard for ever (mantahostels#1783).
 *
 * A WHITELIST of the verdicts this session is the holder on, never a
 * blacklist of the ones it is not. --force reaches six more verdicts of its
 * own, and on every one of them the claim belongs to somebody else: a
 * blacklist hands the forcing session another session's `why` line and tells
 * it to release a file it has no claim on.
 *
 * `dirty` is read off the verdict, never re-asked of git: `released` proves
 * the file clean, since release() refuses a dirty one. `uncheckable` and
 * `contended` are unknown, and answer false rather than guess — the park
 * line is an offer, and a wrong one costs more than a missing one. Never
 * hardcoded false either: it is what puts `release --park` in the notice, and
 * `firstSay` mints the dedupe marker as it prints, so a notice short of it is
 * the only one that will ever be said.
 * @param {string} rel
 * @param {string|null} sessionId
 * @param {string} verdict release()'s or forceRelease()'s
 * @param {boolean} force
 * @returns {string|null} the request notice
 */
function releaseStep(rel, sessionId, verdict, force) {
	const notice =
		!force && HOLDER_VERDICTS.includes(verdict)
			? requestNoticeFor(rel, sessionId, {
					dirty: () => verdict === "dirty",
					freed: verdict === "released",
				})
			: null;
	if (verdict === "released" || verdict === "forced") store.dropRequests(rel);
	return notice;
}

/**
 * THE ONE CONVENTION FOR WRITING A SESSION BY NAME (mantahostels#2452): the name leads and
 * the id follows in parentheses (`docs/working-contract.md`).
 *
 * `name` is null for a session with no title. parkFirst's resolver hands the id
 * back unchanged in that case, so it passes null rather than the id — otherwise
 * the id would render twice.
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
 * How a denial names its holder, so the message says who to go and ask.
 *
 * The null limb is UNVERIFIED and, from the CLI, unreachable: every verdict
 * that reaches a call here carries a lock. It is typed in because ClaimResult
 * cannot say which verdicts those are, and this file exports nothing, so no
 * test can drive the limb that would prove it.
 * @param {LockRecord|null} lock
 * @param {Map<string, string>|null} [names]
 */
function describeHolder(lock, names = holderNames()) {
	const id = lock?.sessionId;
	return describeSession(id, (id && names?.get(id)) || null, lock ?? {});
}

/**
 * @param {string} rel
 * @param {LockRecord} lock
 * @param {Map<string, string>|null} [names]
 */
function buildDenyReason(rel, lock, names) {
	/*
	 * The subject actually HELD, which is not always the one asked for
	 * (mantahostels#970): a neighbour holding the whole of docs/doc-map.md blocks a claim on one
	 * `### B<n>` entry of it. Every command below has to name the held one, or a
	 * denied session is sent to force-release a region nobody holds.
	 */
	const held = lock?.path || rel;
	const blocked =
		held === rel ? "" : `${rel} cannot be claimed while it is covered: `;
	return (
		`${blocked}${held} is held by session ${describeHolder(lock, names)}, which is still running. Wait on it, in the background: node ${ARBITER} wait ${held}\n` +
		`Do not ask the founder whether to wait. It exits when the holder releases, dies or finishes — a holder mid-write releases in a median 13-15 s (mantahostels#1682) — at once if the holder waits on something you hold (DEADLOCK: the hold-while-waiting mantahostels#1406 bans), or after ${WAIT_CEILING_S / 60} minutes, naming the next move each time.\n\n` +
		"A claim is taken by writing the file and runs until the holder releases it, its own commit lands all its hunks, or its process ends. A clean `git status` alone does not mean this file is free: a file reads clean between one session's own writes (mantahostels#66, an incident in its closing comment — its title names other work).\n\n" +
		`WHILE IT RUNS, take another subject — the majority recovery path (mantahostels#1682). Read what is held — node ${ARBITER} list — and do a different part of your ticket that does not touch ${held}, or end your turn: the wait's exit wakes you. Should the edit stay undone, record it as a debt below before you finish.\n\n` +
		`The escape (mantahostels#411), which the wait names on HOLDER-ENDED, for a holder that has finished while its host runs on — not for one mid-edit, which this denial cannot tell apart:\n  node ${ARBITER} release --force ${held}\n` +
		"It refuses while `claude agents --json` still reports the holder live (mantahostels#1682), and refuses on an oracle it cannot read — never a release on doubt. It refuses too on a dirty file, on one whose cleanliness git cannot confirm, on a claim store it cannot read, and on a claim that changed underneath it. Every force writes a break record and pins the holder's last bytes for a week, so their version comes back with `git cat-file -p <sha>`.\n\n" +
		`LAST, where the wait hit its ceiling with the claim still held: ask its holder, in band (mantahostels#1702).\n  node ${ARBITER} request ${held} "<one line on why you want it>"\n` +
		`That records a courtesy the holder reads ${HOLDER_HEARS}. It wakes nobody and you must NOT wait on the request — see whether it was answered with \`node ${ARBITER} requests\`.\n\n` +
		`If any of those gets you the file: make your edit, then clear the stub this denial already wrote — node ${ARBITER} debt clear ${rel} unowned.\n\n` +
		`Otherwise: abandon this one edit, finish the rest of your ticket, and record the blocked edit as a visible debt. Complete that same stub with the issue that now owns the work:\n  node ${ARBITER} debt own ${rel} <issue> "<one line on the edit you did not make>"\n\n` +
		"If the holder is wedged rather than working, kill it — its claim clears the moment its process does."
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

/**
 * The same report addressed to a reader who is NOT the claimant — the --force
 * paths, where the recoverable bytes are somebody else's (mantahostels#420).
 *
 * It names `content.by`, the claim the pin was taken against, NEVER the lock
 * handed back: on `contended` that lock is the replacement, whose holder never
 * wrote these bytes.
 * @param {string} rel
 * @param {{by: string|null, was?: string|null}} content
 */
function foreignClobberHeadline(rel, content) {
	const whose = content.by
		? `its claimant ${content.by}`
		: "the claim that held it";
	return `${rel} no longer holds what ${whose} last wrote: something reached it by a route no hook watches — ${CLOBBER_ROUTES}.`;
}

/**
 * That headline, plus a recovery command for a reader with no break record.
 * @param {string} rel
 * @param {{by: string|null, was?: string|null}} content
 * @param {string} closing
 */
function buildForeignClobberNotice(rel, content, closing) {
	return (
		`${foreignClobberHeadline(rel, content)}\n\n` +
		`That version is recoverable:\n  git cat-file -p ${content.was} > /tmp/recovered\n\n` +
		closing
	);
}

/**
 * What a force leaves behind (mantahostels#411): who lost the claim, who took it, and how to
 * get their version back. The holder is told the same thing by buildBreakNotice on
 * its next write to the path, if it ever makes one — this is the copy for the
 * person doing the forcing, who is the one about to overwrite the file.
 * @param {string} rel
 * @param {LockRecord|null} lock
 * @param {Identity} me
 * @param {BreakRecord|null} record
 */
function buildForcedNotice(rel, lock, me, record) {
	const pinned = record?.blob ?? lock?.blob ?? null;
	return (
		`The claim on ${rel} was broken, not handed over: session ${lock?.sessionId ?? "an unidentified session"} never released it and is not listed as live.\n\n` +
		`Broken by ${me.sessionId || "an unidentified session"}${record ? "" : ` — and the break record would NOT write, so the holder will never be told and the recovery below is not pinned. See: node ${scriptPath("check-guard-errors.js")}`}.\n\n` +
		(pinned
			? `What that session last wrote is recoverable for a week:\n  git cat-file -p ${pinned} > /tmp/recovered\n\nDiff it against the file before you overwrite anything.`
			: "What the file held was never recorded against that claim, so there is nothing to recover here — look for a committed copy before overwriting.")
	);
}

const CLOBBER_AT_WRITE =
	"This write is about to replace what is there now. Diff the recovered copy against the file before you continue.";

const CLOBBER_AT_RELEASE =
	"Whatever recorded those bytes — a claim, or the observation an unclaimed writer gets (mantahostels#2333) — is dropped either way. Diff the recovered copy against the file, and do it now: the pin went with the record, so git will prune that object in a fortnight.";

const CLOBBER_AT_REFUSED_RELEASE =
	"The release below refuses, so the claim and its pin both stand: the recovered copy keeps, rather than starting git's fortnight. Diff it against the file before you write to the path again.";

const CLOBBER_AT_FORCED_RELEASE =
	"The recovery below is that version, not what is on the disk now and not yours. Diff both before you write.";

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
					`  node ${ARBITER} release ${rel}`,
			],
		};
	};

	let text;
	try {
		text = fs.readFileSync(path.join(store.paths.repoRoot(), rel), "utf8");
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
	// The notice belongs to the CALLER, not here: this set may yet be refused,
	// and telling a denied session to release claims it does not hold is the one
	// thing worse than saying nothing. cmdCheck says it past the deny branch.
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
	`This write claims ${subjects.length} regions of ${store.splitSubject(file).rel}, not one — the anchor straddles them, so the write holds every region it rewrites, and takes them all or none.\n\n` +
	"Release them as soon as you are done:\n" +
	subjects.map((s) => `  node ${ARBITER} release ${s}`).join("\n");

/**
 * What a whole-file Write to a REGIONED path is told (mantahostels#2334) — SAID, like
 * buildStraddleNotice above and for mantahostels#970's reason.
 *
 * NOT logged, unlike the fallback claimSubjects falls to.
 *
 * PUSHED PAST THE DENY BRANCH, where buildStraddleNotice is pushed and for its
 * reason.
 * @param {string} rel
 */
const buildWholeFileWriteNotice = (rel) =>
	`This write claims the WHOLE of ${rel}, not one region of it: it carries no anchor to place, so it takes every region and blocks every other session on it until this one ends or releases it.\n\n` +
	"A Write or a NotebookEdit belongs here — each rewrites the file entire. An Edit does not: it takes ONE region off its own anchor, so if this WAS an Edit its anchor could not be read (the file-claim guard drops one it cannot read), and making it again should narrow the claim.\n\n" +
	"Release it as soon as you are done:\n" +
	`  node ${ARBITER} release ${rel}`;

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
			`This write adds ${missing.join(", ")} to ${file}, and this session holds no claim on ${missing.length > 1 ? "those ids" : "that id"}. An id and its append slot are taken together, so two sessions appending at once cannot both pick the same number — and a duplicate \`### B<n>\` cannot be renumbered away (mantahostels#892):\n  node ${ARBITER} alloc-entry ${file}\n\n` +
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
 * The hook path. Prints the PreToolUse JSON and always exits 0: a deny is
 * carried by permissionDecision, so a non-zero exit here would mean the guard
 * itself broke.
 *
 * `newIds` is the `### B<n>` ids this write introduces (mantahostels#1424).
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {{ anchor?: string|null, anchorLength?: string|number|null,
 *   newIds?: string|null }} [edit]
 */
function cmdCheck(filePath, sessionId, { anchor, anchorLength, newIds } = {}) {
	if (filePath === undefined) throw new Error("check needs a path");
	const file = store.relativeToRepo(filePath);
	// The WATCHED union, not the refusing tier: a scripts/ path takes a claim so
	// its content is recorded, and is never denied on one (mantahostels#287, mantahostels#295).
	if (file === null || !store.isWatched(file)) return;

	// Every note rides one emission: a second JSON object on stdout is a second
	// hook response, and only one is read. Opened HERE rather than after the deny
	// branch, because a whole-file fallback has to be said on a denial too — that
	// is the case where knowing which claim was taken matters most.
	const { subjects, notes } = claimSubjects(file, anchor, anchorLength);

	const me = store.identify(sessionId);
	// ALL-OR-NONE, through the seam claim-all runs on (mantahostels#1406, reached from the
	// hook at mantahostels#1685). Every arm but the straddling one hands over a single
	// subject, where this is a plain acquire and the deny path below is
	// unchanged; a straddling edit's pair is rolled back rather than half-held.
	// store.registryNames, never nameResolver: its docstring holds why.
	const { taken, blocked, notices } = takeSet(subjects, me, {
		resolve: store.registryNames,
	});
	// The notices below are FILE-level facts — this file's dirt, its debts, the
	// bytes a clobber would take — and a straddling write's subjects are regions
	// of one file, so they are read off the first of them rather than repeated
	// per region. `lock` is the one whose pin answers for the file's content.
	//
	// RESIDUAL: `verdict` is per SUBJECT. A straddling pair whose first region is
	// reentrant and whose second is freshly claimed reads as reentrant, so the
	// dirt notice is skipped — which is the once-per-session-per-file budget it
	// is gated to anyway, reentrant meaning this session wrote that region
	// earlier and was told then. The three facts that are NOT the primary's to
	// answer are read per subject: the want below, the debts, and the
	// unreadable-store report.
	const primary = blocked ?? taken[0];
	if (primary === undefined)
		throw new Error(
			`takeSet took nothing of ${subjects.join(", ")} and refused nothing`,
		);

	// The break notices ride into the deny branch: a session whose claim was
	// broken is usually refused the file by whoever broke it, so a notice only
	// the notes carry is one it never sees (mantahostels#349).
	const broken = notices.broken.join("\n\n") || null;

	if (blocked) {
		denyWrite(notes, broken, subjects, blocked);
		return;
	}

	if (broken) notes.push(broken);
	notes.push(...subjectNotes(file, subjects, anchor, primary.verdict));
	// The request notice (mantahostels#1783) rides here as well as on `claim`, because a
	// notice only there would reach a script and never an ordinary session
	// writing the file.
	notes.push(...notices.requests);
	notes.push(...writeClobberNotes(primary, me.sessionId));
	notes.push(...uncheckedNotes(notices.unchecked));

	// After the deny branch, so a write that never happens is never warned about
	// the ids it would have added.
	notes.push(...unallocatedEntryNotes(file, newIds, me.sessionId));
	notes.push(...notices.debts);
	notes.push(...dirtyUnclaimedNotes(primary));

	if (notes.length > 0) {
		writeStdout(
			`${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					additionalContext: notes.join("\n\n"),
				},
			})}\n`,
		);
	}
}

/**
 * THE deny path, not a second one: `claim` is what a script calls, and this
 * is what the Write/Edit hook calls, so a register fed only by `claim`
 * records almost nothing (mantahostels#1195). takeSet writes the want and the
 * denial that feed it.
 *
 * A straddling write took nothing at all, so it is told that rather than
 * being left to think it holds the region the refusal does not name.
 * @param {string[]} notes
 * @param {string|null} broken
 * @param {string[]} subjects
 * @param {Refused} blocked
 */
function denyWrite(notes, broken, subjects, blocked) {
	const set =
		subjects.length > 1
			? `None of the ${subjects.length} regions this write straddles was claimed — they go together, so ${buildPutBackLine(blocked)}. Narrow the edit to one region, or make it again once the claim above clears.${buildStuckLine(blocked)}`
			: null;
	writeStdout(
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: [
					...notes,
					broken,
					buildDenyReason(blocked.rel, blocked.lock, null),
					set,
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		})}\n`,
	);
}

/**
 * Which subject the write took, said where it is not the obvious one. Past the
 * deny branch, so every subject named here really is held.
 * @param {string} file
 * @param {string[]} subjects
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
 * The read path fires on a fresh claim only, never a reentrant one, so the
 * gh lookup costs at most once per session per subject rather than once per
 * keystroke. PER SUBJECT and not off the primary: a debt is registered
 * against the region a denial refused, so a straddling pair's second region
 * carries debts the first knows nothing about.
 * @param {Acquired[]} taken
 */
function freshDebtNotes(taken) {
	/** @type {string[]} */
	const notes = [];
	for (const t of taken.filter(
		(x) => x.verdict === "claimed" && store.isGuarded(x.rel),
	)) {
		const debt = store.buildDebtNotice(t.rel);
		if (debt) notes.push(debt);
	}
	return notes;
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
		store.isGuarded(rel) &&
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
		const text = fs.readFileSync(
			path.join(store.paths.repoRoot(), rel),
			"utf8",
		);
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
		? near.filter((id) => Number(id.slice(1)) < Number(asked[1])).length
		: 0;
	const from = Math.max(0, below - REGIONS_SHOWN + 2);
	const window = near.slice(from, from + REGIONS_SHOWN);
	const shown = window.join(", ");
	const rest = near.length - window.length;
	return (
		`session-arbiter: ${rel} has no region \`${region}\`, so no claim was taken and a write to it would be unprotected.\n` +
		`Its ${asked ? "entries" : "sections"} are: ${shown}${rest > 0 ? `, and ${rest} more` : ""}.\n` +
		"This is a fatal spelling error, not contention: RETRYING WILL NEVER CLEAR IT, so a poll loop must stop on exit 2 and only keep going on exit 1.\n" +
		`A NEW \`### B<n>\` entry takes its id and its claim together, and its slot is not a region yet:\n  node ${ARBITER} alloc-entry ${rel}\n`
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
		`  node ${ARBITER} claim ${regions.SIDECAR_PATH}#${regions.ROW_PREFIX}<path>\n` +
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
		const text = fs.readFileSync(
			path.join(store.paths.repoRoot(), rel),
			"utf8",
		);
		const ids = [...new Set(regions.parseRegions(text, rel).map((r) => r.id))];
		const rows = ids.filter((id) => id.startsWith(regions.ROW_PREFIX));
		// Sorted NUMERICALLY for the range below: document order need not be
		// numeric order, and a range read off the ends of the document would name a
		// pair of ids the file does not run between.
		const entries = ids
			.filter((id) => /^B\d+$/.test(id))
			.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
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
		`session-arbiter: ${rel} is claimed per region, and this claim names none — so it takes the WHOLE file and denies every other session's region claim on it until you release.\n` +
		listing +
		`  One region instead:\n    node ${ARBITER} claim ${rel}#<region>\n` +
		(allocatable
			? `  A NEW \`### B<n>\` entry takes its id and its claim together, and its slot is not a region yet:\n    node ${ARBITER} alloc-entry ${rel}\n`
			: "")
	);
}

/**
 * The script path. mantahostels#103 ruled signal 3's helper must ABORT its caller, not
 * merely record: recording alone would leave docs/roadmap-digest.md — 40 of the
 * last 150 commits, single writer — protected for everyone and from nobody.
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
	const rel = store.relativeToRepo(filePath);
	// The watched union, so a script writing a scripts/ file takes a claim and so
	// gets a content record (mantahostels#295). Only the ABORT is confined to the refusing
	// tier: there is nothing to abort on a tier that refuses nothing.
	if (rel === null || !store.isWatched(rel)) return 0;
	// Before acquire(), so a misspelt region takes no lock at all (mantahostels#1313).
	if (refuseClaimSubject(rel, generator)) return 2;
	const me = store.identify(sessionId);
	// The claim step records the want and the denial BEFORE the denial is
	// printed, so a session that reads the refusal and gives up in the same
	// breath still leaves the record behind.
	const { blocked, notices } = takeSet([rel], me);
	sayEach(notices.broken);
	if (blocked) {
		writeStderr(`session-arbiter: ${buildDenyReason(rel, blocked.lock)}\n`);
		return 1;
	}
	// Exit 0, like every other fail-open: a broken store must not stop a script
	// that writes a tracked doc, or one unreadable directory halts the roadmap
	// pipeline for every session (mantahostels#174).
	sayEach(
		notices.unchecked.map((r) =>
			buildUncheckedLine(r, "this write is unprotected and no claim was taken"),
		),
	);
	sayEach(notices.debts);
	sayEach(notices.requests);
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
 * The claim step's bookkeeping on a real claim.
 *
 * Any claim taken ends this session's wait, whatever it was waiting for: the
 * register holds one record per session, so the wait it describes is over the
 * moment this session is no longer blocked (mantahostels#1195), and a want left standing
 * would show as a WAITING line for a session that has long since moved on.
 *
 * A request is narrower than a want: it dies only when the claim it asked for
 * lands, not on any claim at all (mantahostels#1702 story 5) — this session's request on
 * each subject claimed is answered by the claim itself (mantahostels#1782), and its
 * requests on other paths stand. A subject left `unknown`, or `held` on the
 * detect-only tier, was not claimed and answers nothing (#1487).
 * @param {Acquired[]} taken
 * @param {Identity} me
 * @returns {Acquired[]} the subjects really claimed, in order — the ones a
 *   request notice is owed on
 */
function settleClaims(taken, me) {
	const claimed = taken.filter((t) => isRealClaim(t.verdict));
	if (claimed.length > 0) store.dropWant(me.sessionId);
	for (const t of claimed) store.dropRequests(t.rel, me.sessionId);
	return claimed;
}

/**
 * The claim step's bookkeeping on a refusal: the want and the denial. The
 * register is what turns "held by another session" into a nameable cycle
 * (mantahostels#1195).
 * @param {string} rel
 * @param {Identity} me
 * @param {LockRecord|null} lock the claim that refused it
 */
function settleRefusal(rel, me, lock) {
	store.recordWant(rel, me, lock);
	store.registerDenial(rel, me.sessionId || null);
}

/**
 * The notices a set taken whole is owed: each a list of texts but `unchecked`,
 * which is the subjects themselves — each route words that one its own way.
 * Requests are read AFTER settleClaims dropped this session's own, so a session
 * that asked and then took the file is not handed back its own ask.
 * @param {Acquired[]} taken
 * @param {Acquired[]} claimed
 * @param {Identity} me
 * @param {() => (id: string|null) => string} resolve
 */
function takenNotices(taken, claimed, me, resolve) {
	return {
		debts: freshDebtNotes(taken),
		unchecked: taken
			.filter((t) => t.verdict === "unknown" && store.isGuarded(t.rel))
			.map((t) => t.rel),
		requests: /** @type {string[]} */ (
			claimed
				.map((t) =>
					requestNoticeFor(t.rel, me.sessionId, {
						dirty: () => store.subjectDirty(t.rel) === true,
						resolve,
					}),
				)
				.filter(Boolean)
		),
	};
}

/**
 * THE CLAIM STEP (#1487): every subject in `rels`, or none of them, with the
 * want, request and denial bookkeeping done and the notices due handed back.
 * Every route that takes a claim runs on it — the write hook, `claim`,
 * `claim-all` and `alloc-entry` — and chooses only where to print.
 *
 * Two independent defences:
 *
 *   ALL-OR-NOTHING. A partial set is released before the refusal is reported, so
 *   the caller never leaves this function holding something a neighbour needs.
 *
 *   ONE GLOBAL ORDER. Subjects are sorted, so two sessions asking for an
 *   overlapping set always take them in the same sequence and cannot each hold
 *   the other's next lock. That alone rules out a cycle between two callers,
 *   whatever they ask for.
 *
 * A REENTRANT subject — one this session already held before the call — is kept
 * on a rollback. Dropping it would silently free a region mid-edit, and it was
 * not this call's to take.
 *
 * Break notices are read as each subject is acquired, the refused one and any
 * rolled back included: the record is stamped as it is read, so one read and
 * not handed back is never said. The rest are owed only on a set taken whole.
 *
 * `probe` is the entry allocator's: walking past a held id is no denied write,
 * so it records neither a want nor a debt stub.
 * @typedef {{rel: string, verdict: string, lock: any}} Acquired one subject as
 * this call left it.
 * @typedef {Acquired & {undone: number, fresh: number, stuck: string[]}} Refused
 * the subject that refused the set, and what the rollback managed.
 * @typedef {{broken: string[], debts: string[], unchecked: string[],
 *   requests: string[]}} ClaimNotices
 * @param {string[]} rels sorted and de-duplicated here, not by the caller
 * @param {Identity} me
 * @param {{probe?: boolean, resolve?: () => (id: string|null) => string}} [opts]
 *   `resolve` is the route's name resolver — requestNoticeFor's
 * @returns {{rels: string[], taken: Acquired[], blocked: Refused|null,
 *   notices: ClaimNotices}}
 */
function takeSet(rels, me, { probe = false, resolve = nameResolver } = {}) {
	const order = [...new Set(rels)].sort();
	/** @type {Acquired[]} */
	const taken = [];
	/** @type {string[]} */
	const broken = [];
	/** @type {{rel: string, lock: LockRecord}[]} */
	const fresh = [];
	for (const rel of order) {
		const { verdict, lock } = store.acquire(rel, me);
		taken.push({ rel, verdict, lock });
		const notice = store.buildBreakNotice(rel, me.sessionId);
		if (notice) broken.push(notice);
		// `lock` is null for a claim minted by a session the registry cannot
		// identify, and on takeSubjectLock's give-up path. takeLock guards its own
		// umbrella rollback the same way: an unrollbackable claim is skipped, never
		// dereferenced — the throw would land in main's fail-open and exit 0 with the
		// set half-held, which is the state this function exists to prevent.
		if (verdict === "claimed" && lock) fresh.push({ rel, lock });
		if (verdict !== "held" || !store.isGuarded(rel)) continue;

		const { undone, stuck } = rollBack(fresh);
		if (!probe) settleRefusal(rel, me, lock);
		return {
			rels: order,
			taken,
			blocked: { rel, verdict, lock, undone, fresh: fresh.length, stuck },
			notices: { broken, debts: [], unchecked: [], requests: [] },
		};
	}
	const claimed = settleClaims(taken, me);
	return {
		rels: order,
		taken,
		blocked: null,
		notices: { broken, ...takenNotices(taken, claimed, me, resolve) },
	};
}

/**
 * Roll back only what THIS call took, and only where the lock on disk is
 * still the one it took — the same test takeLock uses on its own umbrella
 * rollback. Nothing was written to these paths between the claim and now,
 * so no unfinished edit can be handed on by dropping them (which is what
 * release refuses a dirty file for).
 * @param {{rel: string, lock: LockRecord}[]} fresh
 */
function rollBack(fresh) {
	let undone = 0;
	/** @type {string[]} */
	const stuck = [];
	for (const t of fresh) {
		const { outcome } = store.dropIfUnchanged(
			t.rel,
			(m) => m.claimId === t.lock.claimId,
		);
		if (outcome === "dropped") undone += 1;
		else stuck.push(t.rel);
	}
	return { undone, stuck };
}

/**
 * How a refusal reports what it put back. Subjects are taken in sorted order, so
 * a refusal on the FIRST one costs nothing to undo: a count that stays at zero
 * is the ordering working.
 * @param {Refused} blocked
 */
const buildPutBackLine = (blocked) =>
	blocked.fresh === 0
		? "nothing had been taken yet"
		: `${blocked.undone} of the ${blocked.fresh} taken by this call ${blocked.undone === 1 ? "was" : "were"} put back`;

/**
 * dropIfUnchanged answers dropped|kept|contended, and only the first is a
 * rollback. Saying "put back" over the other two would send the reader to
 * re-run while still holding them.
 * @param {Refused} blocked
 * @param {string} [prefix] each line of a CLI refusal carries the tool's name
 */
const buildStuckLine = (blocked, prefix = "") =>
	blocked.stuck.length > 0
		? `\n${prefix}could NOT put back ${blocked.stuck.join(", ")} — the lock there is no longer the one this call took. Release ${blocked.stuck.length === 1 ? "it" : "them"} by hand before re-running.`
		: "";

/**
 * All the subjects this session needs, or none of them (mantahostels#1406) — the CLI over
 * takeSet above, which owns the guarantee.
 *
 * A deadlock needs a session to HOLD one subject while WAITING for another. The
 * poll loop `CLAUDE.md` prescribes for a contended path does exactly that, and
 * it was prescribed to reduce deferred debt — trading a countable failure for an
 * unbounded one. This is the way to take several subjects without ever entering
 * that state: every acquisition happens in one call, and a refusal anywhere puts
 * back everything the call took.
 *
 * @param {string[]} filePaths
 * @param {string} sessionId
 */
function cmdClaimAll(filePaths, sessionId) {
	const rels = [
		...new Set(
			/** @type {string[]} */ (
				filePaths
					.map((p) => store.relativeToRepo(p))
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
		// misspelt one is: a set is all-or-nothing, so one unclaimable member
		// stops the set before any lock is taken (mantahostels#2422). `claim-all` has no
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
	const { blocked, notices } = takeSet(rels, me);
	sayEach(notices.broken);
	if (blocked) {
		writeStderr(
			`session-arbiter: ${buildDenyReason(blocked.rel, blocked.lock)}` +
				`\nsession-arbiter: the set was NOT taken — all ${rels.length} subject(s) go together, so ${buildPutBackLine(blocked)}. ` +
				`Re-run the whole command; do not claim the rest and wait for this one.${buildStuckLine(blocked, "session-arbiter: ")}\n`,
		);
		return 1;
	}
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
	// The notices `claim` gives, which this path must not lose:
	// CLAUDE.md steers a contended session here (mantahostels#1195's review).
	sayEach(notices.debts);
	sayEach(notices.requests);
	for (const rel of rels) store.recordWrite(rel, sessionId);
	return 0;
}

/**
 * "Was this lock's holder resumed onto a fresh process?", built once for the
 * whole command (#259). findCycles asks store.whoHolds once per waiter, so a
 * test built per call would re-read the sessions registry once per waiter and
 * log its dark warning that many times over.
 *
 * The memo therefore pins ONE registry snapshot for the command's lifetime: a
 * session that resumes, or ends, between the first lock judged and the last is
 * judged against the state read at the first. So the doubt is sticky in TIME as
 * it is not in subject — the first failed read makes every later overlapping dead
 * lock report UNKNOWN, whatever the registry would say by then. That is the safe
 * direction, and undoing it would cost a registry read per lock.
 *
 * `registryUnreadable` is false until something has actually asked: a walk that
 * never consulted the registry learnt nothing it could be wrong about (#271).
 */
let resumedMemo = /**
 * @type {ReturnType<typeof store.resumedHolderTest>|null}
 */ (null);
const wasResumed = Object.assign(
	(/** @type {string|null} */ sessionId) => {
		resumedMemo ??= store.resumedHolderTest(
			"blocker",
			"the sessions registry could not be read, so a claim held by a resumed " +
				"session reads as free — a blocker is reported as UNKNOWN rather than " +
				"nobody, and no report here says the file is free to take",
		);
		return resumedMemo(sessionId);
	},
	{ registryUnreadable: () => resumedMemo?.registryUnreadable() === true },
);

/** Why a holder reads as UNKNOWN, and the one place to look further (#271). */
const UNKNOWN_HOLDER_WHY =
	"the sessions registry could not be read, so a holder resumed onto a fresh " +
	`process reads as gone. See: node ${scriptPath("check-guard-errors.js")}`;

/**
 * The deadlock walk over one lock snapshot, judged by `resumed` — `wasResumed`
 * unless the caller built its own.
 * @param {any[]} wants
 * @param {any[]} locks
 * @param {IssueClaimRecord[]|null} claims
 * @param {ReturnType<typeof store.resumedHolderTest>} [resumed]
 */
function cyclesOverLocks(wants, locks, claims, resumed) {
	return waitMod.findCycles(
		wants,
		(subject, sessionId) =>
			store.whoHolds(subject, sessionId, resumed ?? wasResumed, locks),
		claims,
	);
}

/** The issue claims as one reading, null where the store would not read whole. */
function issueClaimsReading() {
	const listed = store.listIssueClaims();
	return listed && !listed.why ? listed.claims : null;
}

/**
 * The cycle report, printed under `list`. Diagnosis only: it denies nothing and
 * releases nothing, and a register it cannot read costs the report but never the
 * listing above it (mantahostels#1195).
 * @param {any[]} locks
 */
function reportWaits(locks) {
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
	const holdsOf = (/** @type {string} */ id) => holdingsOf(locks, claims, id);

	const cycles = cyclesOverLocks(wants, locks, claims);
	const inCycle = new Set(cycles.flat().map((w) => w.sessionId));
	for (const ring of cycles) printDeadlock(ring, nameOf, holdsOf);

	const stranded = wants.filter((w) => !inCycle.has(w.sessionId));
	if (stranded.length === 0) return;
	writeStdout("\n");
	for (const w of stranded) {
		const issue = waitMod.issueOfWant(w.wants);
		writeStdout(
			issue === null
				? buildFileWaitLine(w, locks, nameOf)
				: buildIssueWaitLine(w, issue, claims, nameOf),
		);
	}
}

/**
 * Everything one session holds — live files, then issues — for its DEADLOCK line.
 * @param {any[]} locks the listing's locks. `any`, not ListedLock: the filter's
 *   unreadable test does not narrow the union for the map that reads `path`
 * @param {IssueClaimRecord[]|null} claims the issue claims, null where the store would not read
 * @param {string} id
 */
function holdingsOf(locks, claims, id) {
	return [
		...locks
			.filter((l) => !l.unreadable && l.alive && l.sessionId === id)
			.map((l) => l.path),
		...(claims === null
			? ["issue claims UNKNOWN: the issue-claim store could not be read"]
			: claims
					.filter((/** @type {any} read off disk */ c) => c.sessionId === id)
					.map((/** @type {any} */ c) => waitMod.issueWant(c.issue))),
	];
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
		"  Break it: whichever member holds a DIRTY file commits it, which is the only thing that lets that member release (mantahostels#1405).\n" +
			`  Then take the whole set in one call next time — \`node ${ARBITER} claim-all <path>...\` — which holds nothing while it waits (mantahostels#1406).\n`,
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
 * The WAITING line for a session waiting outside any ring on a file.
 * @param {WantRecord} w its want
 * @param {ListedLock[]} locks
 * @param {ReturnType<typeof nameResolver>} nameOf
 */
function buildFileWaitLine(w, locks, nameOf) {
	const found = store.whoHolds(w.wants, w.sessionId, wasResumed, locks);
	if (found?.holder)
		return `WAITING  ${nameOf(w.sessionId)} wants ${w.wants}, held by ${nameOf(found.holder.sessionId)} — which is not itself waiting, so this one ends when that session finishes.\n`;
	if (found?.unknown)
		return `WAITING  ${nameOf(w.sessionId)} wants ${w.wants} — whether anyone still holds it is UNKNOWN: ${UNKNOWN_HOLDER_WHY}\n`;
	return `WAITING  ${nameOf(w.sessionId)} wants ${w.wants} — nobody holds it now, so its next claim will succeed.\n`;
}

/**
 * The request report under `list` (mantahostels#1782), beside WAITING and DEADLOCK.
 * Diagnosis only, like reportWaits: an unreadable register costs this block and
 * never the listing above it.
 * @param {any[]} locks
 */
function reportRequests(locks) {
	const requests = store.readRequests();
	if (requests === null) {
		writeStderr(
			`session-arbiter: the request register could not be read, so whether anyone has asked for a held file is unknown — not nothing. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return;
	}
	if (requests.length === 0) return;
	const nameOf = nameResolver();
	writeStdout("\n");
	for (const r of requests) {
		// The holder is read off the LOCKS, not the record: the claim may have
		// changed hands since the request was made.
		const found = store.whoHolds(r.subject, r.requester, wasResumed, locks);
		/** @type {string} */
		let held;
		if (found?.holder) held = `, held by ${nameOf(found.holder.sessionId)}`;
		else if (found?.unknown)
			held = ` — whether it is still held is UNKNOWN: ${UNKNOWN_HOLDER_WHY}`;
		else held = " — nobody holds it now, so its next claim will succeed";
		writeStdout(
			`REQUESTED  ${nameOf(r.requester)} asks for ${r.subject}` +
				held +
				` (since ${r.since}${r.why ? `: "${r.why}"` : ""})` +
				(r.declined
					? ` — DECLINED by ${nameOf(r.declined.by)}${r.declined.reason ? `: "${r.declined.reason}"` : ""}`
					: "") +
				"\n",
		);
	}
}

/**
 * `release --park`'s first half: set this session's unfinished edit aside so the
 * ordinary release below finds a clean file.
 *
 * WHOLE FILE, even where the subject named a region. Regions tile a claim, not
 * the bytes — there is one file on disk — so parking `docs/doc-map.md#B206`
 * parks every uncommitted change in `docs/doc-map.md`. Said out loud below
 * rather than left to be discovered.
 *
 * Exit 1 on any refusal, and the release does not run: a park that did not
 * happen must not be followed by a release that reports success on a file the
 * caller believes is now empty of their work.
 * @param {string} subject
 * @param {string} sessionId
 */
function parkFirst(subject, sessionId) {
	const rel = store.splitSubject(subject).rel;
	const me = store.identify(sessionId);
	if (readOwnSubjectsOn(rel, me.sessionId).length === 0) {
		writeStderr(
			`session-arbiter: not parking ${rel} — this session holds no claim on it.\n` +
				"--park sets aside YOUR unfinished edit. On somebody else's file it would be a force-release that destroyed the evidence, which is why --force refuses a dirty file too.\n",
		);
		return 1;
	}

	// Nothing to park. Parking a clean file would rewrite it with the bytes it
	// already has, and refusing one would make --park the harder way to release a
	// file that was ready to go. `null` — git could not say — is left to the
	// release below, which has its own answer for an uncheckable file.
	//
	// THE FILE'S dirt, not the subject's, even on a region subject — park writes
	// the whole file, so the whole file is what it must weigh (mantahostels#1405). mantahostels#1434's
	// region test belongs to release, which hands over a claim rather than
	// rewriting bytes; narrowing this gate to it would skip the `shared` refusal
	// below that stops a park destroying a live neighbour's work.
	if (store.gitDirty(rel) !== true) return 0;

	const result = store.park(rel, me);
	if (result.verdict === "parked") {
		writeStdout(buildParkedNotice(subject, rel, result));
		return 0;
	}
	const why = parkRefusalWhy(rel, result);
	writeStderr(
		`session-arbiter: ${rel} was NOT parked — ${why || result.verdict}\n${parkTrailer(subject, rel, result)}`,
	);
	return 1;
}

/**
 * The subjects `sessionId` holds on `rel` — the whole file, its regions, or
 * both. Only ever your own: parking a file you do not hold is a force-release
 * with the evidence destroyed, which is the one thing --force refuses to be.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function readOwnSubjectsOn(rel, sessionId) {
	return (store.readHeldBy(sessionId) ?? []).filter(
		(subject) => store.splitSubject(subject).rel === rel,
	);
}

/** @typedef {ReturnType<typeof store.park>} ParkResult */

/**
 * What a park that happened says: where the bytes went and how to get them back.
 * @param {string} subject
 * @param {string} rel
 * @param {ParkResult} result
 */
function buildParkedNotice(subject, rel, result) {
	return (
		`Parked the uncommitted changes in ${rel}.\n` +
		(result.file
			? `  Your version:  ${result.file}\n  Get it back:   cp ${result.file} ${rel}\n`
			: "") +
		`  ${rel} is now ${result.restored === "HEAD" ? "as HEAD has it" : "gone, as it was untracked"}, so the claim can be released and nobody inherits your edit.\n` +
		(store.splitSubject(subject).region === null
			? ""
			: "  Note: the WHOLE file was parked, not just the region named — regions divide the claim, not the bytes.\n")
	);
}

/**
 * WHICH REGISTER WENT DARK, not merely that one did (mantahostels#2417): each
 * WritersUnknown cause, worded for `rel`.
 * @param {string} rel
 * @returns {Record<string, string>}
 */
function parkUnknownSources(rel) {
	return {
		observations: "the observation register could not be read",
		registry: "the session registry could not be read",
		locks: "the claim store could not be read",
		head: `git could not say what HEAD holds for ${rel}`,
		worktree: `${rel} could not be read from the working tree`,
		region: `one region of ${rel} you hold could not be hashed — it is gone from the working tree, or git would not run`,
	};
}

/**
 * The regions whose bytes no longer match this session's pin, named (mantahostels#2429).
 * @param {ParkResult} result
 */
function driftedRegions(result) {
	return (result.regions || []).join(", ");
}

/**
 * Why a park was refused, by verdict — undefined for a verdict this map lacks.
 * @param {string} rel
 * @param {ParkResult} result
 */
function parkRefusalWhy(rel, result) {
	// THE BLOCKERS BY NAME, through describeSession (mantahostels#2452).
	//
	// store.registryNames(), never nameResolver(): its docstring holds why. It
	// hands the id back unchanged for a session it cannot name, which is passed on
	// as a null name so the id renders once rather than twice. describeSession's
	// "an unidentified session" limb is unreachable from here, otherWritersOn
	// dropping a falsy sessionId on both of its limbs (arbiter-locks.js).
	//
	// **Residual:** no pid is carried here, so a neighbour the registry cannot
	// name has one handle fewer than `list` gives for the same session.
	const nameOf = store.registryNames();
	const others = (result.others || []).map((id) => {
		const name = nameOf(id);
		return describeSession(id, name === id ? null : name);
	});
	// The undefined limb is UNREACHABLE while WritersUnknown and this map agree,
	// and is the one place a further cause added to the union would land.
	const unknownSource = parkUnknownSources(rel)[String(result.unknown ?? "")];
	const drifted = driftedRegions(result);
	return {
		shared: `another live session has also written ${rel}: ${others.join(", ")}. Parking would take their uncommitted work with yours.`,
		"own-region-drifted": `every part of ${rel} outside the regions you hold is exactly what HEAD holds, but ${drifted} no longer carries the bytes your own pin records. Park restores HEAD over the WHOLE file, so those bytes go with it.`,
		"writers-unknown": unknownSource
			? `${unknownSource}, so nothing here can say whether another session has also written ${rel}. That is the one to go and check — park stops at the first answer it cannot get, so nothing after it was even consulted.`
			: `one of the registers park reads could not be read, and it did not say which (${result.unknown ?? "cause unrecorded"}) — so nothing here can say whether another session has also written ${rel}, and there is no one place to go and check. Read the arbiter's error log: node ${scriptPath("check-guard-errors.js")}.`,
		uncheckable: `git could not say what HEAD holds for ${rel}, so there is nothing to restore it to.`,
		"unreadable-file": `${rel} could not be read: ${caught(result.error).message}.`,
		"nothing-to-park": `${rel} is neither on disk nor in HEAD — there is no uncommitted change to set aside.`,
		"park-failed": `the park could not be completed: ${caught(result.error).message}.${result.file ? ` Your bytes did reach ${result.file}.` : ""}`,
	}[result.verdict];
}

/**
 * The refusal's trailer: what the refused session can do next.
 * @param {string} subject
 * @param {string} rel
 * @param {ParkResult} result
 */
function parkTrailer(subject, rel, result) {
	const drifted = driftedRegions(result);
	// THREE TRAILERS, AND THE DEFAULT IS THE ONE FOR A VERDICT THIS SESSION CAN
	// CLEAR (mantahostels#2362, mantahostels#2429). A session reaching --park is here because a gate
	// refuses its commit (mantahostels#1405), so "commit or revert the file yourself" names
	// the one act it cannot perform — and on `shared` the bytes in the way are a
	// NEIGHBOUR's, which reverting would destroy. `own-region-drifted` takes a
	// third.
	//
	// TWO SHAPES OF NEIGHBOUR, AND ONLY ONE CAN BE ASKED. `shared` is raised off
	// two registers at once (arbiter-locks.js otherWritersOn), and `request` is
	// addressed to a LOCK holder alone. A neighbour seen only through the
	// observation register wrote from a route that takes no claim, so there is
	// nothing to ask them for and no release for them to perform.
	//
	// **Residual:** nothing makes a holder read or answer a request (mantahostels#1702), and
	// the claimless neighbour has no in-band route at all.
	//
	// AND `list` IS NOT OFFERED WHERE IT WOULD SHOW NOBODY (mantahostels#2453). It walks the
	// LOCK register, so the mantahostels#2333 neighbour — the commonest shape here — never
	// appears in it, and the refusal line above already names them (mantahostels#2397).
	const blockers = result.others?.length ?? 0;
	const claimants = result.claimants?.length ?? 0;
	/** @type {string} */
	let whoHoldsIt;
	if (claimants === 0) whoHoldsIt = "";
	else if (claimants === blockers)
		whoHoldsIt = `  Who holds it:  node ${ARBITER} list\n`;
	else
		whoHoldsIt = `  Who holds it:  node ${ARBITER} list — it lists the ${claimants} of the ${blockers} blockers above that hold a claim; the rest wrote from a route that takes none and never appear there.\n`;
	const askThem =
		`  Ask them to commit or revert it and release: node ${ARBITER} request ${rel} "<why you need it>"\n` +
		`  Read the answer:                              node ${ARBITER} requests\n`;
	const debtLine = `A request does not block you (mantahostels#1406): carry on with the rest of your ticket, and once it is refused or goes unanswered, register the debt — node ${ARBITER} debt own ${rel} <issue> "<gist>"\n`;
	// BOTH CAUSES, NEITHER ASSERTED (mantahostels#2429). The likelier is the session's own
	// write through a window the post-Bash re-pin missed; the other is a
	// neighbour Bash-writing into the region, the blind spot mantahostels#2421's backstop
	// exists for. Nothing here can tell them apart, so both are put, in
	// likelihood order.
	//
	// AND THE SECOND LIMB CARRIES `request` AND THE DEBT (mantahostels#1406), being the
	// `shared` case under another name.
	const driftTrailer =
		"Nothing was moved and the claim stands. The bytes in the way are inside a region YOU hold, and nothing here can say whose they are.\n" +
		"  IF THEY ARE YOURS — a write and this park in one Bash call, or a write from a backgrounded job, neither of which the post-Bash re-pin covers in time — re-pin and park again:\n" +
		`    node ${ARBITER} refresh\n` +
		`    node ${ARBITER} release --park ${subject}\n` +
		`  refresh ASSERTS that what ${drifted} holds now is your own work. On a neighbour's bytes it pins their work as yours and the next park throws it away.\n` +
		`  IF THEY ARE NOT — a neighbour Bash-wrote into ${drifted}, which nothing refuses (mantahostels#1772) — leave the file alone.\n` +
		(claimants
			? askThem
			: `  Nobody holds a claim on ${rel} but you, so there is nobody the arbiter can ask. Take another subject until their work lands in a commit.\n`) +
		whoHoldsIt +
		debtLine;
	/** @type {string} */
	let trailer;
	if (result.verdict === "own-region-drifted") trailer = driftTrailer;
	else if (result.verdict === "shared")
		trailer =
			"Nothing was moved and the claim stands. Only THEY can clear this — it is their uncommitted work in the way, not yours.\n" +
			(claimants
				? askThem
				: `  They hold no claim on ${rel}, so there is nobody the arbiter can ask: they wrote from a route that takes none. Take another subject until their work lands in a commit.\n`) +
			whoHoldsIt +
			debtLine;
	else
		trailer =
			"Nothing was moved and the claim stands. Commit or revert the file yourself, then release.\n";
	return trailer;
}

/**
 * The finished-with-it path (mantahostels#126). Exit 0 when there is nothing of ours left on
 * the path; every refusal exits 1 with its reason on stderr.
 *
 * `generator` is `--generator`, symmetric with the claim's (mantahostels#2428): it waives
 * the dirty refusal on §A of the map alone, whose holder is a generator whose
 * own write made it dirty. It rides `--force` too, and means the same there.
 *
 * `notMine` is `--not-mine`: the holder's word that every uncommitted change
 * left in the file is another session's, taken only where the arbiter could
 * not prove it either way (#2148) — store.release's header.
 * @param {string|undefined} filePath
 * @param {string} sessionId
 * @param {{force?: boolean, park?: boolean, generator?: boolean, notMine?: boolean}} [opts]
 */
function cmdRelease(filePath, sessionId, opts = {}) {
	if (filePath === undefined) return refuseUsage(usageOf("release"));
	// Only `park` is acted on here; the rest ride through to releaseSubject.
	const { park = false } = opts;
	const rel = store.relativeToRepo(filePath);
	if (park && rel !== null && parkFirst(rel, sessionId) !== 0) return 1;
	if (rel !== null && store.splitSubject(rel).region === null) {
		// A bare regioned path means "everything I hold on this file". A session
		// holding three §B entries would otherwise have to remember and spell out
		// all three, and mantahostels#121's whole complaint is that releases get forgotten.
		//
		// THIS SESSION'S OWN, never every lock on the file: walking a neighbour's
		// region claim earns a "not by this session" refusal for a claim the
		// caller never asked about — and under --force it would break every
		// neighbour's region wholesale, which is not what releasing your own file
		// asked for.
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
 * @param {{force?: boolean, generator?: boolean, notMine?: boolean}} [opts]
 */
function releaseSubject(
	filePath,
	sessionId,
	{ force = false, generator = false, notMine = false } = {},
) {
	const rel = filePath === null ? null : store.relativeToRepo(filePath);
	// The watched union: a scripts/ path takes a claim now (mantahostels#295), so its holder
	// must be able to give it back. PLUS the exempt paths, which take no new
	// claim but can still carry one minted before the exemption landed (mantahostels#2103) —
	// gating on isWatched alone would freeze those for ever, returning 0 having
	// dropped nothing while the stranded-claim report went on naming them.
	if (rel === null || !store.isReleasable(rel)) return 0; // never claimed, nothing to drop

	const me = store.identify(sessionId);
	// The oracle is passed unread: it costs ~465 ms (mantahostels#317) and forceRelease calls
	// it only where it decides something.
	const result = force
		? store.forceRelease(rel, me, listedSessionIds, { generator })
		: store.release(rel, me, { generator, notMine });
	const { verdict } = result;

	/*
	 * The request notice's LAST site (mantahostels#1783), AHEAD OF EVERY VERDICT, so
	 * the refusals reach it too: `dirty` is the one a holder most needs it at,
	 * being the verdict that leaves them still holding the file.
	 */
	sayEach([releaseStep(rel, me.sessionId, verdict, force)]);

	/** @type {ReleaseOutcome} */
	const out = { ...result, rel, me, force };
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

/** The verdicts this session is the holder on, which a request notice is owed. */
const HOLDER_VERDICTS = ["released", "dirty", "uncheckable", "contended"];

/**
 * One release()'s or forceRelease()'s answer, with what releaseSubject asked
 * it about.
 * @typedef {ClaimResult & {rel: string, me: Identity, force: boolean}}
 *   ReleaseOutcome
 */

/**
 * The verdicts releaseSubject answers before the observation report: each
 * prints its own outcome and returns the exit code.
 * @type {Record<string, (o: ReleaseOutcome) => number>}
 */
const RELEASE_FIRST = {
	forced: releasedForced,
	"holder-live": (o) => {
		writeStderr(
			`session-arbiter: ${o.rel} is held by session ${describeHolder(o.lock)}, which \`claude agents --json\` still lists as live. The claim stands.\n` +
				"--force is for a claim whose holder has FINISHED and whose host is merely still running; a listed session may be mid-edit, and taking the file from it hands you an unfinished edit to commit under your own message (mantahostels#63).\n" +
				// `wait` first: its want catches as DEADLOCK (#542) the cycle mantahostels#104
				// ruled a bare wait out on and mantahostels#1195 kept a request away from, so a
				// request past its ceiling is safe. RESIDUAL: cmdWait's SIGKILL-stale want.
				`Wait on it in the background, not by asking the founder: node ${ARBITER} wait ${o.lock?.path || o.rel}\n` +
				`Should that end at its ceiling, ask it in band — node ${ARBITER} request ${o.lock?.path || o.rel} "<why>" — then finish the rest of your ticket and record the blocked work as a debt:\n  node ${ARBITER} debt own ${o.rel} <issue> "<one line on the edit you did not make>"\n`,
		);
		return 1;
	},
	"oracle-unreadable": (o) => {
		writeStderr(
			`session-arbiter: ${o.rel} was NOT released — the liveness oracle could not be read, so nothing here can say the holder is finished: ${o.why}.\n` +
				"A stranded claim costs time; a claim broken under a live session costs work (mantahostels#322), so an unreadable oracle refuses rather than guessing.\n" +
				`Three ways on: retry, in case the daemon was momentarily busy; wait for a reboot, which kills every claim of a previous boot by construction; or take the Bash route — \`cp\`, \`tee\`, a \`>\` redirect — which no guard refuses, reading the claims first with \`node ${ARBITER} list\`.\n`,
		);
		return 1;
	},
	"holder-unnamed": (o) => {
		writeStderr(
			`session-arbiter: the claim on ${o.rel} names no session, so the oracle cannot be asked whether its holder is finished, and it is not being called dead on that silence.\n` +
				"Take the Bash route for the edit itself; the lock goes when its holder's process does.\n",
		);
		return 1;
	},
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
 * @param {ReleaseOutcome} o
 */
function releasedForced({ rel, lock, me, record, content, observed }) {
	writeStdout(
		`Force-released ${rel}, claimed by session ${describeHolder(lock)}.\n`,
	);
	// A forcing session may have been writing the file as a second writer, and
	// the record that knew what it wrote has just gone with the force (mantahostels#363).
	if (observed?.state === "changed")
		writeStderr(
			`session-arbiter: ${buildClobberNotice(rel, observed.was, CLOBBER_AT_RELEASE)}\n`,
		);
	// The headline alone, and before the break notice: that notice carries the
	// recovery command this sentence qualifies (mantahostels#420).
	if (content?.state === "changed")
		writeStderr(
			`session-arbiter: ${foreignClobberHeadline(rel, content)}\n\n${CLOBBER_AT_FORCED_RELEASE}\n`,
		);
	writeStderr(
		`session-arbiter: ${buildForcedNotice(rel, lock, me, record ?? null)}\n`,
	);
	return 0;
}

/**
 * `dirty`: the claim stands. The clobber goes FIRST, because the refusal that
 * follows it says to commit or discard, and a clobber makes both of those
 * destructive (mantahostels#337). The verdict is unchanged: still a refusal, still exit 1.
 * @param {ReleaseOutcome} o
 */
function releaseDirty({ rel, lock, content, force, own }) {
	if (content?.state === "changed")
		writeStderr(
			`session-arbiter: ${
				force
					? `${rel} holds neither what its claimant ${lock?.sessionId ?? "an unidentified session"} last wrote nor a committed version: something reached it by a route no hook watches.\n\n` +
						`That claimant's version is recoverable while its claim stands:\n  git cat-file -p ${content.was} > /tmp/recovered\n\n` +
						"The refusal below says to commit or discard. Do neither until you have diffed that copy: committing puts somebody else's bytes under your own message (mantahostels#63)."
					: buildClobberNotice(rel, content.was, CLOBBER_AT_DIRTY_RELEASE)
			}\n`,
		);
	writeStderr(
		force
			? `session-arbiter: ${rel} has uncommitted changes, so the claim stands even against --force.\n` +
					"Read the diff, then commit or revert it, and force again.\n"
			: `session-arbiter: ${rel} ${DIRTY_HEADLINE[own ?? "unjudged"]}, so the claim stands.\n` +
					"Releasing a dirty claim hands the next session your unfinished edit to commit under its own message (mantahostels#63). " +
					"Commit or discard the change, then release. Re-claiming is automatic: your next write to it takes the file back.\n" +
					// Named here or nowhere: a session blocked BY the commit cannot do
					// either of the two things the sentence above asks for (mantahostels#1405).
					`Blocked on the commit itself? \`node ${ARBITER} release --park ${rel}\` sets the edit aside, restores the file and releases, printing how to get the work back.\n` +
					// The third exit, and on one shape the only one: both routes above
					// are unreachable when the dirt is a live neighbour's — committing
					// lands their bytes under your message, and --park refuses on
					// `shared` rather than restoring over them (mantahostels#2318).
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
 * What a non-forced `dirty` refusal says the dirt is, by store.release's `own`;
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
	return `Is every one of them another session's, all of yours already committed? Then \`node ${ARBITER} release --not-mine ${rel}\` releases it on your word — and a change of yours it could not see goes with the file to the next session (mantahostels#63).`;
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
function releaseUnproven({ rel, verdict, content, force }) {
	if (
		content?.state === "changed" &&
		(verdict === "uncheckable" || verdict === "contended")
	)
		writeStderr(
			`session-arbiter: ${
				force
					? buildForeignClobberNotice(rel, content, CLOBBER_AT_REFUSED_RELEASE)
					: buildClobberNotice(rel, content.was, CLOBBER_AT_REFUSED_RELEASE)
			}\n`,
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
 * The two things a refusal can be the LAST chance to say are said as well: a
 * clobber of the holder's own bytes (mantahostels#420), and a request a
 * neighbour left on the file (mantahostels#1783). The one silent exit
 * is a commit with no session behind it, a person's in a terminal.
 * @param {string} sessionId
 * @param {string[]} paths the landed commit's paths, absolute or repo-relative
 */
function cmdReleaseCommitted(sessionId, paths) {
	// Ahead of identify(), which would otherwise log "no live session entry for
	// (no session id)" after every commit a person makes in a terminal.
	if (!sessionId) return 0;
	const landed = new Set(
		paths.map((p) => store.relativeToRepo(p)).filter((rel) => rel !== null),
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
	for (const subject of held) {
		const { rel, region } = store.splitSubject(subject);
		if (!landed.has(rel)) continue;
		if (region !== null) {
			kept.push(
				`Kept ${subject} — a region claim, which a commit never releases; \`node ${ARBITER} release ${subject}\` does.\n`,
			);
			continue;
		}
		const result = releaseLanded(rel, me);
		if (result.verdict === "released") {
			released.push(rel);
			if (result.own === "landed") leftDirty.push(rel);
		} else kept.push(buildKeptLine(rel, result));
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
	sayEach([releaseStep(rel, me.sessionId, verdict, false)]);
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
 * The request notice for every subject this session holds, in the write path's
 * own wording and spending its said-once markers, so a request told here is
 * not told again at the next write within the hour, nor the reverse (#855).
 * The delivery mod runs it, through `deliver-to-session.js --requests`, at the
 * holder's next turn.
 *
 * Exit 1, the reason on stderr, where the claim store cannot be read: which
 * subjects this session holds is then unknown, not none.
 * @param {string} sessionId
 */
function cmdHeldRequests(sessionId) {
	if (!sessionId) return 0;
	try {
		const held = store.readHeldBy(sessionId);
		if (held === null) {
			writeStderr(
				`session-arbiter: held-requests: the claim store could not be read. See: node ${scriptPath("check-guard-errors.js")}\n`,
			);
			return 1;
		}
		const nameOf = store.registryNames();
		const notices = [];
		for (const subject of held) {
			const notice = writeNotice(subject, sessionId, nameOf);
			if (notice) notices.push(notice);
		}
		if (notices.length > 0) writeStdout(notices.join("\n"));
		return 0;
	} catch (e) {
		writeStderr(`session-arbiter: held-requests: ${caught(e).message}\n`);
		return 1;
	}
}

/**
 * #100's stale-write-back rule for one staged path (#111): refuse where the
 * staged blob sits nearer this session's base than HEAD's, which writes back a
 * version a neighbour has since replaced. The rule itself is store.judgeStaged.
 *
 * Not `check`, which is the file-claim guard's. Exit 1 refuses, naming the
 * commits that changed the path since the base and the two ways forward; 0
 * passes, silently, or fails open with one stderr line (mantahostels#103 §6).
 * No session id is the founder's own terminal, never checked.
 * @param {string|undefined} filePath
 * @param {string|undefined} staged the staged blob
 * @param {string} sessionId
 */
function cmdStaleCheck(filePath, staged, sessionId) {
	if (!filePath || !staged) return refuseUsage(usageOf("stale-check"));
	if (!sessionId) return 0;
	const rel = store.relativeToRepo(filePath);
	if (rel === null) return 0;
	return reportStale(rel, store.judgeStaged(rel, sessionId, staged)) ? 1 : 0;
}

/**
 * `stale-check --staged`, the pre-commit gate's call (#113): every path the
 * commit modifies, judged as `stale-check` judges one, so a commit of any size
 * costs one node start. The listing is store.readStagedModifications'.
 *
 * Exit 3 refuses, not 1: node exits 1 itself on a crash main's catch never
 * sees — a half-written module failing to load — and the gate must read that
 * as a fault to fail open on, not as a verdict.
 * @param {string} sessionId
 */
function cmdStaleCheckStaged(sessionId) {
	if (!sessionId) return 0;
	try {
		const staged = store.readStagedModifications();
		if (staged === null) {
			failOpenStale("the commit", "git could not list its staged paths");
			return 0;
		}
		let refused = false;
		for (const { rel, verdict } of store.judgeStagedAll(staged, sessionId))
			if (reportStale(rel, verdict)) refused = true;
		return refused ? 3 : 0;
	} catch (e) {
		const { code, message } = caught(e);
		// main's catch would exit 0 in silence, which the gate reads as a pass.
		failOpenStale("the commit", `the check threw (${code || message})`);
		return 0;
	}
}

/**
 * The one stderr line and the error-log record a fault on the stale-write-back
 * rule gets, the path going through unjudged (mantahostels#103 §6).
 * @param {string} what
 * @param {string} fault
 */
function failOpenStale(what, fault) {
	store.logError(`stale-check ${what}`, new Error(fault));
	writeStderr(
		`session-arbiter: ${what} not checked for a stale write-back, let through: ${fault} (node ${scriptPath("check-guard-errors.js")})\n`,
	);
}

/**
 * Print judgeStaged's verdict on `rel`, and say whether it refused.
 * @param {string} rel
 * @param {ReturnType<typeof store.judgeStaged>} v
 */
function reportStale(rel, v) {
	if (v.verdict === "unknown") {
		failOpenStale(rel, v.fault);
		return false;
	}
	if (v.verdict !== "refuse") return false;
	/** @type {string} */
	let changed;
	if (v.commits === null) changed = "    (git would not list them)\n";
	else if (v.commits.length > 0)
		changed = v.commits.map((c) => `    ${c}\n`).join("");
	else changed = "    (none found between the base and HEAD)\n";
	writeStderr(
		`session-arbiter: refusing ${rel} — the staged version is nearer this session's base (${v.base.head.slice(0, 8)}) than HEAD, so committing it would undo a neighbour's change:\n` +
			changed +
			"  Either re-derive the file from HEAD (regenerate it, or re-apply your edit to HEAD's version),\n" +
			`  or, where the revert is intended, accept HEAD as your base: node ${ARBITER} accept-head ${rel}\n`,
	);
	return true;
}

/**
 * `accept-head` (#112): the escape stale-check's refusal names — HEAD's blob
 * becomes this session's base for the path, and the accept is logged for the
 * founder to audit.
 *
 * Exit 1 where nothing could be accepted, since the commit it was for will
 * still be refused; 2 on usage or no session id, which has no base to move.
 * @param {string|undefined} filePath
 * @param {string} sessionId
 */
function cmdAcceptHead(filePath, sessionId) {
	if (!filePath) return refuseUsage(usageOf("accept-head"));
	if (!sessionId) {
		writeStderr(
			"session-arbiter: accept-head needs CLAUDE_CODE_SESSION_ID — only a session has a base to move, and stale-check never judges a commit without one.\n",
		);
		return 2;
	}
	const rel = store.relativeToRepo(filePath);
	if (rel === null) {
		writeStderr(
			`session-arbiter: ${filePath} is outside this repository, so it has no base.\n`,
		);
		return 2;
	}
	const r = store.acceptHead(rel, sessionId);
	if ("fault" in r) {
		writeStderr(
			`session-arbiter: ${rel} not accepted: ${r.fault}. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	const { oldBase, newBase } = r.entry;
	const was = oldBase ? oldBase.head.slice(0, 8) : "none";
	writeStdout(
		`Accepted HEAD (${newBase.head.slice(0, 8)}) as this session's base for ${rel}, was ${was}. Logged to ${store.paths.acceptedHeads(sessionId)}.\n`,
	);
	return 0;
}

/**
 * `advance-bases` (#114): post-commit's call, making the commit just landed this
 * session's base for every path it touched.
 *
 * 0 but on usage, and silent with no session id; a fault is one stderr line,
 * since the path it left behind can be refused on the session's next commit.
 * @param {string|undefined} commit
 * @param {string} sessionId
 */
function cmdAdvanceBases(commit, sessionId) {
	if (!commit) return refuseUsage(usageOf("advance-bases"));
	if (!sessionId) return 0;
	const { fault } = store.advanceBases(commit, sessionId);
	if (fault)
		writeStderr(
			`session-arbiter: this commit did not become your base everywhere (${fault}), so the stale-write-back gate may refuse your next commit of that path; accept-head is the escape. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
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
 * the reader knows whose bytes they are, and `release --force` already hands a
 * caller a foreign pin the same way (mantahostels#420).
 *
 * THIS SESSION'S OWN OBSERVATION PRINTS BESIDE THE CLAIM'S (mantahostels#2374).
 * @param {string|undefined} filePath
 * @param {string} sessionId
 */
function cmdVersions(filePath, sessionId) {
	if (filePath === undefined) return refuseUsage(usageOf("versions"));
	const rel = store.relativeToRepo(filePath);
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
				? `  Check its permissions (ls -l ${r.file}) and re-run. See: node ${scriptPath("check-guard-errors.js")}\n`
				: `  Its bytes are still there — cat ${r.file} and read the sha out of "blob":"<sha>",\n  then: git cat-file -p <sha> > /tmp/recovered\n`;
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

/**
 * The denied session's courtesy ask (mantahostels#1702, built at mantahostels#1782): record that this
 * session wants `subject`, which a live neighbour holds — without waiting on
 * anything, which is what mantahostels#1406 bans. Every refusal is exit 0 with its reason:
 * a request is never load-bearing, so nothing branches on the code.
 * @param {string|undefined} filePath
 * @param {string|undefined} why
 * @param {string} sessionId
 */
function cmdRequest(filePath, why, sessionId) {
	const rel = filePath ? store.relativeToRepo(filePath) : null;
	if (rel === null) {
		writeStderr(
			`session-arbiter: ${filePath ?? "(no path)"} is not in this repo — no request recorded.\n`,
		);
		return 0;
	}
	if (!store.isWatched(rel)) {
		writeStderr(
			`session-arbiter: ${rel} takes no claims, so there is nobody to ask — no request recorded. Write it; git is what governs it.\n`,
		);
		return 0;
	}
	const me = store.identify(sessionId);
	if (!me.sessionId) {
		writeStderr(
			"session-arbiter: no session id, so a request could not be attributed to anyone — no request recorded.\n",
		);
		return 0;
	}
	const found = store.whoHolds(rel, me.sessionId, wasResumed);
	if (found === null) {
		writeStderr(
			`session-arbiter: the claim store could not be read, so who holds ${rel} is unknown — not nothing (mantahostels#174) — and a request addressed to nobody helps nobody. No request recorded. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 0;
	}
	// THE BLOCKER IS LOOKED FOR FIRST, AND HOLDING COVER OF OUR OWN DOES NOT
	// END THE ASK (mantahostels#2362). "The write is yours to make" answers the case this
	// command was built for — a session DENIED a write — and is false for the
	// other one: `release --park` refuses a file a live neighbour has also
	// written, and is reachable only by a session that holds the path itself.
	const { holder: blocker, own: ownCover, unknown } = found;
	// BEFORE BOTH BRANCHES BELOW (#271), OWN COVER INCLUDED: an overlapping
	// dead-by-pid lock judged against a registry that would not open may be a
	// RESUMED holder, and both of those branches then say the write is safe —
	// "take it instead of asking" to a session with no claim, "the write is
	// yours to make" to one that has its own. Holding cover does not settle it:
	// a region claim is granted while a whole-file lock next to it reads stale,
	// so this session can hold `#B190` while a live neighbour holds the file.
	// There is nobody to address a request to either, so none is recorded — the
	// caller is told the answer is unknown, not that it is no.
	if (!blocker && unknown) {
		writeStdout(
			`Whether anyone else holds ${rel} is UNKNOWN — not nobody (mantahostels#174): ${UNKNOWN_HOLDER_WHY}\n` +
				(ownCover
					? `This session holds ${ownCover.path}, which covers it, but an overlapping claim that could not be judged may be live.\n`
					: "") +
				"No request recorded, and the claim is NOT established as free.\n" +
				`  node ${ARBITER} list --all\n`,
		);
		return 0;
	}
	if (ownCover && !blocker) {
		writeStdout(
			`This session already holds ${ownCover.path}, which covers ${rel} — no request recorded. The write is yours to make.\n`,
		);
		return 0;
	}
	if (!blocker) {
		writeStdout(
			`Nobody holds ${rel} — the claim is free, so take it instead of asking: your next write claims it, or\n  node ${ARBITER} claim ${rel}\n`,
		);
		return 0;
	}
	store.recordRequest(rel, me, blocker.sessionId, why || null);
	writeStdout(
		`Requested ${rel} from session ${describeHolder(blocker)}.\n` +
			`The holder is NOT woken — it is told ${HOLDER_HEARS}, and otherwise never. ` +
			"A request does not block you: carry on with the rest of your ticket, and once it is refused or goes unanswered, record the blocked edit as a debt. " +
			`See whether it has been answered:\n  node ${ARBITER} requests\n`,
	);
	return 0;
}

/**
 * The requester's read of its own outstanding requests (mantahostels#1782): what it asked
 * for, of whom, and whether the holder has answered — *read and refused* being
 * a different fact from *not read yet*.
 * @param {string} sessionId
 */
function cmdRequests(sessionId) {
	const all = store.readRequests();
	if (all === null) {
		writeStderr(
			`session-arbiter: the request register could not be read, so this session's requests are unknown — not nothing (mantahostels#174). See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	const mine = all.filter(
		(/** @type {any} */ r) => sessionId && r.requester === sessionId,
	);
	if (mine.length === 0) {
		writeStdout("No outstanding requests from this session.\n");
		return 0;
	}
	const nameOf = nameResolver();
	// The CURRENT holder, read off the locks — reportRequests' reasoning. The
	// recorded holder is the fallback when the locks cannot be read, labelled
	// as history rather than passed off as now.
	for (const r of mine)
		writeStdout(
			`${r.subject}\t${requestHeldBy(r, nameOf)}\tsince ${r.since}` +
				(r.why ? `\t"${r.why}"` : "") +
				(r.declined
					? `\tDECLINED by ${nameOf(r.declined.by)} at ${r.declined.at}${r.declined.reason ? `: "${r.declined.reason}"` : ""}`
					: "\tunanswered") +
				"\n",
		);
	return 0;
}

/**
 * Who holds what one request asked for, now — or, where the locks would not
 * read, whom it was asked of.
 * @param {RequestRecord} r the request
 * @param {ReturnType<typeof nameResolver>} nameOf
 */
function requestHeldBy(r, nameOf) {
	const found = store.whoHolds(r.subject, r.requester, wasResumed);
	if (found === null)
		return `asked of ${nameOf(r.holder)} (current holder unknown — the claim store could not be read)`;
	if (found.holder) return `held by ${nameOf(found.holder.sessionId)}`;
	if (found.unknown)
		return `asked of ${nameOf(r.holder)} (whether it is still held is UNKNOWN: ${UNKNOWN_HOLDER_WHY})`;
	return "no longer held — your next write claims it";
}

/**
 * The holder's explicit no (mantahostels#1782). Only the current holder may decline a path:
 * anyone else declining would answer for a session that was never asked.
 * @param {string|undefined} filePath
 * @param {string|undefined} reason
 * @param {string} sessionId
 */
function cmdDecline(filePath, reason, sessionId) {
	const rel = filePath ? store.relativeToRepo(filePath) : null;
	if (rel === null) {
		writeStderr(
			`session-arbiter: ${filePath ?? "(no path)"} is not in this repo\n`,
		);
		return 2;
	}
	const me = store.identify(sessionId);
	const found = store.whoHolds(rel, me.sessionId, wasResumed);
	if (found === null) {
		writeStderr(
			`session-arbiter: the claim store could not be read, so whether this session holds ${rel} is unknown — nothing was declined. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	if (!found.own) {
		writeStderr(
			`session-arbiter: this session does not hold ${rel}, so its requests are not yours to decline${heldElsewhere(found)}`,
		);
		return 1;
	}
	const { status, count } = store.declineRequest(
		rel,
		me.sessionId,
		reason || null,
	);
	return reportDecline(rel, status, count);
}

/**
 * Who holds a path this session was asked to decline but does not hold.
 * @param {NonNullable<ReturnType<typeof store.whoHolds>>} found
 */
function heldElsewhere({ holder, unknown }) {
	if (holder) return ` — it is held by session ${describeHolder(holder)}.\n`;
	if (unknown)
		return ` — and who does hold it is UNKNOWN: ${UNKNOWN_HOLDER_WHY}\n`;
	return " — nobody holds it, so there is nothing to decline against.\n";
}

/**
 * Say how a decline went, and its exit code.
 * @param {string} rel
 * @param {ReturnType<typeof store.declineRequest>["status"]} status
 * @param {number} count requests marked
 */
function reportDecline(rel, status, count) {
	if (status === "unreadable") {
		writeStderr(
			`session-arbiter: the request register could not be read, so nothing was declined on ${rel}. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	if (status === "failed") {
		writeStderr(
			`session-arbiter: the register refused the write, so at least one request on ${rel} still reads as unanswered — ${count} ${count === 1 ? "was" : "were"} marked before it refused. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	if (status === "none") {
		writeStdout(`No requests on ${rel} to decline.\n`);
		return 0;
	}
	writeStdout(
		`Declined ${count} request${count === 1 ? "" : "s"} on ${rel}. The requester${count === 1 ? "" : "s"} will see it under \`requests\`; the claim stands.\n`,
	);
	return 0;
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
		writeStdout(`Recorded #${issue} as claimed by session ${me.sessionId}.\n`);
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

/**
 * Drop this session's own claim on an issue. Another session's is left alone.
 * @param {string|undefined} issue
 * @param {string} sessionId
 */
function cmdReleaseIssue(issue, sessionId) {
	if (issue === undefined) return refuseIssue(issue);
	const me = store.identify(sessionId);
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
		writeStdout(`#${c.issue}\t${c.sessionId}\tsince ${c.claimedAt}\n`);
	return listed.why ? 1 : 0;
}

/*
 * `wait`'s verdicts (#540). Each has its own exit code, so a background job's
 * notification says which fired before anything is read. 1 and 2 keep the
 * meanings every other subcommand gives them: a fault, and a usage error.
 */
const WAIT_EXIT = {
	RELEASED: 0,
	"HOLDER-DEAD": 3,
	"NOT-HELD": 4,
	CEILING: 5,
	"HOLDER-ENDED": 6,
	DEADLOCK: 7,
};

// A bound #542 set, not derived: each read costs ~465 ms (mantahostels#317).
const WAIT_ORACLE_EVERY_S = 30;

// A GUESS, unmeasured: above the ~18-minute median wait
// docs/research/waiting-stall-forensics.md §5 found, below the point where
// carrying on and registering the debt is the better move (#535).
const WAIT_CEILING_S = 30 * 60;

// A GUESS too. A poll reads a claim store, /proc and at most the sessions
// registry, so it costs milliseconds; this only bounds how late a release is
// noticed.
const WAIT_POLL_S = Number(process.env.WFC_ARBITER_WAIT_POLL_S) || 2;

/** A fresh registry reading per poll: `wait` outlives any one snapshot. */
const waitResumedTest = () =>
	store.resumedHolderTest(
		"wait",
		"the sessions registry could not be read, so a holder resumed onto a fresh process could not be told from a dead one — the wait goes on",
	);

/**
 * One poll of a file target: `{held}` with the live blocker (and the `locks`
 * and `resumed` test it was judged on), `{free}` with the
 * dead lock still on disk (or null where the claim is gone), or `{doubt}`
 * where neither could be established — `fault` marking a store that would not
 * open, which ends a wait before it starts and only clouds one that is running.
 * @param {string} rel
 * @param {string} sessionId
 * @param {string|null} watched the holder's session id, once one was seen
 */
function pollFile(rel, sessionId, watched) {
	const locks = store.readLocks();
	const resumed = waitResumedTest();
	const found = store.whoHolds(rel, sessionId, resumed, locks);
	if (locks === null || found === null)
		return { doubt: "the claim store could not be read", fault: true };
	const { holder, dead, unknown } = found;
	// The reads ride along so the deadlock walk judges the same snapshot.
	if (holder) return { held: holder, locks, resumed };
	if (unknown) return { doubt: UNKNOWN_HOLDER_WHY };
	return {
		free:
			dead.find((l) => l.sessionId === watched) ??
			(watched ? null : (dead[0] ?? null)),
	};
}

/**
 * One `wait`'s target and its running state, shared by its steps.
 * @typedef {object} WaitRun
 * @property {number|null} issue
 * @property {string|null} rel
 * @property {string} subject
 * @property {number} ceiling seconds
 * @property {Identity} me
 * @property {string} myId
 * @property {any} holder poll's `held`: a LockRecord for a file and an
 *   IssueClaimRecord for an issue, which share only `sessionId`
 * @property {number} oracleDue
 * @property {string|null} oracleDoubt the last oracle read's refusal, for CEILING
 */

/**
 * One poll's reading — `pollFile`'s shape, an issue's `holders` and the
 * `claims` they were read from added.
 * `any`: a held/free value is a LockRecord for a file and an IssueClaimRecord
 * for an issue, which share only `sessionId`.
 * @typedef {{held?: any, free?: any, doubt?: string, fault?: boolean, holders?: any[], claims?: IssueClaimRecord[], locks?: any[], resumed?: ReturnType<typeof store.resumedHolderTest>}} WaitPoll
 */

/**
 * `wait`'s target and ceiling, or the exit code a bad argv ends on — its
 * message printed here.
 * @param {string[]} argv
 * @returns {{code: number} | {issue: number|null, rel: string|null, subject: string, ceiling: number}}
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
	const issue = /^[1-9]\d*$/.test(target) ? Number(target) : null;
	const rel = issue === null ? store.relativeToRepo(target) : null;
	if (issue === null && rel === null) {
		writeStderr(
			`session-arbiter: ${target} is not in this repo, so no claim can hold it.\n`,
		);
		return { code: 2 };
	}
	const subject =
		issue === null ? /** @type {string} */ (rel) : waitMod.issueWant(issue);
	return { issue, rel, subject, ceiling };
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
 * One poll of `wait`'s target, file or issue.
 * @param {WaitRun} w
 * @param {string|null} watched the holder's session id, once one was seen
 * @returns {WaitPoll}
 */
function pollWait(w, watched) {
	if (w.issue === null)
		return pollFile(/** @type {string} */ (w.rel), w.myId, watched);
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
 * Why a target held by nobody has nothing to wait for.
 * @param {WaitRun} w
 */
function notHeldWhy(w) {
	if (w.issue !== null) return "no other session claims it.";
	if (store.isWatched(/** @type {string} */ (w.rel)))
		return "nobody holds it, so your next write claims it.";
	return "it takes no claims at all, so there is nothing to wait for.";
}

/**
 * How a verdict names a holder: one oracle read, paid only at exit.
 * @param {WaitRun} w
 * @param {any} h poll's `held`, for the reason given on WaitRun
 */
function buildWaitHolderText(w, h) {
	if (!h) return "a holder that could not be identified";
	if (w.issue === null) return describeHolder(h);
	return describeSession(h.sessionId, holderNames()?.get(h.sessionId) || null);
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
 * Put `wait`'s own want on the register, naming the holder once one is seen.
 * @param {WaitRun} w
 */
function recordWaitWant(w) {
	store.recordWant(
		w.subject,
		w.me,
		w.holder && {
			sessionId: w.holder.sessionId,
			path: w.holder.path ?? w.subject,
		},
	);
}

/**
 * Drop `wait`'s own want — only where it is still this wait's, so a deny's
 * want on another file stands. An unreadable register drops too: a wait that
 * has ended must not be left listed as WAITING, and that outweighs sparing a
 * deny's want.
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
 * reads where it carries them.
 * @param {WaitRun} w
 * @param {WaitPoll} s a held poll
 */
function ringThroughMe(w, s) {
	const wants = store.readWants();
	const locks = s.locks ?? store.readLocks();
	if (!wants || !locks) return null;
	const cycles = cyclesOverLocks(
		wants,
		locks,
		s.claims ?? issueClaimsReading(),
		s.resumed ?? waitResumedTest(),
	);
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
 * @param {WaitRun} w accumulator: oracleDue and oracleDoubt are advanced
 */
function readOracle(w) {
	w.oracleDue = Date.now() + WAIT_ORACLE_EVERY_S * 1000;
	const listed = relistSessions();
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
	return (
		`still held by ${buildWaitHolderText(w, w.holder)} after ${w.ceiling}s.${doubt} Next: ` +
		(w.issue === null
			? `ask for it — node ${ARBITER} request ${w.subject} "<why>" — or carry on with the rest of the ticket and register the blocked edit as a debt.`
			: "carry on with other work.")
	);
}

/**
 * Each verdict's line after its name, from the run, the poll it fired on and,
 * for DEADLOCK, the ring.
 * @type {Record<import("./lib/arbiter-wait.js").Verdict, (w: WaitRun, state: WaitPoll, ring: WantRecord[]) => string>}
 */
const VERDICT_TEXT = {
	"NOT-HELD": (w) => notHeldWhy(w),
	"HOLDER-DEAD": (w, state) =>
		`${buildWaitHolderText(w, state.free)} has stopped running, so its claim is stale and takeable: your next write claims it.`,
	RELEASED: (w) =>
		w.issue === null
			? `${buildWaitHolderText(w, w.holder)} released it, so your next write claims it.`
			: `${buildWaitHolderText(w, w.holder)} released its claim.`,
	DEADLOCK: (w, _state, ring) =>
		`${deadlockChain(ring, w.myId)} -> held by you. Each waits on the next, so none will release. Next: release or park what you hold — release <path> once committed, release --park <path> to set an edit aside, release-issue <n> — then wait again.`,
	"HOLDER-ENDED": (w) =>
		w.issue === null
			? `${buildWaitHolderText(w, w.holder)} has ended though its process runs on, so its claim is stale. Free it: node ${ARBITER} release --force ${w.holder.path ?? w.subject}`
			: `${buildWaitHolderText(w, w.holder)} has ended, so its claim is stale and nothing will release it. Next: treat the issue as unclaimed.`,
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
		const poll = pollWait(w, w.holder?.sessionId ?? null);
		if (poll.held) w.holder = poll.held;
		if (poll.free === undefined && readOwnWantOf(w.myId) === null)
			recordWaitWant(w);
		const v = waitMod.nextVerdict({
			poll,
			ring: () => ringThroughMe(w, poll),
			terminal: Date.now() < w.oracleDue ? undefined : () => readOracle(w),
			left: () => deadline - Date.now(),
		});
		if (v) return sayVerdict(w, poll, v);
	}
}

/**
 * `wait <path|issue> [ceiling-seconds]` (#540): block until a neighbour's
 * claim on the target frees up, and say how. Run in the background, so its
 * exit is the notification that wakes the session.
 *
 * IT REPORTS AND NEVER ACTS. It breaks, releases and takes nothing: a freed
 * file is claimed by the session's own next write.
 *
 * DOUBT NEVER FREES. A store, registry or oracle that will not read keeps the
 * wait going, and the CEILING line says the last read was doubtful.
 *
 * TWO EARLY EXITS (#542). HOLDER-ENDED is the oracle's `terminal` set — the
 * test `release --force` and `list`'s ENDED apply — and the only liveness an
 * issue claim, carrying no pid, gets. DEADLOCK is `list`'s cycle walk finding
 * this session in a ring.
 *
 * THE WANT is this session's entry in the waiter register, so `list` prints
 * WAITING while this runs. One want per session is the register's shape, so a
 * claim the session takes meanwhile drops it (cmdCheck) and the next poll puts
 * it back; a deny on another file since then is left standing, being the truer
 * statement of what blocks. RESIDUAL: a SIGKILL skips the drop, and the want
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

	const state = pollWait(w, null);
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
 * What is claimed. LIVE claims only by default (mantahostels#1814): a STALE row refuses
 * nothing — the guard denies only on a live holder, and a resumed holder counts
 * as alive (arbiter-store.js's resumedHolderTest), so hiding them hides nothing
 * that would have blocked the reader.
 *
 * An unreadable lock row is NOT a dead one and stays in both views: liveness
 * could not be judged, so it cannot be judged absent.
 *
 * reportWaits and reportRequests are handed the WHOLE list either way — a
 * deadlock ring and a request both describe holders, and filtering the input
 * would silently change what they say.
 *
 * RESIDUAL: every other site in the repo naming this command names the bare
 * `list`, and all of them ask after a LIVE holder, which the default answers. A
 * future site asking after a dead one has to say `--all` for itself; nothing
 * checks that it did.
 *
 * `holderAlive` judges by pid and process-start time, so a background session
 * the oracle has marked done, failed or stopped still reads HELD until the
 * reaper takes its process — and a reader deciding whether to `request` the
 * file from it would be waiting on a session that can no longer answer. The row
 * is still shown, still counted live for the `--all` filter, and the guard
 * still denies on it: this is display wording, never a release mechanism (mantahostels#318,
 * mantahostels#2765, mantahostels#2774).
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
		reportWaits(held);
		reportRequests(held);
		return 0;
	}
	const shown = all ? held : held.filter((l) => l.unreadable || l.alive);
	const hidden = held.length - shown.length;
	// FIRST, not among the rows: every other line here restates a lock still on
	// disk; this one is the ONLY place the reader learns the view is partial
	// (mantahostels#174).
	if (hidden)
		writeStdout(
			`${hidden} stale claim(s) hidden — node ${ARBITER} list --all\n`,
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
	reportWaits(held);
	reportRequests(held);
	return 0;
}

/**
 * Where a region subject carries no debt but its FILE does, say so — `clear` is
 * deliberately not demoted (mantahostels#1857), so a reader whose record was demoted to the
 * file would otherwise read "no debt" and stop.
 * @param {string} rel
 */
function buildRegionHint(rel) {
	const { rel: file, region } = store.splitSubject(rel);
	if (region === null) return "";
	let carried;
	try {
		carried = store.readDebts(file).length;
	} catch {
		return ""; // fail open: a store that will not read owes no hint
	}
	return carried
		? `\n${file} carries ${carried} — a debt on an id the document has no entry for is recorded against the file: node ${ARBITER} debt clear ${file} <issue>`
		: "";
}

/**
 * One line per entry, on stdout. By path, then by owner: a path with several
 * debts prints them together rather than scattered by filename hash (mantahostels#327).
 * @param {Array<Partial<DebtRecord> & {unreadable?: boolean, file?: string}>} debts
 */
function printDebts(debts) {
	const ordered = [...debts].sort(
		(a, b) =>
			String(a.path).localeCompare(String(b.path)) ||
			(a.issue || 0) - (b.issue || 0),
	);
	for (const d of ordered) {
		writeStdout(
			d.unreadable
				? `?????\t(unreadable debt file ${d.file})\n`
				: `${d.issue ? `#${d.issue}` : "UNOWNED"}\t${d.path}\t${d.gist || "(no gist)"}\t${d.createdAt}\n`,
		);
	}
}

/**
 * The stubs this run deleted (mantahostels#1302). Said on every route out that got as far as
 * reading records, the offline SKIP included.
 *
 * These lines are the ONLY surviving record of an entry just unlinked.
 * @param {Partial<DebtRecord>[]} dropped
 */
function reportDropped(dropped) {
	if (!dropped || dropped.length === 0) return;
	for (const d of dropped)
		writeStdout(
			`dropped\tUNOWNED\t${d.path}\t(no gist, denied ${d.createdAt})\n`,
		);
	writeStderr(
		`\n${dropped.length} uncompletable stub${dropped.length === 1 ? "" : "s"} dropped: unowned, no gist, and past the 24h grace, so no issue could ever retire ${dropped.length === 1 ? "it" : "them"} (mantahostels#1302).\n`,
	);
}

/**
 * Entries the sweep meant to delete and could not — a closed issue's, or a spent
 * stub's. Both routes out of the sweep call it: deletions happen on the offline route
 * too (mantahostels#1302).
 *
 * A stub gets its own wording. Reusing the owned form would print "#null has
 * closed" and send the reader looking for an issue that never existed.
 * @param {any[]} failed
 */
function reportFailed(failed) {
	if (!failed || failed.length === 0) return;
	for (const { record, error } of failed)
		writeStderr(
			record.issue
				? `session-arbiter: #${record.issue} on ${record.path} has closed but its entry could not be deleted: ${error?.message}. It still stands.\n`
				: `session-arbiter: the uncompletable stub on ${record.path} could not be deleted: ${error?.message}. It still stands.\n`,
		);
}

/**
 * Entries the sweep could not read. Said on EVERY route out, the SKIP included:
 * a run that printed a short list and no count reads as the whole of what is
 * owed, which is mantahostels#174's failure.
 * @param {any[]} unreadable
 */
function reportUnreadable(unreadable) {
	if (unreadable.length === 0) return;
	writeStderr(
		`\n${unreadable.length} entr${unreadable.length === 1 ? "y" : "ies"} could not be parsed and were left alone: ${unreadable.map((d) => d.file).join(", ")}\n`,
	);
}

/**
 * `debt own <path> <issue> [gist…]`: complete the stub a denial wrote.
 *
 * On a (path, issue) pair that already carries a debt it REPLACES the
 * existing gist outright — it does not append or merge — and prints the same
 * success line either way, so the overwrite is silent. A second call under
 * the same issue collapses two blocked edits into whichever gist was written
 * last. Recover by re-running `debt own` with a gist covering both.
 * @param {string[]} rest
 */
function debtOwn(rest) {
	const [filePath, issue, ...gist] = rest;
	if (filePath === undefined) return refuseUsage(buildUsage([DEBT_OWN]));
	const rel = store.relativeToRepo(filePath);
	if (rel === null) {
		writeStderr(`session-arbiter: ${filePath} is not in this repo\n`);
		return 2;
	}
	if (issue === undefined || !/^#?\d+$/.test(issue))
		return refuseUsage(buildUsage([DEBT_OWN]));
	const number = Number(issue.replace(/^#/, ""));
	let stored;
	try {
		stored = store.ownDebt(
			rel,
			number,
			gist.join(" "),
			// From the environment, not a hook payload: `debt own` runs from Bash.
			// Without one the record names nobody, and guard-uncommitted-work.js
			// never releases the path (#1170).
			process.env.CLAUDE_CODE_SESSION_ID || null,
		);
	} catch (e) {
		store.logError(`debt own ${rel}`, e);
		// "record", not "write": the read of the existing stub can refuse too
		// (mantahostels#174), and reporting that as a failed write sends the reader
		// looking at permissions on a file that was never reached.
		writeStderr(
			`session-arbiter: could not record the debt on ${rel}: ${caught(e).message}\n` +
				`Nothing was stored, so the work is unowned. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	// The KEY, not the subject asked for: an unallocated `#B<n>` is stored
	// against the file (mantahostels#1857), and a reader given the subject back would then
	// run a `debt clear` that finds nothing.
	writeStdout(
		stored === rel
			? `Debt on ${rel} owned by #${number}.\n`
			: `Debt owned by #${number}, recorded against ${stored} — ${rel} names no region the document has, so the file is what carries it.\nClear it with: node ${ARBITER} debt clear ${stored} ${number}\n`,
	);
	return 0;
}

/**
 * The exit code a `debt clear` that removed nothing ends on — its message
 * printed here — or undefined where the result is `cleared` or `none`.
 * @param {ReturnType<typeof store.clearDebt>} result
 * @param {string} rel
 * @returns {number|undefined}
 */
function clearRefusal(result, rel) {
	if (result.status === "unreadable") {
		writeStderr(
			`session-arbiter: could not read the debt store at ${store.paths.debtsDir()}, so nothing was cleared and what is owed on ${rel} is unknown — not nothing (mantahostels#174).\n`,
		);
		return 1;
	}
	if (result.status === "failed") {
		writeStderr(
			`session-arbiter: could not clear the debt on ${rel}: ${result.error.message}\n` +
				`The entry still stands and will warn the next claimant. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		return 1;
	}
	if (result.status !== "ambiguous") return;
	writeStderr(
		`session-arbiter: ${rel} carries ${result.entries.length} debts, so name the one to clear — each is a separate piece of owed work:\n${result.entries
			.map(
				(d) =>
					`  node ${ARBITER} debt clear ${rel} ${d.issue || "unowned"}\t${d.gist || "(no gist)"}\n`,
			)
			.join("")}`,
	);
	return 2;
}

/**
 * The line a `debt clear` that removed one entry, or found none, prints.
 * @param {ReturnType<typeof store.clearDebt>} result
 * @param {string} rel
 * @param {string|undefined} issue as given
 */
function buildClearedLine(result, rel, issue) {
	if (result.status === "cleared") {
		const owner = result.record.issue
			? ` owned by #${result.record.issue}`
			: "";
		return `Debt on ${rel}${owner} cleared.\n`;
	}
	const scope = issue === undefined ? "" : ` for ${issue}`;
	return `No debt registered on ${rel}${scope}.${buildRegionHint(rel)}\n`;
}

/**
 * `debt clear <path> [issue|unowned]`: retire an entry by hand.
 * @param {string[]} rest
 */
function debtClear(rest) {
	const [filePath, issue] = rest;
	if (filePath === undefined)
		return refuseUsage(buildUsage([DEBT_COMMANDS.clear.line]));
	const rel = store.relativeToRepo(filePath);
	if (rel === null) {
		writeStderr(`session-arbiter: ${filePath} is not in this repo\n`);
		return 2;
	}
	if (issue !== undefined && !/^(#?\d+|unowned)$/.test(issue))
		return refuseUsage(buildUsage([DEBT_COMMANDS.clear.line]));
	const owner =
		issue === undefined || issue === "unowned"
			? issue
			: issue.replace(/^#/, "");
	const result = store.clearDebt(rel, owner);
	const refused = clearRefusal(result, rel);
	if (refused !== undefined) return refused;
	writeStdout(buildClearedLine(result, rel, issue));
	return 0;
}

/** @typedef {ReturnType<typeof store.sweepDebts>} SweepResult */

/**
 * `debt sweep`'s human report: what was retired, dropped and left standing.
 * @param {SweepResult} result
 */
function buildSweepReport(result) {
	if (result.status === "unreadable") {
		writeStderr(
			`BROKEN: could not read the debt store at ${store.paths.debtsDir()}, so what is owed is unknown — not nothing (mantahostels#174). Nothing was retired.\n`,
		);
		return 2;
	}
	// The register is machine-local (~/.claude/projects/…), so a CI runner and
	// a fresh checkout have none. Absent SUBJECT, not broken apparatus
	// (mantahostels#1203).
	if (result.status === "absent") {
		writeStderr(
			`SKIP: no debt register on this machine (${store.paths.debtsDir()} does not exist). Nothing to sweep.\n`,
		);
		return 0;
	}
	if (result.status === "offline") {
		writeStderr(
			`SKIP: could not ask GitHub which issues are closed, so nothing was retired — every entry below is shown UNCHECKED. See: node ${scriptPath("check-guard-errors.js")}\n`,
		);
		reportDropped(result.dropped);
		reportFailed(result.failed);
		printDebts(result.live);
		reportUnreadable(result.unreadable);
		return 0;
	}

	reportDropped(result.dropped);
	for (const d of result.retired)
		writeStdout(`retired\t#${d.issue}\t${d.path}\t${d.gist || "(no gist)"}\n`);
	reportFailed(result.failed);

	writeStderr(
		`\n${result.retired.length} retired (owning issue closed), ${result.dropped.length} dropped (uncompletable stub), ${result.live.length} standing.\n`,
	);
	if (result.live.length > 0) {
		writeStderr(
			`A standing entry is NOT proof the work is outstanding — read the file before doing it, and clear the entry if the edit is already there:\n  node ${ARBITER} debt clear <path> <issue>\n\n`,
		);
		printDebts(result.live);
	}
	reportUnreadable(result.unreadable);
	return 0;
}

/** `debt sweep`: drain the register. */
function debtSweep() {
	// Recorded for prune-markers' reason: sweep-debts-detached.sh spawns this
	// detached and returns, so the record is the only thing that says the child
	// came back (mantahostels#1910, lib/detached-run.js). The record closes before anything
	// below is printed — this seam is the sweep itself, not its report.
	const result = recordRun(JOB_DEBT_SWEEP, () => store.sweepDebts());
	return buildSweepReport(result);
}

/** `debt list`: the store as it stands. */
function debtList() {
	const debts = store.listDebts();
	if (debts === null) {
		writeStderr(
			`session-arbiter: could not read the debt store at ${store.paths.debtsDir()}, so what is owed is unknown — not nothing (mantahostels#174).\n`,
		);
		return 1;
	}
	if (debts.length === 0) {
		writeStdout("No debts registered.\n");
		return 0;
	}
	printDebts(debts);
	return 0;
}

/**
 * The denied session's half: `own` completes the stub the denial wrote, `clear`
 * retires an entry by hand, `list` shows the store, `sweep` drains it.
 *
 * `list` takes no network call on purpose — it is the command a person runs to
 * see the store. `sweep` takes exactly one, for the whole register, and is the
 * register's ONLY drain: a claim retires nothing at all (mantahostels#1251).
 *
 * `sweep` IS THE CHECKER FAMILY'S ALPHABET BY HAND — SKIP/BROKEN and 0/2.
 * lib/check.js's runCheck owns a process, so it is not reachable from one
 * subcommand of a CLI whose other verbs are hooks.
 * @param {string[]} argv
 */
function cmdDebt(argv) {
	const [action, ...rest] = argv;
	if (action === "own") return debtOwn(rest);
	if (action === "clear") return debtClear(rest);
	if (action === "sweep") return debtSweep();
	if (action === "list" || action === undefined) return debtList();
	writeStderr(`${DEBT_CLI.usage}\n`);
	return 2;
}

/**
 * The high-water mark in the data file beside the map at `rel`, or 0 where it
 * is absent or unreadable: allocation then falls back to max + 1, and
 * check-doc-map.js's assertion 12 is what refuses a reused id (#2339).
 * @param {string} rel
 */
function readHighWaterMarkFor(rel) {
	const file = path.join(
		store.paths.repoRoot(),
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
		if (code !== "ENOENT")
			writeStderr(
				`session-arbiter: ${file} could not be read (${code || message}), so the id below may be one a removed entry held; check-doc-map.js will refuse it if so.\n`,
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
	const rel = store.relativeToRepo(filePath || "docs/doc-map.md");
	if (rel === null || !regions.isRegioned(rel)) {
		writeStderr(
			`session-arbiter: ${filePath} takes no per-entry claim, so there is no id to allocate. Only docs/doc-map.md does (mantahostels#848).\n`,
		);
		return 2;
	}

	let text;
	try {
		text = fs.readFileSync(path.join(store.paths.repoRoot(), rel), "utf8");
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
		const { taken, notices } = takeSet([subject], me, { probe: true });
		const [t] = taken;
		if (!t) throw new Error(`takeSet took nothing of ${subject}`);
		const { verdict, lock } = t;
		sayEach(notices.broken);
		if (isRealClaim(verdict)) {
			sayEach([...notices.debts, ...notices.requests]);
			writeStdout(`B${n}\n`);
			writeStderr(
				`session-arbiter: B${n} is yours — the append slot is claimed, so write the entry as \`### B${n} · <title>\` and release it when the commit lands:\n  node ${ARBITER} release ${subject}\n`,
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
			// NOT buildDenyReason: that text tells the reader to clear a stub the denial
			// wrote, and allocation registers none — the recipe would answer "no
			// debt registered" and dead-end.
			writeStderr(
				`session-arbiter: no id can be allocated — ${rel} is held whole by session ${describeHolder(lock)}, so every append slot in it is covered.\n` +
					`Wait on it in the background — node ${ARBITER} wait ${lock.path} — or take the escape, which refuses unless the holder has finished:\n  node ${ARBITER} release --force ${lock.path}\n` +
					"If it refuses, write the entry in a later session and record the blocked work against your ticket:\n" +
					`  node ${ARBITER} debt own ${rel} <issue> "<the entry you could not add>"\n`,
			);
			return 1;
		}
	}
	writeStderr(
		`session-arbiter: B${first}..B${n - 1} are all claimed by live sessions. Nothing was allocated; try again once one of them lands: node ${ARBITER} list\n`,
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
 * runs, `record` rides the same hook, `request`, `decline` and `debt own` take
 * free text, and `release-committed` takes git's committed paths, any of which
 * may open `--`. lib/cli-args.js would read that as a flag and refuse it, or
 * print usage on a `--help` inside it. So a mistyped flag on these still
 * passes unrefused, and `request <path> --help` records a request.
 * @type {Record<string, string>}
 */
const PASS_THROUGH = {
	check: "check <path> [session-id] [<anchor> <anchor-length> <new-ids>]",
	record: "record <path> [session-id]",
	request: 'request <path> ["<why>"]',
	decline: 'decline <path> ["<reason>"]',
	"release-committed": "release-committed <path> [<path>...]",
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
		line: "release [--force] [--park] [--generator] [--not-mine] <path>",
		flags: {
			"--force": "boolean",
			"--park": "boolean",
			"--generator": "boolean",
			"--not-mine": "boolean",
		},
		max: 1,
	},
	requests: { line: "requests" },
	"held-requests": { line: "held-requests" },
	"claim-issue": { line: "claim-issue <issue-number>", max: 1 },
	"release-issue": { line: "release-issue <issue-number>", max: 1 },
	"issue-claims": { line: "issue-claims" },
	wait: { line: "wait <path|issue-number> [ceiling-seconds]", max: 2 },
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
	"stale-check": {
		line: "stale-check <path> <staged-blob> | --staged",
		flags: { "--staged": "boolean" },
		max: 2,
	},
	"accept-head": { line: "accept-head <path>", max: 1 },
	"advance-bases": { line: "advance-bases <commit>", max: 1 },
	"record-commit": { line: "record-commit <commit>", max: 1 },
	list: { line: "list [--all]", flags: { "--all": "boolean" } },
	versions: { line: "versions <path>", max: 1 },
	"alloc-entry": { line: "alloc-entry [docs/doc-map.md]", max: 1 },
	"prune-markers": {
		line: "prune-markers [--detach]",
		flags: { "--detach": "boolean" },
	},
};

/**
 * `debt`'s verbs but `own`, which PASS_THROUGH's reason keeps unparsed.
 * @satisfies {Record<string, Form>}
 */
const DEBT_COMMANDS = {
	clear: { line: "debt clear <path> [<issue>|unowned]", max: 2 },
	list: { line: "debt list" },
	sweep: { line: "debt sweep" },
};
const DEBT_OWN = 'debt own <path> <issue> "<gist>"';

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
	DEBT_OWN,
	...linesOf(DEBT_COMMANDS),
]);
const CLI = { usage: USAGE, commands: buildSpecs(COMMANDS) };
const DEBT_CLI = {
	usage: buildUsage([DEBT_OWN, ...linesOf(DEBT_COMMANDS)]),
	commands: buildSpecs(DEBT_COMMANDS),
};

/** A command with no handler: a spec added without its `case`. */
function refuseUnhandled() {
	writeStderr(`${USAGE}\n`);
	return 2;
}

/**
 * `debt …`: `own` and a bare `debt` read unparsed, every other verb through
 * DEBT_CLI.
 * @param {string[]} args the arguments after `debt`
 */
function runDebt(args) {
	if (args[0] === "own") return cmdDebt(args);
	// A bare `debt` is `debt list`.
	if (args.length === 0) return cmdDebt([]);
	const debt = parseOrCode(args, DEBT_CLI);
	if (typeof debt === "number") return debt;
	return cmdDebt([/** @type {string} */ (debt.command), ...debt.positionals]);
}

/**
 * `prune-markers [--detach]`: sweep the stores, or launch a detached sweep.
 * @param {unknown} detach the `--detach` flag
 * @param {string} sessionId
 */
function cmdPruneMarkers(detach, sessionId) {
	/*
	 * `--detach` is the SessionStart registration, and it does no sweeping:
	 * it launches a `prune-markers` of its own and returns (mantahostels#1899).
	 *
	 * The sweep's cost tracks the backlog, not the session — it stats
	 * every observation record, and collects one pinned blob ref per claim
	 * that has ended — so it runs against a 10 s hook budget it cannot be
	 * shown to fit inside. Nothing in the starting session reads a byte of
	 * this: the sweep prints nothing, and it drains the store for the
	 * session AFTER this one. The same reasoning, and the same setsid
	 * mechanics, as sweep-debts-detached.sh's (mantahostels#1251).
	 */
	if (detach) {
		// The one SessionStart registration this script has, so the session's
		// fallback base (#110) rides it — synchronously, being HEAD NOW.
		store.mintSessionBase(sessionId || readHookSessionId());
		return detachPrune();
	}
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
	if (argv[0] === "debt") return runDebt(argv.slice(1));

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
		// --force is a flag, not a session id: it changes WHOSE claim may be
		// dropped, and the answer is still never "one the caller names" (mantahostels#411).
		case "release":
			return cmdRelease(rest[0], sessionId, {
				force: flags["--force"] === true,
				park: flags["--park"] === true,
				generator: flags["--generator"] === true,
				notMine: flags["--not-mine"] === true,
			});
		case "requests":
			return cmdRequests(sessionId);
		// No positional session id: it spends the caller's said-once markers, and
		// argv would let a caller spend somebody else's (#855).
		case "held-requests":
			return cmdHeldRequests(sessionId);
		// No positional session id, for release's reason: a session records the
		// issue IT is working.
		case "claim-issue":
			return cmdClaimIssue(rest[0], sessionId);
		case "release-issue":
			return cmdReleaseIssue(rest[0], sessionId);
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
		// No positional session id, for release's reason: the caller is the
		// pre-commit stack, which inherits CLAUDE_CODE_SESSION_ID.
		case "stale-check":
			if (flags["--staged"]) return cmdStaleCheckStaged(sessionId);
			return cmdStaleCheck(rest[0], rest[1], sessionId);
		// No positional session id, for release's reason: a session moves its own
		// base.
		case "accept-head":
			return cmdAcceptHead(rest[0], sessionId);
		// The caller is .husky/post-commit, for release-committed's reason.
		case "advance-bases":
			return cmdAdvanceBases(rest[0], sessionId);
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
			return cmdPruneMarkers(flags["--detach"], sessionId);
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
		// session that ran `git commit`. Every argument is a committed path.
		case "release-committed":
			return cmdReleaseCommitted(sessionId, rest);
		// No positional session id on either, for release's reason: a request and a
		// decline are this session's own acts, and argv would only offer a caller
		// an easy way to speak as somebody else.
		case "request":
			return cmdRequest(rest[0], rest[1], sessionId);
		case "decline":
			return cmdDecline(rest[0], rest[1], sessionId);
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
// onto a held file.
if (typeof code === "number") process.exit(code);
else
	code.then(
		(c) => process.exit(c),
		(/** @type {unknown} */ e) => {
			store.logError(process.argv.slice(2).join(" "), e);
			process.exit(1);
		},
	);
