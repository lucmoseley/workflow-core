/*
 * claim-warning.js — the judge lib/claimed-bash-write.js hands the paths a
 * Bash command writes: which of them does another live session hold, what is
 * this session told about it, and which code writes are credited to it
 * (mantahostels#1818, split out of mantahostels#1772; route (f) under
 * docs/doc-map.md §Capture and placement). No I/O of its own: the claim store
 * and the clock arrive as ports, and the session ledger as the text the core
 * read and the text it is to write back.
 *
 * THE FAILURE (mantahostels#287, mantahostels#295). lib/file-claim.js sees
 * Write, Edit and NotebookEdit; a shell redirect, a `cp`, a `sed -i` is
 * invisible to it, so a Bash-route write over a neighbour's held file is
 * neither refused nor announced. mantahostels#287 declined a Bash-route DENY
 * on price — the parser is outrunnable (mantahostels#201).
 *
 * TIER 1 ONLY FOR THE WARNING, which is `isGuarded` — `docs/`, `.claude/`,
 * `CLAUDE.md`, `AGENTS.md`. The `scripts/` tier is detect-only by
 * mantahostels#287's own ruling and a prompt there buys the least; adding it
 * is a separate call (mantahostels#1772).
 *
 * THE SESSION LEDGER (mantahostels#2345) bounds what one session can be made
 * to pay here. Two limbs:
 *
 *   the (lock, holder, target)  a line already delivered this session is not
 *   triple                      delivered again. Not the rule: a second command
 *                               against a different held path, or the same path
 *                               under a new holder, is news and arrives in full.
 *                               The target is in the key because the LINE names
 *                               it — one lock, two write targets, two facts.
 *   2,000 B a session           SESSION_BUDGET_BYTES, across every firing and
 *                               INCLUDING the pointer that replaces the payload
 *                               once it is spent.
 *
 * THE 2,000 B PRICES A STATED CASE (mantahostels#2363, re-derived at
 * mantahostels#3568): two deliveries of the fixed prose and the pointer that
 * ends them, the first carrying two 129 B claim lines at `docs/doc-map.md`
 * joined by a charged newline, the second one. The *prices the session budget*
 * case in claim-warning.test.ts measures the fixed prose and holds that case
 * under the constant, and a third delivery over it; the 129 B is this
 * header's, which the test reads and never checks.
 *
 * WHAT IT OVERRUNS. check-context-budget.js cannot census this payload, so the
 * 2,000 B sits ON TOP of whatever it measures for PreToolUse Bash against route
 * (f)'s SESSION_CAP_BYTES, and the first hour overruns that cap. Read both
 * figures with `npm run check:context`; check-context-budget.js's own
 * docstring carries where the cap comes from and every seed it retired.
 *
 * THERE IS NO WORST CASE. Under the decay below each further hour adds another
 * 212 B. NO FIGURE FIXES THE OVERRUN EITHER: one payload's floor has exceeded
 * route (f)'s headroom every time both were taken (mantahostels#2345,
 * mantahostels#2363), so every budget that leaves this guard able to name a
 * path overruns.
 *
 * THE POINTER DECAYS HOURLY (mantahostels#2364), on POINTER_DECAY_MS, and is
 * said again on a contended pair this session has not already been handed —
 * NOT on unchanging contention, which the pair filter drops before the decay
 * is reached. Not a terminal latch: the house shape for a bounded repeat is the
 * arbiter `request` marker's hourly decay, and what a latch silences is a
 * clobber warning — the direction AGENTS.md §Supervision priors says to err
 * away from.
 *
 * A compaction clears the ledger with every other rule latch.
 *
 * NO LOCK ON THE LEDGER, deliberately. Two hooks for one session can read-
 * modify-write it at once; every way that race resolves errs toward SAYING a
 * line again, never toward suppressing one unsaid.
 *
 * REJECTED — making check-context-budget.js count it. That checker censuses
 * rule-text calls, so being counted means fetching a fragment, and route (f)'s
 * Bash cap had 205 B of headroom against the 1,027 B that would take
 * (mantahostels#2345). The bound above holds the line instead, and nothing
 * gates it.
 *
 * THE HOLDER IS NAMED BY SESSION ID, on lib/stale-script.js's reasoning
 * (mantahostels#317).
 */

