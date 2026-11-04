/*
 * dispatch-ledger.js — `.pick-next/dispatched.jsonl`, the record
 * scripts/dispatch-sessions.sh appends to as each session launches, and the
 * refill loop appends to as it resumes a parked one (#3704), as it stops one on
 * its seat's limit, a row holding past the window until released (#3785), and,
 * as it hands one off or a limit hold ends, a release row (#2744).
 *
 * TWO READERS, ONE SEAM (mantahostels#1528). check-duplicate-dispatch.js drops a set member
 * whose issues are already in here; pick-next.js holds those same issues out of
 * the frontier, so a run never offers work the launcher will then delete. They
 * must agree on the path, the window, what counts as an issue number and what
 * counts as the command (#752), so both read it from here rather than
 * restating it.
 */

const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { requiredGroup } = require("./regex-group.js");
const { readJsonl } = require("./jsonl.js");
const { homeDir, readAdopterCheckouts } = require("./refill-repos.js");

/** A prompt's leading `/<skill>`, any `<plugin>:` namespace aside. */
const COMMAND_RE = /^\s*\/(?:[\w.-]+:)?([\w.-]+)/;

/*
 * THE WINDOW IS A JUDGEMENT, NOT A MEASUREMENT. One hour. mantahostels#1337's six, and the
 * two that replaced it, each hid an issue whose launch had already finished
 * from the re-pick for most of a working session.
 * A legitimate re-dispatch of the same issue inside it takes `--force`.
 */
const DEFAULT_WINDOW_HOURS = 1;

/**
 * The tree the ledger lives under.
 *
 * WFC_DISPATCH_ROOT redirects the ledger ALONE, leaving WFC_REPO_ROOT to
 * mean what it means everywhere else: `scripts/dispatch-sessions*.test.ts` drive
 * the real launcher against a stubbed `claude`, so without it those runs would
 * append fake launches to the working ledger and refuse the next real dispatch.
 * Every reader resolves it here, so a caller passing its own repo root cannot
 * silently read a different file from the one the launcher wrote (mantahostels#1528).
 * @returns {string}
 */
function ledgerRoot() {
	return (
		process.env.WFC_DISPATCH_ROOT || process.env.WFC_REPO_ROOT || hostRoot()
	);
}

/** @returns {string} the ledger path — one JSON object per line, append-only. */
function ledgerPath(root = ledgerRoot()) {
	return path.join(markersDir(root), ".pick-next", "dispatched.jsonl");
}

/**
 * The issue numbers a launch prompt claims. Prompts are `/<skill> <issues>`, so
 * every integer in one is an issue number — save the map in
 * `/wayfinder <map> <ticket>`, which is context: two tickets on one map run in
 * parallel (#3217). `/wayfinder <map>` alone claims the map.
 *
 * Residual: a running session's NAME carries no `/wayfinder`, so a live ticket
 * session still holds its map against `/wayfinder <map>`, while a map-only
 * session or ledger row does not hold `/wayfinder <map> <ticket>` — only the
 * claim limb's parent-map check refuses that (#2211).
 *
 * Residual: a prompt carrying a non-issue integer records a phantom issue, which
 * then refuses an unrelated dispatch of that number and hides it from the
 * frontier for the window. `--force` is the way out (mantahostels#1337).
 * @param {string} prompt
 * @returns {number[]}
 */
function issuesIn(prompt) {
	const issues = (prompt.match(/\d+/g) || []).map(Number);
	return commandOf(prompt) === "wayfinder" && issues.length > 1
		? issues.slice(1)
		: issues;
}

/**
 * The command a launch prompt runs — its leading `/<skill>` token, slash and
 * any `<plugin>:` namespace dropped — or `null` where the prompt opens with
 * none (#752). The skill names the `takes:` values carry, so `/triage 34` and
 * `/workflow-core:triage 34` both read `triage`, which the picker compares with
 * the issue's label.
 * @param {unknown} prompt
 * @returns {string|null}
 */
function commandOf(prompt) {
	if (typeof prompt !== "string") return null;
	const m = prompt.match(COMMAND_RE);
	return m ? requiredGroup(m, 1, COMMAND_RE) : null;
}

/**
 * @param {{heldUntil?: string}|undefined} rec
 */
const buildHeldText = (rec) =>
	rec?.heldUntil
		? `, its session stopped on a seat's limit, held until ${rec.heldUntil}`
		: "";

/**
 * Whether a ledger entry holds its issues against a launch of `command` (#752).
 * The hold keys on issue AND command, so `/wayfinder 34` after `/triage 34`
 * passes and a second `/triage 34` does not. It FAILS TOWARD THE HOLD: an
 * entry or a launch whose command cannot be read — a hand-written
 * prompt, a flat `--issues 341,353` — holds. A row with `heldUntil` holds against
 * every command: its stopped session has work on the issue, and no live limb
 * sees it (#3785).
 * @param {{prompt?: unknown, heldUntil?: string}|undefined} rec
 * @param {string|null} command
 */
