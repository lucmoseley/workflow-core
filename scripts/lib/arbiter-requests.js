/*
 * arbiter-requests.js — the request register — asking a live holder for a file (mantahostels#1702, built at mantahostels#1782).
 *
 * A want says *blocked on*; a request says *asking for*, and survives the
 * requester getting on with other work — `dropWant` fires on ANY claim taken,
 * which is exactly why a want cannot carry this.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId, holderAlive } = require("./arbiter-proc.js");
const core = require("./arbiter-core.js");
const { scriptPath } = require("./script-path.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").RequestRecord} RequestRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */

// ---------------------------------------------------------------------------
// The request register (mantahostels#1702, built at mantahostels#1782)
//
// A want says *blocked on*; a request says *asking for*, and survives the
// requester getting on with other work — dropWant fires on ANY claim taken,
// which is exactly why a want cannot carry this (mantahostels#1702's rejected reuse).
//
// RESIDUAL: nothing here delivers a request to its holder — the holder sees it
// at its own next `list`, or never. Delivery at the holder's claim/release
// sites and the founder's session start are mantahostels#1702's follow-on tickets; until
// they land, a request is a record, not a message.
// ---------------------------------------------------------------------------

/**
 * NOT WANT_AGE_MS, on purpose (mantahostels#1784's finding): `prune-markers` runs at
 * every SessionStart, and check-stranded-file-claims.js only when someone runs
 * `npm run status`, so a request that turns reportable — past that checker's
 * 12h threshold — at the SAME age it turns prunable is deleted before any run
 * could report it, and the founder's escape hatch never fires. Set well past
 * that threshold so a request survives long enough to be seen. Still a first
 * guess like WANT_AGE_MS's, and even less turns on it — expiring a request
 * frees nothing and destroys nothing, the worst case being a courtesy that
 * goes unread. mantahostels#318's refusal of claim expiry does not govern here for that
 * reason (mantahostels#1702).
 */
const REQUEST_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Record that this session asks the holder of `subject` to release it.
 *
 * FAILS SILENT BY DESIGN, like recordWant: a request that cannot be written
 * costs a courtesy, never a claim.
 * @param {string} subject region-qualified where the denial was
 * @param {Identity} me the requester
 * @param {string|null} holder the session holding it now, for the report
 * @param {string|null} [why]
 */
function recordRequest(subject, me, holder, why = null) {
	// An unidentifiable session's request would read dead to holderAlive and be
	// skipped by every reader, so recording it would manufacture a file nothing
	// ever shows. The CLI says so before calling here.
	if (!me?.sessionId) return;
	try {
		fs.mkdirSync(core.paths.requestsDir(), { recursive: true });
		core.writeRecord(
			core.paths.request(core.subjectPath(subject), me.sessionId),
			{
				subject,
				requester: me.sessionId,
				pid: me.pid ?? null,
				procStart: me.procStart ?? null,
				bootId: readCurrentBootId(),
				holder: holder ?? null,
				since: new Date().toISOString(),
				why: why || null,
				declined: null,
			},
		);
	} catch (e) {
		core.logError(`request record ${subject}`, e);
	}
}

/**
 * Every request whose requester is still running. A dead requester's record is
 * SKIPPED, never deleted, on readWants' reasoning: holderAlive reads a RESUMED
 * session — same id, fresh host — as dead, and unlinking on that reading would
 * drop a live requester's record for good. The age sweep reaps those.
 *
 * Returns null where the register itself could not be read, [] where it is
 * genuinely empty. The caller must not print the first as the second (mantahostels#174).
 * @returns {RequestRecord[]|null}
 */
function readRequests() {
	let files = [];
	try {
		files = fs
			.readdirSync(core.paths.requestsDir())
			.filter((f) => f.endsWith(".json"));
	} catch (e) {
		// ENOENT is a real empty: nothing has ever been requested.
		if (caught(e).code === "ENOENT") return [];
		core.logError("request list", e);
		return null;
	}
	const out = [];
	for (const f of files) {
		let record = null;
		try {
			record = core.readRecord(path.join(core.paths.requestsDir(), f));
		} catch {
			continue;
		}
		if (!record?.requester || !record.subject) continue;
		if (!holderAlive(record)) continue;
		out.push(record);
	}
	return out;
}

/**
 * Every request file keyed to one FILE, each read — the scan dropRequests and
 * declineRequest share, so the two cannot diverge on it.
 * @param {string} file a plain repo-relative path, no region tail
 * @returns {{state: "ok"|"unreadable", error?: any, entries: {full: string, record: any}[]}}
 */