/** @typedef {import("./arbiter-store").ListedLock} Lock */
/** @typedef {Exclude<Lock, { unreadable: true }>} LiveLock */

/**
 * 4,000 B is `RULE_CAP`'s figure (lib/rule-emission.js), tracked
 * deliberately so the two things a Bash call can be handed are bounded alike.
 */
const WARN_MAX_BYTES = 4000;

/**
 * Bytes held back from the line budget for the overflow notice that replaces
 * the lines that did not fit. The notice is fixed text plus a decimal count,
 * 60 B at a three-digit count (measured), rounded up so a later reword of it
 * does not silently overrun the reserve.
 */
const OVERFLOW_RESERVE = 80;

/**
 * What this guard may spend on one session's PAYLOADS, plus the first pointer
 * that ends them (mantahostels#2345, re-derived at mantahostels#2363).
 *
 * SELF-IMPOSED, because route (f)'s caps cannot reach a payload composed here
 * from live state.
 *
 * DERIVED, and the case it prices is this file's header — which also states
 * what this leaves overrunning against route (f). Re-derive there before
 * moving this constant; POINTER interpolates it, so a budget of a different
 * digit count changes POINTER_BYTES and falsifies the derivation there.
 *
 * WHAT IT DOES NOT BOUND, once the pointer decays (mantahostels#2364): each
 * hourly repeat costs a further POINTER_BYTES on top of this figure.
 */
const SESSION_BUDGET_BYTES = 2000;

/**
 * How long the pointer silences this guard before it speaks again
 * (mantahostels#2364). THE INTERVAL IS COPIED, NOT READ, from the arbiter
 * `request` marker's hourly decay (docs/agents/guard-registry.md
 * §Conventions): nothing here consults that marker, so the two drift
 * independently.
 */
const POINTER_DECAY_MS = 60 * 60 * 1000;

/**
 * What replaces the payload once the session's remainder is too small to afford
 * one — which is usually, but not always, the whole budget spent. Said once,
 * then again at most once an hour — `pointedAt` in the ledger.
 */
const POINTER =
	"A live session holds a path this command writes; this guard has spent " +
	`its ${SESSION_BUDGET_BYTES} B session budget (mantahostels#2345). It repeats hourly ` +
	"on a NEW contended path (mantahostels#2364). Read the claims: " +
	"`node scripts/session-arbiter.js list`.";

const POINTER_BYTES = Buffer.byteLength(POINTER);

const WARN_HEAD =
	"This command writes through Bash to a file another LIVE session holds. " +
	"Nothing will refuse it — `guard-file-claim` sees Write/Edit/NotebookEdit " +
	"only, so the Bash route is unguarded on both tiers (mantahostels#287, mantahostels#295).\n\n" +
	"The live claims on the paths this command names:\n\n";
const WARN_TAIL =
	"\n\nWrite anyway and you clobber an edit git cannot merge back. " +
	"Wait for it instead, backgrounded — `node scripts/session-arbiter.js wait <path>` " +
	"— and carry on with your ticket; past its ceiling, ask the holder with `request`.\n\n" +
	"Residual: a write no parse here recognises — a heredoc, a wrapper, a script that writes for you — " +
	"is invisible, so silence is not proof the path is free.";

/**
 * What one session has already been told, and what it has cost.
 *
 * `pairs` holds `<lock path> <holder session> <target>` for every line already
 * delivered; why that triple and not the rule is this file's header.
 *
 * `pointedAt` is when the pointer last replaced a payload, in epoch ms, or
 * null while payloads are still being paid for.
 *
 * A LEDGER FROM BEFORE mantahostels#2364 carries the boolean `pointed` and no
 * stamp, so it reads as never-pointed — but `bytes` survives, and a ledger
 * that had pointed is by construction one that spent the old 4,000 B budget.
 * Its remainder is therefore negative and the very next firing gets the
 * POINTER, not a payload, and the decay runs from there.
 * @typedef {{ bytes: number, pairs: string[], pointedAt: number | null }} Ledger
 */

/**
 * @typedef {{
 *   listLocks: () => Lock[] | null,
 *   relativeToRepo: (p: string) => string | null,
 *   isGuarded: (rel: string) => boolean,
 *   subjectsOverlap: (a: string, b: string) => boolean,
 *   now: () => number,
 * }} ClaimPorts the claim store's reads and the clock
 */

