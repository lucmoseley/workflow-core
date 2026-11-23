/** @typedef {import("./arbiter-store").ListedLock} Lock */
/** @typedef {Exclude<Lock, { unreadable: true }>} LiveLock */

const WARN_MAX_BYTES = 4000;

// 60 B measured, #5529
const OVERFLOW_RESERVE = 80;

// guess, lucmoseley/mantahostels#2363
const SESSION_BUDGET_BYTES = 2000;

// guess, lucmoseley/mantahostels#2364
const POINTER_DECAY_MS = 60 * 60 * 1000;

const POINTER =
	"A live session holds a path this command writes; this guard has spent " +
	`its ${SESSION_BUDGET_BYTES} B session budget (mantahostels#2345). It repeats hourly ` +
	"on a NEW contended path (mantahostels#2364). Read the claims: " +
	// arbiter-literal-exempt: #5540
	"`node scripts/session-arbiter.js list`.";

const POINTER_BYTES = Buffer.byteLength(POINTER);

const WARN_HEAD =
	"This command writes through Bash to a file another LIVE session holds. " +
	"Nothing will refuse it — `guard-file-claim` sees Write/Edit/NotebookEdit " +
	"only, so the Bash route is unguarded on both tiers (mantahostels#287, mantahostels#295).\n\n" +
	"The live claims on the paths this command names:\n\n";
const WARN_TAIL =
	"\n\nWrite anyway and you clobber an edit git cannot merge back. " +
	"Leave the path to its holder and carry on with the rest of your ticket.\n\n" +
	"Residual: a write no parse here recognises — a heredoc, a wrapper, a script that writes for you — " +
	"is invisible, so silence is not proof the path is free.";

/**
 * @typedef {{ bytes: number, pairs: string[], pointedAt: number | null }} Ledger
 */

/**
 * @typedef {{
 *   listLocks: () => Lock[] | null,
 *   claimKey: (p: string) => string | null,
 *   isWarned: (rel: string) => boolean,
 *   subjectsOverlap: (a: string, b: string) => boolean,
 *   now: () => number,
 * }} ClaimPorts
 */

/** @returns {Ledger} */
const emptyLedger = () => ({ bytes: 0, pairs: [], pointedAt: null });

/** @param {unknown} v @returns {v is string} */
const isString = (v) => typeof v === "string";

/**
 * @param {string | null} text
 * @returns {Ledger}
 */
function readLedger(text) {
	if (!text) return emptyLedger();
	try {
		const d = JSON.parse(text);
		if (!d || typeof d !== "object") return emptyLedger();
		return {
			bytes: Number.isFinite(d.bytes) && d.bytes > 0 ? d.bytes : 0,
			pairs: Array.isArray(d.pairs) ? d.pairs.filter(isString) : [],
			pointedAt:
				Number.isFinite(d.pointedAt) && d.pointedAt > 0 ? d.pointedAt : null,
		};
	} catch {
		return emptyLedger();
	}
}

/**
 * @param {string[]} targets
 * @param {ClaimPorts} ports
 */
function resolveTargets(targets, ports) {
	/** @type {string[]} */
	const out = [];
	for (const raw of targets) {
		const rel = ports.claimKey(raw);
		if (rel !== null && ports.isWarned(rel) && !out.includes(rel))
			out.push(rel);
	}
	return out;
}

/**
 * @param {string[]} paths
 * @param {string} sessionId
 * @param {Lock[]} locks
 * @param {ClaimPorts} ports
 * @returns {string[]}
 */
function creditable(paths, sessionId, locks, ports) {
	return [...new Set(paths)].filter(
		(rel) =>
			!locks.some(
				(lock) =>
					!lock.unreadable &&
					lock.alive &&
					lock.sessionId !== sessionId &&
					ports.subjectsOverlap(lock.path, rel),
			),
	);
}

/** @param {LiveLock} lock */
function describeHolder(lock) {
	const who = lock.sessionId || "an unidentified session";
	const when = lock.claimedAt ? `, holding it since ${lock.claimedAt}` : "";
	return `${who} (pid ${lock.pid ?? "unknown"})${when}`;
}

/**
 * @param {string} target
 * @param {LiveLock} lock
 */