function readRequestEntriesOn(file) {
	const prefix = `${core.keyFor(file)}-`;
	let files;
	try {
		files = fs.readdirSync(core.paths.requestsDir());
	} catch (e) {
		// ENOENT is a real empty: nothing has ever been requested.
		if (caught(e).code === "ENOENT") return { state: "ok", entries: [] };
		return { state: "unreadable", error: e, entries: [] };
	}
	const entries = [];
	for (const f of files) {
		if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
		const full = path.join(core.paths.requestsDir(), f);
		entries.push({ full, record: core.readRecordOrLog(full, "request read") });
	}
	return { state: "ok", entries };
}

/**
 * Whether an act on `subject` answers the request in `record` — overlapping
 * subjects only, so releasing or declining `#B5` cannot destroy a standing ask
 * for a sibling `#B9` another session still holds. A record with no readable
 * subject says yes: it is garbage in the file's own key space, and keeping it
 * protects nobody.
 * @param {string} subject
 * @param {any} record
 */
const requestAnswered = (subject, record) =>
	!record?.subject || core.subjectsOverlap(subject, record.subject);

/**
 * Drop requests `rel` answers: one requester's, on its claim landing, or — the
 * release route — every session's, so the next holder inherits no obligation
 * (mantahostels#1702 story 17). Scoped by requestAnswered above.
 *
 * Fails silent on a write it could not make, like the rest of the write path —
 * but never unlogged (§N5): a request left standing here reaches the NEXT
 * holder, which is the outcome story 17 exists to prevent, so check-guard-errors
 * has to hear about it.
 * @param {string} rel a subject, region tail and all
 * @param {string|null} [requester] just this session's, on its claim landing
 */
function dropRequests(rel, requester = null) {
	const file = core.subjectPath(rel);
	const unlink = (/** @type {string} */ full) => {
		try {
			fs.unlinkSync(full);
		} catch (e) {
			if (caught(e).code !== "ENOENT") core.logError(`request drop ${file}`, e);
		}
	};
	if (requester) {
		const full = core.paths.request(file, requester);
		const record = core.readRecordOrLog(full, `request drop ${file}`);
		// A claim on a disjoint region answers nothing: the requester is still
		// asking for a region this claim did not take.
		if (record && !requestAnswered(rel, record)) return;
		unlink(full);
		return;
	}
	const scan = readRequestEntriesOn(file);
	if (scan.state === "unreadable") {
		core.logError(`request drop ${file}`, scan.error);
		return;
	}
	for (const { full, record } of scan.entries)
		if (requestAnswered(rel, record)) unlink(full);
}

/**
 * The holder's explicit no: mutate `declined` in place on every request `rel`
 * answers, so the requester reads *read and refused* rather than *not read
 * yet*. WHO may decline is the CLI's to judge — this is the mechanism alone.
 *
 * `failed` is a write the register refused with requests standing — never
 * folded into `none`, whose "nothing to decline" is the opposite of the truth.
 * @param {string} rel a subject, region tail and all
 * @param {string|null} by the declining session
 * @param {string|null} [reason]
 * @returns {{status: "declined"|"none"|"failed"|"unreadable", count: number}}
 */
function declineRequest(rel, by, reason = null) {
	const file = core.subjectPath(rel);
	const scan = readRequestEntriesOn(file);
	if (scan.state === "unreadable") {
		core.logError(`request decline ${file}`, scan.error);
		return { status: "unreadable", count: 0 };
	}
	let count = 0;
	let failed = 0;
	for (const { full, record } of scan.entries) {
		if (!record?.requester) continue;
		if (!requestAnswered(rel, record)) continue;
		try {
			core.writeRecord(full, {
				...record,
				declined: {
					by: by ?? null,
					at: new Date().toISOString(),
					reason: reason || null,
				},
			});
			count += 1;
		} catch (e) {
			core.logError(`request decline ${file}`, e);
			failed += 1;
		}
	}
	if (failed) return { status: "failed", count };
	return { status: count ? "declined" : "none", count };
}

/**
 * A request's age in the coarsest unit that still reads true. Minutes, unlike
 * everywhere else in the store: check-stranded-file-claims.js's `0h` would
 * report a fresh ask as having no age at all.
 * @param {string|undefined} since ISO
 */