/** A session that has been told nothing. @returns {Ledger} */
const emptyLedger = () => ({ bytes: 0, pairs: [], pointedAt: null });

/** @param {unknown} v @returns {v is string} */
const isString = (v) => typeof v === "string";

/**
 * The ledger `text` holds, or an empty one.
 *
 * ANYTHING UNREADABLE READS AS EMPTY — absent, truncated, malformed, a shape
 * from an older revision. Erring the other way would suppress a first warning.
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
 * Every target resolved to a repo-relative tier-1 path, de-duplicated. A path
 * outside the repo, or inside it but outside the refusing tier, is dropped
 * here: `isGuarded` is the authority on which tier a path sits in, and the
 * core's own prefix test only saves the store a read.
 * @param {string[]} targets
 * @param {ClaimPorts} ports
 */
function resolveTargets(targets, ports) {
	/** @type {string[]} */
	const out = [];
	for (const raw of targets) {
		const rel = ports.relativeToRepo(raw);
		if (rel !== null && ports.isGuarded(rel) && !out.includes(rel))
			out.push(rel);
	}
	return out;
}

/**
 * Which of this command's code write targets are credited to this session
 * (mantahostels#2778).
 *
 * WHY IT EXISTS. The post-write core (scripts/lib/post-write.js) records the
 * Write/Edit/NotebookEdit tools only, so a session that edits code through
 * `sed -i` or a redirect reaches concision-backstop.sh with an empty ledger,
 * and that backstop's code signal never fires — no threshold,
 * mantahostels#2769's zero one included, is ever consulted. What it cost is
 * measured in lib/arbiter-tool-record.js's header.
 *
 * WHAT MAKES IT SAFE, and it is not the parser. mantahostels#114 forbids
 * over-billing because a nag naming a neighbour's file sends this session to
 * edit a file a live session holds — the collision lib/file-claim.js refuses.
 * A path any OTHER live session holds a claim on is therefore skipped
 * outright, so that harm cannot be produced here whatever the parser gets
 * wrong. The two remaining error directions both cost nothing: a target the
 * core could not read is never passed at all, and a target that turns out not
 * to have changed is dropped by the backstop's own `git diff --name-only`
 * before it is counted.
 *
 * NO `lock.sessionId &&` LIMB, unlike `contends()` below. A live lock may
 * legally carry a null sessionId (arbiter-records.js), and there it is skipped
 * because a warning naming no holder says nothing. Here skipping would CREDIT
 * the path — the over-bill mantahostels#114 forbids — so an unidentified live
 * holder counts as contention.
 * @param {string[]} paths repo-relative code paths this command writes
 * @param {string} sessionId
 * @param {Lock[]} locks
 * @param {ClaimPorts} ports
 * @returns {string[]} the paths to credit, each once
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

/**
 * How the list names the session holding a target.
 * @param {LiveLock} lock
 */
function describeHolder(lock) {
	const who = lock.sessionId || "an unidentified session";
	const when = lock.claimedAt ? `, holding it since ${lock.claimedAt}` : "";
	return `${who} (pid ${lock.pid ?? "unknown"})${when}`;
}

/**
 * One line of the filtered claim list.
 * @param {string} target
 * @param {LiveLock} lock
 */
function line(target, lock) {
	// The lock's own subject, not the target: a region claim
	// (`docs/doc-map.md#B42`) contends with a whole-file write.
	const held =
		lock.path === target ? target : `${lock.path} (covers ${target})`;
	return `  HELD  ${held} — session ${describeHolder(lock)}`;
}

/**
 * @typedef {{ text: string, ledger: Ledger | null }} Warning what to say, ""
 *   for nothing, and the ledger to write back, null where it is unchanged
 * @typedef {{ session: string, locks: Lock[], ledger: string | null }} Seen
 *   the session asking, the store's locks and the session ledger as read
 */

/**
 * The whole warning for `targets`, and the ledger it leaves.
 *
 * The caller reads the locks, and says nothing where the store cannot be
 * read: an unreadable lock store must not manufacture a warning, and
 * mantahostels#103 §6 allows unchecked rather than guessing.
 * @param {string[]} targets
 * @param {Seen} seen
 * @param {ClaimPorts} ports
 * @returns {Warning}
 */