function entryHolds(rec, command) {
	if (rec?.heldUntil) return true;
	const held = commandOf(rec?.prompt);
	return held === null || command === null || held === command;
}

/**
 * One launch line of `.pick-next/dispatched.jsonl`.
 *
 * `session` is the LAUNCHING session — the one that ran dispatch-sessions.sh —
 * never the launched job's own session (mantahostels#3488). On a refill-loop
 * resume (#3704) it is null: the loop forgets its session id at start.
 * `jobId` is that job's own short id, the one `claude --bg` prints and
 * `claude stop`/`claude attach` take, or `null` where unknown.
 * @typedef {{ts: string, issues: number[], model: string, prompt: string,
 *            session: string|null, jobId: string|null,
 *            seatReason?: string, heldUntil?: string}} DispatchRecord
 *   `seatReason` is why the launch went on its seat: the refill loop's pick
 *   (lib/refill-decide.js's SeatReason), or `own seat` for a direct
 *   dispatch-sessions.sh run (#3732). `heldUntil` holds its issues to that time
 *   for a session stopped with no loop left running (#3785)
 */

/**
 * A launch on an overflow seat (#3694), the only mark of a session in a plan
 * dir as overflow. `allowanceUsd` is the key's headroom at launch. `sessionId`
 * is the launched job's own, unlike `session`; null until known.
 * @typedef {DispatchRecord & {kind: "overflow", keyVar: string,
 *            allowanceUsd: number, sessionId: string|null}} OverflowLaunch
 */

/**
 * A launch the refill loop handed off (#2744): `released` is its job id. It
 * ends that launch's hold. It carries no `jobId` or `issues`, so a reader of
 * raw lines never takes it for a launch.
 * @typedef {{ts: string, released: string}} ReleaseRecord
 */

/**
 * Whether a row counts whatever the window: a launch before its `heldUntil`,
 * and any release, as one aged out would revive the held launch it ended.
 * @param {DispatchRecord|ReleaseRecord} rec
 * @param {number} now ms
 */
const isKeptPastWindow = (rec, now) =>
	"released" in rec || Date.parse(String(rec.heldUntil)) > now;

/**
 * Every row inside the window or outlasting it, launches and releases alike. A
 * malformed line is skipped rather than failing the read (lib/jsonl.js) — the
 * ledger is append-only and a torn write must not disarm every later check.
 * @param {string|undefined} root
 * @param {number} windowHours
 * @returns {{ok: boolean, rows: (DispatchRecord|ReleaseRecord)[], error?: string}}
 */
function readCountedRows(root, windowHours) {
	let read;
	try {
		read = readJsonl(ledgerPath(root));
	} catch (err) {
		return { ok: false, rows: [], error: String(err) };
	}
	if (!read) return { ok: true, rows: [] }; // never launched from here: not a failure
	const now = Date.now();
	const cutoff = now - windowHours * 3600 * 1000;
	const rows = /** @type {(DispatchRecord|ReleaseRecord)[]} */ ([]);
	for (const rec of read.rows) {
		const row = /** @type {DispatchRecord|ReleaseRecord} */ (rec);
		const at = Date.parse(String(row.ts));
		if (Number.isNaN(at) || (at < cutoff && !isKeptPastWindow(row, now)))
			continue;
		rows.push(row);
	}
	return { ok: true, rows };
}

/**
 * @param {DispatchRecord|ReleaseRecord} rec
 * @returns {rec is DispatchRecord}
 */
const isLaunch = (rec) => !("released" in rec);

/**
 * Launches inside the window or held past it that still hold: a launch a later release row
 * names is dropped. Later is by line, the append order, so an in-place resume
 * that keeps a released job's id holds again (#3722).
 * @param {string|undefined} root
 * @param {number} windowHours
 * @returns {{ok: boolean, entries: DispatchRecord[], error?: string}}
 */
function readRecentEntries(root, windowHours) {
	const { rows, ...read } = readCountedRows(root, windowHours);
	/** @type {Map<string, number>} each job's last release, by line */
	const lastRelease = new Map();
	rows.forEach((r, i) => {
		if (!isLaunch(r)) lastRelease.set(r.released, i);
	});
	const entries = rows.filter(
		(r, i) => isLaunch(r) && !(r.jobId && i < (lastRelease.get(r.jobId) ?? -1)),
	);
	return { ...read, entries: /** @type {DispatchRecord[]} */ (entries) };
}

/**
 * The latest launch's time in ms, any age, released or not, or null where
 * this tree never launched — the refill loop's cross-repo tie-break after
 * ticket age (#3385), which reads null as launched longest ago. An unreadable
 * ledger fails open to null too: it only orders full ties, so the cost is that
 * repo winning them (#2003).
 * @param {string} root
 * @returns {number|null}
 */
function readLastLaunchAt(root) {
	const { rows } = readCountedRows(root, Number.POSITIVE_INFINITY);
	return rows
		.filter(isLaunch)
		.reduce(
			(/** @type {number|null} */ latest, e) =>
				Math.max(latest ?? 0, Date.parse(e.ts)),
			null,
		);
}

