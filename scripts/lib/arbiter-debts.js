/*
 * arbiter-debts.js — debts — the edit a denial abandoned, and who owes it (mantahostels#116, built by mantahostels#120).
 *
 * A denied session abandons the edit and moves on (mantahostels#104). The store's main
 * consumer is the arbiter's own next claim on the same path, so the next session
 * to reach for the file is told the work is owned elsewhere rather than redoing
 * it; the other is guard-uncommitted-work.js, through `debtsOwnedBy` (#1170).
 * The GitHub reads that retire a debt live here too.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const regions = require("./doc-map-regions.js");
const core = require("./arbiter-core.js");
const { ISSUE_LIST_LIMIT } = require("./gh-limits.js");
const { scriptPath } = require("./script-path.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").DebtRecord} DebtRecord */
/** @typedef {import("./arbiter-records.js").DebtEntry} DebtEntry */
/** @typedef {import("./arbiter-records.js").DebtEntries} DebtEntries */
/** @typedef {import("./arbiter-records.js").UnreadableDebt} UnreadableDebt */
/** @typedef {import("./arbiter-records.js").ListedDebt} ListedDebt */
/** @typedef {import("./arbiter-records.js").FailedDebt} FailedDebt */

/**
 * A debt record. Blocking session and blocking ticket were cut deliberately
 * (mantahostels#116): nobody reads them. `recordedBy` is not that field come back — it
 * names the session that WROTE the record, which `debtsOwnedBy` reads inside
 * that same session (#1170).
 *
 * `createdAt` dates the DENIAL, not the ownership: it is the age of the
 * abandoned edit, which is what a reader of the notice needs, so `ownDebt`
 * carries the stub's value through rather than restamping.
 *
 * @param {{path: string} & Partial<DebtRecord>} spec
 * @returns {DebtRecord}
 */
function newDebt({
	path: rel,
	issue = null,
	gist = null,
	createdAt = new Date().toISOString(),
	recordedBy = null,
}) {
	return { path: rel, issue, gist, createdAt, recordedBy };
}

/**
 * An entry's owner, as one value: the issue number, or null for the stub a
 * denial writes. The one spelling of the question — `!record.issue` reads issue
 * 0 as unowned, and the CLI's own argument grammar accepts a 0.
 * @param {DebtRecord} record
 */
const ownerOf = (record) => record.issue ?? null;

/**
 * @param {DebtEntry[]} entries
 * @param {number} torn
 * @returns {DebtEntries}
 */
const withTorn = (entries, torn) => Object.assign([...entries], { torn });

/**
 * Every entry on a path — one per owning issue, plus at most one unowned stub.
 *
 * Throws where the store could not be read, like readRecord: unreadable must not
 * look like undebted (mantahostels#174).
 * @param {string} rel
 */
function readDebts(rel) {
	const key = core.keyFor(rel);
	/** @type {string[]} */
	let files;
	try {
		files = fs.readdirSync(core.paths.debtsDir());
	} catch (e) {
		if (caught(e).code === "ENOENT") return withTorn([], 0); // no store yet
		throw e;
	}
	const entries = files
		.filter((f) => f.startsWith(`${key}-`) && f.endsWith(".json"))
		.map((f) => {
			const file = path.join(core.paths.debtsDir(), f);
			return { file, record: core.readRecord(file) };
		});

	// A torn entry is mid-write, not lost, so it is dropped rather than reported
	// as a debt — but the COUNT is carried, because with several debts on a path
	// dropping one silently makes a short list read as complete (mantahostels#174).
	const parsed = entries.filter((e) => e.record);
	const readable = withTorn(parsed, entries.length - parsed.length);
	// Owned entries in issue order, the stub last.
	return readable.sort((a, b) => {
		const [x, y] = [ownerOf(a.record), ownerOf(b.record)];
		if (x === y) return 0;
		if (x === null) return 1;
		if (y === null) return -1;
		return x - y;
	});
}