function warnings(targets, seen, ports) {
	const led = readLedger(seen.ledger);
	// Once pointed, the pointer is the ONLY thing this guard says — an hour's
	// silence, then the pointer again (mantahostels#2364). Latched here rather
	// than inside the over-budget branch, where a later payload small enough to
	// fit the unspent remainder would get through and the stated ceiling would
	// not be the enforced one.
	const pointedAt = led.pointedAt;
	const now = ports.now();
	if (pointedAt !== null && now - pointedAt < POINTER_DECAY_MS)
		return { text: "", ledger: null };
	const { lines, fresh } = contention(targets, led, seen, ports);
	if (lines.length === 0) return { text: "", ledger: null };

	// Pointed, and the hour is up: the pointer again and never a payload.
	if (pointedAt !== null) return point(led, now);
	return deliver(led, lines, fresh, now);
}

/**
 * The HELD line for every live claim of another session on one of `targets`,
 * and the ledger key of each, skipping the pairs this session was already
 * handed (mantahostels#2345).
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
	// The session's own claim is not news to it.
	return Boolean(lock.sessionId) && lock.sessionId !== sessionId;
}

/**
 * The payload for `lines` under this session's remaining budget, and the
 * ledger recording what it said — or the pointer where not even one line fits.
 * @param {Ledger} led
 * @param {string[]} lines
 * @param {string[]} fresh the ledger key of each of `lines`
 * @param {number} now
 * @returns {Warning}
 */
function deliver(led, lines, fresh, now) {
	// The per-delivery ceiling, floored at what the session has left with the
	// terminating pointer already reserved. Floored rather than fixed
	// (mantahostels#2363): once the session budget is under one delivery's
	// ceiling, a large first firing must be TRIMMED to the remainder — `… and N
	// more` carries the recovery — instead of being replaced wholesale by a
	// pointer that names no path at all.
	//
	// THE `Math.min` IS UNREACHABLE while the budget is under WARN_MAX_BYTES.
	// It is kept so that raising the budget past 4,000 B restores the
	// per-delivery cap rather than silently retiring it.
	const remaining = SESSION_BUDGET_BYTES - POINTER_BYTES - led.bytes;
	const { text, kept } = clamp(
		WARN_HEAD,
		lines,
		WARN_TAIL,
		Math.min(WARN_MAX_BYTES, remaining),
	);

	// Not even one line fits: clamp keeps a first line whatever it costs, so this
	// is what tests that the payload was actually affordable.
	if (Buffer.byteLength(text) > remaining) return point(led, now);

	// `kept`, never `fresh` whole: a pair the size ceiling dropped was counted in
	// the overflow line and not said, so recording it would suppress the only
	// delivery it was ever going to get.
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
 * The pointer, and the ledger stamped with the hour it starts
 * (mantahostels#2364). No pair is recorded as delivered: a pointed session
 * was told nothing about them, so a compaction clearing the ledger must leave
 * them all still to come.
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
 * The three parts, with as many lines as fit under `ceiling` and a count of
 * those that did not. `kept` is how many of `lines` survived, in order, so the
 * caller can record exactly what was said (mantahostels#2345).
 * @param {string} head
 * @param {string[]} lines
 * @param {string} tail
 * @param {number} ceiling bytes the whole payload may occupy
 * @returns {{ text: string, kept: number }}
 */
function clamp(head, lines, tail, ceiling) {
	const budget = ceiling - Buffer.byteLength(head + tail);
	/** @type {string[]} */
	const kept = [];
	let used = 0;
	for (const l of lines) {
		// +1 for the newline joining it to the previous line.
		const cost = Buffer.byteLength(l) + 1;
		if (used + cost > budget - OVERFLOW_RESERVE) break;
		kept.push(l);
		used += cost;
	}
	// A first line longer than the whole budget would otherwise empty `kept`, and
	// the payload would then assert contention and name none. It is kept
	// whatever it costs.
	const [first] = lines;
	if (kept.length === 0 && first !== undefined) kept.push(first);
	const dropped = lines.length - kept.length;
	const more = dropped
		? `\n  … and ${dropped} more — node scripts/session-arbiter.js list`
		: "";
	return { text: head + kept.join("\n") + more + tail, kept: kept.length };
}

module.exports = { creditable, warnings };