/**
 * Every row, any age, released or not.
 * @param {string} root
 * @returns {(DispatchRecord|ReleaseRecord)[]}
 * @throws where the ledger will not read
 */
function readEveryRow(root) {
	const { ok, rows, error } = readCountedRows(root, Number.POSITIVE_INFINITY);
	if (!ok) throw new Error(`${ledgerPath(root)} would not read: ${error}`);
	return rows;
}

/**
 * Each issue's latest launch from this tree in ms, any age, released or not —
 * the idle alarm's launch log (check-idle-efforts.js); a `heldUntil` row is no
 * launch, written anew after a failed resume (#3838). Throws where it will not
 * read.
 * @param {string} root
 * @returns {Map<number, number>}
 */
function readLaunchTimes(root) {
	/** @type {Map<number, number>} */
	const last = new Map();
	for (const e of readEveryRow(root).filter(isLaunch)) {
		if (e.heldUntil) continue;
		const at = Date.parse(e.ts);
		for (const n of e.issues ?? []) last.set(n, Math.max(last.get(n) ?? 0, at));
	}
	return last;
}

/**
 * @param {DispatchRecord|ReleaseRecord} rec
 * @returns {rec is OverflowLaunch}
 */
const isOverflowLaunch = (rec) =>
	/** @type {{kind?: unknown}} */ (rec).kind === "overflow";

/**
 * The one answer to "is this session overflow, on which key, with what
 * allowance" (#3694): a lookup over every overflow launch in `roots`' ledgers,
 * any age, released or not, as credits stay spent. A session's latest such
 * launch, or null for a session none records. A session id also matches a job
 * id by its first 8 digits, as `--bg` prints only the job id (#3692 (e)). Each
 * root holds only its own checkout's launches, so a reading of a key's spend
 * names every checkout (`readEveryOverflowLookup`); the default suits a session
 * asking about itself.
 * @param {string[]} [roots]
 * @returns {(session: {jobId?: string|null, sessionId?: string|null}) => OverflowLaunch|null}
 * @throws where a ledger will not read: a plan session and an unread overflow
 *   one must not look alike
 */
function readOverflowLookup(roots = [ledgerRoot()]) {
	const launches = roots.flatMap((root) =>
		readEveryRow(root).filter(isOverflowLaunch),
	);
	return ({ jobId, sessionId }) =>
		launches
			.filter(
				(l) =>
					(jobId && l.jobId === jobId) ||
					(sessionId &&
						(l.sessionId === sessionId || l.jobId === sessionId.slice(0, 8))),
			)
			.pop() ?? null;
}

/**
 * `readOverflowLookup` over every checkout's ledger, opted out of the loop or
 * not, for a reading of a key's spend.
 * @throws where a ledger will not read, or the checkouts cannot be listed
 */
const readEveryOverflowLookup = () =>
	readOverflowLookup([
		...new Set([ledgerRoot(), ...readAdopterCheckouts(homeDir()).included]),
	]);

/**
 * Append one line. Never throws: a ledger that cannot be written must not
 * stop the launch or hand-off it records (mantahostels#1528); the caller
 * reports the false.
 * @param {string|undefined} root
 * @param {object} rec
 * @param {number} [at] epoch ms of the event, now where absent
 * @returns {boolean} whether it was written
 */
function append(root, rec, at = Date.now()) {
	const file = ledgerPath(root);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(
			file,
			`${JSON.stringify({ ts: new Date(at).toISOString(), ...rec })}\n`,
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {{jobId: string, root?: string}} entry
 * @returns {boolean} whether it was written
 */
function release(entry) {
	return append(entry.root, { released: entry.jobId });
}

/**
 * `launchedAt` is the launch's epoch ms, from a caller whose own record of the
 * launch reads the same clock; now where absent.
 * @param {{issues: number[], model: string, prompt: string, root?: string, jobId?: string|null, launchedAt?: number, seatReason?: string, heldUntil?: number, overflow?: Pick<OverflowLaunch, "keyVar"|"allowanceUsd"|"sessionId">}} entry
 * @returns {boolean} whether it was written
 */
function record(entry) {
	return append(
		entry.root,
		{
			issues: entry.issues,
			model: entry.model,
			prompt: entry.prompt,
			session: process.env.CLAUDE_CODE_SESSION_ID || null,
			jobId: entry.jobId || null,
			...(entry.seatReason ? { seatReason: entry.seatReason } : {}),
			...(entry.heldUntil === undefined
				? {}
				: { heldUntil: new Date(entry.heldUntil).toISOString() }),
			...(entry.overflow ? { kind: "overflow", ...entry.overflow } : {}),
		},
		entry.launchedAt,
	);
}

module.exports = {
	DEFAULT_WINDOW_HOURS,
	ledgerPath,
	issuesIn,
	commandOf,
	buildHeldText,
	entryHolds,
	readRecentEntries,
	readLastLaunchAt,
	readLaunchTimes,
	readEveryOverflowLookup,
	readOverflowLookup,
	record,
	release,
};
