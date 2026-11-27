const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");
const { shortJobId } = require("./job-paths.js");
const { homeDir, readAdopterCheckouts } = require("./refill-repos.js");
const {
	declaresOverflowSeat,
	readDeclaredSeats,
} = require("./refill-seats.js");

const COMMAND_RE = /^\s*\/(?:[\w.-]+:)?([\w.-]+)/;

// guess, lucmoseley/mantahostels#1337
const DEFAULT_WINDOW_HOURS = 1;

/** @returns {string} */
function ledgerRoot() {
	return (
		process.env.WFC_DISPATCH_ROOT || process.env.WFC_REPO_ROOT || hostRoot()
	);
}

/** @returns {string} */
function ledgerPath(root = ledgerRoot()) {
	return path.join(markersDir(root), ".pick-next", "dispatched.jsonl");
}

const OPTIONS_RE = /^\s*(?:-\S*\s+)*/;

const NAME_WORD_RE = /^[A-Za-z]\S*(?=\s)/;

const SLOT_RE = /^[\s,]*((?:#?\d+(?!\w)[\s,]*)*)/;

const HASH_ISSUE_RE = /(?<![\w&#])#(\d+)\b/g;

/**
 * @param {string} prompt
 * @returns {number[]}
 */
function issuesIn(prompt) {
	const body = prompt.slice(prompt.match(OPTIONS_RE)?.[0].length ?? 0);
	const lead = body.match(COMMAND_RE) ?? body.match(NAME_WORD_RE);
	const rest = body.slice(lead?.[0].length ?? 0);
	const slot = (rest.match(SLOT_RE)?.[1]?.match(/\d+/g) || []).map(Number);
	const args =
		commandOf(body) === "wayfinder" && slot.length > 1 ? slot.slice(1) : slot;
	const named = [...prompt.matchAll(HASH_ISSUE_RE)].map((m) => Number(m[1]));
	return [...new Set([...args, ...named])];
}

/**
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
 * @param {{prompt?: unknown, heldUntil?: string}|undefined} rec
 * @param {string|null} command
 */
function entryHolds(rec, command) {
	if (rec?.heldUntil) return true;
	const held = commandOf(rec?.prompt);
	return held === null || command === null || held === command;
}

/**
 * @typedef {{ts: string, issues: number[], model: string, prompt: string,
 * session: string|null, jobId: string|null,
 * seatReason?: string, heldUntil?: string}} DispatchRecord
 */

/**
 * @typedef {DispatchRecord & {kind: "overflow", keyVar: string,
 * allowanceUsd: number, sessionId: string|null,
 * copyOf?: string, offKeyUsd?: number}} OverflowLaunch
 */

/**
 * @typedef {Pick<OverflowLaunch, "keyVar"|"allowanceUsd"|"sessionId"|"copyOf"|"offKeyUsd">} OverflowFields
 */

/** @typedef {{ts: string, released: string}} ReleaseRecord */

/**
 * @typedef {(session: {jobId?: string|null, sessionId?: string|null}) =>
 * OverflowLaunch|null} OverflowLookup
 */

/**
 * @param {DispatchRecord|ReleaseRecord} rec
 * @param {number} now
 */
const isKeptPastWindow = (rec, now) =>
	"released" in rec || Date.parse(String(rec.heldUntil)) > now;

/**
 * @param {string|undefined} root
 * @param {number} windowHours
 * @param {number} [now]
 * @returns {{ok: boolean, rows: (DispatchRecord|ReleaseRecord)[], error?: string}}
 */
function readCountedRows(root, windowHours, now = Date.now()) {
	let read;
	try {
		read = readJsonl(ledgerPath(root));
	} catch (err) {
		return { ok: false, rows: [], error: String(err) };
	}
	if (!read) return { ok: true, rows: [] };
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
 * @param {string|undefined} root
 * @param {number} windowHours
 * @param {number} [now]
 * @returns {{ok: boolean, entries: DispatchRecord[], error?: string}}
 */
function readRecentEntries(root, windowHours, now = Date.now()) {
	const { rows, ...read } = readCountedRows(root, windowHours, now);
	/** @type {Map<string, number>} */
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
 * @param {string} root
 * @returns {(DispatchRecord|ReleaseRecord)[]}
 */
function readEveryRow(root) {
	const { ok, rows, error } = readCountedRows(root, Number.POSITIVE_INFINITY);
	if (!ok) throw new Error(`${ledgerPath(root)} would not read: ${error}`);
	return rows;
}

/**
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

/** @param {unknown} err */
const buildRemediedError = (err) =>
	new Error(
		`launch record unreadable: ${caught(err).message} — fix that read and re-run: until then an overflow session cannot be told from a plan one`,
		{ cause: err },
	);

/**
 * @param {string[]} [roots]
 * @returns {OverflowLookup}
 */
function readOverflowLookup(roots = [ledgerRoot()]) {
	let launches;
	try {
		launches = roots.flatMap((root) =>
			readEveryRow(root).filter(isOverflowLaunch),
		);
	} catch (err) {
		throw buildRemediedError(err);
	}
	return ({ jobId, sessionId }) =>
		launches
			.filter(
				(l) =>
					(jobId && l.jobId === jobId) ||
					(sessionId &&
						(l.sessionId === sessionId || l.jobId === shortJobId(sessionId))),
			)
			.pop() ?? null;
}

/** @param {string} [root] */
const readEveryLedgerRoot = (root = ledgerRoot()) => [
	...new Set([root, ...readAdopterCheckouts(homeDir()).included]),
];

/** @param {string} [root] */
function readEveryOverflowLookup(root) {
	let roots;
	try {
		roots = readEveryLedgerRoot(root);
	} catch (err) {
		throw buildRemediedError(err);
	}
	return readOverflowLookup(roots);
}

/**
 * @param {import("./refill-seats.js").SeatList} [declared]
 * @param {string} [root]
 * @returns {OverflowLookup}
 */
function readDeclaredOverflowLookup(
	declared = readDeclaredSeats(),
	root = ledgerRoot(),
) {
	if (!declaresOverflowSeat(declared) && declared.errors.length === 0)
		return () => null;
	return readEveryOverflowLookup(root);
}

/**
 * @param {OverflowLaunch} l
 * @returns {Omit<OverflowFields, "sessionId">}
 */
const overflowFieldsOf = ({ keyVar, allowanceUsd, copyOf, offKeyUsd }) => ({
	keyVar,
	allowanceUsd,
	copyOf,
	offKeyUsd,
});

/**
 * @param {{id?: string, sessionId: string}[]} agents
 * @param {string[]} [roots]
 * @returns {string[]}
 */
function recordListedSessionIds(agents, roots = readEveryLedgerRoot()) {
	const listed = new Map(
		agents.flatMap((a) => (a.id && a.sessionId ? [[a.id, a.sessionId]] : [])),
	);
	/** @type {string[]} */
	const faults = [];
	for (const root of roots) {
		let lookup;
		try {
			lookup = readOverflowLookup([root]);
		} catch (err) {
			faults.push(caught(err).message);
			continue;
		}
		for (const [jobId, sessionId] of listed) {
			const l = lookup({ jobId });
			if (!l || l.sessionId) continue;
			const written = record({
				issues: [],
				model: l.model,
				prompt: `session of ${jobId}`,
				root,
				jobId,
				overflow: { ...overflowFieldsOf(l), sessionId },
			});
			if (!written)
				faults.push(
					`overflow job ${jobId}'s session ${sessionId} not written to ${ledgerPath(root)}`,
				);
		}
	}
	return faults;
}

/**
 * @param {string|undefined} root
 * @param {object} rec
 * @param {number} [at]
 * @returns {boolean}
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
 * @returns {boolean}
 */
function release(entry) {
	return append(entry.root, { released: entry.jobId });
}

/**
 * @param {{issues: number[], model: string, prompt: string, root?: string, jobId?: string|null, launchedAt?: number, seatReason?: string, heldUntil?: number, overflow?: OverflowFields}} entry
 * @returns {boolean}
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
	readDeclaredOverflowLookup,
	readEveryOverflowLookup,
	readOverflowLookup,
	record,
	recordListedSessionIds,
	release,
};