/**
 * Every debt a claim on `rel` should be TOLD about: its own, plus — for a
 * region subject — the whole file's.
 *
 * Read-side only, deliberately. The write side keys exactly, with one exception
 * it states for itself (`debtSubject`, mantahostels#1857): a denial on one entry must write
 * that entry's own stub rather than seeing the file's and skipping, and `debt
 * own` must never rewrite a file-level record under a region's name.
 *
 * It exists because a debt keyed on the plain path — a file-level stub, or a
 * whole-file denial — covers every region of that file. Keyed on the region
 * alone, a session claiming `docs/doc-map.md#B42` would be warned off
 * nothing.
 * @param {string} rel
 */
function debtsCovering(rel) {
	const { rel: file, region } = core.splitSubject(rel);
	if (region === null) return readDebts(rel);
	const own = readDebts(rel);
	const seen = new Set(own.map((e) => e.file));
	const fileDebts = readDebts(file);
	const inherited = fileDebts.filter((e) => !seen.has(e.file));
	// BOTH counts: `.filter` and the spread each return a fresh array, dropping
	// `.torn`, and carrying the region's alone hid every unreadable file-level
	// entry from the notice (mantahostels#1408). Never double-counted — the key hashes the
	// whole subject, so a region's records and the file's share no filename.
	return withTorn([...own, ...inherited], own.torn + fileDebts.torn);
}

/**
 * The key a debt on `subject` is STORED under (mantahostels#1857).
 *
 * A `docs/doc-map.md#B<n>` id that no entry occupies at HEAD is not a region —
 * it is the append slot a denied session was reaching for, and it is handed to
 * an unrelated subject the moment somebody allocates it — and the wrong warning
 * then stands indefinitely, because a claim retires nothing and nobody clears a
 * debt they did not incur. Such a debt belongs to the FILE, which stays true
 * whoever takes the id.
 *
 * HEAD, NOT THE WORKING TREE: the working tree is where the denied session's own
 * half-written `### B<n>` sits, and reading that is what made the id look
 * allocated in the first place.
 *
 * `B<n>` ONLY. A `## ` section id is stable vocabulary, and an `A:` row is keyed
 * to a path rather than to a counter, so neither is ever reissued to a different
 * subject.
 *
 * THE PRICE, accepted: `debtsCovering` widens a file-level record onto EVERY
 * region claim on that file, so the demotion trades five wrong warnings for one
 * warning on every claimant. That one is at least about work genuinely owed on
 * the file, and it is clearable — which is what the five were not.
 *
 * RESIDUAL: an `A:` row whose document is later renamed strands an entry the
 * same way by a slower route, and nothing here catches it.
 *
 * Falls back to the exact key on every way of not knowing — no repo, an
 * unreadable HEAD, a git that would not run. A demotion it cannot justify
 * broadens a debt past the subject that was actually denied.
 * @param {string} subject
 */
function debtSubject(subject) {
	const { rel, region } = core.splitSubject(subject);
	if (region === null || !/^B\d+$/.test(region)) return subject;
	const head = core.gitRaw(["show", `HEAD:${rel}`]);
	if (head === null) {
		// §N5: the parse-throw arm below logs, and this one is the likelier of the
		// two — no repo, an unreadable object store, a git that would not run.
		core.logError(
			`debt subject ${subject}`,
			new Error(`HEAD:${rel} could not be read — the exact key was kept`),
		);
		return subject;
	}
	try {
		return regions.entryIds(head).includes(region) ? subject : rel;
	} catch (e) {
		core.logError(`debt subject ${subject}`, e);
		return subject;
	}
}

/**
 * A denial writes the stub. The denied session declares nothing, so nothing can
 * misdeclare (mantahostels#99): forgetting to finish the entry downgrades a good debt to an
 * incomplete one, never to no debt at all.
 * @param {string} subject
 * @param {string|null} [recordedBy] the denied session, where the caller knows it
 */