function line(target, lock) {
	const held =
		lock.path === target ? target : `${lock.path} (covers ${target})`;
	return `  HELD  ${held} — session ${describeHolder(lock)}`;
}

/**
 * @typedef {{ text: string, ledger: Ledger | null }} Warning
 * @typedef {{ session: string, locks: Lock[], ledger: string | null }} Seen
 */

/**
 * @param {string[]} targets
 * @param {Seen} seen
 * @param {ClaimPorts} ports
 * @returns {Warning}
 */
function warnings(targets, seen, ports) {
	const led = readLedger(seen.ledger);
	const pointedAt = led.pointedAt;
	const now = ports.now();
	if (pointedAt !== null && now - pointedAt < POINTER_DECAY_MS)
		return { text: "", ledger: null };
	const { lines, fresh } = contention(targets, led, seen, ports);
	if (lines.length === 0) return { text: "", ledger: null };

	if (pointedAt !== null) return point(led, now);
	return deliver(led, lines, fresh, now);
}

/**
 * @param {string[]} targets
 * @param {Ledger} led
 * @param {Seen} seen
 * @param {ClaimPorts} ports
 * @returns {{ lines: string[], fresh: string[] }}
 */
function contention(targets, led, { session, locks }, ports) {
	/** @type {string[]} */
	const lines = [];
	/** @type {string[]} */
	const fresh = [];
	for (const target of resolveTargets(targets, ports)) {
		for (const lock of locks) {
			if (!contends(lock, target, session, ports)) continue;
			const key = `${lock.path} ${lock.sessionId} ${target}`;
			if (led.pairs.includes(key)) continue;
			fresh.push(key);
			lines.push(line(target, lock));
		}
	}
	return { lines, fresh };
}

/**
 * @param {Lock} lock
 * @param {string} target
 * @param {string} sessionId
 * @param {ClaimPorts} ports
 * @returns {lock is LiveLock}
 */
function contends(lock, target, sessionId, ports) {
	if (lock.unreadable || !lock.alive) return false;
	if (!ports.subjectsOverlap(lock.path, target)) return false;
	return Boolean(lock.sessionId) && lock.sessionId !== sessionId;
}

/**
 * @param {Ledger} led
 * @param {string[]} lines
 * @param {string[]} fresh
 * @param {number} now
 * @returns {Warning}
 */
function deliver(led, lines, fresh, now) {
	const remaining = SESSION_BUDGET_BYTES - POINTER_BYTES - led.bytes;
	const { text, kept } = clamp(
		WARN_HEAD,
		lines,
		WARN_TAIL,
		Math.min(WARN_MAX_BYTES, remaining),
	);

	if (Buffer.byteLength(text) > remaining) return point(led, now);

	return {
		text,
		ledger: {
			...led,
			bytes: led.bytes + Buffer.byteLength(text),
			pairs: [...led.pairs, ...fresh.slice(0, kept)],
		},
	};
}

/**
 * @param {Ledger} led
 * @param {number} now
 * @returns {Warning}
 */
function point(led, now) {
	return {
		text: POINTER,
		ledger: { ...led, bytes: led.bytes + POINTER_BYTES, pointedAt: now },
	};
}

/**
 * @param {string} head
 * @param {string[]} lines
 * @param {string} tail
 * @param {number} ceiling
 * @returns {{ text: string, kept: number }}
 */
function clamp(head, lines, tail, ceiling) {
	const budget = ceiling - Buffer.byteLength(head + tail);
	/** @type {string[]} */
	const kept = [];
	let used = 0;
	for (const l of lines) {
		const cost = Buffer.byteLength(l) + 1;
		if (used + cost > budget - OVERFLOW_RESERVE) break;
		kept.push(l);
		used += cost;
	}
	const [first] = lines;
	if (kept.length === 0 && first !== undefined) kept.push(first);
	const dropped = lines.length - kept.length;
	// arbiter-literal-exempt: #5540
	const overflow = `\n  … and ${dropped} more — node scripts/session-arbiter.js list`;
	const more = dropped ? overflow : "";
	return { text: head + kept.join("\n") + more + tail, kept: kept.length };
}

module.exports = { creditable, warnings };