function requestAge(since) {
	const at = Date.parse(since ?? "");
	if (Number.isNaN(at)) return "an unreadable time ago";
	const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	// 48 is a READING threshold, not REQUEST_AGE_MS: it is where hours stop
	// being the unit a person thinks in. The two coinciding today is chance, and
	// a request can outlive the backstop between sweeps.
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * What the holder of `subject` is told about the requests standing against it
 * (mantahostels#1783, spec mantahostels#1702). The delivery half of the register, at the two moments a
 * holder acts on the file anyway — its next claim, and its release.
 *
 * SAID ONCE PER (request, holder session), via firstSay. A holder claims a file
 * it is working dozens of times in a session, and one outstanding courtesy
 * repeated on each of them is noise the holder learns to skip. Once per hour at
 * worst, in fact: sweepDebris reaps a `.said-` marker at DEBRIS_AGE_MS, so a
 * request outliving that is said again. Accepted — the repeat is bounded, and
 * a longer-lived marker would need a family of its own.
 *
 * DECLINED REQUESTS ARE SILENT: the holder has already answered that one, and
 * re-offering it invites a second answer to a question nobody asked twice.
 *
 * THIS SESSION'S OWN requests are skipped. Between recording an ask and taking
 * the claim there is a window where a session holds a path it asked for, and
 * telling it that it is waiting on itself is the deadlock report's job, not
 * this one's.
 *
 * `dirty` is a THUNK, not a boolean: subjectDirty shells out to git, and the
 * common case is no request standing at all, where nothing here needs the
 * answer. cmdRelease passes a constant — its verdict already decided it.
 *
 * `freed` is the release that SUCCEEDED. Without it the notice tells a holder
 * that no longer holds anything to go and release the file, two lines before
 * dropRequests destroys the record it is reporting.
 * @param {string} subject the subject held, region tail and all
 * @param {string|null} sessionId the holder
 * @param {{ nameOf: (id: string|null) => string, dirty: () => boolean, freed?: boolean }} opts
 *   `nameOf` resolves id to name; `dirty` says whether the file carries
 *   uncommitted work; `freed` whether the caller has just given the subject up
 * @returns {string|null}
 */
function buildRequestNotice(
	subject,
	sessionId,
	{ nameOf, dirty, freed = false },
) {
	if (!sessionId) return null;
	const all = readRequests();
	if (all === null) {
		// mantahostels#174: unreadable is not empty. Said once, or a dark register repeats
		// this on every claim of every file for the rest of the session.
		return core.firstSay(sessionId, "request register unreadable")
			? `the request register could not be read, so whether another session has asked for a file this one holds is unknown — not nothing (mantahostels#174). See: node ${scriptPath("check-guard-errors.js")}`
			: null;
	}
	const standing = all.filter(
		(r) =>
			r.requester !== sessionId && !r.declined && requestAnswered(subject, r),
	);
	// firstSay MINTS the marker, so this filter must run after every other one:
	// a request skipped above must not be marked as said, or the notice is lost
	// when it later becomes sayable.
	const fresh = standing.filter((r) =>
		core.firstSay(
			sessionId,
			`request ${r.subject}\0${r.requester}\0${r.since}`,
		),
	);
	if (fresh.length === 0) return null;
	return buildRequestText(fresh, freed, freed ? false : dirty(), nameOf);
}

/**
 * @param {RequestRecord[]} records
 * @param {boolean} freed the subject has just been given up
 * @param {boolean} dirty the file carries uncommitted work
 * @param {(id: string|null) => string} nameOf
 */
function buildRequestText(records, freed, dirty, nameOf) {
	const one = records.length === 1;
	const asks = records
		.map(
			(r) =>
				`  ${nameOf(r.requester)} asked for ${r.subject}, ${requestAge(r.since)}${r.why ? `: "${r.why}"` : " — no reason given"}`,
		)
		.join("\n");
	const head = `Another session is waiting on a file this one holds:\n${asks}\n\n`;
	if (freed)
		return (
			head +
			`That release answers ${one ? "it" : "them"}: the record is dropped with the claim, and the requester's next write to the file takes it.\n`
		);
	return (
		head +
		"A request is a courtesy. Nothing of yours is blocked and the requester is not sitting on it — they were told to carry on with the rest of their ticket. So finish what you are doing first.\n\n" +
		`Then either hand ${one ? "it" : "them"} over — node ${scriptPath("session-arbiter.js")} release <path> — or say no, which is worth more than silence because it tells the requester *read and refused* rather than *not read yet*:\n  node ${scriptPath("session-arbiter.js")} decline <path> "<reason>"\n` +
		(dirty
			? "\nThis file carries uncommitted work, so an ordinary release refuses it. You do not have to commit a half-finished edit to hand it over: `release --park` sets the edit aside, restores the file, releases it, and prints how to get your work back (mantahostels#1405).\n"
			: "")
	);
}

module.exports = {
	declineRequest,
	dropRequests,
	readRequests,
	recordRequest,
	REQUEST_AGE_MS,
	buildRequestNotice,
};