function registerDenial(subject, recordedBy = null) {
	const rel = debtSubject(subject);
	try {
		fs.mkdirSync(core.paths.debtsDir(), { recursive: true });
		// One unowned stub per path is the whole of what a second denial adds while
		// the first is still unowned; an owned entry beside it is left alone, since
		// overwriting it would erase a completed entry back to a stub.
		if (readDebts(rel).some((e) => ownerOf(e.record) === null)) return;
		core.writeRecord(core.paths.debt(rel), newDebt({ path: rel, recordedBy }), {
			flag: "wx",
		});
	} catch (e) {
		if (caught(e).code === "EEXIST") return; // a parallel denial won the race
		core.logError(`debt register ${rel}`, e);
	}
}

/**
 * The key a record for this work is ALREADY stored under — the exact subject, or
 * the file a `debtSubject` demotion put it on — or null where neither carries
 * one. Only this issue's own entry and the unowned stub count: another issue's
 * entry on the same path is somebody else's and is left standing (mantahostels#327).
 * @param {string} subject
 * @param {number|string} issue
 * @returns {string|null}
 */
function existingDebtKey(subject, issue) {
	const number = Number(issue);
	const mine = (/** @type {string} */ key) =>
		readDebts(key).some((e) => {
			const owner = ownerOf(e.record);
			return owner === number || owner === null;
		});
	if (mine(subject)) return subject;
	const { rel, region } = core.splitSubject(subject);
	if (region !== null && mine(rel)) return rel;
	return null;
}

/**
 * Complete the stub a denial wrote, or mint the entry outright — a debt can be
 * declared by hand on a path that was never denied. Throws on a store it cannot
 * read or write, and the CLI turns that into an exit code.
 *
 * An entry for a DIFFERENT issue on the same path is left standing (mantahostels#327).
 * @param {string} subject
 * @param {number|string} issue
 * @param {string|null} gist
 * @param {string|null} [recordedBy] the owning session — not the denied one,
 *   when the two differ, since it is the owner `debtsOwnedBy` releases. The
 *   last `debt own` wins: a second session re-owning the entry takes the
 *   release from the first, and a call with no session id drops it.
 * @returns {string} the key the record was written under
 */
function ownDebt(subject, issue, gist, recordedBy = null) {
	// AN EXISTING RECORD IS COMPLETED WHERE IT LIES, and only a fresh entry is
	// demoted. `debtSubject` reads HEAD, which moves: recomputing it here would
	// key a second record under a `B<n>` allocated to somebody else between the
	// denial and this call — mantahostels#1857's own failure, on a delay (mantahostels#1302's window is
	// hours). Demoting a fresh entry is what stops the recovery command the denial
	// prints — `debt own docs/doc-map.md#B<n> …`, spelling the subject it refused —
	// duplicating the file-level stub. clearDebt is demoted neither way: it is the
	// only route to a region-keyed record already on disk.
	const rel = existingDebtKey(subject, issue) ?? debtSubject(subject);
	const number = Number(issue);
	const entries = readDebts(rel);
	const mine = entries.find((e) => ownerOf(e.record) === number);
	const stub = entries.find((e) => ownerOf(e.record) === null);
	fs.mkdirSync(core.paths.debtsDir(), { recursive: true });
	core.writeRecord(
		mine ? mine.file : core.paths.debt(rel, number),
		newDebt({
			path: rel,
			issue: number,
			gist: gist || null,
			createdAt: (mine || stub)?.record.createdAt,
			recordedBy,
		}),
	);
	// Unlinked after the write, so an interruption leaves two entries, never none.
	if (!mine && stub) {
		try {
			fs.unlinkSync(stub.file);
		} catch (e) {
			core.logError(`debt own ${rel}`, e);
		}
	}
	// The key actually written, which is not always the subject asked for: the
	// caller has to name it to print a `debt clear` that works.
	return rel;
}

/**
 * Retire one entry by hand. `issue` is a number, the string `unowned`, or
 * undefined for "the path's only entry".
 *
 * Undefined on a path carrying several entries REFUSES: clearing by path alone
 * took a parallel session's still-outstanding debt with it (mantahostels#327).
 * @param {string} rel
 * @param {number|string|undefined} issue
 * @returns {{status: "unreadable"}|{status: "none"}|{status: "ambiguous", entries: DebtRecord[]}|{status: "failed", error: Error}|{status: "cleared", record: DebtRecord}}
 */
function clearDebt(rel, issue) {
	let entries;
	try {
		entries = readDebts(rel);
	} catch (e) {
		core.logError(`debt clear ${rel}`, e);
		return { status: "unreadable" };
	}
	const [first] = entries;
	if (first === undefined) return { status: "none" };

	let target;
	if (issue === undefined || issue === null) {
		if (entries.length > 1)
			return { status: "ambiguous", entries: entries.map((e) => e.record) };
		target = first;
	} else {
		const want = issue === "unowned" ? null : Number(issue);
		target = entries.find((e) => ownerOf(e.record) === want);
		if (!target) return { status: "none" };
	}
	try {
		fs.unlinkSync(target.file);
	} catch (e) {
		if (caught(e).code === "ENOENT") return { status: "none" }; // swept under us
		// Not "none": a refused unlink leaves the debt standing, and reporting it
		// as nothing-to-clear is mantahostels#174's failure — the reader believes it is gone.
		core.logError(`debt clear ${rel}`, e);
		return {
			status: "failed",
			error: new Error(caught(e).message, { cause: e }),
		};
	}
	return { status: "cleared", record: target.record };
}

/**
 * Every registered debt, or `null` where the store could not be read (mantahostels#174).
 * @returns {ListedDebt[]|null}
 */
function listDebts() {
	/** @type {string[]} */
	let files = [];
	try {
		files = fs
			.readdirSync(core.paths.debtsDir())
			.filter((f) => f.endsWith(".json"));
	} catch (e) {
		if (caught(e).code !== "ENOENT") {
			// A debt is the durable record — the only one — of work a session
			// abandoned (mantahostels#174).
			core.logError("debt list", e);
			return null;
		}
		/* no store yet */
	}
	return (
		files
			.map((f) => {
				try {
					return core.readRecord(path.join(core.paths.debtsDir(), f));
				} catch (e) {
					// Kept, not dropped: a short list reads as complete (mantahostels#174).
					core.logError("debt list", e);
					return { file: f, unreadable: true };
				}
			})
			// A torn entry is still dropped: it is mid-write, not lost.
			.filter(Boolean)
	);
}

/**
 * The files carrying an OWNED debt that `sid` recorded — what
 * guard-uncommitted-work.js releases from its refusal (#1170), so a session
 * whose commit a gate refused can stop once it has declared the blocked edit.
 *
 * A region subject (`docs/doc-map.md#B12`) answers for its whole file, because
 * the dirt the guard reads is per file.
 *
 * An unreadable store or entry exempts nothing: the guard then blocks, which
 * its own cap bounds.
 * @param {string} sid
 * @returns {Set<string>}
 */
function debtsOwnedBy(sid) {
	const files = new Set();
	if (!sid) return files;
	for (const d of listDebts() ?? []) {
		if (d.unreadable === true) continue;
		if (ownerOf(d) !== null && d.recordedBy === sid)
			files.add(core.splitSubject(d.path).rel);
	}
	return files;
}

/**
 * Fails toward KEEPING every debt. A missing gh, absent auth, a network stall
 * or a rate limit all return null here, and the caller then retires nothing.
 * The other way round, an outage would silently empty the register.
 *
 * Deliberately not routed through lib/gh.js (mantahostels#154): that seam exits the process
 * on a gh failure, which is right for a checker and wrong here.
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {string} where
 */
function ghJson(args, timeoutMs, where) {
	try {
		return JSON.parse(
			execFileSync(process.env.WFC_ARBITER_GH || "gh", args, {
				cwd: core.repoRoot(),
				encoding: "utf8",
				timeout: timeoutMs,
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
	} catch (e) {
		core.logError(where, e);
		return null;
	}
}

/**
 * The claim's read path. Returns the warning text for a claimant, or null.
 *
 * NO NETWORK CALL, EVER (mantahostels#1251). Every entry `debtsCovering` returns is shown;
 * `sweepDebts` is the only thing that retires one.
 *
 * **Residual:** an entry whose issue has since closed now warns every claimant
 * on that path until a sweep runs. Accepted at mantahostels#1111 — the lookup that would
 * have caught it retired nothing across the whole register.
 *
 * NO existsSync PRE-CHECK. It returned false for a debt sitting in an unreadable
 * DIRECTORY, so the hardening below was unreachable in exactly the case it was
 * written for: the whole store dark, every debt read as no-debt.
 * @param {string} rel
 */
function debtNotice(rel) {
	// EVERY command below names the record's OWN path, never the subject asked
	// about: debtsCovering widens a region claim onto the file's entries, and
	// mantahostels#1857 makes a file-level record the normal shape for a denial reaching for
	// an unallocated id — so `debt clear <the region>` would find nothing and the
	// reader would conclude the entry cannot be retired.
	let entries;
	try {
		entries = debtsCovering(rel);
	} catch (e) {
		const { code, message } = caught(e);
		// Silence here hands the path to a session that would have been told the
		// work is already owned elsewhere (mantahostels#174).
		core.logError(`debt read ${rel}`, e);
		return (
			`${rel} carries a registered debt that could not be read (${code || message}).\n` +
			"An edit was denied here and the entry recording who owns the work is unreadable, so the owning issue cannot be named. " +
			`Read it by hand before writing: ${core.paths.debtsDir()}`
		);
	}

	const live = entries.map((e) => e.record);

	// A LONE torn record stays silent — readRecord's standing ruling. One standing
	// BESIDE a live debt is said out loud, per readDebts above (mantahostels#327).
	const torn = entries.torn
		? `\n${entries.torn} further entr${entries.torn === 1 ? "y" : "ies"} here could not be parsed — mid-write, or corrupt. Re-run to see ${entries.torn === 1 ? "it" : "them"}: node ${scriptPath("session-arbiter.js")} debt list`
		: "";

	const [debt] = live;
	if (debt === undefined) return null;
	if (live.length > 1) return manyDebtsNotice(rel, live) + torn;

	if (debt.issue) {
		return (
			`${rel} carries a registered debt: an edit was denied here and #${debt.issue} now owns it.\n` +
			`#${debt.issue} owns this line; don't fix it here. The issue is authoritative on what the work is — the note below is a hint written at denial time, not a specification:\n` +
			`  "${debt.gist || "(no gist recorded)"}"  (registered ${debt.createdAt})\n` +
			`If you have finished it, or the issue is wrong, clear the entry: node ${scriptPath("session-arbiter.js")} debt clear ${debt.path} ${debt.issue}${torn}`
		);
	}

	return (
		`${rel} carries a registered debt: an edit was denied here on ${debt.createdAt} and never owned.\n` +
		"No issue was recorded against it, so nobody is tracking the work and no closure can retire it. Either own it — node " +
		scriptPath("session-arbiter.js") +
		" debt own " +
		`${debt.path} <issue> "<one line>" — or clear it: node ${scriptPath("session-arbiter.js")} debt clear ${debt.path} unowned` +
		(debt.gist
			? ""
			: "\nLeft alone it is DELETED by the next sweep 24h after that denial (mantahostels#1302).") +
		torn
	);
}

/**
 * How many debts are spelled out in full before the rest become a count.
 *
 * docs/doc-map.md carried 46 file-level entries the day region claims landed
 * (mantahostels#970), and every one of them rides along with any region claim on that file
 * — so an uncapped list buries the claim's own debts under a queue that is
 * mostly about other entries. Above the cap the reader gets the command that
 * prints the lot.
 */
const DEBTS_SHOWN_MAX = 6;

/**
 * @param {string} rel
 * @param {DebtRecord[]} live
 */
function manyDebtsNotice(rel, live) {
	// The claim's OWN subject first, so what is capped away is always the
	// file-wide backlog rather than the entry the reader came to write.
	const ordered = [...live].sort(
		(a, b) => Number(b.path === rel) - Number(a.path === rel),
	);
	const shown = ordered.slice(0, DEBTS_SHOWN_MAX);
	const lines = shown.map(
		(d) =>
			`  ${d.issue ? `#${d.issue}` : "UNOWNED"}  ${d.path === rel ? "" : `[${d.path}] `}"${d.gist || "(no gist recorded)"}"  (registered ${d.createdAt})`,
	);
	if (ordered.length > shown.length)
		lines.push(
			`  … and ${ordered.length - shown.length} more: node ${scriptPath("session-arbiter.js")} debt list`,
		);
	// From SHOWN, not from live: an entry the cap hid is not on the reader's
	// screen, and naming its path in the command reads as a typo.
	const bare = shown.find((d) => !d.issue);
	const unowned = bare
		? `\nThe UNOWNED entry has no issue tracking it, so nothing will ever retire it: own it — node ${scriptPath("session-arbiter.js")} debt own ${bare.path} <issue> "<one line>".`
		: "";
	return (
		`${rel} carries ${live.length} registered debts: edits were denied here and these own them.\n` +
		"Don't fix any of these lines here. Each issue is authoritative on what its own work is — the notes are hints written at denial time, not specifications:\n" +
		`${lines.join("\n")}${unowned}\n` +
		`Clear entries one at a time. A row showing a [path] is cleared under THAT path, not under ${rel}: node ${scriptPath("session-arbiter.js")} debt clear <path> <issue>`
	);
}

/**
 * The `--limit` on the sweep's closed-issue read. IT IS the tracker-wide
 * ceiling `lib/gh-limits.js` holds, not a copy of it — so it is one every other
 * checker reaches at the same moment and says so loudly, rather than this sweep
 * meeting a private number alone. Sizing and the measurement behind it: mantahostels#2482.
 *
 * WHY THE CEILING COMES FROM ITS OWN MODULE (mantahostels#2512) rather than
 * lib/gh.js: requiring lib/gh.js pulls lib/check.js, whose module body installs
 * `process.on("uncaughtException")` handlers ending in `process.exit`, and the
 * process here is the arbiter, run from hooks. Nor is gh.js's
 * `assertWholeTracker` used: it throws a check.js error class, and this sweep
 * must fail toward keeping every debt — log and return null, never throw.
 *
 * `ghJson` here sets no `maxBuffer`, so Node's 1 MB default binds: 20,000 rows
 * of `{"number":n}` is ~0.4 MB, and an overrun fails toward keeping every debt.
 */
const CLOSED_ISSUES_LIMIT = ISSUE_LIST_LIMIT;

/**
 * MEASURED at ~12.4 ms a closed issue (mantahostels#2482), so 300s carries ~24,000 — past
 * CLOSED_ISSUES_LIMIT above, which is the ordering that matters: the ROW
 * ceiling fires and says what to do, where a timeout only lands in `ghJson`'s
 * catch and retires nothing. Re-derive from that rate, never by scaling this.
 *
 * It can be this generous because a sweep runs by hand or detached from
 * SessionStart, never inside a hook: since mantahostels#1251 nothing on the claim path
 * calls GitHub, so nothing runs under guard-file-claim.sh's `timeout 5`.
 */
const GH_BATCH_TIMEOUT_MS = 300_000;

/**
 * Every closed issue number in the repo, in ONE gh call — or null where the
 * answer cannot be trusted.
 *
 * This is the register's ONLY drain (mantahostels#1251).
 *
 * Fails toward KEEPING every entry — `ghJson` above.
 */
function closedIssues() {
	const rows = ghJson(
		[
			"issue",
			"list",
			"--state",
			"closed",
			"--json",
			"number",
			"--limit",
			String(CLOSED_ISSUES_LIMIT),
		],
		GH_BATCH_TIMEOUT_MS,
		"debt sweep",
	);
	if (!Array.isArray(rows)) {
		if (rows !== null)
			core.logError("debt sweep", new Error("gh returned no list"));
		return null;
	}
	// At the ceiling the page may be truncated, so a number's ABSENCE would mean
	// "closed but off the end" as readily as "open". Unusable, not empty.
	if (rows.length >= CLOSED_ISSUES_LIMIT) {
		core.logError(
			"debt sweep",
			new Error(`gh returned ${rows.length} closed issues, at the limit`),
		);
		return null;
	}
	return new Set(rows.map((r) => Number(r.number)));
}

/**
 * 24h. The window between a denial writing its stub and the sweep being allowed
 * to drop it, so a session still on its way to `debt own` is never raced by the
 * SessionStart sweep running detached beside it (mantahostels#1302). RESIDUAL: `registerDenial`
 * returns early when an unowned stub already exists, so `createdAt` dates the
 * FIRST denial on that path — a session denied on a path whose stub is already
 * 25h old gets no window at all. Bounded, since `ownDebt` re-mints the entry.
 *
 * A FIRST GUESS, not a measurement: it is one working day, chosen so any session
 * that will ever complete its stub has ended long before.
 */
const STUB_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * An entry nothing can ever discharge: no issue to close, and no gist saying
 * what was owed. It is the stub `registerDenial` writes, left uncompleted by a
 * session that has since ended — so no later reader can own it, and it prints
 * at every claim on that path forever (mantahostels#1302, which ruled it dropped).
 *
 * Fails toward KEEPING: an unparseable or future `createdAt` is not old enough,
 * so the entry stands. The `Number.isFinite` limb is belt-and-braces and
 * UNVERIFIED — `NaN >= n` is already false, so removing it changes no behaviour
 * and no test can kill that mutation.
 * @param {DebtRecord} d
 * @param {number} [now]
 */
function isSpentStub(d, now = Date.now()) {
	if (d.issue || d.gist) return false;
	const born = Date.parse(d.createdAt);
	return Number.isFinite(born) && now - born >= STUB_GRACE_MS;
}

/**
 * Retire every entry whose owning issue has closed, across the whole register,
 * on one batched lookup (mantahostels#1203) — and drop the entries no closure can ever
 * reach (mantahostels#1302).
 *
 * IT DELETES ON EXACTLY TWO TESTS, and no others: "the owning issue is CLOSED",
 * and "unowned, gistless, and at least STUB_GRACE_MS old". A surviving entry is
 * not proof the work is outstanding (mantahostels#1203). An UNOWNED entry that DOES carry a
 * gist still stands: a later session can act on the gist. Unreadable files are
 * always left standing.
 *
 * `clearStub` is injectable for one reason: `clearDebt`'s `none` and
 * `unreadable` results are races — the file vanishing between the sweep's read
 * and its own — unreachable in-process, and each is disposed of differently
 * (#1366). `now` is the clock the stub grace is judged by.
 * @param {{clearStub?: (rel: string, issue: number|string) => {status: string, error?: Error}, now?: () => number}} [opts]
 * @returns {{status: "unreadable"}|{status: "absent"}|{status: "offline", dropped: DebtRecord[], failed: FailedDebt[], live: DebtRecord[], unreadable: UnreadableDebt[]}|{status: "swept", retired: DebtRecord[], dropped: DebtRecord[], failed: FailedDebt[], live: DebtRecord[], unreadable: UnreadableDebt[]}}
 */
function sweepDebts({ clearStub = clearDebt, now = Date.now } = {}) {
	const debts = listDebts();
	if (debts === null) return { status: "unreadable" };
	if (debts.length === 0 && !fs.existsSync(core.paths.debtsDir()))
		return { status: "absent" };

	/** @type {UnreadableDebt[]} */ const unreadable = [];
	/** @type {DebtRecord[]} */ const records = [];
	// Split by a loop rather than two `.filter` calls: a filter's predicate
	// narrows nothing for the checker.
	for (const d of debts) {
		if (d.unreadable === true) unreadable.push(d);
		else records.push(d);
	}
	// Dropped BEFORE the network call and outside the early return below: a
	// register holding nothing but spent stubs still has to drain, and the drop
	// needs no answer from GitHub.
	const { dropped, failed, kept } = dropSpentStubs(records, clearStub, now());

	const owned = kept.filter((d) => d.issue);
	if (owned.length === 0)
		return {
			status: "swept",
			retired: [],
			dropped,
			failed,
			live: kept,
			unreadable,
		};

	const closed = closedIssues();
	if (closed === null)
		return { status: "offline", dropped, failed, live: kept, unreadable };

	const retirement = retireClosed(kept, closed);
	return {
		status: "swept",
		retired: retirement.retired,
		dropped,
		failed: [...failed, ...retirement.failed],
		live: retirement.live,
		unreadable,
	};
}

/**
 * Clear every entry in `kept` whose owning issue is in `closed`, in order: an
 * entry gone afterwards is `retired`, one left standing is `live`, and a
 * refused clear is also listed in `failed`.
 * @param {DebtRecord[]} kept
 * @param {Set<number>} closed
 * @returns {{retired: DebtRecord[], live: DebtRecord[], failed: FailedDebt[]}}
 */
function retireClosed(kept, closed) {
	/** @type {DebtRecord[]} */ const retired = [];
	/** @type {DebtRecord[]} */ const live = [];
	/** @type {FailedDebt[]} */ const failed = [];
	for (const d of kept) {
		if (!d.issue || !closed.has(Number(d.issue))) {
			live.push(d);
			continue;
		}
		const result = clearDebt(d.path, d.issue);
		// "cleared" and "none" both end with the entry gone; anything else leaves
		// it standing, and saying otherwise is mantahostels#174's failure.
		if (result.status === "cleared" || result.status === "none")
			retired.push(d);
		else {
			// "unreadable" and "ambiguous" carry no error of their own.
			failed.push({
				record: d,
				error: "error" in result ? result.error : undefined,
			});
			live.push(d);
		}
	}
	return { retired, live, failed };
}

/**
 * Delete the spent stubs and hand back what survives.
 *
 * A refused unlink keeps the entry, reported through the same `failed` channel
 * as a refused retirement.
 * @param {DebtRecord[]} records
 * @param {(rel: string, issue: number|string) => {status: string, error?: Error}} clear
 * @param {number} now
 */
function dropSpentStubs(records, clear, now) {
	/** @type {DebtRecord[]} */ const dropped = [];
	/** @type {FailedDebt[]} */ const failed = [];
	/** @type {DebtRecord[]} */ const kept = [];
	for (const d of records) {
		if (!isSpentStub(d, now)) {
			kept.push(d);
			continue;
		}
		const result = clear(d.path, "unowned");
		// Only `cleared` is a deletion THIS run made. `none` also covers a file
		// that was never there and an entry that did not match, so counting it
		// dropped prints a deletion that may not have happened — and the entry is
		// gone either way, so it is not standing either: it goes in neither list.
		if (result.status === "cleared") {
			recordDrop(d);
			dropped.push(d);
		} else if (result.status !== "none") {
			failed.push({
				record: d,
				error: result.error || new Error(result.status),
			});
			kept.push(d);
		}
	}
	return { dropped, failed, kept };
}

/**
 * The one durable trace of a dropped stub. `sweep-debts-detached.sh` runs the
 * SessionStart sweep with stdout on `/dev/null`, so almost every drop happens
 * with `reportDropped`'s lines discarded — and the record is unlinked, so
 * without this the path and denial date are gone for good.
 *
 * NOT the guard-error log: that one is for faults, and check-guard-errors.js
 * injects it into every session's start-up context.
 * @param {DebtRecord} d
 */
function recordDrop(d) {
	try {
		fs.mkdirSync(core.stateDir(), { recursive: true });
		fs.appendFileSync(
			core.paths.droppedLog(),
			`${new Date().toISOString()}\t${d.path}\tdenied ${d.createdAt}\n`,
		);
	} catch (e) {
		core.logError(`debt drop ${d.path}`, e);
	}
}

module.exports = {
	clearDebt,
	debtNotice,
	debtsOwnedBy,
	listDebts,
	ownDebt,
	readDebts,
	registerDenial,
	sweepDebts,
};
